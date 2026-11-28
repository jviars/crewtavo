/**
 * Team chat for people in the field, beside routes/chat.ts (and, like it, as the signed-in person's
 * own database client, so row-level security decides):
 *
 *   GET  /chat/settings/voice-words     whether voice notes are written out with the OpenAI key (owners, admins)
 *   PUT  /chat/settings/voice-words     turn it on (once OpenAI accepts the key) or off
 *   POST /chat/messages/:id/to-job      a message onto a job: its words as a note, or a copy of its photos and files
 *   GET  /chat/to-job/:jobId            how many subcontractors are on the job's visits (they'd see what's added)
 *   GET  /chat/statuses                 everyone's status now (theirs by hand, else their running clock's)
 *   PUT  /chat/status                   set my own status; DELETE clears it. Everyone connected hears of it.
 *   GET  /chat/scheduled                my messages waiting to be sent later (?channel= for one conversation)
 *   POST /chat/channels/:id/scheduled   schedule one; PATCH /chat/scheduled/:id changes its words or time;
 *                                       DELETE takes it back; POST /chat/scheduled/:id/send sends it now.
 *                                       The minute scheduler sends the rest (services/chatLater.ts).
 *   GET  /chat/reminders                my reminders still to come, with their messages
 *   PUT  /chat/messages/:id/reminder    remind me of a message at a time; DELETE /chat/reminders/:id takes it back
 */
import { ADMINS, levelLabel, SALES, toEditable } from "@crewtavo/core";
import { CUSTOM_STATUS, isAudio, STATUS_KINDS, STATUS_TEXT_MAX } from "@crewtavo/core/chatField";
import { fileTitle } from "@crewtavo/core/drive";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { checkOpenAiKey } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { toCompany, toUser } from "../lib/chatHub";
import { dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { reserveStorage, snapshotsFrom } from "../lib/storageLimits";
import { adminClient } from "../lib/supabase";
import { removeStored } from "../services/planFiles";
import { afterMessage, voiceWordsOn } from "../services/chatVoice";
import { attachment, chatDbError, loadPeople, MESSAGE_COLUMNS, messageBody, publish, requireOn, shapeMessages, type MessageRow } from "./chat";

type Ctx = Context<AppEnv>;

export const chatField = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// Voice notes written out (Chat settings)
// ---------------------------------------------------------------------------------------------

chatField.get("/chat/settings/voice-words", requireUser, requireCompany(ADMINS), async (c) => {
  const admin = adminClient(c.env);
  const [company, key] = await Promise.all([
    admin.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(),
    loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null),
  ]);
  if (company.error) throw dbError(company.error);
  return c.json({ on: voiceWordsOn(company.data?.settings), openai: Boolean(key?.api_key) });
});

chatField.put("/chat/settings/voice-words", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ on: z.boolean() }));
  if (body.on) {
    // It spends the business's own OpenAI key, so the key is asked about first.
    const key = (await loadSecret(c.env, adminClient(c.env), c.var.companyId, "chatgpt").catch(() => null))?.api_key;
    if (!key) throw new HttpError(400, "Add an OpenAI key under Apps → ChatGPT first, then turn this on.");
    const checked = await checkOpenAiKey(c.env, key);
    if ("problem" in checked) throw new HttpError(400, `${checked.problem} The key is under Apps → ChatGPT.`);
  }
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { chat_voice_words: body.on } });
  if (error) throw dbError(error);
  return c.json({ on: body.on });
});

// ---------------------------------------------------------------------------------------------
// From a message to a job
// ---------------------------------------------------------------------------------------------

/**
 * Who may: the people who may change a job, as the database's rules for jobs have it (owners,
 * admins, office and estimators: apply_policies('jobs', ...) in 20261016000200_operations.sql). The
 * change itself is made as them, so those rules decide again.
 */
const EDITS_JOBS = SALES;

