/**
 * Storage limits in the app: how much room the company's photos and files take against its limit,
 * each person's against theirs, setting both, and what an upload refused for space says. The numbers
 * come from the database (storage_overview, supabase/migrations/20261028000400_storage_limits.sql);
 * Settings → Storage adds Railway's side (where files are kept, the plan, the price) from GET
 * /api/storage. Limits are set straight from the browser: the company's with storage_set_limit
 * (owners and admins with Settings), a person's or a role's with storage_set_allowance (owners).
 */
import { formatBytes, GB, STORAGE_WARN_AT, storageMonthlyCost, type StorageLimitMode } from "@crewtavo/core/storage";
import type { RailwayPlan, StorageBackend } from "@crewtavo/core/hosting";
import type { Role } from "@crewtavo/core/roles";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, supabase, unwrap } from "@/lib/api";
import { isStorageFull, type ApiError } from "@/lib/errors";
import { isAbort } from "@/lib/resumable";
import { can, hasRole, isSub, useSession, type Session } from "@/lib/session";
import { toast } from "@/lib/toast";

/** Where a person's limit comes from: their own, their role's, or none. */
export type LimitSource = "person" | "role" | null;

/** One person's files that are still in use (the Trash doesn't count toward a person's limit). */
export interface StoragePerson {
  /** Null for files no one in particular added (from a public form or a one-time link): "Uploaded by Crewtavo". */
  user_id: string | null;
  name: string;
  /** Null for someone no longer on the team who still has files here. */
  role: Role | null;
  role_name: string | null;
  used_bytes: number;
  limit_bytes: number | null;
  limit_source: LimitSource;
}

/** storage_overview(): the company's total, and for owners and admins, who and what it's made of. */
export interface StorageOverview {
  /** Everything stored, the Trash included. */
  used_bytes: number;
  /** What's in the Trash, until it's deleted for good. */
  trash_bytes: number;
  files: number;
  /** The limit in force, whatever set it (null: no limit). */
  limit_bytes: number | null;
  limit_mode: StorageLimitMode;
  default_bytes: number | null;
  /** "90% of your 50 GB volume", "Railway Hobby bucket". */
  default_basis: string | null;
  /** The person asking. */
  me: { used_bytes: number; limit_bytes: number | null; limit_source: LimitSource };
  /** Owners and admins only, from here down. */
  by_person?: StoragePerson[];
  by_area?: Array<{ area: string; bytes: number }>;
  /** Limits set for everyone with a role: a base level ("crew_lead") or a custom role's id. */
  roles?: Array<{ role_key: string; name: string; limit_bytes: number }>;
}

/** Where Railway keeps the files, and what that costs, for the cost of a limit. */
export interface StorageRailway {
  backend: StorageBackend | null;
  plan: RailwayPlan | null;
  /** The storage service's volume, when files are on it. */
  volumeBytes: number | null;
  /** Null when where files are stored isn't known yet. */
  pricePerGbMonth: number | null;
}

/** GET /api/storage: the overview, plus Railway's side (null when this Crewtavo isn't on Railway or can't read it). */
export interface StorageReport extends StorageOverview {
  railway: StorageRailway | null;
}

export const STORAGE_KEY = ["storage"];
/** Settings → Storage. */
export const STORAGE_SETTINGS = "/settings?tab=storage";

/** Owners and admins with Settings see Settings → Storage and set the company's limit. */
export const managesStorage = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin") && can(session, "settings");
/** Only owners give a person, or a role, a limit of their own. */
export const setsAllowances = (session: Pick<Session, "role">) => session.role === "owner";

/** The whole team, never a sub. */
const onTeam = (session: Pick<Session, "role">) => !isSub(session);

/**
 * The company's storage as the database counts it, for anyone on the team (owners and admins get who
 * and what too). Light: it never asks Railway, so Drive can show it on every visit.
 */
export function useStorageOverview(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: [...STORAGE_KEY, session.company.id, "overview"],
    enabled: enabled && onTeam(session),
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("storage_overview", { p_company: session.company.id })) as unknown as StorageOverview,
  });
}

/** Settings → Storage: the overview with Railway's side, and the default limit read from Railway again. */
export function useStorageReport() {
  const session = useSession();
  return useQuery({
    queryKey: [...STORAGE_KEY, session.company.id, "report"],
    queryFn: () => api.get<StorageReport>("/storage"),
  });
}

/** After an upload, a move to the Trash, or a limit changed: every count of storage again. */
export const refreshStorage = (queryClient: QueryClient) => queryClient.invalidateQueries({ queryKey: STORAGE_KEY });

