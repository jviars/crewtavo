/**
 * Snow → Storm: where each snow customer stands, as its row says it (StormBoard.tsx). For the storm
 * coming (6pm today through tomorrow) that's what's left for the office to do, so the rows pile up
 * under it: to schedule, to check, scheduled, and not this storm. For a storm that's here today it's
 * how far along its visits are, and whether it's past the time it was to be clear by.
 */
import { clockText, inchesText, snowPlan, type SnowPlan, type SnowRules } from "@crewtavo/core/snow";
import type { Tone } from "@/components/ui/StatusPill";
import { companyCountry } from "@/lib/format";

/** The piles, in the order the office works them. */
export const STORM_GROUPS = ["schedule", "check", "scheduled", "off"] as const;
export type StormGroup = (typeof STORM_GROUPS)[number];

/** `tone` null is said in plain words, not a pill: nothing there needs doing. */
export interface Standing { group: StormGroup; label: string; tone: Tone | null; note?: string; plan: SnowPlan | null }

export const workText = (plan: SnowPlan) => (plan.kind === "salt" ? "Salt run" : plan.pushes > 1 ? `Plow, ${plan.pushes} pushes` : "Plow");

/**
 * A customer for the storm coming: `snow` is its forecast (null for none), `visits` how many of the
 * storm's visits it has, `told` whether its people have been told about this storm, `auto` whether
 * storms schedule themselves here as people are told.
 */
export function standingOf(site: { paused: boolean; located: boolean; rules: SnowRules; told: boolean }, snow: number | null, visits: number, auto = false): Standing {
  if (site.paused) return { group: "off", label: "Paused", tone: null, note: "Not checked while the job is paused", plan: null };
  if (!site.located) return { group: "check", label: "No map location", tone: "danger", note: "Not checked until its address is found", plan: null };
  if (snow == null) return { group: "off", label: "No forecast", tone: null, plan: null };
  const plan = snowPlan(site.rules, snow);
  if (!plan) {
    if (site.told) return { group: "check", label: "Forecast dropped", tone: "warning", note: visits ? "Told and scheduled. Cancel the visit if it's off." : "They were told. Let them know if it's off.", plan };
    return { group: "off", label: "Below trigger", tone: null, note: `${inchesText((site.rules.salt_trigger_in ?? site.rules.trigger_in) - snow)} short`, plan };
  }
  if (visits >= plan.pushes) return { group: "scheduled", label: "Scheduled", tone: "good", note: visits > 1 ? `${visits} visits` : undefined, plan };
  if (visits > 0) return { group: "schedule", label: `${visits} of ${plan.pushes} scheduled`, tone: "warning", note: "The forecast grew", plan };
  return { group: "schedule", label: "To schedule", tone: "warning", note: site.told ? "Crew told" : auto ? "Crew hears and it's scheduled within the hour, 10am to 10pm" : "Crew hears within the hour, 10am to 10pm", plan };
}

/** A customer's triggers in a line: "Plow at 2 in, salt at 1 in, again every 4 in". `noSalt` says so when it isn't salted. */
export function triggersText(rules: SnowRules, noSalt = false): string {
  return [
    `Plow at ${inchesText(rules.trigger_in)}`,
    rules.salt_trigger_in != null ? `salt at ${inchesText(rules.salt_trigger_in)}` : noSalt && "no salting",
    rules.repeat_in != null && `again every ${inchesText(rules.repeat_in)}`,
  ].filter(Boolean).join(", ");
}

/** How soon a customer is cleared, short enough for a row's right edge: "Clear by 6 AM · first". Null when it's neither promised nor ranked. */
export function clearText(clearBy: string | null, priority: number): string | null {
  const rank = priority === 1 ? "first" : priority === 3 ? "after the others" : null;
  if (clearBy) return [`Clear by ${clockText(clearBy, companyCountry())}`, rank].filter(Boolean).join(" · ");
  return priority === 1 ? "First priority" : priority === 3 ? "After the others" : null;
}

/**
 * What the subcontractors asked about a customer said, as one tone for its crew line: red if anyone
 * can't go, amber while anyone hasn't answered, green once everyone asked can go, and none when
 * nobody on it was asked.
 */
export function answersTone(said: Array<boolean | null>): "good" | "warning" | "danger" | undefined {
  if (!said.length) return undefined;
  if (said.some((a) => a === false)) return "danger";
  if (said.some((a) => a == null)) return "warning";
  return "good";
}

/** A storm that's here today, piled by what's left: to schedule (or more to schedule, as it grew), late, under way, and done. */
export const TODAY_GROUPS = ["schedule", "late", "going", "done"] as const;
export type TodayGroup = (typeof TODAY_GROUPS)[number];
export function todayGroup(row: { visits: number; more: number; progress: { status: string; late: boolean } }): TodayGroup {
  if (!row.visits || row.more > 0) return "schedule";
  if (row.progress.status === "completed") return "done";
  return row.progress.late ? "late" : "going";
}

/**
 * A storm that's here today, from its visits (the cancelled ones left out): the least far along
 * decides, and it's late once `clock` ("07:30", the business's time) passes `clearBy` with work left.
 */
export function progressOf(visits: Array<{ status: string }>, clearBy: string | null, clock: string): { status: string; late: boolean; note?: string } {
  if (!visits.length) return { status: "unscheduled", late: false };
  const done = visits.filter((v) => v.status === "completed").length;
  const status = done === visits.length ? "completed" : (["in_progress", "en_route"].find((s) => visits.some((v) => v.status === s)) ?? "scheduled");
  const late = Boolean(clearBy) && status !== "completed" && clock >= clearBy!.slice(0, 5);
  const pushes = visits.length > 1 ? `${done} of ${visits.length} pushes done` : undefined;
  return { status, late, note: late ? [`Due by ${clockText(clearBy!, companyCountry())}`, pushes].filter(Boolean).join(" · ") : pushes };
}