/** "Nov 28, 6:30 AM", where the business is. */
function whenWritten(iso: string, timeZone: string | null) {
  return new Date(iso).toLocaleString("en-US", { timeZone: timeZone || "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * As a note: the message's words, who wrote it and when, added to the job's instructions for the
 * crew. That's where the office reads the job's notes on its page and every crew sees them on each
 * of the job's visits. A voice note adds its words.
 */
async function addAsNote(c: Ctx, job: { id: string; instructions: string | null }, message: MessageRow) {
  const { db, companyId } = c.var;
  const [shaped] = await shapeMessages(db, companyId, [message]);
  const mentioned = await loadPeople(db, companyId, message.mention_users);
  const roles = must(await db.from("company_roles").select("id, name").eq("company_id", companyId));
  const words = toEditable(message.body, (p) =>
    p.kind === "user" ? mentioned.get(p.id)?.name ?? "someone" : p.kind === "role" ? roles.find((r) => r.id === p.key)?.name ?? levelLabel(p.key) ?? "role" : "everyone",
  ).trim();
  const heard = shaped.attachments.filter((a) => isAudio(a) && a.words).map((a) => `Voice note: ${a.words}`);
  const text = [words, ...heard].filter(Boolean).join("\n").slice(0, 4000);
  if (!text) throw new HttpError(400, "This message has no words to add. Add its photos and files instead.");
  const company = await db.from("companies").select("timezone").eq("id", companyId).maybeSingle();
  const note = `**From Team chat:** ${shaped.author?.name ?? "Crewtavo"}, ${whenWritten(message.created_at, company.data?.timezone ?? null)}\n${text}`;
  const instructions = job.instructions?.trim() ? `${job.instructions.trimEnd()}\n\n${note}` : note;
  const { data, error } = await db.from("jobs").update({ instructions }).eq("id", job.id).select("id").maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(403, "You can't change this job.");
  return { added: 1, skipped: [] as string[] };
}

/**
 * Its photos and files: copied, so the message keeps its own. A photo goes on the job's photos (an
 * attachment on the job, in the job's folder), anything else on its Plans and files, for the crew to
 * see too, as a file added on the job's page would. Each is held to the storage limits as an upload
 * from the browser would be, and recorded as the person, so the database's rules about who adds what
 * where apply.
 */
async function addFiles(c: Ctx, job: { id: string }, message: MessageRow) {
  const { db, companyId, userId } = c.var;
  const files = Array.isArray(message.attachments) ? (message.attachments as Array<{ path: string; name?: string; type?: string; size?: number }>) : [];
  if (!files.length) throw new HttpError(400, "This message has no photos or files.");
  const store = adminClient(c.env).storage.from("files");
  const limits = snapshotsFrom(() => adminClient(c.env));
  let added = 0;
  const skipped: string[] = [];
  for (const file of files) {
    const ext = file.path.split(".").pop()!.toLowerCase();
    const name = (file.name || `${isAudio(file) ? "Voice note" : "Photo"}.${ext}`).slice(0, 200);
    const fileName = /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.${ext}`;
    // Read as the person: only a file in a channel they can see.
    const got = await db.storage.from("files").download(file.path);
    if (got.error || !got.data) {
      skipped.push(fileName);
      continue;
    }
    const bytes = new Uint8Array(await got.data.arrayBuffer());
    const contentType = (file.type || got.data.type || "application/octet-stream").split(";")[0]!.slice(0, 150);
    const photo = contentType.startsWith("image/");
    const folder = photo ? `job/${job.id}` : "plans";
    const held = await reserveStorage(limits, { company: companyId, user: userId, folder: photo ? "job" : "plans", bytes: bytes.byteLength, contentType, name: fileName });
    if (!held.ok) throw new HttpError(507, held.message);
    const path = `${companyId}/${folder}/${crypto.randomUUID()}.${ext}`;
    const stored = await store.upload(path, bytes, { contentType, upsert: false });
    if (stored.error) {
      held.release();
      skipped.push(fileName);
      continue;
    }
    const row = photo
      ? await db.from("attachments").insert({ company_id: companyId, owner_type: "job", owner_id: job.id, path, file_name: fileName, content_type: contentType, size_bytes: bytes.byteLength })
      : await db.from("plan_files").insert({ company_id: companyId, job_id: job.id, title: fileTitle(fileName), path, file_name: fileName, content_type: contentType, size_bytes: bytes.byteLength, crew_visible: true });
    if (row.error) {
      held.release();
      await removeStored(store, [path]);
      if (row.error.code === "42501") throw new HttpError(403, "You can't add files to this job.");
      skipped.push(fileName);
      continue;
    }
    held.stored();
    added++;
  }
  if (!added && skipped.length) throw new HttpError(502, "Those files couldn't be copied to the job. Try again in a minute.");
  return { added, skipped };
}

/**
 * Whether subcontractors are on the job's visits: they read its instructions and the files the crew
 * sees, so what's added from chat reaches them too, and the dialog says so first.
 */
async function subsOnJob(c: Ctx, jobId: string): Promise<number> {
  const { db, companyId } = c.var;
  const visits = must(await db.from("visits").select("id").eq("company_id", companyId).eq("job_id", jobId).limit(1000));
  if (!visits.length) return 0;
  const on = must(await db.from("visit_assignees").select("user_id").eq("company_id", companyId).in("visit_id", visits.map((v) => v.id)));
  const people = [...new Set(on.map((a) => a.user_id))];
  if (!people.length) return 0;
  return must(await db.from("memberships").select("user_id").eq("company_id", companyId).eq("role", "subcontractor").in("user_id", people)).length;
}

chatField.get("/chat/to-job/:jobId", requireUser, requireCompany(EDITS_JOBS), async (c) => {
  const jobId = uuid.parse(c.req.param("jobId"));
  await requireOn(c);
  return c.json({ subs: await subsOnJob(c, jobId) });
});

chatField.post("/chat/messages/:id/to-job", requireUser, requireCompany(EDITS_JOBS), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ job_id: uuid, as: z.enum(["note", "files"]) }));
  const { db, companyId } = c.var;
  await requireOn(c);
  // This company's message, as the person sees it.
  const message = must(await db.from("chat_messages").select(MESSAGE_COLUMNS).eq("company_id", companyId).eq("id", id).maybeSingle(), "That message isn't here anymore.") as MessageRow;
  if (message.deleted_at) throw new HttpError(404, "That message isn't here anymore.");
  const job = must(await db.from("jobs").select("id, number, title, instructions").eq("company_id", companyId).eq("id", body.job_id).maybeSingle(), "That job isn't here anymore.");
  const done = body.as === "note" ? await addAsNote(c, job, message) : await addFiles(c, job, message);
  return c.json({ job: { id: job.id, number: job.number, title: job.title }, ...done });
});

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export interface ChatStatusOut {
  user_id: string;
  kind: string;
  words: string | null;
  until: string | null;
  by_clock: boolean;
}

chatField.get("/chat/statuses", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.rpc("chat_statuses", { p_company: companyId })) as ChatStatusOut[];
  return c.json({ statuses: rows });
});

chatField.put("/chat/status", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z
      .object({
        kind: z.enum([CUSTOM_STATUS, ...STATUS_KINDS.map((k) => k.key)] as [string, ...string[]]),
        words: z.string().trim().max(STATUS_TEXT_MAX, `Keep it under ${STATUS_TEXT_MAX} characters.`).nullable().default(null),
        until: z.iso.datetime({ offset: true }).nullable().default(null),
      })
      .refine((b) => b.kind !== CUSTOM_STATUS || Boolean(b.words), { message: "Write your status first.", path: ["words"] }),
  );
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const row = { company_id: companyId, user_id: userId, kind: body.kind, words: body.kind === CUSTOM_STATUS ? body.words : null, until: body.until };
  const { data, error } = await db.from("chat_statuses").upsert(row, { onConflict: "company_id,user_id" }).select("user_id, kind, words, until").single();
  if (error) throw error.code === "22023" ? new HttpError(400, "Pick when it clears: a time in the next year.") : dbError(error);
  const status: ChatStatusOut = { ...data, by_clock: false };
  toCompany(companyId, { type: "status", user_id: userId, status });
  return c.json({ status });
});

chatField.delete("/chat/status", requireUser, requireCompany(), async (c) => {
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { error } = await db.from("chat_statuses").delete().eq("company_id", companyId).eq("user_id", userId);
  if (error) throw dbError(error);
  // What the clock says comes back, if it's running: read again by whoever's looking.
  toCompany(companyId, { type: "status", user_id: userId, status: null });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Sending later
// ---------------------------------------------------------------------------------------------

const SCHEDULED_COLUMNS = "id, channel_id, body, attachments, job_id, reply_to, send_at, created_at";
const sendAt = z.iso.datetime({ offset: true });

/** Said when a time is gone by or more than a year away (chat_scheduled_guard). */
const laterError = (error: { message: string; code?: string }) => (error.code === "22023" && /next year/.test(error.message) ? new HttpError(400, "Pick a time from now to a year ahead.") : chatDbError(error));

chatField.get("/chat/scheduled", requireUser, requireCompany(), async (c) => {
  const channel = c.req.query("channel");
  const { db, companyId } = c.var;
  await requireOn(c);
  let q = db.from("chat_scheduled_messages").select(SCHEDULED_COLUMNS).eq("company_id", companyId).order("send_at").limit(200);
  if (channel) q = q.eq("channel_id", uuid.parse(channel));
  return c.json({ scheduled: must(await q) });
});

chatField.post("/chat/channels/:id/scheduled", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(
    c,
    z.object({ body: messageBody.default(""), attachments: z.array(attachment).max(6).default([]), job_id: uuid.nullable().default(null), reply_to: uuid.nullable().default(null), send_at: sendAt }),
  );
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { data, error } = await db
    .from("chat_scheduled_messages")
    .insert({ company_id: companyId, channel_id: id, author_id: userId, body: body.body, attachments: body.attachments as never, job_id: body.job_id, reply_to: body.reply_to, send_at: body.send_at })
    .select(SCHEDULED_COLUMNS)
    .single();
  if (error) throw laterError(error);
  toUser(companyId, userId, { type: "scheduled", channel_id: id });
  return c.json({ scheduled: data }, 201);
});

chatField.patch("/chat/scheduled/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ body: messageBody.optional(), send_at: sendAt.optional() }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const patch = { ...(body.body !== undefined && { body: body.body }), ...(body.send_at && { send_at: body.send_at }) };
  if (!Object.keys(patch).length) throw new HttpError(400, "Nothing to change.");
  const { data, error } = await db.from("chat_scheduled_messages").update(patch).eq("id", id).select(SCHEDULED_COLUMNS).maybeSingle();
  if (error) throw laterError(error);
  if (!data) throw new HttpError(404, "That message was sent or taken back already.");
  toUser(companyId, userId, { type: "scheduled", channel_id: data.channel_id });
  return c.json({ scheduled: data });
});

chatField.delete("/chat/scheduled/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  // Its files stay stored (nobody signed in deletes a stored file, and the server can't tell here
  // whose upload one was), as a photo picked and then left out of a message does.
  const { data, error } = await db.from("chat_scheduled_messages").delete().eq("id", id).select("channel_id").maybeSingle();
  if (error) throw dbError(error);
  if (!data) throw new HttpError(404, "That message was sent or taken back already.");
  toUser(companyId, userId, { type: "scheduled", channel_id: data.channel_id });
  return c.json({ ok: true });
});

/**
 * Send now: the database takes the scheduled message as it sends it (public.chat_send_scheduled_now),
 * so the minute's run can't send it too. Published here only when this call sent it.
 */
chatField.post("/chat/scheduled/:id/send", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { data: sent, error } = await db.rpc("chat_send_scheduled_now", { p_id: id });
  if (error) {
    if (error.code === "P0002") throw new HttpError(404, "That message was sent or taken back already.");
    if (error.code === "55P03") throw new HttpError(409, "It's being sent right now.");
    throw chatDbError(error);
  }
  const row = (await db.from("chat_messages").select(MESSAGE_COLUMNS).eq("company_id", companyId).eq("id", id).eq("author_id", userId).maybeSingle()).data as MessageRow | null;
  if (!row) throw new HttpError(404, "That message was sent or taken back already.");
  toUser(companyId, userId, { type: "scheduled", channel_id: row.channel_id });
  const [message] = await shapeMessages(db, companyId, [row]);
  if (sent) {
    publish(c, message.channel_id, { type: "message", channel_id: message.channel_id, message });
    afterMessage(c, message);
  }
  return c.json({ message });
});

// ---------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------

chatField.get("/chat/reminders", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.from("chat_reminders").select("id, message_id, channel_id, remind_at").eq("company_id", companyId).order("remind_at").limit(200));
  const messages = rows.length ? (must(await db.from("chat_messages").select(MESSAGE_COLUMNS).in("id", rows.map((r) => r.message_id))) as MessageRow[]) : [];
  const shaped = new Map((await shapeMessages(db, companyId, messages.filter((m) => !m.deleted_at))).map((m) => [m.id, m]));
  return c.json({ reminders: rows.filter((r) => shaped.has(r.message_id)).map((r) => ({ ...r, message: shaped.get(r.message_id)! })) });
});

chatField.put("/chat/messages/:id/reminder", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ remind_at: sendAt }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const message = must(await db.from("chat_messages").select("id, channel_id").eq("company_id", companyId).eq("id", id).maybeSingle(), "That message isn't here anymore.");
  const { data, error } = await db
    .from("chat_reminders")
    .upsert({ company_id: companyId, channel_id: message.channel_id, message_id: id, user_id: userId, remind_at: body.remind_at }, { onConflict: "user_id,message_id" })
    .select("id, message_id, channel_id, remind_at")
    .single();
  if (error) throw error.code === "22023" && /next year/.test(error.message) ? new HttpError(400, "Pick a time from now to a year ahead.") : chatDbError(error);
  toUser(companyId, userId, { type: "reminders" });
  return c.json({ reminder: data });
});

chatField.delete("/chat/reminders/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { error } = await db.from("chat_reminders").delete().eq("id", id);
  if (error) throw dbError(error);
  toUser(companyId, userId, { type: "reminders" });
  return c.json({ ok: true });
});
