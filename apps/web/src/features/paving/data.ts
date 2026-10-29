/**
 * The paving flow's records: a paving project is a quote with a takeoff (a measurement whose shapes
 * are paving items). Where a project stands comes from them and the job and invoices that follow:
 * takeoff, estimate, proposal, schedule, invoice, like a paving app's job record. Roofing projects
 * (features/roofing) are the same records with a roof for the takeoff, so they share these.
 */
import { marginPct } from "@crewtavo/core/estimates";
import { evaluateFormula, formulaVariables, type FormulaVariable } from "@crewtavo/core/formulas";
import { drawingPitchFactor, edgeLengths, type Section } from "@crewtavo/core/geo";
import { countsOn, lineTotal, optionTotals, toCents, type Amount, type OptionLine, type TotalsPromo } from "@crewtavo/core/money";
import { isPavingTakeoff, pavingQuantities } from "@crewtavo/core/paving";
import { savedRoofingQuantities } from "@crewtavo/core/roofing";
import type { IconName } from "@/components/ui/Icon";
import { statusText } from "@/components/ui/StatusPill";

/** One step of a trade's project, as its progress pills and the trade's list page show it. */
export interface FlowStep<Id extends string = string> {
  id: Id;
  label: string;
  icon: IconName;
  text: string;
}

export const STEPS: Array<FlowStep<StepId>> = [
  { id: "takeoff", label: "Takeoff", icon: "area", text: "Measure the lot on the aerial" },
  { id: "estimate", label: "Estimate", icon: "dollar", text: "Price it from your price book" },
  { id: "proposal", label: "Proposal", icon: "send", text: "Send it to sign online" },
  { id: "schedule", label: "Schedule", icon: "calendar", text: "Turn it into a job for a crew" },
  { id: "invoice", label: "Invoice", icon: "invoice", text: "Bill the deposit and the rest" },
];
export type StepId = "takeoff" | "estimate" | "proposal" | "schedule" | "invoice";

/** Whether every invoice is settled: paid, voided or written off. */
export const invoicesSettled = (invoices: ReadonlyArray<{ status: string }>) => invoices.length > 0 && invoices.every((i) => ["paid", "void", "written_off"].includes(i.status));

export interface TakeoffRow {
  id: string;
  title: string;
  sections: unknown;
  total_area_sqft: number;
  total_area_sqyd: number;
  total_length_ft: number;
  roof_pitch: string | null;
  waste_pct: number;
  roofing_squares: number | null;
  snapshot_path: string | null;
  show_on_quote: boolean;
  updated_at: string;
}
export const TAKEOFF_FIELDS = "id, title, sections, total_area_sqft, total_area_sqyd, total_length_ft, roof_pitch, waste_pct, roofing_squares, snapshot_path, show_on_quote, updated_at";

export const sectionsOf = (m: Pick<TakeoffRow, "sections"> | null | undefined): Section[] => (Array.isArray(m?.sections) ? (m!.sections as Section[]) : []);
export const isPaving = (m: Pick<TakeoffRow, "sections"> | null | undefined) => isPavingTakeoff(sectionsOf(m));

/** Every value a quote formula can use, for a saved takeoff: the same ones the server fills in. */
export function takeoffVariables(m: TakeoffRow, depthIn: number | null): Record<FormulaVariable, number | null> {
  const sections = sectionsOf(m);
  const edges = edgeLengths({ sections });
  let pitch: number | null = null;
  try {
    pitch = drawingPitchFactor({ sections }, m.roof_pitch);
  } catch {
    pitch = null;
  }
  return {
    area_sqft: Number(m.total_area_sqft),
    area_sqyd: Number(m.total_area_sqyd),
    length_ft: Number(m.total_length_ft),
    count: sections.filter((s) => s.kind === "Count").length,
    depth_in: depthIn ?? sections.find((s) => s.depth_in)?.depth_in ?? null,
    pitch_factor: pitch,
    waste: Number(m.waste_pct) / 100,
    waste_pct: Number(m.waste_pct),
    eave_ft: edges.eave,
    rake_ft: edges.rake,
    ridge_ft: edges.ridge,
    hip_ft: edges.hip,
    valley_ft: edges.valley,
    ...pavingQuantities(sections),
    ...savedRoofingQuantities(sections, m.roof_pitch, Number(m.waste_pct)),
  };
}

/** A formula's value for a takeoff, or null when it can't be worked out (a value it needs is missing). */
export function formulaValue(formula: string, vars: Record<string, number | null>): number | null {
  try {
    return Math.round(evaluateFormula(formula, vars) * 1000) / 1000;
  } catch {
    return null;
  }
}

/**
 * What a service prices, by the values its formula reads (or, for a price list from before paving
 * items, its name): the asphalt itself, sealing it, or the rest.
 */
export function serviceKind(formula: string | null, name = ""): "pave" | "seal" | "other" {
  if (!formula) return "other";
  let names: Set<string>;
  try {
    names = formulaVariables(formula);
  } catch {
    return "other";
  }
  if (names.has("sealcoat_sqft") || (/seal ?coat/i.test(name) && (names.has("area_sqft") || names.has("asphalt_sqft")))) return "seal";
  if (names.has("asphalt_sqft") || names.has("asphalt_sqyd") || names.has("area_sqyd") || names.has("area_sqft")) return "pave";
  return "other";
}
export const usesDepth = (formula: string | null) => {
  try {
    return Boolean(formula && formulaVariables(formula).has("depth_in"));
  } catch {
    return false;
  }
};

