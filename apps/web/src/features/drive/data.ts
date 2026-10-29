/**
 * Crewtavo - Drive's data: the company's folders (public.drive_folders), the files the Files page lists
 * (public.drive_list, drive_clients and drive_versions, read as the signed-in person so row security
 * applies), the Trash (public.drive_trash), and the small rules the page follows. Drive's files are plan
 * files (public.plan_files); supabase/migrations/20261028000300_drive.sql explains the rules.
 */
import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { featureOn } from "@/components/shell/nav";
import type { IconName } from "@/components/ui/Icon";
import type { ViewerFile } from "@/features/files/FileViewer";
import { fileKind, fileSize, isImage, isPdf, type PlanFile } from "@/features/plans/plans";
import { supabase, unwrap } from "@/lib/api";
import { ApiError, friendlyDbError } from "@/lib/errors";
import { formatDate } from "@/lib/format";
import { can, hasRole, type Session } from "@/lib/session";

/** A current, live file as Drive lists it (public.drive_list), with where it is. */
export interface DriveFile {
  id: string;
  title: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  path: string;
  revision: string | null;
  notes: string | null;
  crew_visible: boolean;
  archived: boolean;
  replaces_id: string | null;
  /** How many versions it has, this one included. */
  versions: number;
  folder_id: string | null;
  folder_name: string | null;
  property_id: string | null;
  property_label: string | null;
  client_id: string | null;
  client_name: string | null;
  request_id: string | null;
  request_title: string | null;
  quote_id: string | null;
  quote_number: number | null;
  quote_title: string | null;
  job_id: string | null;
  job_number: number | null;
  job_title: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DriveFolder {
  id: string;
  /** Null only for the company's top folder, "Company files". */
  parent_id: string | null;
  name: string;
  created_at: string;
  updated_at: string;
}
export const FOLDER_FIELDS = "id, parent_id, name, created_at, updated_at";

/** A client with files, for the Clients list (public.drive_clients). */
export interface DriveClient {
  client_id: string;
  client_name: string;
  files: number;
  updated_at: string;
}

export type TrashKind = "file" | "version" | "folder" | "other";

/**
 * What this person can do with something in the Trash, as public.drive_trash works it out for them:
 * put it back where it was ("back"), have it copied into Company files because where it was is gone
 * ("drive": the office, and never a sub's paperwork, an applicant's files or a receipt), download it
 * ("download": restricted papers whose record is gone, or a crew member's file that would need a copy
 * in Drive), or nothing ("none").
 */
export type TrashRestore = "back" | "drive" | "download" | "none";

/** Something in the Trash (public.drive_trash): a file with its versions, one version, a folder, or a file from elsewhere in Crewtavo. */
export interface TrashItem {
  kind: TrashKind;
  id: string;
  name: string;
  /** Where it was: "Job #12 · 14 Oak St", "Company files › Forms", "Visit photo · Job #12". */
  detail: string | null;
  content_type: string | null;
  size_bytes: number | null;
  path: string | null;
  versions: number | null;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
  purge_at: string;
  restore: TrashRestore;
}

/** Where a new file goes: a folder, or a client's property, request, quote or job (exactly one). */
export type Target = { folder_id: string } | { property_id: string } | { request_id: string } | { quote_id: string } | { job_id: string };

/** Who has Drive: the office (owners, admins, office staff and estimators), like the files on a quote. */
export const seesDrive = (session: Pick<Session, "role">) => hasRole(session, "admin", "office", "estimator");

export type DriveView = "company" | "clients" | "recent" | "search";
const VIEWS: DriveView[] = ["company", "clients", "recent", "search"];

/** Which list the page shows, from ?view= (Company files when there's none). */
export const driveView = (params: URLSearchParams): DriveView => VIEWS.find((v) => v === params.get("view")) ?? "company";

/** Every change to a file shows on Drive, on the Plans and files cards, on a crew's visit, and in how much storage is used. */
export function refreshFiles(queryClient: QueryClient) {
  for (const key of ["drive", "plans", "field-visit", "storage"]) queryClient.invalidateQueries({ queryKey: [key] });
}

// ---------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------

const collator = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });
/** "Folder 2" before "Folder 10", whatever the case. */
export const byName = (a: { name: string }, b: { name: string }) => collator.compare(a.name, b.name);

