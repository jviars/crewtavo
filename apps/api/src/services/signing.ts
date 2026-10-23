/**
 * Signatures on estimates: each person's saved signature (one per business they work for), an
 * estimate the homeowner signs in person on the salesperson's iPad, the business's signature added
 * after (an estimate signed online, before anyone signed for the business), and the signed copy sent
 * to the client as a long-lived link to the Client Hub, which shows the signed document.
 *
 * Everything runs with the person's own client, so row-level security applies: only people who sell
 * (SALES with the sales area) change quotes, and a person only ever reads or writes their own saved
 * signature.
 */
import { pickTemplate } from "@crewtavo/core/documents";
import { z } from "zod";
import type { Env } from "../env";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { clientLink } from "../lib/links";
import { reportError } from "../lib/monitoring";
import { sendEmail, sendSms } from "../lib/notify";
import type { Db } from "../lib/supabase";
import { companyAddress } from "./automations";
import { logoImage } from "./logo";

/** Who's signing, where: the person's client, their company and user, and the address links use. */
export interface SigningScope {
  db: Db;
  env: Env;
  companyId: string;
  userId: string;
  baseUrl: string;
}

/** A drawn signature: a PNG data URL, as SignaturePad makes it (a few to a few hundred KB). */
export const signatureImage = z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

export const saveSignatureSchema = z.object({ image: signatureImage });

export const signSchema = z.object({
  /** The customer's printed name. */
  name: z.string().trim().min(2).max(120),
  signature: signatureImage,
  /** The salesperson's signature for the business, drawn now; else their saved one is used. */
  company_signature: signatureImage.optional(),
  save_signature: z.boolean().optional(),
  email_copy: z.boolean().optional(),
  /** Where to email the copy; the client's email when left out. */
  to: z.string().trim().max(200).optional(),
});
export type SignBody = z.infer<typeof signSchema>;

export const countersignSchema = z.object({ signature: signatureImage.optional(), save_signature: z.boolean().optional() });
export type CountersignBody = z.infer<typeof countersignSchema>;

export const copySchema = z.object({ channel: z.enum(["email", "sms"]), to: z.string().trim().max(200).optional() });
export type CopyBody = z.infer<typeof copySchema>;

/** Statuses a quote can be signed from, and the ones that mean it's signed. */
const OPEN = ["draft", "sent", "changes_requested"];
const SIGNED = ["approved", "converted"];
/** How long the link in the signed copy works: a year, so the client can find it again. */
const COPY_DAYS = 365;

const QUOTE_FIELDS =
  "id, number, status, title, client_id, template_id, salesperson_id, subtotal, discount_amount, tax_amount, total, approval, client:clients(display_name, email, phone), lines:quote_line_items(id, optional, selected)";

// ---------------------------------------------------------------------------------------------
// Saved signatures
// ---------------------------------------------------------------------------------------------

/** The person's saved signature in this business, or null. */
export async function savedSignature(db: Db, companyId: string, userId: string): Promise<string | null> {
  const { data, error } = await db.from("user_signatures").select("image").eq("company_id", companyId).eq("user_id", userId).maybeSingle();
  if (error) throw dbError(error);
  return data?.image ?? null;
}

export async function saveSignature(db: Db, companyId: string, userId: string, image: string): Promise<void> {
  const { error } = await db.from("user_signatures").upsert({ company_id: companyId, user_id: userId, image }, { onConflict: "company_id,user_id" });
  if (error) throw dbError(error);
}

export async function removeSignature(db: Db, companyId: string, userId: string): Promise<void> {
  const { error } = await db.from("user_signatures").delete().eq("company_id", companyId).eq("user_id", userId);
  if (error) throw dbError(error);
}

