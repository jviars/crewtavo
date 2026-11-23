/**
 * "Draft a quote" on a request (Jobber's "Draft for me"): a draft quote filled in from the request,
 * for the office to review. Nothing is sent.
 *
 *   With Claude     when the company switched it on for this (settings.quote_ai, after the key was
 *                   checked with Claude: setQuoteAi). Claude reads the request (its answers, notes
 *                   and its photos' captions), the property's town and lot size, and the price
 *                   list, and proposes lines and a short description. It's never sent the street
 *                   address or the property's notes: gate codes and the like live there. It never
 *                   sets a price or makes up an item: every line is checked against the price list
 *                   here (validateDraft) and takes the item's own name, unit, price and tax;
 *                   anything else is dropped. A quantity the request doesn't give is 1, flagged
 *                   "check the quantity". Its description is the quote's message when a person
 *                   pressed Draft a quote, who reads it there and then. On a draft made by itself
 *                   it stays with the office's notes (quotes.drafted.description), to be used as
 *                   the message with a press: it was written from what a stranger typed into a
 *                   form, so someone reads it before a client can.
 *   Without         lines from the price list items whose names match the request's choice answers
 *                   or its form's name (matchPriceList), and the page says that Claude drafts better.
 *                   Also what happens when Claude can't be asked (busy, the key failed).
 *
 * A price list longer than MAX_PRICE_ITEMS is only looked at that far, with or without Claude, and
 * the draft says so (quotes.drafted.price_list), so nobody takes the draft for the whole list's.
 *
 * Either way the request's answers go in the quote's notes for the office (quotes.drafted, never sent
 * to the client), and the quote is made the way Create quote makes it (sales.ts quoteFromRequest).
 * A company with "Draft a quote when a request comes in" on (settings.quotes.draft_requests) gets
 * one by itself for each request from a booking form or the Client Hub, and the office is told.
 * That one leaves the request exactly as it came in (still new, still bookable at the time asked
 * for, an online booking's status untouched: nobody has quoted anything yet), and when nothing on
 * the price list matches it makes no quote at all, rather than an empty numbered one.
 */
import { z } from "zod";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { adminClient, type Db } from "../lib/supabase";
import { complete, countAiAsk } from "./ai";
import { quoteFromRequest, type SalesScope } from "./sales";

/** A price list item (services) as a draft reads it. */
export interface PriceItem {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  unit: string;
  unit_price: number;
  taxable: boolean;
}

/** A line of the draft: the item's own name, unit, price and tax, and the quantity. */
export interface DraftLine {
  service_id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  taxable: boolean;
  /** The request didn't give the quantity: it's 1 until someone checks it. */
  check: boolean;
}

/** An answer on the request, as the office reads it: its question, and whether it was a choice. */
export interface RequestAnswer {
  label: string;
  value: string;
  choice: boolean;
}

/** The most lines a draft has, and price list items Claude is shown. */
export const MAX_DRAFT_LINES = 30;
export const MAX_PRICE_ITEMS = 500;

// What was typed to reach the client, which the client's record has: not part of what they asked for.
const CONTACT = /^(name|first_?name|last_?name|full_?name|email|e-?mail|phone|phone_?number|mobile|address|street|city|state|zip|postal_?code|promo_?code)$/i;

/**
 * The request's answers in its form's order (then any the form no longer asks), each under its
 * question and as text: a list of choices joined, yes and no as words. Files and photos, and the
 * name, email, phone and address typed to reach them, aren't answers to quote from.
 */
export function requestAnswers(questions: unknown, answers: unknown): RequestAnswer[] {
  const asked = (Array.isArray(questions) ? questions : []) as Array<{ key?: string; label?: string; type?: string }>;
  const given = answers && typeof answers === "object" && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const order = [...asked.map((q) => q.key).filter((k): k is string => Boolean(k)), ...Object.keys(given)];
  const out: RequestAnswer[] = [];
  for (const key of new Set(order)) {
    const q = asked.find((x) => x.key === key);
    if (q?.type === "files" || q?.type === "photos" || q?.type === "address" || (!q && CONTACT.test(key))) continue;
    const raw = given[key];
    const value = Array.isArray(raw) ? raw.map(String).join(", ") : typeof raw === "boolean" ? (raw ? "Yes" : "No") : raw == null ? "" : String(raw);
    if (!value.trim()) continue;
    out.push({ label: q?.label?.trim() || key.replace(/_/g, " "), value: value.trim().slice(0, 2000), choice: q?.type === "choice" || q?.type === "multi_choice" });
  }
  return out;
}

