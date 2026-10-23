/**
 * Roof packages and the roof estimate's money steps (routes/roofing.ts):
 *
 * - Setting a roofing business up: the standard services and the standard packages (Architectural
 *   shingle, Designer shingle, Standing-seam metal) from the roofing preset.
 * - A package on an estimate: the roof priced by the square, then what's always on that roof, each
 *   measured from the roof (or a starting count, like 3 pipe boots).
 * - The price range the homeowner is sent first, and the exact price the salesperson sets on site.
 * - The packages' ABC Supply materials priced again, so a package that follows ABC's prices is
 *   priced at today's materials.
 */
import { FormulaError, getPreset, ROOFING_VARIABLE_NAMES } from "@crewtavo/core";
import { followPrice, inRangeMode, isSiteAdjustment, priceRange, rangeSettings, sitePriceAdjustment, SITE_ADJUSTMENT_NAME, snapshotLines } from "@crewtavo/core/estimates";
import { materialsPerUnit, serviceUnitCost, type MaterialLink } from "@crewtavo/core/materials";
import { lineTotal, toCents } from "@crewtavo/core/money";
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
        .insert({ company_id: companyId, name: p.name, style: p.style, roof_service_id: idOf(p.roof), price_mode: "manual", is_default: i === defaultAt, sort: i })
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
  /** Lines left off, and why: nothing to price on this roof, or a formula that can't be worked out. */
  skipped: Array<{ name: string; reason: string }>;
  /** The roof's own formula couldn't be worked out (usually: no pitch yet). */
  roofProblem: string | null;
}

/**
 * A package's lines for a roof: the roof itself, then what's always on it, in order. Measured
 * services take their amount from the roof and are left off when there's nothing of it on this roof
 * (a steep charge on a 6/12 roof); counted ones start at the package's count, else 1. Services
 * turned off in the price list are left off (the roof itself is always kept).
 */
export function packageLines(
  roof: PackageService | null,
  included: ReadonlyArray<{ service: PackageService; quantity: number | null }>,
  vars: MeasurementVariables | null,
): PackageLines {
  const lines: PackageLine[] = [];
  const skipped: PackageLines["skipped"] = [];
  let roofProblem: string | null = null;
  const seen = new Set<string>();
  const entries = [...(roof ? [{ service: roof, quantity: null, isRoof: true }] : []), ...included.map((i) => ({ ...i, isRoof: false }))];
  for (const { service, quantity, isRoof } of entries) {
    if (seen.has(service.id)) continue;
    seen.add(service.id);
    if (!service.active && !isRoof) continue;
    const base = { service_id: service.id, name: service.name, unit: service.unit, unit_price: Number(service.unit_price), unit_cost: service.unit_cost === null ? null : Number(service.unit_cost), taxable: service.taxable, formula: service.formula };
    if (!service.formula) {
      lines.push({ ...base, quantity: quantity && quantity > 0 ? quantity : 1, sort: lines.length });
      continue;
    }
    let value: number;
    try {
      if (!vars) throw new FormulaError("The roof hasn't been measured yet");
      value = formulaValue(service.formula, vars);
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      if (isRoof) roofProblem = error.message;
      skipped.push({ name: service.name, reason: error.message });
      continue;
    }
    if (!(value > 0)) {
      skipped.push({ name: service.name, reason: "None on this roof" });
      continue;
    }
    lines.push(service.formula_target === "unit_price" ? { ...base, unit_price: round2(value), quantity: 1, sort: lines.length } : { ...base, quantity: value, sort: lines.length });
  }
  return { lines, skipped, roofProblem };
}

const SERVICE_FIELDS = "id, name, unit, unit_price, unit_cost, labor_cost, taxable, formula, formula_target, active";

/**
 * Put a package on a roof estimate. The quote remembers the package either way; an estimate that
 * already has lines keeps them unless `replace` says to start over from the package.
 */
