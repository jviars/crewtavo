/**
 * Shared queries and types for subcontractors and their paperwork. Reads and changes go straight to
 * the database under row-level security (supabase/migrations/20261025001001_subcontractors.sql):
 * only owners, admins and office staff with the Subcontractors area reach any of it, and a signed-in
 * sub their own paperwork. A sub's sign-in goes through the API (routes/subs.ts).
 */
import type { SubAccessState } from "@crewtavo/core/subs";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadBody, uploadRefused } from "@/lib/files";
import { can, hasRole, type Session } from "@/lib/session";
import type { PaperworkRow } from "./paperwork";

export interface SubAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal_code?: string;
}

export interface Sub {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  trade: string | null;
  address: SubAddress;
  tax_classification: string | null;
  notes: string | null;
  active: boolean;
  /** Their sign-in shows the client's phone and email, not just the name. */
  can_contact_clients: boolean;
  /** Their sign-in has a clock, for an office that also wants their hours. */
  uses_clock: boolean;
  created_at: string;
}

export const SUB_FIELDS = "id, name, contact_name, phone, email, trade, address, tax_classification, notes, active, can_contact_clients, uses_clock, created_at";

export interface SubDocument {
  id: string;
  subcontractor_id: string;
  kind: string;
  title: string | null;
  path: string;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  carrier: string | null;
  policy_number: string | null;
  starts_on: string | null;
  expires_on: string | null;
  verified_at: string | null;
  verified_by: string | null;
  superseded_at: string | null;
  uploaded_via: "office" | "link" | "sub";
  created_at: string;
}

export const DOCUMENT_FIELDS =
  "id, subcontractor_id, kind, title, path, file_name, content_type, size_bytes, carrier, policy_number, starts_on, expires_on, verified_at, verified_by, superseded_at, uploaded_via, created_at";

/** People who see and keep subs and their paperwork (the database allows no one else). */
export const managesSubs = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "subs");

/** Every active sub's paperwork status (public.sub_paperwork), or one sub's. */
export function useSubPaperwork(companyId: string, subId?: string, enabled = true) {
  return useQuery({
    queryKey: ["subs", companyId, "paperwork", subId ?? "all"],
    enabled,
    queryFn: async () => {
      let q = supabase().from("sub_paperwork").select("*").eq("company_id", companyId).limit(5000);
      if (subId) q = q.eq("subcontractor_id", subId);
      return unwrap(await q) as PaperworkRow[];
    },
  });
}

/** A sub's documents, current and replaced, newest first, each with a link to its file (good for an hour). */
export function useSubDocuments(companyId: string, subId: string) {
  return useQuery({
    queryKey: ["subs", companyId, "documents", subId],
    // The file links last an hour; fetch new ones well before then.
    refetchInterval: 45 * 60_000,
    queryFn: async () => {
      const rows = unwrap(
        await supabase().from("sub_documents").select(DOCUMENT_FIELDS).eq("subcontractor_id", subId).order("created_at", { ascending: false }).limit(500),
      ) as SubDocument[];
      const urls = await signedUrls(rows.map((r) => r.path)).catch(() => ({}) as Record<string, string>);
      return rows.map((r) => ({ ...r, url: urls[r.path] ?? null }));
    },
  });
}
export type SubDocumentWithLink = SubDocument & { url: string | null };

/** Where a sub's sign-in stands (GET /api/subs/:id/access). `shared`: they also sign in for another business. */
export interface SubAccess {
  state: SubAccessState;
  user_id: string | null;
  last_sign_in_at: string | null;
  shared: boolean;
}

/** What Text, Email or Copy sign-in link did (POST /api/subs/:id/sign-in-link). */
export interface SignInLinkResult {
  access: SubAccess;
  /** The one-time link, to copy. Null when they sign in their own way (access.shared). */
  link: string | null;
  texted: boolean;
  emailed: boolean;
  /** Crewtavo couldn't text it: opens Messages on this phone with the text filled in. */
  sms_link: string | null;
  /** What didn't go out, and why. */
  reason: string | null;
}

export function useSubAccess(companyId: string, subId: string) {
  return useQuery({ queryKey: ["subs", companyId, "access", subId], queryFn: () => api.get<SubAccess>(`/subs/${subId}/access`) });
}

/** A sub with a sign-in, to put on a visit (GET /api/subs/logins). */
export interface SubSignIn {
  user_id: string;
  subcontractor_id: string;
  name: string;
  contact_name: string | null;
  trade: string | null;
  /** False once their sign-in was removed or the sub turned off: they can come off visits, not go on. */
  active: boolean;
}

/** The subs with a sign-in, for whoever schedules the whole team. */
export function useSubSignIns(companyId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["sub-sign-ins", companyId],
    enabled,
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: () => api.get<SubSignIn[]>("/subs/logins"),
  });
}

/** After any change to a sub or their documents. */
export function refreshSubs(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["subs"] });
  queryClient.invalidateQueries({ queryKey: ["sub-sign-ins"] });
}

/** Blank text is stored as null (the email check turns down ""). */
export const blankToNull = (value: string) => value.trim() || null;

/**
 * Files a document for a sub: the file goes to <company>/subs/<sub>/ first, then the row. If the
 * row can't be saved, the file is left with no row, and the server tidies it away after a day.
 * Photos are shrunk first, like receipts.
 */
export async function addSubDocument(
  companyId: string,
  subId: string,
  file: File,
  row: { kind: string; title: string | null; carrier: string | null; policy_number: string | null; starts_on: string | null; expires_on: string | null },
): Promise<string> {
  const body = await uploadBody(file);
  const shrunk = body !== file;
  const ext = shrunk ? "jpg" : (file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "pdf").toLowerCase();
  const path = `${companyId}/subs/${subId}/${crypto.randomUUID()}.${ext}`;
  const contentType = body.type || file.type || "application/octet-stream";
  const uploaded = await supabase().storage.from("files").upload(path, body, { contentType, upsert: false });
  if (uploaded.error) throw uploadRefused(uploaded.error, "You don't have permission to add paperwork.");
  const fileName = shrunk ? file.name.replace(/\.[a-z0-9]{1,8}$/i, "") + ".jpg" : file.name;
  const inserted = await supabase()
    .from("sub_documents")
    .insert({ company_id: companyId, subcontractor_id: subId, path, file_name: fileName.slice(0, 255), content_type: contentType.slice(0, 150), size_bytes: body.size, ...row })
    .select("id")
    .single();
  return unwrap(inserted).id;
}

/**
 * Deletes a document; its file goes to the Trash (the database moves it), from where it can be put
 * back. The one it replaced, if any, counts again (the database puts it back).
 */
export async function deleteSubDocument(doc: Pick<SubDocument, "id" | "path">) {
  unwrap(await supabase().from("sub_documents").delete().eq("id", doc.id));
}
