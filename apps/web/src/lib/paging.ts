/**
 * Reading more rows than the database sends at once. It answers with at most 1,000 rows a request
 * whatever limit is asked for (PGRST_DB_MAX_ROWS), so anything that can grow past that is read a
 * page at a time, here and nowhere else. Every page is read in one set order that ends with the
 * row's id: without an order the database may send a row on two pages and leave another out, and
 * with one that has ties (a date, a name) it may do the same among the rows that tie.
 */
import { unwrap } from "./api";
import { ApiError } from "./errors";

/** How many rows are asked for at a time: what the database sends at most. */
export const PAGE_ROWS = 1000;
/** How many rows everyRow reads before it gives up, unless it's told another number (`most`). */
export const MOST_ROWS = 100_000;

/** A column to sort by: its name (ascending), or with a direction and where its blanks go. */
export type SortBy = string | { column: string; ascending?: boolean; nullsFirst?: boolean };

export interface Paging {
  /** What to sort by. The rows' key always comes after it, so it needn't tell every row apart. */
  order?: SortBy | readonly SortBy[];
  /** The column that tells rows apart, or the columns that do together, for a table without an `id`. */
  key?: string | readonly string[];
}

type DbError = { message: string; code?: string; details?: string | null; hint?: string | null };

/**
 * A supabase-js read before it's sorted or cut to a page: `supabase().from(…).select(…)` and its
 * filters. Sorting and cutting change the query itself, so each page starts from a new one.
 */
export interface PagedQuery<T> extends PromiseLike<{ data: T[] | null; error: DbError | null; count?: number | null; status?: number }> {
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): PagedQuery<T>;
  range(from: number, to: number): PagedQuery<T>;
}

/**
 * There was more to read than `most` rows. Thrown rather than handing back the rows read so far, so
 * no screen adds up part of the rows as if they were all of them.
 */
export class TooManyRows extends ApiError {
  constructor(public most: number) {
    super(`That's more than ${most.toLocaleString("en-US")} records, too many to read at once. Try a shorter date range.`, 400, "too_many_rows");
  }
}

const list = <V>(value: V | readonly V[] | undefined): readonly V[] => (value === undefined ? [] : Array.isArray(value) ? (value as readonly V[]) : [value as V]);

/** One page of a query: rows `from` to `to` in the order asked, then by key. */
async function readPage<T>(query: () => PagedQuery<T>, { order, key = "id" }: Paging, from: number, to: number) {
  const sorts = list(order).map((s) => (typeof s === "string" ? { column: s } : s));
  let q = query();
  for (const { column, ...options } of sorts) q = q.order(column, options);
  for (const column of list(key)) if (!sorts.some((s) => s.column === column)) q = q.order(column);
  const result = await q.range(from, to);
  // Asked to start past the last row (rows went while the pages were read): there's nothing more.
  if (result.error?.code === "PGRST103") return { rows: [], count: null };
  return { rows: unwrap(result) as T[], count: result.count ?? null };
}

/**
 * Every row a query finds. `query` makes the read anew for each page, without an order or a range:
 *
 *   everyRow(() => supabase().from("payments").select("amount").eq("company_id", id), { order: "received_at" })
 *
 * Past `most` rows it throws TooManyRows, so a screen shows that rather than figures that leave
 * rows out. Give `most: Infinity` where everything really is wanted (a download of all the data).
 */
export async function everyRow<T>(query: () => PagedQuery<T>, { most = MOST_ROWS, ...paging }: Paging & { most?: number } = {}): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const page = (await readPage(query, paging, rows.length, rows.length + PAGE_ROWS - 1)).rows;
    rows.push(...page);
    if (rows.length > most) throw new TooManyRows(most);
    if (page.length < PAGE_ROWS) return rows;
  }
}

/**
 * The first `limit` rows a query finds, for a list with "Load more", which may by then be asking
 * for more than one request brings. `total` is how many there are in all when the query counts them
 * (`select(…, { count: "exact" })`), else null.
 */
export async function firstRows<T>(query: () => PagedQuery<T>, limit: number, paging: Paging = {}): Promise<{ rows: T[]; total: number | null }> {
  const rows: T[] = [];
  let total: number | null = null;
  while (rows.length < limit) {
    const asked = Math.min(PAGE_ROWS, limit - rows.length);
    const page = await readPage(query, paging, rows.length, rows.length + asked - 1);
    total ??= page.count;
    rows.push(...page.rows);
    if (page.rows.length < asked || (total !== null && rows.length >= total)) break;
  }
  return { rows, total };
}
