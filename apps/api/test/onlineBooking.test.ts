/**
 * Online booking against a stand-in for PostgREST and the mail and text providers: a form's
 * openings, a client booking one (at once, or waiting on the office), a time that has gone, the
 * limits, and the office booking a time asked for. What the database itself holds (one booking for
 * an opening, the most a day, one upcoming booking for a person) is tested in
 * supabase/tests/online_booking_test.sql.
 */
import type { IncomingMessage } from "node:http";
import { localTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { adminClient } from "../src/lib/supabase";
import { bookAskedTime } from "../src/services/onlineBooking";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
};
const texting: Env = { ...env, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "token", TWILIO_FROM_NUMBER: "+15405550000" };

interface Call { method: string; url: URL; path: string; body: any }

/** Stub fetch: `answer` returns a Response, or rows to send back as JSON. */
function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies stay text
    }
    const call: Call = { method: (init?.method ?? "GET").toUpperCase(), url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}
const connectedFrom = (remoteAddress: string, e: Env = env) => ({ ...e, incoming: { socket: { remoteAddress } } as unknown as IncomingMessage });

const NY = "America/New_York";
// Monday, Nov 2, 2026, 2 PM in New York: the first day a form with a day's lead time offers is Tuesday the 3rd.
const NOW = new Date("2026-11-02T19:00:00Z");
const at = (date: string, time: string) => zonedTimeToUtc(date, time, NY).toISOString();
const MORNING = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"];
const VISIT = "00000000-0000-4000-8000-0000000000a1";
const plain = (text: string) => text.replace(/\s/g, " ");

beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ["Date"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Options {
  /** The form's own settings, over an estimate form that books at once with no crew. */
  form?: Record<string, unknown>;
  /** When whoever the form books is busy. */
  busy?: Array<{ starts_at: string; ends_at: string }>;
  /** How many of the form's bookings each day has. */
  counts?: Array<{ day: string; booked: number }>;
  /** What book_form_time answers: a booking, or the error it raises. */
  book?: (args: Record<string, any>) => Response | unknown;
  /** Rate limits whose key matches are used up. */
  full?: RegExp;
}

/** One company's database: open 8 to 12 every day, an hour a visit. */
function database(options: Options = {}) {
  const company = {
    id: "co-1", name: "Acme Roofing", phone: "540-555-0100", email: "office@acme.example", timezone: NY, address: {},
    settings: { working_hours: { start: "08:00", end: "12:00", days: [0, 1, 2, 3, 4, 5, 6] } },
  };
  const form = {
    id: "form-1", name: "Free roof inspection", kind: "assessment", questions: [], service_area_zips: [], lead_time_days: 1, slot_minutes: 60, max_per_day: null,
    requires_approval: false, pick_time: true, crew_id: null, ...options.form,
  };
  const calls = serve((call) => {
    if (call.path === "rpc/rate_limit_hit") return !options.full?.test(call.body.p_key);
    if (call.path === "companies") return [company];
    if (call.path === "intake_forms") return [form];
    if (call.path === "rpc/booking_busy_times") return (options.busy ?? []).filter((b) => b.starts_at < call.body.p_to && b.ends_at > call.body.p_from);
    if (call.path === "rpc/booking_day_counts") return options.counts ?? [];
    if (call.path === "rpc/book_form_time") {
      return options.book?.(call.body) ?? {
        client_id: "client-2", property_id: "property-2", matched: false, new_property: true, request_id: "request-2", number: 1042,
        visit_id: form.requires_approval ? null : VISIT, starts_at: call.body.p_starts_at, ends_at: new Date(Date.parse(call.body.p_starts_at) + 3_600_000).toISOString(), booked: !form.requires_approval,
      };
    }
    if (call.path === "rpc/booking_form_client") return { client_id: "client-2", property_id: "property-2", matched: false, new_property: true };
    if (call.method === "POST" && call.path === "requests") return Response.json({ id: "request-3", number: 1043 }, { status: 201 });
    if (call.method === "GET" && call.path === "clients") return [{ id: "client-2", display_name: "Bob Jones", email: "bob@example.com", phone: "540-555-0177", sms_opt_out_at: null }];
    if (call.url.host === "api.resend.com") return { id: "email-1" };
    if (call.url.host === "api.twilio.com") return Response.json({ sid: "SM1" }, { status: 201 });
    if (call.path === "rpc/call_off_visit_notice") return 1;
    return [];
  });
  const rpc = (name: string) => calls.filter((c) => c.path === `rpc/${name}`).map((c) => c.body);
  const limits = () => rpc("rate_limit_hit").map((b) => [b.p_key, b.p_max, b.p_window_seconds]);
  const emails = () => calls.filter((c) => c.url.host === "api.resend.com").map((c) => c.body as { to: string[]; subject: string; text: string });
  const texts = () => calls.filter((c) => c.url.host === "api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(String(c.body))) as { To: string; Body: string });
  const made = () => calls.filter((c) => c.method === "POST" && ["requests", "rpc/booking_form_client", "rpc/book_form_time", "visits"].includes(c.path)).map((c) => c.path);
  return { calls, rpc, limits, emails, texts, made };
}

const get = (path: string, bindings = connectedFrom("203.0.113.9")) => app.request(`/api${path}`, {}, bindings);
const post = (path: string, body: unknown, bindings = connectedFrom("203.0.113.9")) =>
  app.request(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, bindings);
const lead = { name: "Bob Jones", email: "bob@example.com", address: { line1: "12 Main St", city: "Radford", postal_code: "24141" } };
const FORM = "/public/forms/acme/inspection";
const timesOn = (slots: Array<{ date: string; starts_at: string }>, date: string) => slots.filter((s) => s.date === date).map((s) => localTime(new Date(s.starts_at), NY));

describe("a booking form that lets clients pick a time", () => {
  it("tells the page its time zone, how long a visit is and how far ahead it books; a plain form says nothing of times", async () => {
    database();
    const view = await (await get(FORM)).json();
    expect(view.booking).toEqual({
      timezone: NY, timezone_label: "Eastern Time (New York)", minutes: 60, window_min: 0, needs_ok: false, needs_postal_code: false, first: "2026-11-03", last: "2027-01-01",
    });
    database({ form: { pick_time: false } });
    expect(await (await get(FORM)).json()).toEqual({ company: { name: "Acme Roofing", phone: "540-555-0100", logo: null, color: null, texts: false, privacy_url: null }, form: { name: "Free roof inspection", kind: "assessment", questions: [] } });
    // A business that can text says so, so the phone box says what giving a number agrees to.
    expect((await (await get(FORM, connectedFrom("203.0.113.9", texting))).json()).company).toEqual({ name: "Acme Roofing", phone: "540-555-0100", logo: null, color: null, texts: true, privacy_url: null });
    database({ form: { requires_approval: true, service_area_zips: ["24141"] } });
    expect((await (await get(FORM)).json()).booking).toMatchObject({ needs_ok: true, needs_postal_code: true });
  });

  it("offers a week of open times in the company's working hours, after the lead time, and nothing else about the schedule", async () => {
    const db = database({ busy: [{ starts_at: at("2026-11-03", "09:30"), ends_at: at("2026-11-03", "10:15") }] });
    const res = await get(`${FORM}/openings`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const week = await res.json();
    expect({ from: week.from, to: week.to, first: week.first, last: week.last }).toEqual({ from: "2026-11-03", to: "2026-11-09", first: "2026-11-03", last: "2027-01-01" });
    // Around the busy 9:30 to 10:15, and the other days whole.
    expect(timesOn(week.slots, "2026-11-03")).toEqual(["08:00", "08:30", "10:30", "11:00"]);
    expect(timesOn(week.slots, "2026-11-04")).toEqual(MORNING);
    expect(new Set(week.slots.map((s: { date: string }) => s.date)).size).toBe(7);
    // Times only: a day, a start and an end.
    expect(Object.keys(week).sort()).toEqual(["first", "from", "last", "slots", "to"]);
    expect(Object.keys(week.slots[0]).sort()).toEqual(["date", "ends_at", "starts_at"]);
    // The whole company's schedule when the form has no crew, for that week only, by the company's own midnight.
    expect(db.rpc("booking_busy_times")).toEqual([{ p_company: "co-1", p_crew: null, p_from: at("2026-11-03", "00:00"), p_to: at("2026-11-10", "00:00") }]);
    // The form has no most-a-day, so the days aren't counted.
    expect(db.rpc("booking_day_counts")).toEqual([]);
  });

  it("reads the form's crew, its visit length, its lead time and its most a day", async () => {
    const db = database({ form: { crew_id: "crew-1", slot_minutes: 90, lead_time_days: 3, max_per_day: 2 }, counts: [{ day: "2026-11-05", booked: 2 }, { day: "2026-11-06", booked: 1 }] });
    const week = await (await get(`${FORM}/openings`)).json();
    expect(week.first).toBe("2026-11-05");
    // The 5th has its two already; the 6th has room.
    expect(week.slots[0].date).toBe("2026-11-06");
    expect(timesOn(week.slots, "2026-11-06")).toEqual(MORNING.slice(0, 6));
    expect(Date.parse(week.slots[0].ends_at) - Date.parse(week.slots[0].starts_at)).toBe(90 * 60_000);
    expect(db.rpc("booking_busy_times")[0]).toMatchObject({ p_crew: "crew-1" });
    expect(db.rpc("booking_day_counts")).toEqual([{ p_company: "co-1", p_form: "form-1", p_from: "2026-11-05", p_to: "2026-11-11" }]);
  });

  it("gives the week asked for, and with none asked, the first week that has a time", async () => {
    database();
    const later = await (await get(`${FORM}/openings?from=2026-11-20`)).json();
    expect([later.from, later.to, later.slots[0].date]).toEqual(["2026-11-20", "2026-11-26", "2026-11-20"]);
    // A week before the first day starts at the first day; past the last there's nothing.
    expect((await (await get(`${FORM}/openings?from=2026-01-01`)).json()).from).toBe("2026-11-03");
    expect((await (await get(`${FORM}/openings?from=2027-02-01`)).json()).slots).toEqual([]);
    // The crew is away all of the first week: the answer is the second.
    const db = database({ busy: [{ starts_at: at("2026-11-03", "00:00"), ends_at: at("2026-11-10", "00:00") }] });
    const first = await (await get(`${FORM}/openings`)).json();
    expect([first.from, first.slots[0].date]).toEqual(["2026-11-10", "2026-11-10"]);
    expect(db.rpc("booking_busy_times")).toHaveLength(2);
  });

  it("keeps the same clock time across a clock change, in the company's zone", async () => {
    // Friday, Oct 30, 2026; the clocks go back on Sunday, Nov 1.
    vi.setSystemTime(new Date("2026-10-30T15:00:00Z"));
    database();
    const week = await (await get(`${FORM}/openings`)).json();
    const eights = week.slots.filter((s: { starts_at: string }) => localTime(new Date(s.starts_at), NY) === "08:00").slice(0, 3).map((s: { starts_at: string }) => s.starts_at);
    expect(eights).toEqual(["2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z", "2026-11-02T13:00:00.000Z"]);
  });

  it("turns an address outside the service area away before any time is read, as the form does", async () => {
    const db = database({ form: { service_area_zips: ["24141"] } });
    for (const postal of ["", "?postal_code=90210"]) {
      const res = await get(`${FORM}/openings${postal}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Sorry, Acme Roofing doesn't serve that area yet." });
    }
    expect(db.rpc("booking_busy_times")).toEqual([]);
    expect((await get(`${FORM}/openings?postal_code=24141-1234`)).status).toBe(200);
  });

  it("isn't there for a form that doesn't offer times, and is limited per visitor and per company", async () => {
    database({ form: { pick_time: false } });
    expect((await get(`${FORM}/openings`)).status).toBe(404);
    const ok = database();
    expect((await get(`${FORM}/openings`)).status).toBe(200);
    expect(ok.limits()).toEqual([["form-openings:ip:203.0.113.9", 120, 3600], ["form-openings:company:co-1", 3000, 3600]]);
    for (const full of [/^form-openings:ip:/, /^form-openings:company:/]) {
      const limited = database({ full });
      expect((await get(`${FORM}/openings`)).status).toBe(429);
      expect(limited.rpc("booking_busy_times")).toEqual([]);
    }
  });
});

describe("a client books a time", () => {
  const nine = at("2026-11-03", "09:00");

  it("books it at once: the request and its visit together, told on the page and by email, and the booked rule stays quiet", async () => {
    const db = database();
    const res = await post(FORM, { ...lead, answers: { notes: "Gate code 1234" }, starts_at: nine });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, reference: 1042, booking: { status: "booked", starts_at: nine, ends_at: at("2026-11-03", "10:00"), emailed: true, texted: false } });
    expect(body.booking.calendar).toContain("BEGIN:VCALENDAR");
    expect(body.booking.calendar).toContain("SUMMARY:Acme Roofing: Assessment: Free roof inspection");
    // One call makes all of it; the form doesn't make a client or a request by itself.
    expect(db.made()).toEqual(["rpc/book_form_time"]);
    expect(db.rpc("book_form_time")).toMatchObject([{
      p_company: "co-1", p_form: "form-1", p_name: "Bob Jones", p_email: "bob@example.com", p_address: lead.address, p_answers: { notes: "Gate code 1234" }, p_starts_at: nine,
    }]);
    // The email and the phone are both named in the call, null when one wasn't typed: left out, the
    // database has no function by those names and nobody with only an email could book.
    const sent = db.rpc("book_form_time")[0] as Record<string, unknown>;
    expect("p_email" in sent && "p_phone" in sent).toBe(true);
    // The day's openings were read again just before.
    expect(db.rpc("booking_busy_times")).toEqual([{ p_company: "co-1", p_crew: null, p_from: at("2026-11-03", "00:00"), p_to: at("2026-11-04", "00:00") }]);
    const [email] = db.emails();
    expect(email!.to).toEqual(["bob@example.com"]);
    expect(plain(email!.subject)).toBe("You're booked for Tue, Nov 3, 9:00 AM");
    expect(plain(email!.text)).toContain("Hi Bob,");
    expect(plain(email!.text)).toContain("You're booked: Assessment: Free roof inspection on Tue, Nov 3, 9:00 AM.");
    // Their own page, where they can ask to move or cancel it: in the email only, never in the form's answer.
    expect(email!.text).toMatch(/https:\/\/ops\.example\.com\/hub\//);
    expect(JSON.stringify(body)).not.toMatch(/\/hub\//);
    expect(db.calls.find((c) => c.method === "POST" && c.path === "messages")?.body).toMatchObject({ client_id: "client-2", channel: "email", direction: "out", related_type: "visit", related_id: VISIT });
    expect(db.rpc("call_off_visit_notice")).toEqual([{ p_visit: VISIT }]);
    expect(db.texts()).toEqual([]);
  });

  it("texts the confirmation too when the company can text and they gave a number", async () => {
    const db = database();
    const body = await (await post(FORM, { ...lead, phone: "540-555-0177", starts_at: nine }, connectedFrom("203.0.113.9", texting))).json();
    expect(body.booking).toMatchObject({ emailed: true, texted: true });
    expect(db.texts()).toHaveLength(1);
    expect(plain(db.texts()[0]!.Body)).toBe("Acme Roofing: You're booked: Assessment: Free roof inspection on Tue, Nov 3, 9:00 AM. Questions? Call 540-555-0100.  Reply STOP to opt out.");
    // No number given: no text, even to the number on their record.
    const quiet = database();
    expect((await (await post(FORM, { ...lead, starts_at: nine }, connectedFrom("203.0.113.9", texting))).json()).booking.texted).toBe(false);
    expect(quiet.texts()).toEqual([]);
  });

  it("keeps where the number came from when it's given on a form of a business that texts", async () => {
    const noted = (db: ReturnType<typeof database>) => db.calls.filter((c) => c.method === "PATCH" && c.path === "clients").map((c) => [c.url.searchParams.get("id"), c.body.sms_consent_source, typeof c.body.sms_consent_at]);
    // The number typed is the one on their record: noted as given on the booking form.
    let db = database();
    await post(FORM, { ...lead, phone: "(540) 555-0177", starts_at: nine }, connectedFrom("203.0.113.9", texting));
    expect(noted(db)).toEqual([["eq.client-2", "booking_form", "string"]]);
    // A form with no times does the same.
    db = database({ form: { pick_time: false } });
    await post(FORM, { ...lead, phone: "540-555-0177" }, connectedFrom("203.0.113.9", texting));
    expect(noted(db)).toEqual([["eq.client-2", "booking_form", "string"]]);
    // A client already here keeps the number on their record: another one typed isn't theirs to note.
    db = database();
    await post(FORM, { ...lead, phone: "540-555-0199", starts_at: nine }, connectedFrom("203.0.113.9", texting));
    expect(noted(db)).toEqual([]);
    // No number, or a business that can't text (the form said nothing about texts): nothing to note.
    db = database();
    await post(FORM, { ...lead, starts_at: nine }, connectedFrom("203.0.113.9", texting));
    await post(FORM, { ...lead, phone: "540-555-0177", starts_at: nine });
    expect(noted(db)).toEqual([]);
  });

  it("holds the time for the office's OK on a form that needs it, and says it isn't confirmed yet", async () => {
    const db = database({ form: { requires_approval: true } });
    const body = await (await post(FORM, { ...lead, starts_at: nine })).json();
    expect(body.booking).toMatchObject({ status: "asked", starts_at: nine, emailed: true });
    expect(body.booking.calendar).toBeUndefined();
    const [email] = db.emails();
    expect(plain(email!.subject)).toBe("We got your request for Tue, Nov 3, 9:00 AM");
    expect(plain(email!.text)).toContain("This time isn't confirmed yet");
    expect(email!.text).not.toMatch(/\/hub\//);
    expect(db.calls.find((c) => c.method === "POST" && c.path === "messages")?.body).toMatchObject({ related_type: "request", related_id: "request-2" });
    // No visit yet, so there's no booked notice to call off.
    expect(db.rpc("call_off_visit_notice")).toEqual([]);
  });

  it("says plainly when the time has just been taken, and makes nothing", async () => {
    const taken = { error: "That time was just taken. Please pick another." };
    // Something went onto the schedule there since the page showed it.
    const busy = database({ busy: [{ starts_at: at("2026-11-03", "09:00"), ends_at: at("2026-11-03", "10:00") }] });
    const res = await post(FORM, { ...lead, starts_at: nine });
    expect([res.status, await res.json()]).toEqual([409, taken]);
    expect(busy.made()).toEqual([]);
    // Two people sent at once, or the day filled: the database turned the second away.
    for (const code of ["CBTKN", "CBFUL"]) {
      const lost = database({ book: () => Response.json({ code, message: "That time was just taken.", details: null, hint: null }, { status: 400 }) });
      const second = await post(FORM, { ...lead, starts_at: nine });
      expect([code, second.status, await second.json()]).toEqual([code, 409, taken]);
      expect(lost.emails()).toEqual([]);
      expect(lost.rpc("call_off_visit_notice")).toEqual([]);
    }
  });

  it("only takes a time the form offers: not outside working hours, off the step, before the lead time or past the 60 days", async () => {
    for (const starts_at of [at("2026-11-03", "07:00"), at("2026-11-03", "11:30"), at("2026-11-03", "09:10"), at("2026-11-02", "16:00"), at("2027-01-05", "09:00"), at("2026-10-20", "09:00")]) {
      const db = database();
      const res = await post(FORM, { ...lead, starts_at });
      expect([starts_at, res.status]).toEqual([starts_at, 409]);
      expect(db.made()).toEqual([]);
    }
    expect((await post(FORM, { ...lead, starts_at: "tomorrow at nine" })).status).toBe(400);
  });

  it("lets one person hold one upcoming booking from a form, and tells them when it is", async () => {
    const db = database({
      book: () => Response.json({ code: "CBONE", message: "You already have a booking from this form.", details: JSON.stringify({ scheduled_on: "2026-11-10", starts_at: at("2026-11-10", "09:00") }), hint: null }, { status: 400 }),
    });
    const res = await post(FORM, { ...lead, starts_at: nine });
    expect(res.status).toBe(409);
    expect(plain((await res.json()).error)).toBe("There's already a booking with this email or phone. To change it, call us at 540-555-0100.");
    expect(db.emails()).toEqual([]);
  });

  it("keeps the form's limits and its service area: nothing is booked past them", async () => {
    const ok = database();
    expect((await post(FORM, { ...lead, starts_at: nine })).status).toBe(201);
    expect(ok.limits()).toEqual([["form:ip:203.0.113.9", 10, 3600], ["form:company:co-1", 100, 3600]]);
    for (const full of [/^form:ip:/, /^form:company:/]) {
      const limited = database({ full });
      expect((await post(FORM, { ...lead, starts_at: nine })).status).toBe(429);
      expect(limited.made()).toEqual([]);
    }
    const area = database({ form: { service_area_zips: ["90210"] } });
    const outside = await post(FORM, { ...lead, starts_at: nine });
    expect([outside.status, await outside.json()]).toEqual([400, { error: "Sorry, Acme Roofing doesn't serve that area yet." }]);
    expect(area.made()).toEqual([]);
  });

  it("still makes a plain request when no time comes with it: the web app from before, or a form with times off", async () => {
    const before = database();
    const res = await post(FORM, lead);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, reference: 1043 });
    expect(before.made()).toEqual(["rpc/booking_form_client", "requests"]);
    expect(before.calls.find((c) => c.method === "POST" && c.path === "requests")!.body).not.toHaveProperty("asked_starts_at");
    expect(before.emails()).toEqual([]);
    // A time sent to a form that doesn't offer them is left out.
    const off = database({ form: { pick_time: false } });
    expect(await (await post(FORM, { ...lead, starts_at: nine })).json()).toEqual({ ok: true, reference: 1043 });
    expect(off.made()).toEqual(["rpc/booking_form_client", "requests"]);
  });
});

describe("the office books a time a client asked for", () => {
  const office = () => ({ db: adminClient(env), companyId: "co-1", role: "office" as const, permissions: ["schedule" as const, "sales" as const], userId: "user-1" });
  const asked = { asked_starts_at: at("2026-11-03", "09:00"), asked_ends_at: at("2026-11-03", "10:00") };

  function requestDb(options: { request?: Record<string, unknown>; busy?: boolean } = {}) {
    const request = {
      id: "request-2", title: "Free roof inspection", status: "new", client_id: "client-2", property_id: "property-2", assigned_to: null, ...asked,
      form: { kind: "assessment", name: "Free roof inspection", crew_id: "crew-1" }, visits: [], ...options.request,
    };
    const calls = serve((call) => {
      if (call.path === "companies") return [{ id: "co-1", name: "Acme Roofing", phone: "540-555-0100", email: null, timezone: NY, address: {}, settings: {} }];
      if (call.method === "GET" && call.path === "requests") return [request];
      if (call.path === "rpc/booking_busy_times") return options.busy ? [{ starts_at: at("2026-11-03", "09:30"), ends_at: at("2026-11-03", "10:30") }] : [];
      if (call.method === "POST" && call.path === "visits") return Response.json([{ id: VISIT }], { status: 201 });
      if (call.method === "GET" && call.path === "clients") return [{ id: "client-2", display_name: "Bob Jones", email: "bob@example.com", phone: null, sms_opt_out_at: null }];
      if (call.url.host === "api.resend.com") return { id: "email-1" };
      return [];
    });
    return calls;
  }

  it("as the assessment the office would schedule, at a fixed time, for the form's crew, and tells the client it's confirmed", async () => {
    const calls = requestDb();
    expect(await bookAskedTime(office(), env, "request-2", false, "https://ops.example.com")).toEqual({ booked: true, visit_id: VISIT, emailed: true, texted: false });
    // Its own asked-for time isn't in its way.
    expect(calls.find((c) => c.path === "rpc/booking_busy_times")!.body).toEqual({ p_company: "co-1", p_crew: "crew-1", p_from: asked.asked_starts_at, p_to: asked.asked_ends_at, p_except_request: "request-2" });
    expect(calls.find((c) => c.method === "POST" && c.path === "visits")!.body).toMatchObject([{
      company_id: "co-1", kind: "assessment", request_id: "request-2", property_id: "property-2", title: "Assessment: Free roof inspection", crew_id: "crew-1", status: "scheduled",
      starts_at: asked.asked_starts_at, ends_at: asked.asked_ends_at, time_fixed: true,
    }]);
    expect(calls.find((c) => c.method === "PATCH" && c.path === "requests")!.body).toEqual({ status: "assessment_scheduled" });
    const email = calls.find((c) => c.url.host === "api.resend.com")!.body;
    expect(plain(email.subject)).toBe("You're booked for Tue, Nov 3, 9:00 AM");
    expect(calls.find((c) => c.path === "rpc/call_off_visit_notice")!.body).toEqual({ p_visit: VISIT });
  });

  it("asks first when the time has been taken since, and books it anyway when told to", async () => {
    const calls = requestDb({ busy: true });
    expect(await bookAskedTime(office(), env, "request-2", false, null)).toEqual({ booked: false, taken: true });
    expect(calls.some((c) => c.method === "POST" && c.path === "visits")).toBe(false);
    expect(await bookAskedTime(office(), env, "request-2", true, null)).toMatchObject({ booked: true, visit_id: VISIT });
  });

  it("not twice, not after the time has passed, and not for a request that asked for none", async () => {
    requestDb({ request: { status: "assessment_scheduled" } });
    await expect(bookAskedTime(office(), env, "request-2", false, null)).rejects.toThrow(/scheduled or closed since/);
    requestDb({ request: { visits: [{ id: VISIT, kind: "assessment", status: "scheduled" }] } });
    await expect(bookAskedTime(office(), env, "request-2", false, null)).rejects.toThrow(/scheduled or closed since/);
    requestDb({ request: { asked_starts_at: at("2026-11-02", "09:00"), asked_ends_at: at("2026-11-02", "10:00") } });
    await expect(bookAskedTime(office(), env, "request-2", false, null)).rejects.toThrow(/has passed/);
    requestDb({ request: { asked_starts_at: null, asked_ends_at: null } });
    await expect(bookAskedTime(office(), env, "request-2", false, null)).rejects.toThrow(/didn't ask for a time/);
    requestDb();
    await expect(bookAskedTime({ ...office(), role: "field_crew" as never }, env, "request-2", false, null)).rejects.toThrow(/can't schedule assessments/);
  });
});