/** Keeps a signature drawn while signing for next time. Signing already worked, so a failure here only gets reported. */
async function keepSignature(s: SigningScope, image: string) {
  try {
    await saveSignature(s.db, s.companyId, s.userId, image);
  } catch (error) {
    console.error("Couldn't save the signature", error);
    reportError(error, { feature: "signatures" });
  }
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

async function loadQuote(s: SigningScope, id: string) {
  return must(await s.db.from("quotes").select(QUOTE_FIELDS).eq("id", id).eq("company_id", s.companyId).maybeSingle(), "We couldn't find that estimate. It may have been deleted.");
}

type Quote = Awaited<ReturnType<typeof loadQuote>>;

async function loadCompany(s: SigningScope) {
  return must(await s.db.from("companies").select("name, email, phone, address, settings").eq("id", s.companyId).maybeSingle(), "Company not found.");
}

type Company = Awaited<ReturnType<typeof loadCompany>>;

/** The signer's name as it prints under the business's line. */
async function signerName(s: SigningScope): Promise<string> {
  const { data, error } = await s.db.from("profiles").select("full_name").eq("user_id", s.userId).maybeSingle();
  if (error) throw dbError(error);
  return data?.full_name?.trim() ?? "";
}

/** Why a quote that isn't open can't be signed, in words. */
function notOpen(status: string): HttpError {
  if (SIGNED.includes(status)) return new HttpError(409, "This estimate was already signed.");
  const word = status === "lost" ? "marked lost" : status === "archived" ? "archived" : status;
  return new HttpError(409, `This estimate is ${word}, so it can't be signed. Reopen it as a draft first.`);
}

/**
 * The homeowner signs on the salesperson's iPad: the quote is approved with both signatures (the
 * business's drawn now or the salesperson's saved one), the salesperson becomes its salesperson if
 * it had none, and the client can be emailed a copy.
 */
export async function signQuote(s: SigningScope, id: string, body: SignBody) {
  const quote = await loadQuote(s, id);
  if (!OPEN.includes(quote.status)) throw notOpen(quote.status);
  const [company, templates, saved, signer] = await Promise.all([
    loadCompany(s),
    s.db.from("document_templates").select("id, is_default, settings").eq("company_id", s.companyId),
    savedSignature(s.db, s.companyId, s.userId),
    signerName(s),
  ]);
  if (templates.error) throw dbError(templates.error);
  const template = pickTemplate(templates.data ?? [], quote.template_id);
  const companySignature = body.company_signature ?? saved;
  if (!companySignature && template.company_signs) throw new HttpError(400, `Sign for ${company.name} too.`);

  const now = new Date().toISOString();
  const approval = {
    name: body.name,
    signature: body.signature,
    signed_at: now,
    method: "in_person" as const,
    selected_line_ids: (quote.lines ?? []).filter((l) => l.optional && l.selected).map((l) => l.id),
    company: companySignature ? { name: signer || company.name, user_id: s.userId, signature: companySignature, signed_at: now } : null,
    // The template as it was signed, so later changes to it (or another default) don't change the terms above the signatures.
    template,
    subtotal: Number(quote.subtotal),
    discount_amount: Number(quote.discount_amount),
    tax_amount: Number(quote.tax_amount),
    total: Number(quote.total),
  };
  // Only while it's still open: two people signing at once can't both win.
  const updated = await s.db
    .from("quotes")
    .update({ status: "approved", approved_at: now, salesperson_id: quote.salesperson_id ?? s.userId, approval: asJson(approval) })
    .eq("id", id)
    .eq("company_id", s.companyId)
    .in("status", OPEN)
    .select("id");
  if (updated.error) throw dbError(updated.error);
  if (!updated.data?.length) throw new HttpError(409, "This estimate was already signed.");
  if (body.save_signature && body.company_signature) await keepSignature(s, body.company_signature);

  const link = await clientLink(s.env, s.baseUrl, { c: s.companyId, t: "quote", id }, COPY_DAYS);
  if (!body.email_copy) return { status: "approved" as const, emailed: false, link };
  const copy = await deliverCopy(s, quote, company, link, { channel: "email", to: body.to });
  return { status: "approved" as const, emailed: copy.sent, ...(copy.sent ? {} : { email_reason: copy.reason }), link };
}

/** Signs for the business on a quote that's already signed (online, say), with a drawn or saved signature. */
export async function countersignQuote(s: SigningScope, id: string, body: CountersignBody) {
  const quote = await loadQuote(s, id);
  if (!SIGNED.includes(quote.status)) throw new HttpError(409, "This estimate isn't signed yet.");
  const company = await loadCompany(s);
  const approval = quote.approval && typeof quote.approval === "object" && !Array.isArray(quote.approval) ? (quote.approval as Record<string, unknown>) : {};
  if (approval.company) throw new HttpError(409, `This estimate was already signed for ${company.name}.`);
  const image = body.signature ?? (await savedSignature(s.db, s.companyId, s.userId));
  if (!image) throw new HttpError(400, "Draw your signature first.");
  const signer = await signerName(s);
  const merged = { ...approval, company: { name: signer || company.name, user_id: s.userId, signature: image, signed_at: new Date().toISOString() } };
  // Only while nobody has signed for the business yet (->> reads a missing key and a JSON null alike).
  const updated = await s.db
    .from("quotes")
    .update({ approval: asJson(merged) })
    .eq("id", id)
    .eq("company_id", s.companyId)
    .in("status", SIGNED)
    .is("approval->>company", null)
    .select("id");
  if (updated.error) throw dbError(updated.error);
  if (!updated.data?.length) throw new HttpError(409, `This estimate was already signed for ${company.name}.`);
  if (body.save_signature && body.signature) await keepSignature(s, body.signature);
  return { ok: true as const };
}

/** Emails or texts the client their signed estimate: a link that works for a year. */
export async function sendSignedCopy(s: SigningScope, id: string, body: CopyBody) {
  const quote = await loadQuote(s, id);
  if (!SIGNED.includes(quote.status)) throw new HttpError(409, "This estimate isn't signed yet.");
  const company = await loadCompany(s);
  const link = await clientLink(s.env, s.baseUrl, { c: s.companyId, t: "quote", id }, COPY_DAYS);
  const result = await deliverCopy(s, quote, company, link, body);
  return { sent: result.sent, ...(result.sent ? {} : { reason: result.reason }), link };
}

/**
 * The signed copy itself. Problems a person can fix (no email on file, email not set up) come back
 * as a reason instead of an error, so the estimate stays signed and the screen can say what to do.
 */
async function deliverCopy(s: SigningScope, quote: Quote, company: Company, link: string, body: CopyBody): Promise<{ sent: boolean; reason?: string }> {
  const client = quote.client as { display_name: string; email: string | null; phone: string | null } | null;
  const who = client?.display_name || "this client";
  const intro = `Here's your signed estimate from ${company.name}. You can view, print or save it any time:`;
  const text = `Hi ${firstName(client?.display_name)},\n\n${intro}\n\n${link}\n\nThanks,\n${company.name}`;
  const subject = `Your signed estimate from ${company.name}`;
  let result: { sent: boolean; reason?: string; id?: string };
  let sentText = text;
  try {
    if (body.channel === "email") {
      const to = body.to || client?.email;
      if (!to) return { sent: false, reason: `Add an email address for ${who} first.` };
      if (!isEmail(to)) return { sent: false, reason: "That email address doesn't look right." };
      const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
      result = await sendEmail(
        s.env,
        { to, subject, ...renderEmail({ companyName: company.name, logo: logoImage(s.baseUrl, s.companyId, company.settings), text, footer }), replyTo: company.email ?? undefined, fromName: company.name },
        s.companyId,
      );
    } else {
      const to = body.to || client?.phone;
      if (!to) return { sent: false, reason: `Add a phone number for ${who} first.` };
      sentText = `${company.name}: Here's your signed estimate. You can view, print or save it any time: ${link}`;
      result = await sendSms(s.env, { to, body: sentText });
    }
  } catch (error) {
    console.error("Couldn't send the signed copy", error);
    reportError(error, { feature: "signed copy" });
    return { sent: false, reason: "Couldn't send it just now. Try again in a minute." };
  }
  if (result.sent) {
    const logged = await s.db.from("messages").insert({
      company_id: s.companyId,
      client_id: quote.client_id,
      channel: body.channel,
      subject: body.channel === "email" ? subject : `Signed estimate #${quote.number}`,
      body: sentText,
      related_type: "quote",
      related_id: quote.id,
      external_id: result.id ?? null,
    });
    if (logged.error) console.error("Couldn't log the signed copy", logged.error);
  }
  return { sent: result.sent, reason: result.reason };
}
