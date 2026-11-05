/**
 * Billing rules the screens and the AI assistant share with the database:
 *   - the minimum charge and late fees, which the database applies (migrations 20261104000100 and
 *     000200); these say the same, for showing them before they happen;
 *   - time and materials: the hours and materials logged on a job that its invoice can still bill,
 *     and the lines that bill them (the database holds each to one line, 20261104000300).
 */
import { lineTotal, toCents, type Amount } from "./money";

export interface LateFee {
  type: "flat" | "percent";
  /** Dollars for flat, a percent of the balance for percent (1.5 is 1.5%). */
  amount: number;
  /** Days after the due date before the fee goes on. */
  grace_days: number;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** settings.minimum_charge, or null when it's off. */
export function minimumCharge(settings: Record<string, unknown> | null | undefined): number | null {
  const v = settings?.minimum_charge;
  return isNumber(v) && v > 0 ? v : null;
}

/** settings.late_fee, or null when it's off (or not one the database would apply). */
export function lateFeeSettings(settings: Record<string, unknown> | null | undefined): LateFee | null {
  const v = settings?.late_fee as Partial<LateFee> | null | undefined;
  if (!v || (v.type !== "flat" && v.type !== "percent") || !isNumber(v.amount) || v.amount <= 0) return null;
  return { type: v.type, amount: v.amount, grace_days: isNumber(v.grace_days) ? Math.max(0, Math.round(v.grace_days)) : 0 };
}

/** A fee on what's owed, to the cent: a percent of it, or the flat amount. */
export function lateFeeAmount(balance: Amount, fee: LateFee): number {
  const cents = fee.type === "flat" ? toCents(fee.amount) : Math.round((toCents(balance) * fee.amount) / 100);
  return cents / 100;
}

/**
 * The day an invoice's late fee goes on (the first day past its grace days), or null when it
 * never will: it has its fee already (an invoice gets one, once), nothing is owed, it isn't due, or
 * it's a draft, paid, void or written off, or a deposit (paid before the work, so never late).
 */
export function lateFeeOn(invoice: { kind: string; status: string; balance_due: Amount; due_on: string | null; late_fee_at?: string | null }, fee: LateFee | null): string | null {
  if (!fee || invoice.kind === "deposit" || invoice.late_fee_at || !invoice.due_on || toCents(invoice.balance_due) <= 0) return null;
  if (!["sent", "partially_paid", "overdue"].includes(invoice.status)) return null;
  const day = new Date(`${invoice.due_on}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + fee.grace_days + 1);
  return day.toISOString().slice(0, 10);
}

/**
 * What a Minimum charge line comes to: how far an invoice's charges (its lines above $0, not the
 * minimum or a late fee) are short of the minimum. 0 with no minimum, or no charges yet.
 */
export function minimumTopUp(lines: ReadonlyArray<{ quantity: Amount; unit_price: Amount; kind?: string | null }>, minimum: number | null): number {
  if (!minimum) return 0;
  const charges = lines.filter((l) => !l.kind).reduce((sum, l) => sum + Math.max(toCents(lineTotal(l.quantity, l.unit_price)), 0), 0);
  return charges > 0 ? Math.max(toCents(minimum) - charges, 0) / 100 : 0;
}

// ---------------------------------------------------------------------------------------------
// Time and materials
// ---------------------------------------------------------------------------------------------

export interface LoggedTime {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  category: string;
  approved_at: string | null;
}

export interface LoggedMaterial {
  id: string;
  name: string;
  quantity: Amount;
  unit: string;
  service_id: string | null;
  logged_at: string;
}

export interface PriceItem {
  id: string;
  name: string;
  unit: string;
  unit_price: Amount;
  taxable: boolean;
  active?: boolean;
}

/** Lines already on the job's invoices that aren't void, with what they bill. */
export interface BilledLine {
  time_entry_ids: readonly string[] | null;
  material_ids: readonly string[] | null;
}

/** Logged materials of the same item (or, without one, the same name) and unit, billed as one line. */
export interface MaterialGroup {
  key: string;
  name: string;
  unit: string;
  quantity: number;
  ids: string[];
  service_id: string | null;
  /** The price list's price; null for materials with no price list item, which the office prices. */
  unit_price: number | null;
  taxable: boolean;
}

/** Hours to two decimals, as an invoice shows them. */
export const entryHours = (t: Pick<LoggedTime, "started_at" | "ended_at">) => (t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 36_000) / 100 : 0);

/**
 * What a job's invoice can still bill: its finished hours that aren't breaks (approved or not), and
 * its logged materials grouped by item, leaving out what's on a line of another invoice already.
 */
export function workToBill(input: { time: readonly LoggedTime[]; materials: readonly LoggedMaterial[]; billed: readonly BilledLine[]; services: readonly PriceItem[] }) {
  const billedTime = new Set(input.billed.flatMap((l) => l.time_entry_ids ?? []));
  const billedMaterials = new Set(input.billed.flatMap((l) => l.material_ids ?? []));
  const hours = input.time
    .filter((t) => t.ended_at && t.category !== "break" && !billedTime.has(t.id) && entryHours(t) > 0)
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  const items = new Map(input.services.map((s) => [s.id, s]));
  const groups = new Map<string, MaterialGroup>();
  for (const m of [...input.materials].sort((a, b) => a.logged_at.localeCompare(b.logged_at))) {
    if (billedMaterials.has(m.id)) continue;
    const item = m.service_id ? items.get(m.service_id) : undefined;
    const key = `${item ? item.id : `name:${m.name.trim().toLowerCase()}`}|${m.unit}`;
    const group = groups.get(key);
    if (group) {
      group.quantity = Math.round((group.quantity + Number(m.quantity)) * 1000) / 1000;
      group.ids.push(m.id);
    } else {
      groups.set(key, {
        key,
        name: item?.name ?? m.name.trim(),
        unit: m.unit,
        quantity: Number(m.quantity),
        ids: [m.id],
        service_id: item?.id ?? null,
        unit_price: item ? Number(item.unit_price) : null,
        taxable: item?.taxable ?? true,
      });
    }
  }
  return { hours, materials: [...groups.values()] };
}

/** The price list items hours can be billed at (sold by the hour), with Labor first: the one it starts on. */
export function laborRates(services: readonly PriceItem[]): PriceItem[] {
  const hourly = services.filter((s) => s.active !== false && /^(hr|hrs|hour|hours)$/i.test(s.unit.trim()));
  return hourly.sort((a, b) => Number(b.name.trim().toLowerCase() === "labor") - Number(a.name.trim().toLowerCase() === "labor") || a.name.localeCompare(b.name));
}

export interface WorkLine {
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  taxable: boolean;
  time_entry_ids?: string[];
  material_ids?: string[];
}

const shortDay = (iso: string, timeZone: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });

/**
 * The lines that bill the chosen hours (one line at the rate item's price) and materials (a line
 * each, at its price, or the price the office gave one with no price list item). A material with no
 * price is left off.
 */
export function workLines(input: { hours: readonly LoggedTime[]; rate: PriceItem | null; materials: readonly MaterialGroup[]; prices?: Readonly<Record<string, number>>; timeZone: string }): WorkLine[] {
  const lines: WorkLine[] = [];
  const total = Math.round(input.hours.reduce((sum, t) => sum + entryHours(t), 0) * 100) / 100;
  if (input.rate && total > 0) {
    const days = [...new Set(input.hours.map((t) => shortDay(t.started_at, input.timeZone)))];
    lines.push({
      service_id: input.rate.id,
      name: input.rate.name,
      description: `Logged hours: ${days.length > 3 ? `${days[0]} to ${days.at(-1)}` : days.join(", ")}`,
      quantity: total,
      unit: input.rate.unit,
      unit_price: Number(input.rate.unit_price),
      taxable: input.rate.taxable,
      time_entry_ids: input.hours.map((t) => t.id),
    });
  }
  for (const m of input.materials) {
    const price = m.unit_price ?? input.prices?.[m.key];
    if (price == null || !(price >= 0)) continue;
    lines.push({ service_id: m.service_id, name: m.name, description: null, quantity: m.quantity, unit: m.unit, unit_price: price, taxable: m.taxable, material_ids: m.ids });
  }
  return lines;
}