/** The company's limit: Railway's default, none, or `bytes`. */
export async function setStorageLimit(companyId: string, mode: StorageLimitMode, bytes: number | null = null) {
  unwrap(await supabase().rpc("storage_set_limit", { p_company: companyId, p_mode: mode, p_limit_bytes: mode === "custom" ? bytes ?? undefined : undefined }));
}

/** Whose limit: one person, or everyone with a role (a base level or a custom role's id). */
export type AllowanceTarget = { user: string } | { role: string };

/** A person's or a role's own limit, or none (null). Owners only; owners themselves are never limited. */
export async function setAllowance(companyId: string, target: AllowanceTarget, bytes: number | null) {
  // Exactly one of the person and the role; a limit of null takes it away.
  const args = { p_company: companyId, p_user: "user" in target ? target.user : null, p_role: "role" in target ? target.role : null, p_limit_bytes: bytes };
  unwrap(await supabase().rpc("storage_set_allowance", args as unknown as { p_company: string; p_user: string; p_role: string; p_limit_bytes: number }));
}

// ---------------------------------------------------------------------------------------------
// Words and numbers
// ---------------------------------------------------------------------------------------------

/** What each folder holds, as people know it. */
const AREAS: Record<string, string> = {
  plans: "Drive and plan files",
  visit: "Visit photos",
  quote: "Quote photos",
  subs: "Sub paperwork",
  receipts: "Receipts",
  applicants: "Résumés",
  kb: "Guide covers",
  equipment: "Equipment photos",
  tickets: "Ticket photos",
  chat: "Chat",
  measurements: "Measure pictures",
  avatars: "Profile photos",
  logo: "Your logo",
  letterhead: "Letterheads",
  packages: "Package pictures",
  services: "Price list pictures",
  trash: "The Trash",
  other: "Other files",
};

/** A folder's name for people: "Visit photos"; one Crewtavo doesn't know by its own name. */
export function areaLabel(area: string): string {
  const known = AREAS[area];
  if (known) return known;
  const words = area.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other files";
}

/** How full a limit is, 0 and up (over 1 past it); null with no limit. */
export const shareOf = (used: number, limit: number | null) => (limit && limit > 0 ? used / limit : null);

/** Past the warnings owners and admins get by email (STORAGE_WARN_AT): fine, nearly full, or full. */
export function fullness(share: number | null): "ok" | "warning" | "danger" | "full" {
  if (share === null || share < STORAGE_WARN_AT[0]) return "ok";
  if (share >= 1) return "full";
  return share >= STORAGE_WARN_AT[1] ? "danger" : "warning";
}

/** "12.4 GB of 45 GB used", or "12.4 GB used" with no limit. */
export function companyLine(o: Pick<StorageOverview, "used_bytes" | "limit_bytes">): string {
  return o.limit_bytes ? `${formatBytes(o.used_bytes)} of ${formatBytes(o.limit_bytes)} used` : `${formatBytes(o.used_bytes)} used`;
}

/** "You've used 3.1 GB of your 10 GB", for someone with a limit of their own (or their role's). */
export function personalLine(me: StorageOverview["me"]): string | null {
  if (!me.limit_bytes) return null;
  if (me.used_bytes >= me.limit_bytes) return `You've used all of your ${formatBytes(me.limit_bytes)}`;
  return `You've used ${formatBytes(me.used_bytes)} of your ${formatBytes(me.limit_bytes)}`;
}

/** A limit in GB for a field: "45", "2.5". */
export const gbField = (bytes: number | null | undefined) => (bytes ? String(Math.round((bytes / GB) * 100) / 100) : "");

/** The most a limit can be: 10 PB, far past anything Railway holds. */
const MOST_GB = 10_000_000;

/** What's typed in a GB field as bytes; a sentence when it isn't a size. */
export function parseGb(text: string): { bytes: number } | { problem: string } {
  const clean = text.replace(/[\s,]/g, "").replace(/gb$/i, "");
  if (!clean) return { problem: "Enter a size in GB." };
  const gb = Number(clean);
  if (!Number.isFinite(gb) || gb <= 0) return { problem: "Enter a size in GB, more than 0." };
  if (gb > MOST_GB) return { problem: "That's more than any storage holds. Enter a smaller size." };
  return { bytes: Math.max(1, Math.round(gb * GB)) };
}

/** Railway bills in US dollars. */
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** A per-GB price: "$0.015". */
export const pricePerGb = (price: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 3 }).format(price);

/** "about $0.68 a month", "under a cent a month". */
export function monthly(bytes: number, pricePerGbMonth: number): string {
  const cost = storageMonthlyCost(bytes, pricePerGbMonth);
  return cost >= 0.01 ? `about ${dollars.format(cost)} a month` : "under a cent a month";
}

