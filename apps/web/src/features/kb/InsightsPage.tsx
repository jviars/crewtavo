/**
 * Knowledge base → Insights, for the office: what needs looking at to keep guides right. Changes
 * the team suggested, guides due for review, searches that found nothing (guides to write, or words
 * to add as tags), and guides people said didn't help.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { guideFinder } from "./finder";
import { reviewDueAt, useCategories, useIsEditor, useSopIndex } from "./kbData";

interface TeamMember { user_id: string; profile: { full_name: string; avatar_url?: string | null } | null }

/** How far back searches that found nothing count. */
const MISS_DAYS = 90;

export function InsightsPage() {
  const { company, userId } = useSession();
  const editor = useIsEditor();
  const queryClient = useQueryClient();
  const index = useSopIndex();
  const categories = useCategories();
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, enabled: editor, queryFn: () => api.get<TeamMember[]>("/team") });
  const feedback = useQuery({
    queryKey: ["kb", company.id, "insights", "feedback"],
    enabled: editor,
    queryFn: async () => unwrap(await supabase().from("sop_feedback").select("id, page_id, revision, user_id, helpful, message, created_at, resolved_at").eq("company_id", company.id).order("created_at", { ascending: false }).limit(3000)),
  });
  const misses = useQuery({
    queryKey: ["kb", company.id, "insights", "misses"],
    enabled: editor,
    queryFn: async () => unwrap(await supabase().from("sop_search_misses").select("query, created_at").eq("company_id", company.id).gte("created_at", new Date(Date.now() - MISS_DAYS * 86_400_000).toISOString()).order("created_at", { ascending: false }).limit(5000)),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
  const done = useMutation({
    meta: { inline: true, success: "Marked done" },
    mutationFn: async (id: string) => unwrap(await supabase().from("sop_feedback").update({ resolved_at: new Date().toISOString(), resolved_by: userId }).eq("id", id)),
    onSettled: refresh,
  });
  const reviewed = useMutation({
    meta: { inline: true, success: "Marked as reviewed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("sop_pages").update({ reviewed_at: new Date().toISOString() }).eq("id", id)),
    onSettled: refresh,
  });
  const clear = useMutation({
    meta: { inline: true, success: "Cleared" },
    mutationFn: async (said: string[]) => unwrap(await supabase().from("sop_search_misses").delete().eq("company_id", company.id).in("query", said)),
    onSettled: refresh,
  });

  const pages = index.data?.pages ?? [];
  const byId = new Map(pages.map((p) => [p.id, p]));
  const person = (id: string | null) => {
    const m = team.data?.find((t) => t.user_id === id);
    return { name: m?.profile?.full_name ?? "Team member", photo: m?.profile?.avatar_url };
  };
  const rows = feedback.data ?? [];
  const suggestions = rows.filter((f) => f.message !== null && !f.resolved_at && byId.has(f.page_id));
  const now = new Date();
  const due = pages
    .flatMap((p) => {
      const at = p.status === "published" ? reviewDueAt(p) : null;
      return at && at <= now ? [{ page: p, at }] : [];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  // Each search once, most searched first; the words as last typed.
  const find = useMemo(() => guideFinder(pages, categories.data ?? []), [pages, categories.data]);
  const searches = useMemo(() => {
    const by = new Map<string, { said: string; spellings: Set<string>; times: number; last: string }>();
    for (const m of misses.data ?? []) {
      const key = m.query.trim().toLowerCase();
      const seen = by.get(key);
      if (seen) {
        seen.times++;
        seen.spellings.add(m.query);
      } else by.set(key, { said: m.query.trim(), spellings: new Set([m.query]), times: 1, last: m.created_at });
    }
    return [...by.values()].sort((a, b) => b.times - a.times || b.last.localeCompare(a.last)).map((s) => ({ ...s, now: byId.get(find(s.said)[0] ?? "") ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [misses.data, find]);
  // Guides some said didn't help, on the revision they read now: least helpful first.
  const unhelpful = useMemo(() => {
    const votes = new Map<string, { yes: number; no: number }>();
    for (const f of rows) {
      const p = byId.get(f.page_id);
      if (f.message !== null || !p || f.revision !== p.revision) continue;
      const v = votes.get(f.page_id) ?? { yes: 0, no: 0 };
      if (f.helpful) v.yes++;
      else v.no++;
      votes.set(f.page_id, v);
    }
    return [...votes.entries()].filter(([, v]) => v.no > 0).map(([id, v]) => ({ page: byId.get(id)!, ...v })).sort((a, b) => a.yes / (a.yes + a.no) - b.yes / (b.yes + b.no) || b.no - a.no);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, index.data]);

  if (!editor) return <><BackLink to="/kb">Knowledge base</BackLink><div className="card"><EmptyState icon="lock" title="Insights are for the people who write guides" /></div></>;
  const loading = index.isPending || feedback.isPending;

  return (
    <>
      <BackLink to="/kb">Knowledge base</BackLink>
      <PageHeader title="Insights" />
      <p className="muted page-lede">What to look at to keep your guides right, and which guides to write next.</p>
      <FormError error={feedback.error ?? misses.error ?? done.error ?? reviewed.error ?? clear.error} />
      <div className="insights">
        <section className="card" aria-labelledby="ins-suggestions">
          <div className="card-head"><h2 id="ins-suggestions">Suggested changes</h2>{suggestions.length > 0 && <span className="badge badge-red">{suggestions.length}</span>}</div>
          {loading ? <RowsSkeleton /> : suggestions.length === 0 ? (
            <p className="card-pad muted small insights-empty">Nothing to look at. When someone suggests a change under a guide, it shows up here and its reviewer gets a notification.</p>
          ) : suggestions.map((f) => {
            const who = person(f.user_id);
            const p = byId.get(f.page_id)!;
            return (
              <div key={f.id} className="card-row" style={{ alignItems: "flex-start" }}>
                <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}><Face name={who.name} photo={who.photo} /></span>
                <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                  <Link to={`/kb/${p.id}`} className="strong">{p.title}</Link>
                  <span className="pre-wrap">{f.message}</span>
                  <span className="muted small" title={formatDateTime(f.created_at)}>{who.name} · {timeAgo(f.created_at)}{f.revision !== p.revision ? ` · about revision ${f.revision}, it's on ${p.revision} now` : ""}</span>
                </span>
                <Button size="sm" icon="check" loading={done.isPending && done.variables === f.id} onClick={() => done.mutate(f.id)}>Done</Button>
              </div>
            );
          })}
        </section>

        <section className="card" aria-labelledby="ins-reviews">
          <div className="card-head"><h2 id="ins-reviews">Due for review</h2>{due.length > 0 && <span className="badge badge-red">{due.length}</span>}</div>
          {loading ? <RowsSkeleton /> : due.length === 0 ? (
            <p className="card-pad muted small insights-empty">Nothing due. Give a guide a review schedule in its editor to be reminded to check it's still right.</p>
          ) : due.map(({ page: p, at }) => (
            <div key={p.id} className="card-row">
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <Link to={`/kb/${p.id}`} className="strong ellipsis">{p.title}</Link>
                <span className="muted small">Due {formatDate(at.toISOString())}{p.owner_id ? ` · ${person(p.owner_id).name} reviews it` : " · Anyone who edits guides"}</span>
              </span>
              <Button size="sm" icon="check" loading={reviewed.isPending && reviewed.variables === p.id} onClick={() => reviewed.mutate(p.id)}>Mark reviewed</Button>
            </div>
          ))}
        </section>

        <section className="card" aria-labelledby="ins-searches">
          <div className="card-head"><h2 id="ins-searches">Searches that found nothing</h2><span className="muted small">Last {MISS_DAYS} days</span></div>
          {misses.isPending ? <RowsSkeleton /> : searches.length === 0 ? (
            <p className="card-pad muted small insights-empty">None yet. When someone searches and no guide matches, the words show up here, so you know what to write.</p>
          ) : searches.slice(0, 50).map((s) => (
            <div key={s.said.toLowerCase()} className="card-row">
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <strong className="ellipsis">“{s.said}”</strong>
                <span className="muted small">
                  {s.times} {s.times === 1 ? "search" : "searches"} · last searched {timeAgo(s.last)}
                  {s.now && <> · Now finds <Link to={`/kb/${s.now.id}`}>{s.now.title}</Link></>}
                </span>
              </span>
              {!s.now && <Link className="btn btn-sm" to={`/kb/new?${new URLSearchParams({ title: s.said })}`}>Write a guide</Link>}
              <Button size="sm" variant="ghost" loading={clear.isPending && clear.variables?.[0] === [...s.spellings][0]} onClick={() => clear.mutate([...s.spellings])}>Clear</Button>
            </div>
          ))}
        </section>

        <section className="card" aria-labelledby="ins-helpful">
          <div className="card-head"><h2 id="ins-helpful">Guides that didn't help</h2><span className="muted small">This revision's votes</span></div>
          {loading ? <RowsSkeleton /> : unhelpful.length === 0 ? (
            <p className="card-pad muted small insights-empty">No one has said a guide didn't help. Everyone sees “Was this guide helpful?” at the end of each guide.</p>
          ) : unhelpful.map(({ page: p, yes, no }) => (
            <Link key={p.id} to={`/kb/${p.id}`} className="card-row">
              <span className="grow stack-sm" style={{ gap: 4, minWidth: 0 }}>
                <strong className="ellipsis">{p.title}</strong>
                <span className="progress insights-ratio"><span style={{ width: `${(yes / (yes + no)) * 100}%` }} /></span>
              </span>
              <span className="muted small tabular">{yes} of {yes + no} found it helpful</span>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}

function RowsSkeleton() {
  return <>{[0, 1].map((i) => <div key={i} className="card-row"><span className="grow stack-sm"><Skeleton width="45%" /><Skeleton width="70%" height={10} /></span></div>)}</>;
}
