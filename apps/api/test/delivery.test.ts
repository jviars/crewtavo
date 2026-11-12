/**
 * The notify task (services/delivery.ts): a notification is delivered once it has gone out, one that
 * didn't go is tried again by the channels still missing, and one that can't go is failed with the
 * reason. Against a small stand-in for PostgREST: fetch is stubbed, tables live in memory, and the
 * delivery queue's functions do here what 20261112000540_notifications_sent_then_marked.sql does in
 * the database (claims, waits and limits themselves are tested in
 * supabase/tests/notification_delivery_test.sql). Resend and Twilio answer what each test gives
 * them, and pushes go to a stand-in for the phone's push service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

vi.mock("../src/lib/webpush", async (original) => ({
  ...(await original<typeof import("../src/lib/webpush")>()),
  sendPush: vi.fn(async () => ({ ok: true, gone: false, status: 201 })),
}));
vi.mock("../src/lib/monitoring", async (original) => ({
  ...(await original<typeof import("../src/lib/monitoring")>()),
  reportError: vi.fn(),
}));

const webpush = await import("../src/lib/webpush");
const { deliverNotifications } = await import("../src/services/delivery");
const sendPush = vi.mocked(webpush.sendPush);

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Crewtavo <noreply@example.com>",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "twilio-token",
  TWILIO_FROM_NUMBER: "+15405550000",
};

const CO = "00000000-0000-4000-8000-0000000000a1";
const CAL = "00000000-0000-4000-8000-000000000001";
const DEE = "00000000-0000-4000-8000-000000000002";

type Row = Record<string, any>;
interface World {
  tables: Record<string, Row[]>;
  /** What Resend and Twilio answer; by default the email or text goes. */
  resend: () => Response;
  twilio: () => Response;
  /** A table whose read fails, as when the database is too busy to answer. */
  broken?: string;
  /** The database refuses to record how a batch went (the server is going down). */
  unsettled?: boolean;
}

const OK = { resend: () => Response.json({ id: "email-1" }), twilio: () => Response.json({ sid: "SM1" }) };
const down = () => Response.json({ message: "Internal server error" }, { status: 500 });

let seq = 0;
const notice = (extra: Row = {}): Row => ({
  id: `n${++seq}`, company_id: CO, user_id: CAL, kind: "schedule", title: "You're on Smith mowing: Thu Nov 12, 7:00 AM", body: null, link: "/field/visits/v1", read_at: null,
  delivered_at: null, delivery: {}, delivery_token: null, locked: false, delivery_attempts: 0, deliver_after: null, delivery_failed_at: null, delivery_error: null, ...extra,
});
/** Cal hears about his schedule by email, text and push, on one phone. */
const world = (notifications: Row[], extra: Partial<World> = {}): World => ({
  tables: {
    notifications,
    notification_prefs: [{ company_id: CO, user_id: CAL, email: ["schedule"], sms: ["schedule"], push: ["schedule"] }],
    profiles: [{ user_id: CAL, email: "cal@november.test", phone: "+15405550101", full_name: "Cal Crew" }, { user_id: DEE, email: "dee@november.test", phone: null, full_name: "Dee Crew" }],
    companies: [{ id: CO, name: "November Lawn", email: "office@november.test" }],
    push_subscriptions: [{ id: "phone-1", user_id: CAL, endpoint: "https://push.example/1", p256dh: "k", auth: "a" }],
    integrations: [],
    integration_secrets: [],
  },
  ...OK,
  ...extra,
});

