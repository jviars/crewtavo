/**
 * Careers (Apps → Crewtavo - Careers): the "Apply now" form on the business's own website posts to
 * /f/<key> the way a contact form does with Website Forms (websiteForms.ts), and each application
 * lands in Applicants (supabase/migrations/20261028000100_careers.sql). Fields are read the way a
 * contact form's are, for the name, email, phone and address, and then for what an employer asks:
 * the position, when they can start, their availability, pay, experience, driver's license and how
 * they heard about the job. Every other field comes along as an answer under its own name. Files are
 * taken too, when the form sends them (enctype="multipart/form-data"): a résumé, a cover letter.
 */
import { fieldLabel, fieldRole, readSubmission, spelling, type FieldValue, type Fields } from "./websiteForms";

export const APPLICANT_STATUSES = [
  { key: "new", label: "New" },
  { key: "reviewing", label: "Reviewing" },
  { key: "interview", label: "Interview" },
  { key: "offer", label: "Offer made" },
  { key: "hired", label: "Hired" },
  { key: "not_hired", label: "Not hired" },
] as const;
export type ApplicantStatus = (typeof APPLICANT_STATUSES)[number]["key"];
/** Still being decided: everything but Hired and Not hired. */
export const OPEN_STATUSES: readonly ApplicantStatus[] = ["new", "reviewing", "interview", "offer"];
export const applicantStatusLabel = (status: string) => APPLICANT_STATUSES.find((s) => s.key === status)?.label ?? status;

/** What an application's fields are read as, beyond who they are (job_applicants' columns). */
export type Detail = "position" | "location" | "start_date" | "availability" | "desired_pay" | "experience" | "drivers_license" | "heard_from" | "message";
export type Details = Partial<Record<Detail, string>>;

/** How each one is shown to the office, in this order. The message is shown on its own. */
export const DETAIL_LABELS: Record<Exclude<Detail, "message">, string> = {
  position: "Position",
  start_date: "Can start",
  availability: "Availability",
  desired_pay: "Desired pay",
  experience: "Experience",
  drivers_license: "Driver's license",
  location: "Lives in",
  heard_from: "Heard about the job from",
};

type JobRole = Exclude<Detail, "message"> | "cover_letter";

// Spellings as they're compared (websiteForms.ts's spelling(): "When can you start?" is whencanyoustart).
const SPELLINGS: Record<JobRole, string[]> = {
  position: ["position", "positions", "positionappliedfor", "positionapplyingfor", "appliedfor", "applyingfor", "job", "jobtitle", "jobposition", "jobappliedfor", "role", "opening", "desiredposition", "positiondesired", "whatposition", "whichposition", "positioninterestedin", "interestedin"],
  location: ["location", "yourlocation", "citystate", "cityandstate", "whereareyoulocated", "wheredoyoulive", "hometown"],
  start_date: ["startdate", "start", "availablestart", "availabledate", "dateavailable", "availablefrom", "availabletostart", "whencanyoustart", "earlieststartdate", "canstart", "desiredstartdate"],
  availability: ["availability", "available", "employmenttype", "jobtype", "hours", "hoursavailable", "schedule", "shift", "shifts", "daysavailable", "fulltimeorparttime", "fulltimeparttime", "worktype"],
  desired_pay: ["pay", "desiredpay", "expectedpay", "payrate", "wage", "desiredwage", "expectedwage", "hourlyrate", "rate", "salary", "desiredsalary", "expectedsalary", "salaryexpectations", "payexpectations", "compensation"],
  experience: ["experience", "yearsexperience", "yearsofexperience", "workexperience", "relevantexperience", "priorexperience", "previousexperience", "pastexperience", "workhistory", "employmenthistory"],
  drivers_license: ["driverslicense", "driverlicense", "driverslicence", "driverlicence", "license", "licence", "validdriverslicense", "validlicense", "cdl", "doyouhaveavaliddriverslicense"],
  heard_from: ["heardfrom", "howyouheard", "howdidyouhear", "howdidyouhearaboutus", "howdidyouhearaboutthisjob", "howdidyoufindus", "heardabout", "heardaboutus", "hearaboutus", "wheredidyouhear", "howheard", "referral", "referredby", "referralsource", "source"],
  cover_letter: ["coverletter", "aboutyou", "aboutyourself", "tellusaboutyourself", "whyyou", "whyshouldwehireyou", "whydoyouwanttoworkhere", "about", "bio", "summary", "additionalinfo", "additionalinformation", "anythingelse"],
};
const JOB_ROLE_OF = new Map<string, JobRole>(Object.entries(SPELLINGS).flatMap(([role, names]) => names.map((n) => [n, role as JobRole])));
const RESUME_FIELDS = new Set(["resume", "cv", "resumecv", "yourresume", "uploadresume", "resumeupload", "attachresume", "resumefile", "curriculumvitae"]);
const COVER_FIELDS = new Set(["coverletter", "coverletterfile", "uploadcoverletter"]);

