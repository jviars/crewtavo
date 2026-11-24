/**
 * Filing a text that came in (services/inboundTexts.ts): under the client whose phone it's from,
 * else under the client whose contact's phone it's from, else as from an unknown number, which is
 * kept (within its daily cap), told to the office once an hour, and never lost; and STOP and START
 * honoured for the number whoever's it is. The database is a stand-in that keeps what's written.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/lib/supabase";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import { receiveText, UNKNOWN_PER_NUMBER } from "../src/services/inboundTexts";
import { lastDigits } from "../src/services/textsOff";

interface State {
  companies: string[];
  clients: Array<{ id: string; company_id: string; phone: string; display_name: string }>;
  contacts: Array<{ id: string; company_id: string; client_id: string; name: string; phone: string }>;
  unknown: Array<{ company_id: string; phone_key: string; from_phone: string; body: string; created_at: string }>;
  stops: Set<string>;
  /** How each stop is kept (sms_stops.source and note), by the same key. */
  kept: Map<string, { source: string; note: string | null }>;
  /** The record of texts going off and on (sms_stop_changes). */
  changes: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  notices: Array<{ company_id: string; title: string; body: string; link: string }>;
  /** The companies each read of clients and contacts was kept to (null: every company). */
  scopes: Array<string[] | null>;
}

const fresh = (): State => ({ companies: ["co-1"], clients: [], contacts: [], unknown: [], stops: new Set(), kept: new Map(), changes: [], messages: [], notices: [], scopes: [] });

function fakeDb(state: State): Db {
  const from = (table: string) => {
    let op = "select";
    let row: any = null;
    let counting = false;
    let limit = Infinity;
    const eq: Record<string, unknown> = {};
    let since = "";
    let scope: string[] | null = null;
    /** The phone numbers asked for (PostgREST's match, as Postgres reads the pattern). */
    let phone: RegExp | null = null;
    const found = <T extends { company_id: string; phone: string }>(rows: T[]) => rows.filter((c) => (!scope || scope.includes(c.company_id)) && (!phone || phone.test(c.phone)));
    const answer = () => {
      if (table === "clients" && op === "select") return (state.scopes.push(scope), { data: found(state.clients) });
      if (table === "clients" && op === "update") return { data: [{ id: eq.id }] };
      if (table === "client_contacts") return { data: found(state.contacts) };
      if (table === "companies") return { data: state.companies.slice(0, limit).map((id) => ({ id })) };
      if (table === "memberships") return { data: [{ user_id: "owner-1" }] };
      if (table === "messages") return (state.messages.push(row), { data: null });
      if (table === "notifications") return (state.notices.push(...row), { data: null });
      if (table === "sms_stops") {
        const key = op === "upsert" ? `${row.company_id}:${row.phone_key}` : `${eq.company_id}:${eq.phone_key}`;
        const had = state.stops.has(key);
        // A stop the office or a phrase set becomes the keyword's when the keyword comes.
        if (op === "update") {
          const was = state.kept.get(key);
          if (!was || !["phrase", "office"].includes(was.source)) return { data: [] };
          state.kept.set(key, { ...was, source: row.source });
          return { data: [{ phone_key: key }] };
        }
        if (op === "upsert") {
          state.stops.add(key);
          if (!had) state.kept.set(key, { source: row.source, note: row.note });
        } else {
          state.stops.delete(key);
          state.kept.delete(key);
        }
        return { data: (op === "upsert") === had ? [] : [{ phone_key: key }] };
      }
      if (table === "sms_stop_changes") return (state.changes.push(row), { data: null });
      if (table === "unknown_texts" && op === "insert") return (state.unknown.push({ ...row, created_at: new Date().toISOString() }), { data: null });
      if (table === "unknown_texts" && counting) {
        return { count: state.unknown.filter((u) => u.company_id === eq.company_id && (!eq.phone_key || u.phone_key === eq.phone_key) && u.created_at >= since).length };
      }
      return { data: null };
    };
    const builder: Record<string, any> = {
      select: (_columns: string, options?: { head?: boolean }) => ((counting = Boolean(options?.head)), builder),
      insert: (value: unknown) => ((op = "insert"), (row = value), builder),
      upsert: (value: unknown) => ((op = "upsert"), (row = value), builder),
      update: (value: unknown) => ((op = "update"), (row = value), builder),
      delete: () => ((op = "delete"), builder),
      eq: (column: string, value: unknown) => ((eq[column] = value), builder),
      in: (column: string, values: string[]) => (column === "company_id" && (scope = values), builder),
      gte: (_column: string, value: string) => ((since = value), builder),
      limit: (n: number) => ((limit = n), builder),
      filter: (column: string, operator: string, value: string) => (column === "phone" && operator === "match" && (phone = new RegExp(value)), builder),
      then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve({ data: null, error: null, count: null, ...answer() }).then(resolve, reject),
    };
    for (const name of ["not", "is"]) builder[name] = () => builder;
    return builder;
  };
  return { from } as unknown as Db;
}

