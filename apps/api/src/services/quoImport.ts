/**
 * Bringing in a Quo number's past texts and calls (Apps → Quo → Bring in past texts and calls),
 * in the background, with how far it got kept on the integration (QuoSettings.import) for the page.
 *
 *   - Texts: every text the number sent or got since the day picked (Quo's list, 50 at a time,
 *     newest first), on the timeline of the client whose number it was, marked as from Quo's
 *     history. Texts Crewtavo itself sent through Quo (quo_sent) are already there and are skipped.
 *   - Calls, while calls are kept: each with Quo's summary and a voicemail's words.
 *   - Nobody is told and nothing is acted on: no STOP, no notices, no automations. A number that
 *     isn't a client's or a contact's is left in Quo and counted.
 *   - Afterwards, a client whose latest message is from the history isn't waiting on a reply.
 *
 * Safe to run again: what's already here (by Quo's id) isn't added twice. Quo allows 10 requests
 * a second for a key; this asks one page at a time, well under it.
 */
import type { Env } from "../env";
import { asJson } from "../lib/http";
import { companyQuo, forgetQuo, quoRequest, type QuoAccount, type QuoImportState } from "../lib/quo";
import type { Db } from "../lib/supabase";
import { callFromApi, fileCall, fileSentText, rememberingParties, textWords, type QuoApiCall, type Resolve } from "./quo";

/** An import that hasn't said how far it got in this long died with its server. */
export const QUO_IMPORT_STALE_MS = 10 * 60_000;

type FetchLike = typeof fetch;

interface QuoMessage {
  id?: string;
  to?: string[];
  from?: string;
  text?: string;
  direction?: string;
  status?: string;
  createdAt?: string;
  media?: unknown[];
}

interface Page<T> {
  data?: T[];
  nextCursor?: string | null;
}

async function saveState(admin: Db, companyId: string, state: QuoImportState) {
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "quo" }).maybeSingle();
  if (!data) return;
  const next = { ...((data.settings ?? {}) as Record<string, unknown>), import: { ...state, updated_at: new Date().toISOString() } };
  await admin.from("integrations").update({ settings: asJson(next) }).match({ company_id: companyId, provider: "quo" });
}

/** Whether an import is going now (and not one that died with its server). */
export const importRunning = (state: QuoImportState | null | undefined) =>
  state?.status === "running" && Date.now() - Date.parse(state.updated_at ?? state.started_at) < QUO_IMPORT_STALE_MS;

/** Marks an import as started before it runs in the background, so a second click is refused. */
export async function beginQuoImport(admin: Db, companyId: string, since: string | null): Promise<QuoImportState> {
  const state: QuoImportState = { status: "running", since, started_at: new Date().toISOString(), counts: { texts: 0, calls: 0, skipped: 0 } };
  await saveState(admin, companyId, state);
  return state;
}

const sinceIso = (since: string | null) => (since ? `${since}T00:00:00Z` : undefined);

