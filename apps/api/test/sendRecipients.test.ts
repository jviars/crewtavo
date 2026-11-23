/**
 * Who a quote or invoice is sent to (deliver in services/sales.ts): the client and their ticked
 * contacts when nobody is named, exactly the people named when they are (the Send dialog's ticks
 * and typed addresses, or the one address older callers give), every one of them checked, and one
 * message on the timeline saying who got it. The database is a stand-in that answers each table's
 * query, and the mailer and texter keep what they were given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { HttpError } from "../src/lib/http";
import type { Db } from "../src/lib/supabase";
import { deliver, sendChoicesOf, sendSchema } from "../src/services/sales";

const emails = vi.hoisted(() => [] as Array<{ to: string; text: string }>);
const texts = vi.hoisted(() => [] as Array<{ to: string; body: string }>);
const refuse = vi.hoisted(() => ({ to: new Set<string>() }));
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: async (_env: Env, message: { to: string; text: string }) => {
    if (refuse.to.has(message.to)) return { sent: false, reason: "That email address isn't valid, so Resend didn't send it.", status: 422 };
    emails.push(message);
    return { sent: true, id: `email-${emails.length}` };
  },
  sendSms: async (_env: Env, message: { to: string; body: string }) => {
    texts.push(message);
    return { sent: true, id: `SM${texts.length}` };
  },
}));
vi.mock("../src/integrations/stripe", async (original) => ({ ...(await original<typeof import("../src/integrations/stripe")>()), stripeAccess: async () => null }));
const server = vi.hoisted(() => ({ tables: {} as Record<string, unknown> }));
vi.mock("../src/lib/supabase", async (original) => ({ ...(await original<typeof import("../src/lib/supabase")>()), adminClient: () => stubDb(server.tables) }));
vi.mock("../src/lib/links", async (original) => ({
  ...(await original<typeof import("../src/lib/links")>()),
  clientLinks: async (_env: Env, baseUrl: string, link: { id: string }) => ({ own: `${baseUrl}/own/${link.id}`, office: `${baseUrl}/office/${link.id}`, kept: "[Client Hub link]" }),
}));

const CO = "00000000-0000-4000-8000-0000000000a1";
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" } as Env;
const company = { name: "Ridge Paving", currency: "USD", email: null, phone: null, address: {}, settings: {} };
const client = { id: "client-1", display_name: "Pat Lee", email: "pat@example.com" as string | null, phone: "(540) 555-0111" as string | null, sms_opt_out_at: null as string | null };
const invoice = { id: "inv-1", number: 7, client_id: "client-1", total: 400, balance_due: 400, client };
const contacts = [
  { id: "c-1", name: "Mo Manager", email: "mo@example.com", phone: "540-555-0122", notify_email: true, notify_sms: true },
  { id: "c-2", name: "Sam Spouse", email: "sam@example.com", phone: "540-555-0133", notify_email: false, notify_sms: false },
];
const logged: Array<{ channel: string; body: string; recipients: unknown }> = [];

/** Answers each table with its rows, whatever the filters. */
function stubDb(tables: Record<string, unknown>): Db {
  const from = (table: string) => {
    const result = { data: tables[table] ?? null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "is", "order", "limit", "update", "upsert"]) builder[name] = () => builder;
    builder.insert = (row: unknown) => {
      if (table === "messages") logged.push(row as (typeof logged)[number]);
      return builder;
    };
    builder.maybeSingle = builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  return { from } as unknown as Db;
}
/**
 * The person's own client, and the company's settings on the server's: the browser's role doesn't
 * read companies.settings (20261123100100_prices_and_settings_for_the_office.sql), so deliver reads
 * the company with the server's key.
 */
const scope = (settings: Record<string, unknown> = {}, who = client) => {
  server.tables = { ...server.tables, companies: { ...company, settings } };
  return { db: stubDb({ clients: who, invoices: invoice }), env, companyId: CO, baseUrl: "https://ops.example.com" };
};
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  return [(error as HttpError).status, (error as HttpError).message];
};

afterEach(() => {
  emails.length = texts.length = logged.length = 0;
  refuse.to.clear();
  server.tables = {};
});

