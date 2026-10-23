/**
 * What a Client Hub link loads (GET /api/hub/:token), and the estimate or invoice document built
 * from it: the business's template (EstimateDocument) is what prints, and what a signed estimate
 * shows. Quotes go through the same builder as the office and the iPad (documents/build.ts), so a
 * client's copy matches theirs. Also the words the price range page shows. No React here, so it's
 * tested on its own.
 */
import { documentColor, templateSettings, type TemplateSettings } from "@crewtavo/core/documents";
import { normalizePitch, pitchFactor } from "@crewtavo/core/geo";
import { quoteTotals } from "@crewtavo/core/money";
import { dateIn, formatDate, formatMoney, formatMoneyCents, formatNumber, todayIn } from "@/lib/format";
import { documentLines, inkOn, licenseLine, quoteDocument as buildQuoteDocument } from "../documents/build";
import type { DocumentCompany, DocumentData } from "../documents/types";

export interface HubLine {
  id?: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  taxable?: boolean;
  optional?: boolean;
  selected?: boolean;
  /** Optional lines that share a group are one choice (Good, Better, Best): the client picks one. */
  option_group?: string | null;
}
export interface HubCompany {
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone?: string | null;
  branding?: { color?: string } | null;
  logo?: string | null;
  /** The letterhead's address lines: the street, then "City, ST 12345". */
  address?: string[];
}
/** A map drawing the office chose to show the client, with the sizes measured on it. */
export interface HubDrawing {
  id: string;
  title: string;
  has_picture: boolean;
  sections: Array<{ label: string; kind: string; value: number; unit: string; pitch?: string }>;
  total_area_sqft: number;
  total_length_ft: number;
  roofing_squares: number | null;
  roof_pitch: string | null;
  imagery: string | null;
  /** When it was measured. Servers that don't send it get a page without the date. */
  measured_at?: string | null;
}
export type HubPromoInfo = { code: string; kind: string; value: number; description: string | null } | null;
/** Who signed a quote. "manual": the office marked it approved, so nobody signed on the client's line. */
export interface HubApproval {
  name: string;
  signature: string | null;
  signed_at: string | null;
  method?: "manual" | "in_person" | null;
  company: { name: string; signature: string; signed_at: string | null } | null;
}
/** A roof estimate sent as a price range: the range, what's in it and what could move it. */
export interface HubRange {
  low: number;
  high: number;
  sent_at: string | null;
  accepted_at: string | null;
  included: string[];
  maybe: Array<{ name: string; price: number; per: string | null }>;
}
export interface QuoteView {
  kind: "quote";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: HubCompany;
  /** The estimate template (core documents.ts); read through templateSettings(). */
  template?: unknown;
  quote: {
    id: string;
    number: number;
    status: string;
    title: string;
    message: string | null;
    change_order_for?: string | null;
    /** Null while the quote is out as a price range: the exact price isn't sent. */
    subtotal?: number | null;
    discount_amount: number | null;
    promo: HubPromoInfo;
    tax_rate: number;
    tax_amount?: number | null;
    total?: number | null;
    deposit_amount: number | null;
    valid_until: string | null;
    sent_at?: string | null;
    approved_at: string | null;
    client: { display_name: string } | null;
    property: { line1: string; city: string | null; region?: string | null; postal_code?: string | null } | null;
    package?: { name: string } | null;
    approval?: HubApproval | null;
    range?: HubRange | null;
    lines: HubLine[];
  };
}
export interface InvoiceView {
  kind: "invoice";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: HubCompany;
  template?: unknown;
  can_pay: boolean;
  /** A bank payment through Stripe is on its way; asking again would charge twice. */
  processing?: boolean;
  /** Made in Stripe, so it's paid exactly as billed there (no promo codes). */
  from_stripe?: boolean;
  tips: boolean;
  invoice: {
    id: string;
    number: number;
    status: string;
    subject: string | null;
    notes: string | null;
    issued_on: string;
    due_on: string | null;
    subtotal: number;
    discount_amount: number;
    tax_amount: number;
    total: number;
    retainage_amount: number;
    amount_paid: number;
    balance_due: number;
    promo: HubPromoInfo;
    client: { display_name: string } | null;
    lines: HubLine[];
    payments: Array<{ amount: number; tip_amount: number; received_at: string }>;
  };
}

