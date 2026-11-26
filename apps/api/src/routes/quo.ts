/**
 * Quo (Apps → Quo): a business's own Quo number for its texts, and that number's calls on clients'
 * timelines. lib/quo.ts talks to Quo; services/quo.ts files what Quo reports; services/quoImport.ts
 * brings in the past.
 *
 *   POST /webhooks/quo/:company   Quo's deliveries for the company's number, signed with the key of
 *                                 the webhook Crewtavo made for it, each handled once.
 *   POST /apps/quo/numbers        The workspace's numbers, for the key being pasted (or the one kept).
 *   PUT  /apps/quo/account        Connect: the key (checked with Quo) and the number; the webhook is
 *                                 made in Quo then, when Quo can reach this Crewtavo.
 *   POST /apps/quo/webhook        Make the webhook again, or bring it up to date (this Crewtavo moved).
 *   POST /apps/quo/test           Ask Quo to send the webhook a sample, to see it get through.
 *   PATCH /apps/quo/settings      Keep calls or not; automatic texts in Quo's Done view or its inbox.
 *   POST /apps/quo/import         Bring in past texts and calls, in the background.
 * Disconnecting is the Apps page's own (routes/apps.ts), which takes the webhook out of Quo first.
 */
import { ADMINS } from "@crewtavo/core";
import { phoneDisplay } from "@crewtavo/core/phone";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { kickAutomations, runInBackground } from "../lib/background";
import { appUrl, asJson, dbError, HttpError, isoDate, readJson } from "../lib/http";
import { sendingWorks } from "../lib/notify";
import { reportError } from "../lib/monitoring";
import {
  companyQuo,
  createQuoWebhook,
  deleteQuoWebhook,
  forgetQuo,
  QuoError,
  quoNumbers,
  QuoProblem,
  testQuoWebhook,
  updateQuoWebhook,
  verifyQuoWebhook,
  type QuoImportState,
  type QuoSettings,
} from "../lib/quo";
import { adminClient, type Db } from "../lib/supabase";
import { loadSecret, saveSecret } from "../integrations/tokens";
import { handleQuoEvent, type QuoEvent } from "../services/quo";
import { beginQuoImport, importFromQuo, importRunning } from "../services/quoImport";

export const quo = new Hono<AppEnv>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How often the last delivery's time is written down (a busy number gets many). */
const HEARD_EVERY_MS = 5 * 60_000;
/** Handled deliveries are kept a little past Quo's 28 hours of trying again; Crewtavo's own texts long enough to recognise them in an import. */
const EVENTS_KEPT_MS = 3 * 86_400_000;
const SENT_KEPT_MS = 400 * 86_400_000;

/** Where Quo sends the company's number's events. */
export const quoWebhookUrl = (base: string, companyId: string) => `${base}/api/webhooks/quo/${companyId}`;

/** Quo only delivers to a public https address; a stand-in for testing (QUO_API_URL) reaches plain http too. */
const reachable = (env: Env, base: string) => base.startsWith("https://") || Boolean(env.QUO_API_URL);

// ---------------------------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------------------------

/** When a company's key was last read again after a signature didn't match, so a stranger's posts can't make every one a read. */
const reread = new Map<string, number>();

