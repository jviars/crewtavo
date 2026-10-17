/**
 * Equipment: kinds, meters, starter maintenance schedules, and how schedules and due dates read.
 * Due states are worked out in Postgres (public.equipment_due); these turn them into words.
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
export interface PlanPreset extends PlanInterval {
  name: string;
}

/** Common schedules to start from. Every manual differs, so people adjust them. */
export const PLAN_PRESETS: Record<EquipmentKind, PlanPreset[]> = {
  truck: [
    { name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month" },
    { name: "Rotate tires", every_meter: 7500 },
    { name: "Inspection and registration", every_count: 1, every_unit: "year" },
  ],
  trailer: [
    { name: "Check tires, lights and brakes", every_count: 3, every_unit: "month" },
    { name: "Grease wheel bearings", every_count: 1, every_unit: "year" },
  ],
  mower: [
    { name: "Oil and filter", every_meter: 100, every_count: 1, every_unit: "year" },
    { name: "Sharpen blades", every_meter: 25 },
    { name: "Grease fittings", every_meter: 50 },
    { name: "Air filter", every_meter: 200 },
  ],
  machine: [
    { name: "Engine oil and filter", every_meter: 250 },
    { name: "Grease fittings", every_meter: 10 },
    { name: "Hydraulic filter", every_meter: 500 },
  ],
  tool: [{ name: "Tune-up", every_count: 1, every_unit: "year" }],
  other: [],
};

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
