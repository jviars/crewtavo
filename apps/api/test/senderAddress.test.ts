/**
 * No marketing email without the sender's postal address (services/senderAddress.ts): a campaign
 * isn't sent, scheduled or tested, an automated marketing campaign isn't turned on or sent, and a
 * review ask or referral ask doesn't go by email, until the company's address is complete. Each
 * refusal says where to add it, and the ones that send by themselves tell the owners once on the
 * bell instead of going quiet. PostgREST is a stand-in answering over fetch, and sending is mocked.
 */
import { AUTOMATED_CAMPAIGNS } from "@crewtavo/core/campaigns";
import { SENDER_ADDRESS_NEEDED } from "@crewtavo/core/postcards";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  emailReady: vi.fn(async () => true),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));

const notify = await import("../src/lib/notify");
const { executeRun } = await import("../src/services/automations");
const { processCampaigns } = await import("../src/services/campaigns");
const { ReferralAskRefused, sendReferralAsk } = await import("../src/services/referrals");
const { sendReviewRequest } = await import("../src/services/reviews");
const { ADDRESS_NOTICE_TITLE, senderAddressProblem } = await import("../src/services/senderAddress");
const { adminClient } = await import("../src/lib/supabase");
const { runTask } = await import("../src/tasks");
const { app } = await import("../src/app");
const sendEmail = vi.mocked(notify.sendEmail);
const sendSms = vi.mocked(notify.sendSms);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA_ID = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000e1";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000f1";
const FULL = { line1: "1 Main St", city: "Radford", region: "VA", postal_code: "24141" };

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: any;
}

const ANA: Row = {
  id: ANA_ID, company_id: CO, display_name: "Ana Smith", email: "ana@example.com", phone: "+15405550100", tags: [], status: "active", lead_source: null,
  review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null, reviewed_at: null,
};
/** A company that skipped its address in Settings, unless one is given. */
const company = (address: Row | null = null, settings: Row = {}): Row => ({
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: "America/New_York", currency: "USD", trade_preset: "lawn_care", address,
  settings: { review_url: "https://g.page/r/acme/review", marketing: { enabled: true }, referrals: { reward: { kind: "amount", value: 25 } }, ...settings },
});

/** PostgREST over fetch: GETs answer from `tables` (filtered by eq. and in.), functions from `rpc` (true when not given). Every call is kept. */
function serve(world: { tables?: Record<string, Row[]>; rpc?: Record<string, (body: any) => unknown> } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (path === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
    if (path.startsWith("rpc/")) {
      const fn = world.rpc?.[path.slice(4)];
      return Response.json(fn ? (fn(call.body) ?? null) : true);
    }
    if (call.method === "GET") {
      let rows = tables[path] ?? [];
      for (const [column, filter] of url.searchParams) {
        if (!rows.some((r) => column in r)) continue;
        if (filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
        else if (filter.startsWith("in.(")) rows = rows.filter((r) => filter.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")).includes(String(r[column])));
      }
      return Response.json(rows);
    }
    return Response.json([]);
  });
  return calls;
}
const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);
/** The bell notices added, as [who, title, link]. */
const notices = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === "notifications").flatMap((c) => c.body as Row[]).map((n) => [n.user_id, n.title, n.link]);
const TOLD = [["owner-1", ADDRESS_NOTICE_TITLE, "/settings?tab=company"], ["admin-1", ADDRESS_NOTICE_TITLE, "/settings?tab=company"]];
const team = [{ user_id: "owner-1", role: "owner" }, { user_id: "admin-1", role: "admin" }];

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(`/api${path}`, {
    method: init.method ?? "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" },
    body: JSON.stringify(init.body ?? {}),
  }, env);
