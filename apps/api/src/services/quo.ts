/**
 * What Quo reports about a business's Quo number (its webhook, routes/quo.ts), filed where the
 * office reads it, and the same filing for what's brought in from Quo's history (services/quoImport.ts).
 *
 *   message.received     A text that came in: filed as Twilio's are (services/inboundTexts.ts),
 *                        STOP and START included, with its pictures kept in the client's files.
 *   message.delivered    A text the number sent. One Crewtavo sent (quo_sent, or a message with its
 *   message.failed       id) has its status brought up to date; any other was typed in the Quo app,
 *   message.undelivered  and goes on the timeline of the client it went to, marked as from Quo.
 *   call.completed       A call on the number, on the timeline of the client whose number called or
 *                        was called (messages, channel "call"): answered, missed, or a voicemail.
 *                        A missed call or voicemail from a number nobody knows waits under Unknown
 *                        numbers with the texts, as a new customer's often does.
 *   call.summary.completed, call.voicemail.completed
 *                        Quo's summary and next steps, and a voicemail's words, added to the call.
 *
 * Whose a number is goes by its last 10 digits, as for texts (services/textsOff.ts phoneKey): a
 * client's own phone, else a contact's (under at most CONTACT_CLIENTS clients).
 */
import { callBody, callLines, readCall, voicemailWords, type CallDetails } from "@crewtavo/core/calls";
import { asksToStopTexts, smsKeyword } from "@crewtavo/core/marketing";
import { phoneDisplay } from "@crewtavo/core/phone";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import type { Env } from "../env";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { QuoError, quoKeptMark, quoRequest, type QuoAccount } from "../lib/quo";
import type { Db } from "../lib/supabase";
import { receiveText, tellOffice, UNKNOWN_PER_COMPANY, UNKNOWN_PER_NUMBER } from "./inboundTexts";
import { lastDigits, phoneKey } from "./textsOff";

/** A contact's number kept under several clients files a text or call under this many of them at most. */
const CONTACT_CLIENTS = 5;
/** Pictures kept from one text, how large each may be, and how many a company keeps a day. */
const PICTURES_PER_TEXT = 5;
const PICTURE_BYTES = 10 * 1024 * 1024;
const PICTURES_PER_DAY = 300;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

type FetchLike = typeof fetch;

