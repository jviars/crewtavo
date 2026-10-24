/**
 * Pay periods: each person's approved hours and pay for a stretch of dates, and marking them paid
 * once the business has paid them (through its own payroll or bank: Crewtavo moves no money).
 * Timesheets → Pay (routes/pay.ts) and AI assistants' pay tools both use these. Pay rates are read
 * with the server's key, so who may ask (office and up with job costs) is checked here.
 */
import { addDays, breakPay, localDate, OFFICE, paySummary, zonedTimeToUtc, type Permission, type Role } from "@crewtavo/core";
import type { Env } from "../env";
import { HttpError, must } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { timeRates } from "./payRates";
import { companyZone } from "./schedule";

export interface PayScope {
  db: Db;
  env: Env;
  companyId: string;
  userId: string;
  role: Role;
  permissions: readonly Permission[];
}

export const PAY_METHODS = ["direct_deposit", "check", "cash", "payroll_service", "other"] as const;

function mayPay(s: PayScope) {
  if (!(OFFICE as readonly string[]).includes(s.role) || !s.permissions.includes("job_costs")) {
    throw new HttpError(403, "Pay is for the office, with Job costs and profit. Ask an owner or admin.");
  }
}

async function names(s: PayScope) {
  const members = must(await s.db.from("memberships").select("user_id").eq("company_id", s.companyId));
  const profiles = members.length ? must(await s.db.from("profiles").select("user_id, full_name").in("user_id", members.map((m) => m.user_id))) : [];
  const byId = new Map(profiles.map((p) => [p.user_id, p.full_name]));
  return (id: string) => byId.get(id) ?? "Former team member";
}

/** Each person's hours and pay from `from` to `to` (local dates, inclusive), and whether they've been marked paid. */
export async function payPeriodSummary(s: PayScope, from: string, to: string) {
  mayPay(s);
  if (to < from) throw new HttpError(400, "The period has to end on or after it starts.");
  const { tz, settings } = await companyZone(s);
  const start = zonedTimeToUtc(from, "00:00", tz).toISOString();
  const end = zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString();
  const entries: Array<{ id: string; user_id: string; started_at: string; ended_at: string | null; category: string; approved_at: string | null }> = [];
  for (let page = 0; page < 25; page++) {
    const batch = must(await s.db.from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("company_id", s.companyId).gte("started_at", start).lt("started_at", end).order("id").range(page * 1000, page * 1000 + 999));
    entries.push(...batch);
    if (batch.length < 1000) break;
  }
  const [rates, nameOf, period] = await Promise.all([
    timeRates(adminClient(s.env), s.companyId, { from: start, to: end }),
    names(s),
    s.db.from("pay_periods").select("id, status, paid_at, notes, lines:pay_period_lines(user_id, paid_amount, method, reference, paid_at)").eq("company_id", s.companyId).eq("starts_on", from).eq("ends_on", to).maybeSingle(),
  ]);
  const summary = paySummary(entries, (e) => rates[e.id] ?? 0, nameOf, tz, breakPay(settings));
  const paid = new Map(((period.data?.lines ?? []) as Array<{ user_id: string; paid_amount: number | null; method: string | null; reference: string | null; paid_at: string | null }>).map((l) => [l.user_id, l]));
  return {
    from,
    to,
    timezone: tz,
    period_id: period.data?.id ?? null,
    status: period.data?.status ?? "open",
    ...summary,
    people: summary.people.map((p) => ({ ...p, paid: paid.get(p.user_id)?.paid_at ? paid.get(p.user_id) : null })),
  };
}

/**
 * Record that people were paid for a period (everyone with approved hours, or the ones given):
 * the amount (default what their hours come to), how, and a reference. Their time in it is then
 * locked. Refused while any of them has time that isn't approved or a clock still running.
 */
