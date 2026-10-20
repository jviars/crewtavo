/** One SOP: read it, confirm you've read it, see who has, and (for the office) edit, restore or delete. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState, PageError } from "@/components/ui/States";
import { Face } from "@/components/ui/Avatar";
import { ApiError, api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { hasContent, htmlToText, sanitizeHtml, withSections } from "@/lib/html";
import { useSession } from "@/lib/session";
import { GuideContents, goToSection, useCurrentSection } from "./GuideContents";
import { ROLE_LABELS, useIsEditor } from "./kbData";

interface TeamMember { user_id: string; role: string; active: boolean; profile: { full_name: string; color: string | null; avatar_url?: string | null } | null }

export function SopPage() {
  const { pageId = "" } = useParams();
  const { company, userId } = useSession();
  const editor = useIsEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [history, setHistory] = useState(false);
  const inlineContents = useRef<HTMLDetailsElement>(null);

  const page = useQuery({
    queryKey: ["kb", company.id, "page", pageId],
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("sop_pages")
          .select("id, title, body_html, updated_at, updated_by, revision, tags, required, status, audience, category:sop_categories(id, name)")
          .eq("id", pageId)
          .maybeSingle(),
      ),
  });
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
  const reads = useQuery({
    queryKey: ["kb", company.id, "reads", pageId, page.data?.revision],
    enabled: Boolean(page.data),
    queryFn: async () => unwrap(await supabase().from("sop_acknowledgements").select("user_id, acknowledged_at").eq("page_id", pageId).eq("revision", page.data!.revision).order("acknowledged_at")),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
  const acknowledge = useMutation({
    meta: { success: "Thanks! Marked as read" },
    mutationFn: async () => unwrap(await supabase().from("sop_acknowledgements").insert({ company_id: company.id, page_id: pageId, revision: page.data!.revision })),
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: "Guide deleted" },
    mutationFn: async () => unwrap(await supabase().from("sop_pages").delete().eq("id", pageId)),
    onSuccess: () => {
      refresh();
      navigate("/kb", { replace: true });
    },
  });
  const publish = useMutation({
    meta: { success: "Guide published" },
    mutationFn: async () => unwrap(await supabase().from("sop_pages").update({ status: "published" }).eq("id", pageId)),
    onSettled: refresh,
  });
  const body = useMemo(() => {
    const html = sanitizeHtml(page.data?.body_html ?? "");
    return { empty: !hasContent(html), ...withSections(html) };
  }, [page.data?.body_html]);
  const sections = body.sections.length > 1 ? body.sections : [];
  const current = useCurrentSection(sections);
  // A link to a section (…/kb/id#mixing-ratio): go there once the guide is showing. A frame later, so the new screen's scroll to the top goes first.
  const { hash } = useLocation();
  useEffect(() => {
    if (hash.length < 2 || body.empty) return;
    const frame = requestAnimationFrame(() => document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView());
    return () => cancelAnimationFrame(frame);
  }, [hash, body]);

  if (page.isPending) return <DetailSkeleton />;
  if (page.error || !page.data) return <PageError error={page.error ?? new ApiError("This guide doesn't exist, or it was deleted.", 404)} onRetry={page.error ? () => page.refetch() : undefined} back={<BackLink to="/kb">Knowledge base</BackLink>} />;
  const sop = page.data;
  const name = (id: string | null) => team.data?.find((m) => m.user_id === id)?.profile?.full_name ?? "Team member";
  const readers = reads.data ?? [];
  const acknowledged = readers.some((r) => r.user_id === userId);
  const audience = (team.data ?? []).filter((m) => m.active && (!sop.audience?.length || (sop.audience as string[]).includes(m.role)));
  const outstanding = audience.filter((m) => !readers.some((r) => r.user_id === m.user_id));
  const showReads = sop.required && sop.status === "published";
  // "#" beside a heading copies a link to it; the contents links just go there.
  const onArticleClick = (e: MouseEvent) => {
    const link = (e.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href?.startsWith("#")) return;
    e.preventDefault();
    goToSection(decodeURIComponent(href.slice(1)), link.classList.contains("heading-anchor"));
  };

  return (
    <>
      <BackLink to={sop.category ? `/kb?category=${sop.category.id}` : "/kb"}>{sop.category?.name ?? "Knowledge base"}</BackLink>
      <PageHeader
        title={sop.title}
        actions={
          <>
            {sop.required && sop.status === "published" && (acknowledged ? (
              <span className="pill" data-tone="success" style={{ height: 36, padding: "0 14px" }}><Icon name="check" size={14} strokeWidth={3} />You've read this</span>
            ) : (
              <Button variant="primary" icon="check" loading={acknowledge.isPending} disabled={reads.isPending} onClick={() => acknowledge.mutate()}>I've read this</Button>
            ))}
            {editor && <Link className="btn" to={`/kb/${sop.id}/edit`}><Icon name="edit" size={16} />Edit</Link>}
            <Menu
              label="More actions"
              items={[
                { label: "Print", icon: "printer", onSelect: () => window.print() },
                { label: "Revision history", icon: "history", onSelect: () => setHistory(true), hidden: !editor },
                { label: "Publish", icon: "send", onSelect: () => publish.mutate(), hidden: !editor || sop.status !== "draft" },
                { separator: true, hidden: !editor },
                {
                  label: "Delete guide", icon: "trash", danger: true, hidden: !editor,
                  onSelect: async () => { if (await confirm({ title: "Delete this guide?", body: "It's removed for everyone, along with its revision history and read receipts.", confirmLabel: "Delete", danger: true })) remove.mutate(); },
                },
              ]}
            />
          </>
        }
      />
      <div className="page-meta">
        {sop.status === "draft" && <span className="pill" data-tone="warning">Draft · only the office can see this</span>}
        {sop.required && <span className="pill" data-tone="warning">Required reading{sop.audience?.length ? ` for ${sop.audience.map((r) => ROLE_LABELS[r] ?? r).join(", ")}` : ""}</span>}
        <span className="muted small">Revision {sop.revision} · Updated {timeAgo(sop.updated_at)}{sop.updated_by && team.data ? ` by ${name(sop.updated_by)}` : ""}</span>
        {sop.tags.map((t) => <Link key={t} to={`/kb?q=${encodeURIComponent(t)}`} className="chip no-print" title="Guides tagged with this">{t}</Link>)}
      </div>
      <div className="sop-reader">
        <div className="sop-layout">
          <div className="sop-main">
            {sections.length > 0 && (
              <details ref={inlineContents} className="card sop-toc-inline no-print">
                <summary>On this page<span className="muted"> · {sections.length} sections</span></summary>
                <GuideContents sections={sections} current={current} onPick={() => inlineContents.current?.removeAttribute("open")} />
              </details>
            )}
            <article className="card prose sop-body" onClick={onArticleClick}>
              {body.empty ? <p className="muted">This guide is empty.{editor && <> <Link to={`/kb/${sop.id}/edit`}>Add content</Link></>}</p> : <div dangerouslySetInnerHTML={{ __html: body.html }} />}
            </article>
          </div>
          {(showReads || sections.length > 0) && (
            <aside className="sop-aside no-print">
              {showReads && (
                <div className="card card-pad stack-sm">
                  <div className="row-between"><strong className="small">Read this revision</strong><span className="muted small">{readers.length}{team.data ? ` of ${audience.length}` : ""}</span></div>
                  {team.data && audience.length > 0 && <div className="progress"><span style={{ width: `${Math.min(100, (readers.length / audience.length) * 100)}%` }} /></div>}
                  {reads.isPending ? <Skeleton height={28} /> : readers.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No one has confirmed this revision yet.</p> : (
                    <div className="stack-sm" style={{ gap: 8 }}>
                      {readers.map((r) => (
                        <div key={r.user_id} className="row" style={{ gap: 8 }}>
                          <span className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}><Face name={name(r.user_id)} photo={team.data?.find((m) => m.user_id === r.user_id)?.profile?.avatar_url} /></span>
                          <span className="grow small strong">{name(r.user_id)}</span>
                          <span className="muted small" title={formatDateTime(r.acknowledged_at)}>{formatDate(r.acknowledged_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {editor && outstanding.length > 0 && (
                    <div className="stack-sm" style={{ gap: 6, marginTop: 6 }}>
                      <span className="muted small strong">Still to read</span>
                      <div className="row wrap" style={{ gap: 6 }}>{outstanding.map((m) => <span key={m.user_id} className="chip">{m.profile?.full_name ?? "Team member"}</span>)}</div>
                    </div>
                  )}
                </div>
              )}
              {sections.length > 0 && (
                <nav className="sop-toc" aria-label="On this page">
                  <strong className="small">On this page</strong>
                  <GuideContents sections={sections} current={current} />
                </nav>
              )}
            </aside>
          )}
        </div>
      </div>
      {history && <HistoryDialog pageId={sop.id} current={sop.revision} names={name} onClose={() => setHistory(false)} />}
    </>
  );
}

function HistoryDialog({ pageId, current, names, onClose }: { pageId: string; current: number; names: (id: string | null) => string; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<number | null>(null);
  const revisions = useQuery({
    queryKey: ["kb", company.id, "revisions", pageId],
    queryFn: async () => unwrap(await supabase().from("sop_revisions").select("revision, title, body_html, edited_by, created_at").eq("page_id", pageId).order("revision", { ascending: false }).limit(100)),
  });
  const restore = useMutation({
    meta: { success: (_: unknown, r: number) => `Revision ${r} restored as a new revision` },
    mutationFn: async (revision: number) => {
      const r = revisions.data!.find((x) => x.revision === revision)!;
      unwrap(await supabase().from("sop_pages").update({ title: r.title, body: { type: "html", html: r.body_html }, body_html: r.body_html, body_text: htmlToText(r.body_html) }).eq("id", pageId));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
      onClose();
    },
  });
  const shown = revisions.data?.find((r) => r.revision === viewing);
  return (
    <Dialog open onClose={onClose} title={shown ? `Revision ${shown.revision}` : "Revision history"} description={shown ? `${shown.title} · ${formatDateTime(shown.created_at)} by ${names(shown.edited_by)}` : "Every saved change is kept. Restoring makes the old version the newest revision."} size="lg">
      {shown ? (
        <div className="stack">
          <div className="card card-pad prose" style={{ maxHeight: "55vh", overflowY: "auto", boxShadow: "none" }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(shown.body_html) || "<p><em>Empty</em></p>" }} />
          <div className="form-actions">
            <Button variant="ghost" icon="arrowLeft" onClick={() => setViewing(null)}>All revisions</Button>
            {shown.revision !== current && <Button variant="primary" icon="undo" loading={restore.isPending} onClick={() => restore.mutate(shown.revision)}>Restore this version</Button>}
          </div>
        </div>
      ) : (
        <div className="card" style={{ boxShadow: "none" }}>
          {revisions.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton height={20} /></div>)}
          {revisions.error && <ErrorState compact error={revisions.error} onRetry={() => revisions.refetch()} />}
          {revisions.data?.map((r) => (
            <button key={r.revision} type="button" className="card-row" onClick={() => setViewing(r.revision)}>
              <span className="badge">{r.revision}</span>
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <strong className="ellipsis">{r.title}</strong>
                <span className="muted small">{formatDateTime(r.created_at)} · {names(r.edited_by)}</span>
              </span>
              {r.revision === current ? <span className="pill" data-tone="success">Current</span> : <Icon name="chevronRight" size={16} />}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