const text = (body: string, from = "+15405550163") => ({ from, body, sid: "SM1", keyword: /^stop$/i.test(body) ? ("stop" as const) : /^start$/i.test(body) ? ("start" as const) : null });
/** Words that ask to stop, as the webhook hands them over (core asksToStopTexts). */
const asking = (body: string, from = "+15405550163") => ({ from, body, sid: "SM1", keyword: "stop" as const, phrase: true });

afterEach(() => vi.useRealTimers());

describe("a text from a contact's phone", () => {
  it("goes on the contact's client's timeline, saying who sent it, and the office hears", async () => {
    const state = fresh();
    state.clients = [{ id: "client-1", company_id: "co-1", phone: "(540) 555-0100", display_name: "Pat Lee" }];
    state.contacts = [
      { id: "contact-1", company_id: "co-1", client_id: "client-1", name: "Mo Manager", phone: "540.555.0163" },
      { id: "contact-2", company_id: "co-1", client_id: "client-1", name: "Sam Spouse", phone: "540-555-0199" },
    ];
    expect(await receiveText(fakeDb(state), text("Gate code is 4411"), null)).toEqual(["co-1"]);
    expect(state.messages).toEqual([
      { company_id: "co-1", client_id: "client-1", channel: "sms", direction: "in", status: "received", body: "Gate code is 4411", external_id: "SM1", sent_by: null, from_phone: "+15405550163", from_name: "Mo Manager" },
    ]);
    expect(state.notices).toEqual([{ company_id: "co-1", user_id: "owner-1", kind: "client", title: "New text from Mo Manager", body: "Gate code is 4411", link: "/messages?client=client-1" }]);
    expect(state.unknown).toEqual([]);
  });

  it("is filed once for each client that keeps the number, and under the client alone where it's their own phone", async () => {
    const state = fresh();
    state.clients = [{ id: "client-1", company_id: "co-1", phone: "540-555-0163", display_name: "Mo Manager LLC" }];
    state.contacts = [
      // Mo manages two properties for co-2's clients, and is listed twice on one of them.
      { id: "contact-1", company_id: "co-2", client_id: "client-7", name: "Mo", phone: "5405550163" },
      { id: "contact-2", company_id: "co-2", client_id: "client-7", name: "Mo (cell)", phone: "+15405550163" },
      { id: "contact-3", company_id: "co-2", client_id: "client-8", name: "Mo Manager", phone: "1 540 555 0163" },
      // And a contact on another of co-1's clients, where the number is a client's own.
      { id: "contact-4", company_id: "co-1", client_id: "client-2", name: "Mo", phone: "540 555 0163" },
    ];
    expect((await receiveText(fakeDb(state), text("On my way"), null)).sort()).toEqual(["co-1", "co-2"]);
    expect(state.messages.map((m) => [m.company_id, m.client_id, m.from_name ?? null])).toEqual([["co-1", "client-1", null], ["co-2", "client-7", "Mo"], ["co-2", "client-8", "Mo Manager"]]);
    expect(state.notices.map((n) => n.title)).toEqual(["New text from a client", "New text from Mo", "New text from Mo Manager"]);
  });

  it("stops that number on STOP and starts it again on START, telling the office once", async () => {
    const state = fresh();
    state.contacts = [
      { id: "contact-1", company_id: "co-1", client_id: "client-1", name: "Mo Manager", phone: "540-555-0163" },
      { id: "contact-2", company_id: "co-1", client_id: "client-2", name: "Mo", phone: "540-555-0163" },
    ];
    await receiveText(fakeDb(state), text("STOP"), null);
    expect([...state.stops]).toEqual(["co-1:5405550163"]);
    expect(state.notices.map((n) => [n.title, n.body])).toEqual([["Mo Manager turned off texts", "They texted STOP from +15405550163. Crewtavo won't text that number until they text START."]]);
    // Both clients' timelines show it.
    expect(state.messages.map((m) => m.client_id)).toEqual(["client-1", "client-2"]);
    state.notices.length = 0;
    await receiveText(fakeDb(state), text("START"), null);
    expect([...state.stops]).toEqual([]);
    expect(state.notices.map((n) => n.title)).toEqual(["Mo Manager turned texts back on"]);
  });
});