/** A delivery from Quo, as much of it as Crewtavo reads. */
export interface QuoEvent {
  id?: string;
  type?: string;
  createdAt?: string;
  data?: {
    resource?: Record<string, unknown>;
    context?: Record<string, unknown>;
  };
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
/** A phone number, not "anonymous" or a short code. */
const isPhone = (value: string | null | undefined): value is string => Boolean(value && /^\+[1-9][0-9]{6,14}$/.test(value));
const isoOr = (value: unknown, fallback: string) => {
  const s = str(value);
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : fallback;
};

// ---------------------------------------------------------------------------------------------
// Whose number
// ---------------------------------------------------------------------------------------------

/** Who a number is on a company's books: a client's own phone, or a contact's (whose name it is then). */
export interface Party {
  client_id: string;
  /** The client's name. */
  name: string;
  /** The contact's name when it's a contact's number rather than the client's own. */
  contact: string | null;
}

/** The clients a number is filed under: each client whose own phone it is, else the clients of the contacts it belongs to. */
export async function partiesFor(admin: Db, companyId: string, phone: string): Promise<Party[]> {
  const key = phoneKey(phone);
  if (key.length < 7) return [];
  const [{ data: clients, error: clientError }, { data: contacts, error: contactError }] = await Promise.all([
    admin.from("clients").select("id, display_name, phone").eq("company_id", companyId).not("phone", "is", null).filter("phone", "match", lastDigits(key)).limit(50),
    admin.from("client_contacts").select("client_id, name, phone, client:clients(display_name)").eq("company_id", companyId).not("phone", "is", null).filter("phone", "match", lastDigits(key)).limit(50),
  ]);
  if (clientError) throw new Error(`Couldn't read whose number it is: ${clientError.message}`);
  if (contactError) throw new Error(`Couldn't read whose number it is: ${contactError.message}`);
  const own = (clients ?? []).filter((c) => phoneKey(c.phone) === key).map((c) => ({ client_id: c.id, name: c.display_name, contact: null }));
  if (own.length) return own;
  const out: Party[] = [];
  for (const contact of contacts ?? []) {
    if (phoneKey(contact.phone) !== key || out.some((p) => p.client_id === contact.client_id)) continue;
    const client = contact.client as unknown as { display_name?: string } | null;
    out.push({ client_id: contact.client_id, name: client?.display_name ?? contact.name, contact: contact.name });
    if (out.length >= CONTACT_CLIENTS) break;
  }
  return out;
}

/** Who a number is, by its number: partiesFor, or a copy that remembers (an import asks about the same numbers often). */
export type Resolve = (phone: string) => Promise<Party[]>;

/** partiesFor, remembering each number's answer: for bringing in history, where one number comes up again and again. */
export function rememberingParties(admin: Db, companyId: string): Resolve {
  const known = new Map<string, Promise<Party[]>>();
  return (phone) => {
    const key = phoneKey(phone);
    let found = known.get(key);
    if (!found) {
      found = partiesFor(admin, companyId, phone);
      known.set(key, found);
    }
    return found;
  };
}

/** The contact's name for a contact's number, else the client's. */
const partyName = (party: Party) => party.contact ?? party.name;

// ---------------------------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------------------------

/** The words kept for a text: what it says, or that it was pictures. */
export function textWords(text: string | null, pictures: number): string {
  const words = (text ?? "").slice(0, 10_000);
  if (words.trim()) return words;
  if (!pictures) return "";
  return pictures === 1 ? "Sent a picture." : `Sent ${pictures} pictures.`;
}

/**
 * A text that came in to the number: filed as Twilio's are, once (a delivery Quo tries again after
 * it was filed isn't filed twice), then its pictures kept, after Quo has its answer (`later`).
 * Returns the companies whose automations should look.
 */
async function textCameIn(env: Env, admin: Db, account: QuoAccount, event: QuoEvent, fetcher: FetchLike, later: (work: Promise<unknown>) => void): Promise<string[]> {
  const r = event.data?.resource ?? {};
  const ctx = event.data?.context ?? {};
  const from = str(ctx.senderIdentifier);
  const id = str(r.id);
  if (!isPhone(from) || !id) return [];
  const text = str(r.text) ?? "";
  const media = Array.isArray(r.media) ? (r.media as Array<{ url?: unknown; type?: unknown }>) : [];
  const body = textWords(text, media.length);
  if (!body) return [];
  const [{ data: filed, error }, { data: waiting, error: waitingError }] = await Promise.all([
    admin.from("messages").select("id").eq("company_id", account.companyId).eq("external_id", id).eq("channel", "sms").limit(1),
    admin.from("unknown_texts").select("id").eq("company_id", account.companyId).eq("external_id", id).limit(1),
  ]);
  if (error || waitingError) throw new Error(`Couldn't read whether a text was filed: ${(error ?? waitingError)!.message}`);
  if (filed?.length || waiting?.length) return [];
  // STOP or START by the words: Quo keeps the number's opt-out itself, and refuses to text it (lib/notify.ts).
  const word = smsKeyword(text);
  const phrase = !word && asksToStopTexts(text);
  const touched = await receiveText(admin, { from, body, sid: id, keyword: phrase ? "stop" : word, phrase }, [account.companyId]);
  if (media.length) later(keepPictures(env, admin, account.companyId, id, media, fetcher).catch((error) => reportError(error, { feature: "quo-pictures" })));
  return touched;
}

/**
 * A text's pictures, kept in the files of the client (or clients) it was filed under, with a
 * caption saying who texted it and when. Only pictures, a few at most, and within a day's share; a
 * text from a number nobody knows keeps its words only.
 */
async function keepPictures(env: Env, admin: Db, companyId: string, messageId: string, media: Array<{ url?: unknown; type?: unknown }>, fetcher: FetchLike) {
  const { data: rows } = await admin.from("messages").select("client_id, from_name, created_at").eq("company_id", companyId).eq("external_id", messageId).eq("channel", "sms").limit(CONTACT_CLIENTS);
  if (!rows?.length) return;
  const { data: names } = await admin.from("clients").select("id, display_name").eq("company_id", companyId).in("id", rows.map((r) => r.client_id!));
  let n = 0;
  for (const item of media.slice(0, PICTURES_PER_TEXT)) {
    const url = str(item.url);
    if (!url || !/^https:\/\//.test(url)) continue;
    if (!(await allow(env, `quo-pictures:${companyId}`, PICTURES_PER_DAY, DAY_MS / 1000))) return;
    const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!res?.ok) continue;
    const type = (res.headers.get("content-type") ?? str(item.type) ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" }[type];
    if (!ext) continue;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > PICTURE_BYTES) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > PICTURE_BYTES) continue;
    n++;
    for (const row of rows) {
      const path = `${companyId}/client/${row.client_id}/text-${messageId.replace(/[^A-Za-z0-9_-]/g, "")}-${n}.${ext}`;
      const { error } = await admin.storage.from("files").upload(path, bytes, { contentType: type, upsert: true });
      if (error) throw new Error(`Couldn't keep a texted picture: ${error.message}`);
      const who = row.from_name ?? names?.find((c) => c.id === row.client_id)?.display_name ?? "the client";
      const day = row.created_at.slice(0, 10);
      const { error: rowError } = await admin.from("attachments").insert({
        company_id: companyId, owner_type: "client", owner_id: row.client_id!, path, file_name: `Texted picture ${day}${n > 1 ? ` (${n})` : ""}.${ext}`,
        content_type: type, size_bytes: bytes.length, caption: `Texted by ${who}`, created_by: null,
      });
      if (rowError) {
        await admin.storage.from("files").remove([path]);
        throw new Error(`Couldn't keep a texted picture: ${rowError.message}`);
      }
    }
  }
}