export async function markPaid(s: PayScope, body: { from: string; to: string; user_ids?: readonly string[]; method: (typeof PAY_METHODS)[number]; reference?: string | null; paid_on?: string; amounts?: Readonly<Record<string, number>>; notes?: string | null }) {
  const summary = await payPeriodSummary(s, body.from, body.to);
  const people = summary.people.filter((p) => (body.user_ids ? body.user_ids.includes(p.user_id) : p.hours > 0));
  if (!people.length) throw new HttpError(400, "Nobody has approved hours in that period to mark paid.");
  const waiting = people.filter((p) => p.unapproved_hours > 0 || p.running);
  if (waiting.length) {
    throw new HttpError(400, `Approve everyone's time first: ${waiting.map((p) => `${p.name} (${p.running ? "a clock is still running" : `${p.unapproved_hours} h not approved`})`).join(", ")}.`);
  }
  const { tz } = await companyZone(s);
  const paidAt = zonedTimeToUtc(body.paid_on ?? localDate(new Date(), tz), "12:00", tz).toISOString();
  const period = must(
    await s.db
      .from("pay_periods")
      .upsert({ company_id: s.companyId, starts_on: body.from, ends_on: body.to, ...(body.notes !== undefined && { notes: body.notes }) }, { onConflict: "company_id,starts_on,ends_on" })
      .select("id")
      .single(),
  );
  const lines = people.map((p) => ({
    company_id: s.companyId,
    period_id: period.id,
    user_id: p.user_id,
    hours: p.hours,
    overtime_hours: p.overtime_hours,
    break_hours: p.break_hours,
    amount: p.amount,
    paid_amount: body.amounts?.[p.user_id] ?? p.amount,
    method: body.method,
    reference: body.reference ?? null,
    paid_at: paidAt,
    paid_by: s.userId,
  }));
  must(await s.db.from("pay_period_lines").upsert(lines, { onConflict: "period_id,user_id" }).select("id"));
  // Paid once everyone with approved hours in it is.
  const everyone = summary.people.filter((p) => p.hours > 0).map((p) => p.user_id);
  const paidNow = new Set([...people.map((p) => p.user_id), ...summary.people.filter((p) => p.paid).map((p) => p.user_id)]);
  const allPaid = everyone.every((id) => paidNow.has(id));
  must(await s.db.from("pay_periods").update(allPaid ? { status: "paid", paid_at: paidAt, paid_by: s.userId } : { status: "open" }).eq("id", period.id).select("id"));
  return { period_id: period.id, status: allPaid ? "paid" : "open", paid: lines.map((l) => ({ user_id: l.user_id, name: people.find((p) => p.user_id === l.user_id)!.name, hours: l.hours, overtime_hours: l.overtime_hours, paid_amount: l.paid_amount })) };
}

/** Take back a paid mark (for the period, or some people), so their time can be changed again. */
export async function unmarkPaid(s: PayScope, body: { from: string; to: string; user_ids?: readonly string[] }) {
  mayPay(s);
  const period = must(await s.db.from("pay_periods").select("id").eq("company_id", s.companyId).eq("starts_on", body.from).eq("ends_on", body.to).maybeSingle(), "No pay period with those dates has been marked paid.");
  let query = s.db.from("pay_period_lines").update({ paid_at: null, paid_by: null, paid_amount: null, method: null, reference: null }).eq("period_id", period.id);
  if (body.user_ids) query = query.in("user_id", [...body.user_ids]);
  const changed = must(await query.select("user_id"));
  must(await s.db.from("pay_periods").update({ status: "open", paid_at: null, paid_by: null }).eq("id", period.id).select("id"));
  return { period_id: period.id, unmarked: changed.length };
}

/** Pay periods someone is marked paid for, newest first, with who and their totals. */
export async function payHistory(s: PayScope, limit = 20) {
  mayPay(s);
  const periods = must(
    await s.db
      .from("pay_periods")
      .select("id, starts_on, ends_on, status, paid_at, notes, lines:pay_period_lines(user_id, hours, overtime_hours, amount, paid_amount, method, reference, paid_at)")
      .eq("company_id", s.companyId)
      .order("starts_on", { ascending: false })
      .limit(limit),
  );
  const nameOf = await names(s);
  // Only the people still marked paid: a mark taken back leaves nothing to show.
  return periods.flatMap((p) => {
    const lines = (p.lines as Array<{ user_id: string; hours: number; overtime_hours: number; amount: number; paid_amount: number | null; method: string | null; reference: string | null; paid_at: string | null }>)
      .filter((l) => l.paid_at)
      .map((l) => ({ ...l, name: nameOf(l.user_id) }));
    return lines.length ? [{ ...p, lines, paid_total: Math.round(lines.reduce((sum, l) => sum + Number(l.paid_amount ?? 0), 0) * 100) / 100 }] : [];
  });
}
