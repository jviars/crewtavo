/**
 * Team chat for people in the field, beside routes/chat.ts (and, like it, as the signed-in person's
 * own database client, so row-level security decides):
 *
 *   GET  /chat/settings/voice-words     whether voice notes are written out with the OpenAI key (owners, admins)
 *   PUT  /chat/settings/voice-words     turn it on (once OpenAI accepts the key) or off
 *   POST /chat/messages/:id/to-job      a message onto a job: its words as a note, or a copy of its photos and files
 */
import { ADMINS, levelLabel, SALES, toEditable } from "@crewtavo/core";
import { isAudio } from "@crewtavo/core/chatField";
import { fileTitle } from "@crewtavo/core/drive";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { checkOpenAiKey } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { reserveStorage, snapshotsFrom } from "../lib/storageLimits";
import { adminClient } from "../lib/supabase";
import { removeStored } from "../services/planFiles";
import { voiceWordsOn } from "../services/chatVoice";
import { loadPeople, messageById, requireOn, shapeMessages } from "./chat";

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
async function addAsNote(c: Ctx, job: { id: string; instructions: string | null }, message: Awaited<ReturnType<typeof messageById>>) {
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
async function addFiles(c: Ctx, job: { id: string }, message: Awaited<ReturnType<typeof messageById>>) {
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

chatField.post("/chat/messages/:id/to-job", requireUser, requireCompany(EDITS_JOBS), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ job_id: uuid, as: z.enum(["note", "files"]) }));
  const { db, companyId } = c.var;
  await requireOn(c);
  const message = await messageById(db, id);
  if (message.deleted_at) throw new HttpError(404, "That message isn't here anymore.");
  const job = must(await db.from("jobs").select("id, number, title, instructions").eq("company_id", companyId).eq("id", body.job_id).maybeSingle(), "That job isn't here anymore.");
  const done = body.as === "note" ? await addAsNote(c, job, message) : await addFiles(c, job, message);
  return c.json({ job: { id: job.id, number: job.number, title: job.title }, ...done });
});