/** A text the number sent, as Quo reports or lists it. */
export interface SentText {
  id: string;
  /** Who it went to (E.164), the number's own left out. */
  to: string[];
  body: string;
  createdAt: string;
  status: "delivered" | "failed" | "sent";
}

/**
 * Files a text the number sent that Crewtavo didn't send (typed in the Quo app, or from Quo's
 * history), on the timeline of each client it went to, once. `origin` says which.
 */
export async function fileSentText(admin: Db, companyId: string, text: SentText, origin: "quo" | "quo_import", resolve: Resolve = (phone) => partiesFor(admin, companyId, phone)): Promise<number> {
  let filed = 0;
  for (const to of text.to.filter(isPhone).slice(0, 10)) {
    const parties = await resolve(to);
    if (!parties.length) continue;
    const { data: already, error: lookError } = await admin.from("messages").select("client_id").eq("company_id", companyId).eq("external_id", text.id).in("client_id", parties.map((p) => p.client_id));
    if (lookError) throw new Error(`Couldn't check whether a Quo text is already here: ${lookError.message}`);
    for (const party of parties) {
      if (already?.some((row) => row.client_id === party.client_id)) continue;
      const { error } = await admin.from("messages").insert({
        company_id: companyId, client_id: party.client_id, channel: "sms", direction: "out", status: text.status, body: text.body,
        external_id: text.id, sent_by: null, created_at: text.createdAt, origin,
        recipients: [{ to, name: partyName(party), ...(text.status === "failed" ? { failed: true } : {}) }],
      });
      if (error) throw new Error(`Couldn't file a text sent from Quo: ${error.message}`);
      filed++;
    }
  }
  return filed;
}

/**
 * A text the number sent reached its end: delivered, or not. One Crewtavo sent has its status
 * brought up to date; any other was typed in the Quo app and is filed. A report can beat
 * Crewtavo's own note that it sent the text by a moment, so a fresh one is looked at twice. One
 * Crewtavo sent and keeps no message for (a sign-in code, a notice to the team) is let go at once.
 */
