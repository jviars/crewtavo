/**
 * The records a roof estimate is made of, as the office page and the salesperson's iPad read them:
 * the quote with its lines and the options it offers (quotes/options.ts), the range it went out at
 * and how it was signed, and the price list's services that can go on it. The select strings below
 * fetch exactly these fields.
 */
import type { SnapshotLine } from "@crewtavo/core/estimates";
import type { LineMaterials } from "@crewtavo/core/materials";
import type { TotalsPromo } from "@crewtavo/core/money";
import { QUOTE_OPTIONS_EMBED, type QuoteOptionRow } from "../../quotes/options";

/** A line on the estimate (quote_line_items). */
export interface EstimateLine {
  id: string;
  /** The option it's on; null for a line on every option (every line of an estimate without options). */
  option_id: string | null;
  service_id: string | null;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  optional: boolean;
  selected: boolean;
  option_group: string | null;
  formula: string | null;
  sort: number;
  /** What its ABC Supply materials came to when it was last priced (RoofMaterials). */
  materials: LineMaterials | null;
  material_cost: number | null;
}

/**
 * How the estimate was signed (quotes.approval). Signing on site or online fills in all of it; an
 * office "Mark approved" from before only has the name and method, so the rest is optional here.
 */
export interface EstimateApproval {
  /** The customer's printed name. */
  name: string;
  /** A PNG data URL. */
  signature?: string | null;
  signed_at?: string;
  method?: "manual" | "in_person";
  selected_line_ids?: string[];
  /** The business's signature, by the salesperson who signed for it. */
  company?: { name: string; user_id: string | null; signature: string; signed_at: string } | null;
  subtotal?: number;
  discount_amount?: number;
  tax_amount?: number;
  total?: number;
}

export interface EstimateQuote {
  id: string;
  number: number | null;
  title: string;
  status: string;
  subtotal: number;
  discount_amount: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  promo_code_id: string | null;
  /** The promo code, and its discount, which an option's total is worked out with (core optionTotals). */
  promo: (TotalsPromo & { code: string }) | null;
  /** The package of the option shown (or of the estimate, without options). */
  roof_package_id: string | null;
  /** The option shown first, and once signed the one chosen; null without options. */
  option_id: string | null;
  /** The contract sections added to this job (the Contract card). */
  section_ids: string[];
  template_id: string | null;
  salesperson_id: string | null;
  /** The price range the homeowner was sent, and the lines it was made from. */
  range_low: number | null;
  range_high: number | null;
  range_sent_at: string | null;
  range_accepted_at: string | null;
  range_lines: SnapshotLine[] | null;
  /** When the salesperson set the exact price on site. */
  priced_on_site_at: string | null;
  /** When the office sent the exact price instead of the range (nobody went out). */
  exact_sent_at: string | null;
  approved_at: string | null;
  approval: EstimateApproval | null;
  /** Who and where, for headings ("Notes for Mike", "Dana Whitfield · 1482 Ridgeview Dr"). */
  client: { id: string; display_name: string; email: string | null; phone: string | null } | null;
  property: { id: string; line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
  /** In order (sort): every option's lines, each with its option_id. */
  lines: EstimateLine[];
  /** The options it offers, in order; none for a single estimate. */
  options: QuoteOptionRow[];
}

/** A price list service that can go on the estimate. */
export interface EstimateService {
  id: string;
  name: string;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  /** "Labor and the rest" per unit, for services priced from ABC Supply materials. */
  labor_cost?: number | null;
  taxable: boolean;
  formula: string | null;
  /** What the formula fills in: the line's "quantity" (most) or its "unit_price". */
  formula_target: string;
  category: string | null;
}

/** A package's one-tap add, with how many to start with (6 sheets of decking), if it says. */
export interface QuickAddService extends EstimateService {
  quantity: number | null;
}

export const ESTIMATE_LINE_FIELDS = "id, option_id, service_id, name, description, quantity, unit, unit_price, unit_cost, taxable, optional, selected, option_group, formula, sort, materials, material_cost";

export const ESTIMATE_QUOTE_FIELDS = `id, number, title, status, subtotal, discount_amount, tax_rate, tax_amount, total, promo_code_id, promo:promo_codes(code, kind, value), roof_package_id, option_id, section_ids, template_id, salesperson_id, range_low, range_high, range_sent_at, range_accepted_at, range_lines, priced_on_site_at, exact_sent_at, approved_at, approval, client:clients(id, display_name, email, phone), property:properties(id, line1, city, region, postal_code), lines:quote_line_items(${ESTIMATE_LINE_FIELDS}), ${QUOTE_OPTIONS_EMBED}`;

export const ESTIMATE_SERVICE_FIELDS = "id, name, unit, unit_price, unit_cost, labor_cost, taxable, formula, formula_target, category";

/** Quotes whose lines can still change: once signed, the lines are locked (quote_lines_guard). */
export const EDITABLE_STATUSES = ["draft", "sent", "changes_requested"];
export const isEditableQuote = (quote: Pick<EstimateQuote, "status">) => EDITABLE_STATUSES.includes(quote.status);