export interface FolderTree {
  /** "Company files". Null until it's loaded (or for a company whose Drive was never installed). */
  root: DriveFolder | null;
  byId: Map<string, DriveFolder>;
  /** Each folder's folders, by name. */
  children: Map<string, DriveFolder[]>;
}

export function folderTree(folders: DriveFolder[]): FolderTree {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const children = new Map<string, DriveFolder[]>();
  let root: DriveFolder | null = null;
  for (const f of folders) {
    if (!f.parent_id) {
      root ??= f;
      continue;
    }
    const list = children.get(f.parent_id);
    if (list) list.push(f);
    else children.set(f.parent_id, [f]);
  }
  for (const list of children.values()) list.sort(byName);
  return { root, byId, children };
}

/** From "Company files" down to this folder, for the breadcrumbs. Empty for a folder that isn't there. */
export function folderPath(tree: FolderTree, id: string | null): DriveFolder[] {
  const path: DriveFolder[] = [];
  const seen = new Set<string>();
  for (let f = id ? tree.byId.get(id) : (tree.root ?? undefined); f && !seen.has(f.id); f = f.parent_id ? tree.byId.get(f.parent_id) : undefined) {
    path.unshift(f);
    seen.add(f.id);
  }
  return path;
}

/** Every folder inside this one, however deep (not the folder itself). */
export function folderDescendants(tree: FolderTree, id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length) {
    for (const child of tree.children.get(queue.shift()!) ?? []) {
      if (found.has(child.id) || child.id === id) continue;
      found.add(child.id);
      queue.push(child.id);
    }
  }
  return found;
}

/** The whole tree in reading order, each folder with how deep it is ("Company files" is 0). */
export function flatTree(tree: FolderTree): Array<{ folder: DriveFolder; depth: number }> {
  const out: Array<{ folder: DriveFolder; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (folder: DriveFolder, depth: number) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    out.push({ folder, depth });
    for (const child of tree.children.get(folder.id) ?? []) walk(child, depth + 1);
  };
  if (tree.root) walk(tree.root, 0);
  return out;
}

/** What's wrong with a folder's name, in the words the database would use, or null when it's fine. */
export function folderNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give the folder a name.";
  if (n.length > 120) return "Keep the name to 120 characters or fewer.";
  if (/[/\\]/.test(n)) return "A folder's name can't have / or \\ in it.";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export const isDoc = (f: Pick<DriveFile, "content_type" | "file_name">) => /wordprocessingml|msword|opendocument\.text|rtf/.test(f.content_type ?? "") || /\.(docx?|odt|rtf)$/i.test(f.file_name);
export const isSheet = (f: Pick<DriveFile, "content_type" | "file_name">) =>
  /spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv/.test(f.content_type ?? "") || /\.(xlsx?|csv|ods|numbers)$/i.test(f.file_name);

export type FileIconKind = "pdf" | "image" | "doc" | "sheet" | "file";
export function iconKind(f: Pick<DriveFile, "content_type" | "file_name">): FileIconKind {
  if (isPdf(f)) return "pdf";
  if (isImage(f)) return "image";
  if (isDoc(f)) return "doc";
  if (isSheet(f)) return "sheet";
  return "file";
}
export const ICON_FOR: Record<FileIconKind, IconName> = { pdf: "quote", image: "fileImage", doc: "quote", sheet: "fileSpreadsheet", file: "file" };

/** "Version 3 · Rev B · 12 MB · PDF · updated Oct 19, 2026 · by Dana Ruiz". */
export function fileMeta(f: Pick<DriveFile, "versions" | "revision" | "size_bytes" | "content_type" | "file_name" | "created_at" | "created_by_name">): string {
  const when = f.versions > 1 ? `updated ${formatDate(f.created_at)}` : formatDate(f.created_at);
  return [f.versions > 1 && `Version ${f.versions}`, f.revision?.trim(), fileSize(f.size_bytes), fileKind(f), when, f.created_by_name && `by ${f.created_by_name}`].filter(Boolean).join(" · ");
}

export type Slot = "job_id" | "quote_id" | "request_id" | "property_id";
export const SLOTS: Slot[] = ["job_id", "quote_id", "request_id", "property_id"];