async function textWentOut(admin: Db, account: QuoAccount, event: QuoEvent, wait: (ms: number) => Promise<unknown>): Promise<void> {
  const r = event.data?.resource ?? {};
  const ctx = event.data?.context ?? {};
  const id = str(r.id);
  if (!id) return;
  const failed = event.type !== "message.delivered";
  const ours = async () => {
    const mark = quoKeptMark(id);
    const [sent, byId, byRecipient] = await Promise.all([
      admin.from("quo_sent").select("message_id").eq("company_id", account.companyId).in("message_id", mark ? [id, mark] : [id]),
      admin.from("messages").select("id, status, recipients").eq("company_id", account.companyId).eq("external_id", id).eq("channel", "sms").limit(10),
      // A text to several people keeps each one's Quo id on that recipient (services/recipients.ts). As JSON
      // text: given an array, the client writes a Postgres array ({...}), which a jsonb column refuses.
      admin.from("messages").select("id, status, recipients").eq("company_id", account.companyId).eq("channel", "sms").contains("recipients", JSON.stringify([{ id }])).limit(10),
    ]);
    // Unread isn't "not ours": it would be filed again as typed in Quo.
    const error = sent.error ?? byId.error ?? byRecipient.error;
    if (error) throw new Error(`Couldn't look up the text Quo reported on: ${error.message}`);
    const kept = [...(byId.data ?? []), ...(byRecipient.data ?? []).filter((row) => !byId.data?.some((k) => k.id === row.id))];
    const noted = (sent.data ?? []).map((row) => row.message_id);
    // `awaited`: its sender saves a message with this id (quoKeptMark), so there's one to wait for.
    return { sent: noted.includes(id), awaited: mark !== null && noted.includes(mark), kept };
  };
  let found = await ours();
  // Crewtavo saves its message once everyone is texted, and notes the text as its own just after Quo
  // takes it: a report can come first. Wait a moment; if a message is coming and still isn't saved,
  // Quo sends the report again. Not for a text of Crewtavo's that nobody keeps a message for: there's
  // nothing to wait for, and nothing for Quo to try again.
  const fresh = Date.now() - Date.parse(isoOr(r.createdAt, new Date(0).toISOString())) < 60_000;
  if (!found.kept.length && fresh && (found.awaited || !found.sent)) {
    await wait(3000);
    found = await ours();
    if (found.awaited && !found.kept.length) throw new Error("Quo reported on a text Crewtavo hasn't saved yet. Quo will send the report again.");
  }
  if (found.kept.length) {
    for (const row of found.kept) {
      const list = Array.isArray(row.recipients) ? (row.recipients as Array<Record<string, unknown>>) : null;
      // The report is about one person's text when each person's id was kept; otherwise about the whole send.
      const each = Boolean(list?.some((p) => p.id));
      let update: { status: string; recipients?: typeof row.recipients } | null = null;
      if (failed) {
        const recipients = list?.map((p) => (!each || p.id === id ? { ...p, failed: true } : p));
        update = { status: !recipients || recipients.every((p) => p.failed) ? "failed" : row.status, ...(recipients ? { recipients: recipients as typeof row.recipients } : {}) };
      } else if (row.status === "sent" || row.status === "queued") {
        update = { status: "delivered" };
      }
      if (!update) continue;
      const { error } = await admin.from("messages").update(update).eq("id", row.id);
      if (error) throw new Error(`Couldn't note what Quo said about a text: ${error.message}`);
    }
    return;
  }
  if (found.sent) return;
  const own = account.settings.from_number;
  const to = strings(ctx.recipientIdentifiers).filter((n) => n !== own);
  const media = Array.isArray(r.media) ? r.media.length : 0;
  const body = textWords(str(r.text), media);
  if (!body) return;
  await fileSentText(admin, account.companyId, { id, to, body, createdAt: isoOr(r.createdAt, isoOr(event.createdAt, new Date().toISOString())), status: failed ? "failed" : "delivered" }, "quo");
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** A call on the number, from Quo's webhook or its list of calls. */
export interface CallInfo {
  id: string;
  direction: "in" | "out";
  createdAt: string;
  /** Someone picked up (for a call out, possibly the other phone's voicemail). */
  answered: boolean;
  /** Quo's AI agent took it, not someone at the business: the office still has to follow up. */
  ai: boolean;
  seconds: number | null;
  /** The other phone, in E.164, when there's one. */
  other: string | null;
  /** They left a voicemail (its words and length once Quo has them). */
  voicemail: { words: string | null; seconds: number | null } | null;
  /** Quo's summary, once it's ready. */
  summary: { lines: string[]; steps: string[] } | null;
}

/** A call as Quo's API lists it (GET /calls?include=summary,voicemail). */
export interface QuoApiCall {
  id?: string;
  direction?: string;
  status?: string;
  createdAt?: string;
  answeredAt?: string | null;
  duration?: number | null;
  aiHandled?: string | null;
  participants?: Array<{ phoneNumber?: string | null; actorId?: string | null }>;
  summary?: { status?: string; summary?: string[] | null; nextSteps?: string[] | null } | null;
  voicemail?: { status?: string; duration?: number | null; transcript?: string | null } | null;
}

/**
 * A call from Quo's API in the shape it's filed in. Null for one that isn't over, or has no id.
 * The other phone is a party that isn't someone in the workspace (no actorId): a call passed to
 * a teammate's line isn't filed under that line.
 */
export function callFromApi(call: QuoApiCall, own: string): CallInfo | null {
  if (!call.id || ["queued", "initiated", "ringing", "in-progress"].includes(call.status ?? "")) return null;
  const other = (call.participants ?? []).filter((p) => !p.actorId).map((p) => p.phoneNumber ?? null).find((n) => isPhone(n) && n !== own) ?? null;
  return {
    id: call.id,
    direction: call.direction === "outgoing" ? "out" : "in",
    createdAt: isoOr(call.createdAt, new Date().toISOString()),
    answered: Boolean(call.answeredAt) || call.status === "answered",
    ai: Boolean(call.aiHandled),
    seconds: num(call.duration),
    other,
    voicemail: call.voicemail ? { words: voicemailWords(call.voicemail.transcript), seconds: num(call.voicemail.duration) } : null,
    summary: call.summary?.status === "completed" ? { lines: callLines(call.summary.summary), steps: callLines(call.summary.nextSteps) } : null,
  };
}

/** call.completed, in the shape it's filed in. */
function callFromEvent(event: QuoEvent, own: string): CallInfo | null {
  const r = event.data?.resource ?? {};
  const ctx = event.data?.context ?? {};
  const id = str(r.id);
  if (!id) return null;
  const participants = (ctx.participants ?? {}) as { external?: unknown; workspace?: unknown };
  const workspace = strings(participants.workspace);
  const status = str(r.status);
  return {
    id,
    direction: r.direction === "outgoing" ? "out" : "in",
    createdAt: isoOr(r.createdAt, isoOr(event.createdAt, new Date().toISOString())),
    answered: Boolean(str(r.answeredAt)) || status === "answered" || status === "ai-handled",
    ai: status === "ai-handled",
    seconds: num(r.duration),
    other: strings(participants.external).find((n) => isPhone(n) && n !== own && !workspace.includes(n)) ?? null,
    voicemail: r.hasVoicemail === true ? { words: null, seconds: null } : null,
    summary: null,
  };
}

/** What's kept about a call, from what's known now and what was kept before. */
export function callDetails(call: CallInfo, before: CallDetails | null = null): CallDetails {
  const voicemail = call.voicemail ?? (before?.outcome === "voicemail" ? { words: before.voicemail ?? null, seconds: before.seconds } : null);
  const outcome = voicemail ? "voicemail" : call.answered || before?.outcome === "answered" ? "answered" : "missed";
  const summary = call.summary?.lines.length ? call.summary.lines : (before?.summary ?? []);
  const steps = call.summary?.steps.length ? call.summary.steps : (before?.next_steps ?? []);
  return {
    outcome,
    seconds: (outcome === "voicemail" ? (voicemail?.seconds ?? null) : null) ?? call.seconds ?? before?.seconds ?? null,
    ...(summary.length ? { summary } : {}),
    ...(steps.length ? { next_steps: steps } : {}),
    ...(voicemail?.words || before?.voicemail ? { voicemail: voicemail?.words || before?.voicemail || null } : {}),
    quo_id: call.id,
  };
}

/** What a report adds to a call already filed: only what it knows (a summary, a voicemail), over what was kept. */
const adding = (id: string, more: Partial<Pick<CallInfo, "voicemail" | "summary">>) => (before: CallDetails | null): CallDetails =>
  callDetails(
    { id, direction: "in", createdAt: "", answered: before?.outcome === "answered", ai: false, seconds: before?.seconds ?? null, other: null, voicemail: more.voicemail ?? null, summary: more.summary ?? null },
    before,
  );

type CallTable = "messages" | "unknown_texts";

/**
 * Changes a filed call's details (and its words) by `change`, without losing what another of the
 * call's reports added at the same moment: each write says which version it changed (call.rev),
 * and one that lost the race reads the call again and tries again.
 */
async function changeCall(admin: Db, table: CallTable, id: string, direction: string, change: (before: CallDetails | null) => CallDetails): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row, error } = await admin.from(table).select("call").eq("id", id).maybeSingle();
    if (error) throw new Error(`Couldn't read a call: ${error.message}`);
    if (!row) return;
    const kept = (row.call ?? null) as { rev?: unknown } | null;
    const rev = typeof kept?.rev === "number" ? kept.rev : 0;
    const details = change(readCall(row.call));
    const write = admin.from(table).update({ call: { ...details, rev: rev + 1 } as unknown as never, body: callBody(direction, details) }).eq("id", id);
    const { data: done, error: writeError } = await (rev ? write.filter("call->>rev", "eq", String(rev)) : write.filter("call->>rev", "is", null)).select("id");
    if (writeError) throw new Error(`Couldn't add to a call: ${writeError.message}`);
    if (done?.length) return;
  }
  throw new Error("Couldn't add to a call: it kept changing.");
}

