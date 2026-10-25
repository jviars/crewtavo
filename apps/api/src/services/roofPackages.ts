/**
 * Packages and the roof estimate's money steps (routes/roofing.ts):
 *
 * - Setting a roofing business up: the standard services and the standard packages (Architectural
 *   shingle, Designer shingle, Standing-seam metal, as Good, Better and Best) from the roofing preset.
 * - A package on an estimate: its main service (for a roof, the roof priced by the square), then
 *   what's always included, each measured (or a starting count, like 3 pipe boots). Packages are
 *   every trade's now; a roof's package needs its roof. The same lines make an option when an
 *   estimate offers two or three (services/quoteOptions.ts).
 * - The price range the homeowner is sent first (from the lowest option to the highest), and the
 *   exact price the salesperson sets on site.
 * - The packages' ABC Supply materials priced again, so a package that follows ABC's prices is
 *   priced at today's materials.
 */
import { FormulaError, getPreset, isRoofDrawing, ROOFING_VARIABLE_NAMES, type Section } from "@crewtavo/core";
import { followPrice, inRangeMode, isSiteAdjustment, optionsRange, priceRange, rangeSettings, type RangeSettings, siteAdjustmentLines, sitePriceAdjustment, siteSubtotal, SITE_ADJUSTMENT_NAME, snapshotLines } from "@crewtavo/core/estimates";
import { materialsPerUnit, serviceUnitCost, type MaterialLink } from "@crewtavo/core/materials";
import { countsOn, optionBaseTotal, toCents } from "@crewtavo/core/money";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env";
import { abcConnection, AbcProblem } from "../integrations/abcSupply";
import { isEmail } from "../lib/email";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { formulaValue, MEASUREMENT_VALUE_FIELDS, measurementVariables, type MeasurementValues, type MeasurementVariables } from "./measurements";
import { addMissingServices } from "./presetServices";
import { deliver, rangeMessage, type SalesScope, type SendBody } from "./sales";

/** Quotes whose lines can still change. */
export const EDITABLE = ["draft", "sent", "changes_requested"];

/** Why a quote's lines or price can't change any more, in the office's words. */
export function lockedMessage(status: string): string {
  if (status === "approved" || status === "converted") return "This estimate was already signed, so it can't change.";
  if (status === "lost") return "This estimate was marked lost. Open it again first.";
  if (status === "archived") return "This estimate was archived. Open it again first.";
  return "This estimate can't change right now.";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------------------------

/**
 * The roofing preset's services a price list is missing, and, for a business with no roof packages
 * yet, the preset's packages made from its services (matched by name). Safe to run again.
 */
export async function setupRoofing(db: Db, companyId: string): Promise<{ services_added: string[]; packages_created: number }> {
  const servicesAdded = await addMissingServices(db, companyId, "roofing_exteriors");
  const existing = must(await db.from("roof_packages").select("id").eq("company_id", companyId).limit(1));
  if (existing.length) return { services_added: servicesAdded, packages_created: 0 };

  const preset = getPreset("roofing_exteriors").packages ?? [];
  if (!preset.length) return { services_added: servicesAdded, packages_created: 0 };
  const services = must(await db.from("services").select("id, name, active, sort").eq("company_id", companyId).order("sort"));
  // One service per name: the active one first, then the first in the price list.
  const byName = new Map<string, string>();
  for (const s of [...services].sort((a, b) => Number(b.active) - Number(a.active) || a.sort - b.sort)) {
    const key = s.name.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, s.id);
  }
  const idOf = (name: string) => byName.get(name.trim().toLowerCase()) ?? null;
  const defaultAt = Math.max(0, preset.findIndex((p) => p.default));

  let created = 0;
  for (const [i, p] of preset.entries()) {
    const pkg = must(
      await db
        .from("roof_packages")
        .insert({
          company_id: companyId,
          name: p.name,
          style: p.style,
          roof_service_id: idOf(p.roof),
          price_mode: "manual",
          is_default: i === defaultAt,
          sort: i,
          tier: p.tier ?? null,
          highlights: p.highlights ?? [],
          warranty: p.warranty ?? "",
        })
        .select("id")
        .single(),
    );
    created++;
    const roofId = idOf(p.roof);
    const included = p.included.map((item) => ({ id: idOf(item.service), quantity: item.quantity ?? null })).filter((item): item is { id: string; quantity: number | null } => Boolean(item.id) && item.id !== roofId);
    const quick = p.quick.map(idOf).filter((id): id is string => Boolean(id) && id !== roofId && !included.some((item) => item.id === id));
    const items = [
      ...unique(included, (item) => item.id).map((item, sort) => ({ company_id: companyId, package_id: pkg.id, service_id: item.id, kind: "included", quantity: item.quantity, sort })),
      ...unique(quick, (id) => id).map((id, sort) => ({ company_id: companyId, package_id: pkg.id, service_id: id, kind: "quick", quantity: null, sort })),
    ];
    if (items.length) {
      const { error } = await db.from("roof_package_items").insert(items);
      if (error) throw dbError(error);
    }
  }
  return { services_added: servicesAdded, packages_created: created };
}