/** The answers as the quote's notes: "Question: answer", a line each. */
export const answerNotes = (answers: readonly RequestAnswer[]) => answers.map((a) => `${a.label}: ${a.value}`).join("\n");

const words = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * Price list items whose names match what the client picked or the form they used: an item's name
 * within a choice ("Weekly mowing" picks "Mowing"), or a choice within the name ("Gutter cleaning"
 * picks "Gutter cleaning, per foot"), whole words only and three letters at least. In price list
 * order, each once.
 */
export function matchPriceList(picked: readonly string[], items: readonly PriceItem[]): PriceItem[] {
  const said = picked.flatMap((p) => p.split(/\s*,\s*/)).map(words).filter((w) => w.trim().length >= 3);
  return items
    .filter((item) => {
      const name = words(item.name);
      if (name.trim().length < 3) return false;
      return said.some((w) => w.includes(name) || name.includes(w));
    })
    .slice(0, MAX_DRAFT_LINES);
}

/** A line from an item, at the item's price. */
const lineOf = (item: PriceItem, quantity: number | null): DraftLine => ({
  service_id: item.id, name: item.name, description: item.description, quantity: quantity ?? 1, unit: item.unit, unit_price: Number(item.unit_price), taxable: item.taxable, check: quantity === null,
});

/**
 * Price list items named, whole, in something written freely (the request's title or details):
 * "Sealcoat my driveway" names "Sealcoat". Only that way round: a few words of a sentence inside an
 * item's longer name say nothing. In price list order, each once.
 */
export function namedInText(texts: readonly (string | null | undefined)[], items: readonly PriceItem[]): PriceItem[] {
  const written = texts.filter((t): t is string => Boolean(t?.trim())).map(words);
  return items.filter((item) => {
    const name = words(item.name);
    return name.trim().length >= 3 && written.some((w) => w.includes(name));
  });
}

/**
 * The draft without Claude: the items matching what the client picked or the form they used, then
 * any the request's title or details name outright, a quantity of 1 each to check.
 */
export function priceListDraft(answers: readonly RequestAnswer[], formName: string | null, items: readonly PriceItem[], written: readonly (string | null | undefined)[] = []): DraftLine[] {
  const picked = [...answers.filter((a) => a.choice).map((a) => a.value), ...(formName ? [formName] : [])];
  const matched = matchPriceList(picked, items);
  const named = namedInText(written, items).filter((item) => !matched.some((m) => m.id === item.id));
  return [...matched, ...named].slice(0, MAX_DRAFT_LINES).map((item) => lineOf(item, null));
}

/** Said on the quote when the price list had nothing for the request, so nobody takes an empty draft for a drafted one. */
export const NOTHING_MATCHED = "Nothing on your price list matched what they asked for. Add the lines yourself.";

const proposal = z.object({
  description: z.string().optional().nullable(),
  lines: z.array(z.unknown()).optional().nullable(),
});