describe("a text from a number kept as it's written at home", () => {
  it("is found however the number's last digits are spaced, and only by them", () => {
    const ends = (key: string, phone: string) => new RegExp(lastDigits(key)).test(phone);
    expect(ends("7700900123", "07700 900 123")).toBe(true);
    expect(ends("7700900123", "07700 900123 ")).toBe(true);
    expect(ends("1412345678", "+61 412 345 678")).toBe(true);
    expect(ends("5405550163", "(540) 555-01 63")).toBe(true);
    expect(ends("5405550163", "540-555-0163")).toBe(true);
    // Those four digits somewhere else in the number aren't its last ones.
    expect(ends("7700900123", "0123 456 789")).toBe(false);
    expect(ends("7700900123", "07700 901234")).toBe(false);
  });

  it("goes to the UK client whose number was typed with its 0, as Twilio gives it with +44", async () => {
    const state = fresh();
    state.clients = [
      { id: "client-1", company_id: "co-1", phone: "07700 900 123", display_name: "Pat Lee" },
      // Ends in the same four digits, but isn't Pat's.
      { id: "client-2", company_id: "co-1", phone: "07811 900123", display_name: "Sam Lee" },
    ];
    state.contacts = [{ id: "contact-1", company_id: "co-1", client_id: "client-3", name: "Mo", phone: "020 7946 0018" }];
    expect(await receiveText(fakeDb(state), text("Running late", "+447700900123"), null)).toEqual(["co-1"]);
    expect(await receiveText(fakeDb(state), text("Gate's open", "+442079460018"), null)).toEqual(["co-1"]);
    expect(state.messages.map((m) => [m.client_id, m.body, m.from_phone])).toEqual([["client-1", "Running late", "+447700900123"], ["client-3", "Gate's open", "+442079460018"]]);
    expect(state.unknown).toEqual([]);
  });

  it("stops the UK number on STOP, as the office's copy of it is matched when texting", async () => {
    const state = fresh();
    state.clients = [{ id: "client-1", company_id: "co-1", phone: "07700 900123", display_name: "Pat Lee" }];
    await receiveText(fakeDb(state), text("STOP", "+447700900123"), null);
    expect([...state.stops]).toEqual(["co-1:7700900123"]);
    expect(state.notices.map((n) => n.title)).toEqual(["Pat Lee turned off texts"]);
    // The stop list's key is the one the number on file has, however it was written.
    for (const kept of ["07700 900123", "07700 900 123", "+44 7700 900123", "+44 (0)7700 900123", "0044 7700 900123"]) expect(phoneMatchKey(kept), kept).toBe("7700900123");
  });

  it("goes to the Canadian client as it does to a US one", async () => {
    const state = fresh();
    state.clients = [{ id: "client-1", company_id: "co-1", phone: "(416) 555-0199", display_name: "Pat Lee" }];
    expect(await receiveText(fakeDb(state), text("See you then", "+14165550199"), null)).toEqual(["co-1"]);
    expect(state.messages.map((m) => m.client_id)).toEqual(["client-1"]);
  });
});

describe("a text that asks to stop without the keyword", () => {
  it("stops a contact's number as a phrase, with what they texted, and the office reads it", async () => {
    const state = fresh();
    state.contacts = [{ id: "contact-1", company_id: "co-1", client_id: "client-1", name: "Mo Manager", phone: "540-555-0163" }];
    expect(await receiveText(fakeDb(state), asking("Please stop texting me"), null)).toEqual(["co-1"]);
    expect([...state.kept]).toEqual([["co-1:5405550163", { source: "phrase", note: "Please stop texting me" }]]);
    expect(state.changes).toEqual([{ company_id: "co-1", phone_key: "5405550163", phone: "+15405550163", texts_on: false, source: "phrase", how: "text", note: "Please stop texting me", set_by: null, set_by_name: null }]);
    // On the client's timeline like any text, and the office is told what was written.
    expect(state.messages.map((m) => [m.client_id, m.body, m.from_name])).toEqual([["client-1", "Please stop texting me", "Mo Manager"]]);
    expect(state.notices.map((n) => [n.title, n.body])).toEqual([[
      "Mo Manager asked to stop texts",
      "They texted “Please stop texting me” from +15405550163, so Crewtavo won't text that number. If that isn't what they meant, you can turn its texts back on from the client's page, only if they ask.",
    ]]);
  });

  it("becomes the keyword's stop when STOP follows, and START still turns texts back on", async () => {
    const state = fresh();
    state.contacts = [{ id: "contact-1", company_id: "co-1", client_id: "client-1", name: "Mo Manager", phone: "540-555-0163" }];
    const db = fakeDb(state);
    await receiveText(db, asking("no more texts"), null);
    await receiveText(db, text("STOP"), null);
    expect(state.kept.get("co-1:5405550163")).toEqual({ source: "keyword", note: "no more texts" });
    expect(state.changes.map((c) => [c.texts_on, c.source])).toEqual([[false, "phrase"], [false, "keyword"]]);
    await receiveText(db, text("START"), null);
    expect([...state.stops]).toEqual([]);
    expect(state.changes.at(-1)).toMatchObject({ texts_on: true, source: "keyword" });
  });

  it("from a number nobody knows is honoured, and kept for the office to read", async () => {
    const state = fresh();
    expect(await receiveText(fakeDb(state), asking("stop texting me, wrong person"), null)).toEqual([]);
    expect([...state.kept]).toEqual([["co-1:5405550163", { source: "phrase", note: "stop texting me, wrong person" }]]);
    expect(state.unknown.map((u) => u.body)).toEqual(["stop texting me, wrong person"]);
    expect(state.notices.map((n) => [n.title, n.body, n.link])).toEqual([["An unknown number asked to stop texts", "+15405550163 texted “stop texting me, wrong person”, so Crewtavo won't text it.", "/messages?unknown=5405550163"]]);
  });
});