/** The template a Hub page prints with: the business's, or the built-in look from an older server. */
export const hubTemplate = (view: { template?: unknown }): TemplateSettings => templateSettings(view.template);

/** The letterhead: the business as its clients see it. */
export function hubLetterhead(company: HubCompany): DocumentCompany {
  return {
    name: company.name,
    phone: company.phone?.trim() || null,
    email: company.email?.trim() || null,
    website: company.website?.trim() || null,
    address: company.address ?? [],
    logo: company.logo ?? null,
    settings: { branding: company.branding ?? null },
  };
}

/** The roof's size from its drawing, for the strip under the address: ["22.4 squares", "6/12 pitch"]. */
function roofFacts(drawings: HubDrawing[] | undefined): string[] {
  const roof = drawings?.find((d) => d.roofing_squares != null && Number(d.roofing_squares) > 0);
  if (!roof) return [];
  return [`${formatNumber(Number(roof.roofing_squares), 1)} squares`, ...(roof.roof_pitch ? [`${roof.roof_pitch} pitch`] : [])];
}

/**
 * A quote as its template document, with both signatures once it's signed. `chosen` is the optional
 * lines the client has ticked on the page (printing follows them, worked out to the cent as the
 * database does); without it, the lines and amounts as saved.
 */
export function quoteDocument(view: QuoteView, chosen?: readonly string[]): DocumentData {
  const q = view.quote;
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lines = q.lines.map((l) => ({ ...l, selected: !l.optional || (chosen ? chosen.includes(l.id ?? "") : l.selected !== false) }));
  const worked = chosen || q.subtotal == null || q.total == null ? quoteTotals(lines, { taxRate: q.tax_rate, discountAmount: q.discount_amount ?? 0, promo: q.promo }) : null;
  const amounts = worked
    ? { subtotal: worked.subtotal, discount_amount: worked.discount, tax_amount: worked.tax, total: worked.total }
    : { subtotal: q.subtotal ?? 0, discount_amount: q.discount_amount ?? 0, tax_amount: q.tax_amount ?? 0, total: q.total ?? 0 };
  return buildQuoteDocument({ ...q, ...amounts }, lines, {
    // Dated the day it was sent where the business is.
    date: q.sent_at ? dateIn(q.sent_at, tz) : todayIn(tz),
    facts: [...(q.package ? [q.package.name] : []), ...roofFacts(view.drawings)],
  });
}

/** An invoice as its template document: what was billed, what's been paid and refunded, and what's left. */
export function invoiceDocument(view: InvoiceView): DocumentData {
  const inv = view.invoice;
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Printed as deductions from the total ("−$500.00"); a refund's negative amount adds back.
  const payments = inv.payments.map((p) => ({
    label: `${Number(p.amount) > 0 ? "Paid" : "Refunded"} ${formatDate(dateIn(p.received_at, tz))}`,
    amount: Number(p.amount),
  }));
  if (Number(inv.retainage_amount) > 0) payments.unshift({ label: "Retainage (billed later)", amount: Number(inv.retainage_amount) });
  const discount = Math.min(Number(inv.discount_amount), Math.max(Number(inv.subtotal), 0));
  return {
    kind: "invoice",
    number: inv.number,
    date: inv.issued_on,
    dueOn: inv.due_on,
    title: inv.subject,
    client: { name: inv.client?.display_name ?? "", lines: [] },
    lines: documentLines(inv.lines),
    subtotal: Number(inv.subtotal),
    discount,
    discountLabel: discount > 0 && inv.promo ? `Promo code ${inv.promo.code}` : undefined,
    tax: Number(inv.tax_amount),
    total: Number(inv.total),
    payments,
    balanceDue: Number(inv.balance_due),
    notes: inv.notes?.trim() || null,
  };
}

// ---------------------------------------------------------------------------------------------
// The price range page
// ---------------------------------------------------------------------------------------------

/** Whole dollars when the amount is whole ("$650"), else with cents ("$3.50"). */
export const priceText = (amount: number) => (Number.isInteger(Number(amount)) ? formatMoney(amount) : formatMoneyCents(amount));

const UNIT_WORDS: Record<string, string> = { ft: "foot", lf: "foot", "sq ft": "square foot", sqft: "square foot", sq: "square", yd: "yard", "sq yd": "square yard", hr: "hour", ea: "", each: "" };