/** Changes the call wherever it's filed (each client's timeline, or Unknown numbers). True when it was filed. */
async function changeFiledCall(admin: Db, companyId: string, id: string, change: (before: CallDetails | null) => CallDetails): Promise<boolean> {
  const [{ data: rows, error }, { data: waiting, error: waitingError }] = await Promise.all([
    admin.from("messages").select("id, direction").eq("company_id", companyId).eq("external_id", id).eq("channel", "call").limit(CONTACT_CLIENTS),
    admin.from("unknown_texts").select("id").eq("company_id", companyId).eq("external_id", id).eq("channel", "call").limit(1),
  ]);
  if (error || waitingError) throw new Error(`Couldn't read a call: ${(error ?? waitingError)!.message}`);
  if (!rows?.length && !waiting?.length) return false;
  for (const row of rows ?? []) await changeCall(admin, "messages", row.id, row.direction, change);
  for (const row of waiting ?? []) await changeCall(admin, "unknown_texts", row.id, "in", change);
  return true;
}

/** What happened to filing a call. */
export type CallFiled = "filed" | "updated" | "unknown" | "skipped";

/**
 * Files a call on the timeline of each client whose number it was, once (messages_call_once):
 * one already filed has what's new added to it. A call in from a number nobody knows waits under
 * Unknown numbers (within the same daily share as texts), unless it's from history. `notify`
 * tells the office about a missed call, a voicemail or a call Quo's AI agent took, as about a text.
 */
