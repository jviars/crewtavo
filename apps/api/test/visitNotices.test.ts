/**
 * What a client is told when a visit is booked, moved or cancelled (the visit.scheduled,
 * visit.rescheduled and visit.cancelled rules in services/automations.ts): the day and time as they
 * read them, where a moved visit was, a deleted visit still told as cancelled from what its event
 * kept, the Hub link, and what a run skips by the time it goes (ten minutes after the change).
 * PostgREST is a stand-in answering over fetch and sending is mocked. When the events are emitted,
 * and how changes fold while a message waits, is the database's: supabase/tests/visit_notices_test.sql.
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
const { buildContext, executeRun, keptVars, loadContext, officeVars, reminderSkip, visitNoticeSkip, visitWhen, withEvent } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");
const { KEPT_LINK, readClientLink } = await import("../src/lib/links");
const sendEmail = vi.mocked(notify.sendEmail);
const sendSms = vi.mocked(notify.sendSms);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const NY = "America/New_York";
const CO = "00000000-0000-4000-8000-0000000000c1";
const ANA_ID = "00000000-0000-4000-8000-0000000000a1";
const VISIT = "00000000-0000-4000-8000-0000000000f1";
const PLACE = "00000000-0000-4000-8000-0000000000b1";

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  body: any;
}

const ANA: Row = {
  id: ANA_ID, company_id: CO, display_name: "Ana Smith", email: "ana@example.com", phone: "+15405550100", tags: [], status: "active", lead_source: null,
  review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null,
};
const company = (settings: Row = {}): Row => ({ id: CO, name: "Acme Lawn", phone: "555-0100", email: "office@acme.example", website: null, timezone: NY, currency: "USD", trade_preset: "lawn_care", address: {}, settings });
const place = { id: PLACE, company_id: CO, line1: "12 Oak St", city: "Radford", region: "VA", client_id: ANA_ID };
/** A visit on Thursday, October 29 at 9am in New York. */
const visit = (over: Row = {}): Row => ({
  id: VISIT, company_id: CO, title: "Fall cleanup", kind: "job", status: "scheduled", scheduled_on: "2026-10-29", starts_at: "2026-10-29T13:00:00Z", eta_at: null,
  job_id: "job-1", property_id: PLACE, property: place, job: { client_id: ANA_ID, kind: "one_off" }, request: null, ...over,
});
const rule = (trigger: string, over: Row = {}): Row => ({
  id: "rule-1", company_id: CO, name: "Tell the client", trigger, enabled: true, conditions: [], run_count: 0,
  actions: [{ type: "send_email", subject: "Your visit on {{date}}", body: "{{address}} on {{date}}{{time}}. Was {{old.date}}{{old.time}}. {{link}}" }], ...over,
});
const run = (over: Row = {}) => ({ id: 7, company_id: CO, rule_id: "rule-1", subject_type: "visit", subject_id: VISIT, activity_id: 5, result: [], claim_token: "claim-1", ...over });
const event = (verb: string, data: Row = {}): Row => ({ id: 5, company_id: CO, verb, data: { kind: "job", client_id: ANA_ID, ...data } });

/** PostgREST over fetch: GETs answer from `tables`, filtered by eq. on the row's own columns; functions from `rpc` (true when not given). */
function serve(tables: Record<string, Row[]>, rpc: Record<string, (body: any) => unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), path, body: text ? JSON.parse(text) : undefined };
    calls.push(call);
    if (path.startsWith("rpc/")) {
      const fn = rpc[path.slice(4)];
      return Response.json(fn ? (fn(call.body) ?? null) : true);
    }
    if (call.method !== "GET") return Response.json([]);
    let rows = tables[path] ?? [];
    for (const [column, filter] of url.searchParams) {
      if (rows.some((r) => column in r) && filter.startsWith("eq.")) rows = rows.filter((r) => String(r[column]) === filter.slice(3));
    }
    return Response.json(rows);
  });
  return calls;
}
const world = (trigger: string, over: Record<string, Row[]> = {}, repeat = false) =>
  serve({ companies: [company()], automation_rules: [rule(trigger)], visits: [visit()], clients: [ANA], properties: [place], activity: [event(trigger)], ...over }, { visit_notice_is_repeat: () => repeat });
