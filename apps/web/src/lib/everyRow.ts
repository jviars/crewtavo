/**
 * Reading a whole list from the database. The API hands over 1,000 rows a request at most, however
 * many `.limit()` asks for, so a longer list has to be read a page at a time.
 */
import { unwrap } from "./api";

/** How many rows are asked for at a time: what the API hands over at most. */
export const PAGE_ROWS = 1000;

/** One page of a read, as supabase-js answers; `count` is there when the read asked for it. */
export interface RowPage<T> {
  data: T[] | null;
  error: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
  count?: number | null;
  status?: number;
}

/**
 * Every row of a read, however many there are: `page` reads rows `from` to `to`. Ask for the count
 * with it ({ count: "exact" }) and a list that fits in one page is one request; without it, reading
 * carries on until a page comes back empty. It never goes by a page coming back short, since a
 * server set to hand over fewer rows would look finished after its first page. Give the read an
 * order that can't tie (end it with the id), or a row could repeat or go missing between pages.
 * A failed page fails the whole read, rather than passing off part of the list as all of it.
 */
export async function everyRow<T>(page: (from: number, to: number) => PromiseLike<RowPage<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const result = await page(rows.length, rows.length + PAGE_ROWS - 1);
    // Rows deleted while reading can leave the next page starting past the end: that's the end.
    if (result.error?.code === "PGRST103") return rows;
    const batch = unwrap(result);
    rows.push(...batch);
    if (!batch.length || (result.count != null && rows.length >= result.count)) return rows;
  }
}
