/**
 * A quote that offers two or three options (quote_options): each a copy of the package it came from
 * (its name, tier, picture, highlights, warranty and contract sections) with lines of its own; lines
 * without an option are on every option. quotes.option_id is the option shown first, and once signed
 * the one chosen. Adding options from packages, filling them in after measuring, taking one off and
 * copying a quote go through the API (apps/api/src/routes/packages.ts); renaming an option, its tier
 * and words, and showing another one first are plain writes (RLS). The options bar is
 * QuoteOptions.tsx; the money for each option is core money.ts (optionTotals, optionBaseTotal).
 * Lists of quotes price one from its cheapest option until it's signed (listPrice).
 */
import { isSiteAdjustment } from "@crewtavo/core/estimates";
import { optionBaseTotal, optionTierLabels, optionTotals, type OptionLine, type TotalsPromo } from "@crewtavo/core/money";
import { useQuery } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { MAX_OPTIONS } from "../roofing/data";
import { lowestOption, SIGNED, type RangeEstimate } from "../roofing/flow/model";

/** One option on a quote, as the options bar reads it. */
export interface QuoteOptionRow {
  id: string;
  quote_id: string;
  /** The package it was made from, while that package is there. */
  package_id: string | null;
  name: string;
  tier: string | null;
  /** The package's picture when it was offered (<company>/packages/<uuid>.jpg), else its drawing (`style`). */
  picture: string | null;
  picture_width: number | null;
  picture_height: number | null;
  style: string;
  highlights: string[];
  warranty: string;
  section_ids: string[];
  sort: number;
}

export const QUOTE_OPTION_FIELDS = "id, quote_id, package_id, name, tier, picture, picture_width, picture_height, style, highlights, warranty, section_ids, sort";
/** A quote's options in a select of quotes, by the foreign key's name (there are two links between them). */
export const QUOTE_OPTIONS_EMBED = `options:quote_options!quote_options_quote_fkey(${QUOTE_OPTION_FIELDS})`;

export const quoteOptionsKey = (quoteId: string) => ["quote-options", quoteId];

/** A quote's options, in the order they're offered (none for a quote that doesn't offer options). */
export function useQuoteOptions(quoteId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: quoteOptionsKey(quoteId),
    enabled: enabled && Boolean(quoteId),
    queryFn: async () => sortOptions(unwrap(await supabase().from("quote_options").select(QUOTE_OPTION_FIELDS).eq("quote_id", quoteId)) as QuoteOptionRow[]),
  });
}

/** Options in the order they're offered: by `sort`, then as made. */
export const sortOptions = <T extends { id: string; sort: number }>(options: readonly T[]): T[] => [...options].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));

// ---------------------------------------------------------------------------------------------
// In lists of quotes
// ---------------------------------------------------------------------------------------------

/**
 * A quote in a list, as listPrice prices it: in its select `status, total, tax_rate,
 * discount_amount, promo:promo_codes(kind, value), options:quote_options!quote_options_quote_fkey(id)`,
 * and the lines withOptionLines adds.
 */
export interface ListedQuote extends RangeEstimate {
  status: string;
  options: ReadonlyArray<{ id: string }>;
}

/**
 * The price a list shows for a quote, and that the list's totals add up. One that offers options
 * and isn't signed yet starts from its cheapest option before add-ons ("From $18,300",
 * roofing/flow/model.ts lowestOption), whichever is shown first; otherwise, and while none of its
 * options has a price yet, its total, which once it's signed is the option they chose. The quotes
 * list and the sales board price quotes this way, as the roofing and paving lists do.
 */
export function listPrice(q: ListedQuote): { amount: number; from: boolean } {
  const from = q.options.length && !SIGNED.includes(q.status) ? lowestOption(q) : null;
  return from === null ? { amount: Number(q.total), from: false } : { amount: from, from: true };
}

/**
 * The quotes of a list with the lines listPrice needs, read again only for the ones that offer
 * options and aren't signed, so a list without options doesn't read every quote's lines. The rest
 * get none and are priced at their total.
 */
export async function withOptionLines<Q extends { id: string; status: string; options: ReadonlyArray<{ id: string }> }>(quotes: readonly Q[]): Promise<Array<Q & { lines: OptionLine[] }>> {
  const ids = quotes.filter((q) => q.options.length && !SIGNED.includes(q.status)).map((q) => q.id);
  const lines = new Map<string, OptionLine[]>();
  for (let i = 0; i < ids.length; i += 200) {
    const rows = unwrap(await supabase().from("quotes").select("id, lines:quote_line_items(option_id, quantity, unit_price, taxable, optional, selected)").in("id", ids.slice(i, i + 200)));
    for (const r of rows) lines.set(r.id, r.lines);
  }
  return quotes.map((q) => ({ ...q, lines: lines.get(q.id) ?? [] }));
}

