import { toCents } from "@crewtavo/core/money";

interface Paid {
  amount: number;
  method: string;
  processor?: string | null;
}

/**
 * What's left to refund on a payment. A refund is a negative payment on the invoice with the
 * payment's method but no link to the payment itself, so the most it can still give back is the
 * smallest of: the payment, what's still paid that way on the invoice, and what's still paid at all.
 * A $100 check refunded once has nothing left.
 */
export function refundable(payment: Paid, payments: Paid[]): number {
  const net = (list: Paid[]) => list.reduce((sum, p) => sum + toCents(p.amount), 0);
  const sameWay = payments.filter((p) => !p.processor && p.method === payment.method);
  return Math.max(0, Math.min(toCents(payment.amount), net(sameWay), net(payments))) / 100;
}
