/**
 * How each email and text went is told to the database (lib/notify.ts noteSending), which warns the
 * company's owners and admins when sending stops and clears it when it works again
 * (public.note_sending, tested in supabase/tests/sending_warnings_test.sql). Here: what is told, and
 * when. fetch is stubbed: Resend and Twilio answer what each test gives them, and the database's
 * function keeps what it was called with.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { forgetMailbox, sendEmail, sendingWorks, sendSms } from "../src/lib/notify";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_server",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};

type Row = Record<string, any>;
interface World {
  resend: () => Response;
  twilio: () => Response;
  /** The company's own mailbox, when it has one. */
  integrations: Row[];
  integration_secrets: Row[];
  /** public.note_sending is failing (the database is away). */
  deaf?: boolean;
}
const went = { resend: () => Response.json({ id: "email-1" }), twilio: () => Response.json({ sid: "SM1" }) };
const world = (extra: Partial<World> = {}): World => ({ ...went, integrations: [], integration_secrets: [], ...extra });

function serve(w: World) {
  const noted: Row[] = [];
  const updates: Row[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "api.resend.com") return w.resend();
    if (url.host === "api.twilio.com") return w.twilio();
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    if (path === "rpc/note_sending") {
      noted.push(body);
      return w.deaf ? Response.json({ message: "connection refused" }, { status: 500 }) : Response.json(null);
    }
    const rows = ((w as unknown as Record<string, Row[]>)[path] ?? []).filter((r) => r.company_id === url.searchParams.get("company_id")?.replace("eq.", ""));
    if ((init?.method ?? "GET") === "PATCH") {
      updates.push(body);
      for (const r of rows) Object.assign(r, body);
    }
    return new Headers(init?.headers).get("accept")?.includes("vnd.pgrst.object") ? (rows[0] ? Response.json(rows[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 })) : Response.json(rows);
  });
  return { noted, updates };
}

/** A company nothing is remembered about yet (what's known of each is kept for ten minutes). */
const company = () => crypto.randomUUID();
const message = { to: "ann@client.test", subject: "Your quote", text: "Here it is." };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an email that doesn't go", () => {
  it("is counted for the company, with the words its owners would be warned in", async () => {
    const { noted } = serve(world({ resend: () => Response.json({ message: "Internal server error" }, { status: 500 }) }));
    const co = company();
    expect(await sendEmail(env, message, co)).toMatchObject({ sent: false });
    expect(noted).toEqual([{
      p_company: co, p_channel: "email", p_ok: false, p_refused: false,
      p_error: "Resend is having trouble right now. Try again in a few minutes.",
      p_title: "Emails aren't going out",
      p_body: "The last few emails didn't go. Resend is having trouble right now. Try again in a few minutes. Quotes, invoices and reminders won't reach anyone by email until it's fixed, in Settings → Email.",
    }]);
  });

  it("is a refused sign-in when the key or password was turned down, on the company's own mailbox too", async () => {
    const co = company();
    const w = world({
      resend: () => Response.json({ message: "API key is invalid" }, { status: 401 }),
      integrations: [{ company_id: co, provider: "email", status: "connected", settings: { preset: "resend", kind: "resend", from_email: "office@oscar.test" } }],
      integration_secrets: [{ company_id: co, provider: "email", ciphertext: await encryptJson(env, { api_key: "re_revoked" }) }],
    });
    const { noted, updates } = serve(w);
    await sendEmail(env, message, co);
    // Settings → Email shows it, as before, and now the owners are told too.
    expect(updates).toEqual([expect.objectContaining({ status: "error" })]);
    expect(noted).toEqual([expect.objectContaining({ p_company: co, p_ok: false, p_refused: true })]);
    expect(noted[0]!.p_body).toBe(
      "Resend didn't accept this API key. It may have been deleted, or only part of it was copied. Create a new one under API keys in Resend and paste the whole key (it starts with re_). Quotes, invoices and reminders won't reach anyone by email until it's fixed, in Settings → Email.",
    );
    forgetMailbox(co);
  });

  it("isn't counted when it's about the address it was for, or when no company is given", async () => {
    const { noted } = serve(world({ resend: () => Response.json({ message: "Invalid `to` field." }, { status: 422 }) }));
    expect(await sendEmail(env, message, company())).toMatchObject({ sent: false, reason: "That email address isn't valid, so Resend didn't send it." });
    expect(await sendEmail(env, { ...message, to: "sub-1@subs.invalid" }, company())).toMatchObject({ sent: false });
    expect(await sendEmail(env, message)).toMatchObject({ sent: false });
    expect(noted).toEqual([]);
  });

  it("still says how the send went when the database can't take the note", async () => {
    const { noted } = serve(world({ deaf: true, resend: () => Response.json({ message: "Internal server error" }, { status: 500 }) }));
    expect(await sendEmail(env, message, company())).toMatchObject({ sent: false, status: 500 });
    expect(noted).toHaveLength(1);
  });
});

