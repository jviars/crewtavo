/**
 * A business's Quo number (lib/quo.ts, routes/quo.ts, services/quo.ts, services/quoImport.ts):
 * Quo's webhook signatures are checked the Standard Webhooks way, texts go out through Quo with
 * its refusals said as Crewtavo reads them, each of Quo's deliveries is filed once where the office
 * reads it (replies, texts sent from the Quo app, calls with their summaries and voicemails), the
 * Apps page connects and changes it, and past texts and calls come in. Quo is a stand-in that
 * answers as its 2026-03-30 API is documented; the database is quoDb.ts.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { decryptJson, encryptJson } from "../src/lib/crypto";
import { sendSms } from "../src/lib/notify";
import { companyQuo, forgetQuo, quoRequest, verifyQuoWebhook, type QuoSettings } from "../src/lib/quo";
import { callFromApi, handleQuoEvent } from "../src/services/quo";
import { forgetTwilio } from "../src/lib/twilio";
import { beginQuoImport, importFromQuo } from "../src/services/quoImport";
import { memoryDb, type MemoryDb, type Row } from "./quoDb";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://crew.example.com",
};
const CO = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const PN = "PNmain123";
const OWN = "+15405550000";
const ANA = "+15405550163";
const KEY = "quo-key-123";
const HOOK_KEY = `whsec_${Buffer.from("a signing key of thirty-two bytes!").toString("base64")}`;
const headers = { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" };

// ---------------------------------------------------------------------------------------------
// Quo, as it answers
// ---------------------------------------------------------------------------------------------

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

function fakeQuo(answers: Partial<Record<string, (req: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> } | Response>> = {}) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const req: Seen = { method: init.method ?? "GET", url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : null };
    seen.push(req);
    const route = `${req.method} ${url.hostname === "api.quo.com" ? url.pathname : url.href}`;
    const answer = answers[route] ?? Object.entries(answers).find(([k]) => k.endsWith("*") && route.startsWith(k.slice(0, -1)))?.[1];
    if (!answer) return new Response(JSON.stringify({ title: "Not Found", message: `No stand-in for ${route}` }), { status: 404 });
    const out = answer(req);
    if (out instanceof Response) return out;
    return new Response(out.status === 204 ? null : JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { "Content-Type": "application/json", ...(out.headers ?? {}) } });
  });
  return { fetcher, seen };
}

const NUMBERS = { "GET /phone-numbers": () => ({ body: { data: [{ id: PN, name: "Main line", phoneNumber: OWN }, { id: "PNother", name: "", phoneNumber: "+15405550001" }], nextCursor: null } }) };

// ---------------------------------------------------------------------------------------------
// The business
// ---------------------------------------------------------------------------------------------

async function connectedDb(settings: Partial<QuoSettings> = {}, extra: Record<string, Row[]> = {}): Promise<MemoryDb> {
  const db = memoryDb(
    {
      memberships: [{ company_id: CO, user_id: OWNER, role: "owner", role_id: null, subcontractor_id: null, active: true }],
      companies: [{ id: CO, country: "US", name: "Alder Painting", settings: {} }, { id: OTHER, country: "US", name: "Birch", settings: {} }],
      clients: [
        { id: "client-ana", company_id: CO, phone: "(540) 555-0163", display_name: "Ana Alvarez" },
        { id: "client-bo", company_id: CO, phone: "540-555-0177", display_name: "Bo Brown" },
        { id: "client-other", company_id: OTHER, phone: "(540) 555-0163", display_name: "Ana at Birch" },
      ],
      client_contacts: [{ id: "contact-sam", company_id: CO, client_id: "client-bo", name: "Sam Brown", phone: "+1 540 555 0188" }],
      integrations: [
        {
          company_id: CO, provider: "quo", status: "connected", external_account_id: PN, account_label: "Main line",
          settings: { phone_number_id: PN, from_number: OWN, number_name: "Main line", webhook_id: "77", webhook_url: `https://crew.example.com/api/webhooks/quo/${CO}`, ...settings },
        },
      ],
      integration_secrets: [{ company_id: CO, provider: "quo", ciphertext: await encryptJson(env, { api_key: KEY, extra: { webhook_key: HOOK_KEY } }) }],
      ...extra,
    },
    { [OWNER]: "owner@alder.example" },
  );
  current.db = db.db;
  return db;
}

/** A delivery from Quo, signed with the webhook's key unless told otherwise. */
async function deliver(event: Record<string, unknown>, options: { id?: string; key?: string; company?: string; at?: number } = {}) {
  const body = JSON.stringify(event);
  const id = options.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  const key = options.key ?? HOOK_KEY;
  const signature = createHmac("sha256", Buffer.from(key.slice("whsec_".length), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return app.request(`/api/webhooks/quo/${options.company ?? CO}`, { method: "POST", headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}`, "Content-Type": "application/json" }, body }, env);
}

const messageEvent = (type: string, resource: Record<string, unknown>, context: Record<string, unknown>) => ({
  id: "EV1", apiVersion: "2026-03-30", createdAt: new Date().toISOString(), type,
  data: { resource: { media: [], createdAt: new Date().toISOString(), ...resource }, context: { orgId: "OR1", phoneNumberId: PN, conversationId: "CN1", userId: "US1", ...context }, links: { quo: null } },
});
const callContext = (external: string) => ({ phoneNumberId: PN, participants: { workspace: [OWN], external: [external], resolution: "available" } });

beforeEach(() => {
  forgetQuo();
  forgetTwilio();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("Quo's webhook signatures", () => {
  const body = '{"type":"message.received"}';
  const sign = (key: string, id: string, ts: string, text: string) => createHmac("sha256", Buffer.from(key.slice(6), "base64")).update(`${id}.${ts}.${text}`).digest("base64");
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);

  it("takes a delivery signed with the webhook's key, among other signatures", async () => {
    const good = sign(HOOK_KEY, "msg_1", ts, body);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "msg_1", timestamp: ts, signature: `v2,abc v1,${btoa("nope")} v1,${good}` }, body, now)).toBe(true);
  });

  it("refuses another key, another body, another id, and anything missing", async () => {
    const good = sign(HOOK_KEY, "msg_1", ts, body);
    const other = `whsec_${Buffer.from("another key altogether, 32 bytes").toString("base64")}`;
    expect(await verifyQuoWebhook(other, { id: "msg_1", timestamp: ts, signature: `v1,${good}` }, body, now)).toBe(false);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "msg_1", timestamp: ts, signature: `v1,${good}` }, `${body} `, now)).toBe(false);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "msg_2", timestamp: ts, signature: `v1,${good}` }, body, now)).toBe(false);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "msg_1", timestamp: ts, signature: null }, body, now)).toBe(false);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "msg_1", timestamp: ts, signature: `v2,${good}` }, body, now)).toBe(false);
  });

  it("refuses a delivery signed more than five minutes before or after now", async () => {
    const old = String(now / 1000 - 301);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "m", timestamp: old, signature: `v1,${sign(HOOK_KEY, "m", old, body)}` }, body, now)).toBe(false);
    const ahead = String(now / 1000 + 301);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "m", timestamp: ahead, signature: `v1,${sign(HOOK_KEY, "m", ahead, body)}` }, body, now)).toBe(false);
    const fine = String(now / 1000 - 299);
    expect(await verifyQuoWebhook(HOOK_KEY, { id: "m", timestamp: fine, signature: `v1,${sign(HOOK_KEY, "m", fine, body)}` }, body, now)).toBe(true);
  });
});

describe("Quo's API", () => {
  it("sends the bare key and the version, and tries a read again after Quo's rate limit", async () => {
    let tries = 0;
    const { fetcher, seen } = fakeQuo({ "GET /users": () => (++tries === 1 ? { status: 429, body: { title: "Too Many Requests" } } : { body: { data: [] } }) });
    await quoRequest(env, KEY, "/users", {}, fetcher as unknown as typeof fetch);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers.authorization).toBe(KEY);
    expect(seen[0]!.headers["quo-api-version"]).toBe("2026-03-30");
  });

  it("never sends a text twice after Quo fails on its side", async () => {
    const { fetcher, seen } = fakeQuo({ "POST /messages": () => ({ status: 500, body: { title: "Unexpected Error", message: "boom" } }) });
    await expect(quoRequest(env, KEY, "/messages", { method: "POST", body: {} }, fetcher as unknown as typeof fetch)).rejects.toThrow("boom");
    expect(seen).toHaveLength(1);
  });
});

describe("Texts through Quo", () => {
  it("go from the Quo number in E.164, to Quo's Done view when Crewtavo sends them by itself, and are noted as Crewtavo's", async () => {
    const data = await connectedDb();
    const { fetcher, seen } = fakeQuo({ "POST /messages": () => ({ status: 202, body: { data: { id: "ACsent1", status: "queued" } } }) });
    vi.stubGlobal("fetch", fetcher);
    const result = await sendSms(env, { to: "(540) 555-0163", body: "See you tomorrow" }, CO);
    expect(result).toEqual({ sent: true, id: "ACsent1" });
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(["POST /messages"]);
    expect(seen[0]!.body).toEqual({ content: "See you tomorrow", from: PN, to: [ANA], inboxStatus: "done" });
    expect(data.tables.quo_sent).toEqual([expect.objectContaining({ company_id: CO, message_id: "ACsent1" })]);
  });

  it("go as the person who wrote them when they're on the number, and stay open in Quo's inbox", async () => {
    await connectedDb();
    const { fetcher, seen } = fakeQuo({
      "GET /phone-numbers/PNmain123/users": () => ({ body: { data: [{ id: "USjosue", email: "Owner@Alder.example", firstName: "Josue" }], nextCursor: null } }),
      "POST /messages": () => ({ status: 202, body: { data: { id: "ACsent2" } } }),
    });
    vi.stubGlobal("fetch", fetcher);
    await sendSms(env, { to: ANA, body: "On it", company: CO, by: { userId: OWNER } });
    expect(seen.at(-1)!.body).toEqual({ content: "On it", from: PN, to: [ANA], senderUserId: "USjosue" });
  });

  it("keep Crewtavo's own texts in Quo's inbox when the business turned that off", async () => {
    await connectedDb({ quiet: false });
    const { fetcher, seen } = fakeQuo({ "POST /messages": () => ({ status: 202, body: { data: { id: "ACsent3" } } }) });
    vi.stubGlobal("fetch", fetcher);
    await sendSms(env, { to: ANA, body: "Reminder" }, CO);
    expect(seen[0]!.body.inboxStatus).toBeUndefined();
  });

  it("say a number that opted out as Twilio's STOP code, so it's kept as stopped", async () => {
    await connectedDb();
    const { fetcher } = fakeQuo({ "POST /messages": () => ({ status: 400, body: { title: "User Opted Out", message: "User has opted out of receiving messages" } }) });
    vi.stubGlobal("fetch", fetcher);
    const result = await sendSms(env, { to: ANA, body: "Hi" }, CO);
    expect(result).toMatchObject({ sent: false, code: 21610 });
    expect(result.reason).toContain("opted out");
  });

  it("mark the connection broken when Quo no longer takes the key, and say what's wrong when credits run out", async () => {
    const data = await connectedDb();
    let answer: { status: number; body: unknown } = { status: 401, body: { title: "Unauthorized", message: "Invalid API key" } };
    const { fetcher } = fakeQuo({ "POST /messages": () => answer });
    vi.stubGlobal("fetch", fetcher);
    expect(await sendSms(env, { to: ANA, body: "Hi" }, CO)).toMatchObject({ sent: false, status: 401 });
    expect(data.tables.integrations![0]).toMatchObject({ status: "error" });

    forgetQuo();
    answer = { status: 402, body: { title: "Not Enough Credits", message: "The organization does not have enough prepaid credits" } };
    const short = await sendSms(env, { to: ANA, body: "Hi" }, CO);
    expect(short.sent).toBe(false);
    expect(short.status).toBeUndefined();
    expect(short.reason).toContain("prepaid credits");
  });

  it("don't go through Quo for a business that hasn't connected it", async () => {
    await connectedDb();
    const { fetcher, seen } = fakeQuo({});
    vi.stubGlobal("fetch", fetcher);
    const result = await sendSms(env, { to: ANA, body: "Hi", company: OTHER });
    expect(result.sent).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("Quo's deliveries", () => {
  it("file a reply from a client's phone on their timeline, once however often Quo sends it", async () => {
    const data = await connectedDb();
    vi.stubGlobal("fetch", fakeQuo({}).fetcher);
    const event = messageEvent("message.received", { id: "ACin1", direction: "incoming", text: "Can you do Tuesday?" }, { senderIdentifier: ANA, recipientIdentifiers: [OWN] });
    const first = await deliver(event, { id: "msg_same" });
    expect(first.status).toBe(200);
    const again = await deliver(event, { id: "msg_same" });
    expect(await again.json()).toMatchObject({ again: true });
    const filed = data.tables.messages!.filter((m) => m.external_id === "ACin1");
    expect(filed).toEqual([expect.objectContaining({ client_id: "client-ana", direction: "in", channel: "sms", body: "Can you do Tuesday?", status: "received" })]);
    // The other business with the same client number isn't told.
    expect(filed.every((m) => m.company_id === CO)).toBe(true);
    expect(data.tables.notifications?.some((n) => n.title === "New text from a client")).toBe(true);
  });

  it("refuse a delivery signed with another key, and one for a business without Quo, the same way", async () => {
    const data = await connectedDb();
    const event = messageEvent("message.received", { id: "ACin2", direction: "incoming", text: "Hi" }, { senderIdentifier: ANA });
    const wrong = await deliver(event, { key: `whsec_${Buffer.from("someone else's key, thirty-two b").toString("base64")}` });
    const nobody = await deliver(event, { company: OTHER });
    const junk = await app.request("/api/webhooks/quo/not-a-company", { method: "POST", body: "{}" }, env);
    expect([wrong.status, nobody.status, junk.status]).toEqual([401, 401, 401]);
    expect(await nobody.json()).toEqual(await wrong.json());
    expect(data.tables.messages ?? []).toHaveLength(0);
  });

  it("let other numbers' events and Quo's test samples go", async () => {
    const data = await connectedDb();
    const sample = messageEvent("message.received", { id: "AC-message", text: "hello" }, { phoneNumberId: "PN123", senderIdentifier: "+15550001111" });
    expect((await deliver(sample)).status).toBe(200);
    expect(data.tables.messages ?? []).toHaveLength(0);
    // Heard from Quo, all the same.
    await vi.waitFor(() => expect((data.tables.integrations![0]!.settings as QuoSettings).heard_at).toBeTruthy());
  });

  it("keep a texted picture in the client's files", async () => {
    const data = await connectedDb();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    vi.stubGlobal("fetch", fakeQuo({ "GET https://media.quo.example/p1.jpg": () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }) }).fetcher);
    await deliver(messageEvent("message.received", { id: "ACpic", text: "", media: [{ url: "https://media.quo.example/p1.jpg", type: "image/jpeg" }] }, { senderIdentifier: ANA }));
    expect(data.tables.messages!.find((m) => m.external_id === "ACpic")).toMatchObject({ body: "Sent a picture.", client_id: "client-ana" });
    // Kept after Quo has its answer.
    await vi.waitFor(() => expect(data.tables.attachments ?? []).toHaveLength(1));
    expect(data.tables.attachments).toEqual([expect.objectContaining({ owner_type: "client", owner_id: "client-ana", content_type: "image/jpeg", caption: "Texted by Ana Alvarez" })]);
    expect([...data.files.keys()]).toEqual([`${CO}/client/client-ana/text-ACpic-1.jpg`]);
  });

  it("bring a text Crewtavo sent up to date, and file one typed in the Quo app as from Quo", async () => {
    const data = await connectedDb({}, {
      quo_sent: [{ company_id: CO, message_id: "ACours" }],
      messages: [{ id: "m-ours", company_id: CO, client_id: "client-ana", channel: "sms", direction: "out", status: "sent", body: "Reminder", external_id: "ACours", recipients: [{ to: ANA, name: "Ana Alvarez" }] }],
    });
    await deliver(messageEvent("message.delivered", { id: "ACours", direction: "outgoing", text: "Reminder", status: "delivered" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    expect(data.tables.messages!.filter((m) => m.external_id === "ACours")).toEqual([expect.objectContaining({ id: "m-ours", status: "delivered" })]);

    await deliver(messageEvent("message.delivered", { id: "ACtyped", direction: "outgoing", text: "Running 10 min late", status: "delivered", createdAt: "2026-11-20T15:00:00.000Z" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    expect(data.tables.messages!.find((m) => m.external_id === "ACtyped")).toMatchObject({
      client_id: "client-ana", direction: "out", status: "delivered", origin: "quo", body: "Running 10 min late", created_at: "2026-11-20T15:00:00.000Z", recipients: [{ to: ANA, name: "Ana Alvarez" }],
    });

    await deliver(messageEvent("message.failed", { id: "ACours", direction: "outgoing", text: "Reminder", errorCode: "30003" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    expect(data.tables.messages!.find((m) => m.id === "m-ours")).toMatchObject({ status: "failed", recipients: [{ to: ANA, name: "Ana Alvarez", failed: true }] });
  });

  it("mark only the person whose text failed, in a text to several people", async () => {
    const BO = "+15405550188";
    const data = await connectedDb({}, {
      quo_sent: [{ company_id: CO, message_id: "ACana" }, { company_id: CO, message_id: "ACbo" }],
      messages: [{ id: "m-both", company_id: CO, client_id: "client-ana", channel: "sms", direction: "out", status: "sent", body: "Reminder", external_id: "ACana", recipients: [{ to: ANA, name: "Ana Alvarez", id: "ACana" }, { to: BO, name: "Bo Brown", id: "ACbo" }] }],
    });
    await deliver(messageEvent("message.undelivered", { id: "ACbo", direction: "outgoing", text: "Reminder", errorCode: "30003" }, { senderIdentifier: OWN, recipientIdentifiers: [BO] }));
    expect(data.tables.messages!.find((m) => m.id === "m-both")).toMatchObject({ status: "sent", recipients: [{ to: ANA, id: "ACana" }, { to: BO, id: "ACbo", failed: true }] });
    expect(data.tables.messages!.find((m) => m.id === "m-both")!.recipients[0].failed).toBeUndefined();
    await deliver(messageEvent("message.failed", { id: "ACana", direction: "outgoing", text: "Reminder", errorCode: "30003" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    expect(data.tables.messages!.find((m) => m.id === "m-both")).toMatchObject({ status: "failed" });
    expect(data.tables.messages!.filter((m) => m.body === "Reminder")).toHaveLength(1);
  });

  it("note a text its sender keeps on a timeline apart from one nobody keeps", async () => {
    const data = await connectedDb();
    let n = 0;
    vi.stubGlobal("fetch", fakeQuo({ "POST /messages": () => ({ status: 202, body: { data: { id: `ACnote${++n}` } } }) }).fetcher);
    // A sign-in code, or a notice to the team: Crewtavo's, and nothing more.
    await sendSms(env, { to: ANA, body: "Your code is 123456", company: CO });
    // A quote's text: its sender saves a message with Quo's id.
    await sendSms(env, { to: ANA, body: "Here's your quote", company: CO, kept: true });
    expect(data.tables.quo_sent!.map((row) => row.message_id)).toEqual(["ACnote1", "ACnote2", "ACnote2 kept"]);
  });

  it("answer Quo at once about a text nobody keeps on a timeline, without filing it as typed in Quo", async () => {
    const data = await connectedDb({}, { quo_sent: [{ company_id: CO, message_id: "ACcode" }, { company_id: CO, message_id: "ACnotice" }] });
    const started = Date.now();
    const delivered = await deliver(messageEvent("message.delivered", { id: "ACcode", direction: "outgoing", text: "Your code is 123456", status: "delivered" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    const failed = await deliver(messageEvent("message.failed", { id: "ACnotice", direction: "outgoing", text: "New request from Ana", errorCode: "30003" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] }));
    expect([delivered.status, failed.status]).toEqual([200, 200]);
    // No three-second wait for a message that isn't coming.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(data.tables.messages ?? []).toEqual([]);
    expect(data.tables.quo_events!.every((row) => row.done_at)).toBe(true);
  });

  it("wait for the message a sender is still saving, and have Quo report again when it isn't there yet", async () => {
    const data = await connectedDb({}, { quo_sent: [{ company_id: CO, message_id: "ACquote" }, { company_id: CO, message_id: "ACquote kept" }] });
    const account = (await companyQuo(env, CO))!;
    const report = messageEvent("message.failed", { id: "ACquote", direction: "outgoing", text: "Here's your quote", errorCode: "30003" }, { senderIdentifier: OWN, recipientIdentifiers: [ANA] });
    // Not saved after the wait: Quo is asked to send the report again (its webhook answers 500).
    const waited: number[] = [];
    await expect(handleQuoEvent(env, data.db, account, report, { wait: async (ms) => void waited.push(ms) })).rejects.toThrow("hasn't saved yet");
    expect(waited).toEqual([3000]);
    expect((await deliver(report)).status).toBe(500);
    expect(data.tables.quo_events ?? []).toEqual([]);
    expect(data.tables.messages ?? []).toEqual([]);
    // Saved during the wait: the report lands on it.
    const save = async () => void (data.tables.messages = [{ id: "m-quote", company_id: CO, client_id: "client-ana", channel: "sms", direction: "out", status: "sent", body: "Here's your quote", external_id: "ACquote", recipients: [{ to: ANA, name: "Ana Alvarez", id: "ACquote" }] }]);
    await handleQuoEvent(env, data.db, account, report, { wait: save });
    expect(data.tables.messages).toEqual([expect.objectContaining({ id: "m-quote", status: "failed", recipients: [{ to: ANA, name: "Ana Alvarez", id: "ACquote", failed: true }] })]);
  }, 15_000);

  it("put an answered call on the client's timeline, waiting on nobody", async () => {
    const data = await connectedDb();
    const call = messageEvent("call.completed", { id: "ACcall1", direction: "incoming", status: "answered", answeredAt: "2026-11-20T15:00:05.000Z", duration: 240, hasVoicemail: false, createdAt: "2026-11-20T15:00:00.000Z" }, callContext(ANA));
    await deliver(call);
    const row = data.tables.messages!.find((m) => m.external_id === "ACcall1");
    expect(row).toMatchObject({ channel: "call", direction: "in", client_id: "client-ana", origin: "quo", body: "Call · 4 min", call: { outcome: "answered", seconds: 240, quo_id: "ACcall1" } });
    expect(data.tables.conversations_done).toEqual([expect.objectContaining({ client_id: "client-ana" })]);
    expect(data.tables.notifications ?? []).toHaveLength(0);
  });

  it("put a voicemail on the timeline once, with its words and Quo's summary as they come, in any order", async () => {
    const data = await connectedDb();
    const { fetcher, seen } = fakeQuo({
      "GET /calls/ACvm": () => ({ body: { data: { id: "ACvm", direction: "incoming", status: "missed", answeredAt: null, duration: 0, createdAt: "2026-11-20T16:00:00.000Z", participants: [{ phoneNumber: OWN }, { phoneNumber: ANA }], voicemail: { status: "in-progress", duration: null, transcript: null } } } }),
    });
    vi.stubGlobal("fetch", fetcher);
    // The summary first: the call is fetched from Quo and filed with it.
    await deliver(messageEvent("call.summary.completed", { callId: "ACvm", processingStatus: "completed", summary: ["Wants a quote for the deck."], nextSteps: ["Call back Friday."] }, callContext(ANA)));
    expect(seen.map((r) => `${r.url.pathname}?${r.url.searchParams}`)).toEqual(["/calls/ACvm?include=summary%2Cvoicemail"]);
    // Then the call itself, and the voicemail's words.
    await deliver(messageEvent("call.completed", { id: "ACvm", direction: "incoming", status: "unanswered", answeredAt: null, duration: 0, hasVoicemail: true, createdAt: "2026-11-20T16:00:00.000Z" }, callContext(ANA)));
    await deliver(messageEvent("call.voicemail.completed", { id: "ACvmact", callId: "ACvm", direction: "incoming", duration: 42, from: ANA, to: OWN, transcript: "Hi, it's Ana about the deck." }, callContext(ANA)));
    const rows = data.tables.messages!.filter((m) => m.external_id === "ACvm");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.call).toEqual({ outcome: "voicemail", seconds: 42, summary: ["Wants a quote for the deck."], next_steps: ["Call back Friday."], voicemail: "Hi, it's Ana about the deck.", quo_id: "ACvm", rev: 2 });
    expect(rows[0]!.body).toBe("Voicemail · 42 sec\n\n“Hi, it's Ana about the deck.”\n\nWants a quote for the deck.\n\nNext steps:\n• Call back Friday.");
    expect(data.tables.notifications).toEqual([expect.objectContaining({ title: "Voicemail from Ana Alvarez", link: "/messages?client=client-ana" })]);
  });

  it("keep a missed call from a number nobody knows under Unknown numbers, and a contact's call under their client", async () => {
    const data = await connectedDb();
    await deliver(messageEvent("call.completed", { id: "ACnew", direction: "incoming", status: "unanswered", duration: 0, hasVoicemail: false }, callContext("+15405559999")));
    expect(data.tables.unknown_texts).toEqual([expect.objectContaining({ channel: "call", phone_key: "5405559999", body: "Missed call", external_id: "ACnew" })]);
    expect(data.tables.notifications).toEqual([expect.objectContaining({ title: "Missed call from an unknown number" })]);

    await deliver(messageEvent("call.completed", { id: "ACsam", direction: "outgoing", status: "answered", answeredAt: "2026-11-20T17:00:00.000Z", duration: 61, hasVoicemail: false }, callContext("+15405550188")));
    expect(data.tables.messages!.find((m) => m.external_id === "ACsam")).toMatchObject({ client_id: "client-bo", direction: "out", body: "Call · 1 min", recipients: [{ to: "+15405550188", name: "Sam Brown" }] });
  });

  it("leave calls alone when the business keeps texts only", async () => {
    const data = await connectedDb({ calls: false });
    await deliver(messageEvent("call.completed", { id: "ACoff", direction: "incoming", status: "answered", duration: 30 }, callContext(ANA)));
    expect(data.tables.messages ?? []).toHaveLength(0);
  });
});

describe("Connecting Quo on the Apps page", () => {
  const routes = {
    ...NUMBERS,
    "POST /webhooks": () => ({ status: 201, body: { data: { id: "991", key: HOOK_KEY, status: "enabled" } } }),
    "PATCH /webhooks/991": () => ({ body: { data: { id: "991" } } }),
    "DELETE /webhooks/991": () => ({ status: 204 }),
  };

  it("checks the key, keeps it encrypted, and makes the webhook for the number picked", async () => {
    const data = memoryDb({ memberships: [{ company_id: CO, user_id: OWNER, role: "owner", role_id: null, active: true }], companies: [{ id: CO, country: "US", settings: {} }] }, { [OWNER]: "owner@alder.example" });
    current.db = data.db;
    const { fetcher, seen } = fakeQuo(routes);
    vi.stubGlobal("fetch", fetcher);
    const listed = await app.request("/api/apps/quo/numbers", { method: "POST", headers, body: JSON.stringify({ api_key: KEY }) }, env);
    expect(await listed.json()).toEqual({ numbers: [{ id: PN, number: OWN, name: "Main line" }, { id: "PNother", number: "+15405550001", name: "(540) 555-0001" }] });

    const res = await app.request("/api/apps/quo/account", { method: "PUT", headers, body: JSON.stringify({ api_key: KEY, phone_number_id: PN }) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quo: { webhook: { set: boolean }; number: unknown } };
    expect(body.quo.webhook.set).toBe(true);
    expect(body.quo.number).toEqual({ id: PN, number: OWN, name: "Main line" });
    const made = seen.find((r) => r.method === "POST" && r.url.pathname === "/webhooks")!;
    expect(made.body).toEqual({
      url: `https://crew.example.com/api/webhooks/quo/${CO}`,
      events: ["message.received", "message.delivered", "message.failed", "message.undelivered", "call.completed", "call.summary.completed", "call.voicemail.completed"],
      resourceIds: [PN],
      label: "Crewtavo",
    });
    const row = data.tables.integrations!.find((r) => r.provider === "quo")!;
    expect(row).toMatchObject({ status: "connected", external_account_id: PN });
    expect(JSON.stringify(row.settings)).not.toContain(KEY);
    const kept = await decryptJson<{ api_key: string; extra: { webhook_key: string } }>(env, data.tables.integration_secrets![0]!.ciphertext);
    expect(kept).toEqual({ api_key: KEY, extra: { webhook_key: HOOK_KEY } });
    expect(row.account_label).toBe("Main line · (540) 555-0000");
    // A number Quo has no name for is labelled by the number once.
    await app.request("/api/apps/quo/account", { method: "PUT", headers, body: JSON.stringify({ phone_number_id: "PNother" }) }, env);
    expect(data.tables.integrations!.find((r) => r.provider === "quo")!.account_label).toBe("Quo · (540) 555-0001");
  });

  it("says what to fix when Quo doesn't take the key", async () => {
    current.db = memoryDb({ memberships: [{ company_id: CO, user_id: OWNER, role: "owner", role_id: null, active: true }] }, { [OWNER]: "o@a.example" }).db;
    vi.stubGlobal("fetch", fakeQuo({ "GET /phone-numbers": () => ({ status: 401, body: { title: "Unauthorized", message: "bad key" } }) }).fetcher);
    const res = await app.request("/api/apps/quo/numbers", { method: "POST", headers, body: JSON.stringify({ api_key: "wrong" }) }, env);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Workspace Settings → API");
  });

  it("stops listening for calls in Quo when they're turned off, and takes the webhook out on disconnect", async () => {
    const data = await connectedDb({ webhook_id: "991" });
    const { fetcher, seen } = fakeQuo(routes);
    vi.stubGlobal("fetch", fetcher);
    const off = await app.request("/api/apps/quo/settings", { method: "PATCH", headers, body: JSON.stringify({ calls: false }) }, env);
    expect(off.status).toBe(200);
    expect(seen.find((r) => r.method === "PATCH")!.body.events).toEqual(["message.received", "message.delivered", "message.failed", "message.undelivered"]);
    expect((data.tables.integrations![0]!.settings as QuoSettings).calls).toBe(false);

    const gone = await app.request("/api/apps/quo/disconnect", { method: "POST", headers, body: "{}" }, env);
    expect(gone.status).toBe(200);
    expect(seen.some((r) => r.method === "DELETE" && r.url.pathname === "/webhooks/991")).toBe(true);
    expect(data.tables.integrations![0]).toMatchObject({ status: "disconnected" });
    expect(data.tables.integration_secrets ?? []).toHaveLength(0);
  });
});