/** What a "could change the price" item costs: "$95 a sheet", "$85 a square", "$650". */
export function maybePrice(item: { price: number; per: string | null }): string {
  const unit = (item.per ?? "").trim().toLowerCase();
  const word = unit in UNIT_WORDS ? UNIT_WORDS[unit]! : unit;
  return word ? `${priceText(item.price)} ${/^([aeiou]|hour)/.test(word) ? "an" : "a"} ${word}` : priceText(item.price);
}

/** The package as the homeowner reads it: "Architectural shingle" -> "Architectural shingle roof". */
export function packageLabel(name: string | null | undefined): string {
  const clean = (name ?? "").trim();
  return !clean || /\broof/i.test(clean) ? clean : `${clean} roof`;
}

/** The property on one line: "1482 Ridgeview Dr, Columbus, OH 43221". */
export function propertyLine(property: QuoteView["quote"]["property"]): string {
  if (!property) return "";
  const place = [property.region, property.postal_code].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return [property.line1, property.city, place].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}

/** A phone number as a link: "tel:+16145550188" from "+1 (614) 555-0188". */
export const phoneHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** A link to the business's website, with https:// added when it was typed without it. */
export const websiteHref = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);

const INK = "#0f2a35";

/** How well a color reads on white, as a contrast ratio from 1 to 21. Anything that isn't a hex color counts as unreadable. */
function contrastOnWhite(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 1;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}

/**
 * The color the range page is drawn in: the estimate template's (documentColor), so the link
 * matches the paper the homeowner signs later. `text` is that color for words on white, or ink when
 * it's too light to read at body size; `on` is the color of words on a button filled with it.
 */
export function hubAccent(view: { template?: unknown; company: Pick<HubCompany, "branding"> }): { color: string; text: string; on: string } {
  const color = documentColor(hubTemplate(view), { branding: view.company.branding ?? null });
  return { color, text: contrastOnWhite(color) >= 4.5 ? color : INK, on: inkOn(color) };
}

/** "2026-10-23" -> "October 23, 2026", or "October 23" without the year. */
export function dayText(date: string, withYear = true): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", withYear ? { month: "long", day: "numeric", year: "numeric" } : { month: "long", day: "numeric" });
}

/**
 * The dates under the title, on the business's calendar: the day the range was sent ("October 23,
 * 2026") and the day it's good until ("November 22", with the year when it's another year). Null
 * for what isn't known, like the sent date on a preview. `today` is today where the business is.
 */
export function rangeDates(view: Pick<QuoteView, "company" | "quote">, today: string): { sent: string | null; goodUntil: string | null; expired: boolean } {
  const q = view.quote;
  const tz = view.company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sentAt = q.range?.sent_at ?? q.sent_at ?? null;
  const sentOn = sentAt ? dateIn(sentAt, tz) : null;
  const until = q.valid_until ? q.valid_until.slice(0, 10) : null;
  return {
    sent: sentOn ? dayText(sentOn) : null,
    goodUntil: until ? dayText(until, until.slice(0, 4) !== (sentOn ?? today).slice(0, 4)) : null,
    expired: Boolean(until && until < today),
  };
}

/** The roof as measured, for "Your roof, measured". */
export interface MeasuredRoof {
  /** The drawings the roof is on, whose pictures go on the page. */
  drawings: HubDrawing[];
  /** The roof's surface at its pitch, without waste: the roof itself, not what's ordered for it. */
  areaSqft: number;
  /** The same in roofing squares (100 sq ft each). */
  squares: number;
  /** The pitch most of the roof is at ("6/12", or "Flat"), and whether some of it is at another. */
  pitch: string | null;
  mixed: boolean;
}

const slopeFactor = (pitch: string | null | undefined) => {
  try {
    return pitchFactor(pitch);
  } catch {
    return 1;
  }
};
const pitchName = (pitch: string | null | undefined) => {
  try {
    const rise = normalizePitch(pitch);
    return rise === "0/12" ? "Flat" : rise || null;
  } catch {
    return null;
  }
};

/**
 * The roof from the drawings shown on the quote: each area at its own pitch, added up, without the
 * waste the saved squares include. Null when none of them is a roof (no squares on it).
 */
