/**
 * A call (messages.channel "call", on a business's Quo number) in words, for the client's timeline
 * and Messages: what it was and who with ("Missed call from Ana", "Call to Ana · 4 min"), and what
 * Quo added to it (a voicemail's words, its summary, next steps). With nobody named the words are
 * core/calls.ts callHeadline's, said through t(): the test holds the two together, so the body the
 * server keeps for lists and search and these never drift apart.
 */
import { callLength, readCall, type CallDetails, type CallOutcome } from "@crewtavo/core/calls";
import type { IconName } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";

/** "Missed call from Ana", "Voicemail from Ana · 42 sec", "Call with Ana · 4 min", "Call to Ana · 4 min"; "Missed call" with nobody named. */
export function callTitle(direction: string, call: Pick<CallDetails, "outcome" | "seconds">, who?: string | null): string {
  const name = who?.trim() || null;
  const out = direction === "out";
  // Nobody answered: there's no length to say.
  if (call.outcome === "missed") {
    if (out) return name ? t("Call to {name}, not answered", { name }) : t("Call not answered");
    return name ? t("Missed call from {name}", { name }) : t("Missed call");
  }
  let words: string;
  if (call.outcome === "voicemail") {
    words = out ? (name ? t("Left a voicemail for {name}", { name }) : t("Left a voicemail")) : name ? t("Voicemail from {name}", { name }) : t("Voicemail");
  } else {
    words = name ? (out ? t("Call to {name}", { name }) : t("Call with {name}", { name })) : t("Call", { context: "noun" });
  }
  const length = callLength(call.seconds);
  return length ? `${words} · ${length}` : words;
}

/** A call as the screens show it: its title, then what Quo added, each part empty when there's none. */
export interface CallView {
  outcome: CallOutcome;
  title: string;
  /** The voicemail's words, once Quo transcribed them. */
  voicemail: string | null;
  /** Quo's summary, a line each. */
  summary: string[];
  /** Quo's next steps from the call. */
  steps: string[];
}

/** A message's call, or null for one whose details weren't kept (its body says it in words then). */
export function callView(message: { direction: string; call?: unknown }, who?: string | null): CallView | null {
  const call = readCall(message.call);
  if (!call) return null;
  return { outcome: call.outcome, title: callTitle(message.direction, call, who), voicemail: call.voicemail ?? null, summary: call.summary ?? [], steps: call.next_steps ?? [] };
}

/** The call's icon: a phone, a phone with an x when nobody answered, a voicemail's tape. */
export const callIcon = (outcome: CallOutcome | null | undefined): IconName => (outcome === "missed" ? "phoneMissed" : outcome === "voicemail" ? "voicemail" : "phone");

/** One line for a list (Messages' rows): what the call was, then the voicemail's words or the summary's first line. */
export function callPreview(message: { direction: string; call?: unknown; body?: string | null }): string {
  const view = callView(message);
  if (!view) return message.body ?? "";
  const more = view.voicemail ? `“${view.voicemail}”` : view.summary[0];
  return more ? `${view.title}: ${more}` : view.title;
}

/** Long enough to fold on the timeline (a long voicemail, or a summary with many next steps): its first lines, then Show all. */
export const callIsLong = (view: Pick<CallView, "voicemail" | "summary" | "steps">) => (view.voicemail?.length ?? 0) > 320 || view.summary.length + view.steps.length > 6;

/** What a folded call shows: the voicemail and the summary's first three lines, no next steps. */
export const foldedCall = <V extends Pick<CallView, "summary" | "steps">>(view: V): V => ({ ...view, summary: view.summary.slice(0, 3), steps: [] });