describe("Bringing in past texts and calls", () => {
  it("files texts and calls under the clients whose numbers they were, once, and tells nobody", async () => {
    const data = await connectedDb({}, {
      quo_sent: [{ company_id: CO, message_id: "ACcrewtavo" }],
      messages: [{ id: "m-known", company_id: CO, client_id: "client-ana", channel: "sms", direction: "in", status: "received", body: "Already here", external_id: "ACknown", created_at: "2026-10-02T10:00:00.000Z" }],
    });
    const pages: Record<string, unknown> = {
      first: { data: [
        { id: "ACh1", direction: "incoming", from: ANA, to: [OWN], text: "Is Thursday ok?", status: "received", createdAt: "2026-10-05T10:00:00.000Z", media: [] },
        { id: "ACh2", direction: "outgoing", from: OWN, to: [ANA], text: "Thursday works", status: "delivered", createdAt: "2026-10-05T10:05:00.000Z", media: [] },
        { id: "ACknown", direction: "incoming", from: ANA, to: [OWN], text: "Already here", status: "received", createdAt: "2026-10-02T10:00:00.000Z", media: [] },
      ], nextCursor: "page2" },
      second: { data: [
        { id: "ACcrewtavo", direction: "outgoing", from: OWN, to: [ANA], text: "Reminder from Crewtavo", status: "delivered", createdAt: "2026-10-01T10:00:00.000Z", media: [] },
        { id: "ACstranger", direction: "incoming", from: "+15405559999", to: [OWN], text: "Who is this?", status: "received", createdAt: "2026-10-01T09:00:00.000Z", media: [] },
        { id: "ACstop", direction: "incoming", from: ANA, to: [OWN], text: "STOP", status: "received", createdAt: "2026-09-30T09:00:00.000Z", media: [] },
      ], nextCursor: null },
    };
    const { fetcher, seen } = fakeQuo({
      "GET /messages": (req) => ({ body: req.url.searchParams.get("after") === "page2" ? pages.second : pages.first }),
      "GET /calls": () => ({ body: { data: [
        { id: "AChc", direction: "incoming", status: "completed", answeredAt: "2026-10-04T12:00:05.000Z", duration: 125, createdAt: "2026-10-04T12:00:00.000Z", participants: [{ phoneNumber: OWN }, { phoneNumber: ANA }], summary: { status: "completed", summary: ["Asked about trim colours."], nextSteps: [] }, voicemail: null },
        { id: "ACignored", direction: "incoming", status: "answered", answeredAt: "2026-10-04T13:00:00.000Z", duration: 30, createdAt: "2026-10-04T13:00:00.000Z", participants: [{ phoneNumber: OWN }, { phoneNumber: "+15405559999" }] },
        { id: "AColdlead", direction: "incoming", status: "missed", answeredAt: null, duration: 0, createdAt: "2026-10-03T13:00:00.000Z", participants: [{ phoneNumber: OWN }, { phoneNumber: "+15405559998" }], voicemail: { status: "completed", duration: 9, transcript: "Call me back" } },
      ], nextCursor: null } }),
    });
    const state = await beginQuoImport(data.db, CO, "2026-09-01");
    await importFromQuo(env, data.db, CO, state, fetcher as unknown as typeof fetch);

    const messagesQuery = seen.find((r) => r.url.pathname === "/messages")!.url.searchParams;
    expect(Object.fromEntries(messagesQuery)).toEqual({ phoneNumberId: PN, "createdAt[gt]": "2026-09-01T00:00:00Z", limit: "50" });
    const callsQuery = seen.find((r) => r.url.pathname === "/calls")!.url.searchParams;
    expect(callsQuery.get("include")).toBe("summary,voicemail");

    const brought = data.tables.messages!.filter((m) => m.origin === "quo_import");
    expect(brought.map((m) => [m.external_id, m.direction, m.channel]).sort()).toEqual([
      ["ACh1", "in", "sms"], ["ACh2", "out", "sms"], ["AChc", "in", "call"], ["ACstop", "in", "sms"],
    ]);
    expect(brought.find((m) => m.external_id === "AChc")).toMatchObject({ body: "Call · 2 min\n\nAsked about trim colours.", created_at: "2026-10-04T12:00:00.000Z" });
    // A STOP from history is a message, not a stop: nothing is acted on, nobody is told, nothing waits.
    expect(data.tables.sms_stops ?? []).toHaveLength(0);
    expect(data.tables.notifications ?? []).toHaveLength(0);
    expect(data.tables.unknown_texts ?? []).toHaveLength(0);
    expect(data.tables.conversations_done).toEqual([expect.objectContaining({ client_id: "client-ana" })]);
    const done = (data.tables.integrations![0]!.settings as QuoSettings).import!;
    expect(done).toMatchObject({ status: "done", since: "2026-09-01", counts: { texts: 3, calls: 1, skipped: 3 } });
  });

  it("says it failed, and why, when Quo stops answering", async () => {
    const data = await connectedDb();
    const { fetcher } = fakeQuo({ "GET /messages": () => ({ status: 403, body: { title: "Forbidden", message: "Key can't read messages" } }) });
    const state = await beginQuoImport(data.db, CO, null);
    await expect(importFromQuo(env, data.db, CO, state, fetcher as unknown as typeof fetch)).rejects.toThrow();
    expect((data.tables.integrations![0]!.settings as QuoSettings).import).toMatchObject({ status: "failed", error: "Key can't read messages" });
  });
});

