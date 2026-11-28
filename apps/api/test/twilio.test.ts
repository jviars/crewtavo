/**
 * A company's own Twilio account (lib/twilio.ts, Apps → Twilio): its credentials are checked with
 * Twilio before they're kept, the Auth Token is stored encrypted, texts go out through the
 * company's account when it has one and the server's otherwise, and a text that comes in belongs to
 * the company whose account signed it. Twilio answers what each test gives it; the database is a
 * stand-in that keeps integrations and their secrets like the real tables.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { decryptJson, encryptJson } from "../src/lib/crypto";
import { sendSms, smsReady } from "../src/lib/notify";
import { checkTwilio, forgetTwilio, inboundAccounts, setSmsWebhook, TwilioProblem, twilioStatusUrl } from "../src/lib/twilio";
import type { Db } from "../src/lib/supabase";
import { twilioSignature } from "../src/routes/messages";

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
const withServer: Env = { ...env, TWILIO_ACCOUNT_SID: "AC" + "5".repeat(32), TWILIO_AUTH_TOKEN: "server-token", TWILIO_FROM_NUMBER: "+15405550000" };
const ALDER = "00000000-0000-4000-8000-00000000000a";
const BIRCH = "00000000-0000-4000-8000-00000000000b";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SID_A = "AC" + "a".repeat(32);
const SID_B = "AC" + "b".repeat(32);
const headers = { Authorization: "Bearer token", "X-Company-Id": ALDER, "Content-Type": "application/json" };
const HOOK = "https://crew.example.com/api/webhooks/twilio";

interface Query {
  table: string;
  calls: Array<[string, ...any[]]>;
}
const call = (q: Query, name: string) => q.calls.find(([n]) => n === name);
const verb = (q: Query) => q.calls.find(([n]) => ["insert", "upsert", "update", "delete"].includes(n))?.[0] ?? "select";
/** What a query is filtered to, from .eq(), .match() and .in(). */
const filters = (q: Query) => {
  const exact: Record<string, unknown> = {};
  const among: Record<string, unknown[]> = {};
  for (const [name, a, b] of q.calls) {
    if (name === "eq") exact[a] = b;
    if (name === "match") Object.assign(exact, a);
    if (name === "in") among[a] = b;
  }
  return (row: Record<string, unknown>) => Object.entries(exact).every(([k, v]) => row[k] === v) && Object.entries(among).every(([k, v]) => v.includes(row[k]));
};