/** The JSON object in Claude's answer (it's asked for JSON alone, but may wrap it in a code block). */
export function readJsonAnswer(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * What Claude proposed, as lines the quote can take: only items on the price list (by their id),
 * each with the item's own name, unit, price and tax whatever it said, each once; a quantity it gave
 * that's a number above 0 (to 3 decimals, 100,000 at most), else 1 to check. Everything else is
 * dropped, and counted.
 */
export function validateDraft(raw: unknown, items: readonly PriceItem[]): { description: string | null; lines: DraftLine[]; dropped: number } {
  const parsed = proposal.safeParse(raw);
  if (!parsed.success) return { description: null, lines: [], dropped: 0 };
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines: DraftLine[] = [];
  let dropped = 0;
  for (const line of parsed.data.lines ?? []) {
    const p = (line && typeof line === "object" ? line : {}) as { id?: unknown; quantity?: unknown };
    const item = typeof p.id === "string" ? byId.get(p.id) : undefined;
    if (!item || lines.some((l) => l.service_id === item.id) || lines.length >= MAX_DRAFT_LINES) {
      dropped++;
      continue;
    }
    const q = typeof p.quantity === "number" ? p.quantity : typeof p.quantity === "string" && p.quantity.trim() ? Number(p.quantity) : NaN;
    lines.push(lineOf(item, Number.isFinite(q) && q > 0 && q <= 100_000 ? Math.round(q * 1000) / 1000 : null));
  }
  const description = (parsed.data.description ?? "").replace(/\s+\n/g, "\n").trim().slice(0, 2000) || null;
  return { description, lines, dropped };
}

/** What Claude is told and asked: the request and the price list, never a price to choose. */
export function draftPrompt(input: {
  company: string;
  request: { title: string; details: string | null; source: string; form: string | null };
  answers: readonly RequestAnswer[];
  /** Where the work is, roughly, and how big: never the street address or the property's notes. */
  property: { city: string | null; region: string | null; lot_size_sqft: number | null } | null;
  photos: readonly string[];
  items: readonly PriceItem[];
}) {
  const system =
    `You draft a quote for ${input.company}, a home-services business, from a customer's request. ` +
    "Use only items from the price list, each by its id, and never make up an item, a price or a discount. " +
    "Give a quantity only when the request says it (a count, an area, a length, how many visits); otherwise leave quantity out. " +
    "Leave out anything the request doesn't ask for. The description is one or two plain sentences to the customer about the work, with no prices. " +
    'Reply with JSON only, in this shape: {"description": "...", "lines": [{"id": "<price list id>", "quantity": 3}]}';
  const prompt = JSON.stringify({
    request: { ...input.request, answers: input.answers.map((a) => ({ question: a.label, answer: a.value })), photo_captions: input.photos },
    property: input.property,
    price_list: input.items.map((i) => ({ id: i.id, name: i.name, description: i.description, unit: i.unit, category: i.category })),
  });
  return { system, prompt };
}

/** Whether Claude drafts quotes for the company (settings.quote_ai, only the server sets it). */
export const quoteAiOn = (settings: unknown) => (settings as { quote_ai?: { on?: unknown } } | null)?.quote_ai?.on === true;
/** Whether a request from a booking form or the Client Hub gets a draft by itself (settings.quotes.draft_requests). */
export const draftsNewRequests = (settings: unknown) => (settings as { quotes?: { draft_requests?: unknown } } | null)?.quotes?.draft_requests === true;

export interface Drafted {
  id: string;
  number: number | null;
  by: "claude" | "price_list";
  lines: number;
  /** Lines whose quantity to check. */
  check: number;
  /** Why it wasn't Claude's, when Claude is on: what to tell the office. */
  note: string | null;
}

/**
 * Make the draft for whoever pressed Draft a quote (`userId`). The scope's client, the person's own,
 * writes the quote, and the request becomes Quoted as with Create quote. With nothing to put on it,
 * the quote is still started, and says so.
 */
export async function draftQuote(s: SalesScope, requestId: string, userId: string): Promise<Drafted> {
  return (await makeDraft(s, requestId, userId, false))!;
}

/**
 * The draft itself. `auto`: made by itself as the request came in, with the server's client and the
 * ask counted against the company alone. Then the request is left as it is, and null comes back,
 * with no quote made, when there's nothing to put on one.
 */
async function makeDraft(s: SalesScope, requestId: string, userId: string | null, auto: boolean): Promise<Drafted | null> {
  const request = await loadRequest(s.db, s.companyId, requestId);
  const [company, items] = await Promise.all([
    adminClient(s.env).from("companies").select("name, settings").eq("id", s.companyId).maybeSingle(),
    s.db.from("services").select("id, name, description, category, unit, unit_price, taxable", { count: "exact" }).eq("company_id", s.companyId).eq("active", true).order("sort").order("name").limit(MAX_PRICE_ITEMS),
  ]);
  if (company.error || !company.data) throw new HttpError(404, "Company not found.");
  if (items.error) throw new HttpError(500, items.error.message);
  const priceList = (items.data ?? []) as PriceItem[];
  // A longer price list than a draft looks at: said on the quote, so what's missing isn't a surprise.
  const cut = (items.count ?? 0) > priceList.length ? { shown: priceList.length, of: items.count! } : null;
  const answers = requestAnswers(request.form?.questions, request.answers);
  let lines: DraftLine[] = [];
  let description: string | null = null;
  let by: Drafted["by"] = "price_list";
  let note: string | null = null;

  if (quoteAiOn(company.data.settings) && priceList.length) {
    try {
      await countAiAsk(s.env, s.companyId, userId);
      const { system, prompt } = draftPrompt({
        company: company.data.name,
        request: { title: request.title, details: request.details, source: request.source, form: request.form?.name ?? null },
        answers,
        property: request.property ? { city: request.property.city, region: request.property.region, lot_size_sqft: request.property.lot_size_sqft } : null,
        photos: request.photos,
        items: priceList,
      });
      const text = await complete(s.env, { asker: { companyId: s.companyId, userId }, system, prompt, effort: "low", maxTokens: 3000 });
      const proposed = validateDraft(readJsonAnswer(text), priceList);
      lines = proposed.lines;
      description = proposed.description;
      by = "claude";
      if (!lines.length) note = "The AI didn't find anything on your price list for this request. Add the lines yourself.";
    } catch (error) {
      if (!(error instanceof HttpError)) reportError(error, { feature: "quote_draft", company: s.companyId });
      note = `The AI couldn't draft this one (${error instanceof HttpError ? error.message.replace(/\.$/, "") : "it didn't answer"}), so it was drafted from your price list.`;
    }
  }
  if (by === "price_list") {
    lines = priceListDraft(answers, request.form?.name ?? null, priceList, [request.title, request.details]);
    if (!lines.length) note = note ? `${note} ${NOTHING_MATCHED}` : NOTHING_MATCHED;
  }

  if (auto && !lines.length) return null;
  const quote = await quoteFromRequest(s, requestId, { keepRequest: auto });
  if (lines.length) {
    const { data: saved, error } = await s.db
      .from("quote_line_items")
      .insert(lines.map((l, i) => ({ company_id: s.companyId, quote_id: quote.id, service_id: l.service_id, name: l.name, description: l.description, quantity: l.quantity, unit: l.unit, unit_price: l.unit_price, taxable: l.taxable, sort: i })))
      .select("id, sort");
    if (error) throw new HttpError(500, error.message);
    const check = (saved ?? []).filter((row) => lines[row.sort]?.check).map((row) => row.id);
    await saveDrafted(s.db, quote.id, { by, auto, request: request.number, check, lines: lines.length, answers, note, description, cut });
  } else {
    await saveDrafted(s.db, quote.id, { by, auto, request: request.number, check: [], lines: 0, answers, note, description, cut });
  }
  return { id: quote.id, number: quote.number, by, lines: lines.length, check: lines.filter((l) => l.check).length, note };
}

async function saveDrafted(db: Db, quoteId: string, d: { by: Drafted["by"]; auto: boolean; request: number | null; check: string[]; lines: number; answers: readonly RequestAnswer[]; note: string | null; description: string | null; cut: { shown: number; of: number } | null }) {
  // `auto` marks one made by itself: its request is still as it came in, and becomes Quoted when this
  // quote is sent. Claude's description for it stays here, with the office's notes, until someone
  // uses it as the message; a person who pressed Draft a quote gets it as the message to read now.
  const drafted = {
    by: d.by, at: new Date().toISOString(), request_number: d.request, check: d.check, lines: d.lines, notes: answerNotes(d.answers) || null, note: d.note,
    ...(d.auto ? { auto: true } : {}),
    ...(d.auto && d.description ? { description: d.description } : {}),
    ...(d.cut ? { price_list: d.cut } : {}),
  };
  const { error } = await db.from("quotes").update({ drafted, ...(d.description && !d.auto ? { message: d.description } : {}) }).eq("id", quoteId);
  if (error) throw new HttpError(500, error.message);
}

/** The request, with what a draft reads: its form and questions, the property, and its photos' captions. */
async function loadRequest(db: Db, companyId: string, requestId: string) {
  const { data, error } = await db
    .from("requests")
    .select("id, number, title, details, answers, source, client_id, assigned_to, form:intake_forms(name, questions), property:properties(city, region, lot_size_sqft), files:plan_files(title)")
    .eq("id", requestId)
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Request not found.");
  const files = (data.files ?? []) as Array<{ title: string | null }>;
  return { ...data, photos: files.map((f) => f.title?.trim() ?? "").filter(Boolean).slice(0, 20) };
}

/**
 * A request just in from a booking form or the Client Hub, at a company with "Draft a quote when a
 * request comes in" on: its draft, made with the server's client, and the office told (the request's
 * salesperson, else the owners, admins and office). The request itself isn't touched. Nothing on
 * the price list for it: no quote, and nothing to tell. Never throws: the request is in either way.
 */
export async function draftArrivedRequest(env: Env, companyId: string, requestId: string): Promise<Drafted | null> {
  const admin = adminClient(env);
  try {
    const { data: company } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
    if (!draftsNewRequests(company?.settings)) return null;
    const baseUrl = (env.APP_URL ?? "").replace(/\/$/, "");
    const drafted = await makeDraft({ db: admin, env, companyId, baseUrl }, requestId, null, true);
    if (!drafted) return null;
    const { data: request } = await admin.from("requests").select("number, assigned_to, client:clients(display_name)").eq("id", requestId).maybeSingle();
    const { data: people } = request?.assigned_to
      ? { data: [{ user_id: request.assigned_to }] }
      : await admin.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).in("role", ["owner", "admin", "office"]);
    const who = (request?.client as { display_name?: string } | null)?.display_name ?? "a client";
    const body = drafted.by === "claude"
      ? `AI drafted it from the request and your price list${drafted.check ? `. Check the quantity on ${drafted.check === 1 ? "1 line" : `${drafted.check} lines`}` : ""}. Look it over before you send it.`
      : "It was drafted from your price list. Look it over before you send it.";
    if (people?.length) {
      await admin.from("notifications").insert(people.map((p) => ({
        company_id: companyId, user_id: p.user_id, kind: "quote",
        title: `A draft quote is ready for request #${request?.number ?? ""} from ${who}`.slice(0, 300), body, link: `/quotes/${drafted.id}`,
      })));
    }
    return drafted;
  } catch (error) {
    reportError(error, { feature: "quote_draft", company: companyId, request: requestId });
    return null;
  }
}

/**
 * "Draft quotes with Claude" on or off. On checks the key with Claude first (a few words, counted
 * as an ask), and says what to fix when it fails; off needs no check. Only the server writes it.
 */
export async function setQuoteAi(env: Env, companyId: string, userId: string, on: boolean) {
  const admin = adminClient(env);
  if (on) {
    await countAiAsk(env, companyId, userId);
    try {
      await complete(env, { asker: { companyId, userId: null }, system: "Reply with the word OK.", prompt: "Are you there?", effort: "low", maxTokens: 20 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 501) throw new HttpError(400, "Add a Claude or OpenAI key on the Apps page first, then turn this on.");
      if (error instanceof HttpError) throw new HttpError(400, `The AI didn't answer, so this is still off. ${error.message}`);
      throw error;
    }
  }
  const { data, error } = await admin.rpc("set_quote_ai", { p_company: companyId, p_on: on, p_by: userId });
  if (error) throw new HttpError(500, error.message);
  return data as { on: boolean; checked_at: string };
}
