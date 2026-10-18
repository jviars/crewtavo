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
