/**
 * Receipts and supplier invoices read with AI (services/receipts.ts):
 *
 *   PUT  /receipts/reading            owners and admins turn it on (once the company's AI key answers) or off.
 *   POST /receipts/read               a photo or PDF just picked in Add expense (the office's, or the
 *                                     crew's receipt from a visit): what it says, which job it seems
 *                                     to be for, and for the office which of the job's materials its
 *                                     lines seem to be. Nothing is saved. For the people who can add
 *                                     an expense: the team (STAFF). Not a subcontractor, who can't.
 *   POST /receipts/drafts/:id/read    one of several dropped in at once (expense_drafts): read the
 *                                     same way, and what was found kept on the draft for the office
 *                                     to check and confirm.
 *
 * Off, or when reading fails or takes too long, the form is filled in by hand as before: the web app
 * treats every refusal here that way. A draft that isn't read because reading is off isn't a
 * failure: it's marked to fill in (status to_fill).
 *
 * Reading has its own hourly allowance (allowReceiptRead), apart from the other AI features', so a
 * stack of receipts doesn't use up everyone's asks. Past it, a receipt picked in Add expense is
 * filled in by hand; a draft waits (status waiting) and the page reads it once there's room again.
 */
import { ADMINS, matchLines, OFFICE, readFields, readingProblems, STAFF, suggestJob, type JobCandidate, type MaterialCandidate, type ReceiptReading } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, param, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { allowReceiptRead, askerOf, checkCompanyAi } from "../services/ai";
import { READ_MAX_BYTES, readReceipt } from "../services/receipts";

export const receipts = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;

/** Whether the company has reading turned on (settings.receipt_reading). */
export const readingOn = (settings: unknown) => (settings as { receipt_reading?: unknown } | null)?.receipt_reading === true;

const OFF = "Reading receipts is off. An owner or admin can turn it on in Settings → Company.";
const USED_UP = "That's all the receipts that can be read this hour. Fill this one in by hand, or add it again later.";

async function companySettings(c: Ctx) {
  const { data, error } = await adminClient(c.env).from("companies").select("settings").eq("id", c.var.companyId).maybeSingle();
  if (error) throw dbError(error);
  return (data?.settings ?? {}) as Record<string, unknown>;
}

receipts.put("/receipts/reading", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ on: z.boolean() }));
  if (body.on) {
    // The key reading spends when nobody's own ChatGPT plan pays for it: the company's Claude or
    // OpenAI key, or else the deployment's. Checked with whichever service it's for.
    const problem = await checkCompanyAi(c.env, adminClient(c.env), c.var.companyId);
    if (problem) throw new HttpError(400, problem);
  }
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { receipt_reading: body.on } });
  if (error) throw dbError(error);
  return c.json({ on: body.on });
});

/** For the office with job costs (who log materials and see what things cost): the rest get only what the receipt says. */
const seesCosts = (c: Ctx) => (OFFICE as readonly string[]).includes(c.var.role) && c.var.permissions.includes("job_costs");

const like = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * The job the reading names, among the jobs the person can see (asked as them, so row-level
 * security decides): by number, PO or street address.
 */
async function jobFor(c: Ctx, ref: ReceiptReading["job_reference"]) {
  const columns = "id, number, title, po_number, property:properties(line1)";
  const base = () => c.var.db.from("jobs").select(columns).eq("company_id", c.var.companyId).neq("status", "archived");
  const found: JobCandidate[] = [];
  const number = Number((ref.job_number ?? "").match(/\d{1,9}/)?.[0] ?? NaN);
  const asks: Array<PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>> = [];
  if (Number.isFinite(number)) asks.push(base().eq("number", number).limit(5));
  if (ref.po_number) asks.push(base().ilike("po_number", like(ref.po_number.trim())).limit(5));
  const house = (ref.address ?? "").trim().match(/^(\d+)\s+\S/)?.[1];
  if (house) asks.push(c.var.db.from("jobs").select("id, number, title, po_number, property:properties!inner(line1)").eq("company_id", c.var.companyId).neq("status", "archived").ilike("property.line1", `${house} %`).limit(50));
  for (const { data, error } of await Promise.all(asks)) {
    if (error) throw dbError(error);
    for (const j of (data ?? []) as JobCandidate[]) if (!found.some((f) => f.id === j.id)) found.push(j);
  }
  const hit = suggestJob(ref, found);
  if (!hit) return null;
  const job = found.find((j) => j.id === hit.id) as JobCandidate & { title: string };
  return { id: job.id, number: job.number, title: job.title, why: hit.why };
}