/** The delivery queue's functions, as the migration defines them, over the notifications in memory. */
function queue(w: World): Record<string, (body: any) => unknown> {
  const all = () => w.tables.notifications!;
  const open = (n: Row) => !n.delivered_at && !n.delivery_failed_at;
  return {
    claim_notification_deliveries: () => {
      const token = `claim-${++seq}`;
      const rows = all().filter((n) => open(n) && !n.locked && !n.deliver_after);
      for (const n of rows) Object.assign(n, { delivery_token: token, locked: true });
      return rows.map((n) => ({ ...n }));
    },
    start_notification_deliveries: (body) => {
      const rows = all().filter((n) => body.p_ids.includes(n.id) && n.delivery_token === body.p_token && open(n));
      for (const n of rows) n.delivery_attempts++;
      return rows.map((n) => ({ id: n.id, delivery: { ...n.delivery } }));
    },
    note_notification_channel: (body) => {
      const rows = all().filter((n) => body.p_ids.includes(n.id) && open(n));
      for (const n of rows) n.delivery = { ...n.delivery, [body.p_channel]: body.p_outcome };
      return rows.length;
    },
    settle_notification_deliveries: (body) => {
      if (w.unsettled) return Response.json({ message: "the database is shutting down" }, { status: 503 });
      const held = (ids: string[]) => all().filter((n) => ids.includes(n.id) && n.delivery_token === body.p_token && open(n));
      const free = { delivery_token: null, locked: false };
      for (const n of held(body.p_delivered)) Object.assign(n, free, { delivered_at: "now", delivery_error: null });
      for (const n of held(body.p_failed)) Object.assign(n, free, { delivery_failed_at: "now", delivery_error: body.p_error ?? n.delivery_error });
      for (const n of held(body.p_retry)) Object.assign(n, free, n.delivery_attempts >= 8 ? { delivery_failed_at: "now" } : { deliver_after: "later" }, { delivery_error: body.p_error });
      return 0;
    },
    sub_notice_contacts: () => [],
  };
}

function serve(w: World) {
  const calls: Array<{ method: string; host: string; path: string; body: any }> = [];
  const rpc = queue(w);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const text = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // form bodies (Twilio) stay text
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/rest\/v1\//, "");
    calls.push({ method, host: url.host, path, body });
    if (url.host === "api.resend.com") return w.resend();
    if (url.host === "api.twilio.com") return w.twilio();
    if (path.startsWith("rpc/")) {
      const answer = rpc[path.slice(4)]?.(body);
      return answer instanceof Response ? answer : Response.json(answer ?? null);
    }
    if (path === w.broken) return Response.json({ code: "57014", message: "canceling statement due to statement timeout" }, { status: 500 });
    const rows = (w.tables[path] ??= []);
    const picked = rows.filter((r) => [...url.searchParams].every(([key, value]) => {
      const [op, ...rest] = value.split(".");
      const arg = rest.join(".");
      if (op === "eq") return String(r[key]) === arg;
      if (op === "in") return arg.slice(1, -1).split(",").includes(String(r[key]));
      return true;
    }));
    if (method === "DELETE") w.tables[path] = rows.filter((r) => !picked.includes(r));
    if (method === "PATCH") for (const r of picked) Object.assign(r, body);
    return (init?.headers && new Headers(init.headers).get("accept")?.includes("vnd.pgrst.object")) ? (picked[0] ? Response.json(picked[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 })) : Response.json(picked);
  });
  const to = (host: string) => calls.filter((c) => c.host === host);
  return {
    calls,
    emails: () => to("api.resend.com").map((c) => c.body as { to: string[]; subject: string; text: string }),
    texts: () => to("api.twilio.com").map((c) => Object.fromEntries(new URLSearchParams(c.body as string))),
    rpcs: (name: string) => calls.filter((c) => c.path === `rpc/${name}`).map((c) => c.body),
  };
}

/** Its wait is over, or its claim has run out: the next run may claim it. */
const comeBack = (w: World) => {
  for (const n of w.tables.notifications!) Object.assign(n, { deliver_after: null, locked: false });
};

beforeEach(() => {
  sendPush.mockReset();
  sendPush.mockResolvedValue({ ok: true, gone: false, status: 201 });
});
afterEach(() => vi.unstubAllGlobals());