/** A database with integrations, their encrypted secrets and two companies' clients. */
function fakeDb() {
  const state = {
    integrations: [] as Array<Record<string, any>>,
    secrets: [] as Array<{ company_id: string; provider: string; ciphertext: string }>,
    clients: [
      { id: "client-a", company_id: ALDER, phone: "(540) 555-0163", display_name: "Ana at Alder" },
      { id: "client-b", company_id: BIRCH, phone: "540-555-0163", display_name: "Ana at Birch" },
    ] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    unknown: [] as Array<Record<string, any>>,
    /** companies.country, by company. */
    countries: { [ALDER]: "US", [BIRCH]: "US" } as Record<string, string>,
  };
  const queries: Query[] = [];
  const upsert = (rows: Array<Record<string, any>>, row: Record<string, any>) => {
    const at = rows.findIndex((r) => r.company_id === row.company_id && r.provider === row.provider);
    if (at >= 0) rows[at] = { ...rows[at], ...row };
    else rows.push({ ...row });
  };
  const answer = (q: Query): { data?: unknown; count?: number } => {
    const one = Boolean(call(q, "maybeSingle") ?? call(q, "single"));
    const pick = (rows: Array<Record<string, any>>) => {
      const found = rows.filter(filters(q)).filter((r) => !call(q, "neq") || r[call(q, "neq")![1]] !== call(q, "neq")![2]).filter((r) => !call(q, "not") || r[call(q, "not")![1]] != null);
      return { data: one ? (found[0] ?? null) : found };
    };
    if (q.table === "memberships") return { data: one ? { role: "owner", role_id: null } : [{ user_id: USER }] };
    if (q.table === "integrations") {
      if (verb(q) === "upsert") upsert(state.integrations, call(q, "upsert")![1]);
      else if (verb(q) === "update") for (const row of state.integrations.filter(filters(q))) Object.assign(row, call(q, "update")![1]);
      else return pick(state.integrations);
      return { data: null };
    }
    if (q.table === "integration_secrets") {
      if (verb(q) === "upsert") upsert(state.secrets, call(q, "upsert")![1]);
      else if (verb(q) === "delete") state.secrets = state.secrets.filter((r) => !filters(q)(r));
      else return pick(state.secrets);
      return { data: null };
    }
    if (q.table === "clients" && verb(q) === "select") return pick(state.clients);
    if (q.table === "messages" && verb(q) === "insert") state.messages.push(call(q, "insert")![1]);
    if (q.table === "messages" && verb(q) !== "insert") {
      // .contains("recipients", '[{"id": ...}]'): a row one of whose recipients has that id.
      const has = call(q, "contains") ? (JSON.parse(call(q, "contains")![2]) as Array<{ id: string }>)[0]!.id : null;
      const found = state.messages.filter(filters(q)).filter((m) => !has || (m.recipients ?? []).some((p: { id?: string }) => p.id === has));
      if (verb(q) === "update") for (const row of found) Object.assign(row, call(q, "update")![1]);
      else return { data: found };
      return { data: null };
    }
    if (q.table === "unknown_texts" && verb(q) === "insert") state.unknown.push(call(q, "insert")![1]);
    if (q.table === "unknown_texts" && verb(q) === "select") return { count: 0 };
    if (q.table === "companies") return { data: one ? { settings: {}, country: state.countries[String(call(q, "eq")?.[2])] ?? null } : [{ id: ALDER }, { id: BIRCH }] };
    return { data: one ? null : [] };
  };
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve().then(() => ({ error: null, data: null, ...answer(q) })).then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  const db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async () => ({ data: true, error: null }),
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  /** A company that connected its own account before the test starts. */
  const connect = async (company: string, sid: string, token: string, from: string) => {
    state.integrations.push({ company_id: company, provider: "twilio", status: "connected", external_account_id: sid, settings: { from_number: from, phone_sid: "PN" + sid.slice(2, 8), sms_url: null } });
    state.secrets.push({ company_id: company, provider: "twilio", ciphertext: await encryptJson(env, { api_key: token, extra: { account_sid: sid } }) });
  };
  return { db: db as unknown as Db, state, queries, connect };
}

/** Twilio's API, answering by path; every request is kept. */
function twilio(answers: { account?: () => Response; numbers?: () => Response; message?: () => Response; number?: () => Response } = {}) {
  const requests: Array<{ url: URL; method: string; auth: string; form: Record<string, string> }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "api.twilio.com") return Response.json([]);
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ url, method, auth: atob(String((init?.headers as Record<string, string>).Authorization).replace("Basic ", "")), form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))) });
    if (url.pathname.endsWith("/Messages.json")) return (answers.message ?? (() => Response.json({ sid: "SM1" })))();
    if (/IncomingPhoneNumbers\/PN\w+\.json$/.test(url.pathname)) return (answers.number ?? (() => Response.json({ sid: "PN1" })))();
    if (url.pathname.endsWith("/IncomingPhoneNumbers.json")) {
      return (answers.numbers ?? (() => Response.json({ incoming_phone_numbers: [{ sid: "PN123abc", sms_url: "https://demo.twilio.com/welcome/sms/reply/", capabilities: { sms: true } }] })))();
    }
    return (answers.account ?? (() => Response.json({ friendly_name: "Alder Lawn", status: "active", type: "Full" })))();
  }) as typeof fetch;
  return { requests, fetcher };
}
const refused = () => Response.json({ code: 20003, message: "Authenticate" }, { status: 401 });

beforeEach(() => forgetTwilio());
afterEach(() => vi.unstubAllGlobals());

