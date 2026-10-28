/**
 * Applicants (Apps → Crewtavo - Careers): the people who applied through the business's careers form,
 * or that the office added, with their résumés (supabase/migrations/20261028000100_careers.sql).
 * Only owners, admins and office staff with the hiring area see them; the database holds to that.
 */
import { fileKind, fileName, MAX_FILE_BYTES, type ApplicantFile, type ApplicantStatus } from "@crewtavo/core/careers";
import type { Json } from "@crewtavo/core/database";
import type { QueryClient } from "@tanstack/react-query";
import type { Tone } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { can, hasRole, type Session } from "@/lib/session";
import type { WebVisit } from "../marketing/website";

export const APPLICANT_TONES: Record<ApplicantStatus, Tone> = { new: "warning", reviewing: "info", interview: "info", offer: "info", hired: "good", not_hired: "muted" };

/** Who sees applicants: owners, admins and office staff with the hiring area (job_applicants' policies). */
export const seesApplicants = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "hiring");

/** New for this long, and it shows as waiting: people who apply for a job hear back fast elsewhere. */
export const WAITING_DAYS = 3;
export const isWaiting = (a: { status: string; created_at: string }) => a.status === "new" && Date.now() - Date.parse(a.created_at) > WAITING_DAYS * 86_400_000;

export const APPLICANT_FIELDS =
  "id, status, name, email, phone, position, location, start_date, availability, desired_pay, experience, drivers_license, heard_from, message, answers, files, web_visit, rating, interview_at, notes, status_changed_at, created_at, created_by, website_form_id";

export interface Applicant {
  id: string;
  status: ApplicantStatus;
  name: string;
  email: string | null;
  phone: string | null;
  position: string | null;
  location: string | null;
  start_date: string | null;
  availability: string | null;
  desired_pay: string | null;
  experience: string | null;
  drivers_license: string | null;
  heard_from: string | null;
  message: string | null;
  answers: Record<string, string | string[]>;
  files: ApplicantFile[];
  web_visit: WebVisit | null;
  rating: number | null;
  interview_at: string | null;
  notes: string | null;
  status_changed_at: string;
  created_at: string;
  created_by: string | null;
  website_form_id: string | null;
}

/** Links to an applicant's files, good for an hour, with a second one that downloads under the file's own name. */
export async function fileLinks(files: ApplicantFile[]): Promise<Record<string, { open: string; save: string }>> {
  const urls = await signedUrls(files.map((f) => f.path));
  return Object.fromEntries(
    files.flatMap((f) => (urls[f.path] ? [[f.path, { open: urls[f.path]!, save: `${urls[f.path]}${urls[f.path]!.includes("?") ? "&" : "?"}download=${encodeURIComponent(f.name)}` }] as const] : [])),
  );
}

/** The other times this person applied: by their email, or else their phone number. */
export async function otherApplications(companyId: string, a: Pick<Applicant, "id" | "email" | "phone">) {
  if (!a.email && !a.phone) return [];
  let q = supabase().from("job_applicants").select("id, position, status, created_at").eq("company_id", companyId).neq("id", a.id).order("created_at", { ascending: false }).limit(10);
  q = a.email ? q.eq("email", a.email) : q.eq("phone", a.phone!);
  return unwrap(await q);
}

/** job_applicants.files as the database client takes it. */
export const filesJson = (files: ApplicantFile[]) => files as unknown as NonNullable<Json>;

export function refreshApplicants(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["applicants"] });
  queryClient.invalidateQueries({ queryKey: ["job_applicants"] });
}

/** Delete an applicant and their files: their files first, so none are left without anyone to see them. */
export async function deleteApplicant(a: Pick<Applicant, "id" | "files">) {
  if (a.files.length) {
    const { error } = await supabase().storage.from("files").remove(a.files.map((f) => f.path));
    if (error) throw new Error(`Couldn't delete their files: ${error.message}`);
  }
  unwrap(await supabase().from("job_applicants").delete().eq("id", a.id));
}

/** Store a file the office adds under the applicant, as an application's are, and describe it for job_applicants.files. */
export async function uploadApplicantFile(companyId: string, applicantId: string, file: File, field: string): Promise<ApplicantFile> {
  const kind = fileKind(file.name, file.type);
  if (!kind) throw new Error(`${file.name} can't be added. Choose a PDF, a Word document or a photo of it.`);
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is too large. Files can be up to 10 MB.`);
  const path = `${companyId}/applicants/${applicantId}/${crypto.randomUUID()}.${kind.ext}`;
  const { error } = await supabase().storage.from("files").upload(path, file, { contentType: kind.type, upsert: false });
  if (error) throw new Error(/row-level security/i.test(error.message) ? "You don't have permission to add files for applicants." : `Upload failed: ${error.message}`);
  return { path, name: fileName(file.name, kind.ext), type: kind.type, size: file.size, field };
}
