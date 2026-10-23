/**
 * Signatures (routes/signing.ts, services/signing.ts): a person's saved signature, the homeowner
 * signing on the salesperson's iPad, signing for the business afterwards, and the signed copy.
 */
import { DEFAULT_TEMPLATE, templateSettings } from "@crewtavo/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client: tables of rows that eq, in, is (including a
// ->> json path) and match filter, with insert, upsert, update (returning rows after .select()) and
// delete. Email and texts are recorded instead of sent, and automations aren't run.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, user: "" }));
vi.mock("../src/lib/supabase", () => {
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: state.user } }, error: null }) },
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      let returning = false;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (change?.kind === "update") {
          const hit = rows();
          for (const row of hit) Object.assign(row, structuredClone(change.values));
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (change?.kind === "delete") {
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !filters.every((keep) => keep(row)));
          return { data: null, error: null };
        }
        return { data: rows(), error: null };
      };
      const add = (list: Row | Row[], options?: { onConflict?: string }) => {
        const keys = options?.onConflict?.split(",") ?? [];
        for (const row of [list].flat()) {
          const existing = keys.length ? (state.tables[table] ?? []).find((r) => keys.every((k) => r[k] === row[k])) : undefined;
          if (existing) Object.assign(existing, row);
          else state.tables[table] = [...(state.tables[table] ?? []), { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }];
        }
        return Promise.resolve({ data: null, error: null });
      };
      const value = (row: Row, column: string) => {
        const [col, key] = column.split("->>");
        const v = row[col!];
        return key ? (v && typeof v === "object" ? ((v as Row)[key] ?? null) : null) : v;
      };
      const builder: Record<string, unknown> = {
        select: () => ((returning = true), builder),
        order: () => builder,
        limit: () => builder,
        eq: (column: string, v: unknown) => (filters.push((row) => value(row, column) === v), builder),
        is: (column: string, v: unknown) => (filters.push((row) => (value(row, column) ?? null) === v), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(value(row, column))), builder),
        match: (values: Row) => (filters.push((row) => Object.entries(values).every(([k, v]) => row[k] === v)), builder),
        insert: (list: Row | Row[]) => add(list),
        upsert: add,
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        delete: () => ((change = { kind: "delete" }), builder),
        maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const db = client();
  return { userClient: () => db, adminClient: () => db, publishableKey: () => "key" };
});
vi.mock("../src/lib/notify", async (original) => ({
  ...(await original<typeof import("../src/lib/notify")>()),
  sendEmail: vi.fn(async () => ({ sent: true, id: "email-1" })),
  sendSms: vi.fn(async () => ({ sent: true, id: "sms-1" })),
}));
vi.mock("../src/lib/background", async (original) => ({ ...(await original<typeof import("../src/lib/background")>()), kickAutomations: vi.fn() }));

const { app } = await import("../src/app");
const notify = await import("../src/lib/notify");
const background = await import("../src/lib/background");
const sendEmail = vi.mocked(notify.sendEmail);
const sendSms = vi.mocked(notify.sendSms);

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;

const ROOFER = "00000000-0000-4000-8000-00000000d0c1";
const OTHER = "00000000-0000-4000-8000-00000000d0c2";
const QUOTE = "00000000-0000-4000-8000-00000000d0c3";
const MIKE = "00000000-0000-4000-8000-00000000d0c4";
const CLIENT = "00000000-0000-4000-8000-00000000d0c5";
const HOMEOWNER = `data:image/png;base64,${"A".repeat(400)}=`;
const MIKES = `data:image/png;base64,${"B".repeat(400)}=`;
const SAVED = `data:image/png;base64,${"C".repeat(400)}=`;

const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": ROOFER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const quote = () => state.tables.quotes!.find((q) => q.id === QUOTE)!;

function roofer({ status = "sent", role = "estimator", approval = null as Row | null, templates = [] as Row[], saved = null as string | null, email = "alex@example.com" as string | null } = {}) {
  state.user = MIKE;
  state.tables = {
    memberships: [{ company_id: ROOFER, user_id: MIKE, active: true, role, role_id: null }],
    companies: [{ id: ROOFER, name: "Ridgeline Roofing", email: "office@ridgeline.example", phone: "(614) 555-0188", address: { line1: "2290 Harper Rd", city: "Columbus", region: "OH" }, settings: {} }],
    profiles: [{ user_id: MIKE, full_name: "Mike Torres" }],
    document_templates: templates,
    user_signatures: [
      ...(saved ? [{ company_id: ROOFER, user_id: MIKE, image: saved }] : []),
      // Mike's signature at another business he works for never crosses over.
      { company_id: OTHER, user_id: MIKE, image: SAVED },
    ],
    quotes: [
      {
        id: QUOTE, company_id: ROOFER, number: 1042, status, title: "New roof", client_id: CLIENT, template_id: null, salesperson_id: null,
        subtotal: 18304, discount_amount: 0, tax_amount: 0, total: 18304, approval, approved_at: approval ? "2026-10-20T15:00:00.000Z" : null,
        client: { display_name: "Alex Morgan", email, phone: "(614) 555-0142" },
        lines: [{ id: "line-1", optional: false, selected: true }, { id: "line-2", optional: true, selected: true }, { id: "line-3", optional: true, selected: false }],
      },
    ],
    messages: [],
  };
}