export function measuredRoof(drawings: HubDrawing[] | undefined): MeasuredRoof | null {
  const roofs = (drawings ?? []).filter((d) => Number(d.roofing_squares) > 0);
  if (!roofs.length) return null;
  let area = 0;
  const byPitch = new Map<string, number>();
  for (const d of roofs) {
    const areas = d.sections.filter((s) => s.kind === "Area" && Number(s.value) > 0);
    // A drawing without its areas listed: its whole area at its pitch.
    const parts = areas.length ? areas.map((s) => ({ plan: Number(s.value), pitch: s.pitch || d.roof_pitch })) : [{ plan: Number(d.total_area_sqft) || 0, pitch: d.roof_pitch }];
    for (const part of parts) {
      const surface = part.plan * slopeFactor(part.pitch);
      area += surface;
      const name = pitchName(part.pitch);
      if (name) byPitch.set(name, (byPitch.get(name) ?? 0) + surface);
    }
  }
  // Nothing to work it out from: the saved squares, waste and all, are closer than nothing.
  if (!(area > 0)) area = roofs.reduce((sum, d) => sum + Number(d.roofing_squares) * 100, 0);
  const main = [...byPitch].sort((a, b) => b[1] - a[1])[0];
  return { drawings: roofs, areaSqft: area, squares: area / 100, pitch: main ? main[0] : null, mixed: byPitch.size > 1 };
}

/** How many layers of old shingles come off, from the tear-off in what's included ("Tear-off and disposal (2 layers)"). Null without one. */
export function tearOffLayers(included: readonly string[]): number | null {
  const line = included.find((name) => /tear[\s-]?off/i.test(name));
  if (!line) return null;
  const layers = /\((\d+) layers?\)/i.exec(line);
  return layers ? Number(layers[1]) : 1;
}

/** The facts beside the roof's picture: its size in squares, its area, its pitch and the layers coming off. */
export function roofTiles(roof: MeasuredRoof, included: readonly string[] = []): Array<{ label: string; value: string }> {
  // Small roofs keep a decimal; an aerial measurement isn't closer than 10 sq ft on a whole house.
  const squares = roof.squares < 10 ? formatNumber(roof.squares, 1) : formatNumber(Math.round(roof.squares));
  const area = roof.areaSqft >= 1000 ? Math.round(roof.areaSqft / 10) * 10 : Math.round(roof.areaSqft);
  const layers = tearOffLayers(included);
  return [
    { label: "Roof size", value: `${squares} squares` },
    { label: "Roof area", value: `${formatNumber(area)} sq ft` },
    ...(roof.pitch ? [{ label: roof.mixed ? "Main pitch" : "Pitch", value: roof.pitch }] : []),
    ...(layers ? [{ label: "Tear-off", value: `${layers} ${layers === 1 ? "layer" : "layers"}` }] : []),
  ];
}

/** Under the roof's facts: when it was measured (when the server says), and that it's checked on site. */
export function measuredLine(roof: MeasuredRoof, timeZone: string, today: string): string {
  const latest = roof.drawings.map((d) => d.measured_at).filter((at): at is string => Boolean(at)).sort().pop();
  const on = latest ? dateIn(latest, timeZone) : null;
  return `Measured from aerial photos${on ? ` on ${dayText(on, on.slice(0, 4) !== today.slice(0, 4))}` : ""}. We check every measurement on site.`;
}

export interface TrustBadge {
  kind: "license" | "insured";
  title: string;
  detail: string;
}

/** "Licensed" and "Fully insured" from the template, each only when it's filled in and shown. */
export function trustBadges(template: TemplateSettings): TrustBadge[] {
  const badges: TrustBadge[] = [];
  const license = template.license.trim();
  // "License #RC-104882" reads "Licensed · #RC-104882", not "Licensed · License #RC-104882".
  if (template.show_license && license) badges.push({ kind: "license", title: "Licensed", detail: license.replace(/^lic(?:ense)?(?:\.|\b(?=[\s#:]))\s*(?:(?:no|number)\b\.?)?\s*:?\s*/i, "") || license });
  const insurer = template.insurer.trim();
  if (template.show_insurer && insurer) badges.push({ kind: "insured", title: "Fully insured", detail: insurer });
  return badges;
}

/** The license and insurer for the foot of the page, worded as the document words them: "License #RC-104882 · Insured by Hartwell Mutual". */
export function credentialLine(template: TemplateSettings): string {
  return [
    template.show_license && template.license.trim() ? licenseLine(template.license) : null,
    template.show_insurer && template.insurer.trim() ? `Insured by ${template.insurer.trim()}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