describe("sending an invoice with nobody named", () => {
  it("goes to the client and their contacts ticked for it, each with the right link", async () => {
    server.tables = { client_contacts: contacts };
    const result = await deliver(scope(), "invoice", invoice, sendSchema.parse({}));
    expect(result).toMatchObject({ sent: true, link: "https://ops.example.com/office/inv-1", sent_to: ["pat@example.com", "mo@example.com"] });
    expect(result).not.toHaveProperty("not_sent");
    // The client's own link only to the client's own address.
    expect(emails.map((m) => [m.to, m.text.includes("/own/inv-1")])).toEqual([["pat@example.com", true], ["mo@example.com", false]]);
    expect(emails[1]!.text).toContain("/office/inv-1");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ channel: "email", recipients: [{ to: "pat@example.com", name: "Pat Lee" }, { to: "mo@example.com", name: "Mo Manager" }] });
    // The timeline's copy holds no link: the team reads it.
    expect(logged[0]!.body).toContain("[Client Hub link]");
    expect(logged[0]!.body).not.toContain("/office/inv-1");
  });

  it("goes to the client alone while the company hasn't turned contacts on", async () => {
    server.tables = { client_contacts: contacts };
    const result = await deliver(scope({ contact_messages: { enabled: false, pending: true } }), "invoice", invoice, sendSchema.parse({ channel: "sms" }));
    expect(result.sent_to).toEqual(["(540) 555-0111"]);
    expect(texts.map((t) => t.to)).toEqual(["(540) 555-0111"]);
  });

  it("says what to fix when there's nobody to send it to", async () => {
    const bare = { ...client, email: null, phone: null };
    expect(await refusal(deliver(scope({}, bare), "invoice", { ...invoice, client: bare }, sendSchema.parse({})))).toEqual([400, "Add a valid email address for this client first."]);
    expect(await refusal(deliver(scope({}, bare), "invoice", { ...invoice, client: bare }, sendSchema.parse({ channel: "sms" })))).toEqual([400, "This client has no phone number."]);
    // Their phone texted STOP, and nobody else is ticked for texts.
    const stopped = { ...client, sms_opt_out_at: "2026-11-01T12:00:00Z" };
    expect(await refusal(deliver(scope({}, stopped), "invoice", { ...invoice, client: stopped }, sendSchema.parse({ channel: "sms" })))).toEqual([400, "Pat Lee asked not to be texted, so texts to them are off. Send it by email instead."]);
    expect(emails).toEqual([]);
    expect(texts).toEqual([]);
  });
});

