/**
 * Equipment: kinds, meters, starter maintenance schedules, and how schedules and due dates read;
 * and the dates its paperwork (tags, inspection stickers) runs to. Due states are worked out in
 * Postgres (public.equipment_due, public.equipment_paperwork); these turn them into words.
 */

export const EQUIPMENT_KINDS = [
  { key: "truck", label: "Truck or vehicle", meter: "miles" },
  { key: "trailer", label: "Trailer", meter: "none" },
  { key: "mower", label: "Mower", meter: "hours" },
  { key: "machine", label: "Machine", meter: "hours" },
  { key: "tool", label: "Small tool", meter: "none" },
  { key: "other", label: "Other", meter: "none" },
] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number]["key"];
export type Meter = "hours" | "miles" | "none";
export type IntervalUnit = "day" | "week" | "month" | "year";
export type DueState = "overdue" | "due_soon" | "ok";

export const kindLabel = (kind: string) => EQUIPMENT_KINDS.find((k) => k.key === kind)?.label ?? "Other";
export const defaultMeter = (kind: string): Meter => EQUIPMENT_KINDS.find((k) => k.key === kind)?.meter ?? "none";

export interface PlanInterval {
  every_count?: number | null;
  every_unit?: IntervalUnit | string | null;
  every_meter?: number | null;
}
/** A starter schedule. Hours and miles are both given where they make sense, so it fits whichever the machine tracks. */
export interface PlanPreset {
  name: string;
  every_hours?: number;
  every_miles?: number;
  every_count?: number;
  every_unit?: IntervalUnit;
}

/** Common schedules to start from. Every manual differs, so people adjust them. */
export const PLAN_PRESETS: Record<EquipmentKind, PlanPreset[]> = {
  truck: [
    { name: "Oil change", every_miles: 5000, every_hours: 250, every_count: 6, every_unit: "month" },
    { name: "Rotate tires", every_miles: 7500, every_count: 6, every_unit: "month" },
  ],
  trailer: [
    { name: "Check tires, lights and brakes", every_count: 3, every_unit: "month" },
    { name: "Grease wheel bearings", every_count: 1, every_unit: "year" },
  ],
  mower: [
    { name: "Oil and filter", every_hours: 100, every_count: 1, every_unit: "year" },
    { name: "Sharpen blades", every_hours: 25 },
    { name: "Grease fittings", every_hours: 50 },
    { name: "Air filter", every_hours: 200 },
  ],
  machine: [
    { name: "Engine oil and filter", every_hours: 250, every_count: 1, every_unit: "year" },
    { name: "Grease fittings", every_hours: 10 },
    { name: "Hydraulic filter", every_hours: 500 },
  ],
  tool: [{ name: "Tune-up", every_count: 1, every_unit: "year" }],
  other: [],
};

/** Small-engine upkeep (generators, pressure washers, blowers, saws) for anything with an hour meter. */
const SMALL_ENGINE: PlanPreset[] = [
  { name: "Oil change", every_hours: 50, every_count: 1, every_unit: "year" },
  { name: "Clean the air filter", every_hours: 25 },
  { name: "Spark plug", every_hours: 100, every_count: 1, every_unit: "year" },
];

/** The starter schedules for a type of machine tracking `meter`; anything on hours without hour-based ones of its own gets small-engine upkeep. */
export function presetsFor(kind: string, meter: Meter | string): PlanPreset[] {
  const own = PLAN_PRESETS[kind as EquipmentKind] ?? [];
  return meter === "hours" && !own.some((p) => p.every_hours) ? SMALL_ENGINE : own;
}

/** A starter schedule as a machine tracking `meter` keeps it: its hours or miles, its date, and once a year if neither fits. */
export function presetInterval(p: PlanPreset, meter: Meter | string): Required<PlanInterval> {
  const every_meter = (meter === "hours" ? p.every_hours : meter === "miles" ? p.every_miles : null) ?? null;
  if (!every_meter && !p.every_count) return { every_meter: null, every_count: 1, every_unit: "year" };
  return { every_meter, every_count: p.every_count ?? null, every_unit: p.every_count ? p.every_unit ?? "month" : null };
}

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
const plural = (n: number, one: string, many = `${one}s`) => (Math.abs(n) === 1 ? one : many);