beforeEach(() => {
  sendEmail.mockClear();
  sendSms.mockClear();
  vi.mocked(background.kickAutomations).mockClear();
});
afterEach(() => {
  state.tables = {};
});

describe("my saved signature", () => {
  it("saves, reads and removes the signed-in person's own signature in this business", async () => {
    roofer();
    expect(await (await call("/me/signature")).json()).toEqual({ image: null });

    const saved = await call("/me/signature", { image: MIKES }, "PUT");
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ image: MIKES });
    expect(await (await call("/me/signature")).json()).toEqual({ image: MIKES });

    // Signing again replaces it rather than adding another.
    await call("/me/signature", { image: SAVED }, "PUT");
    expect(state.tables.user_signatures!.filter((r) => r.company_id === ROOFER)).toEqual([expect.objectContaining({ user_id: MIKE, image: SAVED })]);

    expect(await (await call("/me/signature", undefined, "DELETE")).json()).toEqual({ ok: true });
    expect(await (await call("/me/signature")).json()).toEqual({ image: null });
    // The other business's copy is untouched.
    expect(state.tables.user_signatures).toEqual([expect.objectContaining({ company_id: OTHER })]);
  });

  it("only takes a drawn signature", async () => {
    roofer();
    for (const image of ["data:image/jpeg;base64,AAAA", "<svg></svg>", `data:image/png;base64,${"A".repeat(300_001)}`]) {
      const res = await call("/me/signature", { image }, "PUT");
      expect(res.status, image.slice(0, 20)).toBe(400);
    }
    expect(state.tables.user_signatures!.filter((r) => r.company_id === ROOFER)).toEqual([]);
  });
});

describe("signing on site", () => {
  it("approves the estimate with both signatures and emails the homeowner a copy", async () => {
    roofer();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, save_signature: true, email_copy: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "approved", emailed: true, link: expect.stringMatching(/^https:\/\/ops\.example\.com\/hub\/.+/) });

    const q = quote();
    expect(q.status).toBe("approved");
    expect(q.approved_at).toEqual(expect.any(String));
    expect(q.salesperson_id).toBe(MIKE);
    expect(q.approval).toEqual({
      name: "Alex Morgan",
      signature: HOMEOWNER,
      signed_at: q.approved_at,
      method: "in_person",
      selected_line_ids: ["line-2"],
      company: { name: "Mike Torres", user_id: MIKE, signature: MIKES, signed_at: q.approved_at },
      // No template saved yet: the built-in one, kept as it was signed.
      template: DEFAULT_TEMPLATE,
      subtotal: 18304,
      discount_amount: 0,
      tax_amount: 0,
      total: 18304,
    });
    // It's never the IP: that's only for online approvals.
    expect(q.approval).not.toHaveProperty("ip");

    // "Save my signature" keeps the one Mike drew for next time.
    expect(state.tables.user_signatures).toContainEqual(expect.objectContaining({ company_id: ROOFER, user_id: MIKE, image: MIKES }));

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, message, companyId] = sendEmail.mock.calls[0]!;
    expect(companyId).toBe(ROOFER);
    expect(message).toMatchObject({ to: "alex@example.com", subject: "Your signed estimate from Ridgeline Roofing", replyTo: "office@ridgeline.example", fromName: "Ridgeline Roofing" });
    expect(message.text).toContain("Hi Alex,");
    expect(message.text).toContain("Here's your signed estimate from Ridgeline Roofing. You can view, print or save it any time:");
    expect(message.text).toContain(body.link);
    expect(state.tables.messages).toEqual([expect.objectContaining({ client_id: CLIENT, channel: "email", related_type: "quote", related_id: QUOTE, external_id: "email-1" })]);
    expect(background.kickAutomations).toHaveBeenCalledTimes(1);
  });

  it("uses the salesperson's saved signature for the business", async () => {
    roofer({ saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "approved", emailed: false, link: expect.any(String) });
    expect((quote().approval as Row).company).toEqual(expect.objectContaining({ name: "Mike Torres", signature: SAVED }));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("asks for the business's signature when the template has a line for it", async () => {
    roofer();
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Sign for Ridgeline Roofing too.");
    expect(quote().status).toBe("sent");
    expect(quote().approval).toBeNull();
  });

  it("signs without it when the quote's template has no line for the business", async () => {
    roofer({
      templates: [
        { id: "t-standard", company_id: ROOFER, is_default: true, settings: {} },
        { id: "t-simple", company_id: ROOFER, is_default: false, settings: { company_signs: false } },
      ],
    });
    quote().template_id = "t-simple";
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER });
    expect(res.status).toBe(200);
    expect((quote().approval as Row).company).toBeNull();
    // The quote's own template is kept with the signatures, so editing it later doesn't change the signed copy.
    expect((quote().approval as Row).template).toEqual(templateSettings({ company_signs: false }));
  });

  it("won't sign an estimate twice, or one that isn't open", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    let res = await call(`/quotes/${QUOTE}/sign`, { name: "Someone Else", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate was already signed.");
    expect((quote().approval as Row).name).toBe("Alex Morgan");

    roofer({ status: "lost" });
    res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate is marked lost, so it can't be signed. Reopen it as a draft first.");
  });

  it("keeps it signed when the copy can't be emailed, and says why", async () => {
    roofer({ email: null });
    let res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, email_copy: true });
    expect(await res.json()).toEqual({ status: "approved", emailed: false, email_reason: "Add an email address for Alex Morgan first.", link: expect.any(String) });
    expect(quote().status).toBe("approved");

    roofer();
    sendEmail.mockResolvedValueOnce({ sent: false, reason: "Email isn't set up yet." });
    res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES, email_copy: true });
    expect(await res.json()).toMatchObject({ status: "approved", emailed: false, email_reason: "Email isn't set up yet." });
    expect(state.tables.messages).toEqual([]);
  });

  it("is for people who sell", async () => {
    roofer({ role: "field_crew" });
    const res = await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", signature: HOMEOWNER, company_signature: MIKES });
    expect(res.status).toBe(403);
    expect(quote().status).toBe("sent");
  });

  it("needs the customer's name and signature", async () => {
    roofer();
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "A", signature: HOMEOWNER, company_signature: MIKES })).status).toBe(400);
    expect((await call(`/quotes/${QUOTE}/sign`, { name: "Alex Morgan", company_signature: MIKES })).status).toBe(400);
    expect(quote().status).toBe("sent");
  });
});