function unique<T>(list: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => !seen.has(key(item)) && Boolean(seen.add(key(item))));
}

// ---------------------------------------------------------------------------------------------
// A package's lines on an estimate
// ---------------------------------------------------------------------------------------------

export interface PackageService {
  id: string;
  name: string;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  formula: string | null;
  formula_target: string;
  active: boolean;
}

/** One line a package puts on an estimate, before it has a quote. */
export interface PackageLine {
  service_id: string;
  name: string;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  taxable: boolean;
  formula: string | null;
  quantity: number;
  sort: number;
}

export interface PackageLines {
  lines: PackageLine[];
  /** Lines left off, and why: nothing to price on this job, or a formula that can't be worked out. */
  skipped: Array<{ name: string; reason: string }>;
  /** The main service's own formula couldn't be worked out (on a roof, usually: no pitch yet). */
  roofProblem: string | null;
}

/**
 * A package's lines for a job: its main service (a roof's is the roof itself), then what's always
 * included, in order. Measured services take their amount from the measurement and are left off when
 * there's nothing of it on this job (a steep charge on a 6/12 roof); counted ones start at the
 * package's count, else 1. Services turned off in the price list are left off (the main service is
 * always kept). Outside roofing a package may have no main service, and the words say "job".
 */
export function packageLines(
  main: PackageService | null,
  included: ReadonlyArray<{ service: PackageService; quantity: number | null }>,
  vars: MeasurementVariables | null,
  roofing = true,
): PackageLines {
  const lines: PackageLine[] = [];
  const skipped: PackageLines["skipped"] = [];
  let roofProblem: string | null = null;
  const seen = new Set<string>();
  const entries = [...(main ? [{ service: main, quantity: null, isMain: true }] : []), ...included.map((i) => ({ ...i, isMain: false }))];
  for (const { service, quantity, isMain } of entries) {
    if (seen.has(service.id)) continue;
    seen.add(service.id);
    if (!service.active && !isMain) continue;
    const base = { service_id: service.id, name: service.name, unit: service.unit, unit_price: Number(service.unit_price), unit_cost: service.unit_cost === null ? null : Number(service.unit_cost), taxable: service.taxable, formula: service.formula };
    if (!service.formula) {
      lines.push({ ...base, quantity: quantity && quantity > 0 ? quantity : 1, sort: lines.length });
      continue;
    }
    let value: number;
    try {
      if (!vars) throw new FormulaError(roofing ? "The roof hasn't been measured yet" : "It hasn't been measured yet");
      value = formulaValue(service.formula, vars);
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      if (isMain) roofProblem = error.message;
      skipped.push({ name: service.name, reason: error.message });
      continue;
    }
    if (!(value > 0)) {
      skipped.push({ name: service.name, reason: roofing ? "None on this roof" : "None on this job" });
      continue;
    }
    lines.push(service.formula_target === "unit_price" ? { ...base, unit_price: round2(value), quantity: 1, sort: lines.length } : { ...base, quantity: value, sort: lines.length });
  }
  return { lines, skipped, roofProblem };
}

const SERVICE_FIELDS = "id, name, unit, unit_price, unit_cost, labor_cost, taxable, formula, formula_target, active";

/** A package as it's priced and offered: its services, and its card (tier, picture, highlights, warranty). */
const PACKAGE_FIELDS = "id, name, tier, style, picture, picture_width, picture_height, highlights, warranty, section_ids, roof_service_id, price_mode, markup_pct";

export interface PackageRow {
  id: string;
  name: string;
  tier: string | null;
  style: string;
  picture: string | null;
  picture_width: number | null;
  picture_height: number | null;
  highlights: string[];
  warranty: string;
  section_ids: string[];
  roof_service_id: string | null;
  price_mode: string;
  markup_pct: number;
}