/** What a person's limit says in a list: "10 GB" and where it's from, or none. */
export function limitText(p: Pick<StoragePerson, "role" | "limit_bytes" | "limit_source" | "user_id">): { size: string; source: string | null } {
  if (p.role === "owner") return { size: "Not limited", source: "Owners never are" };
  if (!p.user_id) return { size: "—", source: null };
  if (!p.role) return { size: "—", source: "No longer on the team" };
  if (!p.limit_bytes) return { size: "No limit", source: null };
  return { size: formatBytes(p.limit_bytes), source: p.limit_source === "role" ? "From their role" : "Their own" };
}

/** Someone an owner can give a limit of their own: on the team now, and not an owner or a sub (whose uploads are never refused). */
export const limitable = (p: Pick<StoragePerson, "user_id" | "role">) => Boolean(p.user_id && p.role && p.role !== "owner" && p.role !== "subcontractor");

// ---------------------------------------------------------------------------------------------
// An upload refused for space
// ---------------------------------------------------------------------------------------------

/**
 * Says an upload was refused for space (true), in the server's own sentence, and offers owners and
 * admins with Settings the way to Settings → Storage; false for any other error, so the caller says
 * it its own way. `title` names what wasn't added ("Site plan.pdf wasn't added"), with the reason
 * under it.
 */
export function reportStorageFull(error: unknown, options: { title?: string; manages: boolean; open: () => void }): boolean {
  if (!isStorageFull(error)) return false;
  const reason = error.message;
  toast.error(options.title ?? reason, {
    description: options.title ? reason : undefined,
    action: options.manages ? { label: "Open storage settings", onClick: options.open } : undefined,
    duration: 12_000,
  });
  return true;
}

/**
 * The files refused for space, by name: "Site plan.pdf wasn't added", "Site plan.pdf and Bid.docx
 * weren't added", "Site plan.pdf, Bid.docx and 2 more files weren't copied".
 */
export function notAdded(names: string[], done: "added" | "copied" = "added"): string {
  const [first = "A file", second, third] = names;
  if (names.length <= 1) return `${first} wasn't ${done}`;
  if (names.length === 2) return `${first} and ${second} weren't ${done}`;
  if (names.length === 3) return `${first}, ${second} and ${third} weren't ${done}`;
  return `${first}, ${second} and ${names.length - 2} more files weren't ${done}`;
}

/**
 * The files in one batch that were refused for space, said once at the end. Storage checks each
 * upload on its own against the room that's left, so one refused doesn't stop the rest: a smaller
 * one may still fit. A file at least as big as one already refused would be refused too, so it's
 * counted here without being sent.
 */
export class RefusedForSpace {
  /** The first refusal. Its sentence, which gives that file's size, is the one shown. */
  first: ApiError | null = null;
  readonly names: string[] = [];
  private smallest = Infinity;

  /** Notes a file refused for space (true). False for any other error, which the screen reports its own way. */
  add(error: unknown, name: string, size: number | null = null): boolean {
    if (!isStorageFull(error)) return false;
    this.first ??= error;
    this.names.push(name);
    if (size !== null) this.smallest = Math.min(this.smallest, size);
    return true;
  }

  /** True when a file this big would be refused too (it's noted, so don't send it). */
  skips(name: string, size: number): boolean {
    if (size < this.smallest) return false;
    this.names.push(name);
    return true;
  }

  /** The toast's title ("Site plan.pdf and Bid.docx weren't added"), over the first refusal's sentence. */
  title(done: "added" | "copied" = "added"): string {
    return notAdded(this.names, done);
  }
}

/**
 * Adds a batch of files one at a time with `add`, which throws when a file isn't added. A refusal
 * for space doesn't stop the rest (see RefusedForSpace): those files come back in `refused`, for one
 * toast at the end. `failed` hears about every other file that wasn't added. A file stopped with
 * Stop is neither.
 */
export async function addEach(list: File[], add: (file: File) => Promise<void>, failed: (file: File, error: unknown) => void) {
  let added = 0;
  const refused = new RefusedForSpace();
  for (const file of list) {
    if (refused.skips(file.name, file.size)) continue;
    try {
      await add(file);
      added++;
    } catch (error) {
      if (isAbort(error)) continue;
      if (!refused.add(error, file.name, file.size)) failed(file, error);
    }
  }
  return { added, refused };
}

/** reportStorageFull for a screen: true when it was refused for space (and said so). */
export function useStorageFull() {
  const session = useSession();
  const navigate = useNavigate();
  const manages = managesStorage(session);
  return (error: unknown, title?: string) => reportStorageFull(error, { title, manages, open: () => navigate(STORAGE_SETTINGS) });
}
