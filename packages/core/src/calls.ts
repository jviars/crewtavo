/**
 * Calls on a client's timeline (messages with channel "call", from a business's Quo number:
 * apps/api/src/services/quo.ts). messages.call keeps what's known about one (CallDetails), and its
 * body says the same in words (callBody), for the Messages list, search, and anything that reads
 * only the words. The words are rewritten as more comes in: Quo's summary arrives a minute or two
 * after the call ends, a voicemail's words once it's transcribed.
 */

export type CallOutcome = "answered" | "missed" | "voicemail";

export interface CallDetails {
  /** How it went: someone answered, nobody did, or they left a voicemail. */
  outcome: CallOutcome;
  /** How long it lasted (the voicemail's length for one), when Quo said. */
  seconds: number | null;
  /** Quo's summary, a line each, once it's ready. */
  summary?: string[];
  /** Quo's next steps from the call. */
  next_steps?: string[];
  /** A voicemail's words, once Quo transcribed it. */
  voicemail?: string | null;
  /** Quo's id for the call (AC...). */
  quo_id: string;
}

const LINES = 20;
const LINE = 500;
const VOICEMAIL = 4000;

/** Lines as kept: words only, trimmed, none empty, within reason. */
export const callLines = (lines: unknown): string[] =>
  (Array.isArray(lines) ? lines : [])
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.replace(/\s+/g, " ").trim().slice(0, LINE))
    .filter(Boolean)
    .slice(0, LINES);

/** A voicemail's words as kept. */
export const voicemailWords = (words: unknown): string | null => (typeof words === "string" && words.trim() ? words.replace(/\s+/g, " ").trim().slice(0, VOICEMAIL) : null);

/** "42 sec", "4 min", "1 hr 5 min". */
export function callLength(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** What the call was, in a few words: "Missed call", "Voicemail · 42 sec", "Call · 4 min". */
export function callHeadline(direction: string, call: Pick<CallDetails, "outcome" | "seconds">): string {
  const length = callLength(call.seconds);
  if (call.outcome === "voicemail") return direction === "out" ? `Left a voicemail${length ? ` · ${length}` : ""}` : `Voicemail${length ? ` · ${length}` : ""}`;
  if (call.outcome === "missed") return direction === "out" ? "Call not answered" : "Missed call";
  return `Call${length ? ` · ${length}` : ""}`;
}

/**
 * The words kept as the call's body: the headline, then the voicemail's words, Quo's summary and
 * its next steps when there are some.
 */
export function callBody(direction: string, call: CallDetails): string {
  const parts = [callHeadline(direction, call)];
  if (call.voicemail) parts.push(`“${call.voicemail}”`);
  const summary = callLines(call.summary);
  if (summary.length) parts.push(summary.join("\n"));
  const steps = callLines(call.next_steps);
  if (steps.length) parts.push(`Next steps:\n${steps.map((step) => `• ${step}`).join("\n")}`);
  return parts.join("\n\n");
}

/** messages.call as read back: what's there, in the shape above, or null for anything else. */
export function readCall(value: unknown): CallDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const outcome = v.outcome === "answered" || v.outcome === "missed" || v.outcome === "voicemail" ? v.outcome : null;
  if (!outcome) return null;
  return {
    outcome,
    seconds: typeof v.seconds === "number" && Number.isFinite(v.seconds) ? v.seconds : null,
    summary: callLines(v.summary),
    next_steps: callLines(v.next_steps),
    voicemail: voicemailWords(v.voicemail),
    quo_id: typeof v.quo_id === "string" ? v.quo_id : "",
  };
}
