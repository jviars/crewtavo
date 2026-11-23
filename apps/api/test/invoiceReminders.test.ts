/**
 * Payment reminders (remindInvoices in services/sales.ts): how the email words the due date, by the
 * company's own calendar, and whether it says to pay online. The database is a stand-in that answers each table's query, and the mailer
 * keeps what it was given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import type { Db } from "../src/lib/supabase";
import { remindInvoices } from "../src/services/sales";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string }>);
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: async (_env: Env, message: { to: string; subject: string; text: string }) => {
    sent.push(message);
    return { sent: true, id: `email-${sent.length}` };
  },
}));
const stripe = vi.hoisted(() => ({ key: null as string | null }));
vi.mock("../src/integrations/stripe", async (original) => ({
  ...(await original<typeof import("../src/integrations/stripe")>()),
  stripeAccess: async () => (stripe.key ? { key: stripe.key, own: true } : null),
}));
// The server's own client, which reads who a client's message goes to: their contacts, the
// company's switch and the numbers that texted STOP (services/recipients.ts); and the company and
// its settings, which the browser's role doesn't read (deliver in services/sales.ts).
const server = vi.hoisted(() => ({ tables: {} as Record<string, unknown> }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => stubDb(server.tables),
}));
vi.mock("../src/lib/links", async (original) => ({
  ...(await original<typeof import("../src/lib/links")>()),
  clientLink: async (_env: Env, baseUrl: string, link: { id: string }) => `${baseUrl}/u/${link.id}`,
  clientLinks: async (_env: Env, baseUrl: string, link: { id: string }) => ({ own: `${baseUrl}/u/${link.id}`, office: `${baseUrl}/u/${link.id}` }),
}));

const CO = "00000000-0000-4000-8000-0000000000a1";
const env = { SUPABASE_URL: "http://db.test", SUPABASE_SECRET_KEY: "test" } as Env;
const company = { name: "Ridge Paving", currency: "USD", timezone: "America/New_York", email: null, phone: null, address: {}, settings: {} };
const client = { display_name: "Pat Lee", email: "pat@example.com", phone: null };
const invoice = (id: string, number: number, due_on: string) => ({ id, number, status: "sent", total: 400, balance_due: 400, due_on, client_id: "client-1", client });

/** Answers each table with its rows, whatever the filters. */
function stubDb(tables: Record<string, unknown>): Db {
  const from = (table: string) => {
    const result = { data: tables[table] ?? null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "order", "limit"]) builder[name] = () => builder;
    builder.insert = (row: unknown) => {
      if (table === "messages") logged.push(row as { recipients: unknown });
      return builder;
    };
    builder.maybeSingle = builder.single = () => Promise.resolve(result);
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return builder;
  };
  return { from } as unknown as Db;
}

/** The messages kept on the client's timeline. */
const logged: Array<{ recipients: unknown }> = [];

afterEach(() => {
  sent.length = 0;
  logged.length = 0;
  server.tables = {};
  stripe.key = null;
  vi.useRealTimers();
});

describe("a payment reminder", () => {
  it("says the invoice is due until the due date has passed, then that it was due", async () => {
    // 10 PM on November 30 in New York, already December 1 in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T03:00:00Z"));
    const db = stubDb({
      companies: company,
      invoices: [invoice("inv-early", 4, "2026-12-15"), invoice("inv-today", 5, "2026-11-30"), invoice("inv-late", 6, "2026-11-29")],
      stripe_invoices: [],
    });
    server.tables = { companies: company };

    const result = await remindInvoices({ db, env, companyId: CO, baseUrl: "https://ops.example.com" }, ["inv-early", "inv-today", "inv-late"]);

    expect(result).toEqual({ sent: 3, skipped: [] });
    const [early, today, late] = sent.map((m) => m.text);
    expect(early).toContain("$400.00 is still owed on invoice #4, which is due December 15.");
    expect(today).toContain("on invoice #5, which is due November 30.");
    expect(late).toContain("on invoice #6, which was due November 29.");
  });

  it("says to pay online only when the business takes payments online", async () => {
    const db = stubDb({ companies: company, invoices: [invoice("inv-1", 7, "2026-12-15")], stripe_invoices: [] });
    const scope = { db, env, companyId: CO, baseUrl: "https://ops.example.com" };
    server.tables = { companies: company };

    await remindInvoices(scope, ["inv-1"]);
    stripe.key = "rk_live_own";
    await remindInvoices(scope, ["inv-1"]);

    const [noStripe, withStripe] = sent.map((m) => m.text);
    expect(noStripe).toContain("You can view it online:");
    expect(noStripe).not.toContain("pay it online");
    expect(withStripe).toContain("You can view and pay it online:");
  });

  it("goes to the client and their contacts ticked for emails, once the company has that on", async () => {
    const contacts = [
      { id: "c-1", name: "Mo Manager", email: "mo@example.com", phone: null, notify_email: true, notify_sms: true },
      { id: "c-2", name: "Sam Spouse", email: "sam@example.com", phone: null, notify_email: false, notify_sms: true },
      // The client's own address again, in other letters: one email, not two.
      { id: "c-3", name: "Pat at work", email: " PAT@Example.com", phone: null, notify_email: true, notify_sms: false },
    ];
    const tables = { invoices: [invoice("inv-1", 7, "2026-12-15")], stripe_invoices: [], clients: { id: "client-1", ...client, sms_opt_out_at: null } };
    const scope = { db: stubDb({ ...tables, companies: company }), env, companyId: CO, baseUrl: "https://ops.example.com" };

    server.tables = { companies: company, client_contacts: contacts };
    expect(await remindInvoices(scope, ["inv-1"])).toEqual({ sent: 1, skipped: [] });
    expect(sent.map((m) => m.to)).toEqual(["pat@example.com", "mo@example.com"]);
    // One message on the timeline, saying who got it.
    expect(logged).toHaveLength(1);
    expect(logged[0]!.recipients).toEqual([{ to: "pat@example.com", name: "Pat Lee" }, { to: "mo@example.com", name: "Mo Manager" }]);

    // A company that had contacts before the ticks did anything: nobody new until it says yes.
    sent.length = 0;
    server.tables = { ...server.tables, companies: { ...company, settings: { contact_messages: { enabled: false, pending: true } } } };
    await remindInvoices(scope, ["inv-1"]);
    expect(sent.map((m) => m.to)).toEqual(["pat@example.com"]);
  });
});