// ---------------------------------------------------------------------------------------------
// Changing them
// ---------------------------------------------------------------------------------------------

/** A package's line left off an option, and why (nothing of it on this job, or a formula that can't be worked out). */
export interface SkippedLine {
  package: string;
  name: string;
  reason: string;
}

export interface OptionsResult {
  options: Array<Omit<QuoteOptionRow, "quote_id">>;
  skipped: SkippedLine[];
  /** The deposit, only when it was lowered: it's never more than the cheapest option's price (the server keeps it so). */
  deposit_amount?: number;
}

/** The sentence when adding or filling in options lowered the deposit, or null when it didn't. */
export const depositNote = (result: Pick<OptionsResult, "deposit_amount">) =>
  result.deposit_amount === undefined ? null : `The deposit is now ${formatMoneyCents(result.deposit_amount)}, so it's no more than the cheapest option.`;

/**
 * Offer packages on a quote (POST /quotes/:id/options). `add` puts them beside the options there
 * are; a quote with lines and no options becomes option 1 first, except the lines listed in
 * `sharedLineIds`, which stay on every option. `replace` starts the quote over from them. One
 * package on an empty quote is a single estimate, as it always was.
 */
export const addOptions = (quoteId: string, packageIds: readonly string[], mode: "add" | "replace" = "add", sharedLineIds?: readonly string[]) =>
  api.post<OptionsResult>(`/quotes/${quoteId}/options`, { package_ids: packageIds, mode, ...(sharedLineIds ? { shared_line_ids: sharedLineIds } : {}) });

/** How many lines a quote has; none after one package went on means its lines wait for the measurement. */
export async function quoteLineCount(quoteId: string): Promise<number> {
  const result = await supabase().from("quote_line_items").select("id", { count: "exact", head: true }).eq("quote_id", quoteId);
  unwrap(result);
  return result.count ?? 0;
}

/** After measuring: the options (or the single package) offered before get their lines. */
export const fillOptions = (quoteId: string) => api.post<OptionsResult>(`/quotes/${quoteId}/options/fill`);

/** Take an option off a quote, with its lines; with one left, it's a single estimate again. */
export const removeOption = (quoteId: string, optionId: string) => api.delete<{ options: OptionsResult["options"] }>(`/quotes/${quoteId}/options/${optionId}`);

/** "Copy as new draft": the quote with its lines and options. Returns the copy's id. */
export const duplicateQuote = (quoteId: string) => api.post<{ id: string }>(`/quotes/${quoteId}/duplicate`);

/**
 * Show this option first ("Show this one first" in the office, "They chose this one" on the iPad).
 * Its lines count from now on; another option's add-ons start unpicked, and a price set on site for
 * another option goes (the database does both).
 */
export async function showOption(quoteId: string, optionId: string) {
  unwrap(await supabase().from("quotes").update({ option_id: optionId }).eq("id", quoteId));
}

/** What the office can change on an option: the words on its card. */
export type OptionPatch = Partial<Pick<QuoteOptionRow, "name" | "tier" | "highlights" | "warranty">>;

export async function saveOption(optionId: string, patch: OptionPatch) {
  unwrap(await supabase().from("quote_options").update(patch).eq("id", optionId));
}

/**
 * The lines left off, in a sentence for after options are added or filled in: nothing of them on
 * this job, an option whose package was deleted (filling in: its name is the option's), or a
 * formula that can't be worked out from the measurements.
 */