quo.post("/webhooks/quo/:company", async (c) => {
  const companyId = c.req.param("company");
  if (!UUID.test(companyId)) throw new HttpError(404, "Not found.");
  const body = await c.req.text();
  const headers = { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") };
  let account = await companyQuo(c.env, companyId);
  let signed = Boolean(account?.webhookKey) && (await verifyQuoWebhook(account!.webhookKey!, headers, body));
  // The webhook made again a moment ago has a new key: read it once more before refusing.
  if (!signed && Date.now() - (reread.get(companyId) ?? 0) > 10_000) {
    reread.set(companyId, Date.now());
    forgetQuo(companyId);
    account = await companyQuo(c.env, companyId);
    signed = Boolean(account?.webhookKey) && (await verifyQuoWebhook(account!.webhookKey!, headers, body));
  }
  if (!account) throw new HttpError(404, "Quo isn't connected here.");
  if (!signed) throw new HttpError(401, "Bad signature.");

  const admin = adminClient(c.env);
  const eventId = headers.id!.slice(0, 200);
  // Each delivery once: Quo tries one again until it's answered with a 2xx.
  const seen = await admin.from("quo_events").insert({ company_id: companyId, event_id: eventId });
  if (seen.error?.code === "23505") return c.json({ ok: true, again: true });
  if (seen.error) throw dbError(seen.error);
  let event: QuoEvent;
  try {
    event = JSON.parse(body) as QuoEvent;
  } catch {
    return c.json({ ok: true, ignored: "not JSON" });
  }
  try {
    const touched = await handleQuoEvent(c.env, admin, account, event);
    for (const company of touched) kickAutomations(c, company);
  } catch (error) {
    // Not handled: Quo tries it again later, and it isn't taken for one already done.
    await admin.from("quo_events").delete().match({ company_id: companyId, event_id: eventId });
    throw error;
  }
  runInBackground(c, noteHeard(admin, companyId, account.settings));
  return c.json({ ok: true });
});

/** Notes that Quo's deliveries get through (every few minutes at most), and lets old records go now and then. */
async function noteHeard(admin: Db, companyId: string, settings: QuoSettings) {
  if (settings.heard_at && Date.now() - Date.parse(settings.heard_at) < HEARD_EVERY_MS) return;
  const now = new Date().toISOString();
  settings.heard_at = now;
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "quo" }).maybeSingle();
  if (data) await admin.from("integrations").update({ settings: asJson({ ...((data.settings ?? {}) as Record<string, unknown>), heard_at: now }) }).match({ company_id: companyId, provider: "quo" });
  await admin.from("quo_events").delete().eq("company_id", companyId).lt("received_at", new Date(Date.now() - EVENTS_KEPT_MS).toISOString());
  await admin.from("quo_sent").delete().eq("company_id", companyId).lt("sent_at", new Date(Date.now() - SENT_KEPT_MS).toISOString());
}

// ---------------------------------------------------------------------------------------------
// The Apps page
// ---------------------------------------------------------------------------------------------

/** Quo on its app page (GET /apps): the number, the webhook, the switches and the last import. */
export interface QuoState {
  number: { id: string; number: string; name: string } | null;
  webhook: {
    /** Crewtavo made it in Quo, for this address. */
    set: boolean;
    /** It was made for another address (this Crewtavo moved): bringing it up to date fixes it. */
    moved: boolean;
    url: string;
    problem: string | null;
  };
  /** Quo can reach this Crewtavo (a public https address). */
  reachable: boolean;
  /** When Quo's last delivery got through. */
  heard_at: string | null;
  calls: boolean;
  quiet: boolean;
  import: (QuoImportState & { stopped?: boolean }) | null;
  /** The company also has its own Twilio account connected, which Quo takes over from. */
  twilio: boolean;
}

export function quoState(env: Env, base: string, companyId: string, settings: QuoSettings | null, twilio: boolean): QuoState {
  const url = quoWebhookUrl(base, companyId);
  const running = settings?.import ?? null;
  return {
    number: settings?.phone_number_id ? { id: settings.phone_number_id, number: settings.from_number, name: settings.number_name || phoneDisplay(settings.from_number) } : null,
    webhook: {
      set: Boolean(settings?.webhook_id) && settings!.webhook_url === url,
      moved: Boolean(settings?.webhook_id) && settings!.webhook_url !== url,
      url,
      problem: settings?.webhook_problem ?? null,
    },
    reachable: reachable(env, base),
    heard_at: settings?.heard_at ?? null,
    calls: settings?.calls !== false,
    quiet: settings?.quiet !== false,
    import: running ? { ...running, ...(running.status === "running" && !importRunning(running) ? { stopped: true } : {}) } : null,
    twilio,
  };
}

async function readSettings(admin: Db, companyId: string): Promise<{ status: string; settings: QuoSettings } | null> {
  const { data } = await admin.from("integrations").select("status, settings").match({ company_id: companyId, provider: "quo" }).maybeSingle();
  return data ? { status: data.status, settings: (data.settings ?? {}) as unknown as QuoSettings } : null;
}

async function writeSettings(admin: Db, companyId: string, settings: QuoSettings) {
  const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).match({ company_id: companyId, provider: "quo" });
  if (error) throw dbError(error);
  forgetQuo(companyId);
}

