/**
 * An invoice as it reads with a different set of payments, worked out the way the database does it
 * (private.invoice_totals): what's paid is the sum of the payments, the balance is the total less
 * retainage and that, and an invoice that's been sent is paid, past due, partly paid or awaiting
 * payment from those. Used to take a payment off the screen at once while its Undo is offered, and
 * to put it back; the saved invoice replaces this as soon as it reloads.
 */

interface Settles<P> {
  status: string;
  total: number | string;
  retainage_amount: number | string;
  due_on: string | null;
  lines: unknown[];
  payments: P[];
}

export function settle<P extends { amount: number | string }, T extends Settles<P>>(invoice: T, payments: P[], today: string): T {
  const paid = Math.round(payments.reduce((sum, p) => sum + Number(p.amount), 0) * 100) / 100;
  const balance = Math.round((Number(invoice.total) - Number(invoice.retainage_amount) - paid) * 100) / 100;
  const settled = invoice.lines.length > 0 && balance <= 0;
  let status = invoice.status;
  if (status === "written_off") status = settled ? "paid" : status;
  else if (status !== "draft" && status !== "void") {
    status = settled ? "paid" : invoice.due_on && invoice.due_on < today ? "overdue" : paid > 0 ? "partially_paid" : "sent";
  }
  return { ...invoice, payments, amount_paid: paid, balance_due: balance, status } as T;
}
