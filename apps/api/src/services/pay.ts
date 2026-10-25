/**
 * Pay periods: each person on the team's approved hours and pay for a stretch of dates, their piece
 * pay (job pay done in it, per square, per job or per day), and marking them paid once the business
 * has paid them (through its own payroll or bank: Crewtavo moves no money). Subs aren't in them, even
 * with their hours kept: they're paid by the job. Marking someone paid marks their piece
 * pay in the period paid with it, and taking the mark back puts it back to done: the database does
 * both (20261025003003_piece_pay_periods.sql). Timesheets → Pay (routes/pay.ts) and AI assistants'
 * pay tools both use these. Pay rates are read with the server's key, so who may ask (office and up
 * with job costs) is checked here.
 */
import { addDays, breakPay, localDate, OFFICE, paySummary, zonedTimeToUtc, type Permission, type Role } from "@crewtavo/core";
import type { Env } from "../env";
import { dbError, HttpError, must } from "../lib/http";
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

export interface PiecePayLine {
  id: string;
  user_id: string;
  job_id: string;
  job_number: number | null;
  job_title: string;
  total: number;
  status: string;
  earned_on: string | null;
}

/**
 * Team members' piece pay for a period: done and earned on a day in it, or already paid with it
 * (`periodId`). The same rule the database uses when the period is marked paid (private.period_piece).
 */
async function periodPiecePay(s: PayScope, from: string, to: string, periodId: string | null): Promise<PiecePayLine[]> {
  let query = s.db.from("job_pay").select("id, user_id, job_id, total, status, earned_on, job:jobs(number, title)").eq("company_id", s.companyId).not("user_id", "is", null);
  query = periodId
    ? query.or(`and(status.eq.done,earned_on.gte.${from},earned_on.lte.${to}),and(status.eq.paid,pay_period_id.eq.${periodId})`)
    : query.eq("status", "done").gte("earned_on", from).lte("earned_on", to);
  const rows = must(await query.order("earned_on").order("id").limit(5000));
  return rows.map((r) => {
    const job = (Array.isArray(r.job) ? r.job[0] : r.job) as { number: number | null; title: string } | null;
    return { id: r.id, user_id: r.user_id!, job_id: r.job_id, job_number: job?.number ?? null, job_title: job?.title ?? "", total: Number(r.total), status: r.status, earned_on: r.earned_on };
  });
}

/**
 * The company's subs' sign-ins. A sub the office keeps the hours of (Uses the clock) has time
 * entries, but their pay goes through job pay and the 1099, not payroll: they're never in a pay
 * period. Read with the server's key, so nothing the asker can't see lets one slip in.
 */
async function subSignIns(s: PayScope): Promise<Set<string>> {
  const rows = must(await adminClient(s.env).from("memberships").select("user_id").eq("company_id", s.companyId).eq("role", "subcontractor"));
  return new Set(rows.map((m) => m.user_id));
}

/** Subs are paid by the job, under Subs: their hours aren't payroll. */
export const SUBS_NOT_PAYROLL = "Subs are paid by the job, under Subs, not with a pay period. Their hours on Timesheets are only for your records.";

/**
 * Each person on the team's hours and pay from `from` to `to` (local dates, inclusive): hourly, piece
 * pay (with the jobs it's for) and the two together, and whether they've been marked paid. Subs'
 * hours are left out: they're paid by the job.
 */
export async function payPeriodSummary(s: PayScope, from: string, to: string) {
  mayPay(s);
  if (to < from) throw new HttpError(400, "The period has to end on or after it starts.");
  const { tz, settings } = await companyZone(s);
  const start = zonedTimeToUtc(from, "00:00", tz).toISOString();
  const end = zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString();
  const subs = await subSignIns(s);
  const entries: Array<{ id: string; user_id: string; started_at: string; ended_at: string | null; category: string; approved_at: string | null }> = [];
  for (let page = 0; page < 25; page++) {
    const batch = must(await s.db.from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("company_id", s.companyId).gte("started_at", start).lt("started_at", end).order("id").range(page * 1000, page * 1000 + 999));
    entries.push(...batch.filter((e) => !subs.has(e.user_id)));
    if (batch.length < 1000) break;
  }
  const [rates, nameOf, period] = await Promise.all([
    timeRates(adminClient(s.env), s.companyId, { from: start, to: end }),
    names(s),
    s.db.from("pay_periods").select("id, status, paid_at, notes, lines:pay_period_lines(user_id, paid_amount, piece_amount, method, reference, paid_at)").eq("company_id", s.companyId).eq("starts_on", from).eq("ends_on", to).maybeSingle(),
  ]);
  if (period.error) throw dbError(period.error);
  const piece = await periodPiecePay(s, from, to, period.data?.id ?? null);
  const summary = paySummary(entries, (e) => rates[e.id] ?? 0, nameOf, tz, breakPay(settings), piece);
  const paid = new Map(((period.data?.lines ?? []) as Array<{ user_id: string; paid_amount: number | null; piece_amount: number; method: string | null; reference: string | null; paid_at: string | null }>).map((l) => [l.user_id, l]));
  return {
    from,
    to,
    timezone: tz,
    period_id: period.data?.id ?? null,
    status: period.data?.status ?? "open",
    ...summary,
    people: summary.people.map((p) => ({ ...p, piece: piece.filter((x) => x.user_id === p.user_id), paid: paid.get(p.user_id)?.paid_at ? paid.get(p.user_id) : null })),
  };
}