export interface QuoteForFlow {
  status: string;
  lines: Array<unknown>;
  jobs: Array<{ id: string; status: string }>;
}

/** Where a project is: the first step not done yet ("done" once the last invoice is paid). */
export function currentStep(q: QuoteForFlow | null, takeoff: TakeoffRow | null, invoices: Array<{ status: string }> = []): StepId | "done" {
  if (!takeoff) return "takeoff";
  if (!q || !q.lines.length) return "estimate";
  if (["draft", "sent", "changes_requested"].includes(q.status)) return "proposal";
  if (q.status === "approved" || !q.jobs.length) return "schedule";
  if (!invoicesSettled(invoices)) return "invoice";
  return "done";
}

/** A short word for the project list. */
export function stageLabel(q: { status: string; lines?: unknown[]; jobs?: Array<{ status: string }> }, hasTakeoff: boolean): { label: string; tone: "muted" | "info" | "warning" | "good" | "danger" } {
  if (q.status === "lost") return { label: statusText("quote", q.status), tone: "danger" };
  if (q.status === "archived") return { label: statusText("quote", q.status), tone: "muted" };
  if (!hasTakeoff) return { label: "Takeoff", tone: "muted" };
  if (!q.lines?.length) return { label: "Estimate", tone: "muted" };
  if (q.status === "draft") return { label: "Ready to send", tone: "info" };
  if (q.status === "sent") return { label: "Proposal sent", tone: "info" };
  if (q.status === "changes_requested") return { label: statusText("quote", q.status), tone: "warning" };
  if (q.status === "approved") return { label: "Won", tone: "good" };
  const job = q.jobs?.[0];
  if (job?.status === "completed") return { label: "Done", tone: "good" };
  return { label: "Job", tone: "good" };
}

// ---------------------------------------------------------------------------------------------
// The estimate's money
// ---------------------------------------------------------------------------------------------

/**
 * The lines the option looked at (`optionId`) is made of: its own and the ones on every option, and
 * every line without options. What's ticked, taken off and listed on the estimate step.
 */
export const viewedLines = <L extends { option_id: string | null }>(lines: readonly L[], optionId: string | null): L[] =>
  lines.filter((l) => l.option_id === null || l.option_id === optionId);

/** A quote line as the estimate's money reads it. */
export interface SumsLine extends OptionLine {
  unit_cost: Amount;
  material_cost: Amount;
  /** Materials priced at the supplier: one the branch hasn't priced has no total. */
  materials: { items: ReadonlyArray<{ total: number | null; quantity: number }> } | null;
}

/** The quote as the estimate's money reads it; its saved totals are the option shown's. */
export interface SumsQuote {
  option_id: string | null;
  subtotal: Amount;
  total: Amount;
  tax_rate: Amount;
  discount_amount: Amount;
  promo: TotalsPromo | null;
  lines: readonly SumsLine[];
}

export interface EstimateSums {
  cost: number;
  /** Every line that counts has a cost, so the profit and margin are real. */
  costKnown: boolean;
  /** Before tax and any discount. */
  price: number;
  profit: number;
  margin: number | null;
  /** With tax, after any discount. */
  total: number;
  /** What the supplier priced the materials at, for the lines that count; null when none were. */
  materials: number | null;
  /** Something the branch hasn't priced: the materials cost at least this much. */
  materialsPartial: boolean;
}

/**
 * The estimate's cost, price, profit and margin for the option looked at (`optionId`; null for an
 * estimate without options): the lines that count on it (core countsOn: its own and the shared ones,
 * not add-ons left off), priced as the quote's saved totals for the option shown and, for another,
 * as the database will work them out once it's shown (core optionTotals).
 */
export function estimateSums(quote: SumsQuote, optionId: string | null): EstimateSums {
  const counted = quote.lines.filter((l) => countsOn(l, optionId));
  const cost = counted.reduce((t, l) => t + (l.unit_cost == null ? 0 : toCents(lineTotal(l.quantity, l.unit_cost))), 0);
  const costKnown = counted.every((l) => l.unit_cost != null);
  const totals =
    optionId !== null && optionId !== quote.option_id
      ? optionTotals(quote.lines, optionId, quote.option_id, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo })
      : { subtotal: Number(quote.subtotal), total: Number(quote.total) };
  const price = toCents(totals.subtotal);
  const priced = counted.filter((l) => l.material_cost != null);
  return {
    cost: cost / 100,
    costKnown,
    price: price / 100,
    profit: (price - cost) / 100,
    margin: costKnown ? marginPct(price / 100, cost / 100) : null,
    total: Number(totals.total),
    materials: priced.length ? priced.reduce((t, l) => t + toCents(l.material_cost), 0) / 100 : null,
    materialsPartial: priced.some((l) => l.materials?.items.some((i) => i.total === null && i.quantity > 0)),
  };
}
