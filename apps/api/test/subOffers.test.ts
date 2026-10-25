/**
 * Job offers to subs (routes/subOffers.ts, services/subOffers.ts) and the text an offer sends through
 * the notify task (services/delivery.ts), against a small stand-in for PostgREST: fetch is stubbed,
 * tables live in memory, and the database's functions answer what each test gives them. (What the
 * functions themselves do, and who reaches what, is tested in supabase/tests/sub_offers_test.sql.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { deliverNotifications } from "../src/services/delivery";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const texting: Env = { ...env, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_FROM_NUMBER: "+15405550000" };

const CO = "00000000-0000-4000-8000-0000000000a1";
const OTHER_CO = "00000000-0000-4000-8000-0000000000a2";
const OWNER = "00000000-0000-4000-8000-000000000001";
const PAYROLL = "00000000-0000-4000-8000-000000000002"; // office, job costs without subs
const SUBS = "00000000-0000-4000-8000-000000000003"; // office, subs without job costs
const CREW = "00000000-0000-4000-8000-000000000004";
const AL = "00000000-0000-4000-8000-000000000005"; // Apex's sign-in
const DEE = "00000000-0000-4000-8000-000000000006";
const APEX = "00000000-0000-4000-8000-0000000000b1";
const JOB = "00000000-0000-4000-8000-0000000000c1";
const SHINGLES = "00000000-0000-4000-8000-0000000000d1";
const PAY = "00000000-0000-4000-8000-0000000000e1";
const DEE_PAY = "00000000-0000-4000-8000-0000000000e2";
const PAYROLL_ROLE = "00000000-0000-4000-8000-0000000000f1";
const SUBS_ROLE = "00000000-0000-4000-8000-0000000000f2";

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenFor = (sub: string) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln`;

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  url: URL;
  body: any;
  /** The server's key (rather than a person's session) sent it. */
  admin: boolean;
}
interface World {
  tables: Record<string, Row[]>;
  /** The database's functions: what each answers (an { error } answers as PostgREST does). */
  rpc?: Record<string, (body: any) => unknown>;
}

