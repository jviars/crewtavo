/**
 * What an estimate or invoice document shows (EstimateDocument). Screens build one of these from
 * their own data: the staff app from Supabase, the Client Hub from its link's payload, Settings from a
 * sample. The look comes separately, from the business's estimate template (core documents.ts).
 */
import type { TemplateSettings } from "@crewtavo/core/documents";

/** The business at the top of the page. Address is already split into lines. */
export interface DocumentCompany {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string[];
  /** The logo's URL (/api/public/logo/...), or null for the business's initials. */
  logo: string | null;
  /** companies.settings, for the brand color when the template has none (documentColor). */
  settings?: unknown;
}

export interface DocumentLine {
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  total: number;
}

export interface DocumentSignature {
  name: string;
  /** A PNG data URL; null leaves the line blank to sign by hand. */
  image: string | null;
  /** ISO timestamp, printed as the date beside the signature. */
  date: string | null;
}

export interface DocumentData {
  kind: "estimate" | "invoice";
  number: number | null;
  /** ISO date the document is dated. */
  date: string | null;
  /** Estimates: "Good until". */
  validUntil?: string | null;
  /** Invoices: "Due". */
  dueOn?: string | null;
  /** The bold label on the summary strip under the address, like "Architectural shingle roof". */
  title?: string | null;
  /** The rest of the strip, like ["22.0 squares", "6/12 pitch", "Tear off 1 layer"]. */
  facts?: string[];
  client: { name: string; lines: string[] };
  lines: DocumentLine[];
  subtotal: number;
  discount: number;
  /** "Discount" unless given, like "Promo code SPRING". */
  discountLabel?: string;
  tax: number;
  total: number;
  /** Estimates: the deposit to get on the schedule. */
  deposit?: number | null;
  /**
   * Invoices: payments and refunds so far, and what's left. A payment's amount is what was paid
   * (printed as "−$500.00"); a refund's is negative (printed as "+$50.00").
   */
  payments?: Array<{ label: string; amount: number }>;
  balanceDue?: number | null;
  /** A note under the lines (the quote's message, an invoice's notes). */
  notes?: string | null;
  signatures?: { customer?: DocumentSignature | null; company?: DocumentSignature | null };
}

export interface EstimateDocumentProps {
  template: TemplateSettings;
  company: DocumentCompany;
  data: DocumentData;
  className?: string;
  /**
   * How many pages it prints on, for the "Page N of N" at the end. PrintableDocument works it out;
   * on screen the sheet is one page.
   */
  pages?: number;
}