export async function fileCall(admin: Db, companyId: string, call: CallInfo, options: { origin: "quo" | "quo_import"; notify: boolean; resolve?: Resolve }): Promise<CallFiled> {
  if (await changeFiledCall(admin, companyId, call.id, (before) => callDetails(call, before))) return "updated";
  if (!call.other) return "skipped";
  const details = callDetails(call);
  const body = callBody(call.direction, details);
  const parties = await (options.resolve ?? ((phone: string) => partiesFor(admin, companyId, phone)))(call.other);
  if (!parties.length) {
    // From history, a number nobody knows stays in Quo, as its texts do: months-old missed calls aren't leads to answer today.
    if (call.direction !== "in" || options.origin === "quo_import") return "skipped";
    return (await keepUnknownCall(admin, companyId, call, details, body, options.notify)) ? "unknown" : "skipped";
  }
  for (const party of parties) {
    const { error } = await admin.from("messages").insert({
      company_id: companyId, client_id: party.client_id, channel: "call", direction: call.direction, status: call.direction === "in" ? "received" : "sent",
      body, external_id: call.id, sent_by: null, created_at: call.createdAt, origin: options.origin, call: details as unknown as never,
      ...(call.direction === "in" ? { from_phone: call.other, ...(party.contact ? { from_name: party.contact.slice(0, 200) } : {}) } : { recipients: [{ to: call.other, name: partyName(party) }] }),
    });
    // Filed a moment ago by another of the call's reports: add to that one instead.
    if (error?.code === "23505") {
      await changeFiledCall(admin, companyId, call.id, (before) => callDetails(call, before));
      continue;
    }
    if (error) throw new Error(`Couldn't file a call: ${error.message}`);
    if (!options.notify || call.direction !== "in") continue;
    const who = partyName(party);
    if (details.outcome === "answered" && !call.ai) {
      // Answered: the office spoke with them, so nothing waits on a reply (when the call is the latest).
      await markDoneAfterCall(admin, companyId, party.client_id, call.id);
    } else {
      await tellOffice(admin, companyId, {
        title: details.outcome === "voicemail" ? `Voicemail from ${who}` : details.outcome === "answered" ? `Quo's AI agent took a call from ${who}` : `Missed call from ${who}`,
        body: details.outcome === "voicemail"
          ? "They left a voicemail. Its words show on their timeline once Quo has them."
          : details.outcome === "answered" ? "Nobody at the business spoke with them. Quo's summary shows on their timeline once it's ready." : "They called your Quo number and nobody answered.",
        link: `/messages?client=${party.client_id}`,
      });
    }
  }
  return "filed";
}

