/**
 * The parts of Quo's app page (QuoPanel.tsx) that are plain logic: the number in words, which state
 * its webhook is in, which error to show under it, what the server just said put on the Apps list,
 * how far back an import reaches, and an import's progress and result in words.
 */
import { phoneDisplay } from "@crewtavo/core/phone";
import { t } from "@/lib/i18n";
import { quoImportRunning, type AppsData, type QuoImport, type QuoState } from "./catalog";

/** A number in the Quo workspace, to pick the one texts go from (POST /apps/quo/numbers). */
export interface QuoNumber {
  id: string;
  /** E.164. */
  number: string;
  name: string;
}

const digits = (s: string) => s.replace(/\D/g, "");

/**
 * The name is only the number written another way: Quo names a number nobody named by the number
 * itself ("(540) 555-0100", "+1 540-555-0100", "07700 900123" for +447700900123).
 */
export function nameIsNumber(name: string, number: string): boolean {
  if (!/^[\d\s+().-]+$/.test(name)) return false;
  const named = digits(name).replace(/^0+/, "");
  return named.length >= 7 && digits(number).endsWith(named);
}

/** The number in words: its name in Quo, then the number, said once when the name is just the number. */
export function numberLabel(n: Pick<QuoNumber, "name" | "number">): string {
  const shown = phoneDisplay(n.number);
  const name = n.name?.trim();
  return name && !nameIsNumber(name, n.number) ? `${name} · ${shown}` : shown;
}

/**
 * Why the number or the API key can't change now, or null. An import goes on with the number and
 * key it started with, so they change once it's done (the server refuses sooner with a 409).
 */
export const changeHeldBack = (quo: Pick<QuoState, "import">): string | null =>
  quoImportRunning(quo.import) ? t("Change the number or the API key once the past texts and calls are in.") : null;

/**
 * The Apps list with Quo as the server just said it is, so the page shows it without waiting for
 * the list to be read again. `saved`: a key or number was just saved, which connects Quo and clears
 * its error.
 */
export function withQuo(data: AppsData | undefined, quo: QuoState, saved = false): AppsData | undefined {
  if (!data) return data;
  return { ...data, apps: data.apps.map((a) => (a.id === "quo" ? { ...a, quo, ...(saved ? { status: "connected" as const, last_error: null } : {}) } : a)) };
}

/**
 * Where Quo's deliveries stand, most pressing first: Quo can't reach this Crewtavo at all; setting
 * the webhook up failed; it was made for this Crewtavo's old address; there isn't one; or it's set,
 * and something has come in through it, or nothing yet.
 */
export type HookState = "unreachable" | "problem" | "moved" | "unset" | "working" | "waiting";

export function hookState(quo: Pick<QuoState, "webhook" | "reachable" | "heard_at">): HookState {
  if (!quo.reachable) return "unreachable";
  if (quo.webhook.problem) return "problem";
  if (quo.webhook.moved) return "moved";
  if (!quo.webhook.set) return "unset";
  return quo.heard_at ? "working" : "waiting";
}

/** A mutation's error, and when it was last started (TanStack's submittedAt). */
interface Tried {
  error: unknown;
  submittedAt: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The one error to show under Replies and calls: the latest of a test's and a setup's. A setup's
 * isn't said again when the callout above already says it (`problem`: Quo's problem, kept with its
 * state and shown there), and an older error never stands in for it.
 */
export function deliveriesError(test: Tried, setUp: Tried, problem: string | null): unknown {
  const latest = [test, setUp].filter((m) => m.error).sort((a, b) => b.submittedAt - a.submittedAt)[0];
  if (!latest) return null;
  if (latest === setUp && problem && errorText(setUp.error).trim() === problem.trim()) return null;
  return latest.error;
}

/** Quo's test arrived: something came in since the test was asked for (heard_at then, `before`). */
export const testArrived = (before: string | null, heardAt: string | null) => Boolean(heardAt) && heardAt !== before;

/**
 * The server notes Quo's last delivery every five minutes at most, so a test only shows when the
 * last one is older than that (or there's none): sooner, it plainly works.
 */
export const HEARD_EVERY_MS = 5 * 60_000;
export const canTest = (quo: Pick<QuoState, "webhook" | "heard_at">, now = Date.now()) =>
  quo.webhook.set && !quo.webhook.moved && (!quo.heard_at || now - Date.parse(quo.heard_at) > HEARD_EVERY_MS);

/** How far back to bring in past texts and calls. */
export type ImportRange = "3m" | "12m" | "all";

/** The day an import starts from (YYYY-MM-DD, the person's own day), or null for everything Quo has. */
export function importSince(range: ImportRange, today = new Date()): string | null {
  if (range === "all") return null;
  const months = range === "3m" ? 3 : 12;
  const first = new Date(today.getFullYear(), today.getMonth() - months, 1);
  // The same day of that month, or its last day when it's shorter (May 31 back 3 months is Feb 28).
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const day = Math.min(today.getDate(), last);
  return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const texts = (n: number) => t.plural(n, { one: "{count} text", other: "{count} texts" });
const calls = (n: number) => t.plural(n, { one: "{count} call", other: "{count} calls" });

/** While it runs: "4 texts and 1 call so far." */
export const importProgress = (state: Pick<QuoImport, "counts">) => t("{texts} and {calls} so far.", { texts: texts(state.counts.texts), calls: calls(state.counts.calls) });

/** Once done: what came in, and what was left in Quo because it wasn't a client's. */
export function importResult(state: Pick<QuoImport, "counts">): string {
  const came = t("{texts} and {calls} came in.", { texts: texts(state.counts.texts), calls: calls(state.counts.calls) });
  const skipped = state.counts.skipped;
  if (!skipped) return came;
  return `${came} ${t.plural(skipped, { one: "1 with a number that isn't a client's was left in Quo.", other: "{count} with numbers that aren't clients' were left in Quo." })}`;
}