describe("What review turned up", () => {
  it("a summary and a voicemail's words that come at the same moment both stay", async () => {
    const data = await connectedDb();
    await deliver(messageEvent("call.completed", { id: "ACboth", direction: "incoming", status: "unanswered", duration: 0, hasVoicemail: true }, callContext(ANA)));
    await Promise.all([
      deliver(messageEvent("call.summary.completed", { callId: "ACboth", processingStatus: "completed", summary: ["Asked about colors."], nextSteps: ["Send the color list."] }, callContext(ANA))),
      deliver(messageEvent("call.voicemail.completed", { id: "ACvmx", callId: "ACboth", direction: "incoming", duration: 12, from: ANA, to: OWN, transcript: "Call me about colors." }, callContext(ANA))),
    ]);
    const row = data.tables.messages!.find((m) => m.external_id === "ACboth")!;
    expect(row.call).toMatchObject({ outcome: "voicemail", seconds: 12, summary: ["Asked about colors."], next_steps: ["Send the color list."], voicemail: "Call me about colors." });
    expect(row.body).toContain("Call me about colors.");
    expect(row.body).toContain("Send the color list.");
  });

  it("a delivery still being handled is to be tried again later, and one left half done is taken over", async () => {
    const data = await connectedDb({}, { quo_events: [{ company_id: CO, event_id: "msg_busy", received_at: new Date().toISOString(), done_at: null }, { company_id: CO, event_id: "msg_left", received_at: new Date(Date.now() - 10 * 60_000).toISOString(), done_at: null }] });
    const busy = await deliver(messageEvent("message.received", { id: "ACbusy", text: "Hello?" }, { senderIdentifier: ANA }), { id: "msg_busy" });
    expect(busy.status).toBe(409);
    const left = await deliver(messageEvent("message.received", { id: "ACleft", text: "Anyone there?" }, { senderIdentifier: ANA }), { id: "msg_left" });
    expect(left.status).toBe(200);
    expect(data.tables.messages!.filter((m) => m.external_id === "ACleft")).toHaveLength(1);
    expect(data.tables.quo_events!.find((e) => e.event_id === "msg_left")!.done_at).toBeTruthy();
    // And a text already filed (Quo trying again after a failure further on) isn't filed twice.
    await deliver(messageEvent("message.received", { id: "ACleft", text: "Anyone there?" }, { senderIdentifier: ANA }), { id: "msg_other_try" });
    expect(data.tables.messages!.filter((m) => m.external_id === "ACleft")).toHaveLength(1);
  });

  it("a business whose Quo connection can't be read sends nothing, rather than from another number", async () => {
    const data = await connectedDb();
    // The secrets table doesn't answer.
    const failing = { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "database down" } }) }) }) }) };
    const down = { ...data.db, from: (table: string) => (table === "integration_secrets" ? failing : data.db.from(table as never)) };
    current.db = down;
    const withServer: Env = { ...env, TWILIO_ACCOUNT_SID: "AC" + "5".repeat(32), TWILIO_AUTH_TOKEN: "server-token", TWILIO_FROM_NUMBER: "+15405550000" };
    const { fetcher, seen } = fakeQuo({});
    vi.stubGlobal("fetch", fetcher);
    const result = await sendSms(withServer, { to: ANA, body: "Reminder" }, CO);
    expect(result.sent).toBe(false);
    expect(seen).toHaveLength(0);
    await expect(companyQuo(withServer, CO)).rejects.toThrow("database down");
  });

  it("an automatic text to a number that texted in the last few days stays in Quo's inbox", async () => {
    await connectedDb({}, { messages: [{ company_id: CO, client_id: "client-ana", channel: "sms", direction: "in", status: "received", body: "Is Tuesday ok?", from_phone: ANA, created_at: new Date(Date.now() - 3600_000).toISOString() }] });
    const { fetcher, seen } = fakeQuo({ "POST /messages": () => ({ status: 202, body: { data: { id: "ACq" } } }) });
    vi.stubGlobal("fetch", fetcher);
    await sendSms(env, { to: "(540) 555-0163", body: "Reminder: tomorrow at 9" }, CO);
    expect(seen[0]!.body.inboxStatus).toBeUndefined();
    await sendSms(env, { to: "(540) 555-0177", body: "Reminder: tomorrow at 9" }, CO);
    expect(seen[1]!.body.inboxStatus).toBe("done");
  });

  it("a late refusal of the key doesn't bring a disconnected Quo back", async () => {
    const data = await connectedDb();
    await companyQuo(env, CO);
    data.tables.integrations![0]!.status = "disconnected";
    vi.stubGlobal("fetch", fakeQuo({ "POST /messages": () => ({ status: 401, body: { title: "Unauthorized", message: "Invalid API key" } }) }).fetcher);
    await sendSms(env, { to: ANA, body: "Hi" }, CO);
    expect(data.tables.integrations![0]!.status).toBe("disconnected");
  });

  it("a new key takes the old webhook out of Quo, even when the old key no longer works, and any other sending here", async () => {
    const data = await connectedDb({ webhook_id: "77" });
    const url = `https://crew.example.com/api/webhooks/quo/${CO}`;
    const { fetcher, seen } = fakeQuo({
      ...NUMBERS,
      "DELETE /webhooks/77": (req) => (req.headers.authorization === "new-key" ? { status: 204 } : { status: 401, body: { title: "Unauthorized", message: "revoked" } }),
      "POST /webhooks": () => ({ status: 201, body: { data: { id: "992", key: HOOK_KEY } } }),
      "GET /webhooks": () => ({ body: { data: [{ id: "992", url }, { id: "55", url }, { id: "60", url: "https://elsewhere.example/hook" }] } }),
      "DELETE /webhooks/55": () => ({ status: 204 }),
    });
    vi.stubGlobal("fetch", fetcher);
    const res = await app.request("/api/apps/quo/account", { method: "PUT", headers, body: JSON.stringify({ api_key: "new-key", phone_number_id: PN }) }, env);
    expect(res.status).toBe(200);
    const deletes = seen.filter((r) => r.method === "DELETE").map((r) => `${r.url.pathname} ${r.headers.authorization}`);
    expect(deletes).toEqual(["/webhooks/77 quo-key-123", "/webhooks/77 new-key", "/webhooks/55 new-key"]);
    expect((data.tables.integrations![0]!.settings as QuoSettings).webhook_id).toBe("992");
  });

  it("a webhook whose signing key was lost gets a new one from Quo", async () => {
    const data = await connectedDb({ webhook_id: "77" });
    data.tables.integration_secrets![0]!.ciphertext = await encryptJson(env, { api_key: KEY, extra: {} });
    const { fetcher, seen } = fakeQuo({
      "PATCH /webhooks/77": () => ({ body: { data: { id: "77" } } }),
      "POST /webhooks/77/rotate": () => ({ body: { data: { id: "77", key: HOOK_KEY } } }),
      "GET /webhooks": () => ({ body: { data: [] } }),
    });
    vi.stubGlobal("fetch", fetcher);
    const res = await app.request("/api/apps/quo/webhook", { method: "POST", headers, body: "{}" }, env);
    expect(res.status).toBe(200);
    expect(seen.some((r) => r.url.pathname === "/webhooks/77/rotate")).toBe(true);
    const kept = await decryptJson<{ extra: { webhook_key: string } }>(env, data.tables.integration_secrets![0]!.ciphertext);
    expect(kept.extra.webhook_key).toBe(HOOK_KEY);
  });

  it("the number can't change while past texts and calls are coming in", async () => {
    await connectedDb({ import: { status: "running", since: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), counts: { texts: 3, calls: 0, skipped: 0 } } });
    vi.stubGlobal("fetch", fakeQuo(NUMBERS).fetcher);
    const res = await app.request("/api/apps/quo/account", { method: "PUT", headers, body: JSON.stringify({ phone_number_id: "PNother" }) }, env);
    expect(res.status).toBe(409);
  });

  it("a voicemail from a number nobody knows, deleted under Unknown numbers, isn't brought back by its words", async () => {
    const data = await connectedDb();
    vi.stubGlobal("fetch", fakeQuo({ "GET /calls/ACgone": () => ({ body: { data: { id: "ACgone", direction: "incoming", status: "missed", duration: 0, participants: [{ phoneNumber: OWN, actorId: "US1" }, { phoneNumber: "+15405559999", actorId: null }], voicemail: { status: "completed", duration: 8, transcript: "Call me" } } } }) }).fetcher);
    await deliver(messageEvent("call.voicemail.completed", { id: "ACv", callId: "ACgone", direction: "incoming", duration: 8, from: "+15405559999", to: OWN, transcript: "Call me" }, callContext("+15405559999")));
    expect(data.tables.unknown_texts ?? []).toHaveLength(0);
    expect(data.tables.notifications ?? []).toHaveLength(0);
  });

  it("a call Quo's AI agent took tells the office, and leaves the conversation waiting", async () => {
    const data = await connectedDb();
    await deliver(messageEvent("call.completed", { id: "ACai", direction: "incoming", status: "ai-handled", answeredAt: "2026-11-20T20:00:01.000Z", duration: 95, hasVoicemail: false }, callContext(ANA)));
    expect(data.tables.messages!.find((m) => m.external_id === "ACai")!.call).toMatchObject({ outcome: "answered" });
    expect(data.tables.conversations_done ?? []).toHaveLength(0);
    expect(data.tables.notifications).toEqual([expect.objectContaining({ title: "Quo's AI agent took a call from Ana Alvarez" })]);
  });

  it("the other phone on a call is never one of the business's own", () => {
    const call = callFromApi({ id: "ACx", direction: "incoming", status: "completed", answeredAt: "2026-11-20T10:00:00Z", duration: 30, participants: [{ phoneNumber: OWN, actorId: "US1" }, { phoneNumber: "+15405550111", actorId: "US2" }, { phoneNumber: ANA, actorId: null }] }, OWN);
    expect(call?.other).toBe(ANA);
  });

  it("Quo's key goes in on its own page, not as a plain key", async () => {
    await connectedDb();
    const res = await app.request("/api/apps/quo/key", { method: "PUT", headers, body: JSON.stringify({ api_key: "something" }) }, env);
    expect(res.status).toBe(400);
  });

  it("bringing in history leaves a conversation from the last few days waiting", async () => {
    const data = await connectedDb();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const { fetcher } = fakeQuo({
      "GET /messages": () => ({ body: { data: [{ id: "ACrecent", direction: "incoming", from: ANA, to: [OWN], text: "Still on for Friday?", status: "received", createdAt: recent, media: [] }], nextCursor: null } }),
      "GET /calls": () => ({ body: { data: [], nextCursor: null } }),
    });
    const state = await beginQuoImport(data.db, CO, null);
    await importFromQuo(env, data.db, CO, state, fetcher as unknown as typeof fetch);
    expect(data.tables.messages!.find((m) => m.external_id === "ACrecent")).toBeTruthy();
    expect(data.tables.conversations_done ?? []).toHaveLength(0);
  });
});