const owner = { role: "owner", role_id: null, subcontractor_id: null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") }); // 11am in New York
  sendEmail.mockClear().mockImplementation(async () => ({ sent: true, id: "email-1" }));
  sendSms.mockClear().mockImplementation(async () => ({ sent: true, id: "sms-1" }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a company's address, as a marketing email needs it", () => {
  it("is complete with a street or a PO box, a city, a state and a ZIP code", () => {
    expect(senderAddressProblem({ address: FULL })).toBeNull();
    expect(senderAddressProblem({ address: { line1: "PO Box 12", city: "Radford", region: "Virginia", postal_code: "24141-0012" } })).toBeNull();
    for (const address of [null, {}, { line1: "1 Main St" }, { ...FULL, line1: " " }, { ...FULL, city: "" }, { ...FULL, region: null }, { ...FULL, postal_code: undefined }]) {
      expect(senderAddressProblem({ address }), JSON.stringify(address)).toBe(SENDER_ADDRESS_NEEDED);
    }
    expect(SENDER_ADDRESS_NEEDED).toBe("Add your company's full postal address in Settings → Company first: every marketing email has to show it. A PO box is fine.");
  });

  it("counts when it's all there though a postcard couldn't be mailed from it", () => {
    // Lob's rules (two-letter US states, 64 characters a line) are for cards, not for a footer.
    expect(senderAddressProblem({ address: { ...FULL, region: "Va." } })).toBeNull();
    expect(senderAddressProblem({ address: { ...FULL, line1: `${"Long ".repeat(15)}Road` } })).toBeNull();
    // Outside the US there may be no state.
    expect(senderAddressProblem({ address: { line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP", country: "United Kingdom" } })).toBeNull();
    expect(senderAddressProblem({ address: { line1: "12 High Street", city: "Leeds", country: "United Kingdom" } })).toBe(SENDER_ADDRESS_NEEDED);
  });

  it("is read as addresses are written in the business's country, since the address doesn't say it", () => {
    const leeds = { line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP" };
    // A UK address usually has no county.
    expect(senderAddressProblem({ address: leeds, country: "GB" })).toBeNull();
    expect(senderAddressProblem({ address: { ...leeds, postal_code: "" }, country: "GB" })).toBe(SENDER_ADDRESS_NEEDED);
    expect(senderAddressProblem({ address: { line1: "Hauptstraße 1", city: "Berlin", postal_code: "10115" }, country: "DE" })).toBeNull();
    // A Canadian one has its province, as a US one has its state.
    const toronto = { line1: "1 King St W", city: "Toronto", postal_code: "M5H 1A1" };
    expect(senderAddressProblem({ address: toronto, country: "CA" })).toBe(SENDER_ADDRESS_NEEDED);
    expect(senderAddressProblem({ address: { ...toronto, region: "ON" }, country: "CA" })).toBeNull();
    for (const country of ["US", null, undefined]) {
      expect(senderAddressProblem({ address: { ...FULL, region: null }, country }), String(country)).toBe(SENDER_ADDRESS_NEEDED);
      expect(senderAddressProblem({ address: FULL, country }), String(country)).toBeNull();
    }
    // An address that says its country goes by that, as before.
    expect(senderAddressProblem({ address: { ...leeds, country: "United Kingdom" }, country: "US" })).toBeNull();
    expect(senderAddressProblem({ address: { ...leeds, country: "US" }, country: "GB" })).toBe(SENDER_ADDRESS_NEEDED);
  });
});

describe("a campaign from a company with no address", () => {
  const draft = { id: CAMPAIGN, company_id: CO, kind: "one_off", status: "draft", name: "Spring", subject: "Spring cleanup", body: "Hi {{client.first_name}}, spots are filling up.", audience: {}, scheduled_at: null };
  const tables = (address: Row | null) => ({ memberships: [owner], companies: [company(address)], campaigns: [draft], profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }] });

  it("isn't sent, scheduled or tested, and says where to add the address", async () => {
    for (const [path, body] of [[`/campaigns/${CAMPAIGN}/send`, {}], [`/campaigns/${CAMPAIGN}/send`, { scheduled_at: "2026-11-01T15:00:00Z" }], [`/campaigns/${CAMPAIGN}/test`, {}]] as const) {
      const calls = serve({ tables: tables(null) });
      const res = await call(path, { body });
      expect([res.status, await res.json()], path).toEqual([400, { error: SENDER_ADDRESS_NEEDED }]);
      expect(calls.filter((c) => c.method === "POST" && c.path === "campaign_recipients")).toEqual([]);
    }
    expect(sendEmail).not.toHaveBeenCalled();
    // With the address in, the test goes, and its footer shows it.
    serve({ tables: tables(FULL) });
    expect((await call(`/campaigns/${CAMPAIGN}/test`)).status).toBe(200);
    expect(sendEmail.mock.calls[0]![1].text).toContain("Acme Lawn · 1 Main St, Radford, VA, 24141");
  });

  it("goes from a UK business whose address has no county", async () => {
    const leeds = { line1: "12 High Street", city: "Leeds", postal_code: "LS1 4AP" };
    serve({ tables: { ...tables(null), companies: [{ ...company(leeds), country: "GB" }] } });
    expect((await call(`/campaigns/${CAMPAIGN}/test`)).status).toBe(200);
    expect(sendEmail.mock.calls[0]![1].text).toContain("Acme Lawn · 12 High Street, Leeds, LS1 4AP");
    // The same address in the US is missing its state.
    serve({ tables: { ...tables(null), companies: [{ ...company(leeds), country: "US" }] } });
    expect(await (await call(`/campaigns/${CAMPAIGN}/test`)).json()).toEqual({ error: SENDER_ADDRESS_NEEDED });
  });

  it("doesn't go out when it was scheduled before the address was taken away, and the owners hear once", async () => {
    const sending = { id: CAMPAIGN, company_id: CO, subject: "Spring cleanup", body: "Hi", status: "sending", company: { name: "Acme Lawn", email: null, phone: null, address: {}, settings: { marketing: { enabled: true } } } };
    const recipients = [1, 2].map((id) => ({ id, campaign_id: CAMPAIGN, company_id: CO, client_id: `client-${id}`, email: `person${id}@example.com`, name: `Person ${id}`, status: "sending", claim_token: "claim-1", track_token: `5f0c2b1e-0000-4000-8000-00000000000${id}` }));
    let claims = 0;
    const calls = serve({ tables: { campaigns: [sending], memberships: team }, rpc: { claim_campaign_recipients: () => (claims++ ? [] : recipients) } });
    expect(await processCampaigns(env, { campaignId: CAMPAIGN, baseUrl: env.APP_URL })).toMatchObject({ sent: 0, failed: 2 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls(calls, "finish_campaign_recipients").map((b) => [b.p_ids, b.p_status, b.p_error])).toEqual([[[1], "failed", SENDER_ADDRESS_NEEDED], [[2], "failed", SENDER_ADDRESS_NEEDED]]);
    expect(notices(calls)).toEqual(TOLD);
  });
});

describe("an automated marketing campaign at a company with no address", () => {
  const ruleOf = (key: keyof typeof AUTOMATED_CAMPAIGNS, over: Row = {}): Row => {
    const { template_key, ...starter } = AUTOMATED_CAMPAIGNS[key].starter;
    return { id: `rule-${key}`, company_id: CO, template_key, ...starter, enabled: true, run_count: 0, ...over };
  };
  const routes = (address: Row | null, rules: Row[]) =>
    serve({ tables: { memberships: [owner], automation_rules: rules, companies: [company(address)], profiles: [{ user_id: USER, email: "mia@acme.example", full_name: "Mia Owner" }] }, rpc: { ensure_automated_campaign: () => "camp-1", inactive_client_count: () => 0 } });

  it("can't be turned on or tested, but can be turned off and edited", async () => {
    for (const key of ["reengage", "win_back"] as const) {
      const calls = routes(null, [ruleOf(key, { enabled: false })]);
      const res = await call(`/campaigns/automated/${key}`, { method: "PUT", body: { enabled: true } });
      expect([res.status, await res.json()], key).toEqual([400, { error: SENDER_ADDRESS_NEEDED }]);
      expect(calls.filter((c) => c.method === "PATCH" && c.path === "automation_rules")).toEqual([]);
      const test = await call(`/campaigns/automated/${key}/test`, { body: { subject: "We miss you", body: "Hi {{client.first_name}}, come back soon." } });
      expect([test.status, await test.json()], key).toEqual([400, { error: SENDER_ADDRESS_NEEDED }]);
    }
    expect(sendEmail).not.toHaveBeenCalled();
    routes(null, [ruleOf("reengage")]);
    expect((await call("/campaigns/automated/reengage", { method: "PUT", body: { enabled: false } })).status).toBe(200);
    // Close pending quotes follows up a quote the client asked for: it isn't held to this.
    routes(null, [ruleOf("close_quotes", { enabled: false })]);
    expect((await call("/campaigns/automated/close_quotes", { method: "PUT", body: { enabled: true } })).status).toBe(200);
  });

  it("that was on already fails with what to do, lets the client go for later, and tells the owners once", async () => {
    const run = { id: 41, company_id: CO, rule_id: "rule-reengage", subject_type: "client", subject_id: ANA_ID, activity_id: null, result: [], claim_token: "claim-1" };
    const world = (more: Record<string, Row[]> = {}) =>
      serve({ tables: { companies: [company(null)], automation_rules: [ruleOf("reengage")], clients: [ANA], visits: [{ company_id: CO, status: "completed", kind: "job", completed_at: "2025-09-01T15:00:00Z" }], memberships: team, ...more } });
    let calls = world();
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("failed");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(rpcCalls(calls, "begin_campaign_send")).toEqual([]);
    expect(rpcCalls(calls, "finish_automation_run")[0]).toMatchObject({ p_status: "failed", p_error: SENDER_ADDRESS_NEEDED });
    // They're emailed once the address is in: their stretch isn't used up.
    expect(calls.filter((c) => c.method === "DELETE" && c.path === "inactive_client_marks").map((c) => c.params.get("run_id"))).toEqual(["eq.41"]);
    expect(notices(calls)).toEqual(TOLD);

    // The next client's run fails the same way, and the bell already has it.
    calls = world({ notifications: [{ id: "n-1", company_id: CO, title: ADDRESS_NOTICE_TITLE }] });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("failed");
    expect(notices(calls)).toEqual([]);
  });
});

describe("a review ask from a company with no address", () => {
  const asking = (address: Row | null = null) => serve({ tables: { companies: [company(address)], memberships: team }, rpc: { begin_review_request: () => "rr-1", last_review_ask: () => null } });
  const ask = (over: Partial<Parameters<typeof sendReviewRequest>[2]> = {}) =>
    sendReviewRequest(env, adminClient(env), { companyId: CO, client: ANA as never, channel: "email", baseUrl: env.APP_URL!, automatic: false, createdBy: null, ...over });

  it("by hand isn't emailed, and says where to add the address; by text it goes", async () => {
    let calls = asking();
    await expect(ask()).rejects.toThrow(SENDER_ADDRESS_NEEDED);
    await expect(ask({ channel: "both" })).rejects.toThrow(SENDER_ADDRESS_NEEDED);
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
    // Whoever asked is told on the spot, so the bell isn't used.
    expect(notices(calls)).toEqual([]);
    calls = asking();
    expect(await ask({ channel: "sms" })).toMatchObject({ sent: true, detail: "Asked for a review by text" });
    asking(FULL);
    expect(await ask({ channel: "both" })).toMatchObject({ sent: true, detail: "Asked for a review by text and email" });
  });

  it("from a rule goes by text alone where it can, fails where it can't, and the owners hear once", async () => {
    let calls = asking();
    expect(await ask({ automatic: true, channel: "both" })).toMatchObject({ sent: true, detail: "Asked for a review by text" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(notices(calls)).toEqual(TOLD);
    calls = asking();
    await expect(ask({ automatic: true, channel: "email" })).rejects.toThrow(SENDER_ADDRESS_NEEDED);
    expect(rpcCalls(calls, "begin_review_request")).toEqual([]);
    expect(notices(calls)).toEqual(TOLD);
    // A client with no email address is skipped for that, as ever: the address isn't why.
    calls = asking();
    expect(await ask({ automatic: true, channel: "email", client: { ...ANA, email: null } as never })).toMatchObject({ skipped: true, detail: "Ana Smith has no email address" });
    expect(notices(calls)).toEqual([]);
  });

  it("stops a reminder that was to go by email, saying why, and keeps one going by text", async () => {
    const due = (channel: string): Row => ({ id: "rr-1", company_id: CO, client_id: ANA_ID, channel, status: "sent", clicked_at: null, sent_at: "2026-10-24T15:00:00Z", reminders_sent: 0, reminder_claim: "claim-1", link_token: "tok" });
    const remind = (channel: string) => serve({ tables: { companies: [company(null)], clients: [ANA], memberships: team }, rpc: { claim_review_reminders: () => [due(channel)], start_review_reminder: () => true, finish_review_reminder: () => true } });
    vi.setSystemTime(new Date("2026-10-27T17:30:00Z")); // 1:30pm in New York
    let calls = remind("email");
    expect(await runTask("reviews", env)).toMatchObject({ claimed: 1, stopped: 1 });
    expect(rpcCalls(calls, "finish_review_reminder")).toEqual([{ p_id: "rr-1", p_token: "claim-1", p_outcome: "stop", p_note: "Your company's address is missing" }]);
    expect(notices(calls)).toEqual(TOLD);
    expect(sendEmail).not.toHaveBeenCalled();
    calls = remind("both");
    expect(await runTask("reviews", env)).toMatchObject({ claimed: 1, sent: 1 });
    expect(sendSms).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("a referral ask from a company with no address", () => {
  const asking = (address: Row | null = null) => serve({ tables: { companies: [company(address)], memberships: team }, rpc: { begin_referral_ask: () => "ra-1", last_referral_ask: () => null } });
  const ask = (automatic: boolean) => sendReferralAsk(env, adminClient(env), { companyId: CO, client: ANA as never, baseUrl: env.APP_URL!, automatic, createdBy: null });

  it("isn't sent: by hand it's refused with where to add it, and from a rule it fails and the owners hear once", async () => {
    let calls = asking();
    const refusal = await ask(false).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReferralAskRefused);
    expect((refusal as Error).message).toBe(SENDER_ADDRESS_NEEDED);
    expect(notices(calls)).toEqual([]);
    calls = asking();
    await expect(ask(true)).rejects.toThrow(SENDER_ADDRESS_NEEDED);
    expect(rpcCalls(calls, "begin_referral_ask")).toEqual([]);
    expect(notices(calls)).toEqual(TOLD);
    expect(sendEmail).not.toHaveBeenCalled();
    asking(FULL);
    expect(await ask(true)).toMatchObject({ sent: true, detail: "Asked for referrals by email" });
  });
});
