/**
 * Record payment, as the office's invoice page and the field app's visit both record one: checked
 * against the balance, a draft is marked sent first (a payment pays an invoice the client has), and
 * the row goes in under the person's own rules (owners, admins and office with the invoices area).
 * No receipt is sent: the client gets one only for what they pay online.
 *
 * The form makes the payment's id (`id`) when it opens, so the same payment sent twice (a second
 * tap, or a try again after the answer was lost) is one row: the database turns the second down as
 * a duplicate, and that counts as recorded. The database also checks the balance, one payment at a
 * time (20261112000450_payments_within_balance.sql), for when someone else just recorded it.
 */
import { paymentProblem } from "@crewtavo/core/money";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";

export type PaymentMethod = "check" | "cash" | "card" | "ach" | "other";

export interface PaymentRecord {
  /** Made once by the form (crypto.randomUUID()), and sent again with every try. */
  id: string;
  companyId: string;
  currency: string;
  invoice: { id: string; client_id: string; balance: number; draft: boolean };
  amount: number;
  tip?: number;
  method: PaymentMethod;
  receivedAt: string;
  notes: string | null;
}

export async function recordPayment(p: PaymentRecord) {
  // The same check AI assistants' record_payment makes (packages/core/src/money.ts).
  const problem = paymentProblem(p.amount, p.invoice.balance, p.currency);
  if (problem) throw new Error(problem);
  if (p.invoice.draft) unwrap(await supabase().from("invoices").update({ status: "sent" }).eq("id", p.invoice.id));
  const amount = Math.round(p.amount * 100) / 100;
  const sent = await supabase().from("payments").insert({
    id: p.id,
    company_id: p.companyId,
    invoice_id: p.invoice.id,
    client_id: p.invoice.client_id,
    amount,
    tip_amount: p.tip && p.tip > 0 ? Math.round(p.tip * 100) / 100 : 0,
    method: p.method,
    received_at: p.receivedAt,
    notes: p.notes,
  });
  // Already there under this id: an earlier try went through. Unless the amount was changed since,
  // which isn't recorded on top of it.
  if (sent.error?.code === "23505") {
    const { data: recorded } = await supabase().from("payments").select("amount").eq("id", p.id).maybeSingle();
    if (recorded && Number(recorded.amount) !== amount) {
      throw new Error(`This payment is already recorded, as ${formatMoneyCents(Number(recorded.amount))}. Close this and check the invoice.`);
    }
    return;
  }
  unwrap(sent);
}