/** One PostgREST condition (col=op.value) on a row. */
function test(row: Row, key: string, value: string): boolean {
  const [op, ...rest] = value.split(".");
  const arg = rest.join(".");
  const cell = row[key];
  if (op === "eq") return String(cell) === arg;
  if (op === "neq") return String(cell) !== arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(cell));
  if (op === "is") return arg === "null" ? cell == null : String(cell) === arg;
  return true;
}
const SKIP = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function serve(world: World) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies (Twilio) stay text
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body, admin: (headers.get("apikey") ?? "") === "sb_secret_test" };
    calls.push(call);
    if (url.host === "api.twilio.com") return Response.json({ sid: "SM1" });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "someone", aud: "authenticated", role: "authenticated" });
    if (!url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (call.path.startsWith("rpc/")) {
      const answer = world.rpc?.[call.path.slice(4)]?.(body);
      if (answer && typeof answer === "object" && "error" in answer) return Response.json((answer as { error: unknown }).error, { status: 400 });
      return Response.json(answer === undefined ? [] : answer);
    }
    const rows = (world.tables[call.path] ??= []);
    const filters = [...url.searchParams].filter(([k]) => !SKIP.has(k));
    const picked = rows.filter((r) => filters.every(([k, v]) => test(r, k, v)));
    const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (method === "PATCH") {
      for (const r of picked) Object.assign(r, body);
      return Response.json(picked);
    }
    if (one) return picked.length ? Response.json(picked[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
    return Response.json(picked);
  });
  const rpcCalls = (name: string) => calls.filter((c) => c.path === `rpc/${name}`).map((c) => c.body);
  const texts = () => calls.filter((c) => c.url.host === "api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(c.body as string)));
  return { calls, rpcCalls, texts };
}
afterEach(() => vi.unstubAllGlobals());

const pay = (extra: Row = {}): Row => ({
  id: PAY, company_id: CO, job_id: JOB, subcontractor_id: APEX, user_id: null, status: "draft", total: 2040, earned_on: null, paid_at: null, paid_amount: null,
  method: null, reference: null, paid_by: null, pay_period_id: null, notes: null, respond_by: null, offered_at: null, offered_by: null, offer_round: 0,
  offer_outcome: null, answered_at: null, answered_by: null, decline_reason: null, insurance_warning: null, accepted_snapshot: null, lines: [], visits: [], ...extra,
});
/** An offer as public.my_sub_offers() gives it. */
const offer = (extra: Row = {}): Row => ({
  id: PAY, company_id: CO, subcontractor_id: APEX, job_id: JOB, job_title: "Smith roof", city: "Dover", region: "DE", status: "offered", is_change: false, can_answer: true,
  total: 2040, lines: [{ description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 24, rate: 85, amount: 2040 }], agreed_total: null, agreed_lines: null,
  visits: [{ id: "v1", scheduled_on: "2026-11-03", starts_at: null, ends_at: null, status: "scheduled" }], scope: [{ name: "Architectural shingles", description: null, quantity: 24, unit: "sq" }],
  notes: null, respond_by: "2026-11-02T21:00:00Z", offered_at: "2026-10-25T14:00:00Z", offer_round: 1, outcome: null, answered_at: null, decline_reason: null,
  insurance_warning: ["Your workers' comp certificate on file ends before this job."], earned_on: null, paid_at: null, paid_amount: null, ...extra,
});
/** Romeo Roofing: Oz owns it, Pam does payroll (job costs, no subs), Sal handles subs (subs, no job costs), Cy is on the crew, Al signs in for Apex. */
const romeo = (tables: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  companies: [{ id: CO, name: "Romeo Roofing", email: null, timezone: "America/New_York", settings: {} }],
  memberships: [
    { company_id: CO, user_id: OWNER, role: "owner", role_id: null, subcontractor_id: null, active: true },
    { company_id: CO, user_id: PAYROLL, role: "office", role_id: PAYROLL_ROLE, subcontractor_id: null, active: true },
    { company_id: CO, user_id: SUBS, role: "office", role_id: SUBS_ROLE, subcontractor_id: null, active: true },
    { company_id: CO, user_id: CREW, role: "field_crew", role_id: null, subcontractor_id: null, active: true },
    { company_id: CO, user_id: AL, role: "subcontractor", role_id: null, subcontractor_id: APEX, active: true },
  ],
  company_roles: [
    { id: PAYROLL_ROLE, company_id: CO, permissions: ["job_costs", "timesheets"] },
    { id: SUBS_ROLE, company_id: CO, permissions: ["subs", "schedule"] },
  ],
  job_pay: [pay(), pay({ id: DEE_PAY, subcontractor_id: null, user_id: DEE, total: 100 })],
  ...tables,
});

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(
    `/api${path}`,
    {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${tokenFor(who)}`, "X-Company-Id": CO, "Content-Type": "application/json" },
      ...(init.method && init.method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    },
    env,
  );

const newPrice = { lines: [{ description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 26, rate: 85, service_id: SHINGLES }], respond_by: "2026-11-01T17:00:00-04:00" };

describe("sending, changing and taking back offers", () => {
  it("are for the office with the subs area: the crew, subs and payroll are refused", async () => {
    const { rpcCalls } = serve({ tables: romeo() });
    const routes: Array<[string, unknown]> = [[`/job-pay/${PAY}/offer`, {}], [`/job-pay/${PAY}/offer/change`, newPrice], [`/job-pay/${PAY}/offer/withdraw`, {}]];
    for (const who of [CREW, AL, PAYROLL]) {
      for (const [path, body] of routes) expect((await as(who, path, { method: "POST", body })).status, `${who} ${path}`).toBe(403);
    }
    expect([...rpcCalls("send_sub_offer"), ...rpcCalls("change_sub_offer"), ...rpcCalls("withdraw_sub_offer")]).toEqual([]);
  });

  it("send a draft, to answer by a time if one is given, and answer with the pay", async () => {
    const world: World = { tables: romeo() };
    world.rpc = { send_sub_offer: () => Object.assign(world.tables.job_pay![0]!, { status: "offered", offer_round: 1, respond_by: "2026-11-01T21:00:00Z" }) };
    const { rpcCalls, calls } = serve(world);
    const res = await as(SUBS, `/job-pay/${PAY}/offer`, { method: "POST", body: { respond_by: "2026-11-01T17:00:00-04:00" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: PAY, status: "offered", offer_round: 1, respond_by: "2026-11-01T21:00:00Z" });
    expect(rpcCalls("send_sub_offer")).toEqual([{ p_pay: PAY, p_respond_by: "2026-11-01T17:00:00-04:00" }]);
    // As the person asking, so the database checks the subs area again.
    expect(calls.filter((c) => c.path === "rpc/send_sub_offer").every((c) => !c.admin)).toBe(true);
    expect((await as(OWNER, `/job-pay/${PAY}/offer`, { method: "POST", body: {} })).status).toBe(200);
    expect(rpcCalls("send_sub_offer")[1]).toEqual({ p_pay: PAY });
  });

  it("check the time to answer by, and say what the database says", async () => {
    serve({ tables: romeo(), rpc: { send_sub_offer: () => ({ error: { code: "22023", message: "Give them a sign-in first, or agree it with them and press Agree." } }) } });
    expect((await as(SUBS, `/job-pay/${PAY}/offer`, { method: "POST", body: { respond_by: "tomorrow" } })).status).toBe(400);
    const res = await as(SUBS, `/job-pay/${PAY}/offer`, { method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Give them a sign-in first, or agree it with them and press Agree." });
  });

  it("aren't for a team member's pay", async () => {
    const { rpcCalls } = serve({ tables: romeo() });
    const res = await as(OWNER, `/job-pay/${DEE_PAY}/offer`, { method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Offers are for subs. Agree pay for your team yourself." });
    expect(rpcCalls("send_sub_offer")).toEqual([]);
  });

  it("send a new price with its lines", async () => {
    const world: World = { tables: romeo({ job_pay: [pay({ status: "accepted" })] }) };
    world.rpc = { change_sub_offer: () => Object.assign(world.tables.job_pay![0]!, { status: "offered", total: 2210, accepted_snapshot: { total: 2040, lines: [] } }) };
    const { rpcCalls } = serve(world);
    const res = await as(SUBS, `/job-pay/${PAY}/offer/change`, { method: "POST", body: { ...newPrice, lines: [...newPrice.lines, { description: " Ridge vent ", rate: 90 }] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "offered", total: 2210, accepted_snapshot: { total: 2040 } });
    expect(rpcCalls("change_sub_offer")).toEqual([{
      p_pay: PAY,
      p_lines: [
        { description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 26, rate: 85, service_id: SHINGLES, pay_rate_id: null },
        { description: "Ridge vent", basis: "per_job", unit: null, quantity: 1, rate: 90, service_id: null, pay_rate_id: null },
      ],
      p_respond_by: "2026-11-01T17:00:00-04:00",
    }]);
    expect((await as(SUBS, `/job-pay/${PAY}/offer/change`, { method: "POST", body: { lines: [] } })).status).toBe(400);
    expect((await as(SUBS, `/job-pay/${PAY}/offer/change`, { method: "POST", body: { lines: [{ description: "No rate" }] } })).status).toBe(400);
    expect((await as(SUBS, `/job-pay/${PAY}/offer/change`, { method: "POST", body: { lines: [{ description: "Odd", basis: "per_hour", rate: 5 }] } })).status).toBe(400);
    expect(rpcCalls("change_sub_offer")).toHaveLength(1);
  });

  it("take an offer back", async () => {
    const world: World = { tables: romeo({ job_pay: [pay({ status: "offered", offer_round: 1 })] }) };
    world.rpc = { withdraw_sub_offer: () => Object.assign(world.tables.job_pay![0]!, { status: "withdrawn", offer_outcome: "withdrawn" }) };
    const { rpcCalls } = serve(world);
    expect(await (await as(SUBS, `/job-pay/${PAY}/offer/withdraw`, { method: "POST" })).json()).toMatchObject({ status: "withdrawn", offer_outcome: "withdrawn" });
    expect(rpcCalls("withdraw_sub_offer")).toEqual([{ p_pay: PAY }]);
  });

  it("go out at most 60 an hour per person, since each one texts the sub", async () => {
    const { rpcCalls } = serve({ tables: romeo(), rpc: { rate_limit_hit: (body) => !String(body.p_key).startsWith("sub-offer:") } });
    const res = await as(SUBS, `/job-pay/${PAY}/offer`, { method: "POST", body: {} });
    expect(res.status).toBe(429);
    expect(rpcCalls("rate_limit_hit")).toEqual([{ p_key: `sub-offer:${SUBS}`, p_max: 60, p_window_seconds: 3600 }]);
    expect(rpcCalls("send_sub_offer")).toEqual([]);
  });
});

describe("a sub's own offers", () => {
  it("are only for subs", async () => {
    const { rpcCalls } = serve({ tables: romeo() });
    for (const who of [OWNER, SUBS, CREW]) {
      expect((await as(who, "/sub/offers")).status, who).toBe(403);
      expect((await as(who, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: true } })).status, who).toBe(403);
    }
    expect([...rpcCalls("my_sub_offers"), ...rpcCalls("answer_sub_offer")]).toEqual([]);
  });

  it("lists theirs at this company, asked as themselves", async () => {
    const { rpcCalls, calls } = serve({ tables: romeo(), rpc: { my_sub_offers: () => [offer(), offer({ id: "elsewhere", company_id: OTHER_CO })] } });
    const res = await as(AL, "/sub/offers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([offer()]);
    // This company's, picked by the database, so its limit counts only these.
    expect(rpcCalls("my_sub_offers")).toEqual([{ p_company: CO }]);
    expect(calls.filter((c) => c.path === "rpc/my_sub_offers").every((c) => !c.admin)).toBe(true);
    await as(AL, "/sub/offers?all=1");
    expect(rpcCalls("my_sub_offers")[1]).toEqual({ p_company: CO, p_all: true });
  });

  it("gives what they've been paid this year and are owed, from the database", async () => {
    const { rpcCalls } = serve({ tables: romeo(), rpc: { my_sub_pay_totals: () => [{ year: 2026, paid: "54210.00", payments: 521, owed: "2210.00", owed_jobs: 1, counted: "51210.00" }] } });
    const res = await as(AL, "/sub/offers/totals");
    expect(res.status).toBe(200);
    // counted: what counts toward their 1099 (card and payment-app payments are on a 1099-K).
    expect(await res.json()).toEqual({ year: 2026, paid: 54210, payments: 521, owed: 2210, owed_jobs: 1, counted: 51210 });
    expect(rpcCalls("my_sub_pay_totals")).toEqual([{ p_company: CO }]);
    for (const who of [OWNER, SUBS, CREW]) expect((await as(who, "/sub/offers/totals")).status, who).toBe(403);
  });

  it("says which company an offer of theirs is from, for a link from another company", async () => {
    const { calls } = serve({ tables: romeo({ job_pay: [pay({ company_id: OTHER_CO, status: "offered" })] }) });
    const res = await as(AL, `/sub/offers/${PAY}/company`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ company_id: OTHER_CO });
    // Read as Al, so row-level security decides whose it is.
    expect(calls.filter((c) => c.path === "job_pay").every((c) => !c.admin)).toBe(true);
    expect((await as(AL, `/sub/offers/${DEE_PAY}/company`)).status).toBe(404);
    expect((await as(OWNER, `/sub/offers/${PAY}/company`)).status).toBe(403);
  });

  it("takes one, as the offer they saw, and answers with it", async () => {
    let answered = false;
    const { rpcCalls } = serve({
      tables: romeo(),
      rpc: {
        answer_sub_offer: () => (answered = true),
        my_sub_offers: () => [answered ? offer({ status: "accepted", outcome: "accepted", can_answer: false, insurance_warning: [] }) : offer()],
      },
    });
    const res = await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: true, reason: "ignored when taking it", round: 1 } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ offer: { id: PAY, status: "accepted", outcome: "accepted" } });
    expect(rpcCalls("answer_sub_offer")).toEqual([{ p_pay: PAY, p_accept: true, p_company: CO, p_round: 1 }]);
  });

  it("turns one down, with a reason if they give one", async () => {
    const { rpcCalls } = serve({ tables: romeo(), rpc: { answer_sub_offer: () => true, my_sub_offers: () => [offer({ status: "declined", outcome: "declined" })] } });
    expect((await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: false, reason: "  Too far for us  " } })).status).toBe(200);
    expect((await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: false, reason: "   " } })).status).toBe(200);
    expect(rpcCalls("answer_sub_offer")).toEqual([{ p_pay: PAY, p_accept: false, p_company: CO, p_reason: "Too far for us" }, { p_pay: PAY, p_accept: false, p_company: CO }]);
  });

  it("says why, with a 409, when the answer didn't go through", async () => {
    const answer = async (now: Row | null, body: Row = { accept: true, round: 1 }) => {
      serve({ tables: romeo(), rpc: { answer_sub_offer: () => false, my_sub_offers: () => (now ? [now] : []) } });
      const res = await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body });
      return [res.status, (await res.json()).error];
    };
    expect(await answer(offer({ status: "accepted", outcome: "accepted", can_answer: false }))).toEqual([409, "You've already accepted this job. It's on My day."]);
    expect(await answer(offer({ status: "expired", outcome: "expired", can_answer: false }))).toEqual([409, "This offer ran out. Call the office if you'd still like the work."]);
    expect(await answer(offer({ status: "withdrawn", outcome: "withdrawn", can_answer: false }))).toEqual([409, "The office withdrew this offer."]);
    expect(await answer(offer({ offer_round: 2 }))).toEqual([409, "The office changed this offer. Have a look at it again."]);
    expect(await answer(null)).toEqual([409, "This offer isn't open any more."]);
  });

  it("answers only offers from the company they have open", async () => {
    // Al is a sub of Sierra too, and this offer is Sierra's: answered with Romeo open, it isn't answered.
    const { rpcCalls } = serve({ tables: romeo({ job_pay: [pay({ company_id: OTHER_CO, status: "offered", offer_round: 1 })] }), rpc: { answer_sub_offer: (b) => b.p_company !== CO, my_sub_offers: () => [] } });
    const res = await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: true, round: 1 } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This offer is from another company you work for. Switch to it to answer.");
    expect(rpcCalls("answer_sub_offer")).toEqual([{ p_pay: PAY, p_accept: true, p_company: CO, p_round: 1 }]);
  });

  it("needs a yes or a no", async () => {
    const { rpcCalls } = serve({ tables: romeo() });
    expect((await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: {} })).status).toBe(400);
    expect((await as(AL, `/sub/offers/${PAY}/answer`, { method: "POST", body: { accept: false, reason: "x".repeat(501) } })).status).toBe(400);
    expect(rpcCalls("answer_sub_offer")).toEqual([]);
  });
});

describe("the offer by text", () => {
  // What send_sub_offer leaves for Al: a notification under his "jobs" topic, linking to the offer.
  const notice = { id: "n1", company_id: CO, user_id: AL, kind: "jobs", title: "Smith roof, Tue Nov 3, 24 squares, $2,040. Open Crewtavo to accept or decline.", body: "New job offer.", link: `/field/jobs/${PAY}`, read_at: null };
  const world = (prefs: Row[] = []): World => ({
    tables: {
      notification_prefs: prefs,
      profiles: [{ user_id: AL, email: "sub-x@subs.invalid", phone: "+15405550107", full_name: "Al Apex" }],
      companies: [{ id: CO, name: "Romeo Roofing", email: null }],
      push_subscriptions: [],
    },
    rpc: { claim_notifications: () => [notice] },
  });

  it("goes to a sub with a phone when texting is set up, with a link to the offer, as their settings start", async () => {
    const { texts } = serve(world());
    expect(await deliverNotifications(texting)).toMatchObject({ sms: 1, email: 0 });
    expect(texts()).toEqual([expect.objectContaining({ To: "+15405550107", Body: `Romeo Roofing: ${notice.title} https://ops.example.com/field/jobs/${PAY}` })]);
  });

  it("links two at once to My jobs, and anything else mixed in to the start", async () => {
    const second = { ...notice, id: "n2", title: "Jones gutters, Thu Nov 5, $600. Open Crewtavo to accept or decline.", link: "/field/jobs/other" };
    const both = world();
    both.rpc = { claim_notifications: () => [notice, second] };
    const jobs = serve(both);
    await deliverNotifications(texting);
    expect(jobs.texts()).toEqual([expect.objectContaining({ Body: `Romeo Roofing: ${notice.title} (+1 more) https://ops.example.com/field/jobs` })]);
    const mixed = world([{ company_id: CO, user_id: AL, email: [], sms: ["jobs", "schedule"], push: [] }]);
    mixed.rpc = { claim_notifications: () => [notice, { ...second, kind: "schedule", title: "You're on Tear off", link: "/field/visits/v1" }] };
    const other = serve(mixed);
    await deliverNotifications(texting);
    expect(other.texts()).toEqual([expect.objectContaining({ Body: `Romeo Roofing: ${notice.title} (+1 more) https://ops.example.com/` })]);
  });

  it("not when they've turned texts for their jobs off, or texting isn't set up", async () => {
    const off = serve(world([{ company_id: CO, user_id: AL, email: [], sms: ["schedule"], push: ["jobs"] }]));
    expect(await deliverNotifications(texting)).toMatchObject({ sms: 0 });
    expect(off.texts()).toEqual([]);
    const unset = serve(world());
    expect(await deliverNotifications(env)).toMatchObject({ sms: 0 });
    expect(unset.texts()).toEqual([]);
  });
});
