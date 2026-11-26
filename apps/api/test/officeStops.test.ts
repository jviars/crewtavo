/**
 * Texts turned off by the office (services/textsOff.ts setTexts, POST /clients/:id/texts): someone
 * who phoned or emailed "please stop texting me" is put on the same stop list as someone who texted
 * STOP, with who set it and how they were asked; texts come back on by hand only for a stop Twilio
 * doesn't have. And the stop holds wherever a text to a client starts: a visit reminder, a visit
 * notice, an on-my-way text, a quote, an invoice, a review ask, a booking's confirmation and a text
 * typed in Messages. PostgREST is a stand-in answering over fetch, and sending is mocked.
 */
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
const { confirmBooking } = await import("../src/services/onlineBooking");
const { sendReviewRequest } = await import("../src/services/reviews");
const { adminClient } = await import("../src/lib/supabase");
const { app } = await import("../src/app");
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
const MO_ID = "00000000-0000-4000-8000-0000000000b1";
const USER = "00000000-0000-4000-8000-0000000000e1";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: any;
}

const ANA: Row = {
  id: ANA_ID, company_id: CO, display_name: "Ana Smith", email: "ana@example.com", phone: "(540) 555-0100", tags: [], status: "active", lead_source: null,
  review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null, reviewed_at: null,
};
const MO: Row = { id: MO_ID, company_id: CO, client_id: ANA_ID, name: "Mo Manager", email: null, phone: "540-555-0163", notify_email: false, notify_sms: true };
const company: Row = {
  id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: "America/New_York", currency: "USD", trade_preset: "lawn_care",
  address: { line1: "1 Main St", city: "Radford", region: "VA", postal_code: "24141" },
  settings: { review_url: "https://g.page/r/acme/review", marketing: { enabled: true } },
};
/** Ana's number as the stop list keeps it once the office has turned her texts off. */
const officeStop = (phoneKey = "5405550100"): Row => ({ company_id: CO, phone_key: phoneKey, phone: "(540) 555-0100", stopped_at: "2026-10-20T15:00:00Z", source: "office", how: "phone", note: null, set_by: USER, set_by_name: "Dana Office" });

