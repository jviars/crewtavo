/**
 * Before a roof estimate goes out (Roofing's send dialog): what its packages left off that someone
 * should decide about, and the roof's sections too low for a shingle package.
 *
 * Left off is worked out again from the packages and the roof as they are now (packageLines), so a
 * roof measured since puts the line on and takes it off the list. Only what may be missing is asked
 * about: a line that couldn't be worked out, or one that came to nothing from roof edges none of
 * which are marked (core leftOutReason); a steep charge on a 6/12 roof isn't. Each is office only
 * unless the office shows it to the homeowner as "Not included" (quotes.left_out, read by the
 * estimate document); what was decided goes in the estimate's notes, with who decided it.
 */
import { formulaVariables, leftOutReason, lowSlopeSections, type LowSlopeSection, type Section } from "@crewtavo/core";
import { HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";
import { measurementVariables } from "./measurements";
import { loadPackages, packageLines, packageWork, type PricedPackage } from "./roofPackages";

/** One line a package left off this estimate, and whether the homeowner sees it as "Not included". */
export interface LeftOutItem {
  service_id: string;
  /** The option it's left off, on an estimate that offers options; null without. */
  option_id: string | null;
  option: string | null;
  name: string;
  reason: string;
  shown: boolean;
}

/** As kept on the quote (quotes.left_out). */
type Kept = Pick<LeftOutItem, "service_id" | "option_id" | "name" | "reason" | "shown">;

const keptOf = (raw: unknown): Kept[] =>
  (Array.isArray(raw) ? raw : []).filter((x): x is Kept => Boolean(x) && typeof x === "object" && typeof (x as Kept).service_id === "string" && typeof (x as Kept).name === "string");

const same = (a: Pick<Kept, "service_id" | "option_id">, b: Pick<Kept, "service_id" | "option_id">) => a.service_id === b.service_id && (a.option_id ?? null) === (b.option_id ?? null);

async function check(db: Db, companyId: string, quoteId: string) {
  const quote = must(
    await db
      .from("quotes")
      .select("id, client_id, work_kind, roof_package_id, left_out, lines:quote_line_items(service_id, option_id), options:quote_options!quote_options_quote_fkey(id, name, package_id)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "That estimate wasn't found.",
  );
  const wanted = quote.options.length
    ? quote.options.flatMap((o) => (o.package_id ? [{ option: o as { id: string; name: string }, packageId: o.package_id }] : []))
    : quote.roof_package_id
      ? [{ option: null, packageId: quote.roof_package_id }]
      : [];
  const nothing = { quote, items: [] as LeftOutItem[], lowSlope: [] as LowSlopeSection[] };
  if (!wanted.length) return nothing;
  const { roofing, measurement } = await packageWork(db, companyId, quote, wanted.map((w) => w.packageId));
  // Before the roof's measured there's nothing priced to miss; outside roofing there's no roof to check.
  if (!roofing || !measurement) return nothing;
  let packages: PricedPackage[];
  try {
    packages = await loadPackages(db, companyId, wanted.map((w) => w.packageId), true);
  } catch (error) {
    // A package deleted or missing its roof: the estimate step says so; it doesn't stop it going out.
    if (error instanceof HttpError) return nothing;
    throw error;
  }

  const kept = keptOf(quote.left_out);
  const vars = measurementVariables(measurement);
  const items: LeftOutItem[] = [];
  for (const { option, packageId } of wanted) {
    const p = packages.find((x) => x.pkg.id === packageId)!;
    const services = [p.main, ...p.included.map((i) => i.service)];
    for (const skipped of packageLines(p.main, p.included, vars, true).skipped) {
      const optionId = option?.id ?? null;
      // On the estimate anyway (added by hand, or on every option): nothing's missing.
      if (quote.lines.some((l) => l.service_id === skipped.service_id && (l.option_id === null || l.option_id === optionId))) continue;
      let reads: Set<string>;
      try {
        reads = formulaVariables(services.find((s) => s?.id === skipped.service_id)?.formula ?? "");
      } catch {
        reads = new Set();
      }
      const reason = leftOutReason(reads, skipped.none, skipped.reason);
      if (!reason || items.some((i) => same(i, { service_id: skipped.service_id, option_id: optionId }))) continue;
      const shown = kept.some((k) => same(k, { service_id: skipped.service_id, option_id: optionId }) && k.shown === true);
      items.push({ service_id: skipped.service_id, option_id: optionId, option: option?.name ?? null, name: skipped.name, reason, shown });
    }
  }
  const shingles = packages.some((p) => p.pkg.style === "shingle" || p.pkg.style === "designer");
  const sections = (Array.isArray(measurement.sections) ? measurement.sections : []) as Section[];
  return { quote, items, lowSlope: shingles ? lowSlopeSections(sections, measurement.roof_pitch) : [] };
}

/** What the send dialog asks about: left off (with what was decided last time) and low slopes. */
export async function sendCheck(db: Db, companyId: string, quoteId: string) {
  const { items, lowSlope } = await check(db, companyId, quoteId);
  return { items, low_slope: lowSlope };
}

/**
 * The office's choice for each line left off (`shown`: the ones the homeowner sees as "Not
 * included"; the rest are office only), kept on the quote. When it changed, a note in the
 * estimate's thread says what was left off, why, and how, from whoever decided.
 */
export async function saveLeftOut(db: Db, companyId: string, userId: string, quoteId: string, shown: ReadonlyArray<Pick<Kept, "service_id" | "option_id">>) {
  const { quote, items } = await check(db, companyId, quoteId);
  const next = items.map((i) => ({ ...i, shown: shown.some((s) => same(s, i)) }));
  const kept = next.map(({ service_id, option_id, name, reason, shown: on }): Kept => ({ service_id, option_id, name, reason, shown: on }));
  const before = keptOf(quote.left_out);
  const changed = kept.length !== before.length || kept.some((k) => !before.some((b) => same(b, k) && b.shown === k.shown && b.reason === k.reason));
  if (!changed) return next;
  must(await db.from("quotes").update({ left_out: kept }).eq("id", quoteId).eq("company_id", companyId).select("id").single());
  if (next.length && quote.client_id) {
    const body = ["Left off this estimate:", ...next.map((i) => `• ${i.name}${i.option ? ` (${i.option})` : ""}: ${i.reason}. ${i.shown ? "Shown to the homeowner as not included." : "Office only."}`)].join("\n");
    // The choice is saved either way: a note that didn't save isn't worth stopping the estimate going out.
    const { error } = await db.from("messages").insert({ company_id: companyId, client_id: quote.client_id, channel: "note", direction: "internal", body, related_type: "quote", related_id: quoteId, sent_by: userId });
    if (error) console.error("Couldn't add the note for what was left off an estimate", error.message);
  }
  return next;
}
