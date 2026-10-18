interface StripeInvoiceRow {
  origin: string;
  status: string;
  detached_at: string | null;
}

/**
 * Made in Stripe and still open there: Stripe asks the client for all of it, so a payment is
 * recorded by marking it paid in Stripe, not here (the database refuses one too). One in a Stripe
 * account Crewtavo has since left isn't followed any more, so it doesn't count.
 */
export const paidInStripe = (rows: StripeInvoiceRow[]) =>
  rows.some((s) => s.origin === "stripe" && ["creating", "open", "processing"].includes(s.status) && !s.detached_at);

/** Past this, a bank payment has cleared or bounced (as in the API's integrations/stripe.ts). */
const CLEARING_DAYS = 30;

/**
 * A bank payment on its way through Stripe, if any. `left` when it's in a Stripe account Crewtavo
 * has since left, so it won't show up here on its own; and past the days one can take, it has
 * cleared or bounced there, so it no longer counts (the Client Hub takes payments again).
 */
export function bankPayment<T extends StripeInvoiceRow>(rows: T[], now = Date.now()): (T & { left: boolean }) | null {
  const row = rows.find((s) => s.status === "processing" && (!s.detached_at || now - Date.parse(s.detached_at) < CLEARING_DAYS * 86_400_000));
  return row ? { ...row, left: Boolean(row.detached_at) } : null;
}
