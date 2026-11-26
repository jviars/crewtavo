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
  listQuoWebhooks,
  QuoError,
  quoNumbers,
  QuoProblem,
  remember,
  rotateQuoWebhook,
  testQuoWebhook,
  updateQuoWebhook,
  verifyQuoWebhook,
  type QuoImportState,
  type QuoSettings,
} from "../lib/quo";
import { adminClient, type Db } from "../lib/supabase";
import { IntegrationError, loadSecret, saveSecret } from "../integrations/tokens";
import { handleQuoEvent, type QuoEvent } from "../services/quo";
import { beginQuoImport, importFromQuo, importing, importRunning } from "../services/quoImport";

export const quo = new Hono<AppEnv>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How often the last delivery's time is written down (a busy number gets many). */
const HEARD_EVERY_MS = 5 * 60_000;
/** Handled deliveries are kept a little past Quo's 28 hours of trying again; Crewtavo's own texts long enough to recognise them in an import. */
const EVENTS_KEPT_MS = 3 * 86_400_000;
const SENT_KEPT_MS = 400 * 86_400_000;

/** A number's name in Quo that's only the number written out (an unnamed one): not said twice. */
export function nameIsNumber(name: string, number: string): boolean {
  const digits = name.replace(/\D/g, "").replace(/^0+/, "");
  return /^[\d\s()+.-]+$/.test(name.trim()) && digits.length >= 7 && number.replace(/\D/g, "").endsWith(digits);
}

/** Where Quo sends the company's number's events. */
export const quoWebhookUrl = (base: string, companyId: string) => `${base}/api/webhooks/quo/${companyId}`;

/** Quo only delivers to a public https address; a stand-in for testing (QUO_API_URL) reaches plain http too. */
const reachable = (env: Env, base: string) => base.startsWith("https://") || Boolean(env.QUO_API_URL);

// ---------------------------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------------------------

/** When a company's key was last read again after a signature didn't match, so a stranger's posts can't make every one a read. */
const reread = new Map<string, number>();
/** A delivery still being handled after this long was left by a server that stopped: another try takes it over. */
const HANDLING_MS = 2 * 60_000;