export async function applyPackage(db: Db, companyId: string, quoteId: string, packageId: string, replace: boolean) {
  const quote = must(await db.from("quotes").select("id, status, promo_code_id, lines:quote_line_items(id)").eq("id", quoteId).eq("company_id", companyId).maybeSingle(), "That estimate wasn't found.");
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  const pkg = must(
    await db.from("roof_packages").select("id, name, roof_service_id, price_mode, markup_pct").eq("id", packageId).eq("company_id", companyId).maybeSingle(),
    "That package wasn't found. It may have been deleted.",
  );

  const { error: chooseError } = await db.from("quotes").update({ roof_package_id: pkg.id }).eq("id", quoteId).eq("company_id", companyId);
  if (chooseError) throw dbError(chooseError);
  if (quote.lines.length && !replace) return { applied: false as const };

  if (!pkg.roof_service_id) throw new HttpError(409, `Pick the roof for the ${pkg.name} package first, in Roofing → Packages.`);
  const items = must(await db.from("roof_package_items").select("service_id, quantity, sort").eq("package_id", pkg.id).eq("kind", "included").order("sort"));
  const ids = [...new Set([pkg.roof_service_id, ...items.map((i) => i.service_id)])];
  const services = must(await db.from("services").select(SERVICE_FIELDS).eq("company_id", companyId).in("id", ids)) as unknown as Array<PackageService & { labor_cost: number | null }>;
  const byId = new Map(services.map((s) => [s.id, s]));
  const roof = byId.get(pkg.roof_service_id);
  if (!roof) throw new HttpError(409, `The ${pkg.name} package's roof isn't in your price list any more. Pick it again in Roofing → Packages.`);

  // A package that follows ABC Supply prices the roof at today's materials, and the price list follows.
  if (pkg.price_mode === "follow") {
    const links = must(await db.from("service_materials").select("per_unit, unit_price").eq("company_id", companyId).eq("service_id", roof.id)) as MaterialLink[];
    if (links.length) {
      const price = followPrice(materialsPerUnit(links), roof.labor_cost, pkg.markup_pct);
      if (price > 0 && price !== Number(roof.unit_price)) {
        const { error } = await db.from("services").update({ unit_price: price }).eq("id", roof.id).eq("company_id", companyId);
        if (error) throw dbError(error);
      }
      if (price > 0) roof.unit_price = price;
    }
  }

  const included = items.flatMap((i) => {
    const service = byId.get(i.service_id);
    return service ? [{ service, quantity: i.quantity === null ? null : Number(i.quantity) }] : [];
  });
  const measured = [roof, ...included.map((i) => i.service)].some((s) => s.formula);
  const measurement = measured
    ? (must(await db.from("measurements").select(`id, ${MEASUREMENT_VALUE_FIELDS}`).eq("quote_id", quoteId).eq("company_id", companyId).order("updated_at", { ascending: false }).limit(1)) as unknown as Array<MeasurementValues & { id: string }>)[0]
    : undefined;
  if (measured && !measurement) throw new HttpError(409, "Measure the roof first.");
  const vars = measurement ? measurementVariables(measurement) : null;
  const built = packageLines(roof, included, vars);
  if (built.roofProblem) {
    const noPitch = vars !== null && ROOFING_VARIABLE_NAMES.every((name) => vars[name] === null);
    throw new HttpError(409, noPitch ? "The roof's pitch doesn't read. Set it again on the map, so its squares can be worked out." : `The ${roof.name} formula can't be worked out for this roof: ${built.roofProblem}.`);
  }

  if (replace && quote.lines.length) {
    const { error } = await db.from("quote_line_items").delete().eq("quote_id", quoteId).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  if (replace) {
    // Starting over starts the price over too: a price set on site (its discount included) or the
    // exact price sent instead of the range was for the old lines. A promo code keeps its discount.
    const { error } = await db
      .from("quotes")
      .update({ priced_on_site_at: null, exact_sent_at: null, ...(quote.promo_code_id ? {} : { discount_amount: 0 }) })
      .eq("id", quoteId)
      .eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  if (built.lines.length) {
    const { error } = await db.from("quote_line_items").insert(built.lines.map((line) => ({ company_id: companyId, quote_id: quoteId, ...line })));
    if (error) throw dbError(error);
  }
  if (measurement) {
    const { error } = await db.from("measurements").update({ show_on_quote: true, quote_id: quoteId }).eq("id", measurement.id).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  return { applied: true as const, lines: built.lines.length, skipped: built.skipped };
}

// ---------------------------------------------------------------------------------------------
// The price range
// ---------------------------------------------------------------------------------------------

/**
 * Send the homeowner a price range instead of the exact price: the estimate rounded down to the
 * estimate plus the room on top, rounded up (companies.settings.roofing). The quote keeps the lines
 * it was made from, so the office can see what changed on site.
 */
export async function sendRange(s: SalesScope, quoteId: string, body: SendBody) {
  const quote = must(
    await s.db
      .from("quotes")
      .select("id, number, status, total, client_id, client:clients(display_name, email, phone), lines:quote_line_items(id, service_id, name, quantity, unit, unit_price, unit_cost, taxable, formula, optional, selected, sort)")
      .eq("id", quoteId)
      .eq("company_id", s.companyId)
      .maybeSingle(),
    "That estimate wasn't found.",
  );
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  if (!quote.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  // Check where it's going before the quote changes, so a missing email doesn't leave it half sent.
  if (body.channel === "email" && !isEmail(body.to || quote.client?.email)) throw new HttpError(400, "Add a valid email address for this client first.");
  if (body.channel === "sms" && !(body.to || quote.client?.phone)) throw new HttpError(400, "This client has no phone number.");

  const company = must(await s.db.from("companies").select("name, currency, settings").eq("id", s.companyId).maybeSingle());
  const range = priceRange(quote.total, rangeSettings(company.settings));
  const lines = [...quote.lines].sort((a, b) => a.sort - b.sort);
  // A new range: nothing is priced on site or sent at the exact price yet, and the client hasn't answered.
  const { error } = await s.db
    .from("quotes")
    .update({ range_low: range.low, range_high: range.high, range_sent_at: new Date().toISOString(), range_lines: asJson(snapshotLines(lines)), range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null })
    .eq("id", quoteId)
    .eq("company_id", s.companyId);
  if (error) throw dbError(error);

  const result = await deliver(s, "quote", quote, body, rangeMessage(company, range.low, range.high));
  // Sent, or the office took the link to share themselves: the range is now with the client.
  if (result.sent || body.channel === "link") {
    await s.db.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", quoteId).in("status", ["draft", "changes_requested"]);
  }
  return { ...result, range };
}

export const RANGE_NOT_WAITING = "This price range isn't waiting for an answer.";

/**
 * The homeowner said yes to the range some other way (on the phone, by text, in person), and the
 * office marks it. It's the same step as their Yes on the link (accept_hub_range: once, only while
 * the range is out and waiting), so the follow-up is called off and the team is told to book the
 * visit. A note on the estimate says who marked it, and how they said yes when the office says.
 */
export async function markRangeAccepted(env: Env, db: Db, companyId: string, userId: string, quoteId: string, note?: string) {
  const [quoteResult, company, profile] = await Promise.all([
    db
      .from("quotes")
      .select("id, status, client_id, range_low, range_high, range_accepted_at, priced_on_site_at, exact_sent_at, client:clients(display_name)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    db.from("companies").select("currency").eq("id", companyId).maybeSingle(),
    db.from("profiles").select("full_name").eq("user_id", userId).maybeSingle(),
  ]);
  const quote = must(quoteResult, "That estimate wasn't found.");
  if (!inRangeMode(quote) || quote.range_accepted_at) throw new HttpError(409, RANGE_NOT_WAITING);

  // The service role: the step is the database's own, and only the server may take it.
  const { data: acceptedAt, error } = await adminClient(env).rpc("accept_hub_range", { p_company: companyId, p_quote: quoteId });
  if (error) throw dbError(error);
  if (!acceptedAt) throw new HttpError(409, RANGE_NOT_WAITING);

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.data?.currency || "USD", maximumFractionDigits: 0 });
  const client = quote.client?.display_name?.trim() || "The homeowner";
  const by = profile.data?.full_name?.trim() || "the office";
  const how = note?.trim();
  const body = `${client} said yes to the range (${money.format(Number(quote.range_low))} to ${money.format(Number(quote.range_high))}), marked by ${by}.${how ? `\n${how}` : ""}`;
  // The yes is saved either way: a note that didn't save isn't worth an error the office would retry into a 409.
  const { error: noteError } = await db
    .from("messages")
    .insert({ company_id: companyId, client_id: quote.client_id, channel: "note", direction: "internal", body, related_type: "quote", related_id: quoteId, sent_by: userId });
  if (noteError) console.error("Couldn't add the note for a range marked as agreed", noteError.message);
  return { accepted_at: acceptedAt };
}

// ---------------------------------------------------------------------------------------------
// The exact price, set on site
// ---------------------------------------------------------------------------------------------

/**
 * The price the salesperson and homeowner agree on, before tax. Below the estimate it's a discount;
 * above it, a "Price adjustment" line. Null goes back to the estimate as it is. Either way the quote
 * now has its exact price, so the homeowner sees it instead of the range.
 */
export async function setSitePrice(db: Db, companyId: string, quoteId: string, body: { price: number | null; note?: string }) {
  const quote = must(
    await db
      .from("quotes")
      .select("id, status, client_id, promo_code_id, lines:quote_line_items(id, name, service_id, formula, quantity, unit_price, selected, sort)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "That estimate wasn't found.",
  );
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, lockedMessage(quote.status));
  // A promo code sets the discount itself, so a price set by hand wouldn't come out right.
  if (body.price !== null && quote.promo_code_id) throw new HttpError(409, "Take the promo code off first.");

  const old = quote.lines.filter(isSiteAdjustment);
  const rest = quote.lines.filter((l) => !isSiteAdjustment(l));
  const subtotal = rest.filter((l) => l.selected).reduce((sum, l) => sum + toCents(lineTotal(l.quantity, l.unit_price)), 0) / 100;
  const { discount, extra } = body.price === null ? { discount: 0, extra: 0 } : sitePriceAdjustment(subtotal, body.price);
  const note = body.note?.trim() || null;

  if (old.length) {
    const { error } = await db.from("quote_line_items").delete().in("id", old.map((l) => l.id)).eq("quote_id", quoteId);
    if (error) throw dbError(error);
  }
  if (extra > 0) {
    const sort = quote.lines.reduce((max, l) => Math.max(max, l.sort), 0) + 1;
    const { error } = await db.from("quote_line_items").insert({
      company_id: companyId,
      quote_id: quoteId,
      service_id: null,
      name: SITE_ADJUSTMENT_NAME,
      description: note,
      quantity: 1,
      unit: "ea",
      unit_price: extra,
      unit_cost: null,
      taxable: true,
      formula: null,
      sort,
    });
    if (error) throw dbError(error);
  }
  const { error } = await db
    .from("quotes")
    .update({ priced_on_site_at: new Date().toISOString(), ...(quote.promo_code_id ? {} : { discount_amount: discount }) })
    .eq("id", quoteId)
    .eq("company_id", companyId);
  if (error) throw dbError(error);
  if (note) {
    const { error: noteError } = await db.from("messages").insert({ company_id: companyId, client_id: quote.client_id, channel: "note", direction: "internal", body: note, related_type: "quote", related_id: quoteId });
    if (noteError) throw dbError(noteError);
  }
  const totals = must(await db.from("quotes").select("subtotal, discount_amount, tax_amount, total").eq("id", quoteId).eq("company_id", companyId).maybeSingle());
  return { subtotal: Number(totals.subtotal), discount_amount: Number(totals.discount_amount), tax_amount: Number(totals.tax_amount), total: Number(totals.total) };
}

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
