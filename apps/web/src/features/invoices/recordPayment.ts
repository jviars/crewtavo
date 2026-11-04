/**
 * Record payment, as the office's invoice page and the field app's visit both record one: checked
 * against the balance, a draft is marked sent first (a payment pays an invoice the client has), and
 * the row goes in under the person's own rules (owners, admins and office with the invoices area).
 * No receipt is sent: the client gets one only for what they pay online.
 */
import { paymentProblem } from "@crewtavo/core/money";
import { supabase, unwrap } from "@/lib/api";

export type PaymentMethod = "check" | "cash" | "card" | "ach" | "other";

export interface PaymentRecord {
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
  unwrap(
    await supabase().from("payments").insert({
      company_id: p.companyId,
      invoice_id: p.invoice.id,
      client_id: p.invoice.client_id,
      amount: Math.round(p.amount * 100) / 100,
      tip_amount: p.tip && p.tip > 0 ? Math.round(p.tip * 100) / 100 : 0,
      method: p.method,
      received_at: p.receivedAt,
      notes: p.notes,
    }),
  );
}