describe("a text from a number nobody knows", () => {
  it("is kept for the office, who hear on the bell where to find it", async () => {
    const state = fresh();
    state.clients = [{ id: "client-1", company_id: "co-1", phone: "(540) 555-0100", display_name: "Pat Lee" }];
    expect(await receiveText(fakeDb(state), text("Do you plow driveways?"), null)).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.unknown).toMatchObject([{ company_id: "co-1", from_phone: "+15405550163", phone_key: "5405550163", body: "Do you plow driveways?", external_id: "SM1" }]);
    expect(state.notices).toEqual([
      { company_id: "co-1", user_id: "owner-1", kind: "client", title: "New text from an unknown number", body: "+15405550163: Do you plow driveways?", link: "/messages?unknown=5405550163" },
    ]);
  });

  it("tells the office about a number once an hour, however much it texts, and keeps every text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T15:00:00Z"));
    const state = fresh();
    const db = fakeDb(state);
    await receiveText(db, text("Hello?"), null);
    await receiveText(db, text("Anyone there?"), null);
    expect(state.unknown.map((u) => u.body)).toEqual(["Hello?", "Anyone there?"]);
    expect(state.notices).toHaveLength(1);
    // Another number is its own news.
    await receiveText(db, text("A different person", "+15405550177"), null);
    expect(state.notices.map((n) => n.link)).toEqual(["/messages?unknown=5405550163", "/messages?unknown=5405550177"]);
    vi.setSystemTime(new Date("2026-11-13T16:00:01Z"));
    await receiveText(db, text("Still me"), null);
    expect(state.notices).toHaveLength(3);
    expect(state.unknown).toHaveLength(4);
  });

  it("keeps a day's cap for each number, so one number can't fill the instance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T15:00:00Z"));
    const state = fresh();
    const db = fakeDb(state);
    for (let i = 0; i < UNKNOWN_PER_NUMBER + 5; i++) await receiveText(db, text(`Text ${i}`), null);
    expect(state.unknown).toHaveLength(UNKNOWN_PER_NUMBER);
    // Another number still gets through, and so does this one a day later.
    await receiveText(db, text("Someone else", "+15405550188"), null);
    expect(state.unknown).toHaveLength(UNKNOWN_PER_NUMBER + 1);
    vi.setSystemTime(new Date("2026-11-14T15:00:01Z"));
    await receiveText(db, text("A day on"), null);
    expect(state.unknown.at(-1)!.body).toBe("A day on");
  });

  it("goes to the company whose own number it texted, and nowhere when several companies share the server's", async () => {
    const own = fresh();
    own.companies = ["co-1", "co-2", "co-3"];
    await receiveText(fakeDb(own), text("Hi"), ["co-2"]);
    expect(own.unknown.map((u) => u.company_id)).toEqual(["co-2"]);
    // Only that company's clients and contacts were looked at.
    expect(own.scopes).toEqual([["co-2"]]);

    const shared = fresh();
    shared.companies = ["co-1", "co-2"];
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    await receiveText(fakeDb(shared), text("Hi"), null);
    expect(shared.unknown).toEqual([]);
    expect(shared.notices).toEqual([]);
    expect(shared.scopes).toEqual([null]);
    quiet.mockRestore();
  });

  it("is honoured on STOP and START without being kept as a message", async () => {
    const state = fresh();
    state.companies = ["co-1", "co-2"];
    await receiveText(fakeDb(state), text("STOP"), null);
    // The server's number is every company's here, so none of them texts it again.
    expect([...state.stops].sort()).toEqual(["co-1:5405550163", "co-2:5405550163"]);
    expect(state.unknown).toEqual([]);
    expect(state.notices).toEqual([]);
    await receiveText(fakeDb(state), text("START"), ["co-2"]);
    expect([...state.stops]).toEqual(["co-1:5405550163"]);
  });
});
