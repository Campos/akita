import { QueryEntity } from '../../api/query-entity';
import { delay, map, switchMap, take } from 'rxjs/operators';
import { BehaviorSubject, from, Observable, Subscription } from 'rxjs';
import { isObservable, isUndefined } from '../../internal/utils';
import { ID } from '../../api/types';
import { AkitaPlugin } from '../plugin';
import { applyTransaction } from '../../api/transaction';
import { action, applyAction } from '../../internal/action';

export interface PaginationResponse<E> {
  currentPage: number;
  perPage: number;
  lastPage: number;
  data: E[];
  total?: number;
  from?: number;
  to?: number;
  pageControls?: number[];
}

export type PaginatorConfig = {
  pagesControls?: boolean;
  range?: boolean;
  startWith?: number;
  cacheTimeout?: Observable<number>;
};

const paginatorDefaults: PaginatorConfig = {
  pagesControls: false,
  range: false,
  startWith: 1,
  cacheTimeout: undefined
};

export class PaginatorPlugin<E> extends AkitaPlugin<E> {
  /** Save current filters, sorting, etc. in cache */
  metadata = new Map();

  private page: BehaviorSubject<number>;
  private pages = new Map<number, { ids: ID[] }>();
  private readonly clearCacheSubscription: Subscription;

  private pagination: PaginationResponse<E> = {
    currentPage: 1,
    perPage: 0,
    total: 0,
    lastPage: 0,
    data: []
  };

  /**
   * When the user navigates to a different page and return
   * we don't want to call `clearCache` on first time.
   */
  private initial = false;

  constructor(protected query: QueryEntity<any, E>, public config: PaginatorConfig = {}) {
    super(query);
    this.config = Object.assign(paginatorDefaults, config);
    const { startWith, cacheTimeout } = this.config;
    this.page = new BehaviorSubject(startWith);
    if (isObservable(cacheTimeout)) {
      this.clearCacheSubscription = cacheTimeout.subscribe(_ => this.clearCache());
    }
  }

  /**
   * Proxy to the query loading
   */
  isLoading$ = this.query.selectLoading().pipe(delay(0));

  /**
   * Listen to page changes
   */
  get pageChanges() {
    return this.page.asObservable();
  }

  /**
   * Get the current page number
   */
  get currentPage() {
    return this.pagination.currentPage;
  }

  /**
   * Check if current page is the first one
   */
  get isFirst() {
    return this.currentPage === 1;
  }

  /**
   * Check if current page is the last one
   */
  get isLast() {
    return this.currentPage === this.pagination.lastPage;
  }

  /**
   * Whether to generate an array of pages for *ngFor
   * [1, 2, 3, 4]
   */
  withControls() {
    this.config.pagesControls = true;
    return this;
  }

  /**
   * Whether to generate the `from` and `to` keys
   * [1, 2, 3, 4]
   */
  withRange() {
    this.config.range = true;
    return this;
  }

  /**
   * Set the loading state
   */
  setLoading(value = true) {
    this.getStore().setLoading(value);
  }

  /**
   * Update the pagination object and add the page
   */
  @action({ type: '@Pagination - New Page' }, true)
  update(response: PaginationResponse<E>) {
    this.pagination = response;
    this.addPage(response.data);
  }

  /**
   *
   * Set the ids and add the page to store
   */
  addPage(data: E[]) {
    this.pages.set(this.currentPage, { ids: data.map(entity => entity[this.getStore().idKey]) });
    this.getStore().add(data);
  }

  /**
   * Clear the cache.
   */
  clearCache() {
    if (!this.initial) {
      applyAction(
        () => {
          this.getStore().remove();
        },
        { type: '@Pagination - Clear Cache' }
      );
      this.pages = new Map();
    }
    this.initial = false;
  }

  clearPage(page: number) {
    this.pages.delete(page);
  }

  /**
   * Clear the cache timeout and optionally the pages
   */
  destroy({ clearCache, currentPage }: { clearCache?: boolean; currentPage?: number } = {}) {
    if (this.clearCacheSubscription) {
      this.clearCacheSubscription.unsubscribe();
    }
    if (clearCache) {
      this.clearCache();
    }
    if (!isUndefined(currentPage)) {
      this.setPage(currentPage);
    }
    this.initial = true;
  }

  /**
   * Whether the provided page is active
   */
  isPageActive(page: number) {
    return this.currentPage === page;
  }

  /**
   * Set the current page
   */
  setPage(page: number) {
    if (page !== this.currentPage || !this.hasPage(page)) {
      this.page.next((this.pagination.currentPage = page));
    }
  }

  /**
   * Increment current page
   */
  nextPage() {
    if (this.currentPage !== this.pagination.lastPage) {
      this.setPage(this.pagination.currentPage + 1);
    }
  }

  /**
   * Decrement current page
   */
  prevPage() {
    if (this.pagination.currentPage > 1) {
      this.setPage(this.pagination.currentPage - 1);
    }
  }

  /**
   * Set current page to last
   */
  setLastPage() {
    this.setPage(this.pagination.lastPage);
  }

  /**
   * Set current page to first
   */
  setFirstPage() {
    this.setPage(1);
  }

  /**
   * Check if page exists in cache
   */
  hasPage(page: number) {
    return this.pages.has(page);
  }

  /**
   * Get the current page if it's in cache, otherwise invoke the request
   */
  getPage(req: () => Observable<PaginationResponse<E>>) {
    const page = this.pagination.currentPage;
    if (this.hasPage(page)) {
      return this.selectPage(page);
    } else {
      this.setLoading(true);
      return from(req()).pipe(
        switchMap((config: PaginationResponse<E>) => {
          applyTransaction(() => {
            this.setLoading(false);
            this.update(config);
          });
          return this.selectPage(page);
        })
      );
    }
  }

  getQuery(): QueryEntity<any, E> {
    return this.query;
  }

  private getFrom() {
    if (this.isFirst) {
      return 1;
    }
    return (this.currentPage - 1) * this.pagination.perPage + 1;
  }

  private getTo() {
    return this.currentPage * this.pagination.perPage;
  }

  /**
   * Select the page
   */
  private selectPage(page: number): Observable<PaginationResponse<E>> {
    return this.query.selectAll({ asObject: true }).pipe(
      take(1),
      map(entities => {
        let response: PaginationResponse<E> = {
          ...this.pagination,
          data: this.pages.get(page).ids.map(id => entities[id])
        };

        const { range, pagesControls } = this.config;

        if (!this.pagination.total) {
          response.total = response.perPage * response.lastPage;
          this.pagination.total = response.total;
        }

        if (range) {
          response.from = this.getFrom();
          response.to = this.getTo();
        }

        if (pagesControls) {
          response.pageControls = generatePages(this.pagination.total, this.pagination.perPage);
        }

        return response;
      })
    );
  }
}

/**
 * Generate an array so we can ngFor them to navigate between pages
 */
function generatePages(total: number, perPage: number) {
  const len = Math.ceil(total / perPage);
  let arr = [];
  for (let i = 0; i < len; i++) {
    arr.push(i + 1);
  }
  return arr;
}

/** backward compatibility */
export const Paginator = PaginatorPlugin;
