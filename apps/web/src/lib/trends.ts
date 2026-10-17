/** Series for the small trend sparklines on Home and Invoices. Pure functions, so they're unit tested. */
import { addDays, localDate } from "@crewtavo/core/time";

export interface TrendPayment {
  amount: number | string;
  received_at: string;
  invoice_id?: string | null;
}

export interface TrendInvoice {
  id: string;
  issued_on: string | null;
  due_on: string | null;
  balance_due: number | string;
}

const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Money collected so far this month, day by day, beside the same days of last month. `today` is the
 * company's local date (YYYY-MM-DD). This month's line stops at today; last month's runs the whole
 * month, with any days past the end of this month folded into the last point.
 */
export function monthToDate(payments: TrendPayment[], today: string, tz: string) {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const thisStart = `${today.slice(0, 8)}01`;
  const lastStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Array<number>(days).fill(0);
  const before = new Array<number>(days).fill(0);
  for (const p of payments) {
    const day = localDate(new Date(p.received_at), tz);
    const n = Number(day.slice(8));
    if (day >= thisStart && day <= today) now[n - 1] += Number(p.amount);
    else if (day >= lastStart && day < thisStart) before[Math.min(n, days) - 1] += Number(p.amount);
  }
  const todayN = Number(today.slice(8));
  let a = 0;
  let b = 0;
  return now.map((_, i) => {
    a += now[i];
    b += before[i];
    return { label: `By ${shortDay(`${today.slice(0, 8)}${String(i + 1).padStart(2, "0")}`)}`, now: i < todayN ? a : null, before: b };
  });
}

/**
 * What was owed, what was past due, and what had come in over the previous 30 days, as of today and
 * the same weekday in each of the weeks before. It walks back from today's balances: on an earlier
 * day an invoice owed its balance now plus whatever was paid on it since, and nothing before it was
 * issued. `invoices` should hold every invoice that is open now or was paid during the window
 * (drafts and voided invoices left out); `payments` everything received since `weeks` weeks and 30
 * days ago. Credits and voids aren't replayed, so earlier points are close rather than exact.
 */
export function receivablesTrend({ invoices, payments, today, tz, weeks = 12 }: { invoices: TrendInvoice[]; payments: TrendPayment[]; today: string; tz: string; weeks?: number }) {
  const paid = payments.map((p) => ({ day: localDate(new Date(p.received_at), tz), amount: Number(p.amount), invoice: p.invoice_id ?? null }));
  const byInvoice = new Map<string, Array<{ day: string; amount: number }>>();
  for (const p of paid) if (p.invoice) byInvoice.set(p.invoice, [...(byInvoice.get(p.invoice) ?? []), p]);
  const out: Array<{ label: string; owed: number; pastDue: number; collected: number }> = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const day = addDays(today, -7 * k);
    let owed = 0;
    let pastDue = 0;
    for (const inv of invoices) {
      if (!inv.issued_on || inv.issued_on > day) continue;
      const since = (byInvoice.get(inv.id) ?? []).filter((p) => p.day > day).reduce((s, p) => s + p.amount, 0);
      const balance = Math.max(0, Number(inv.balance_due) + since);
      owed += balance;
      if (inv.due_on && inv.due_on < day) pastDue += balance;
    }
    const from = addDays(day, -30);
    const collected = paid.filter((p) => p.day > from && p.day <= day).reduce((s, p) => s + p.amount, 0);
    out.push({ label: k === 0 ? "Today" : shortDay(day), owed: round(owed), pastDue: round(pastDue), collected: round(collected) });
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;
