/**
 * Marketing → Reviews' "Ask automatically" form (Reviews.tsx): what it shows, read from the two
 * starter rules and settings.reviews, and what it sends to PUT /api/reviews/asks, which changes the
 * rules (packages/core/src/marketing.ts says their shapes).
 */
import { ordinal, readAskRule, reviewSettings, type AskChannel, type AskWhen } from "@crewtavo/core/marketing";

export interface AskRuleRow {
  id: string;
  name: string;
  description: string | null;
  template_key: string | null;
  trigger: string;
  enabled: boolean;
  delay_minutes: number;
  conditions: unknown;
  actions: unknown;
}

export interface AskForm {
  enabled: boolean;
  when: AskWhen;
  channel: AskChannel;
  recurring: boolean;
  visits: number;
  /** How many reminders: none, one or two. */
  reminders: number;
  days: [number, number];
}

/** The starter rules, whether each is one the form can show, and the form as they are now. */
export function askRules(rules: AskRuleRow[], settings: Record<string, unknown> | null | undefined) {
  const afterRule = rules.find((r) => r.template_key === "review_after_job");
  const recurringRule = rules.find((r) => r.template_key === "review_recurring");
  const after = readAskRule(afterRule, "after_job");
  const recurring = readAskRule(recurringRule, "recurring");
  // On when either rule asks: a business that only asks on recurring work has it on.
  const on = Boolean(afterRule?.enabled || recurringRule?.enabled);
  const current = reviewSettings(settings);
  const form: AskForm = {
    enabled: on,
    when: (after?.when as AskWhen | undefined) ?? "job.completed",
    // The channel of a rule that's asking, before one that's off.
    channel: (afterRule?.enabled ? after?.channel : undefined) ?? (recurringRule?.enabled ? recurring?.channel : undefined) ?? after?.channel ?? recurring?.channel ?? "email",
    // Turned off altogether, recurring work comes back on with the rest.
    recurring: on ? Boolean(recurringRule?.enabled) : true,
    visits: current.recurringAfterVisits,
    reminders: current.reminderDays.length,
    days: [current.reminderDays[0] ?? 3, current.reminderDays[1] ?? 5],
  };
  return {
    afterRule,
    recurringRule,
    afterCustom: Boolean(afterRule && !after),
    recurringCustom: Boolean(recurringRule && !recurring),
    /** Only recurring work is asked right now: saving with the switch on asks after the rest too. */
    onlyRecurring: !afterRule?.enabled && Boolean(recurringRule?.enabled),
    /** A rule was deleted: saving puts it back. */
    missing: !afterRule || !recurringRule,
    form,
  };
}

/** The second reminder comes after the first. */
export const daysInOrder = (form: AskForm) => form.reminders < 2 || form.days[1] > form.days[0];

/** What PUT /api/reviews/asks is sent. */
export const askBody = (form: AskForm) => ({
  enabled: form.enabled,
  when: form.when,
  channel: form.channel,
  recurring: form.recurring,
  recurring_after_visits: form.visits,
  reminder_days: form.days.slice(0, form.reminders),
});

/**
 * Saving fewer reminders than now (`before`, `after`) with `waiting` asks that would lose one: what
 * the confirm says, since turning reminders back on later doesn't send them. Null when nothing is lost.
 */
export function reminderDropWords(before: number, after: number, waiting: number): { title: string; body: string; confirmLabel: string; cancelLabel: string } | null {
  if (after >= before || waiting <= 0) return null;
  const who = waiting === 1 ? "1 client is" : `${waiting.toLocaleString("en-US")} clients are`;
  const them = waiting === 1 ? "it" : "them";
  return after === 0
    ? {
        title: "Turn reminders off?",
        body: `${who} waiting on a reminder. Turning reminders off stops ${them} for good: turning them back on later won't send ${them}.`,
        confirmLabel: "Turn off",
        cancelLabel: "Keep them",
      }
    : {
        title: "Send one reminder only?",
        body: `${who} waiting on a second reminder. Saving stops ${them} for good: going back to two later won't send ${them}.`,
        confirmLabel: "Send one only",
        cancelLabel: "Keep them",
      };
}

/** What the save's toast says once reminders were dropped (PUT /api/reviews/asks' reminders_dropped). */
export const remindersDroppedWords = (dropped: number) =>
  dropped > 0 ? `Saved. ${dropped === 1 ? "1 waiting reminder was" : `${dropped.toLocaleString("en-US")} waiting reminders were`} stopped.` : null;

/** What asking by hand answers (POST /api/reviews/request). */
export interface AskResult {
  sent: boolean;
  link: string;
  detail: string;
  /** It went one way but not the other: the detail says which didn't, and why. */
  warning?: true;
}

/** The toast for an ask that went: a warning when it went one way but not the other, so that isn't missed. */
export const askToastKind = (r: Pick<AskResult, "warning">): "warning" | "success" => (r.warning ? "warning" : "success");

/**
 * The rest of Ask automatically on one line, under its timing, once it's folded (SetupSummary):
 * "By email · reminders 3 and 5 days after · recurring jobs after the 3rd visit".
 */
export function askSummary(form: Pick<AskForm, "channel" | "reminders" | "days" | "recurring" | "visits">): string {
  const by = form.channel === "both" ? "By text and email" : form.channel === "sms" ? "By text" : "By email";
  const days = form.days.slice(0, form.reminders);
  const reminders = !days.length ? "no reminders" : days.length === 1 ? `a reminder ${days[0]} ${days[0] === 1 ? "day" : "days"} after` : `reminders ${days[0]} and ${days[1]} days after`;
  const recurring = form.recurring ? `recurring jobs after the ${ordinal(form.visits)} visit` : "not on recurring work";
  return [by, reminders, recurring].join(" · ");
}
