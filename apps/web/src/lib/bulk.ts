/**
 * Acting on many records at once from a list page (Clients, Quotes, Jobs, Invoices): which rows are
 * picked, writing them a chunk at a time, and what to say about how it went. The checkboxes and the
 * bar are components/ui/Selection.tsx.
 */
import { errorMessage, isNetworkError } from "./errors";
import { toast, type ToastTone } from "./toast";

/** Ids per request: well inside a URL's length for `.in("id", …)`, and the API's own limits. */
export const BULK_CHUNK = 100;

/** Said for a record a write left out: row-level security hid it, or its status moved on since the list loaded. */
export const NOT_CHANGED = "You can't change it, or it changed since the list loaded";

/** The picked ids that are on the page now, in the page's order. */
export const pickedOnPage = (picked: ReadonlySet<string>, pageIds: readonly string[]) => pageIds.filter((id) => picked.has(id));

/** What "select all on this page" shows: ticked, a dash (some), or empty. */
export function pageState(picked: ReadonlySet<string>, pageIds: readonly string[]): "all" | "some" | "none" {
  const n = pickedOnPage(picked, pageIds).length;
  return n === 0 ? "none" : n === pageIds.length ? "all" : "some";
}

/** Select all on this page: every row on it, or none once they all are. */
export function toggleAll(picked: ReadonlySet<string>, pageIds: readonly string[]): Set<string> {
  const all = pageState(picked, pageIds) === "all";
  const next = new Set(picked);
  for (const id of pageIds) all ? next.delete(id) : next.add(id);
  return next;
}

export function toggleOne(picked: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(picked);
  next.has(id) ? next.delete(id) : next.add(id);
  return next;
}

export interface BulkResult {
  done: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Writes the ids `size` at a time. `write` returns the ids it changed, and any it left out failed for
 * `missing`. A chunk that errors is tried again an id at a time, so one the database refuses (with its
 * reason) doesn't take the rest with it: every id ends up done or failed, never left unsaid.
 */
export async function inChunks(ids: readonly string[], write: (chunk: string[]) => Promise<readonly string[]>, missing = NOT_CHANGED, size = BULK_CHUNK): Promise<BulkResult> {
  const result: BulkResult = { done: [], failed: [] };
  const run = async (chunk: string[]) => {
    try {
      const changed = new Set(await write(chunk));
      for (const id of chunk) changed.has(id) ? result.done.push(id) : result.failed.push({ id, reason: missing });
    } catch (error) {
      // Offline, each would fail the same way: said once for the chunk rather than tried one by one.
      if (chunk.length > 1 && !isNetworkError(error)) for (const id of chunk) await run([id]);
      else for (const id of chunk) result.failed.push({ id, reason: errorMessage(error) });
    }
  };
  for (let i = 0; i < ids.length; i += size) await run(ids.slice(i, i + size));
  return result;
}

/** Results put together, as when some were skipped before anything was written. */
export const mergeResults = (...results: BulkResult[]): BulkResult => ({ done: results.flatMap((r) => r.done), failed: results.flatMap((r) => r.failed) });

export interface BulkWords {
  /** What was done to them: "archived". */
  verb: string;
  one: string;
  many: string;
  /** How a record is named beside a reason: "#12", "Jane Doe". */
  name: (id: string) => string;
}

const MAX_NAMES = 5;

/** Why the rest weren't done, a sentence per reason: "#12, #14: Already archived." */
function reasons(failed: BulkResult["failed"], name: (id: string) => string): string {
  const byReason = new Map<string, string[]>();
  for (const f of failed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), name(f.id)]);
  return [...byReason]
    .map(([reason, names]) => {
      const shown = names.slice(0, MAX_NAMES).join(", ") + (names.length > MAX_NAMES ? ` and ${names.length - MAX_NAMES} more` : "");
      return `${shown}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`;
    })
    .join(" ");
}

/**
 * What to say once it's done: how many worked, and why the rest didn't. With `said`, the toast that
 * offered Undo already said how many, so only what didn't work is told (null when everything did).
 */
export function bulkOutcome(result: BulkResult, words: BulkWords, said = false): { kind: "success" | "warning" | "error"; title: string; description?: string } | null {
  const count = (n: number) => `${n} ${n === 1 ? words.one : words.many}`;
  const done = result.done.length;
  const failed = result.failed.length;
  if (!failed) return said ? null : { kind: "success", title: `${count(done)} ${words.verb}` };
  const description = reasons(result.failed, words.name);
  if (said) return { kind: done ? "warning" : "error", title: `${failed} of ${done + failed} ${done + failed === 1 ? words.one : words.many} not ${words.verb}`, description };
  if (!done) return { kind: "error", title: `${count(failed)} not ${words.verb}`, description };
  return { kind: "warning", title: `${count(done)} ${words.verb}, ${failed} not`, description };
}

/** Shows bulkOutcome as a toast. */
export function reportBulk(result: BulkResult, words: BulkWords, options: { said?: boolean; tone?: ToastTone } = {}) {
  const outcome = bulkOutcome(result, words, options.said);
  if (outcome) toast[outcome.kind](outcome.title, { description: outcome.description, tone: options.tone });
}