/** What a supplier's lines can be logged as on the job: its estimated materials first, then the price list. */
async function materialsFor(c: Ctx, jobId: string): Promise<MaterialCandidate[]> {
  const estimated = await c.var.db.rpc("job_estimated_materials", { p_job: jobId });
  if (estimated.error) throw dbError(estimated.error);
  const items: Array<{ id: string; name: string; unit: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.var.db.from("services").select("id, name, unit").eq("company_id", c.var.companyId).order("id").range(from, from + 999);
    if (error) throw dbError(error);
    items.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const out: MaterialCandidate[] = (estimated.data ?? []).map((m) => ({ service_id: m.service_id, name: m.name, unit: m.unit, estimated: true }));
  for (const s of items) if (!out.some((m) => m.service_id === s.id)) out.push({ service_id: s.id, name: s.name, unit: s.unit, estimated: false });
  return out;
}

/** A reading with what the form needs: the fields it filled, what doesn't add up, and the job and materials it seems to be. */
async function answerFor(c: Ctx, reading: ReceiptReading, jobId: string | null) {
  const job = jobId ? null : await jobFor(c, reading.job_reference);
  const on = jobId ?? job?.id ?? null;
  const candidates = on && reading.lines.length && seesCosts(c) ? await materialsFor(c, on) : [];
  return {
    reading,
    fields: readFields(reading),
    problems: readingProblems(reading),
    job,
    candidates,
    matches: candidates.length ? matchLines(reading.lines, candidates) : reading.lines.map(() => null),
  };
}

const base64 = z.string().max(Math.ceil((READ_MAX_BYTES * 4) / 3) + 4, "That file is too large to read. Fill it in by hand.").regex(/^[A-Za-z0-9+/=\s]+$/);

// Whoever can add an expense can have its receipt read: the team, the crew adding their own from a
// visit included. A subcontractor can't add an expense (the database refuses theirs), so not them.
receipts.post("/receipts/read", requireUser, requireCompany(STAFF), async (c) => {
  const body = await readJson(c, z.object({ file: base64, job_id: uuid.nullish() }));
  if (!readingOn(await companySettings(c))) throw new HttpError(409, OFF);
  if (!(await allowReceiptRead(c.env, c.var.companyId, c.var.userId))) throw new HttpError(429, USED_UP);
  const reading = await readReceipt(c.env, { bytes: new Uint8Array(Buffer.from(body.file, "base64")) }, askerOf(c));
  return c.json(await answerFor(c, reading, body.job_id ?? null));
});

receipts.post("/receipts/drafts/:id/read", requireUser, requireCompany(OFFICE, "job_costs"), async (c) => {
  const id = param(c, "id");
  const { data: draft, error } = await c.var.db.from("expense_drafts").select("id, job_id, user_id, receipt_path").eq("id", id).eq("company_id", c.var.companyId).maybeSingle();
  if (error) throw dbError(error);
  if (!draft) throw new HttpError(404, "This draft is gone: someone may have saved or discarded it already.");
  const save = async (patch: { status: "read" | "failed" | "to_fill" | "waiting"; read?: unknown; error?: string | null }) => {
    const { data, error: saveError } = await c.var.db
      .from("expense_drafts")
      .update({ status: patch.status, read: patch.read === undefined ? null : asJson(patch.read), error: patch.error ?? null })
      .eq("id", id)
      .select("id, job_id, receipt_path, file_name, status, read, error, created_at")
      .maybeSingle();
    if (saveError) throw dbError(saveError);
    return data;
  };
  // Nothing was tried, so nothing failed: it waits to be filled in by hand.
  if (!readingOn(await companySettings(c))) return c.json({ draft: await save({ status: "to_fill" }) });
  // The hour's allowance is used up: it waits, and is read when the page asks again and there's room.
  if (!(await allowReceiptRead(c.env, c.var.companyId, c.var.userId))) return c.json({ draft: await save({ status: "waiting" }) });
  try {
    // As the person: the receipts folder is theirs to read only with job costs (as the expense's is).
    const file = await c.var.db.storage.from("files").download(draft.receipt_path);
    if (file.error || !file.data) throw new HttpError(404, "The file couldn't be opened. Fill it in by hand.");
    // Asked for by whoever dropped it in, when that's the person whose page is reading it now: a
    // draft someone else left waiting is read for the company, not on this person's own account.
    const reading = await readReceipt(c.env, { bytes: new Uint8Array(await file.data.arrayBuffer()) }, { companyId: c.var.companyId, userId: draft.user_id === c.var.userId ? c.var.userId : null });
    return c.json({ draft: await save({ status: "read", read: await answerFor(c, reading, draft.job_id) }) });
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return c.json({ draft: await save({ status: "failed", error: err.message.slice(0, 500) }) });
  }
});