const finished = (calls: Call[]) => calls.filter((c) => c.path === "rpc/finish_automation_run").map((c) => c.body);
const emailed = () => sendEmail.mock.calls.map(([, message]) => message as unknown as { to: string; subject: string; text: string });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") }); // Tuesday, 11am in New York
  sendEmail.mockClear();
  sendSms.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a visit's day and time, as a client reads them", () => {
  it("is the day and the start, or the arrival window when the business gives one", () => {
    expect(visitWhen("2026-10-29T13:00:00Z", "2026-10-29", NY)).toEqual({ date: "Thursday, October 29", time: " at 9:00 AM" });
    expect(visitWhen("2026-10-29T13:00:00Z", "2026-10-29", NY, 120)).toEqual({ date: "Thursday, October 29", time: " between 9:00 AM and 11:00 AM" });
  });

  it("is the day alone for an anytime visit, and nothing for one with no day", () => {
    expect(visitWhen(null, "2026-10-29", NY, 120)).toEqual({ date: "Thursday, October 29", time: "" });
    expect(visitWhen(null, null, NY)).toEqual({ date: "", time: "" });
  });

  it("goes by the company's day, not the server's", () => {
    // 11pm on the 29th in New York is already the 30th in UTC.
    expect(visitWhen("2026-10-30T03:00:00Z", "2026-10-29", NY).date).toBe("Thursday, October 29");
  });

  it("is written the way the business's country writes it, a US business's as it always was", () => {
    expect(visitWhen("2026-10-29T13:00:00Z", "2026-10-29", NY, 120, "US")).toEqual({ date: "Thursday, October 29", time: " between 9:00 AM and 11:00 AM" });
    expect(visitWhen("2026-10-29T13:00:00Z", "2026-10-29", "America/Toronto", 0, "CA")).toEqual({ date: "Thursday, October 29", time: " at 9:00 a.m." });
    expect(visitWhen("2026-10-29T14:00:00Z", "2026-10-29", "Europe/London", 120, "GB")).toEqual({ date: "Thursday 29 October", time: " between 14:00 and 16:00" });
    expect(visitWhen(null, "2026-10-29", "Australia/Sydney", 0, "AU")).toEqual({ date: "Thursday 29 October", time: "" });
  });
});