/** One of the records a file is on, for its chips and "Remove from…". */
export interface Place {
  slot: Slot;
  id: string;
  label: string;
  /** The record's page (a property's is its client's), when there's one to open. */
  path: string | null;
}

const recordLabel = (noun: string, number: number | null, title: string | null) => [number ? `${noun} #${number}` : noun, title?.trim()].filter(Boolean).join(" · ");

/** Where a file is: its job, quote, request and property, in that order. */
export function placesOf(f: DriveFile): Place[] {
  const out: Place[] = [];
  if (f.job_id) out.push({ slot: "job_id", id: f.job_id, label: recordLabel("Job", f.job_number, f.job_title), path: `/jobs/${f.job_id}` });
  if (f.quote_id) out.push({ slot: "quote_id", id: f.quote_id, label: recordLabel("Quote", f.quote_number, f.quote_title), path: `/quotes/${f.quote_id}` });
  if (f.request_id) out.push({ slot: "request_id", id: f.request_id, label: recordLabel("Request", null, f.request_title), path: `/requests/${f.request_id}` });
  if (f.property_id) {
    const label = [f.client_name, f.property_label].filter(Boolean).join(" · ") || "A property";
    out.push({ slot: "property_id", id: f.property_id, label, path: f.client_id ? `/clients/${f.client_id}` : null });
  }
  return out;
}

type Placement = Partial<Record<Slot | "folder_id", string | null>>;

/**
 * Taking a file off one record. With nothing else holding it, it goes into Company files in the same
 * change: a file on nothing at all is moved to the Trash by the database.
 */
export function detachPatch(row: Pick<DriveFile, Slot | "folder_id">, slot: Slot, rootId: string): Placement {
  const patch: Placement = { [slot]: null };
  if (!row.folder_id && !SLOTS.some((s) => s !== slot && row[s])) patch.folder_id = rootId;
  return patch;
}

/** A record to attach a file to, as Attach to… found it. */
export interface AttachPick {
  slot: Slot;
  id: string;
  /** The record's client, when it has one. */
  clientId: string | null;
  /** The property the record is at (a property's own id), when it has one. */
  propertyId: string | null;
  label: string;
}

/**
 * Attaching a file to a record (the database tells the crew on a job). The file is at the property
 * the record is at, so a file moved to a job at the client's other property moves there too; a
 * record at no property leaves the file's property as it was. A file moving to another client leaves
 * the first client's records behind; its folder stays either way.
 */
export function attachPatch(row: Pick<DriveFile, "client_id">, pick: AttachPick): Placement {
  const otherClient = Boolean(row.client_id && pick.clientId && row.client_id !== pick.clientId);
  const patch: Placement = otherClient ? { job_id: null, quote_id: null, request_id: null, property_id: null } : {};
  patch[pick.slot] = pick.id;
  if (pick.propertyId) patch.property_id = pick.propertyId;
  return patch;
}

/**
 * The places a change takes a file off. A file is on one job, one quote and one request, at one
 * property: attaching it to a second job takes it off the first, a record at another property moves
 * it there, and another client's record leaves every one of the first client's behind.
 */
export function attachLeaves(places: Place[], patch: Placement): Place[] {
  return places.filter((p) => p.slot in patch && patch[p.slot] !== p.id);
}

/** A place in a few words, for a sentence: "Job #12", "Quote #5", "the request “Gate code”", "14 Oak St". */
export function placeName(f: Pick<DriveFile, "job_number" | "quote_number" | "request_title" | "property_label">, p: Place): string {
  if (p.slot === "job_id") return f.job_number ? `Job #${f.job_number}` : p.label;
  if (p.slot === "quote_id") return f.quote_number ? `Quote #${f.quote_number}` : p.label;
  if (p.slot === "request_id") return f.request_title?.trim() ? `the request “${f.request_title.trim()}”` : "its request";
  return f.property_label?.trim() || "its property";
}