const text = (value: FieldValue | undefined) => (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();

export interface Application {
  name: string | null;
  /** A whole address, as emailKey() spells it. */
  email: string | null;
  /** As typed, when it has enough digits to be a number. */
  phone: string | null;
  details: Details;
  /** The fields that aren't any of the above, under their own names. */
  answers: Fields;
  /** _subject: the email's subject. */
  subject: string | null;
  /** _next: where to go after sending, when it's a web address. */
  next: string | null;
  /** _gotcha filled in: a bot. Treated as sent, and nothing is kept. */
  bot: boolean;
  /** Every field people filled in, in the order the form sent them (for the email). */
  fields: Array<[string, FieldValue]>;
}

export type ApplicationResult = { ok: true; application: Application } | { ok: false; error: string };

/** Read an application from its fields (websiteForms.ts's cleanFields first). */
export function readApplication(fields: Array<[string, FieldValue]>): ApplicationResult {
  // What an employer asks first; the first field for each wins and a second is an answer.
  const job: Partial<Record<JobRole, string>> = {};
  const jobFields = new Set<string>();
  const rest: Array<[string, FieldValue]> = [];
  for (const [name, value] of fields) {
    const role = name.startsWith("_") ? undefined : JOB_ROLE_OF.get(spelling(name));
    if (role && job[role] === undefined) {
      job[role] = text(value).slice(0, 5000);
      jobFields.add(name);
    } else rest.push([name, value]);
  }
  const read = readSubmission(rest);
  if (!read.ok) return read;
  const s = read.submission;

  const answers: Fields = { ...s.answers };
  // A company field is where they work now, not a business of their own: it's an answer.
  for (const [name, value] of Object.entries(s.contact)) if (fieldRole(name) === "company") answers[name] = value;
  // Where they live: a location field, or the address they typed, or just the city and state.
  let location = job.location || [s.address.line1, s.address.line2, s.address.city, s.address.region, s.address.postal_code].filter(Boolean).join(", ");
  if (!location) {
    const parts = Object.keys(answers).filter((n) => ["city", "region", "postal_code"].includes(fieldRole(n) ?? ""));
    location = parts.map((n) => text(answers[n])).join(", ");
    for (const n of parts) delete answers[n];
  }
  // A cover letter is the message, unless there's a message too.
  let message = s.message;
  if (job.cover_letter) {
    if (!message) message = job.cover_letter;
    else answers[fields.find(([n]) => JOB_ROLE_OF.get(spelling(n)) === "cover_letter")![0]] = job.cover_letter;
  }

  const details: Details = {};
  for (const key of Object.keys(DETAIL_LABELS) as Array<keyof typeof DETAIL_LABELS>) {
    const value = key === "location" ? location : job[key];
    if (value) details[key] = value;
  }
  if (message) details.message = message;
  return {
    ok: true,
    application: {
      name: s.name, email: s.email, phone: s.phone, details, answers, subject: s.subject, next: s.next, bot: s.bot,
      // In the order the form sent them, the job's fields among the rest.
      fields: fields.filter(([n]) => jobFields.has(n) || s.fields.some(([kept]) => kept === n)),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** A résumé is a few hundred KB; a photo of a paper one, a few MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A résumé, a cover letter and one more (a license, a certificate). */
export const MAX_FILES = 3;

/** Documents and pictures of them, by extension, with the type they're stored as. */
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  txt: "text/plain",
  pages: "application/vnd.apple.pages",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
};
const EXTENSION_OF: Record<string, string> = Object.fromEntries(Object.entries(FILE_TYPES).filter(([ext]) => ext !== "jpeg").map(([ext, type]) => [type, ext]));
/** For the form's file field: accept="...". */
export const FILE_ACCEPT = Object.keys(FILE_TYPES).map((ext) => `.${ext}`).join(",");

/**
 * A file someone attached, as it's stored: its extension and type, from its name (browsers send Word
 * files as application/octet-stream) or else its type. Null for anything that isn't a document or a
 * picture of one.
 */
export function fileKind(name: string, type: string): { ext: string; type: string } | null {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1]?.toLowerCase();
  if (ext && FILE_TYPES[ext]) return { ext: ext === "jpeg" ? "jpg" : ext, type: FILE_TYPES[ext]! };
  const byType = EXTENSION_OF[type.toLowerCase()];
  return byType ? { ext: byType, type: FILE_TYPES[byType]! } : null;
}

/** A file's name as it's kept: no folders or odd characters, at most 120 characters, its extension kept. */
export function fileName(name: string, ext: string): string {
  const base = name.trim().split(/[\\/]/).pop()!.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\p{L}\p{N} ._()-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 110);
  return `${base || "file"}.${ext}`;
}

export interface ApplicantFile {
  /** <company>/applicants/<applicant>/<name>, in the files bucket. */
  path: string;
  name: string;
  type: string;
  size: number;
  /** The form field it came in, or "resume" for one the office added. */
  field: string;
}

/** What a file is, from the field it came in: a résumé, a cover letter, or the field's own name. */
export function fileLabel(field: string): string {
  const spelled = spelling(field);
  if (RESUME_FIELDS.has(spelled)) return "Résumé";
  if (COVER_FIELDS.has(spelled)) return "Cover letter";
  return fieldLabel(field);
}

/** Whether a file is the résumé: from a résumé field, or the first file when none came in one. */
export function isResume(file: Pick<ApplicantFile, "field">, files: ReadonlyArray<Pick<ApplicantFile, "field">>): boolean {
  const resumes = files.filter((f) => RESUME_FIELDS.has(spelling(f.field)));
  return resumes.length ? resumes[0] === file : files[0] === file && !COVER_FIELDS.has(spelling(file.field));
}

export const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);