describe("what a rule on a visit knows", () => {
  it("has the client's Hub link, their own for them and the office's copy for anyone else", async () => {
    world("visit.scheduled");
    const ctx = (await buildContext(env, adminClient(env), CO, "visit", VISIT, env.APP_URL!))!;
    expect(ctx.vars).toMatchObject({ date: "Thursday, October 29", time: " at 9:00 AM", address: "12 Oak St, Radford, VA" });
    expect(ctx.visit).toEqual({ status: "scheduled", scheduled_on: "2026-10-29", starts_at: "2026-10-29T13:00:00Z" });
    const link = String(ctx.vars.link);
    expect(link).toMatch(/^https:\/\/ops\.example\.com\/hub\//);
    expect(await readClientLink(env, link.split("/hub/")[1]!)).toMatchObject({ c: CO, t: "client", id: ANA_ID, own: 1 });
    const office = String((await officeVars(env, ctx, env.APP_URL!)).link);
    expect(await readClientLink(env, office.split("/hub/")[1]!)).toMatchObject({ t: "client", id: ANA_ID, via: "office" });
    // What the team reads (the copy on the timeline, which crews who work for the client read too) has no link at all.
    expect(keptVars(ctx).link).toBe(KEPT_LINK);
  });

  it("says where a moved visit was", async () => {
    world("visit.rescheduled", { activity: [event("visit.rescheduled", { was_scheduled_on: "2026-10-28", was_starts_at: "2026-10-28T18:30:00Z" })] });
    const ctx = await withEvent(adminClient(env), (await loadContext(adminClient(env), CO, "visit", VISIT))!, "visit.rescheduled", 5);
    expect(ctx.vars.old).toEqual({ date: "Wednesday, October 28", time: " at 2:30 PM" });
    expect(ctx.vars).toMatchObject({ date: "Thursday, October 29", time: " at 9:00 AM" });
    expect(ctx.was).toEqual({ scheduled_on: "2026-10-28", starts_at: "2026-10-28T18:30:00Z" });
  });

  it("says when a cancelled visit was to be, as its own day and time", async () => {
    world("visit.cancelled", { visits: [visit({ status: "unscheduled", scheduled_on: null, starts_at: null })], activity: [event("visit.cancelled", { was_scheduled_on: "2026-10-28", title: "Fall cleanup" })] });
    const ctx = await withEvent(adminClient(env), (await loadContext(adminClient(env), CO, "visit", VISIT))!, "visit.cancelled", 5);
    expect(ctx.vars).toMatchObject({ date: "Wednesday, October 28", time: "" });
  });

  it("is nothing for a deleted visit, unless its cancelled event kept it", async () => {
    world("visit.cancelled", { visits: [] });
    expect(await loadContext(adminClient(env), CO, "visit", VISIT)).toBeNull();
    const ctx = (await loadContext(adminClient(env), CO, "visit", VISIT, { title: "Fall cleanup", kind: "job", client_id: ANA_ID, job_id: null, property_id: PLACE }))!;
    expect(ctx.client?.display_name).toBe("Ana Smith");
    expect(ctx.vars).toMatchObject({ title: "Fall cleanup", address: "12 Oak St, Radford, VA" });
    expect(ctx.visit).toEqual({ status: "cancelled", scheduled_on: null, starts_at: null, gone: true });
    expect([ctx.jobId, ctx.propertyId, ctx.appPath]).toEqual([null, PLACE, "/schedule"]);
  });
});

describe("what a run has nothing to say about by the time it goes", () => {
  const ctx = (over: Row = {}, was?: Row) => ({ client: ANA as never, company: company() as never, visit: { status: "scheduled", scheduled_on: "2026-10-29", starts_at: "2026-10-29T13:00:00Z", ...over }, was: was as never });
  const now = new Date("2026-10-27T15:00:00Z");

  it("goes ahead for a visit still on the schedule and to come", () => {
    expect(visitNoticeSkip(ctx(), "visit.scheduled", now)).toBeNull();
    expect(visitNoticeSkip(ctx({}, { scheduled_on: "2026-10-28", starts_at: null }), "visit.rescheduled", now)).toBeNull();
    expect(visitNoticeSkip(ctx({ status: "cancelled" }), "visit.cancelled", now)).toBeNull();
    expect(visitNoticeSkip(ctx({ status: "cancelled", scheduled_on: null, starts_at: null, gone: true }), "visit.cancelled", now)).toBeNull();
  });

  it("skips a visit that started, came off the schedule or whose day passed", () => {
    expect(visitNoticeSkip(ctx({ status: "in_progress" }), "visit.scheduled", now)).toBe("The visit has started or is off the schedule");
    expect(visitNoticeSkip(ctx({ status: "cancelled" }), "visit.rescheduled", now)).toBe("The visit has started or is off the schedule");
    expect(visitNoticeSkip(ctx({ scheduled_on: "2026-10-26", starts_at: null }), "visit.scheduled", now)).toBe("The visit's day has passed");
    // Today where the company is still counts, though it's tomorrow in UTC by then.
    expect(visitNoticeSkip(ctx({ scheduled_on: "2026-10-27", starts_at: null }), "visit.scheduled", new Date("2026-10-28T02:00:00Z"))).toBeNull();
  });

  it("skips a move that's back where it was, and a cancelling that was undone", () => {
    expect(visitNoticeSkip(ctx({}, { scheduled_on: "2026-10-29", starts_at: "2026-10-29T13:00:00.000+00:00" }), "visit.rescheduled", now)).toBe("The visit is back where it was");
    expect(visitNoticeSkip(ctx({}, { scheduled_on: "2026-10-29", starts_at: "2026-10-29T14:00:00Z" }), "visit.rescheduled", now)).toBeNull();
    expect(visitNoticeSkip(ctx(), "visit.cancelled", now)).toBe("The visit is back on the schedule");
  });

  it("skips an archived client, and leaves every other rule alone", () => {
    expect(visitNoticeSkip({ ...ctx(), client: { ...ANA, status: "archived" } as never }, "visit.scheduled", now)).toBe("Ana Smith is archived");
    expect(visitNoticeSkip(ctx({ status: "completed" }), "visit.completed", now)).toBeNull();
    expect(visitNoticeSkip(ctx({ status: "scheduled" }), "visit.reminder", now)).toBeNull();
  });
});

describe("the engine, on a visit booked, moved or cancelled", () => {
  it("emails the client where the visit is now", async () => {
    const calls = world("visit.scheduled");
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(emailed()).toHaveLength(1);
    expect(emailed()[0]).toMatchObject({ to: "ana@example.com", subject: "Your visit on Thursday, October 29" });
    expect(emailed()[0]!.text).toContain("12 Oak St, Radford, VA on Thursday, October 29 at 9:00 AM. Was . https://ops.example.com/hub/");
    expect(calls.filter((c) => c.path === "rpc/visit_notice_is_repeat").map((c) => c.body)).toEqual([{ p_run: 7 }]);
    expect(finished(calls)[0]).toMatchObject({ p_status: "done" });
    // The copy on the timeline is about the visit, which crews who work for the client read: no link to the client's page in it.
    const kept = calls.find((c) => c.method === "POST" && c.path === "messages")!.body as { related_type: string; body: string };
    expect(kept.related_type).toBe("visit");
    expect(kept.body).toContain(KEPT_LINK);
    expect(kept.body).not.toContain("/hub/");
  });

  it("says where a moved visit was", async () => {
    world("visit.rescheduled", { activity: [event("visit.rescheduled", { was_scheduled_on: "2026-10-28", was_starts_at: "2026-10-28T18:30:00Z" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(emailed()[0]!.text).toContain("on Thursday, October 29 at 9:00 AM. Was Wednesday, October 28 at 2:30 PM.");
  });

  it("tells the client a deleted visit is cancelled, from what its event kept", async () => {
    const calls = world("visit.cancelled", {
      visits: [],
      activity: [event("visit.cancelled", { title: "Fall cleanup", was_scheduled_on: "2026-10-29", was_starts_at: "2026-10-29T13:00:00Z", property_id: PLACE, job_id: "job-1", deleted: true })],
    });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(emailed()[0]).toMatchObject({ to: "ana@example.com", subject: "Your visit on Thursday, October 29" });
    expect(emailed()[0]!.text).toContain("12 Oak St, Radford, VA on Thursday, October 29 at 9:00 AM.");
    expect(finished(calls)[0]).toMatchObject({ p_status: "done" });
  });

  it("still skips a deleted visit for any other rule", async () => {
    const calls = world("visit.rescheduled", { visits: [], activity: [event("visit.rescheduled", { title: "Fall cleanup" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_status: "skipped", p_error: "The record was deleted." });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends one message for multi-day work: another day's run says it", async () => {
    const calls = world("visit.scheduled", {}, true);
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_status: "skipped", p_error: "Another day of the same multi-day work says it" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends nothing for a visit that's back where it was, started, or an archived client's", async () => {
    let calls = world("visit.rescheduled", { activity: [event("visit.rescheduled", { was_scheduled_on: "2026-10-29", was_starts_at: "2026-10-29T13:00:00+00:00" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_error: "The visit is back where it was" });
    calls = world("visit.scheduled", { visits: [visit({ status: "en_route" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_error: "The visit has started or is off the schedule" });
    calls = world("visit.cancelled", { visits: [visit({ status: "cancelled" })], clients: [{ ...ANA, status: "archived" }], activity: [event("visit.cancelled", { was_scheduled_on: "2026-10-29" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_error: "Ana Smith is archived" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("doesn't ask about multi-day work for any other rule", async () => {
    const calls = world("visit.reminder", { automation_rules: [rule("visit.reminder")] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(calls.filter((c) => c.path === "rpc/visit_notice_is_repeat")).toEqual([]);
  });
});

describe("the day-before reminder", () => {
  const ctx = (over: Row = {}) => ({ visit: { status: "scheduled", scheduled_on: "2026-10-29", starts_at: null, ...over } });

  it("goes for the day it was for, whatever time the visit has by then", () => {
    expect(reminderSkip(ctx(), "2026-10-29")).toBeNull();
    expect(reminderSkip(ctx({ starts_at: "2026-10-29T18:00:00Z" }), "2026-10-29")).toBeNull();
    // An event that doesn't say its day, and a record that isn't a visit.
    expect(reminderSkip(ctx(), null)).toBeNull();
    expect(reminderSkip({}, "2026-10-29")).toBeNull();
  });

  it("isn't sent for a day the visit has left, or a visit that came off the schedule", () => {
    expect(reminderSkip(ctx({ scheduled_on: "2026-11-05" }), "2026-10-29")).toBe("The visit moved to another day, and is reminded the day before that one");
    expect(reminderSkip(ctx({ status: "cancelled" }), "2026-10-29")).toBe("The visit has started or is off the schedule");
    expect(reminderSkip(ctx({ status: "unscheduled", scheduled_on: null }), "2026-10-29")).toBe("The visit has started or is off the schedule");
  });

  it("is held back by the engine when the visit moved between the event and the email", async () => {
    let calls = world("visit.reminder", { automation_rules: [rule("visit.reminder")], activity: [event("visit.reminder", { scheduled_on: "2026-10-28" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("skipped");
    expect(finished(calls)[0]).toMatchObject({ p_status: "skipped", p_error: "The visit moved to another day, and is reminded the day before that one" });
    expect(sendEmail).not.toHaveBeenCalled();
    calls = world("visit.reminder", { automation_rules: [rule("visit.reminder")], activity: [event("visit.reminder", { scheduled_on: "2026-10-29" })] });
    expect(await executeRun(env, adminClient(env), run(), env.APP_URL!)).toBe("done");
    expect(emailed()[0]!.text).toContain("12 Oak St, Radford, VA on Thursday, October 29 at 9:00 AM.");
  });
});