/** "Job #12", "Job #12 and 14 Oak St", "Job #12, Quote #5 and 14 Oak St". */
export function andList(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Changes where a file is (its folder or records). Only its current version is changed here: the
 * database puts every other version of it in the same place (plan_files_carry), so an older version
 * that comes back later is where the file was, and the property it fills in from a job, quote or
 * request reaches them all. `current` is the current version's own (who sees it).
 */
export async function placeFile(fileId: string, patchFor: (row: Pick<DriveFile, Slot | "folder_id">) => Placement, current: { crew_visible?: boolean } = {}) {
  const rows = await fileVersions(fileId);
  const now = rows.find((r) => r.id === fileId) ?? rows[0];
  if (!now) throw new Error("That file isn't here anymore. It may be in the Trash.");
  unwrap(await supabase().from("plan_files").update({ ...patchFor(now), ...current }).eq("id", now.id).select("id").single());
}

/** A client's files, by property, then by the job, quote or request each is on. */
export interface PropertyGroup {
  key: string;
  propertyId: string | null;
  label: string;
  places: Array<{ key: string; label: string; path: string | null; files: DriveFile[] }>;
}

const PLACE_ORDER: Record<string, number> = { job: 0, quote: 1, request: 2, property: 3 };

export function groupClientFiles(files: DriveFile[]): PropertyGroup[] {
  const groups = new Map<string, PropertyGroup>();
  for (const f of files) {
    const key = f.property_id ?? "none";
    let group = groups.get(key);
    if (!group) {
      group = { key, propertyId: f.property_id, label: f.property_id ? (f.property_label?.trim() || "A property") : "Not at a property", places: [] };
      groups.set(key, group);
    }
    const place = f.job_id
      ? { key: `job:${f.job_id}`, label: recordLabel("Job", f.job_number, f.job_title), path: `/jobs/${f.job_id}` }
      : f.quote_id
        ? { key: `quote:${f.quote_id}`, label: recordLabel("Quote", f.quote_number, f.quote_title), path: `/quotes/${f.quote_id}` }
        : f.request_id
          ? { key: `request:${f.request_id}`, label: recordLabel("Request", null, f.request_title), path: `/requests/${f.request_id}` }
          : { key: "property", label: "At the property", path: null };
    const existing = group.places.find((p) => p.key === place.key);
    if (existing) existing.files.push(f);
    else group.places.push({ ...place, files: [f] });
  }
  const number = (f: DriveFile) => f.job_number ?? f.quote_number ?? 0;
  for (const group of groups.values()) {
    group.places.sort((a, b) => PLACE_ORDER[a.key.split(":")[0]] - PLACE_ORDER[b.key.split(":")[0]] || number(b.files[0]) - number(a.files[0]) || collator.compare(a.label, b.label));
  }
  return [...groups.values()].sort((a, b) => Number(!a.propertyId) - Number(!b.propertyId) || collator.compare(a.label, b.label));
}

/** What the viewer needs from a listed file (only current versions are listed). */
export const viewerFile = (companyId: string, f: DriveFile): ViewerFile => ({
  id: f.id,
  company_id: companyId,
  path: f.path,
  title: f.title,
  file_name: f.file_name,
  content_type: f.content_type,
  size_bytes: f.size_bytes,
  revision: f.revision,
  crew_visible: f.crew_visible,
  archived: f.archived,
  replaces_id: f.replaces_id,
  superseded_at: null,
  created_at: f.created_at,
});
export const VIEWER_FIELDS = "id, company_id, path, title, file_name, content_type, size_bytes, revision, crew_visible, archived, replaces_id, superseded_at, created_at";

/** A version just saved in the viewer, as the viewer opens it (the same fields as VIEWER_FIELDS). */
export const savedViewerFile = (companyId: string, f: PlanFile): ViewerFile => ({
  id: f.id,
  company_id: f.company_id ?? companyId,
  path: f.path,
  title: f.title,
  file_name: f.file_name,
  content_type: f.content_type,
  size_bytes: f.size_bytes,
  revision: f.revision,
  crew_visible: f.crew_visible,
  archived: f.archived ?? false,
  replaces_id: f.replaces_id,
  superseded_at: f.superseded_at ?? null,
  created_at: f.created_at,
});

/** Whether the viewer may offer Edit: the current version of a file that isn't archived (as on a job's Plans and files card). */
export const editableInDrive = (f: Pick<ViewerFile, "superseded_at" | "archived">) => !f.superseded_at && !f.archived;

/**
 * The database turning a new version down ("A newer version of Site plan was already added. Refresh
 * and try again.", "… is in the Trash"), in its own words rather than as "That already exists."
 */
export function versionRefused(error: { message: string; code?: string; details?: string | null; hint?: string | null }): Error {
  if (/newer version|in the Trash/i.test(error.message ?? "")) return new ApiError(error.message, 409, error.code);
  return friendlyDbError(error);
}

/**
 * Where a restored file is when that's Company files (a folder that came back, a file whose place is
 * gone, a copy under Restored files), said plainly: only Drive shows Company files, and Drive may not
 * be installed. `copied`: it's a copy, because where it was is gone.
 */
export function companyFilesNote(session: Pick<Session, "role" | "permissions" | "company">, copied: boolean): string {
  // Drive is the office's: a crew member can't open it either way.
  if (!seesDrive(session)) return copied ? "Where it was is gone, so the office has it in Drive, under Restored files." : "The office has it in Drive, in Company files.";
  if (featureOn(session.company.settings, "drive")) return copied ? "Where it was is gone, so it's in Drive, under Restored files." : "It's in Drive, in Company files.";
  const where = copied ? "Where it was is gone, so it's in Company files, under Restored files." : "It's in Company files.";
  return `${where} ${hasRole(session, "admin") && can(session, "apps") ? "Install Drive from Apps to see it." : "Ask an owner or admin to install Drive to see it."}`;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** The company's folders. Drive makes "Company files" when it's installed; if it's missing, it's made now. */
export function useDriveFolders(companyId: string, enabled = true) {
  return useQuery({
    queryKey: ["drive", companyId, "folders"],
    enabled,
    queryFn: async () => {
      const load = async () => unwrap(await supabase().from("drive_folders").select(FOLDER_FIELDS).eq("company_id", companyId).order("name").limit(5000)) as unknown as DriveFolder[];
      const folders = await load();
      if (folders.some((f) => !f.parent_id)) return folders;
      unwrap(await supabase().rpc("drive_root", { p_company: companyId }));
      return load();
    },
  });
}

export type ListScope = "folder" | "client" | "recent" | "search";

/** Current files in a folder, on a client, the newest, or matching a search (public.drive_list). */
export function useDriveList(companyId: string, scope: ListScope, id: string | null, query: string | null, limit: number, enabled = true) {
  return useQuery({
    queryKey: ["drive", companyId, "list", scope, id, query, limit],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      unwrap(await supabase().rpc("drive_list", { p_company: companyId, p_scope: scope, p_id: id ?? undefined, p_query: query ?? undefined, p_limit: limit })) as unknown as DriveFile[],
  });
}

/** Clients with files, the most recently changed first (public.drive_clients). */
export function useDriveClients(companyId: string, query: string, limit: number, enabled = true) {
  return useQuery({
    queryKey: ["drive", companyId, "clients", query, limit],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => unwrap(await supabase().rpc("drive_clients", { p_company: companyId, p_query: query || undefined, p_limit: limit })) as unknown as DriveClient[],
  });
}

/** One version of a file, as public.drive_versions gives it (the current one first). */
export type VersionRow = Pick<DriveFile, Slot | "id" | "title" | "path" | "file_name" | "content_type" | "size_bytes" | "revision" | "crew_visible" | "replaces_id" | "folder_id" | "created_by" | "created_by_name" | "created_at">;

/** A file's live versions, newest first, so the current one first (public.drive_versions). */
export function useDriveVersions(companyId: string, fileId: string) {
  return useQuery({
    queryKey: ["drive", companyId, "versions", fileId],
    queryFn: () => fileVersions(fileId),
  });
}

export async function fileVersions(fileId: string): Promise<VersionRow[]> {
  return unwrap(await supabase().rpc("drive_versions", { p_file: fileId })) as unknown as VersionRow[];
}

/** Everything in the Trash this person may see, newest first (public.drive_trash). */
export function useDriveTrash(companyId: string) {
  return useQuery({
    queryKey: ["drive", companyId, "trash"],
    queryFn: async () => unwrap(await supabase().rpc("drive_trash", { p_company: companyId })) as unknown as TrashItem[],
  });
}

/** A client's properties, to add files to. The same list (and cache) as the property picker on a client. */
export function useClientProperties(clientId: string | null) {
  return useQuery({
    queryKey: ["client", clientId, "properties"],
    enabled: Boolean(clientId),
    queryFn: async () => unwrap(await supabase().from("properties").select("id, label, line1, city, region, postal_code").eq("client_id", clientId!).order("created_at")),
  });
}