/** A package ready to price: its main service and what's always included, at today's prices. */
export interface PricedPackage {
  pkg: PackageRow;
  main: PackageService | null;
  included: Array<{ service: PackageService; quantity: number | null }>;
  /** Some of its services take their amount from a measurement. */
  measured: boolean;
  /** For a package that follows ABC Supply: its main service's price at today's materials, for the price list once its lines are saved. */
  followed: number | null;
}

/** The measurement a quote's lines are worked out from: its newest. */
export type QuoteMeasurement = MeasurementValues & { id: string; roofing_squares: number | string | null };

export async function quoteMeasurement(db: Db, companyId: string, quoteId: string): Promise<QuoteMeasurement | null> {
  const found = must(
    await db.from("measurements").select(`id, roofing_squares, ${MEASUREMENT_VALUE_FIELDS}`).eq("quote_id", quoteId).eq("company_id", companyId).order("updated_at", { ascending: false }).limit(1),
  ) as unknown as QuoteMeasurement[];
  return found[0] ?? null;
}

/**
 * Whether a quote is roof work, which is priced in Roofing: the business is a roofer, or what's
 * measured for it is a roof (squares, a pitch, or lines marked as roof edges). Roof work words its
 * steps for a roof, and its packages need their roof.
 */
export function isRoofWork(tradePreset: string | null | undefined, measurement: Pick<QuoteMeasurement, "sections" | "roof_pitch" | "roofing_squares"> | null | undefined): boolean {
  if (tradePreset === "roofing_exteriors") return true;
  if (!measurement) return false;
  return measurement.roofing_squares != null || isRoofDrawing((Array.isArray(measurement.sections) ? measurement.sections : []) as Section[], measurement.roof_pitch);
}

/** The business's trade (companies.trade_preset). */
export async function companyTrade(db: Db, companyId: string): Promise<string | null> {
  const company = must(await db.from("companies").select("trade_preset").eq("id", companyId).maybeSingle(), "Company not found.");
  return company.trade_preset ?? null;
}

/** What to do before a package's measured lines can be priced. */
export const measureFirst = (roofing: boolean) => (roofing ? "Measure the roof first." : "Measure the job first.");

/**
 * The business's packages with their services, in the order asked for, ready for packageLines. A
 * roof's package needs its roof (`roofing`); elsewhere the main service is optional. A package that
 * follows ABC Supply is priced at today's materials (`followed`), without saving anything yet.
 */
export async function loadPackages(db: Db, companyId: string, packageIds: readonly string[], roofing: boolean): Promise<PricedPackage[]> {
  const ids = [...new Set(packageIds)];
  if (!ids.length) return [];
  const rows = must(await db.from("roof_packages").select(PACKAGE_FIELDS).eq("company_id", companyId).in("id", ids)) as unknown as PackageRow[];
  const byPackage = new Map(rows.map((p) => [p.id, p]));
  const packages = ids.map((id) => byPackage.get(id));
  if (packages.some((p) => !p)) throw new HttpError(404, "That package wasn't found. It may have been deleted.");
  for (const p of packages as PackageRow[]) {
    if (roofing && !p.roof_service_id) throw new HttpError(409, `Pick the roof for the ${p.name} package first, in Roofing → Packages.`);
  }

  const items = must(await db.from("roof_package_items").select("package_id, service_id, quantity, sort").eq("company_id", companyId).in("package_id", ids).eq("kind", "included").order("sort"));
  const serviceIds = [...new Set([...rows.flatMap((p) => (p.roof_service_id ? [p.roof_service_id] : [])), ...items.map((i) => i.service_id)])];
  const services = serviceIds.length
    ? (must(await db.from("services").select(SERVICE_FIELDS).eq("company_id", companyId).in("id", serviceIds)) as unknown as Array<PackageService & { labor_cost: number | null }>)
    : [];
  const byId = new Map(services.map((s) => [s.id, s]));
  const following = rows.filter((p) => p.price_mode === "follow" && p.roof_service_id && byId.has(p.roof_service_id));
  const links = following.length
    ? (must(await db.from("service_materials").select("service_id, per_unit, unit_price").eq("company_id", companyId).in("service_id", following.map((p) => p.roof_service_id!))) as unknown as Array<MaterialLink & { service_id: string }>)
    : [];

  return (packages as PackageRow[]).map((pkg) => {
    const found = pkg.roof_service_id ? byId.get(pkg.roof_service_id) : undefined;
    if (pkg.roof_service_id && !found) {
      throw new HttpError(
        409,
        roofing ? `The ${pkg.name} package's roof isn't in your price list any more. Pick it again in Roofing → Packages.` : `The ${pkg.name} package's main service isn't in your price list any more. Pick it again in Packages.`,
      );
    }
    // A copy, so a package that follows ABC doesn't change the price another package reads.
    const main = found ? { ...found } : null;
    let followed: number | null = null;
    if (main && pkg.price_mode === "follow") {
      const own = links.filter((l) => l.service_id === main.id);
      const price = own.length ? followPrice(materialsPerUnit(own), main.labor_cost, pkg.markup_pct) : 0;
      if (price > 0) {
        if (price !== Number(main.unit_price)) followed = price;
        main.unit_price = price;
      }
    }
    const included = items.filter((i) => i.package_id === pkg.id).flatMap((i) => {
      const service = byId.get(i.service_id);
      return service ? [{ service, quantity: i.quantity === null ? null : Number(i.quantity) }] : [];
    });
    return { pkg, main, included, measured: [main, ...included.map((i) => i.service)].some((s) => s?.formula), followed };
  });
}