export async function importFromQuo(env: Env, admin: Db, companyId: string, state: QuoImportState, fetcher: FetchLike = fetch): Promise<void> {
  try {
    forgetQuo(companyId);
    const account = await companyQuo(env, companyId);
    if (!account) throw new Error("Quo isn't connected.");
    const resolve = rememberingParties(admin, companyId);
    const touched = new Set<string>();
    await importTexts(env, admin, account, state, resolve, touched, fetcher);
    await saveState(admin, companyId, state);
    if (account.settings.calls !== false) await importCalls(env, admin, account, state, resolve, touched, fetcher);
    await settle(admin, companyId, touched);
    await saveState(admin, companyId, { ...state, status: "done", finished_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveState(admin, companyId, { ...state, status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 300) });
    throw error;
  }
}

async function importTexts(env: Env, admin: Db, account: QuoAccount, state: QuoImportState, resolve: Resolve, touched: Set<string>, fetcher: FetchLike) {
  const own = account.settings.from_number;
  let after: string | undefined;
  do {
    const page = await quoRequest<Page<QuoMessage>>(env, account.key, "/messages", {
      query: { phoneNumberId: account.settings.phone_number_id, "createdAt[gt]": sinceIso(state.since), limit: "50", after },
    }, fetcher);
    const items = (page.data ?? []).filter((m): m is QuoMessage & { id: string } => Boolean(m.id));
    const ids = items.map((m) => m.id);
    // Already here: filed by the webhook, sent by Crewtavo, or brought in before.
    const [{ data: kept }, { data: ours }] = ids.length
      ? await Promise.all([
          admin.from("messages").select("external_id").eq("company_id", account.companyId).in("external_id", ids),
          admin.from("quo_sent").select("message_id").eq("company_id", account.companyId).in("message_id", ids),
        ])
      : [{ data: [] }, { data: [] }];
    const known = new Set([...(kept ?? []).map((r) => r.external_id), ...(ours ?? []).map((r) => r.message_id)]);
    for (const m of items) {
      if (known.has(m.id)) continue;
      const body = textWords(m.text ?? null, Array.isArray(m.media) ? m.media.length : 0);
      if (!body) continue;
      const createdAt = m.createdAt && !Number.isNaN(Date.parse(m.createdAt)) ? new Date(m.createdAt).toISOString() : new Date().toISOString();
      if (m.direction === "outgoing") {
        const to = (m.to ?? []).filter((n) => n !== own);
        const status = m.status === "failed" || m.status === "undelivered" ? "failed" : m.status === "delivered" ? "delivered" : "sent";
        const filed = await fileSentText(admin, account.companyId, { id: m.id, to, body, createdAt, status }, "quo_import", resolve);
        if (filed) state.counts.texts++;
        else state.counts.skipped++;
        if (filed) for (const n of to) for (const p of await resolve(n)) touched.add(p.client_id);
        continue;
      }
      const from = m.from ?? "";
      const parties = /^\+[1-9][0-9]{6,14}$/.test(from) ? await resolve(from) : [];
      if (!parties.length) {
        state.counts.skipped++;
        continue;
      }
      for (const party of parties) {
        const { error } = await admin.from("messages").insert({
          company_id: account.companyId, client_id: party.client_id, channel: "sms", direction: "in", status: "received", body,
          external_id: m.id, sent_by: null, created_at: createdAt, from_phone: from, origin: "quo_import",
          ...(party.contact ? { from_name: party.contact.slice(0, 200) } : {}),
        });
        if (error) throw new Error(`Couldn't bring in a text: ${error.message}`);
        touched.add(party.client_id);
      }
      state.counts.texts++;
    }
    await saveState(admin, account.companyId, state);
    after = page.nextCursor ?? undefined;
  } while (after);
}

async function importCalls(env: Env, admin: Db, account: QuoAccount, state: QuoImportState, resolve: Resolve, touched: Set<string>, fetcher: FetchLike) {
  let after: string | undefined;
  do {
    const page = await quoRequest<Page<QuoApiCall>>(env, account.key, "/calls", {
      query: { phoneNumberId: account.settings.phone_number_id, "createdAt[gte]": sinceIso(state.since), include: "summary,voicemail", limit: "50", after },
    }, fetcher);
    for (const raw of page.data ?? []) {
      const call = callFromApi(raw, account.settings.from_number);
      if (!call) continue;
      const filed = await fileCall(admin, account.companyId, call, { origin: "quo_import", notify: false, resolve });
      if (filed === "filed") {
        state.counts.calls++;
        if (call.other) for (const p of await resolve(call.other)) touched.add(p.client_id);
      } else if (filed === "skipped" || filed === "unknown") state.counts.skipped++;
    }
    await saveState(admin, account.companyId, state);
    after = page.nextCursor ?? undefined;
  } while (after);
}

/**
 * A client whose latest message came from the history waits on nobody: an old text from them
 * isn't a conversation the office has to answer today.
 */
async function settle(admin: Db, companyId: string, clients: Set<string>) {
  for (const clientId of clients) {
    const { data: latest } = await admin.from("messages").select("origin").eq("company_id", companyId).eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (latest?.origin !== "quo_import") continue;
    const { error } = await admin.from("conversations_done").upsert({ client_id: clientId, company_id: companyId });
    if (error) console.warn(`Couldn't mark a brought-in conversation done: ${error.message}`);
  }
}