/**
 * Record that people were paid for a period (everyone with approved hours or piece pay, or the ones
 * given): the amount (default what their hours and piece pay come to), how, and a reference. Their
 * time and piece pay in it are then locked. Refused while any of them has time that isn't approved or
 * a clock still running, and (by the database) when their piece pay has changed since the summary.
 */
export async function markPaid(s: PayScope, body: { from: string; to: string; user_ids?: readonly string[]; method: (typeof PAY_METHODS)[number]; reference?: string | null; paid_on?: string; amounts?: Readonly<Record<string, number>>; notes?: string | null }) {
  const summary = await payPeriodSummary(s, body.from, body.to);
  if (body.user_ids?.length) {
    const subs = await subSignIns(s);
    if (body.user_ids.some((id) => subs.has(id))) throw new HttpError(400, SUBS_NOT_PAYROLL);
  }
  const owed = (p: { hours: number; piece_amount: number }) => p.hours > 0 || p.piece_amount > 0;
  const people = summary.people.filter((p) => (body.user_ids ? body.user_ids.includes(p.user_id) : owed(p)));
  if (!people.length) throw new HttpError(400, "Nobody has approved hours or piece pay in that period to mark paid.");
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
    piece_amount: p.piece_amount,
    paid_amount: body.amounts?.[p.user_id] ?? p.amount,
    method: body.method,
    reference: body.reference ?? null,
    paid_at: paidAt,
    paid_by: s.userId,
  }));
  must(await s.db.from("pay_period_lines").upsert(lines, { onConflict: "period_id,user_id" }).select("id"));
  // Paid once everyone with approved hours or piece pay in it is.
  const everyone = summary.people.filter(owed).map((p) => p.user_id);
  const paidNow = new Set([...people.map((p) => p.user_id), ...summary.people.filter((p) => p.paid).map((p) => p.user_id)]);
  const allPaid = everyone.every((id) => paidNow.has(id));
  must(await s.db.from("pay_periods").update(allPaid ? { status: "paid", paid_at: paidAt, paid_by: s.userId } : { status: "open" }).eq("id", period.id).select("id"));
  return {
    period_id: period.id,
    status: allPaid ? "paid" : "open",
    paid: lines.map((l) => ({ user_id: l.user_id, name: people.find((p) => p.user_id === l.user_id)!.name, hours: l.hours, overtime_hours: l.overtime_hours, piece_amount: l.piece_amount, paid_amount: l.paid_amount })),
  };
}

/** Take back a paid mark (for the period, or some people), so their time can be changed again (and their piece pay is done again, owed). */
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
      .select("id, starts_on, ends_on, status, paid_at, notes, lines:pay_period_lines(user_id, hours, overtime_hours, amount, piece_amount, paid_amount, method, reference, paid_at)")
      .eq("company_id", s.companyId)
      .order("starts_on", { ascending: false })
      .limit(limit),
  );
  const nameOf = await names(s);
  // Only the people still marked paid: a mark taken back leaves nothing to show.
  return periods.flatMap((p) => {
    const lines = (p.lines as Array<{ user_id: string; hours: number; overtime_hours: number; amount: number; piece_amount: number; paid_amount: number | null; method: string | null; reference: string | null; paid_at: string | null }>)
      .filter((l) => l.paid_at)
      .map((l) => ({ ...l, name: nameOf(l.user_id) }));
    return lines.length ? [{ ...p, lines, paid_total: Math.round(lines.reduce((sum, l) => sum + Number(l.paid_amount ?? 0), 0) * 100) / 100 }] : [];
  });
}