/** PostgREST over fetch: GETs answer from `tables` (filtered by eq. and in.), functions from `rpc`; `answer` can step in first. Every call is kept. */
function serve(world: { tables?: Record<string, Row[]>; rpc?: Record<string, (body: any) => unknown>; answer?: (call: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const tables = world.tables ?? {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // a form
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, params: url.searchParams, body };
    calls.push(call);
    const own = world.answer?.(call);
    if (own !== undefined) return own instanceof Response ? own : Response.json(own);
    if (path === "/auth/v1/user") return Response.json({ id: USER, aud: "authenticated", role: "authenticated" });
    if (path.startsWith("rpc/")) {
      const fn = world.rpc?.[path.slice(4)];
      return Response.json(fn ? (fn(body) ?? null) : true);
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

const writes = (calls: Call[], method: string, table: string) => calls.filter((c) => c.method === method && c.path === table);
const rpcCalls = (calls: Call[], fn: string) => calls.filter((c) => c.path === `rpc/${fn}`).map((c) => c.body);

// A session Supabase Auth vouches for: getClaims asks /auth/v1/user about HS256 tokens.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: USER, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;
const call = (path: string, body: unknown) =>
  app.request(`/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Company-Id": CO, "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
const member = (role: string) => ({ role, role_id: null, subcontractor_id: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") }); // 11am in New York
  sendSms.mockClear().mockImplementation(async () => ({ sent: true, id: "sms-1" }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the office's Texts switch", () => {
  const world = (over: { role?: string; stops?: Row[]; clients?: Row[] } = {}) => ({
    tables: {
      memberships: [member(over.role ?? "office")], profiles: [{ user_id: USER, full_name: "Dana Office" }],
      clients: over.clients ?? [ANA], client_contacts: [MO], sms_stops: over.stops ?? [],
    },
  });
  /** As the database answers a stop that's new: the row it added. */
  const added = (c: Call) => (c.method === "POST" && c.path === "sms_stops" ? [{ phone_key: c.body.phone_key }] : undefined);
  const removed = (c: Call) => (c.method === "DELETE" && c.path === "sms_stops" ? [{ phone_key: "5405550100" }] : undefined);

  it("turns a client's texts off for someone who asked by phone, keeping who set it and how", async () => {
    const calls = serve({ ...world(), answer: added });
    const res = await call(`/clients/${ANA_ID}/texts`, { on: false, how: "phone", note: "Called Tuesday" });
    expect([res.status, await res.json()]).toEqual([200, { on: false, phone: "(540) 555-0100" }]);
    // On the stop list every send checks, as the office's.
    expect(writes(calls, "POST", "sms_stops").map((c) => c.body)).toEqual([
      { company_id: CO, phone_key: "5405550100", phone: "(540) 555-0100", source: "office", how: "phone", note: "Called Tuesday", set_by: USER, set_by_name: "Dana Office" },
    ]);
    // The client is marked, as a STOP marks them.
    const marked = writes(calls, "PATCH", "clients");
    expect(marked.map((c) => [c.params.get("id"), c.params.get("sms_opt_out_at"), typeof c.body.sms_opt_out_at])).toEqual([[`in.(${ANA_ID})`, "is.null", "string"]]);
    // And it's kept: in the record of changes, and on the client's timeline.
    expect(writes(calls, "POST", "sms_stop_changes").map((c) => c.body)).toEqual([
      { company_id: CO, phone_key: "5405550100", phone: "(540) 555-0100", texts_on: false, source: "office", how: "phone", note: "Called Tuesday", set_by: USER, set_by_name: "Dana Office" },
    ]);
    expect(writes(calls, "POST", "messages").map((c) => [c.body.channel, c.body.sent_by, c.body.body])).toEqual([
      ["note", USER, "Dana Office turned texts off for Ana Smith ((540) 555-0100): they asked by phone not to be texted. Note: Called Tuesday"],
    ]);
  });

  it("turns off a contact's number, and the client's own too when it's the same one", async () => {
    let calls = serve({ ...world(), answer: added });
    expect((await call(`/clients/${ANA_ID}/texts`, { on: false, how: "email", contact_id: MO_ID })).status).toBe(200);
    expect(writes(calls, "POST", "sms_stops").map((c) => [c.body.phone_key, c.body.how])).toEqual([["5405550163", "email"]]);
    // Ana's own phone is another number: she isn't marked.
    expect(writes(calls, "PATCH", "clients")).toEqual([]);
    expect(writes(calls, "POST", "messages")[0]!.body.body).toBe("Dana Office turned texts off for Mo Manager (540-555-0163): they asked by email not to be texted.");

    // Mo's number kept as a client's own phone too: that client follows.
    calls = serve({ ...world({ clients: [ANA, { ...ANA, id: "client-2", display_name: "Mo Manager LLC", phone: "+1 540 555 0163" }] }), answer: added });
    await call(`/clients/${ANA_ID}/texts`, { on: false, how: "in_person", contact_id: MO_ID });
    expect(writes(calls, "PATCH", "clients").map((c) => c.params.get("id"))).toEqual(["in.(client-2)"]);
  });

  it("asks how they asked, and is for owners, admins and the office", async () => {
    let calls = serve(world());
    const res = await call(`/clients/${ANA_ID}/texts`, { on: false });
    expect([res.status, await res.json()]).toEqual([400, { error: "Say how they asked for texts to stop." }]);
    calls = serve(world({ role: "estimator" }));
    expect((await call(`/clients/${ANA_ID}/texts`, { on: false, how: "phone" })).status).toBe(403);
    expect(writes(calls, "POST", "sms_stops")).toEqual([]);
  });

  it("turns texts back on for a stop the office set, or one from words that asked to stop", async () => {
    for (const source of ["office", "phrase"]) {
      const calls = serve({ ...world({ stops: [{ ...officeStop(), source }], clients: [{ ...ANA, sms_opt_out_at: "2026-10-20T15:00:00Z" }] }), answer: removed });
      const res = await call(`/clients/${ANA_ID}/texts`, { on: true });
      expect([res.status, await res.json()], source).toEqual([200, { on: true, phone: "(540) 555-0100" }]);
      expect(writes(calls, "DELETE", "sms_stops").map((c) => c.params.get("phone_key"))).toEqual(["eq.5405550100"]);
      expect(writes(calls, "PATCH", "clients").map((c) => [c.params.get("id"), c.body])).toEqual([[`in.(${ANA_ID})`, { sms_opt_out_at: null }]]);
      expect(writes(calls, "POST", "sms_stop_changes").map((c) => [c.body.texts_on, c.body.source, c.body.set_by_name])).toEqual([[true, "office", "Dana Office"]]);
      expect(writes(calls, "POST", "messages")[0]!.body.body).toBe("Dana Office turned texts back on for Ana Smith ((540) 555-0100), because they asked.");
    }
  });

  it.each([["keyword"], ["carrier"], [null]])("doesn't turn texts back on over a STOP Twilio has (%s), and says they have to text START", async (source) => {
    const calls = serve(world({ stops: [{ ...officeStop(), source }], clients: [{ ...ANA, sms_opt_out_at: "2026-10-20T15:00:00Z" }] }));
    const res = await call(`/clients/${ANA_ID}/texts`, { on: true });
    expect([res.status, await res.json()]).toEqual([400, {
      error: "Ana Smith texted STOP from (540) 555-0100. The service that sends your texts refuses that number until they text START to your texting number, so it can't be turned back on from here.",
    }]);
    expect(writes(calls, "DELETE", "sms_stops")).toEqual([]);
    expect(writes(calls, "PATCH", "clients")).toEqual([]);
  });

  it("turns texts back on for a client marked alone, whose number never stopped", async () => {
    // A merge brought the mark over, or their number changed since.
    const calls = serve(world({ clients: [{ ...ANA, sms_opt_out_at: "2026-10-20T15:00:00Z" }] }));
    expect((await call(`/clients/${ANA_ID}/texts`, { on: true })).status).toBe(200);
    expect(writes(calls, "PATCH", "clients").map((c) => c.body)).toEqual([{ sms_opt_out_at: null }]);
    expect(writes(calls, "POST", "sms_stop_changes").map((c) => [c.body.texts_on, c.body.source])).toEqual([[true, "office"]]);
  });

  it("keeps a STOP that comes after the office's as Twilio's, so only START lifts it", async () => {
    const { noteStop } = await import("../src/services/textsOff");
    // Already on the list (the upsert adds nothing): its source becomes the keyword's.
    const calls = serve({ answer: (c) => (c.method === "PATCH" && c.path === "sms_stops" ? [{ phone_key: "5405550100" }] : undefined) });
    expect(await noteStop(adminClient(env), CO, "+15405550100")).toBe(false);
    expect(writes(calls, "PATCH", "sms_stops").map((c) => [c.body, c.params.get("source")])).toEqual([[{ source: "keyword" }, "in.(phrase,office)"]]);
    expect(writes(calls, "POST", "sms_stop_changes").map((c) => [c.body.texts_on, c.body.source])).toEqual([[false, "keyword"]]);
  });
});

describe("a number the office stopped", () => {
  // Only the stop list has it: the client isn't marked (the number was a contact's when it was
  // stopped), so each send is held by the list itself.
  const stopped = { clients: [ANA], sms_stops: [officeStop()] };
  const visit = { id: "visit-1", company_id: CO, title: "Mowing", kind: "job", status: "scheduled", scheduled_on: "2026-10-28", starts_at: "2026-10-28T14:00:00Z", eta_at: null, job_id: "job-1", property_id: null, property: null, job: { client_id: ANA_ID, kind: "one_off" }, request: null };
  const rule = (trigger: string) => ({ id: "rule-1", company_id: CO, name: "Texts", trigger, enabled: true, delay_minutes: 0, conditions: [], actions: [{ type: "send_sms", body: "Hi {{client.first_name}}, about your visit." }], run_count: 0 });
  const run = { id: 7, company_id: CO, rule_id: "rule-1", subject_type: "visit", subject_id: "visit-1", activity_id: null, result: [], claim_token: "claim-1" };
  const engine = (trigger: string, tables: Record<string, Row[]>) =>
    serve({ tables: { companies: [company], automation_rules: [rule(trigger)], visits: [visit], ...tables }, rpc: { visit_notice_is_repeat: () => false } });

  it.each([
    ["a visit reminder", "visit.reminder"],
    ["a visit booked", "visit.scheduled"],
    ["a visit moved", "visit.rescheduled"],
    ["a visit cancelled", "visit.cancelled"],
    ["an on-my-way text", "visit.en_route"],
  ])("isn't texted %s", async (_what, trigger) => {
    // A cancelled visit is off the schedule by the time its rule runs.
    const tables: Record<string, Row[]> = trigger === "visit.cancelled" ? { visits: [{ ...visit, status: "cancelled", scheduled_on: null, starts_at: null }] } : {};
    const calls = engine(trigger, { ...stopped, ...tables });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("skipped");
    expect(rpcCalls(calls, "finish_automation_run")[0].p_result).toEqual([{ type: "send_sms", ok: true, skipped: true, detail: "Ana Smith asked not to be texted, so texts to them are off" }]);
    expect(sendSms).not.toHaveBeenCalled();

    // The same rule texts her once nothing stops it.
    engine(trigger, { clients: [ANA], ...tables });
    expect(await executeRun(env, adminClient(env), run, env.APP_URL!)).toBe("done");
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it("isn't texted a quote or an invoice", async () => {
    const onRecord = { display_name: ANA.display_name, email: ANA.email, phone: ANA.phone };
    const quote = {
      id: "00000000-0000-4000-8000-0000000000d1", company_id: CO, number: 1042, status: "sent", total: 400, tax_rate: 0, discount_amount: 0, client_id: ANA_ID, range_low: null, range_high: null,
      priced_on_site_at: null, exact_sent_at: null, client: onRecord, promo: null, options: [], lines: [{ id: "line-1", option_id: null, quantity: 1, unit_price: 400, taxable: false, optional: false, selected: true }],
    };
    const invoice = { id: "00000000-0000-4000-8000-0000000000d2", company_id: CO, number: 88, status: "sent", total: 400, balance_due: 400, client_id: ANA_ID, client: onRecord, lines: [{ id: "line-1" }] };
    for (const [kind, id] of [["quotes", quote.id], ["invoices", invoice.id]]) {
      serve({ tables: { memberships: [member("office")], companies: [company], quotes: [quote], invoices: [invoice], ...stopped } });
      const res = await call(`/${kind}/${id}/send`, { channel: "sms" });
      expect([res.status, await res.json()], kind).toEqual([400, { error: "Ana Smith asked not to be texted, so texts to them are off. Send it by email instead." }]);
      // Named outright, her number is refused too.
      const named = await call(`/${kind}/${id}/send`, { channel: "sms", to: "540.555.0100" });
      expect([named.status, await named.json()], kind).toEqual([400, { error: "540.555.0100 asked not to be texted, so Crewtavo can't text it." }]);
    }
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("isn't asked for a review by text, by hand or by a rule", async () => {
    const world = { tables: { companies: [company], ...stopped }, rpc: { begin_review_request: () => "rr-1", last_review_ask: () => null } };
    serve(world);
    const args = { companyId: CO, client: ANA as never, channel: "sms" as const, baseUrl: env.APP_URL!, createdBy: null };
    await expect(sendReviewRequest(env, adminClient(env), args)).rejects.toThrow("Ana Smith asked not to be texted, so texts to them are off. Ask by email instead.");
    expect(await sendReviewRequest(env, adminClient(env), { ...args, automatic: true })).toMatchObject({ skipped: true, detail: "Ana Smith asked not to be texted, so texts to them are off" });
    // By both, it goes by email alone.
    expect(await sendReviewRequest(env, adminClient(env), { ...args, channel: "both", automatic: true })).toMatchObject({ sent: true, detail: "Asked for a review by email" });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("isn't texted a booking's confirmation", async () => {
    serve({ tables: { companies: [company], ...stopped } });
    const booking = { companyId: CO, clientId: ANA_ID, requestId: "request-1", visitId: null, title: "Estimate", startsAt: "2026-10-28T14:00:00Z", booked: true, text: true };
    expect(await confirmBooking(env, adminClient(env), booking, env.APP_URL!)).toEqual({ emailed: true, texted: false });
    expect(sendSms).not.toHaveBeenCalled();
    serve({ tables: { companies: [company], clients: [ANA] } });
    expect(await confirmBooking(env, adminClient(env), booking, env.APP_URL!)).toEqual({ emailed: true, texted: true });
  });

  it("isn't texted from Messages", async () => {
    serve({ tables: { memberships: [member("office")], companies: [company], ...stopped } });
    const res = await call("/messages/send", { client_id: ANA_ID, channel: "sms", body: "Running late" });
    expect([res.status, await res.json()]).toEqual([400, { error: "(540) 555-0100 asked not to be texted, so Crewtavo can't text it." }]);
    expect(sendSms).not.toHaveBeenCalled();
    // A client the office's switch marked says so by name.
    serve({ tables: { memberships: [member("office")], companies: [company], clients: [{ ...ANA, sms_opt_out_at: "2026-10-20T15:00:00Z" }], sms_stops: [officeStop()] } });
    const marked = await call("/messages/send", { client_id: ANA_ID, channel: "sms", body: "Running late" });
    expect(await marked.json()).toEqual({ error: "Ana Smith asked not to be texted, so texts to them are off. Send it by email instead." });
    expect(sendSms).not.toHaveBeenCalled();
  });
});
