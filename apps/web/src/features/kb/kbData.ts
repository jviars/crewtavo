/** Shared knowledge base data: categories, the page index, each role's training and what the current person still has to read. */
import { ROLE_LABELS as LEVEL_LABELS, STAFF } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { supabase, unwrap } from "@/lib/api";
import { everyRow } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { useCompanyRoles } from "../settings/roles";

export interface SopIndexRow {
  id: string;
  title: string;
  category_id: string | null;
  required: boolean;
  status: string;
  revision: number;
  updated_at: string;
  /** When its title or body last changed: what "Updated" shows (pinning or a review doesn't move it). */
  revised_at: string;
  audience: string[] | null;
  audience_roles: string[] | null;
  tags: string[];
  cover_path: string | null;
  owner_id: string | null;
  review_months: number | null;
  reviewed_at: string | null;
  /** Pinned above the categories on the knowledge base home; null when it isn't. */
  pinned_at: string | null;
}

/** Who a guide is for: the team's levels (a sub never reads guides). */
export const ROLE_LABELS: Record<string, string> = Object.fromEntries(STAFF.map((r) => [r, LEVEL_LABELS[r]]));

/**
 * Whether a required guide is this person's to read: their access level or their team role
 * (Settings → Roles) is listed, or neither list has anything (everyone).
 */
export function mustRead(page: { audience: string[] | null; audience_roles: string[] | null }, person: { role: string; role_id?: string | null }): boolean {
  const levels = page.audience ?? [];
  const roles = page.audience_roles ?? [];
  if (!levels.length && !roles.length) return true;
  return levels.includes(person.role) || (person.role_id != null && roles.includes(person.role_id));
}

/** The guides a guide links to (/kb/…), first link first, each once. Takes the saved, sanitized HTML. */
export function guideLinks(html: string): string[] {
  return [...new Set([...html.matchAll(/href="\/kb\/([0-9a-f-]{36})/g)].map((m) => m[1]))];
}

/**
 * When a guide on a review schedule is next due, as the database counts it (emit_guide_reviews):
 * that many months after its last review, on the month's last day when it's shorter. Null: not on one.
 */
export function reviewDueAt(page: { review_months: number | null; reviewed_at: string | null }): Date | null {
  if (!page.review_months || !page.reviewed_at) return null;
  const due = new Date(page.reviewed_at);
  const day = due.getDate();
  due.setMonth(due.getMonth() + page.review_months);
  if (due.getDate() < day) due.setDate(0);
  return due;
}

export function useIsEditor() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "kb_edit");
}

export function useCategories() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["kb", company.id, "categories"],
    queryFn: async () => unwrap(await supabase().from("sop_categories").select("id, name, icon, sort, cover_path").eq("company_id", company.id).order("sort").order("name")),
  });
}

/** One guide to read. A visit's checklist fetches its guides ahead with this too, so crews have them with no signal (lib/offline.ts keeps them). */
export const guideQuery = (companyId: string, pageId: string) => ({
  queryKey: ["kb", companyId, "page", pageId],
  queryFn: async () =>
    unwrap(
      await supabase()
        .from("sop_pages")
        .select("id, title, body_html, cover_path, updated_at, revised_at, updated_by, revision, tags, required, status, audience, audience_roles, owner_id, review_months, reviewed_at, pinned_at, category:sop_categories(id, name)")
        .eq("id", pageId)
        .maybeSingle(),
    ),
});

/** Every page the person can see, by title (crews only get published ones, via RLS). */
export const loadSopPages = async (companyId: string) =>
  (await everyRow(
    () => supabase().from("sop_pages").select("id, title, category_id, required, status, revision, updated_at, revised_at, audience, audience_roles, tags, cover_path, owner_id, review_months, reviewed_at, pinned_at").eq("company_id", companyId),
    { order: "title" },
  )) as SopIndexRow[];

/** Everything people said about pages, newest first: Insights counts it and lists what's unanswered. */
export const loadSopFeedback = (companyId: string) =>
  everyRow(() => supabase().from("sop_feedback").select("id, page_id, revision, user_id, helpful, message, created_at, resolved_at").eq("company_id", companyId), { order: { column: "created_at", ascending: false } });

/** Every search since `since` that found nothing, newest first. */
export const loadSearchMisses = (companyId: string, since: string) =>
  everyRow(() => supabase().from("sop_search_misses").select("query, created_at").eq("company_id", companyId).gte("created_at", since), { order: { column: "created_at", ascending: false } });

/** Every page the person can see plus their read receipts. */
export function useSopIndex() {
  const { company, userId, role, roleId } = useSession();
  return useQuery({
    queryKey: ["kb", company.id, "index"],
    queryFn: async () => {
      const [rows, acks] = await Promise.all([
        loadSopPages(company.id),
        supabase().from("sop_acknowledgements").select("page_id, revision").eq("company_id", company.id).eq("user_id", userId),
      ]);
      const read = new Set(unwrap(acks).map((a) => `${a.page_id}:${a.revision}`));
      const isRead = (p: SopIndexRow) => read.has(`${p.id}:${p.revision}`);
      const toRead = rows.filter((p) => p.required && p.status === "published" && mustRead(p, { role, role_id: roleId }) && !isRead(p));
      return { pages: rows, isRead, toRead };
    },
  });
}

/**
 * Each team role's training, by role id: its job description (Settings → Roles), then the published
 * guides the description links to, in its order. The people with the role have to read all of it.
 * Undefined while loading.
 */
export function useTraining(): Map<string, string[]> | undefined {
  const { company } = useSession();
  const roles = useCompanyRoles();
  const index = useSopIndex();
  const jobIds = [...new Set((roles.data ?? []).flatMap((r) => (r.guide_id ? [r.guide_id] : [])))].sort();
  const bodies = useQuery({
    queryKey: ["kb", company.id, "job-descriptions", jobIds],
    enabled: jobIds.length > 0,
    queryFn: async () => unwrap(await supabase().from("sop_pages").select("id, body_html").in("id", jobIds)),
  });
  return useMemo(() => {
    if (!roles.data || !index.data || (jobIds.length > 0 && !bodies.data)) return undefined;
    const published = new Set(index.data.pages.filter((p) => p.status === "published").map((p) => p.id));
    const html = new Map((bodies.data ?? []).map((b) => [b.id, b.body_html]));
    const byRole = new Map<string, string[]>();
    for (const r of roles.data) {
      if (!r.guide_id || !published.has(r.guide_id)) continue;
      byRole.set(r.id, [r.guide_id, ...guideLinks(html.get(r.guide_id) ?? "").filter((id) => id !== r.guide_id && published.has(id))]);
    }
    return byRole;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles.data, index.data, bodies.data]);
}