describe("delivering a notification", () => {
  it("marks it delivered once it has gone by every channel the person chose", async () => {
    const w = world([notice()]);
    const sent = serve(w);
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 1, sms: 1, push: 1, failed: 0 });
    expect(sent.rpcs("claim_notification_deliveries")).toEqual([{ p_min_age_seconds: 45, p_limit: 200 }]);
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery: { email: "sent", sms: "sent", push: "sent" }, delivery_failed_at: null });
    // Nothing is left to claim, so nothing goes twice.
    expect(await deliverNotifications(env)).toMatchObject({ claimed: 0 });
    expect([sent.emails().length, sent.texts().length, sendPush.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("isn't delivered while its email hasn't gone, and the next try sends only the email", async () => {
    const w = world([notice()], { resend: down });
    const sent = serve(w);
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 0, sms: 1, push: 1, failed: 1 });
    expect(w.tables.notifications![0]).toMatchObject({
      delivered_at: null, delivery_failed_at: null, deliver_after: "later", delivery: { sms: "sent", push: "sent" },
      delivery_error: "Email: Resend is having trouble right now. Try again in a few minutes.",
    });

    // Resend is back when its wait is over.
    w.resend = OK.resend;
    comeBack(w);
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 1, sms: 0, push: 0, failed: 0 });
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery: { email: "sent", sms: "sent", push: "sent" }, delivery_error: null });
    expect(sent.emails()).toHaveLength(2);
    expect(sent.texts()).toHaveLength(1);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("doesn't send again what went before the server stopped partway", async () => {
    // Everything went, and then how it went couldn't be recorded: the claim is left to run out.
    const w = world([notice()], { unsettled: true });
    const sent = serve(w);
    await deliverNotifications(env);
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: null, locked: true, delivery: { email: "sent", sms: "sent", push: "sent" } });

    w.unsettled = false;
    comeBack(w);
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 0, sms: 0, push: 0, failed: 0 });
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery_attempts: 2 });
    expect([sent.emails().length, sent.texts().length, sendPush.mock.calls.length]).toEqual([1, 1, 1]);
  });

  it("is failed with the reason, not tried again, when the address can't be sent to", async () => {
    const w = world([notice()], { resend: () => Response.json({ message: "Invalid `to` field. Please use our testing email address instead of domains like `example.com`." }, { status: 422 }) });
    serve(w);
    expect(await deliverNotifications(env)).toMatchObject({ email: 0, sms: 1, push: 1, failed: 1 });
    expect(w.tables.notifications![0]).toMatchObject({
      delivered_at: null, deliver_after: null, delivery_failed_at: "now", delivery: { email: "failed", sms: "sent", push: "sent" },
      delivery_error: "Email: That email address isn't valid, so Resend didn't send it.",
    });
  });

  it("keeps a bad address failed when its push needed another try first", async () => {
    const w = world([notice()], { resend: () => Response.json({ message: "Invalid `to` field." }, { status: 422 }) });
    sendPush.mockResolvedValue({ ok: false, gone: false, status: 503 });
    const sent = serve(w);
    await deliverNotifications(env);
    expect(w.tables.notifications![0]).toMatchObject({ delivery_failed_at: null, deliver_after: "later", delivery: { email: "failed", sms: "sent" } });
    expect(w.tables.notifications![0]!.delivery_error).toBe("Email: That email address isn't valid, so Resend didn't send it. Push: Their phone's push service turned it down (503).");

    sendPush.mockResolvedValue({ ok: true, gone: false, status: 201 });
    comeBack(w);
    expect(await deliverNotifications(env)).toMatchObject({ email: 0, sms: 0, push: 1 });
    // The push went this time, and the email never will.
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: null, delivery_failed_at: "now", delivery: { email: "failed", sms: "sent", push: "sent" } });
    expect(sent.emails()).toHaveLength(1);
  });

  it("gives up after 8 tries", async () => {
    const w = world([notice({ delivery_attempts: 7, delivery: { sms: "sent", push: "sent" } })], { resend: down });
    serve(w);
    await deliverNotifications(env);
    expect(w.tables.notifications![0]).toMatchObject({ delivery_attempts: 8, delivered_at: null, delivery_failed_at: "now", delivery_error: "Email: Resend is having trouble right now. Try again in a few minutes." });
  });

  it("asks a mail or text provider that just failed only once in a run, and everyone it was for waits", async () => {
    const w = world([notice(), notice({ user_id: DEE })], { resend: down, twilio: down });
    w.tables.notification_prefs!.push({ company_id: CO, user_id: DEE, email: ["schedule"], sms: ["schedule"], push: [] });
    w.tables.profiles![1]!.phone = "+15405550102";
    const sent = serve(w);
    expect(await deliverNotifications(env)).toMatchObject({ email: 0, sms: 0, failed: 2 });
    expect(sent.emails()).toHaveLength(1);
    expect(sent.texts()).toHaveLength(1);
    expect(w.tables.notifications!.map((n) => [n.deliver_after, n.delivered_at])).toEqual([["later", null], ["later", null]]);
    expect(w.tables.notifications![1]!.delivery_error).toBe("Email: Resend is having trouble right now. Try again in a few minutes. Text: The text provider refused it (500: Internal server error).");
  });

  it("fails a text to a number that can't be texted, without holding up anyone else's", async () => {
    const w = world([notice()], { twilio: () => Response.json({ code: 21610, message: "Attempt to send to unsubscribed recipient" }, { status: 400 }) });
    serve(w);
    await deliverNotifications(env);
    expect(w.tables.notifications![0]).toMatchObject({ delivery_failed_at: "now", delivery: { email: "sent", sms: "failed", push: "sent" } });
  });

  it("leaves alone what another server has claimed since", async () => {
    const w = world([notice()]);
    const sent = serve(w);
    // This run's claim ran out while it was busy with others, and another server took it.
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await inner(input, init);
      if (String(input instanceof Request ? input.url : input).endsWith("/rpc/claim_notification_deliveries")) for (const n of w.tables.notifications!) n.delivery_token = "another-server";
      return response;
    });
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 0, sms: 0, push: 0, failed: 0 });
    expect([sent.emails().length, sent.texts().length, sendPush.mock.calls.length]).toEqual([0, 0, 0]);
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: null, delivery_token: "another-server", delivery_attempts: 0 });
  });

  it("is delivered without sending when it was read in the app first", async () => {
    const w = world([notice({ read_at: "2026-11-12T12:00:00Z" })]);
    const sent = serve(w);
    expect(await deliverNotifications(env)).toEqual({ claimed: 1, email: 0, sms: 0, push: 0, failed: 0 });
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery: {} });
    expect(sent.emails()).toEqual([]);
  });

  it("sends nothing and settles nothing when it can't read who to notify", async () => {
    const w = world([notice()], { broken: "profiles" });
    const sent = serve(w);
    await expect(deliverNotifications(env)).rejects.toThrow(/Couldn't read who to notify/);
    expect([sent.emails().length, sent.texts().length, sendPush.mock.calls.length]).toEqual([0, 0, 0]);
    // Still claimed, not started: it's claimed again when the five minutes run out, with all 8 tries left.
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: null, delivery_failed_at: null, locked: true, delivery_attempts: 0 });
  });
});