describe("sending to the people named", () => {
  it("goes to exactly them, each once, and says whose each address is", async () => {
    server.tables = { client_contacts: contacts };
    const body = sendSchema.parse({ recipients: ["pat@example.com", "sam@example.com", "Bookkeeper@Example.com", " PAT@example.com "], to: "pat@example.com" });
    const result = await deliver(scope(), "invoice", invoice, body);
    // Mo is ticked for emails but wasn't named; Sam isn't ticked but was.
    expect(result.sent_to).toEqual(["pat@example.com", "sam@example.com", "Bookkeeper@Example.com"]);
    expect(logged[0]!.recipients).toEqual([
      { to: "pat@example.com", name: "Pat Lee" },
      { to: "sam@example.com", name: "Sam Spouse" },
      { to: "Bookkeeper@Example.com", name: "Bookkeeper@Example.com" },
    ]);
    expect(emails.filter((m) => m.text.includes("/own/")).map((m) => m.to)).toEqual(["pat@example.com"]);
  });

  it("still takes the one address an older caller gives, and sends to it alone", async () => {
    server.tables = { client_contacts: contacts };
    const result = await deliver(scope(), "invoice", invoice, sendSchema.parse({ to: "office@tenant.example" }));
    expect(result.sent_to).toEqual(["office@tenant.example"]);
    expect(emails.map((m) => m.to)).toEqual(["office@tenant.example"]);
  });

  it("refuses the whole send for an address or number that isn't one, before anything goes", async () => {
    expect(await refusal(deliver(scope(), "invoice", invoice, sendSchema.parse({ recipients: ["pat@example.com", "mo at example"] })))).toEqual([400, "mo at example isn't a valid email address."]);
    expect(await refusal(deliver(scope(), "invoice", invoice, sendSchema.parse({ to: "nope" })))).toEqual([400, "Add a valid email address for this client first."]);
    expect(await refusal(deliver(scope(), "invoice", invoice, sendSchema.parse({ channel: "sms", recipients: ["540-555-0122", "ext 12"] })))).toEqual([400, "ext 12 isn't a phone number."]);
    expect(emails).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("takes ten at most", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    expect(sendSchema.safeParse({ recipients: eleven }).success).toBe(false);
    // Ten named and one more as `to` is eleven too.
    expect(await refusal(deliver(scope(), "invoice", invoice, sendSchema.parse({ recipients: eleven.slice(0, 10), to: "one-more@example.com" })))).toEqual([400, "Send it to 10 people at most."]);
    expect((await deliver(scope(), "invoice", invoice, sendSchema.parse({ recipients: eleven.slice(0, 10) }))).sent_to).toHaveLength(10);
  });

  it("never texts a number that texted STOP, the client's own or anyone's", async () => {
    const stopped = { ...client, sms_opt_out_at: "2026-11-01T12:00:00Z" };
    expect(await refusal(deliver(scope({}, stopped), "invoice", { ...invoice, client: stopped }, sendSchema.parse({ channel: "sms", recipients: ["540-555-0122", "+1 540 555 0111"] })))).toEqual([
      400, "Pat Lee asked not to be texted, so texts to them are off. Send it by email instead.",
    ]);
    server.tables = { client_contacts: contacts, sms_stops: [{ phone_key: "5405550133" }] };
    expect(await refusal(deliver(scope(), "invoice", invoice, sendSchema.parse({ channel: "sms", recipients: ["(540) 555-0111", "540-555-0133"] })))).toEqual([
      400, "540-555-0133 asked not to be texted, so Crewtavo can't text it.",
    ]);
    expect(texts).toEqual([]);
  });

  it("says who it didn't reach when it reached someone else, and keeps both on the timeline", async () => {
    refuse.to.add("typo@example.con");
    const result = await deliver(scope(), "invoice", invoice, sendSchema.parse({ recipients: ["pat@example.com", "typo@example.con"] }));
    expect(result).toMatchObject({ sent: true, sent_to: ["pat@example.com"], not_sent: [{ to: "typo@example.con", reason: "That email address isn't valid, so Resend didn't send it." }] });
    expect(result).not.toHaveProperty("reason");
    expect(logged[0]!.recipients).toEqual([{ to: "pat@example.com", name: "Pat Lee" }, { to: "typo@example.con", name: "typo@example.con", failed: true }]);
  });

  it("says why when it reached nobody, and keeps nothing", async () => {
    refuse.to.add("pat@example.com");
    const result = await deliver(scope(), "invoice", invoice, sendSchema.parse({ recipients: ["pat@example.com"] }));
    expect(result).toMatchObject({ sent: false, reason: "That email address isn't valid, so Resend didn't send it.", status: 422, sent_to: [] });
    expect(logged).toEqual([]);
  });
});

describe("who the Send dialog offers", () => {
  it("is the client and every contact, by email and by text, with who starts ticked", async () => {
    server.tables = { client_contacts: contacts, sms_stops: [{ phone_key: "5405550122" }] };
    const offered = await sendChoicesOf(scope(), "invoice", "inv-1");
    expect(offered.email.map((c) => [c.name, c.to, c.ticked])).toEqual([["Pat Lee", "pat@example.com", true], ["Mo Manager", "mo@example.com", true], ["Sam Spouse", "sam@example.com", false]]);
    expect(offered.sms.map((c) => [c.name, c.ticked, c.blocked ?? null])).toEqual([["Pat Lee", true, null], ["Mo Manager", false, "Texts off"], ["Sam Spouse", false, null]]);
    expect(offered).toMatchObject({ contacts_on: true, max: 10 });
  });
});