/** Whether the company has its own Twilio account connected too. */
async function hasOwnTwilio(admin: Db, companyId: string): Promise<boolean> {
  const { data } = await admin.from("integrations").select("external_account_id").match({ company_id: companyId, provider: "twilio" }).neq("status", "disconnected").maybeSingle();
  return Boolean(data?.external_account_id);
}

async function stateFor(c: Context<AppEnv>, admin: Db): Promise<QuoState> {
  const row = await readSettings(admin, c.var.companyId);
  return quoState(c.env, appUrl(c), c.var.companyId, row && row.status !== "disconnected" ? row.settings : null, await hasOwnTwilio(admin, c.var.companyId));
}

/** The key kept for the company, for a change that doesn't paste a new one. */
async function keptKey(c: Context<AppEnv>): Promise<string> {
  const secret = await loadSecret(c.env, adminClient(c.env), c.var.companyId, "quo").catch(() => null);
  if (!secret?.api_key) throw new HttpError(400, "Paste your Quo API key.");
  return secret.api_key;
}

const asProblem = (error: unknown) => {
  if (error instanceof QuoProblem) return new HttpError(400, error.message);
  if (error instanceof QuoError) return new HttpError(502, error.status === 401 ? "Quo didn't accept the API key anymore. Connect Quo again with a new key." : `Quo said: ${error.message}`);
  return error;
};

/**
 * Makes the webhook in Quo for the company's number, or brings the one there up to date (its
 * address, events and number), keeping its signing key. What went wrong is kept for the page to
 * say, and the company stays connected: texts still go out without it.
 */
async function setUpWebhook(c: Context<AppEnv>, admin: Db, key: string, settings: QuoSettings): Promise<QuoSettings> {
  const base = appUrl(c);
  const url = quoWebhookUrl(base, c.var.companyId);
  const input = { url, phoneNumberId: settings.phone_number_id, calls: settings.calls !== false };
  if (!reachable(c.env, base)) return { ...settings, webhook_problem: "Quo can only send replies and calls to a public https address, and this Crewtavo doesn't have one yet." };
  try {
    if (settings.webhook_id) {
      try {
        await updateQuoWebhook(c.env, key, settings.webhook_id, input);
        return { ...settings, webhook_url: url, webhook_problem: null };
      } catch (error) {
        // Deleted in Quo: make a new one.
        if (!(error instanceof QuoError && error.status === 404)) throw error;
      }
    }
    const made = await createQuoWebhook(c.env, key, input);
    const secret = await loadSecret(c.env, admin, c.var.companyId, "quo");
    await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: key, extra: { ...(secret?.extra ?? {}), webhook_key: made.key } });
    return { ...settings, webhook_id: made.id, webhook_url: url, webhook_problem: null };
  } catch (error) {
    if (!(error instanceof QuoError)) throw error;
    const problem = error.status === 401 ? "Quo didn't accept the API key." : `Quo couldn't set it up (${error.status ? `error ${error.status}: ` : ""}${error.message})`;
    return { ...settings, webhook_problem: problem.slice(0, 300) };
  }
}

quo.post("/apps/quo/numbers", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ api_key: z.string().trim().max(500).optional() }));
  const key = body.api_key || (await keptKey(c));
  try {
    const numbers = await quoNumbers(c.env, key);
    if (!numbers.length) throw new HttpError(400, "There are no numbers in this Quo workspace yet. Add one in Quo first.");
    return c.json({ numbers });
  } catch (error) {
    throw asProblem(error);
  }
});

