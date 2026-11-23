/**
 * Knowledge base → Insights, for the office (KB-Insights.dc.html): what needs looking at to keep
 * guides right. A strip of figures, then changes the team suggested, guides due for review, searches
 * that found nothing (guides to write, or words to add as tags), and beside them the guides people
 * said didn't help. Flat rows on hairlines; an empty part says so in a quiet line.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
import { Button, cx } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, personHue } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { SHEET_QUERY } from "@/components/ui/menuModel";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { InboxSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { guideFinder } from "./finder";
import { categoryLook, GuideTile } from "./GuideCover";
import { loadSearchMisses, loadSopFeedback, reviewDueAt, useCategories, useIsEditor, useSopIndex } from "./kbData";
import s from "./kb.module.css";

interface TeamMember { user_id: string; profile: { full_name: string; avatar_url?: string | null } | null }

/** How far back searches that found nothing count. */
const MISS_DAYS = 90;
const DAY = 86_400_000;

export function InsightsPage() {
  const { company, userId } = useSession();
  const editor = useIsEditor();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const index = useSopIndex();
  const categories = useCategories();
  const team = useQuery({ queryKey: ["team", company.id], staleTime: 5 * 60_000, enabled: editor, queryFn: () => api.get<TeamMember[]>("/team") });
  const feedback = useQuery({
    queryKey: ["kb", company.id, "insights", "feedback"],
    enabled: editor,
    queryFn: () => loadSopFeedback(company.id),
  });
  const misses = useQuery({
    queryKey: ["kb", company.id, "insights", "misses"],
    enabled: editor,
    queryFn: () => loadSearchMisses(company.id, new Date(Date.now() - MISS_DAYS * DAY).toISOString()),
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
  const looks = new Map((categories.data ?? []).map((c, i) => [c.id, categoryLook(c.name, i)]));
  const categoryName = (id: string | null) => categories.data?.find((c) => c.id === id)?.name ?? "Uncategorized";
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
    return [...by.values()].sort((a, b) => b.times - a.times || b.last.localeCompare(a.last)).map((x) => ({ ...x, now: byId.get(find(x.said)[0] ?? "") ?? null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [misses.data, find]);
  // Votes on the revision each guide is on now.
  const votes = rows.filter((f) => f.message === null && f.helpful !== null && byId.get(f.page_id)?.revision === f.revision);
  // Guides some said didn't help, on the revision they read now: least helpful first.
  const unhelpful = useMemo(() => {
    const tally = new Map<string, { yes: number; no: number }>();
    for (const f of votes) {
      const v = tally.get(f.page_id) ?? { yes: 0, no: 0 };
      if (f.helpful) v.yes++;
      else v.no++;
      tally.set(f.page_id, v);
    }
    return [...tally.entries()].filter(([, v]) => v.no > 0).map(([id, v]) => ({ page: byId.get(id)!, ...v, open: suggestions.filter((f) => f.page_id === id).length })).sort((a, b) => a.yes / (a.yes + a.no) - b.yes / (b.yes + b.no) || b.no - a.no);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, index.data]);

  if (!editor) return <><BackLink to="/kb">Knowledge base</BackLink><EmptyState icon="lock" title="Insights are for the people who write guides" /></>;
  const loading = index.isPending || feedback.isPending;
  const published = pages.filter((p) => p.status === "published").length;
  const drafts = pages.length - published;
  const helpful = votes.filter((f) => f.helpful).length;
  const searchCount = searches.reduce((n, x) => n + x.times, 0);
  const copy = (words: string) => navigator.clipboard?.writeText(words).then(() => toast.success("Copied"), () => {});

  return (
    <>
      <BackLink to="/kb">Knowledge base</BackLink>
      <PageHeader title="Insights" lede="What to look at to keep your guides right, and which guides to write next." />
      {loading ? (
        <StatsSkeleton count={4} />
      ) : (
        <StatStrip label="Your guides">
          <Stat label="Published guides" value={published} note={drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"} · ${pages.length} in all` : `${pages.length} in all`} />
          <Stat label="Found helpful" value={votes.length ? `${Math.round((helpful / votes.length) * 100)}%` : "No votes"} note={votes.length ? `${helpful} of ${votes.length} ${votes.length === 1 ? "vote" : "votes"}` : "On the revisions people read now"} />
          <Stat label="Due for review" value={due.length} tone={due.length ? "warning" : undefined} note={due.length ? `Oldest due ${formatDate(due[0]!.at.toISOString())}` : "Nothing due"} />
          <Stat label="Searches that found nothing" value={misses.isPending ? "…" : searchCount} note={searches.length ? `${searches.length} different ${searches.length === 1 ? "search" : "searches"} · ${MISS_DAYS} days` : `Last ${MISS_DAYS} days`} />
        </StatStrip>
      )}
      <FormError error={feedback.error ?? misses.error ?? done.error ?? reviewed.error ?? clear.error} />
      <div className={cx("m-grouped", s.insights)}>
        <div className={s.insightsMain}>
          <Section flush title="Suggested changes" icon="messages" count={suggestions.length || undefined}>
            {loading ? <InboxSkeleton rows={2} /> : suggestions.length === 0 ? (
              <EmptyState inline title="Nothing to look at">When someone suggests a change under a guide, it shows up here and its reviewer gets a notification.</EmptyState>
            ) : (
              <InboxList label="Suggested changes" inset className={s.insightRows}>
                <InboxGroup>
                  {suggestions.map((f) => {
                    const who = person(f.user_id);
                    const p = byId.get(f.page_id)!;
                    return (
                      <InboxRow
                        key={f.id}
                        to={`/kb/${p.id}`}
                        title={p.title}
                        badge={<span className="il-num">{categoryName(p.category_id)}</span>}
                        avatar={<span className={cx("avatar", s.insightFace)} style={{ background: personHue(who.name) }}><Face name={who.name} photo={who.photo} /></span>}
                        subject={f.message}
                        meta={[`${who.name} · ${timeAgo(f.created_at)}`, f.revision !== p.revision && <span className="meta-break"><Icon name="history" size={13} />About revision {f.revision}, it's on {p.revision} now</span>]}
                        aside={<Button size="sm" variant="ghost" icon="check" loading={done.isPending && done.variables === f.id} aria-label={`Done with ${who.name}'s suggestion on ${p.title}`} onClick={() => done.mutate(f.id)}>Done</Button>}
                      />
                    );
                  })}
                </InboxGroup>
              </InboxList>
            )}
          </Section>

          <Section flush title="Due for review" icon="calendarCheck" count={due.length || undefined}>
            {loading ? <InboxSkeleton rows={2} /> : due.length === 0 ? (
              <EmptyState inline title="Nothing due">Give a guide a review schedule in its editor to be reminded to check it's still right.</EmptyState>
            ) : (
              <InboxList label="Due for review" inset className={s.insightRows}>
                <InboxGroup>
                  {due.map(({ page: p, at }) => {
                    const late = Math.floor((now.getTime() - at.getTime()) / DAY);
                    return (
                      <InboxRow
                        key={p.id}
                        to={`/kb/${p.id}`}
                        title={p.title}
                        badge={<span className="il-num">{categoryName(p.category_id)}</span>}
                        avatar={<GuideTile path={p.cover_path} look={looks.get(p.category_id ?? "") ?? null} />}
                        square
                        subject={`Due ${formatDate(at.toISOString())} · ${p.owner_id ? `${person(p.owner_id).name} reviews it` : "Anyone who edits guides"}`}
                        meta={[p.review_months && `Every ${p.review_months === 12 ? "year" : `${p.review_months} months`}`, p.reviewed_at && `Last reviewed ${formatDate(p.reviewed_at)}`]}
                        aside={
                          <>
                            <StatusPill tone={late > 14 ? "danger" : "warning"} label={late < 1 ? "Due today" : late === 1 ? "Due yesterday" : `${late} days late`} />
                            <Button size="sm" variant="ghost" icon="check" loading={reviewed.isPending && reviewed.variables === p.id} aria-label={`Mark ${p.title} reviewed`} onClick={() => reviewed.mutate(p.id)}>Mark reviewed</Button>
                          </>
                        }
                      />
                    );
                  })}
                </InboxGroup>
              </InboxList>
            )}
          </Section>

          <Section title="Searches that found nothing" icon="search" count={searches.length || undefined} action={<span className={s.quietEnd}>Last {MISS_DAYS} days</span>}>
            {misses.isPending ? <InboxSkeleton rows={2} /> : searches.length === 0 ? (
              <EmptyState inline title="None yet">When someone searches and no guide matches, the words show up here, so you know what to write.</EmptyState>
            ) : (
              <RelatedList label="Searches that found nothing">
                {searches.slice(0, 50).map((x) => {
                  const write = `/kb/new?${new URLSearchParams({ title: x.said[0]!.toUpperCase() + x.said.slice(1) })}`;
                  return (
                    <RelatedRow
                      key={x.said.toLowerCase()}
                      lead={<span className={s.hits}>{x.times}</span>}
                      title={`“${x.said}”`}
                      sub={[`${x.times} ${x.times === 1 ? "search" : "searches"} · last searched ${timeAgo(x.last)}`, x.now && <span className={s.found}><Icon name="check" size={13} />Now finds <Link to={`/kb/${x.now.id}`}>{x.now.title}</Link></span>]}
                      actions={
                        <>
                          {!x.now && <Link className="btn btn-sm" to={write}><Icon name="edit" size={14} />Write a guide</Link>}
                          <Menu
                            label={`More for “${x.said}”`}
                            title={`“${x.said}” · ${x.times} ${x.times === 1 ? "search" : "searches"}`}
                            triggerClassName="btn btn-sm btn-icon"
                            items={[
                              // A phone's sheet already says it in its title.
                              { heading: `“${x.said}” · ${x.times} ${x.times === 1 ? "search" : "searches"}`, hidden: window.matchMedia(SHEET_QUERY).matches },
                              { label: "Write a guide", icon: "edit", kbd: "W", onSelect: () => navigate(write) },
                              { label: "Copy the words", icon: "copy", kbd: "C", onSelect: () => void copy(x.said) },
                              { separator: true },
                              { label: "Clear", icon: "x", kbd: "E", onSelect: () => clear.mutate([...x.spellings]) },
                            ]}
                          />
                        </>
                      }
                    />
                  );
                })}
              </RelatedList>
            )}
          </Section>
        </div>

        <aside className={s.insightsSide}>
          <Section title="Guides that didn't help" icon="thumbsUp" action={<span className={s.quietEnd}>This revision's votes</span>}>
            {loading ? <InboxSkeleton rows={2} /> : unhelpful.length === 0 ? (
              <EmptyState inline title="No one has said a guide didn't help">Everyone sees “Was this guide helpful?” at the end of each guide.</EmptyState>
            ) : (
              <ul className={s.helpList}>
                {unhelpful.map(({ page: p, yes, no, open }) => {
                  const share = yes / (yes + no);
                  return (
                    <li key={p.id} className={s.helpItem}>
                      <div className={s.helpTop}><Link to={`/kb/${p.id}`}>{p.title}</Link><span>Revision {p.revision}</span></div>
                      <span className={s.bar} data-tone={share < 0.5 ? "danger" : undefined} aria-hidden="true"><b style={{ width: `${share * 100}%` }} /></span>
                      <div className={s.helpSub}>{yes} of {yes + no} found it helpful{open > 0 && <> · <Link to={`/kb/${p.id}`}>{open === 1 ? "1 suggestion open" : `${open} suggestions open`}</Link></>}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </>
  );
}
