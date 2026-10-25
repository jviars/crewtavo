/**
 * How a sub's paperwork reads on screen: the chips on the Subs list and the sub's page, what
 * "needs attention" means, the insurance warning (it only ever warns), and the checks the public
 * upload page makes before a file goes up. No React or Supabase here, so it's tested on its own
 * (test/subs.test.ts).
 */
import {
  PAPERWORK_REQUIREMENTS,
  SUB_DOCUMENT_EXPIRES,
  subDocumentLabel,
  uninsured,
  type PaperworkRequirement,
  type PaperworkState,
  type SubDocumentKind,
} from "@crewtavo/core/subs";
import type { Tone } from "@/components/ui/StatusPill";
import { formatDate } from "@/lib/format";

/** One required piece of paperwork's status: a public.sub_paperwork row or a paperworkStatus() entry. */
export interface PaperworkRow {
  subcontractor_id?: string | null;
  requirement: string | null;
  state: string | null;
  document_id?: string | null;
  kind?: string | null;
  expires_on: string | null;
  days_left: number | null;
  verified: boolean | null;
  /** The sub sent one the office hasn't checked yet (public.sub_paperwork.waiting). */
  waiting?: boolean | null;
}

/** The chip for one requirement: "OK", "Expires in 12 days", "Expired", "Missing" or "Not verified yet". */
export function paperworkChip(s: Pick<PaperworkRow, "state" | "days_left" | "verified" | "waiting">): { label: string; tone: Tone } {
  if (s.state === "missing" || !s.state) return { label: "Missing", tone: "danger" };
  // Sent in by the sub: on file, but someone should look at it (and it may be the new one).
  if (s.waiting) return { label: "Not verified yet", tone: "info" };
  if (s.state === "expired") return { label: "Expired", tone: "danger" };
  if (s.verified === false) return { label: "Not verified yet", tone: "info" };
  if (s.state === "expiring") {
    const days = s.days_left ?? 0;
    return { label: days <= 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires in ${days} days`, tone: "warning" };
  }
  return { label: "OK", tone: "good" };
}

/** Anything expiring, expired, missing or not checked yet. */
export const needsAttention = (statuses: ReadonlyArray<Pick<PaperworkRow, "state" | "verified" | "waiting">>) =>
  statuses.some((s) => s.state !== "ok" || s.verified === false || Boolean(s.waiting));

/**
 * Each sub's three requirements, in the order they're shown (W-9, liability, workers' comp). A
 * requirement with no row counts as missing.
 */
export function paperworkBySub(rows: readonly PaperworkRow[]): Map<string, PaperworkRow[]> {
  const bySub = new Map<string, PaperworkRow[]>();
  for (const row of rows) {
    if (!row.subcontractor_id) continue;
    bySub.set(row.subcontractor_id, [...(bySub.get(row.subcontractor_id) ?? []), row]);
  }
  for (const [id, list] of bySub) bySub.set(id, inOrder(list));
  return bySub;
}

/** The three requirements in order, missing ones filled in. */
export function inOrder(rows: readonly PaperworkRow[]): PaperworkRow[] {
  return PAPERWORK_REQUIREMENTS.map(
    (req) => rows.find((r) => r.requirement === req.key) ?? { requirement: req.key, state: "missing", expires_on: null, days_left: null, verified: null, waiting: false },
  );
}

/**
 * The plain warning when a sub's insurance has run out or isn't on file. Never a stop: the office
 * can still give them work. Null when their insurance is fine.
 */
export function insuranceWarning(statuses: ReadonlyArray<Pick<PaperworkRow, "requirement" | "state" | "waiting">>): string | null {
  const gaps = uninsured(statuses.map((s) => ({ requirement: s.requirement as PaperworkRequirement, state: (s.state ?? "missing") as PaperworkState })));
  if (!gaps.length) return null;
  const expired = (key: PaperworkRequirement) => statuses.find((s) => s.requirement === key)?.state === "expired";
  const words = gaps.map((g) => `${g === "liability" ? "liability insurance" : "workers' comp"} ${expired(g) ? "has run out" : "isn't on file"}`);
  const sentence = words.join(" and ");
  const sent = gaps.some((g) => statuses.find((s) => s.requirement === g)?.waiting) ? " They've sent a new one: verify it below." : "";
  return `Their ${sentence}.${sent} You can still give them work, but without current certificates your insurance company may charge you for their work at your audit.`;
}

/** The document kinds that cover a requirement: workers' comp takes a certificate or an exemption. */
export const kindsFor = (requirement: string): SubDocumentKind[] =>
  [...(PAPERWORK_REQUIREMENTS.find((r) => r.key === requirement)?.kinds ?? [])] as SubDocumentKind[];

/** Insurance asks for the date it ends; a W-9 never ends, and other papers may. */
export const asksForEndDate = (kind: string) => SUB_DOCUMENT_EXPIRES[kind as SubDocumentKind] ?? false;
/** Certificates are what's tracked, so they need the date they end. An exemption, license or anything else may not have one. */
export const needsEndDate = (kind: string) => kind === "liability" || kind === "workers_comp";
/** Carrier and policy number go with insurance. */
export const isInsurance = (kind: string) => kind === "liability" || kind === "workers_comp" || kind === "wc_exemption";

/** "Liability insurance" for a document with no title of its own. */
export const documentTitle = (d: { kind: string; title: string | null }) => (d.kind === "other" || d.kind === "license" ? d.title || subDocumentLabel(d.kind) : subDocumentLabel(d.kind));

/** "Ends Nov 10, 2026", "Ended Oct 1, 2026", "No end date". */
export function endsText(expiresOn: string | null, today: string): string {
  if (!expiresOn) return "No end date";
  return `${expiresOn < today ? "Ended" : "Ends"} ${formatDate(expiresOn)}`;
}

// ---------------------------------------------------------------------------------------------
// The sub's upload page (/paperwork/:token)
// ---------------------------------------------------------------------------------------------

/** What the API takes (routes/subs.ts): PDFs and pictures, by extension. */
const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
};
/** The file picker's filter: PDFs and pictures, which on a phone also offers the camera. */
export const UPLOAD_ACCEPT = "application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp";
export const WRONG_TYPE = "Send a PDF or a photo (JPG, PNG or HEIC).";

const extensionOf = (name: string) => name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "";

/** "200 MB" */
export const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Why a picked file can't be sent, in words the sub understands, or null when it can. */
export function uploadProblem(file: { name: string; size: number; type?: string }, maxBytes: number): string | null {
  const type = FILE_TYPES[extensionOf(file.name)];
  if (!type) return WRONG_TYPE;
  // A phone may name a picture .jpg but say it's something else; the server checks the two agree.
  if (file.type && file.type !== type && !(type.startsWith("image/hei") && file.type.startsWith("image/hei")) && !(type === "image/jpeg" && file.type === "image/jpg")) return WRONG_TYPE;
  if (file.size <= 0) return "That file is empty. Pick it again, or take a new photo.";
  if (file.size > maxBytes) return `That file is bigger than ${megabytes(maxBytes)}. Send a smaller one, or a photo of the page.`;
  return null;
}

/**
 * The file as sent: some phones leave a HEIC photo's type blank, and Storage would then take it
 * as "unknown" and the server would turn it away. "image/jpg" is written the way Storage expects.
 */
export function withType(file: File): File {
  const type = FILE_TYPES[extensionOf(file.name)];
  if (!type || file.type === type || (file.type && file.type !== "image/jpg")) return file;
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

/** Why the end date won't do, or null: the server's own check (packages/core). On the sub's page `today` is theirs. */
export { endDateProblem } from "@crewtavo/core/subs";

/** "Hi Apex Roofing, Uniform Roofing needs these from you:" */
export const greeting = (sub: string, company: string) => `Hi ${sub}, ${company} needs these from you:`;

/** Under each item on the sub's page: why it's asked for. */
export function neededWhy(item: { state: string; expires_on: string | null }): string {
  if (item.state === "expired" && item.expires_on) return `The one we have ran out ${formatDate(item.expires_on)}.`;
  if (item.state === "expiring" && item.expires_on) return `The one we have ends ${formatDate(item.expires_on)}.`;
  return "We don't have one on file yet.";
}

// ---------------------------------------------------------------------------------------------
// The sub's own paperwork in the field app (/field/paperwork)
// ---------------------------------------------------------------------------------------------

/** Where one of the sub's required documents stands, in their words: what's needed, what's waiting, what's OK. */
export type MyPaperworkState = "needed" | "waiting" | "ok";

export interface MyPaperworkItem {
  requirement: string;
  label: string;
  state: MyPaperworkState;
  /** The chip: "Needed", "Expired", "Ends in 12 days", "Waiting to be checked", "OK". */
  status: string;
  tone: Tone;
  /** One line under it. */
  detail: string;
}

/**
 * The sub's three required documents (sub_paperwork, their own rows) as they read them. A newer one
 * they sent, waiting behind the checked one on file, is waiting: they've done their part, even if
 * the one on file ran out. Otherwise the one that counts says: missing, run out or ending within 30
 * days is needed (so the new one comes in before it lapses), even when it's the one they sent and
 * the office hasn't checked it yet (the reminder that links here says the same); one that's fine
 * but not checked yet is waiting.
 */
export function myPaperwork(rows: readonly PaperworkRow[]): MyPaperworkItem[] {
  return inOrder(rows).map((r) => {
    const requirement = r.requirement ?? "";
    const label = PAPERWORK_REQUIREMENTS.find((p) => p.key === requirement)?.label ?? requirement;
    const base = { requirement, label };
    const state = r.state ?? "missing";
    // The view's `waiting` counts the one on file too, when it's theirs and unchecked.
    const unchecked = r.verified === false ? " The office is still checking the one you sent." : "";
    if (state === "missing") return { ...base, state: "needed", status: "Needed", tone: "danger", detail: "We don't have one on file yet." };
    if (r.waiting && r.verified !== false) return { ...base, state: "waiting", status: "Waiting to be checked", tone: "info", detail: "You sent a new one. The office will check it." };
    if (state === "expired") return { ...base, state: "needed", status: "Expired", tone: "danger", detail: `${neededWhy({ state, expires_on: r.expires_on })} Send the new one.${unchecked}` };
    if (state === "expiring") {
      return { ...base, state: "needed", status: paperworkChip({ ...r, verified: true, waiting: false }).label.replace(/^Expires/, "Ends"), tone: "warning", detail: `${neededWhy({ state, expires_on: r.expires_on })} Send the new one when you get it.${unchecked}` };
    }
    if (r.verified === false) return { ...base, state: "waiting", status: "Waiting to be checked", tone: "info", detail: "On file. The office will check it." };
    return { ...base, state: "ok", status: "OK", tone: "good", detail: r.expires_on ? `Good until ${formatDate(r.expires_on)}.` : "On file." };
  });
}

/** The line at the top: "You're all set", "1 thing needed", "2 things needed". */
export function myPaperworkSummary(items: readonly Pick<MyPaperworkItem, "state">[]): string {
  const needed = items.filter((i) => i.state === "needed").length;
  if (!needed) return items.some((i) => i.state === "waiting") ? "Nothing needed. The office is checking what you sent." : "You're all set";
  return needed === 1 ? "1 thing needed" : `${needed} things needed`;
}

/**
 * Why a file the sub picked can't be sent, or null. Photos are shrunk before they go up (lib/files.ts),
 * so only the type is checked for them; anything else has to fit as it is.
 */
export function myUploadProblem(file: { name: string; size: number; type?: string }, maxBytes: number): string | null {
  const photo = Boolean(file.type?.startsWith("image/")) || /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name);
  return uploadProblem(file, photo ? Number.MAX_SAFE_INTEGER : maxBytes);
}