// ---------------------------------------------------------------------------------------------
// The email, and a form to start from
// ---------------------------------------------------------------------------------------------

/** The email the people a careers form names get for each application (lib/email.ts renders it). */
export function applicationEmail(input: { formName: string; application: Application; files: Array<{ name: string; field: string; size: number }>; link: string }): { subject: string; text: string } {
  const { application: a, formName, files, link } = input;
  const who = a.name ?? a.email ?? a.phone ?? "someone";
  const short: string[] = [];
  const long: string[] = [];
  for (const [name, value] of a.fields) {
    const shown = Array.isArray(value) ? value.join(", ") : value;
    if (shown.includes("\n") || shown.length > 80) long.push(`${fieldLabel(name)}:\n${shown}`);
    else short.push(`${fieldLabel(name)}: ${shown}`);
  }
  const attached = files.map((f) => `${fileLabel(f.field)}: ${f.name} (${fileSize(f.size)})`);
  const first = (a.name ?? "").split(/\s+/)[0];
  return {
    subject: a.subject ?? `New application from ${who}${a.details.position ? ` for ${a.details.position}` : ""}`,
    text: [
      `New job application from your website's ${formName}.`,
      short.join("\n"),
      ...long,
      attached.length ? `${attached.join("\n")}\nOpen ${files.length === 1 ? "it" : "them"} in Crewtavo.` : null,
      link,
      a.email ? `Reply to this email to answer ${first || "them"}.` : null,
    ].filter(Boolean).join("\n\n"),
  };
}

/** An application form to start from: paste it into the website and it works, résumé and all. */
export function exampleApplicationForm(action: string): string {
  return [
    `<form action="${action}" method="POST" enctype="multipart/form-data">`,
    `  <label>Name <input type="text" name="name" autocomplete="name" required></label>`,
    `  <label>Email <input type="email" name="email" autocomplete="email" required></label>`,
    `  <label>Phone <input type="tel" name="phone" autocomplete="tel" required></label>`,
    `  <label>City and state <input type="text" name="location" autocomplete="address-level2"></label>`,
    `  <label>Position <input type="text" name="position" placeholder="Crew member"></label>`,
    `  <label>When can you start? <input type="text" name="start_date" placeholder="Two weeks from now"></label>`,
    `  <label>Availability`,
    `    <select name="availability">`,
    `      <option>Full-time</option>`,
    `      <option>Part-time</option>`,
    `      <option>Seasonal</option>`,
    `    </select>`,
    `  </label>`,
    `  <label>Years of experience <input type="text" name="experience"></label>`,
    `  <label>Valid driver's license?`,
    `    <select name="drivers_license">`,
    `      <option>Yes</option>`,
    `      <option>No</option>`,
    `    </select>`,
    `  </label>`,
    `  <label>Résumé <input type="file" name="resume" accept="${FILE_ACCEPT}"></label>`,
    `  <label>Tell us about yourself <textarea name="message" rows="5"></textarea></label>`,
    `  <label>How did you hear about the job? <input type="text" name="heard_from"></label>`,
    `  <!-- Keeps bots out. Leave it here, hidden. -->`,
    `  <input type="text" name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">`,
    `  <button type="submit">Apply</button>`,
    `</form>`,
  ].join("\n");
}
