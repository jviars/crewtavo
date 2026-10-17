/**
 * Stripe over its REST API (no SDK, so it runs anywhere): Checkout sessions for invoices and
 * webhook signature checks. One Stripe account per deployment; the hosted version would use
 * Stripe Connect so each company is paid directly.
 */
import { hmacSha256Hex, safeEqual } from "../lib/crypto";

export async function createCheckoutSession(
  secretKey: string,
  input: { lines: Array<{ name: string; amountCents: number }>; currency: string; successUrl: string; cancelUrl: string; metadata: Record<string, string>; email?: string | null },
): Promise<{ id: string; url: string }> {
  const form = new URLSearchParams({
    mode: "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    "payment_method_types[0]": "card",
    "payment_method_types[1]": "us_bank_account",
  });
  input.lines.forEach((line, i) => {
    form.set(`line_items[${i}][quantity]`, "1");
    form.set(`line_items[${i}][price_data][currency]`, input.currency.toLowerCase());
    form.set(`line_items[${i}][price_data][unit_amount]`, String(line.amountCents));
    form.set(`line_items[${i}][price_data][product_data][name]`, line.name.slice(0, 250));
  });
  for (const [key, value] of Object.entries(input.metadata)) {
    form.set(`metadata[${key}]`, value);
    form.set(`payment_intent_data[metadata][${key}]`, value);
  }
  if (input.email) form.set("customer_email", input.email);

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const json = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !json.url || !json.id) throw new Error(json.error?.message ?? `Stripe returned ${response.status}`);
  return { id: json.id, url: json.url };
}

/** Verify a Stripe-Signature header (t=..., v1=...) and a 5-minute tolerance. */
export async function verifyStripeSignature(payload: string, header: string | undefined, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  const signatures = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((sig) => safeEqual(sig, expected));
}
