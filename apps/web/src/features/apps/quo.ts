/**
 * The parts of Quo's app page (QuoPanel.tsx) that are plain logic: which state its webhook is in,
 * how far back an import reaches, and an import's progress and result in words.
 */
import { t } from "@/lib/i18n";
import type { QuoImport, QuoState } from "./catalog";

/** A number in the Quo workspace, to pick the one texts go from (POST /apps/quo/numbers). */
export interface QuoNumber {
  id: string;
  /** E.164. */
  number: string;
  name: string;
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
