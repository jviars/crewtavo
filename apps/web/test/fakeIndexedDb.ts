/**
 * For the tests: the phone's IndexedDB, kept in memory, with the little of it lib/offlinePhotos.ts
 * uses. It outlives the app's modules (a test "closes the app" by loading them again), copies what
 * it's given as the real one does, and can be made to run out of room.
 */
type Row = { id: string };
type Callback = (() => void) | null | undefined;
interface FakeRequest<T> {
  result: T;
  error: unknown;
  onsuccess?: Callback;
  onerror?: Callback;
  onupgradeneeded?: Callback;
}

export class FakeIndexedDb {
  /** Each database's stores, and each store's rows by id. */
  readonly databases = new Map<string, Map<string, Map<string, Row>>>();
  /** No room left: a write fails, and its whole transaction with it. */
  full = false;
  private last = Promise.resolve();

  rows(database: string, store: string): Row[] {
    return [...(this.databases.get(database)?.get(store)?.values() ?? [])];
  }

  open(name: string) {
    const request: FakeRequest<unknown> = { result: undefined, error: null };
    queueMicrotask(() => {
      const fresh = !this.databases.has(name);
      const stores = this.databases.get(name) ?? new Map<string, Map<string, Row>>();
      this.databases.set(name, stores);
      request.result = {
        createObjectStore: (store: string) => void stores.set(store, new Map()),
        transaction: (store: string, mode: string) => this.transaction(stores, store, mode),
        close: () => undefined,
      };
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }

  private transaction(stores: Map<string, Map<string, Row>>, name: string, mode: string) {
    if (!stores.has(name)) throw new Error(`No object store named ${name}`);
    // Written to a copy, and kept only if every request went through.
    let draft = new Map<string, Row>();
    const queue: Array<() => void> = [];
    const tx: { error: unknown; oncomplete?: Callback; onerror?: Callback; onabort?: Callback; objectStore: () => unknown } = { error: null, objectStore: () => store };
    const ask = <T>(work: () => T) => {
      const request: FakeRequest<T | undefined> = { result: undefined, error: null };
      queue.push(() => {
        request.result = work();
        request.onsuccess?.();
      });
      return request;
    };
    const write = (work: () => void) =>
      ask(() => {
        if (mode !== "readwrite") throw new Error("ReadOnlyError");
        work();
      });
    const store = {
      put: (row: Row) =>
        write(() => {
          if (this.full) throw new Error("QuotaExceededError");
          draft.set(row.id, structuredClone(row));
        }),
      delete: (id: string) => write(() => void draft.delete(id)),
      getAll: () => ask(() => [...draft.values()].map((row) => structuredClone(row))),
    };
    // One transaction at a time, in the order they were opened, as the real one does for writes.
    this.last = this.last.then(async () => {
      draft = new Map(stores.get(name));
      try {
        while (queue.length) {
          queue.shift()!();
          await Promise.resolve();
        }
        if (mode === "readwrite") stores.set(name, draft);
        tx.oncomplete?.();
      } catch (error) {
        tx.error = error;
        tx.onabort?.();
      }
    });
    return tx;
  }
}
