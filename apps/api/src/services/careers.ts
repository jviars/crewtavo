/**
 * Careers (Apps → Crewtavo - Careers): an application from the business's own "Apply now" form,
 * sent to a careers form's address (routes/websiteForms.ts). Its files are stored here, out of the
 * team's reach (<company>/applicants/<applicant>/..., supabase/migrations/20261028000100_careers.sql),
 * and the people the form names get an email that replies to the applicant. The résumé itself stays
 * in Crewtavo rather than going around by email: it carries their home address and work history.
 */
import { applicationEmail, fileKind, fileName, MAX_FILE_BYTES, MAX_FILES, type Application, type ApplicantFile } from "@crewtavo/core/careers";
import type { Env } from "../env";
import { renderEmail } from "../lib/email";
import { HttpError } from "../lib/http";
import { sendEmail } from "../lib/notify";
import { spendUploadBytes } from "../lib/publicUploads";
import type { Db } from "../lib/supabase";
import { logoImage } from "./logo";
import type { FormCompany } from "./websiteForms";

/** A file a form sent: what FormData holds for a file field. */
export interface SentFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export const isSentFile = (value: unknown): value is SentFile =>
  typeof value === "object" && value !== null && typeof (value as SentFile).arrayBuffer === "function" && typeof (value as SentFile).size === "number";

export interface CheckedFile {
  field: string;
  file: SentFile;
  name: string;
  ext: string;
  type: string;
}

/**
 * The files an application sent, checked before anything is kept: documents or pictures of them, up
 * to MAX_FILES of MAX_FILE_BYTES each. A file field left empty sends a nameless empty file: skipped.
 */
export function checkFiles(entries: Array<[string, unknown]>): CheckedFile[] {
  const sent = entries.filter((e): e is [string, SentFile] => isSentFile(e[1]) && e[1].size > 0);
  if (sent.length > MAX_FILES) throw new HttpError(413, `Attach up to ${MAX_FILES} files.`);
  return sent.map(([field, file]) => {
    const kind = fileKind(file.name, file.type);
    if (!kind) throw new HttpError(415, `${file.name || "That file"} can't be sent. Attach a PDF, a Word document or a photo of it.`);
    if (file.size > MAX_FILE_BYTES) throw new HttpError(413, `${file.name || "That file"} is too large. Each file can be up to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
    return { field: field.trim().slice(0, 100), file, name: fileName(file.name, kind.ext), ext: kind.ext, type: kind.type };
  });
}

/** What an application hears when the business has taken its day's worth of strangers' files. */
export const FILES_PAUSED = "This form has taken in a lot of files today, so it can't take more until tomorrow. Try again tomorrow, or email your application.";

/**
 * Whether the business can take these files today: they're counted against the visitor's and the
 * business's day of strangers' uploads (lib/publicUploads.ts) before any is stored, since what an
 * application sends is kept. An application without files always can.
 */
export async function roomForFiles(env: Env, companyId: string, visitor: string, files: CheckedFile[]): Promise<boolean> {
  const bytes = files.reduce((sum, f) => sum + f.file.size, 0);
  return bytes === 0 || spendUploadBytes(env, companyId, visitor, bytes);
}

/** Store an application's files under its applicant. Stored ones are removed again if one fails. */
export async function storeFiles(admin: Db, companyId: string, applicantId: string, files: CheckedFile[]): Promise<ApplicantFile[]> {
  const stored: ApplicantFile[] = [];
  try {
    for (const [i, f] of files.entries()) {
      // Numbered, not named: storage keys take only plain characters, and the name is kept beside it.
      const path = `${companyId}/applicants/${applicantId}/${i + 1}.${f.ext}`;
      const { error } = await admin.storage.from("files").upload(path, new Uint8Array(await f.file.arrayBuffer()), { contentType: f.type, upsert: false });
      if (error) throw new Error(`Couldn't store an applicant's file: ${error.message}`);
      stored.push({ path, name: f.name, type: f.type, size: f.file.size, field: f.field });
    }
    return stored;
  } catch (error) {
    await removeFiles(admin, stored);
    throw error;
  }
}

export async function removeFiles(admin: Db, files: Array<{ path: string }>): Promise<void> {
  if (!files.length) return;
  const { error } = await admin.storage.from("files").remove(files.map((f) => f.path));
  if (error) console.warn(`Couldn't remove an applicant's files: ${error.message}`);
}

/** Email each application to the people the form names, replying to the applicant. Sent one by one; a failure is logged. */
export async function emailApplication(
  env: Env,
  input: { base: string | null; company: FormCompany; form: { name: string; email_to: string[] }; application: Application; files: ApplicantFile[]; applicantId: string },
): Promise<void> {
  const { base, company, form, application } = input;
  // Without this Crewtavo's own address (base null), no link or logo: see emailMessage.
  const { subject, text } = applicationEmail({ formName: form.name, application, files: input.files, link: base ? `${base}/applicants/${input.applicantId}` : null });
  // What the applicant typed is in it: only the application's own link here is a button.
  const email = renderEmail({ companyName: company.name, logo: base ? logoImage(base, company.id, company.settings) : null, text, base });
  for (const to of form.email_to) {
    const result = await sendEmail(env, { to, subject, text: email.text, html: email.html, replyTo: application.email ?? undefined, fromName: company.name }, company.id);
    if (!result.sent) console.warn(`Careers email to ${to} wasn't sent: ${result.reason ?? "unknown reason"}`);
  }
}