describe("signing for the business afterwards", () => {
  const online = { name: "Alex Morgan", signature: HOMEOWNER, signed_at: "2026-10-20T15:00:00.000Z", ip: "203.0.113.9", selected_line_ids: [], total: 18304 };

  it("adds the saved signature to an estimate the client signed online", async () => {
    roofer({ status: "approved", approval: { ...online }, saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(quote().approval).toEqual({ ...online, company: { name: "Mike Torres", user_id: MIKE, signature: SAVED, signed_at: expect.any(String) } });

    // Only once.
    const again = await call(`/quotes/${QUOTE}/countersign`, { signature: MIKES });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This estimate was already signed for Ridgeline Roofing.");
    expect(((quote().approval as Row).company as Row).signature).toBe(SAVED);
  });

  it("takes a signature drawn now, and can save it", async () => {
    roofer({ status: "converted", approval: { ...online, company: null } });
    const res = await call(`/quotes/${QUOTE}/countersign`, { signature: MIKES, save_signature: true });
    expect(res.status).toBe(200);
    expect(((quote().approval as Row).company as Row).signature).toBe(MIKES);
    expect(state.tables.user_signatures).toContainEqual(expect.objectContaining({ company_id: ROOFER, user_id: MIKE, image: MIKES }));
  });

  it("asks for a signature when there's no saved one", async () => {
    roofer({ status: "approved", approval: { ...online } });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Draw your signature first.");
    expect((quote().approval as Row).company).toBeUndefined();
  });

  it("is only for signed estimates", async () => {
    roofer({ status: "sent", saved: SAVED });
    const res = await call(`/quotes/${QUOTE}/countersign`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This estimate isn't signed yet.");
  });
});

describe("the signed copy", () => {
  it("texts the client a link to the signed estimate", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "sms" });
    const body = await res.json();
    expect(body).toEqual({ sent: true, link: expect.stringContaining("/hub/") });
    expect(sendSms).toHaveBeenCalledWith(env, { to: "(614) 555-0142", body: `Ridgeline Roofing: Here's your signed estimate. You can view, print or save it any time: ${body.link}` });
    expect(state.tables.messages).toEqual([expect.objectContaining({ channel: "sms", subject: "Signed estimate #1042", related_type: "quote", related_id: QUOTE })]);
  });

  it("emails it to another address when asked", async () => {
    roofer({ status: "converted", approval: { name: "Alex Morgan", signature: HOMEOWNER } });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email", to: "alex.work@example.com" });
    expect(await res.json()).toMatchObject({ sent: true });
    expect(sendEmail.mock.calls[0]![1].to).toBe("alex.work@example.com");
  });

  it("says why it wasn't sent instead of failing", async () => {
    roofer({ status: "approved", approval: { name: "Alex Morgan" }, email: null });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "Add an email address for Alex Morgan first.", link: expect.any(String) });
    expect(await (await call(`/quotes/${QUOTE}/send-copy`, { channel: "email", to: "not an email" })).json()).toMatchObject({ sent: false, reason: "That email address doesn't look right." });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("is only for signed estimates", async () => {
    roofer({ status: "sent" });
    const res = await call(`/quotes/${QUOTE}/send-copy`, { channel: "email" });
    expect(res.status).toBe(409);
  });
});
