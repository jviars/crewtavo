/**
 * Estimate templates (document_templates): how a business's estimates, proposals and invoices look
 * on paper. The settings are free-form jsonb, so everything that reads them goes through
 * templateSettings(), which fills in the defaults and drops anything out of shape.
 */

export type HeaderStyle = "classic" | "centered" | "banner";
export type Lettering = "modern" | "classic";

export interface TemplateSettings {
  /** Logo and name on the left with the details on the right, all centered, or a band of color. */
  header: HeaderStyle;
  /** The document's color; null uses the business's brand color (Settings → Business). */
  color: string | null;
  /** Modern is the app's sans serif; classic is a serif. */
  font: Lettering;
  /** The line under the business's name, like "Roofing · Siding · Gutters". */
  tagline: string;
  license: string;
  insurer: string;
  show_license: boolean;
  show_insurer: boolean;
  /** Printed above the signatures. Line breaks are kept. */
  terms: string;
  customer_signs: boolean;
  customer_label: string;
  company_signs: boolean;
  /** Under the company's signature line; empty means "<business> representative". */
  company_label: string;
  sign_dates: boolean;
  footer: string;
  page_numbers: boolean;
}

export const TEMPLATE_LIMITS = { name: 80, tagline: 120, license: 60, insurer: 120, terms: 4000, label: 80, footer: 200 } as const;

export const DEFAULT_TERMS =
  "Payment: a deposit to get on the schedule, and the rest when the work is done.\n" +
  "Changes: anything not listed here is extra, and only with your OK.\n" +
  "Warranty: we stand behind our workmanship, plus the manufacturer's warranty on materials.";

export const DEFAULT_TEMPLATE: TemplateSettings = {
  header: "classic",
  color: null,
  font: "modern",
  tagline: "",
  license: "",
  insurer: "",
  show_license: true,
  show_insurer: true,
  terms: DEFAULT_TERMS,
  customer_signs: true,
  customer_label: "Customer",
  company_signs: true,
  company_label: "",
  sign_dates: true,
  footer: "",
  page_numbers: true,
};

export const HEADER_STYLES: Array<{ id: HeaderStyle; label: string }> = [
  { id: "classic", label: "Classic" },
  { id: "centered", label: "Centered" },
  { id: "banner", label: "Banner" },
];

/** The colors offered on the template, besides the business's own. */
export const TEMPLATE_COLORS: Array<{ name: string; hex: string }> = [
  { name: "Navy", hex: "#1f4e79" },
  { name: "Forest", hex: "#2f6b3a" },
  { name: "Brick", hex: "#a33a2b" },
  { name: "Copper", hex: "#9a5418" },
  { name: "Teal", hex: "#1d6b66" },
  { name: "Charcoal", hex: "#2b2f33" },
];

const HEX = /^#[0-9a-f]{6}$/i;

const text = (value: unknown, max: number, fallback: string) => (typeof value === "string" ? value.slice(0, max) : fallback);
const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** A template's settings with the defaults filled in. Anything of the wrong type or too long is dropped or cut. */
export function templateSettings(raw: unknown): TemplateSettings {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_TEMPLATE;
  return {
    header: s.header === "centered" || s.header === "banner" || s.header === "classic" ? s.header : d.header,
    color: typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : null,
    font: s.font === "classic" || s.font === "modern" ? s.font : d.font,
    tagline: text(s.tagline, TEMPLATE_LIMITS.tagline, d.tagline),
    license: text(s.license, TEMPLATE_LIMITS.license, d.license),
    insurer: text(s.insurer, TEMPLATE_LIMITS.insurer, d.insurer),
    show_license: flag(s.show_license, d.show_license),
    show_insurer: flag(s.show_insurer, d.show_insurer),
    terms: text(s.terms, TEMPLATE_LIMITS.terms, d.terms),
    customer_signs: flag(s.customer_signs, d.customer_signs),
    customer_label: text(s.customer_label, TEMPLATE_LIMITS.label, d.customer_label),
    company_signs: flag(s.company_signs, d.company_signs),
    company_label: text(s.company_label, TEMPLATE_LIMITS.label, d.company_label),
    sign_dates: flag(s.sign_dates, d.sign_dates),
    footer: text(s.footer, TEMPLATE_LIMITS.footer, d.footer),
    page_numbers: flag(s.page_numbers, d.page_numbers),
  };
}

/** The color a document prints in: the template's, else the business's brand color, else navy. */
export function documentColor(template: Pick<TemplateSettings, "color">, companySettings: unknown): string {
  if (template.color) return template.color;
  const branding = companySettings && typeof companySettings === "object" ? (companySettings as { branding?: { color?: unknown } }).branding : null;
  const brand = branding && typeof branding.color === "string" && HEX.test(branding.color) ? branding.color : null;
  return brand ?? "#1f4e79";
}

/** The words under the company's signature line. */
export const companySignatureLabel = (template: Pick<TemplateSettings, "company_label">, companyName: string) =>
  template.company_label.trim() || `${companyName} representative`;

/**
 * Which template a document uses: the one it names, else the business's default, else the built-in
 * defaults (a business that never opened the template builder still gets a clean document).
 */
export function pickTemplate<T extends { id: string; is_default: boolean; settings: unknown }>(templates: readonly T[], id?: string | null): TemplateSettings {
  const chosen = (id ? templates.find((t) => t.id === id) : undefined) ?? templates.find((t) => t.is_default) ?? templates[0];
  return templateSettings(chosen?.settings);
}