quo.put("/apps/quo/account", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ api_key: z.string().trim().max(500).optional(), phone_number_id: z.string().trim().regex(/^PN\S{1,100}$/, "Pick the number to text from.") }));
  const admin = adminClient(c.env);
  const before = await readSettings(admin, c.var.companyId);
  const oldKey = await loadSecret(c.env, admin, c.var.companyId, "quo").then((s) => s?.api_key ?? null).catch(() => null);
  const key = body.api_key || (before && before.status !== "disconnected" ? oldKey : null);
  if (!key) throw new HttpError(400, "Paste your Quo API key.");
  let numbers;
  try {
    numbers = await quoNumbers(c.env, key);
  } catch (error) {
    throw asProblem(error);
  }
  const number = numbers.find((n) => n.id === body.phone_number_id);
  if (!number) throw new HttpError(400, "That number isn't in this Quo workspace anymore. Pick it again.");
  // A new key may be another workspace's: the webhook made with the old one goes, and a new one is made.
  const was = before && before.status !== "disconnected" ? before.settings : null;
  const sameKey = Boolean(oldKey) && oldKey === key;
  if (was?.webhook_id && !sameKey && oldKey) await deleteQuoWebhook(c.env, oldKey, was.webhook_id).catch((error) => reportError(error, { feature: "quo" }));
  const settings: QuoSettings = {
    ...(was ?? {}),
    phone_number_id: number.id,
    from_number: number.number,
    number_name: number.name,
    ...(sameKey ? {} : { webhook_id: null, webhook_url: null }),
    webhook_problem: null,
    heard_at: sameKey ? (was?.heard_at ?? null) : null,
    import: was && was.phone_number_id === number.id && sameKey ? (was.import ?? null) : null,
  };
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId,
    provider: "quo",
    status: "connected",
    account_label: `${number.name} · ${phoneDisplay(number.number)}`.slice(0, 200),
    external_account_id: number.id,
    settings: asJson(settings),
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw dbError(error);
  const kept = sameKey ? await loadSecret(c.env, admin, c.var.companyId, "quo").catch(() => null) : null;
  await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: key, extra: { ...(kept?.extra ?? {}) } });
  forgetQuo(c.var.companyId);
  await writeSettings(admin, c.var.companyId, await setUpWebhook(c, admin, key, settings));
  // A warning that texts weren't going out was about how they went before.
  await sendingWorks(c.env, c.var.companyId, "sms");
  return c.json({ provider: "quo", status: "connected", quo: await stateFor(c, admin) });
});

/** Connected companies only: the kept key and settings. */
async function connected(c: Context<AppEnv>, admin: Db): Promise<{ key: string; settings: QuoSettings }> {
  const row = await readSettings(admin, c.var.companyId);
  if (!row || row.status === "disconnected" || !row.settings.phone_number_id) throw new HttpError(409, "Connect Quo first.");
  return { key: await keptKey(c), settings: row.settings };
}

quo.post("/apps/quo/webhook", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const admin = adminClient(c.env);
  const { key, settings } = await connected(c, admin);
  const next = await setUpWebhook(c, admin, key, settings);
  await writeSettings(admin, c.var.companyId, next);
  if (next.webhook_problem) throw new HttpError(502, next.webhook_problem);
  return c.json({ quo: await stateFor(c, admin) });
});

quo.post("/apps/quo/test", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const admin = adminClient(c.env);
  const { key, settings } = await connected(c, admin);
  if (!settings.webhook_id) throw new HttpError(409, "Set up the webhook first.");
  try {
    await testQuoWebhook(c.env, key, settings.webhook_id);
  } catch (error) {
    throw asProblem(error);
  }
  return c.json({ sent: true, asked_at: new Date().toISOString() });
});

quo.patch("/apps/quo/settings", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ calls: z.boolean().optional(), quiet: z.boolean().optional() }));
  const admin = adminClient(c.env);
  const { key, settings } = await connected(c, admin);
  let next: QuoSettings = { ...settings, ...(body.calls === undefined ? {} : { calls: body.calls }), ...(body.quiet === undefined ? {} : { quiet: body.quiet }) };
  // The webhook listens for calls only while they're kept.
  if (body.calls !== undefined && body.calls !== (settings.calls !== false) && settings.webhook_id) next = await setUpWebhook(c, admin, key, next);
  await writeSettings(admin, c.var.companyId, next);
  return c.json({ quo: await stateFor(c, admin) });
});

quo.post("/apps/quo/import", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ since: isoDate.nullable().default(null) }));
  const admin = adminClient(c.env);
  const { settings } = await connected(c, admin);
  if (importRunning(settings.import)) throw new HttpError(409, "Past texts and calls are already coming in.");
  const state = await beginQuoImport(admin, c.var.companyId, body.since);
  runInBackground(c, importFromQuo(c.env, admin, c.var.companyId, state));
  return c.json({ status: "running" }, 202);
});