/** "hours" / "hour", "miles" / "mile". */
export const meterUnit = (meter: Meter | string, n = 2) => (meter === "miles" ? plural(n, "mile") : plural(n, "hour"));

/** "1,240.5 hours", "52,310 miles". */
export const formatMeter = (value: number | null | undefined, meter: Meter | string) =>
  value == null || meter === "none" ? "" : `${number(Number(value))} ${meterUnit(meter, Number(value))}`;

const unitWords: Record<IntervalUnit, string> = { day: "day", week: "week", month: "month", year: "year" };

/** "Every 100 hours or 1 year", "Every 6 months", "Every year", "Every 5,000 miles". */
export function describeInterval(plan: PlanInterval, meter: Meter | string): string {
  const parts: string[] = [];
  if (plan.every_meter && meter !== "none") parts.push(formatMeter(plan.every_meter, meter));
  if (plan.every_count && plan.every_unit) {
    const unit = unitWords[plan.every_unit as IntervalUnit] ?? plan.every_unit;
    parts.push(plan.every_count === 1 && !parts.length ? unit : `${plan.every_count} ${plural(plan.every_count, unit)}`);
  }
  return parts.length ? `Every ${parts.join(" or ")}` : "No schedule";
}

export interface DueInfo {
  state: DueState | string;
  days_left: number | null;
  meter_left: number | null;
  meter: Meter | string;
  every_meter?: number | null;
  last_done_on?: string | null;
  next_due_on?: string | null;
}

/** How much of the interval is left (1 = just done, 0 = due now, below 0 = overdue), by hours or miles and by date. */
function remaining(d: DueInfo) {
  const meterLeft = d.meter !== "none" && d.meter_left != null ? Number(d.meter_left) : null;
  const daysLeft = d.days_left != null ? Number(d.days_left) : null;
  const span = d.last_done_on && d.next_due_on ? (Date.parse(d.next_due_on) - Date.parse(d.last_done_on)) / 86_400_000 : null;
  return {
    meterLeft,
    daysLeft,
    byMeter: meterLeft != null && d.every_meter ? meterLeft / Number(d.every_meter) : null,
    byDate: daysLeft != null && span ? daysLeft / span : null,
  };
}

/** The share of the interval left on whichever limit is closer; null when unknown. For sorting. */
export function dueProgress(d: DueInfo): number | null {
  const { byMeter, byDate } = remaining(d);
  return byMeter == null ? byDate : byDate == null ? byMeter : Math.min(byMeter, byDate);
}

/**
 * When a schedule is due, in a few words: "3 days overdue", "12 hours over", "Due today",
 * "Due in 5 days", "Due in 40 hours". Leads with whichever limit is closer.
 */
export function dueSummary(d: DueInfo): string {
  const { meterLeft, daysLeft, byMeter, byDate } = remaining(d);
  const unit = (n: number) => meterUnit(d.meter, n);
  if (meterLeft != null && meterLeft <= 0) return meterLeft === 0 ? "Due now" : `${number(-meterLeft)} ${unit(-meterLeft)} over`;
  if (daysLeft != null && daysLeft < 0) return `${-daysLeft} ${plural(-daysLeft, "day")} overdue`;
  if (daysLeft === 0) return "Due today";
  const leadWithMeter =
    meterLeft != null &&
    (daysLeft == null ||
      (byMeter != null && byDate != null ? byMeter <= byDate : d.state === "due_soon" && daysLeft > 14));
  if (leadWithMeter) return `Due in ${number(meterLeft)} ${unit(meterLeft)}`;
  if (daysLeft != null) return daysLeft === 1 ? "Due tomorrow" : `Due in ${daysLeft} ${plural(daysLeft, "day")}`;
  return "Not scheduled";
}

/** Status pill tone for a due state. */
export const dueTone = (state: string): "danger" | "warning" | "good" => (state === "overdue" ? "danger" : state === "due_soon" ? "warning" : "good");