describe("a push", () => {
  const pushOnly = (notifications: Row[]) => {
    const w = world(notifications);
    w.tables.notification_prefs = [{ company_id: CO, user_id: CAL, email: [], sms: [], push: ["schedule"] }];
    w.tables.push_subscriptions!.push({ id: "tablet-1", user_id: CAL, endpoint: "https://push.example/2", p256dh: "k", auth: "a" });
    return w;
  };

  it("has gone once one of their devices took it", async () => {
    const w = pushOnly([notice()]);
    sendPush.mockResolvedValueOnce({ ok: false, gone: false, status: 503 }).mockResolvedValueOnce({ ok: true, gone: false, status: 201 });
    serve(w);
    expect(await deliverNotifications(env)).toMatchObject({ push: 1, failed: 1 });
    expect(w.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery: { push: "sent" } });
  });

  it("is tried again when no push service took it, each notification on its own", async () => {
    const w = pushOnly([notice({ title: "First" }), notice({ title: "Second" })]);
    // The first goes to the phone; the second reaches neither device.
    sendPush.mockImplementation(async (_env, _device, message) => (message.title === "First" ? { ok: true, gone: false, status: 201 } : { ok: false, gone: false, status: 0 }));
    serve(w);
    await deliverNotifications(env);
    expect(w.tables.notifications!.map((n) => [n.title, n.delivered_at, n.deliver_after, n.delivery_error])).toEqual([
      ["First", "now", null, null],
      ["Second", null, "later", "Push: Their phone's push service didn't answer."],
    ]);

    sendPush.mockClear();
    sendPush.mockResolvedValue({ ok: true, gone: false, status: 201 });
    comeBack(w);
    await deliverNotifications(env);
    expect(sendPush.mock.calls.map((c) => c[2].title)).toEqual(["Second", "Second"]);
    expect(w.tables.notifications![1]).toMatchObject({ delivered_at: "now" });
  });

  it("is failed when every device turns it away for good, and delivered when the only device is gone", async () => {
    const refused = pushOnly([notice()]);
    sendPush.mockResolvedValue({ ok: false, gone: false, status: 403 });
    serve(refused);
    await deliverNotifications(env);
    expect(refused.tables.notifications![0]).toMatchObject({ delivery_failed_at: "now", delivery: { push: "failed" }, delivery_error: "Push: Their phone's push service turned it down (403)." });

    const gone = pushOnly([notice()]);
    sendPush.mockResolvedValue({ ok: false, gone: true, status: 410 });
    serve(gone);
    await deliverNotifications(env);
    expect(gone.tables.push_subscriptions).toEqual([]);
    expect(gone.tables.notifications![0]).toMatchObject({ delivered_at: "now", delivery_failed_at: null });
  });
});