/** A package's lines from a measurement (or none, when nothing in it is measured), or a 409 saying why its main service can't be priced. */
export function pricedLines(p: PricedPackage, vars: MeasurementVariables | null, roofing: boolean): PackageLines {
  const built = packageLines(p.main, p.included, vars, roofing);
  if (built.roofProblem && p.main) {
    const noPitch = roofing && vars !== null && ROOFING_VARIABLE_NAMES.every((name) => vars[name] === null);
    if (noPitch) throw new HttpError(409, "The roof's pitch doesn't read. Set it again on the map, so its squares can be worked out.");
    throw new HttpError(409, roofing ? `The ${p.main.name} formula can't be worked out for this roof: ${built.roofProblem}.` : `The ${p.main.name} formula can't be worked out from this measurement: ${built.roofProblem}.`);
  }
  return built;
}

/** The price list follows the packages that follow ABC Supply, once their lines are on an estimate. */
export async function saveFollowedPrices(db: Db, companyId: string, packages: readonly PricedPackage[]) {
  for (const p of packages) {
    if (p.followed === null || !p.main) continue;
    const { error } = await db.from("services").update({ unit_price: p.followed }).eq("id", p.main.id).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
}

/** The measurement the lines came from shows on the quote. */
export async function showMeasurement(db: Db, companyId: string, quoteId: string, measurementId: string) {
  const { error } = await db.from("measurements").update({ show_on_quote: true, quote_id: quoteId }).eq("id", measurementId).eq("company_id", companyId);
  if (error) throw dbError(error);
}

/** An estimate that offers options changes them from the options bar (POST /quotes/:id/options). */
export const OFFERS_OPTIONS = "This estimate offers options; change them from the options bar.";

/**
 * Put a package on an estimate that doesn't offer options. The quote remembers the package either
 * way; an estimate that already has lines keeps them unless `replace` says to start over from the
 * package.
 */
export async function applyPackage(db: Db, companyId: string, quoteId: string, packageId: string, replace: boolean) {
  const quote = must(
    await db
      .from("quotes")
      .select("id, status, lines:quote_line_items(id), options:quote_options!quote_options_quote_fkey(id)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "That estimate wasn't found.",
  );
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  if (quote.options.length) throw new HttpError(409, OFFERS_OPTIONS);
  const pkg = must(await db.from("roof_packages").select("id").eq("id", packageId).eq("company_id", companyId).maybeSingle(), "That package wasn't found. It may have been deleted.");

  // The quote remembers the package, and its contract sections come with it.
  const remember = () => putQuotePackage(db, quoteId, pkg.id, [], false);
  if (quote.lines.length && !replace) {
    await remember();
    return { applied: false as const };
  }

  const [trade, measurement] = await Promise.all([companyTrade(db, companyId), quoteMeasurement(db, companyId, quoteId)]);
  const roofing = isRoofWork(trade, measurement);
  const [priced] = await loadPackages(db, companyId, [pkg.id], roofing);
  if (priced!.measured && !measurement) {
    // Its lines come once the roof is measured (fillOptions).
    await remember();
    throw new HttpError(409, measureFirst(roofing));
  }
  const built = pricedLines(priced!, priced!.measured && measurement ? measurementVariables(measurement) : null, roofing);

  // Starting over starts the price over too: a price set on site (its discount included) or the
  // exact price sent instead of the range was for the old lines. A promo code keeps its discount.
  // Lines added meanwhile on another screen stay, and the package's don't go on.
  if (!(await putQuotePackage(db, quoteId, pkg.id, built.lines, replace))) return { applied: false as const };
  await saveFollowedPrices(db, companyId, [priced!]);
  if (priced!.measured && measurement) await showMeasurement(db, companyId, quoteId, measurement.id);
  return { applied: true as const, lines: built.lines.length, skipped: built.skipped };
}

/**
 * One package prices an estimate that offers no options, in one locked step (put_quote_package):
 * the quote remembers it, and `lines` go on it, shared, unless it has lines already. Its contract
 * sections come with it: the database swaps the old package's sections for this one's on the
 * locked quote, keeping the ones added for the job. `replace` starts over first: every option and
 * line goes, with the price set on site, the exact price sent and the discount (a promo code keeps
 * its own). Returns whether the lines went on.
 */
export async function putQuotePackage(db: Db, quoteId: string, packageId: string, lines: readonly PackageLine[], replace: boolean): Promise<boolean> {
  const { data, error } = await db.rpc("put_quote_package", {
    p_quote: quoteId,
    p_package: packageId,
    p_lines: asJson(lines.map((l) => ({ service_id: l.service_id, name: l.name, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, unit_cost: l.unit_cost, taxable: l.taxable, formula: l.formula, sort: l.sort }))),
    p_replace: replace,
  });
  if (error) throw dbError(error);
  return data === true;
}

// ---------------------------------------------------------------------------------------------
// The price range
// ---------------------------------------------------------------------------------------------

/** A quote as its price range is worked out from it (sendRange, markRangeAccepted). */
const RANGE_QUOTE =
  "id, number, status, total, tax_rate, discount_amount, client_id, range_low, range_high, range_accepted_at, priced_on_site_at, exact_sent_at, client:clients(display_name, email, phone), promo:promo_codes(kind, value), lines:quote_line_items(id, option_id, service_id, name, quantity, unit, unit_price, unit_cost, taxable, formula, optional, selected, sort), options:quote_options!quote_options_quote_fkey(id, name)";

async function rangeQuote(db: Db, companyId: string, quoteId: string) {
  return must(await db.from("quotes").select(RANGE_QUOTE).eq("id", quoteId).eq("company_id", companyId).maybeSingle(), "That estimate wasn't found.");
}
type RangeQuote = Awaited<ReturnType<typeof rangeQuote>>;

/**
 * The range an estimate goes out at now: the estimate rounded down to the estimate plus the room on
 * top, rounded up (companies.settings.roofing). An estimate that offers options runs from the
 * cheapest option's low end to the priciest one's high end, each option priced before add-ons
 * (optionBaseTotal), so which one is shown doesn't move it. Checks it can go out; writes nothing.
 */
function rangeOf(quote: RangeQuote, settings: RangeSettings) {
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  if (!quote.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  const opts = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  const bases = quote.options.map((o) => optionBaseTotal(quote.lines, o.id, opts)).filter((t): t is number => t !== null);
  if (quote.options.length && !bases.length) throw new HttpError(400, "Price the options before sending the range: none of them has any lines yet.");
  return { range: quote.options.length ? optionsRange(bases, settings) : priceRange(quote.total, settings), options: bases.length };
}

/**
 * The range saved on the quote with the lines it was made from, so the office can see what changed
 * on site. A new range: nothing is priced on site or sent at the exact price yet, and the client
 * hasn't answered.
 */
async function saveRange(db: Db, companyId: string, quote: RangeQuote, range: { low: number; high: number }) {
  const lines = [...quote.lines].sort((a, b) => a.sort - b.sort);
  const { error } = await db
    .from("quotes")
    .update({ range_low: range.low, range_high: range.high, range_sent_at: new Date().toISOString(), range_lines: asJson(snapshotLines(lines)), range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null })
    .eq("id", quote.id)
    .eq("company_id", companyId);
  if (error) throw dbError(error);
}

/** The range is with the client now, so a draft (or a quote they'd asked about) counts as sent. */
async function markSent(db: Db, companyId: string, quoteId: string) {
  await db.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", quoteId).eq("company_id", companyId).in("status", ["draft", "changes_requested"]);
}

/** Send the homeowner a price range instead of the exact price (rangeOf), by email or text, or just make their link. */
export async function sendRange(s: SalesScope, quoteId: string, body: SendBody) {
  const [quote, company] = await Promise.all([
    rangeQuote(s.db, s.companyId, quoteId),
    s.db.from("companies").select("name, currency, settings").eq("id", s.companyId).maybeSingle().then((r) => must(r)),
  ]);
  const { range, options } = rangeOf(quote, rangeSettings(company.settings));
  // Check where it's going before the quote changes, so a missing email doesn't leave it half sent.
  if (body.channel === "email" && !isEmail(body.to || quote.client?.email)) throw new HttpError(400, "Add a valid email address for this client first.");
  if (body.channel === "sms" && !(body.to || quote.client?.phone)) throw new HttpError(400, "This client has no phone number.");

  await saveRange(s.db, s.companyId, quote, range);
  const result = await deliver(s, "quote", quote, body, rangeMessage(company, range.low, range.high, options));
  // Sent, or the office took the link to share themselves: the range is now with the client.
  if (result.sent || body.channel === "link") await markSent(s.db, s.companyId, quoteId);
  return { ...result, range };
}

export const RANGE_NOT_WAITING = "This price range isn't waiting for an answer.";

/**
 * The homeowner said yes to the range some other way (on the phone, by text, in person), and the
 * office marks it. It's the same step as their Yes on the link (accept_hub_range: once, only while
 * the range is out and waiting), so the follow-up is called off and the team is told to book the
 * visit, with the option they're leaning toward when they said (it becomes the one shown). A range
 * that hasn't gone out (the office told them on the phone, or its email didn't go) is saved first,
 * as sending saves it but without sending them anything, and the estimate counts as sent. A note on
 * the estimate says who marked it, and how they said yes when the office says.
 */
export async function markRangeAccepted(env: Env, db: Db, companyId: string, userId: string, quoteId: string, body: { note?: string; option_id?: string } = {}) {
  const [quote, company, profile] = await Promise.all([
    rangeQuote(db, companyId, quoteId),
    db.from("companies").select("currency, settings").eq("id", companyId).maybeSingle(),
    db.from("profiles").select("full_name").eq("user_id", userId).maybeSingle(),
  ]);
  const option = body.option_id ? quote.options.find((o) => o.id === body.option_id) : null;
  if (body.option_id && !option) throw new HttpError(409, "The options on this estimate changed. Look them over and try again.");

  let range = { low: Number(quote.range_low), high: Number(quote.range_high) };
  if (quote.status === "draft" && !quote.priced_on_site_at && !quote.exact_sent_at) {
    range = rangeOf(quote, rangeSettings(company.data?.settings)).range;
    await saveRange(db, companyId, quote, range);
    await markSent(db, companyId, quoteId);
  } else if (!inRangeMode(quote) || quote.range_accepted_at) {
    throw new HttpError(409, RANGE_NOT_WAITING);
  }

  // The service role: the step is the database's own, and only the server may take it.
  const { data: acceptedAt, error } = await adminClient(env).rpc("accept_hub_range", { p_company: companyId, p_quote: quoteId, ...(option ? { p_option: option.id } : {}) });
  if (error) throw dbError(error);
  if (!acceptedAt) throw new HttpError(409, RANGE_NOT_WAITING);

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.data?.currency || "USD", maximumFractionDigits: 0 });
  const client = quote.client?.display_name?.trim() || "The homeowner";
  const by = profile.data?.full_name?.trim() || "the office";
  const how = body.note?.trim();
  const leaning = option ? `, leaning toward ${option.name}` : "";
  const text = `${client} said yes to the range (${money.format(range.low)} to ${money.format(range.high)})${leaning}, marked by ${by}.${how ? `\n${how}` : ""}`;
  // The yes is saved either way: a note that didn't save isn't worth an error the office would retry into a 409.
  const { error: noteError } = await db
    .from("messages")
    .insert({ company_id: companyId, client_id: quote.client_id, channel: "note", direction: "internal", body: text, related_type: "quote", related_id: quoteId, sent_by: userId });
  if (noteError) console.error("Couldn't add the note for a range marked as agreed", noteError.message);
  return { accepted_at: acceptedAt, range, option_id: option?.id ?? null };
}

// ---------------------------------------------------------------------------------------------
// The exact price, set on site
// ---------------------------------------------------------------------------------------------

/**
 * The price the salesperson and homeowner agree on, before tax. Below the estimate it's a discount;
 * above it, a "Price adjustment" line. Null goes back to the estimate as it is. Either way the quote
 * now has its exact price, so the homeowner sees it instead of the range. On an estimate that offers
 * options the price is for the option shown, which needs lines of its own: the whole difference, up
 * or down, is "Price adjustment" lines on that option, so no other option's price moves; below the
 * estimate it comes off its taxed and untaxed work as a discount would (core siteAdjustmentLines), so
 * the tax does too. The office's own discount (a flat amount off whichever option is chosen) stays
 * and still comes off, so the lines are worked out after it and the option comes to exactly the price
 * agreed. Changing the option later clears the price (private.quote_option_switch); another option
 * shown while the price is saved is a 409, and the price isn't kept.
 */
export async function setSitePrice(db: Db, companyId: string, quoteId: string, body: { price: number | null; note?: string }) {
  const quote = must(
    await db
      .from("quotes")
      .select("id, status, client_id, promo_code_id, option_id, discount_amount, lines:quote_line_items(id, option_id, name, service_id, formula, quantity, unit_price, taxable, optional, selected, sort)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "That estimate wasn't found.",
  );
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  // A promo code sets the discount itself, so a price set by hand wouldn't come out right.
  if (body.price !== null && quote.promo_code_id) throw new HttpError(409, "Take the promo code off first.");

  const shown = quote.option_id;
  const onOption = shown !== null;
  // An option offered before the roof was measured comes to the shared lines alone: a price set on
  // it would be one big adjustment.
  if (onOption && body.price !== null && !quote.lines.some((l) => l.option_id === shown && !l.optional && !isSiteAdjustment(l))) {
    throw new HttpError(409, "This option has no lines of its own yet, so there's nothing to set its price against.");
  }
  // The earlier price's lines: on every option, or on the option shown.
  const old = quote.lines.filter((l) => isSiteAdjustment(l) && (l.option_id === null || l.option_id === shown));
  const subtotal = siteSubtotal(quote.lines, shown);
  // With options the office's discount still comes off after the adjustment line, so the line is the
  // price and that discount less the lines: the option comes to the price agreed, to the cent.
  const net = onOption ? (toCents(subtotal) - toCents(quote.discount_amount)) / 100 : subtotal;
  const { discount, extra } = body.price === null ? { discount: 0, extra: 0 } : sitePriceAdjustment(net, body.price, { onOption });
  const note = body.note?.trim() || null;

  if (old.length) {
    const { error } = await db.from("quote_line_items").delete().in("id", old.map((l) => l.id)).eq("quote_id", quoteId);
    if (error) throw dbError(error);
  }
  // Above the estimate, one taxed line; below it on an option, taxed and untaxed as a discount comes off.
  const work = quote.lines.filter((l) => countsOn(l, shown) && !isSiteAdjustment(l));
  const parts = onOption ? siteAdjustmentLines(extra, work) : extra > 0 ? [{ unit_price: extra, taxable: true }] : [];
  const adjustments = parts.map(() => crypto.randomUUID());
  if (parts.length) {
    const sort = quote.lines.reduce((max, l) => Math.max(max, l.sort), 0) + 1;
    const { error } = await db.from("quote_line_items").insert(
      parts.map((part, i) => ({
        id: adjustments[i]!,
        company_id: companyId,
        quote_id: quoteId,
        option_id: shown,
        service_id: null,
        name: SITE_ADJUSTMENT_NAME,
        description: note,
        quantity: 1,
        unit: "ea",
        unit_price: part.unit_price,
        unit_cost: null,
        taxable: part.taxable,
        formula: null,
        sort: sort + i,
      })),
    );
    if (error) throw dbError(error);
  }
  // Only while the same option is shown: one shown since ("They chose this one" on another screen) wasn't priced.
  const priced = db
    .from("quotes")
    .update({ priced_on_site_at: new Date().toISOString(), ...(quote.promo_code_id || onOption ? {} : { discount_amount: discount }) })
    .eq("id", quoteId)
    .eq("company_id", companyId);
  const { data: saved, error } = await (shown === null ? priced.is("option_id", null) : priced.eq("option_id", shown)).select("id");
  if (error) throw dbError(error);
  if (!saved?.length) {
    if (adjustments.length) await db.from("quote_line_items").delete().in("id", adjustments).eq("quote_id", quoteId);
    throw new HttpError(409, "The option changed. Check it again.");
  }
  if (note) {
    const { error: noteError } = await db.from("messages").insert({ company_id: companyId, client_id: quote.client_id, channel: "note", direction: "internal", body: note, related_type: "quote", related_id: quoteId });
    if (noteError) throw dbError(noteError);
  }
  const totals = must(await db.from("quotes").select("subtotal, discount_amount, tax_amount, total").eq("id", quoteId).eq("company_id", companyId).maybeSingle());
  return { subtotal: Number(totals.subtotal), discount_amount: Number(totals.discount_amount), tax_amount: Number(totals.tax_amount), total: Number(totals.total) };
}

/** Whether a price set on site is in effect, so no promo code goes on top (core sitePriceSet, which the office's quote page uses too). */
export { SITE_PRICE_SET, sitePriceSet } from "@crewtavo/core/estimates";

// ---------------------------------------------------------------------------------------------
// The packages' materials at today's ABC Supply prices
// ---------------------------------------------------------------------------------------------

type PricedLink = MaterialLink & { id: string; service_id: string };

/**
 * Price the materials of every service in the business's packages at its ABC Supply branch today.
 * The price list's costs follow, and so does the roof price of each package that follows ABC.
 */
export async function pricePackages(env: Env, db: Db, companyId: string) {
  const [packages, items] = await Promise.all([
    db.from("roof_packages").select("id, roof_service_id, price_mode, markup_pct").eq("company_id", companyId),
    db.from("roof_package_items").select("service_id").eq("company_id", companyId),
  ]);
  const ids = [...new Set([...must(packages).map((p) => p.roof_service_id), ...must(items).map((i) => i.service_id)].filter((id): id is string => Boolean(id)))];
  const links = ids.length
    ? (must(await db.from("service_materials").select("id, service_id, item_number, name, uom, length_ft, per_unit, unit_price").eq("company_id", companyId).in("service_id", ids)) as unknown as PricedLink[])
    : [];
  if (!links.length) return { priced_at: null, branch_name: null, services: 0 };

  let prices;
  let branchName: string;
  try {
    const { client, settings } = await abcConnection(env, adminClient(env), companyId);
    branchName = settings.branch_name;
    prices = await client.prices(
      settings.ship_to,
      settings.branch,
      links.map((l) => ({ id: l.id, item_number: l.item_number, quantity: 1, uom: l.uom, length_ft: l.length_ft === null || l.length_ft === undefined ? null : Number(l.length_ft) })),
      "estimating",
    );
  } catch (error) {
    if (error instanceof AbcProblem) throw new HttpError((error.status === 401 ? 502 : error.status) as ContentfulStatusCode, error.message);
    throw error;
  }

  const pricedAt = new Date().toISOString();
  for (const link of links) {
    const price = prices.get(link.id);
    if (!price) continue;
    // A material ABC won't price today keeps its last price, with ABC's reason beside it.
    const { error } = await db.from("service_materials").update({ unit_price: price.unit_price ?? (link.unit_price === null || link.unit_price === undefined ? null : Number(link.unit_price)), price_note: price.note, priced_at: pricedAt }).eq("id", link.id).eq("company_id", companyId);
    if (error) throw dbError(error);
    if (price.unit_price !== null) link.unit_price = price.unit_price;
  }

  const serviceIds = [...new Set(links.map((l) => l.service_id))];
  const services = must(await db.from("services").select("id, labor_cost").eq("company_id", companyId).in("id", serviceIds));
  const labor = new Map(services.map((s) => [s.id, s.labor_cost === null ? null : Number(s.labor_cost)]));
  const linksOf = (serviceId: string) => links.filter((l) => l.service_id === serviceId);
  for (const serviceId of serviceIds) {
    const { error } = await db.from("services").update({ unit_cost: serviceUnitCost(linksOf(serviceId), labor.get(serviceId) ?? null) }).eq("id", serviceId).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  for (const pkg of must(packages)) {
    if (pkg.price_mode !== "follow" || !pkg.roof_service_id || !linksOf(pkg.roof_service_id).length) continue;
    const price = followPrice(materialsPerUnit(linksOf(pkg.roof_service_id)), labor.get(pkg.roof_service_id) ?? null, pkg.markup_pct);
    if (!(price > 0)) continue;
    const { error } = await db.from("services").update({ unit_price: price }).eq("id", pkg.roof_service_id).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  return { priced_at: pricedAt, branch_name: branchName, services: serviceIds.length };
}