/** A call from a number nobody knows, kept under Unknown numbers. False when the day's share is used. */
async function keepUnknownCall(admin: Db, companyId: string, call: CallInfo, details: CallDetails, body: string, notify: boolean): Promise<boolean> {
  const key = phoneMatchKey(call.other);
  if (!key || !call.other) return false;
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  const count = async (sinceMs: number, number: boolean) => {
    let rows = admin.from("unknown_texts").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("created_at", since(sinceMs));
    if (number) rows = rows.eq("phone_key", key);
    const { count: found, error } = await rows;
    if (error) throw new Error(`Couldn't count texts from unknown numbers: ${error.message}`);
    return found ?? 0;
  };
  const [today, lastHour, everyone] = await Promise.all([count(DAY_MS, true), count(HOUR_MS, true), count(DAY_MS, false)]);
  if (today >= UNKNOWN_PER_NUMBER || everyone >= UNKNOWN_PER_COMPANY) return false;
  const { error } = await admin.from("unknown_texts").insert({
    company_id: companyId, from_phone: call.other.slice(0, 40), phone_key: key, body, external_id: call.id, channel: "call", call: details as unknown as never, created_at: call.createdAt,
  });
  // Kept a moment ago by another of the call's reports: what this one knows is added to it.
  if (error?.code === "23505") {
    await changeFiledCall(admin, companyId, call.id, (before) => callDetails(call, before));
    return true;
  }
  if (error) throw new Error(`Couldn't keep a call from an unknown number: ${error.message}`);
  if (notify && !lastHour && (details.outcome !== "answered" || call.ai)) {
    await tellOffice(admin, companyId, {
      title: details.outcome === "voicemail" ? "Voicemail from an unknown number" : details.outcome === "answered" ? "Quo's AI agent took a call from an unknown number" : "Missed call from an unknown number",
      body: `${phoneDisplay(call.other)} called your Quo number.`,
      link: `/messages?unknown=${key}`,
    });
  }
  return true;
}

/** After an answered call in, the client's conversation waits on nobody, when the call is their latest message. */
async function markDoneAfterCall(admin: Db, companyId: string, clientId: string, callId: string) {
  const { data: latest } = await admin.from("messages").select("external_id").eq("company_id", companyId).eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (latest?.external_id !== callId) return;
  const { error } = await admin.from("conversations_done").upsert({ client_id: clientId, company_id: companyId });
  if (error) console.warn(`Couldn't mark a conversation done after a call: ${error.message}`);
}