quo.post("/webhooks/quo/:company", async (c) => {
  const refused = () => new HttpError(401, "Not a delivery for this Crewtavo.");
  const companyId = c.req.param("company");
  if (!UUID.test(companyId)) throw refused();
  const body = await c.req.text();
  const headers = { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") };
  let account = await companyQuo(c.env, companyId);
  // The same answer whether or not the business has Quo, so strangers learn nothing from it.
  if (!account) throw refused();
  let signed = Boolean(account.webhookKey) && (await verifyQuoWebhook(account.webhookKey!, headers, body));
  // The webhook got a new key a moment ago: read it once more before refusing (at most every 10 seconds).
  if (!signed && Date.now() - (reread.get(companyId) ?? 0) > 10_000) {
    remember(reread, companyId, Date.now());
    forgetQuo(companyId);
    account = await companyQuo(c.env, companyId);
    if (!account) throw refused();
    signed = Boolean(account.webhookKey) && (await verifyQuoWebhook(account.webhookKey!, headers, body));
  }
  if (!signed) throw refused();

  const admin = adminClient(c.env);
  const eventId = headers.id!.slice(0, 200);
  // Each delivery once: Quo tries one again until it's answered with a 2xx. One being handled right
  // now is to be tried again later; one left half done by a server that stopped is taken over.
  const claim = await admin.from("quo_events").insert({ company_id: companyId, event_id: eventId });
  if (claim.error?.code === "23505") {
    const { data: seen } = await admin.from("quo_events").select("received_at, done_at").match({ company_id: companyId, event_id: eventId }).maybeSingle();
    if (!seen || seen.done_at) return c.json({ ok: true, again: true });
    if (Date.now() - Date.parse(seen.received_at) < HANDLING_MS) return c.json({ error: "Still handling this delivery. Try it again later." }, 409);
    const { data: taken } = await admin.from("quo_events").update({ received_at: new Date().toISOString() }).match({ company_id: companyId, event_id: eventId, received_at: seen.received_at }).is("done_at", null).select("event_id");
    if (!taken?.length) return c.json({ error: "Still handling this delivery. Try it again later." }, 409);
  } else if (claim.error) throw dbError(claim.error);
  const finish = async () => {
    const { error } = await admin.from("quo_events").update({ done_at: new Date().toISOString() }).match({ company_id: companyId, event_id: eventId });
    if (error) throw dbError(error);
  };
  let event: QuoEvent;
  try {
    event = JSON.parse(body) as QuoEvent;
  } catch {
    await finish();
    return c.json({ ok: true, ignored: "not JSON" });
  }
  try {
    const touched = await handleQuoEvent(c.env, admin, account, event, { later: (work) => runInBackground(c, work) });
    for (const company of touched) kickAutomations(c, company);
    await finish();
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

/**
 * Writes only what changed, over the settings as they are now: an import's progress and Quo's
 * last delivery are written alongside, and a whole copy read earlier would put them back.
 */
async function patchSettings(admin: Db, companyId: string, patch: Partial<QuoSettings>) {
  const { data, error: readError } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "quo" }).maybeSingle();
  if (readError) throw dbError(readError);
  const { error } = await admin.from("integrations").update({ settings: asJson({ ...((data?.settings ?? {}) as Record<string, unknown>), ...patch }) }).match({ company_id: companyId, provider: "quo" });
  if (error) throw dbError(error);
  forgetQuo(companyId);
}

/** The company's kept secret: null when there's none or it can't be decrypted (ENCRYPTION_KEY changed); a database error is thrown. */
async function keptSecret(c: Context<AppEnv>, admin: Db) {
  try {
    return await loadSecret(c.env, admin, c.var.companyId, "quo");
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    reportError(error, { feature: "quo" });
    return null;
  }
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

/** Keeps the webhook's signing key with the API key. */
async function keepWebhookKey(c: Context<AppEnv>, admin: Db, key: string, webhookKey: string) {
  const secret = await loadSecret(c.env, admin, c.var.companyId, "quo");
  await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: key, extra: { ...(secret?.extra ?? {}), webhook_key: webhookKey } });
}

/**
 * Makes the webhook in Quo for the company's number, or brings the one there up to date (its
 * address, events and number), keeping its signing key; one whose key Crewtavo lost gets a new
 * key from Quo. Others in the workspace sending to this company's address (left by an earlier
 * connection) are taken out. Returns what changed in the settings; what went wrong is kept for the
 * page to say, and the company stays connected: texts still go out without it.
 */
async function setUpWebhook(c: Context<AppEnv>, admin: Db, key: string, settings: QuoSettings): Promise<Partial<QuoSettings>> {
  const base = appUrl(c);
  const url = quoWebhookUrl(base, c.var.companyId);
  const input = { url, phoneNumberId: settings.phone_number_id, calls: settings.calls !== false };
  if (!reachable(c.env, base)) return { webhook_problem: "Quo can only send replies and calls to a public https address, and this Crewtavo doesn't have one yet." };
  try {
    let id = settings.webhook_id ?? null;
    if (id) {
      try {
        await updateQuoWebhook(c.env, key, id, input);
        if (!(await loadSecret(c.env, admin, c.var.companyId, "quo"))?.extra?.webhook_key) await keepWebhookKey(c, admin, key, await rotateQuoWebhook(c.env, key, id));
      } catch (error) {
        // Deleted in Quo: make a new one.
        if (!(error instanceof QuoError && error.status === 404)) throw error;
        id = null;
      }
    }
    if (!id) {
      const made = await createQuoWebhook(c.env, key, input);
      await keepWebhookKey(c, admin, key, made.key);
      id = made.id;
    }
    const others = await listQuoWebhooks(c.env, key).catch(() => []);
    for (const other of others) if (other.id !== id && other.url === url) await deleteQuoWebhook(c.env, key, other.id).catch((error) => reportError(error, { feature: "quo" }));
    return { webhook_id: id, webhook_url: url, webhook_problem: null };
  } catch (error) {
    if (!(error instanceof QuoError)) throw error;
    const problem = error.status === 401 ? "Quo didn't accept the API key." : `Quo couldn't set it up (${error.status ? `error ${error.status}: ` : ""}${error.message})`;
    return { webhook_problem: problem.slice(0, 300) };
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
  const oldSecret = await keptSecret(c, admin);
  const oldKey = oldSecret?.api_key ?? null;
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
  const was = before && before.status !== "disconnected" ? before.settings : null;
  const sameKey = Boolean(oldKey) && oldKey === key;
  // An import goes on with the number and key it started with: they change once it's done.
  if (was && (importRunning(was.import) || importing(c.var.companyId)) && (!sameKey || was.phone_number_id !== number.id)) {
    throw new HttpError(409, "Past texts and calls are still coming in. Change the number or key once they're in.");
  }
  // A new key may be another workspace's: the webhook made with the old one goes (with the old key,
  // or the new one when it's the same workspace), and a new one is made.
  if (was?.webhook_id && !sameKey) {
    const gone = oldKey ? await deleteQuoWebhook(c.env, oldKey, was.webhook_id).then(() => true, () => false) : false;
    if (!gone) await deleteQuoWebhook(c.env, key, was.webhook_id).catch((error) => reportError(error, { feature: "quo" }));
  }
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
    account_label: `${nameIsNumber(number.name, number.number) ? "Quo" : number.name} · ${phoneDisplay(number.number)}`.slice(0, 200),
    external_account_id: number.id,
    settings: asJson(settings),
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  if (error) throw dbError(error);
  await saveSecret(c.env, admin, c.var.companyId, "quo", { api_key: key, extra: { ...(sameKey ? (oldSecret?.extra ?? {}) : {}) } });
  forgetQuo(c.var.companyId);
  await patchSettings(admin, c.var.companyId, await setUpWebhook(c, admin, key, settings));
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
  await patchSettings(admin, c.var.companyId, next);
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
  let patch: Partial<QuoSettings> = { ...(body.calls === undefined ? {} : { calls: body.calls }), ...(body.quiet === undefined ? {} : { quiet: body.quiet }) };
  // The webhook listens for calls only while they're kept.
  if (body.calls !== undefined && body.calls !== (settings.calls !== false) && settings.webhook_id) patch = { ...patch, ...(await setUpWebhook(c, admin, key, { ...settings, ...patch })) };
  await patchSettings(admin, c.var.companyId, patch);
  return c.json({ quo: await stateFor(c, admin) });
});

quo.post("/apps/quo/import", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ since: isoDate.nullable().default(null) }));
  const admin = adminClient(c.env);
  const { settings } = await connected(c, admin);
  if (importRunning(settings.import) || importing(c.var.companyId)) throw new HttpError(409, "Past texts and calls are already coming in.");
  const state = await beginQuoImport(admin, c.var.companyId, body.since);
  runInBackground(c, importFromQuo(c.env, admin, c.var.companyId, state));
  return c.json({ status: "running" }, 202);
});