describe("an email that goes", () => {
  it("is told to the database once, then taken as still working for ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { noted } = serve(world());
    const co = company();
    await sendEmail(env, message, co);
    await sendEmail(env, message, co);
    expect(noted).toEqual([{ p_company: co, p_channel: "email", p_ok: true }]);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await sendEmail(env, message, co);
    expect(noted).toHaveLength(2);
  });

  it("clears a warning right after a failure, however recently it last worked", async () => {
    const w = world();
    const { noted } = serve(w);
    const co = company();
    await sendEmail(env, message, co);
    w.resend = () => Response.json({ message: "Internal server error" }, { status: 500 });
    await sendEmail(env, message, co);
    w.resend = went.resend;
    await sendEmail(env, message, co);
    expect(noted.map((n) => n.p_ok)).toEqual([true, false, true]);
  });

  it("is told at once when the mailbox was just connected again", async () => {
    const { noted } = serve(world());
    const co = company();
    await sendEmail(env, message, co);
    await sendingWorks(env, co, "email");
    expect(noted).toEqual([{ p_company: co, p_channel: "email", p_ok: true }, { p_company: co, p_channel: "email", p_ok: true }]);
  });
});

describe("a text", () => {
  it("that the provider refuses to sign in for is counted as refused, in words about Twilio", async () => {
    const { noted } = serve(world({ twilio: () => Response.json({ code: 20003, message: "Authenticate" }, { status: 401 }) }));
    const co = company();
    expect(await sendSms(env, { to: "+15405550101", body: "Reminder" }, co)).toMatchObject({ sent: false, status: 401 });
    expect(noted).toEqual([{
      p_company: co, p_channel: "sms", p_ok: false, p_refused: true,
      p_error: "The text provider refused it (401: Authenticate).",
      p_title: "Texts aren't going out",
      p_body: "The text provider refused it (401: Authenticate). Reminders and other texts won't reach anyone until it's fixed. Check the Twilio account, and the Twilio keys this Crewtavo was set up with.",
    }]);
  });

  it("to a number that can't be texted isn't counted, and neither is one sent for no company", async () => {
    const w = world({ twilio: () => Response.json({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, { status: 400 }) });
    const { noted } = serve(w);
    await sendSms(env, { to: "+15405550101", body: "Reminder" }, company());
    w.twilio = () => Response.json({ message: "Internal server error" }, { status: 500 });
    await sendSms(env, { to: "+15405550101", body: "Your sign-in code" });
    expect(noted).toEqual([]);
  });

  it("that goes clears a warning, and one that fails for the provider's own reasons is counted", async () => {
    const w = world();
    const { noted } = serve(w);
    const co = company();
    await sendSms(env, { to: "+15405550101", body: "Reminder" }, co);
    w.twilio = () => Response.json({ message: "Internal server error" }, { status: 500 });
    await sendSms(env, { to: "+15405550101", body: "Reminder" }, co);
    expect(noted.map((n) => [n.p_channel, n.p_ok, n.p_refused])).toEqual([["sms", true, undefined], ["sms", false, false]]);
    expect(noted[1]!.p_body).toMatch(/^The last few texts didn't go\. The text provider refused it \(500: Internal server error\)\./);
  });
});