/** Quo's call by its id, with its summary and voicemail, in the shape it's filed in. */
export async function fetchCall(env: Env, account: QuoAccount, id: string, fetcher: FetchLike = fetch): Promise<CallInfo | null> {
  try {
    const got = await quoRequest<{ data?: QuoApiCall }>(env, account.key, `/calls/${encodeURIComponent(id)}`, { query: { include: "summary,voicemail" } }, fetcher);
    return got?.data ? callFromApi(got.data, account.settings.from_number) : null;
  } catch (error) {
    // A call Quo won't show (gone, or not this key's to see) isn't worth a day of retries: the report's own details stand.
    if (error instanceof QuoError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

/**
 * call.summary.completed and call.voicemail.completed: added to the call, which is fetched from
 * Quo when it isn't filed yet (its report can come last). Only a client's call is filed that way:
 * a call from a number nobody knows that isn't under Unknown numbers was deleted there, or is
 * filed by its own report, and isn't brought back by its voicemail.
 */
async function callNews(env: Env, admin: Db, account: QuoAccount, event: QuoEvent, fetcher: FetchLike) {
  const r = event.data?.resource ?? {};
  const callId = str(r.callId);
  if (!callId) return;
  let more: Partial<Pick<CallInfo, "voicemail" | "summary">>;
  if (event.type === "call.summary.completed") {
    if (r.processingStatus !== "completed") return;
    more = { summary: { lines: callLines(r.summary), steps: callLines(r.nextSteps) } };
  } else {
    more = { voicemail: { words: voicemailWords(r.transcript), seconds: num(r.duration) } };
  }
  if (await changeFiledCall(admin, account.companyId, callId, adding(callId, more))) return;
  const call = await fetchCall(env, account, callId, fetcher);
  if (!call?.other || !(await partiesFor(admin, account.companyId, call.other)).length) return;
  await fileCall(admin, account.companyId, {
    ...call,
    ...(more.summary ? { summary: more.summary } : {}),
    ...(more.voicemail ? { voicemail: { words: more.voicemail.words ?? call.voicemail?.words ?? null, seconds: more.voicemail.seconds ?? call.voicemail?.seconds ?? null } } : {}),
  }, { origin: "quo", notify: true });
}

// ---------------------------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------------------------

/**
 * One of Quo's deliveries, already checked as Quo's and not seen before (routes/quo.ts). Only the
 * company's own number's events count: Quo's test events and other numbers' are let go. Returns
 * the companies whose automations should look at it.
 */
export async function handleQuoEvent(
  env: Env,
  admin: Db,
  account: QuoAccount,
  event: QuoEvent,
  options: { fetcher?: FetchLike; wait?: (ms: number) => Promise<unknown>; later?: (work: Promise<unknown>) => void } = {},
): Promise<string[]> {
  const fetcher = options.fetcher ?? fetch;
  const later = options.later ?? ((work: Promise<unknown>) => void work);
  const wait = options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ctx = event.data?.context ?? {};
  if (str(ctx.phoneNumberId) !== account.settings.phone_number_id) return [];
  switch (event.type) {
    case "message.received":
      return textCameIn(env, admin, account, event, fetcher, later);
    case "message.delivered":
    case "message.failed":
    case "message.undelivered":
      await textWentOut(admin, account, event, wait);
      return [];
    case "call.completed": {
      if (account.settings.calls === false) return [];
      let call = callFromEvent(event, account.settings.from_number);
      // Quo couldn't say who was on the call ("unavailable"): its own record of the call can.
      if (call && !call.other) call = (await fetchCall(env, account, call.id, fetcher)) ?? call;
      if (call) await fileCall(admin, account.companyId, call, { origin: "quo", notify: true });
      return [];
    }
    case "call.summary.completed":
    case "call.voicemail.completed":
      if (account.settings.calls === false) return [];
      await callNews(env, admin, account, event, fetcher);
      return [];
    default:
      return [];
  }
}