export function skippedText(skipped: readonly SkippedLine[]): string | null {
  if (!skipped.length) return null;
  const list = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
  const kind = (s: SkippedLine) => (s.reason.startsWith("None on this") ? "none" : s.reason.startsWith("Its package was deleted") ? "gone" : "formula");
  const names = (k: ReturnType<typeof kind>) => [...new Set(skipped.filter((s) => kind(s) === k).map((s) => s.name))];
  const [none, gone, other] = [names("none"), names("gone"), names("formula")];
  return [
    none.length ? `Left off, with nothing to measure on this job: ${list(none)}.` : null,
    gone.length === 1 ? `${gone[0]}'s package was deleted, so add its lines by hand.` : gone.length ? `The packages of ${list(gone)} were deleted, so add their lines by hand.` : null,
    other.length ? `Couldn't work out ${list(other)} from the measurements. Add ${other.length === 1 ? "it" : "them"} by hand.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The toast once packages went on: how many options, or for one package on its own, that it's on
 * the estimate, what was left off, and the deposit when a cheaper option lowered it. `lines` is how many lines the estimate has after (null when
 * that couldn't be read): none means they wait for the roof's measurement (else the package is empty).
 */
export function addedMessage(result: OptionsResult, { name, startOver, lines, roofing }: { name: string; startOver: boolean; lines: number | null; roofing: boolean }): { title: string; description: string | null } {
  const waiting = lines === 0 && !result.skipped.length;
  const and = (text: string | null) => [text, depositNote(result)].filter(Boolean).join(" ") || null;
  if (result.options.length) {
    return { title: `${result.options.length} options on the estimate`, description: and(waiting && roofing ? "Their lines fill in once the roof is measured." : skippedText(result.skipped)) };
  }
  return {
    title: startOver ? `Estimate started over from ${name}` : `${name} is on the estimate`,
    description: and(waiting ? (roofing ? "Its lines fill in once the roof is measured." : "That package has nothing in it yet.") : skippedText(result.skipped)),
  };
}

// ---------------------------------------------------------------------------------------------
// The options bar, in plain functions
// ---------------------------------------------------------------------------------------------

/** The parts of a quote the options bar prices with. */
export interface OptionsQuote {
  id: string;
  status: string;
  /** The option shown first (once signed, the one chosen). */
  option_id: string | null;
  tax_rate: number | string;
  discount_amount: number | string;
  promo: TotalsPromo | null;
  /** The package the quote's lines came from, which becomes option 1 when options are added. */
  roof_package_id: string | null;
  /** When a price was set on site (for the shown option): choosing another clears it. */
  priced_on_site_at: string | null;
}

/** A line on the estimate as the options bar has it: what it costs, and what it is. */
export interface OptionsLine extends OptionLine {
  id: string;
  name: string;
  service_id: string | null;
  formula: string | null;
}

/** Whether a quote's options can still change: not once it's signed, lost or archived. */
export const optionsOpen = (status: string) => ["draft", "sent", "changes_requested"].includes(status);

/**
 * When the office marks a quote approved but the client signed it meanwhile (Client Hub or iPad):
 * the write goes on only while the quote is still open, so their signature keeps its own approval.
 */
export const ALREADY_ANSWERED = "The client has already answered this quote.";

/**
 * What to ask before `name` is shown first (in the office) or marked as their choice (on the iPad),
 * or null to go straight ahead. Once the customer has the estimate, their link opens on it and the
 * add-ons they picked are cleared; a price set on site was for the option it was set on.
 */
export function showAsk(mode: "office" | "visit", quote: Pick<OptionsQuote, "status" | "priced_on_site_at">, name: string): { title: string; body: string; confirmLabel: string } | null {
  const priced = Boolean(quote.priced_on_site_at);
  if (mode === "visit") return priced ? { title: "Change the option?", body: "Changing the option clears the price you set.", confirmLabel: "Change it" } : null;
  const sent = quote.status !== "draft";
  if (!sent && !priced) return null;
  const body = sent
    ? `They already have this estimate. Their link will open on ${name}, and any add-ons they picked${priced ? " and the price set on site" : ""} are cleared.`
    : "Changing the option clears the price set on site.";
  return { title: `Show ${name} first?`, body, confirmLabel: "Show it first" };
}

/**
 * How the options bar marks the option shown (quotes.option_id), and what it says under it while
 * it's the one looked at. In the office it's the one the customer sees first. On the iPad it's the
 * one the price and the signing are for, which the office may have set before anyone on site chose
 * (quotes.option_id doesn't say who set it), so it isn't called their choice until it's signed.
 */
export function shownWords(mode: "office" | "visit", signed: boolean): { chip: string; note: string } {
  if (signed) return { chip: "Chosen", note: "Signed estimates keep their option." };
  return mode === "visit"
    ? { chip: "Pricing this one", note: "The price you set and the signing are for this one. If they want another, tap it, then “They chose this one”." }
    : { chip: "Shown first", note: "The customer sees this one first." };
}

/**
 * The option a screen is looking at: the one picked to look at, else the one shown first, else the
 * first. Null when the quote has no options. (`viewing` is local: looking changes nothing.)
 */
export function viewedOption(options: ReadonlyArray<{ id: string }>, viewing: string | null, shownId: string | null): string | null {
  return options.find((o) => o.id === viewing)?.id ?? options.find((o) => o.id === shownId)?.id ?? options[0]?.id ?? null;
}

export interface OptionTab<T> {
  option: T;
  /** Its own tier, or Good, Better and Best by price when none has one (core optionTierLabels). */
  tier: string | null;
  /** Its total as it would be shown, with the quote's tax and discount; null while it has no lines of its own. */
  total: number | null;
  shown: boolean;
}

/** One tab per option, in order: its tier word, its total (core optionTotals) and whether it's shown. */
export function optionTabs<T extends { id: string; tier: string | null; sort: number }>(options: readonly T[], lines: readonly OptionLine[], quote: Pick<OptionsQuote, "option_id" | "tax_rate" | "discount_amount" | "promo">): Array<OptionTab<T>> {
  const opts = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  const sorted = sortOptions(options);
  const tiers = optionTierLabels(sorted.map((o) => ({ id: o.id, tier: o.tier, total: optionBaseTotal(lines, o.id, opts) })));
  return sorted.map((option) => ({
    option,
    tier: tiers.get(option.id) ?? null,
    total: lines.some((l) => l.option_id === option.id) ? optionTotals(lines, option.id, quote.option_id, opts).total : null,
    shown: option.id === quote.option_id,
  }));
}

/**
 * What "Add options" can offer on a quote: the packages already on it (picked and locked, in the
 * options' order: the options' packages, and the quote's own package when its lines become option
 * 1), how many the picker can hold with them (`max`), and how many options there are before any are
 * added (`taken`, counting the quote's lines as option 1 when they'll become one). `empty`: nothing
 * on the quote yet, so one package prices it as a single estimate.
 */
export function optionsPlan(options: ReadonlyArray<{ id: string; sort: number; package_id: string | null }>, lineCount: number, roofPackageId: string | null, packageIds: readonly string[]) {
  const converting = options.length === 0 && lineCount > 0;
  const known = new Set(packageIds);
  const locked = [...new Set([...sortOptions(options).map((o) => o.package_id), converting ? roofPackageId : null])].filter((id): id is string => id !== null && known.has(id));
  const taken = options.length + (converting ? 1 : 0);
  return { converting, empty: options.length === 0 && lineCount === 0, locked, taken, max: Math.max(MAX_OPTIONS - taken, 0) + locked.length };
}

/**
 * The "Add options" button, for the packages picked that aren't on the quote yet: what it says and
 * whether it can go. On a quote with nothing on it, one package prices it ("Use …"); otherwise it
 * takes two or three options once they're added. Starting over takes one package or more.
 */
export function addAction(plan: Pick<ReturnType<typeof optionsPlan>, "empty" | "taken">, picked: readonly string[], startOver: boolean, nameOf: (id: string) => string): { label: string; ready: boolean } {
  if (startOver) {
    return { ready: picked.length > 0, label: picked.length === 1 ? `Start over as ${nameOf(picked[0]!)}` : picked.length ? `Start over with ${picked.length} options` : "Start over" };
  }
  if (plan.empty && picked.length === 1) return { ready: true, label: `Use ${nameOf(picked[0]!)}` };
  const total = plan.taken + picked.length;
  return picked.length && total >= 2 ? { ready: true, label: `Offer ${total} options` } : { ready: false, label: "Offer options" };
}

type PackageServices = { roof_service_id: string | null; items: ReadonlyArray<{ service_id: string; kind: string }> };

/**
 * The lines that stay on every option at first when the estimate becomes option 1: the ones no
 * package on offer has (extras found on the job, lines typed by hand), so they count whichever option
 * is picked. A line a package has stays with option 1, or the option made from that package would
 * have it twice. With no package to tell by (`current` null: priced by hand, or its package deleted)
 * every line stays with option 1. A price set on site always goes with option 1.
 */
export function sharedAtFirst(lines: readonly Pick<OptionsLine, "id" | "name" | "service_id" | "formula">[], current: PackageServices | null, offered: readonly PackageServices[]): string[] {
  if (!current) return [];
  const fromPackages = new Set([current, ...offered].flatMap((p) => [p.roof_service_id, ...p.items.filter((i) => i.kind === "included").map((i) => i.service_id)]));
  return lines.filter((l) => !isSiteAdjustment(l) && !(l.service_id && fromPackages.has(l.service_id))).map((l) => l.id);
}