// ---------------------------------------------------------------------------------------------
// Tags and inspection: paperwork that runs out on a date (public.equipment_paperwork)
// ---------------------------------------------------------------------------------------------

export const DOCUMENT_KINDS = [
  { key: "registration", label: "Registration (tags)" },
  { key: "inspection", label: "Safety inspection" },
  { key: "emissions", label: "Emissions inspection" },
  { key: "insurance", label: "Insurance" },
  { key: "dot_inspection", label: "DOT annual inspection" },
  { key: "other", label: "Something else" },
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]["key"];

/** "Registration", "Safety inspection", or what an "other" is called. */
export const documentLabel = (kind: string, name?: string | null) =>
  kind === "other" ? name?.trim() || "Paperwork" : kind === "registration" ? "Registration" : DOCUMENT_KINDS.find((k) => k.key === kind)?.label ?? "Paperwork";

const ymd = (date: string) => date.split("-").map(Number) as [number, number, number];
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
/** The year and month `months` after (or before) year/month. */
function shiftMonth(year: number, month: number, months: number): [number, number] {
  const total = year * 12 + month - 1 + months;
  const y = Math.floor(total / 12);
  return [y, total - y * 12 + 1];
}
const isoDate = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** The last day of the month `months` after `from`'s month: an inspection sticker's date. "2026-11-05", 12 → "2027-11-30". */
export function endOfMonthAfter(from: string, months: number): string {
  const [y, m] = ymd(from);
  const [ny, nm] = shiftMonth(y, m, months);
  return isoDate(ny, nm, daysInMonth(ny, nm));
}

/** `from` moved on by `months`, on the same day, or the month's last day when `from` is a month's end (Feb 28 → Feb 29 in a leap year). */
export function addMonths(from: string, months: number): string {
  const [y, m, d] = ymd(from);
  const [ny, nm] = shiftMonth(y, m, months);
  const last = daysInMonth(ny, nm);
  return isoDate(ny, nm, d >= daysInMonth(y, m) ? last : Math.min(d, last));
}

/**
 * Quick picks for a renewal's new end date. Registration counts from the old date (renewing early
 * loses nothing, and up to a year late keeps its month, as Virginia does), or from this month when
 * there's none; inspections run to the end of the month a year (emissions two) from when they're
 * done; insurance and the rest count from the old date. People check it against the decal or card.
 */
export function renewalChoices(kind: string, expiresOn: string | null, today: string): Array<{ label: string; date: string }> {
  const from = (years: number) =>
    expiresOn && expiresOn >= addMonths(today, -12) ? addMonths(expiresOn, years * 12) : kind === "registration" ? endOfMonthAfter(today, years * 12) : addMonths(today, years * 12);
  switch (kind) {
    case "registration":
      return [1, 2, 3].map((n) => ({ label: `${n} ${plural(n, "year")}`, date: from(n) }));
    case "inspection":
    case "dot_inspection":
      return [{ label: "A year from this month", date: endOfMonthAfter(today, 12) }];
    case "emissions":
      return [
        { label: "2 years from this month", date: endOfMonthAfter(today, 24) },
        { label: "1 year from this month", date: endOfMonthAfter(today, 12) },
      ];
    case "insurance":
      return [
        { label: "6 months", date: expiresOn && expiresOn >= addMonths(today, -12) ? addMonths(expiresOn, 6) : addMonths(today, 6) },
        { label: "1 year", date: from(1) },
      ];
    default:
      return [1, 2].map((n) => ({ label: `${n} ${plural(n, "year")}`, date: from(n) }));
  }
}

/** "Ran out 3 days ago", "Runs out today", "Runs out tomorrow", "Runs out in 12 days", "Current", "Doesn't expire". */
export function expirySummary(daysLeft: number | null, expiresOn: string | null): string {
  if (!expiresOn || daysLeft == null) return "Doesn't expire";
  if (daysLeft < 0) return daysLeft === -1 ? "Ran out yesterday" : `Ran out ${-daysLeft} days ago`;
  if (daysLeft === 0) return "Runs out today";
  if (daysLeft === 1) return "Runs out tomorrow";
  return daysLeft <= 30 ? `Runs out in ${daysLeft} days` : "Current";
}