describe("checking a Twilio account before it's kept", () => {
  const good = { account_sid: SID_A, auth_token: "token-a-secret", from_number: "(540) 555-0100" };
  const problem = async (work: Promise<unknown>) => {
    const error = await work.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(TwilioProblem);
    return (error as Error).message;
  };

  it("reads the account and finds the number in it, with the token it was given", async () => {
    const t = twilio();
    expect(await checkTwilio({}, good, t.fetcher)).toEqual({ name: "Alder Lawn", from_number: "+15405550100", phone_sid: "PN123abc", sms_url: "https://demo.twilio.com/welcome/sms/reply/", trial: false });
    expect(t.requests.map((r) => [r.method, r.url.pathname + r.url.search, r.auth])).toEqual([
      ["GET", `/2010-04-01/Accounts/${SID_A}.json`, `${SID_A}:token-a-secret`],
      ["GET", `/2010-04-01/Accounts/${SID_A}/IncomingPhoneNumbers.json?PhoneNumber=%2B15405550100`, `${SID_A}:token-a-secret`],
    ]);
    expect((await checkTwilio({}, good, twilio({ account: () => Response.json({ friendly_name: "Trial", status: "active", type: "Trial" }) }).fetcher)).trial).toBe(true);
  });

  it("says what to fix without asking Twilio when the SID or number isn't one", async () => {
    const t = twilio();
    expect(await problem(checkTwilio({}, { ...good, account_sid: "SK123" }, t.fetcher))).toMatch(/^That doesn't look like an Account SID/);
    expect(await problem(checkTwilio({}, { ...good, from_number: "555-0100" }, t.fetcher))).toBe("Enter your Twilio number in full, with its area code, like (540) 555-0100.");
    expect(await problem(checkTwilio({}, { ...good, from_number: "555-0100", country: "CA" }, t.fetcher))).toBe("Enter your Twilio number in full, with its area code, like (540) 555-0100.");
    expect(await problem(checkTwilio({}, { ...good, from_number: "900123", country: "GB" }, t.fetcher))).toBe("Enter your Twilio number in full, with its area code, like 07700 900123.");
    expect(t.requests).toEqual([]);
  });

  it("finds a number typed as the company's country writes it", async () => {
    const t = twilio();
    expect((await checkTwilio({}, { ...good, from_number: "07700 900100", country: "GB" }, t.fetcher)).from_number).toBe("+447700900100");
    expect(t.requests[1]!.url.searchParams.get("PhoneNumber")).toBe("+447700900100");
    // A US company's is read as it always was.
    expect(await problem(checkTwilio({}, { ...good, from_number: "07700 900100", country: "US" }, t.fetcher))).toMatch(/^Enter your Twilio number in full/);
  });

  it("says so when Twilio turns the token down, the number isn't the account's, or it can't text", async () => {
    expect(await problem(checkTwilio({}, good, twilio({ account: refused }).fetcher))).toMatch(/^Twilio didn't accept that Account SID and Auth Token/);
    expect(await problem(checkTwilio({}, good, twilio({ numbers: () => Response.json({ incoming_phone_numbers: [] }) }).fetcher))).toBe(
      "(540) 555-0100 isn't a number in this Twilio account. Copy it from Phone Numbers → Active numbers in Twilio.",
    );
    expect(await problem(checkTwilio({}, good, twilio({ numbers: () => Response.json({ incoming_phone_numbers: [{ sid: "PN1", capabilities: { sms: false } }] }) }).fetcher))).toMatch(/^That Twilio number can't send texts/);
    expect(await problem(checkTwilio({}, good, twilio({ account: () => Response.json({ status: "suspended" }) }).fetcher))).toMatch(/^This Twilio account is suspended/);
    expect(await problem(checkTwilio({}, good, twilio({ account: () => new Response("", { status: 503 }) }).fetcher))).toBe("Twilio couldn't check these right now (error 503). Try again in a minute.");
    expect(await problem(checkTwilio({}, good, (async () => Promise.reject(new Error("offline"))) as typeof fetch))).toBe("Couldn't reach Twilio to check these. Try again in a minute.");
  });
});

describe("connecting it on the Apps page", () => {
  const put = (body: unknown, path = "/api/apps/twilio/account") => app.request(path, { method: "PUT", headers, body: JSON.stringify(body) }, env);
  const body = { account_sid: SID_A, auth_token: "token-a-secret", from_number: "540-555-0100" };

  it("keeps the account once Twilio accepts it, with the token encrypted and never sent back", async () => {
    const { state } = fakeDb();
    vi.stubGlobal("fetch", twilio().fetcher);
    const res = await put(body);
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer).toMatchObject({
      provider: "twilio", status: "connected", trial: false,
      twilio: { own: true, server: false, from_number: "+15405550100", webhook_url: HOOK, webhook_set: false, other_webhook: "https://demo.twilio.com/welcome/sms/reply/", reachable: true },
    });
    expect(JSON.stringify(answer)).not.toContain("token-a-secret");
    expect(state.integrations).toEqual([
      expect.objectContaining({
        company_id: ALDER, provider: "twilio", status: "connected", external_account_id: SID_A, account_label: "Alder Lawn · (540) 555-0100", connected_by: USER, last_error: null,
        settings: { from_number: "+15405550100", phone_sid: "PN123abc", sms_url: "https://demo.twilio.com/welcome/sms/reply/" },
      }),
    ]);
    expect(JSON.stringify(state.integrations)).not.toContain("token-a-secret");
    expect(state.secrets).toHaveLength(1);
    expect(state.secrets[0]!.ciphertext).not.toContain("token-a-secret");
    expect(await decryptJson(env, state.secrets[0]!.ciphertext)).toEqual({ api_key: "token-a-secret", extra: { account_sid: SID_A } });
    // And the company can text from then on.
    expect(await smsReady(env, ALDER)).toBe(true);
    expect(await smsReady(env, BIRCH)).toBe(false);
  });

  it("takes a UK company's number as it's written there", async () => {
    const { state } = fakeDb();
    state.countries[ALDER] = "GB";
    vi.stubGlobal("fetch", twilio().fetcher);
    const res = await put({ ...body, from_number: "07700 900100" });
    expect(res.status).toBe(200);
    expect(state.integrations[0]).toMatchObject({ account_label: "Alder Lawn · +447700900100", settings: { from_number: "+447700900100" } });
  });

  it("refuses credentials Twilio doesn't accept, saying why, and keeps nothing", async () => {
    const { state } = fakeDb();
    vi.stubGlobal("fetch", twilio({ account: refused }).fetcher);
    const res = await put(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Twilio didn't accept that Account SID and Auth Token/);
    expect(state.integrations).toEqual([]);
    expect(state.secrets).toEqual([]);
    expect(await smsReady(env, ALDER)).toBe(false);
  });

  it("doesn't take a bare key the way other apps do", async () => {
    fakeDb();
    const res = await put({ api_key: "token-a-secret" }, "/api/apps/twilio/key");
    expect([res.status, (await res.json()).error]).toEqual([400, "Twilio takes your Account SID, Auth Token and number."]);
  });

  it("points the number's incoming texts at this Crewtavo when asked", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    const t = twilio();
    vi.stubGlobal("fetch", t.fetcher);
    const res = await app.request("/api/apps/twilio/webhook", { method: "POST", headers }, env);
    expect(res.status).toBe(200);
    expect(t.requests.map((r) => [r.method, r.url.pathname, r.auth, r.form])).toEqual([
      ["POST", `/2010-04-01/Accounts/${SID_A}/IncomingPhoneNumbers/PNaaaaaa.json`, `${SID_A}:token-a-secret`, { SmsUrl: HOOK, SmsMethod: "POST" }],
    ]);
    expect((await res.json()).twilio).toMatchObject({ webhook_set: true, other_webhook: null });
    expect(state.integrations[0]!.settings.sms_url).toBe(HOOK);
    // Nothing to point without an account, and nowhere to point without a public address.
    fakeDb();
    forgetTwilio();
    expect((await app.request("/api/apps/twilio/webhook", { method: "POST", headers }, env)).status).toBe(409);
    expect((await app.request("/api/apps/twilio/webhook", { method: "POST", headers }, { ...env, APP_URL: "http://localhost:8787" })).status).toBe(400);
  });

  it("says plainly when Twilio won't change the number", async () => {
    await expect(setSmsWebhook({}, { sid: SID_A, token: "t" }, "PN1", HOOK, twilio({ number: refused }).fetcher)).rejects.toThrow("Twilio didn't accept the Auth Token anymore. Connect your Twilio account again, then try this.");
    await expect(setSmsWebhook({}, { sid: SID_A, token: "t" }, "PN1", HOOK, twilio({ number: () => new Response("", { status: 400 }) }).fetcher)).rejects.toThrow(/^Twilio couldn't change the number's settings \(error 400\)/);
  });
});

describe("sending a text", () => {
  it("goes through the company's own account when it has one, and the server's otherwise", async () => {
    const { connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    const t = twilio();
    vi.stubGlobal("fetch", t.fetcher);
    expect(await sendSms(withServer, { to: "+15405550163", body: "On our way", company: ALDER })).toEqual({ sent: true, id: "SM1" });
    expect(await sendSms(withServer, { to: "+15405550163", body: "On our way" }, BIRCH)).toEqual({ sent: true, id: "SM1" });
    expect(t.requests.map((r) => [r.url.pathname, r.auth, r.form.From])).toEqual([
      [`/2010-04-01/Accounts/${SID_A}/Messages.json`, `${SID_A}:token-a-secret`, "+15405550100"],
      [`/2010-04-01/Accounts/${withServer.TWILIO_ACCOUNT_SID}/Messages.json`, `${withServer.TWILIO_ACCOUNT_SID}:server-token`, "+15405550000"],
    ]);
  });

  it("asks Twilio to report what became of a text kept on a timeline, where Twilio can reach this Crewtavo", async () => {
    const { connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    const t = twilio();
    vi.stubGlobal("fetch", t.fetcher);
    const text = { to: "+15405550163", body: "Your quote is ready" };
    await sendSms(env, { ...text, company: ALDER, kept: true });
    await sendSms(withServer, { ...text, kept: true }, BIRCH);
    // A sign-in code or a notice to the team has no message to mark, and Twilio can't reach a private address.
    await sendSms(env, { ...text, company: ALDER });
    await sendSms({ ...env, APP_URL: "http://localhost:8787" }, { ...text, company: ALDER, kept: true });
    await sendSms({ ...env, APP_URL: "https://localhost:8787" }, { ...text, company: ALDER, kept: true });
    await sendSms({ ...env, APP_URL: undefined }, { ...text, company: ALDER, kept: true });
    expect(t.requests.map((r) => r.form.StatusCallback)).toEqual([`${HOOK}/status/${ALDER}`, `${HOOK}/status/${BIRCH}`, undefined, undefined, undefined, undefined]);
    // In development, a stand-in for Twilio on this machine can.
    expect(twilioStatusUrl({ APP_URL: "http://localhost:8102", LOOKALYKE_URL: "http://127.0.0.1:4102" }, ALDER)).toBe(`http://localhost:8102/api/webhooks/twilio/status/${ALDER}`);
  });

  it("goes to a number typed without its country code with the company's country's, and to a US company's numbers as typed", async () => {
    const { state, connect } = fakeDb();
    state.countries[BIRCH] = "GB";
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    await connect(BIRCH, SID_B, "token-b-secret", "+447700900100");
    const t = twilio();
    vi.stubGlobal("fetch", t.fetcher);
    for (const to of ["07700 900123", "020 7946 0018", "+44 7700 900123", "0044 7700 900123", "+15405550163"]) await sendSms(env, { to, body: "Hi", company: BIRCH });
    for (const to of ["(540) 555-0163", "540.555.0163", "011 44 7700 900123", "07700 900123"]) await sendSms(env, { to, body: "Hi" }, ALDER);
    expect(t.requests.map((r) => [r.form.From, r.form.To])).toEqual([
      ["+447700900100", "+447700900123"],
      ["+447700900100", "+442079460018"],
      ["+447700900100", "+447700900123"],
      ["+447700900100", "+447700900123"],
      ["+447700900100", "+15405550163"],
      ["+15405550100", "(540) 555-0163"],
      ["+15405550100", "540.555.0163"],
      ["+15405550100", "011 44 7700 900123"],
      ["+15405550100", "07700 900123"],
    ]);
  });

  it("is available to a company by its own account or the server's, and to nobody with neither", async () => {
    const { connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    expect([await smsReady(env, ALDER), await smsReady(env, BIRCH), await smsReady(env, null)]).toEqual([true, false, false]);
    expect([await smsReady(withServer, ALDER), await smsReady(withServer, BIRCH)]).toEqual([true, true]);
    vi.stubGlobal("fetch", twilio().fetcher);
    expect(await sendSms(env, { to: "+15405550163", body: "Hi", company: BIRCH })).toEqual({ sent: false, reason: "Texting isn't set up yet. An admin can connect Quo or Twilio in Apps." });
  });

  it("marks the company's account as needing attention when Twilio turns its token down, and clears that when a text goes", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    vi.stubGlobal("fetch", twilio({ message: refused }).fetcher);
    expect((await sendSms(env, { to: "+15405550163", body: "Hi", company: ALDER })).sent).toBe(false);
    expect(state.integrations[0]).toMatchObject({ status: "error", last_error: "The text provider refused it (401: Authenticate)." });
    vi.stubGlobal("fetch", twilio().fetcher);
    expect((await sendSms(env, { to: "+15405550163", body: "Hi", company: ALDER })).sent).toBe(true);
    expect(state.integrations[0]).toMatchObject({ status: "connected", last_error: null });
  });

  it("isn't done through an account that was disconnected, or a key saved without an Account SID", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    state.integrations[0]!.status = "disconnected";
    // Before accounts could be connected, a bare key could be saved for Twilio. It never sent anything.
    state.integrations.push({ company_id: BIRCH, provider: "twilio", status: "connected", external_account_id: null, settings: {} });
    state.secrets.push({ company_id: BIRCH, provider: "twilio", ciphertext: await encryptJson(env, { api_key: "an-old-key" }) });
    expect([await smsReady(env, ALDER), await smsReady(env, BIRCH)]).toEqual([false, false]);
  });
});

describe("a text that comes in", () => {
  const form = (extra: Record<string, string> = {}) => ({ From: "+15405550163", Body: "Running late?", MessageSid: "SM9", ...extra });
  const post = async (params: Record<string, string>, token: string, on: Env = env) =>
    app.request("/api/webhooks/twilio", { method: "POST", headers: { "x-twilio-signature": await twilioSignature(token, HOOK, params) }, body: new URLSearchParams(params) }, on);

  it("belongs to the company whose own account signed it, and is filed for that company alone", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    await connect(BIRCH, SID_B, "token-b-secret", "+15405550200");
    const res = await post(form({ AccountSid: SID_A, To: "+15405550100" }), "token-a-secret");
    expect(res.status).toBe(200);
    // Ana is a client of both companies; only Alder's number was texted.
    expect(state.messages.map((m) => [m.company_id, m.client_id, m.body])).toEqual([[ALDER, "client-a", "Running late?"]]);
  });

  it("is refused when the signature isn't the named account's, whoever else's it is", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    await connect(BIRCH, SID_B, "token-b-secret", "+15405550200");
    const toAlder = form({ AccountSid: SID_A, To: "+15405550100" });
    // Birch's own token can't sign a text for Alder, nor can a made-up one, nor none at all.
    expect((await post(toAlder, "token-b-secret")).status).toBe(403);
    expect((await post(toAlder, "guess")).status).toBe(403);
    expect((await app.request("/api/webhooks/twilio", { method: "POST", body: new URLSearchParams(toAlder) }, env)).status).toBe(403);
    // Nor does naming Alder's account with another number of that account's reach Alder.
    expect((await post(form({ AccountSid: SID_A, To: "+15405550999" }), "token-a-secret")).status).toBe(501);
    expect(state.messages).toEqual([]);
  });

  it("still comes in on the server's number, for every company that shares it", async () => {
    const { state, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    const res = await post(form({ AccountSid: withServer.TWILIO_ACCOUNT_SID!, To: "+15405550000" }), "server-token", withServer);
    expect(res.status).toBe(200);
    expect(state.messages.map((m) => m.client_id)).toEqual(["client-a", "client-b"]);
    // The server's token doesn't make a text for a company's own number that company's.
    expect((await post(form({ AccountSid: SID_A, To: "+15405550100" }), "wrong", withServer)).status).toBe(403);
  });

  it("from a number nobody knows is kept for the company whose number it texted", async () => {
    const { state, connect } = fakeDb();
    await connect(BIRCH, SID_B, "token-b-secret", "+15405550200");
    const res = await post({ From: "+15405550177", Body: "Do you do gutters?", MessageSid: "SM10", AccountSid: SID_B, To: "+15405550200" }, "token-b-secret");
    expect(res.status).toBe(200);
    expect(state.unknown).toEqual([{ company_id: BIRCH, from_phone: "+15405550177", phone_key: "5405550177", body: "Do you do gutters?", external_id: "SM10" }]);
    expect(state.messages).toEqual([]);
  });

  it("is refused with nothing set up at all", async () => {
    fakeDb();
    expect((await post(form(), "anything")).status).toBe(501);
  });

  it("names the accounts a request could be from by its AccountSid and To, and nobody's own without both", async () => {
    const { db, connect } = fakeDb();
    await connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    await connect(BIRCH, SID_A, "token-a-secret", "+15405550100");
    // Two companies on one account and number get the text together.
    expect(await inboundAccounts(env, db, { AccountSid: SID_A, To: "(540) 555-0100" })).toEqual([{ token: "token-a-secret", companies: [ALDER, BIRCH] }]);
    expect(await inboundAccounts(env, db, { AccountSid: SID_A })).toEqual([]);
    expect(await inboundAccounts(env, db, { To: "+15405550100" })).toEqual([]);
    expect(await inboundAccounts(withServer, db, { AccountSid: SID_B, To: "+15405550100" })).toEqual([{ token: "server-token", companies: null }]);
  });
});

describe("what Twilio reports about a text it took", () => {
  const SENT = `${HOOK}/status/${ALDER}`;
  const report = (status: string, extra: Record<string, string> = {}) => ({ AccountSid: SID_A, From: "+15405550100", To: "+15405550163", MessageSid: "SM1", SmsSid: "SM1", MessageStatus: status, SmsStatus: status, ...extra });
  const post = async (params: Record<string, string>, token = "token-a-secret", url = SENT, on: Env = env) =>
    app.request(url.replace("https://crew.example.com", ""), { method: "POST", headers: { "x-twilio-signature": await twilioSignature(token, url, params) }, body: new URLSearchParams(params) }, on);
  const text = (more: Record<string, unknown> = {}) => ({ id: "m1", company_id: ALDER, client_id: "client-a", channel: "sms", direction: "out", status: "sent", external_id: "SM1", recipients: [{ to: "+15405550163", name: "Ana" }], ...more });
  const setUp = async (...messages: Array<Record<string, unknown>>) => {
    const made = fakeDb();
    await made.connect(ALDER, SID_A, "token-a-secret", "+15405550100");
    made.state.messages.push(...messages);
    return made;
  };
  const now = (state: { messages: Array<Record<string, any>> }) => state.messages.map((m) => [m.status, m.recipients]);
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout"] }));
  /** Until a report has looked for its message once and is waiting to look again. */
  const looking = async () => {
    while (!vi.getTimerCount()) await new Promise((resolve) => setImmediate(resolve));
  };
  afterEach(() => vi.useRealTimers());

  it("marks a text that didn't arrive as failed, with why in words for the office", async () => {
    const { state } = await setUp(text());
    const res = await post(report("undelivered", { ErrorCode: "30003" }));
    expect([res.status, await res.text()]).toEqual([200, ""]);
    expect(now(state)).toEqual([["failed", [{ to: "+15405550163", name: "Ana", failed: true, reason: "Their phone is off or out of reach (Twilio error 30003)." }]]]);
    // An unregistered US number is the one that fails every text after Twilio takes it.
    state.messages[0] = text();
    await post(report("failed", { ErrorCode: "30034" }));
    expect(state.messages[0]!.recipients[0].reason).toBe("Your Twilio number isn't registered to text US numbers yet (A2P 10DLC). Finish the registration in Twilio (Twilio error 30034).");
    state.messages[0] = text();
    await post(report("failed", { ErrorCode: "39999" }));
    expect(state.messages[0]!.recipients[0].reason).toBe("Twilio couldn't deliver it (Twilio error 39999).");
    state.messages[0] = text({ recipients: null });
    await post(report("failed"));
    expect(now(state)).toEqual([["failed", null]]);
  });

  it("marks one that arrived as delivered, and leaves it alone while it's on its way", async () => {
    const { state } = await setUp(text());
    for (const status of ["queued", "sending", "sent"]) expect((await post(report(status))).status).toBe(200);
    expect(state.messages[0]!.status).toBe("sent");
    expect((await post(report("delivered"))).status).toBe(200);
    expect(now(state)).toEqual([["delivered", [{ to: "+15405550163", name: "Ana" }]]]);
  });

  it("keeps the first word on how it ended, and a repeat changes nothing", async () => {
    const { state, queries } = await setUp(text());
    await post(report("delivered"));
    await post(report("undelivered", { ErrorCode: "30003" }));
    await post(report("delivered"));
    expect(now(state)).toEqual([["delivered", [{ to: "+15405550163", name: "Ana" }]]]);
    state.messages[0] = text();
    await post(report("failed", { ErrorCode: "30005" }));
    const failed = structuredClone(state.messages[0]);
    const before = queries.length;
    await post(report("delivered"));
    await post(report("failed", { ErrorCode: "30003" }));
    expect(state.messages[0]).toEqual(failed);
    expect(queries.slice(before).filter((q) => q.table === "messages" && verb(q) === "update")).toEqual([]);
  });

  it("marks only the person whose text failed when it went to several", async () => {
    const both = [{ to: "+15405550163", name: "Ana", id: "SM1" }, { to: "+15405550333", name: "Bo", id: "SM2" }];
    const { state } = await setUp(text({ recipients: both }));
    await post(report("delivered"));
    await post(report("undelivered", { MessageSid: "SM2", ErrorCode: "30006" }));
    const marked = [both[0], { ...both[1], failed: true, reason: "That number is a landline, or its carrier can't be reached (Twilio error 30006)." }];
    expect(now(state)).toEqual([["delivered", marked]]);
    // A failure stands, and its repeat with another reason changes nothing.
    await post(report("delivered", { MessageSid: "SM2" }));
    await post(report("failed", { MessageSid: "SM2", ErrorCode: "30003" }));
    expect(now(state)).toEqual([["delivered", marked]]);
    // Nobody got it: the whole text failed.
    state.messages[0] = text({ recipients: both });
    await post(report("failed", { ErrorCode: "30003" }));
    expect(state.messages[0]!.status).toBe("sent");
    await post(report("failed", { MessageSid: "SM2", ErrorCode: "30003" }));
    expect(state.messages[0]!.status).toBe("failed");
  });

  it("waits a moment for a text whose message is still being saved", async () => {
    const { state } = await setUp();
    const answered = post(report("undelivered", { ErrorCode: "30003" }));
    await looking();
    state.messages.push(text());
    await vi.advanceTimersByTimeAsync(3000);
    expect((await answered).status).toBe(200);
    expect(state.messages[0]!.status).toBe("failed");
  });

  it("answers 200 and changes nothing for a text it has no message for, or another company's", async () => {
    const { state } = await setUp(text({ company_id: BIRCH }), text({ id: "m2", external_id: "SM7" }), text({ id: "m3", channel: "email" }));
    const before = structuredClone(state.messages);
    const answered = post(report("failed", { ErrorCode: "30003" }));
    await looking();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await answered).status).toBe(200);
    expect(state.messages).toEqual(before);
  });

  it("is refused unless that company's Twilio account signed the address it was given", async () => {
    const { state, connect } = await setUp(text());
    await connect(BIRCH, SID_B, "token-b-secret", "+15405550200");
    const failed = report("failed", { ErrorCode: "30003" });
    expect((await post(failed, "guess")).status).toBe(403);
    expect((await post(failed, "token-b-secret")).status).toBe(403);
    expect((await app.request(`/api/webhooks/twilio/status/${ALDER}`, { method: "POST", body: new URLSearchParams(failed) }, env)).status).toBe(403);
    // Signed for the address of incoming texts, or for another company's, it isn't this one.
    expect((await app.request(`/api/webhooks/twilio/status/${ALDER}`, { method: "POST", headers: { "x-twilio-signature": await twilioSignature("token-a-secret", `${HOOK}/status/${BIRCH}`, failed) }, body: new URLSearchParams(failed) }, env)).status).toBe(403);
    expect((await app.request("/api/webhooks/twilio/status/nobody", { method: "POST", body: new URLSearchParams(failed) }, env)).status).toBe(404);
    expect(state.messages[0]!.status).toBe("sent");
  });

  it("is taken for a company on the server's number, signed with the server's token", async () => {
    const { state } = await setUp(text({ company_id: BIRCH }));
    const res = await post(report("undelivered", { AccountSid: withServer.TWILIO_ACCOUNT_SID!, From: "+15405550000", ErrorCode: "30003" }), "server-token", `${HOOK}/status/${BIRCH}`, withServer);
    expect(res.status).toBe(200);
    expect(state.messages[0]!.status).toBe("failed");
  });

  it("is taken at the address for incoming texts too, where an owner may have pointed Twilio's reports", async () => {
    const { state } = await setUp(text());
    // On a report, From is the business's number and To the client's.
    const res = await post(report("undelivered", { ErrorCode: "30003" }), "token-a-secret", HOOK);
    expect(res.status).toBe(200);
    expect(state.messages.map((m) => m.status)).toEqual(["failed"]);
    expect((await post(report("sent"), "token-a-secret", HOOK)).status).toBe(200);
    expect((await post(report("delivered"), "guess", HOOK)).status).toBe(403);
    // Nothing is filed as a text from the client.
    expect(state.messages).toHaveLength(1);
    expect(state.unknown).toEqual([]);
  });
});
