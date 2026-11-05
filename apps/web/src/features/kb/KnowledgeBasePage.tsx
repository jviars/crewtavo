/**
 * SOP library: required reading and your job's training, categories, search as you type (titles
 * here, full text on the server), and questions answered from the SOPs. A search that finds nothing
 * is noted for the office (Insights), so they know which guides to write.
 */
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { CategoriesDialog } from "./CategoriesDialog";
import { guideFinder } from "./finder";
import { GuideCover } from "./GuideCover";
import { NewGuideButton } from "./NewGuide";
import { reviewDueAt, useCategories, useIsEditor, useSopIndex, useTraining, type SopIndexRow } from "./kbData";

interface Answer { answer: string; sources: Array<{ id: string; title: string }> }

/** Searches already noted as finding nothing, this visit. */
const missed = new Set<string>();

export function KnowledgeBasePage() {
  const session = useSession();
  const { company } = session;
  const editor = useIsEditor();
  const aiEnabled = session.config.features.ai;
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const categoryId = params.get("category");
  const [draft, setDraft] = useState(query);
  const [managing, setManaging] = useState(false);
  // From a tag link or Back; not while typing, where the address follows the box (and would drop a trailing space).
  useEffect(() => setDraft((d) => (d.trim() === query ? d : query)), [query]);
  const term = draft.trim();

  const categories = useCategories();
  const index = useSopIndex();
  const training = useTraining();
  const results = useQuery({
    queryKey: ["kb", company.id, "search", query],
    enabled: query.length > 1,
    placeholderData: keepPreviousData,
    queryFn: async () => unwrap(await supabase().rpc("search_sops", { p_company: company.id, p_query: query, p_limit: 25 })),
  });
  // For the office: suggestions still to look at, for the Insights button's count.
  const suggestions = useQuery({
    queryKey: ["kb", company.id, "open-suggestions"],
    enabled: editor,
    queryFn: async () => (await supabase().from("sop_feedback").select("id", { count: "exact", head: true }).eq("company_id", company.id).not("message", "is", null).is("resolved_at", null)).count ?? 0,
  });
  const ask = useMutation({ meta: { inline: true }, mutationFn: (question: string) => api.post<Answer>("/kb/ask", { question }) });

  const set = (next: Record<string, string | null>, replace = false) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace });
  };
  // Typing searches the words inside guides too, once it pauses.
  useEffect(() => {
    if (term === query) return;
    const timer = setTimeout(() => set({ q: term || null, category: null }, true), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, query]);
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    ask.reset();
    set({ q: draft.trim() || null, category: null });
  };
  const category = categories.data?.find((c) => c.id === categoryId) ?? (categoryId === "none" ? { id: "none", name: "Uncategorized" } : null);
  const pages = index.data?.pages ?? [];
  // Their job's training (Settings → Roles): its description first, then the guides it links to. All of it is theirs to read.
  const myTraining = (training?.get(session.roleId ?? "") ?? []).flatMap((id) => pages.filter((p) => p.id === id));
  const jobGuide = myTraining[0];
  const isRead = index.data?.isRead ?? (() => false);
  const trainingRead = myTraining.filter(isRead).length;
  const toRead = [...(index.data?.toRead ?? []), ...myTraining.filter((p) => !isRead(p) && !index.data?.toRead.includes(p))];
  // For the office: guides due for review and suggestions to look at (both on Insights).
  const now = new Date();
  const attention = editor ? pages.filter((p) => p.status === "published" && (reviewDueAt(p) ?? now) < now).length + (suggestions.data ?? 0) : 0;
  const find = useMemo(() => guideFinder(pages, categories.data ?? []), [pages, categories.data]);
  // Pinned by the office (a "Start here"), first pinned first, above the categories.
  const pinned = pages.filter((p) => p.pinned_at).sort((a, b) => a.pinned_at!.localeCompare(b.pinned_at!));
  const searching = term.length > 1;
  // Title, tag and category matches straight away; matches inside guides (with a snippet) once the server answers for these words.
  const hits = useMemo(() => {
    if (!searching) return [];
    const server = query === term && !results.isPlaceholderData ? (results.data ?? []) : [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    const names = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
    const snippet = new Map(server.map((r) => [r.id, r.snippet]));
    const listed = find(term)
      .map((id) => byId.get(id))
      .filter((p) => p !== undefined)
      .map((p) => ({ id: p.id, title: p.title, category: names.get(p.category_id ?? "") ?? null, required: p.required, acknowledged: index.data?.isRead(p) ?? false, snippet: snippet.get(p.id) ?? null, cover: p.cover_path }));
    const seen = new Set(listed.map((h) => h.id));
    return [...listed, ...server.filter((r) => !seen.has(r.id)).map((r) => ({ id: r.id, title: r.title, category: r.category, required: r.required, acknowledged: r.acknowledged, snippet: r.snippet, cover: byId.get(r.id)?.cover_path ?? null }))].slice(0, 30);
  }, [searching, term, query, results.data, results.isPlaceholderData, find, pages, categories.data, index.data]);
  const fullTextPending = searching && (query !== term || results.isFetching);
  // A search that settles on nothing (still nothing two seconds on, so not a word half typed) is noted once.
  const nothingFound = searching && hits.length === 0 && !fullTextPending && !index.isPending && !results.error;
  useEffect(() => {
    const said = term.toLowerCase();
    if (!nothingFound || missed.has(said)) return;
    const timer = setTimeout(() => {
      missed.add(said);
      void supabase().from("sop_search_misses").insert({ company_id: company.id, query: term.slice(0, 200) }).then(() => undefined);
    }, 2000);
    return () => clearTimeout(timer);
  }, [nothingFound, term, company.id]);
  const countFor = (id: string | null) => pages.filter((p) => p.category_id === id).length;
  const uncategorized = countFor(null);

  return (
    <>
      <PageHeader
        title="Knowledge base"
        actions={
          editor && (
            <>
              <Link className="btn btn-ghost" to="/kb/insights" aria-label={attention ? `Insights, ${attention} to look at` : "Insights"}>
                <Icon name="metrics" size={16} />Insights{attention > 0 && <span className="badge badge-red">{attention}</span>}
              </Link>
              <Button variant="ghost" icon="layers" onClick={() => setManaging(true)}>Categories</Button>
              <NewGuideButton category={category && category.id !== "none" ? category.id : null} />
            </>
          )
        }
      />

      <form onSubmit={onSearch} className="kb-search" role="search">
        <div className="input-group grow">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input input-lg" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={aiEnabled ? "Search or ask a question" : "Search"} aria-label="Search guides" maxLength={200} />
        </div>
        <Button type="submit" size="lg">Search</Button>
        {aiEnabled && (
          <Button type="button" size="lg" icon="sparkle" loading={ask.isPending} disabled={draft.trim().length < 4} onClick={() => ask.mutate(draft.trim())}>Ask</Button>
        )}
      </form>

      {(ask.isPending || ask.data || ask.error) && (
        <section className="card card-pad stack-sm kb-answer" aria-live="polite" aria-label="Answer from your guides">
          <div className="row" style={{ gap: 8 }}><span className="kb-answer-icon"><Icon name="sparkle" size={14} /></span><strong>Answer from your guides</strong></div>
          {ask.isPending && <Loading label="Thinking"><div className="stack-sm"><Skeleton width="92%" /><Skeleton width="85%" /><Skeleton width="60%" /></div></Loading>}
          {ask.data && <div className="pre-wrap" style={{ lineHeight: 1.6 }}>{ask.data.answer}</div>}
          {ask.data && ask.data.sources.length > 0 && (
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="muted small">Sources</span>
              {ask.data.sources.map((s, i) => <Link key={s.id} to={`/kb/${s.id}`} className="chip">[{i + 1}] {s.title}</Link>)}
            </div>
          )}
          <FormError error={ask.error} />
        </section>
      )}

      {toRead.length > 0 && !searching && !category && (
        <section className="sop-required" aria-label="Required reading">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <strong>You have {toRead.length} required {toRead.length === 1 ? "guide" : "guides"} to read</strong>
            <div className="row wrap" style={{ gap: 6 }}>
              {toRead.slice(0, 6).map((p) => <Link key={p.id} to={`/kb/${p.id}`} className="chip" style={{ background: "var(--surface)" }}>{p.title}</Link>)}
              {toRead.length > 6 && <span className="small">and {toRead.length - 6} more</span>}
            </div>
          </div>
        </section>
      )}

      {jobGuide && !searching && !category && (
        <Link to={`/kb/${jobGuide.id}`} className="card card-pad row kb-job" aria-label={`Your job: ${session.roleName}. ${jobGuide.title}`}>
          <Icon name="book" size={20} />
          <span className="grow stack-sm" style={{ gap: 4 }}>
            <strong>Your job: {session.roleName}</strong>
            <span className="muted small">
              {jobGuide.title === session.roleName ? "Your job description" : jobGuide.title}
              {myTraining.length > 1 && ` · ${trainingRead} of ${myTraining.length} training guides read`}
            </span>
            {myTraining.length > 1 && <span className="progress" style={{ maxWidth: 280 }}><span style={{ width: `${(trainingRead / myTraining.length) * 100}%` }} /></span>}
          </span>
          <Icon name="chevronRight" size={16} />
        </Link>
      )}

      {searching ? (
        <section className="stack-sm" aria-labelledby="kb-results">
          <div className="row-between">
            <h2 id="kb-results" className="section-title">Results for “{term}”</h2>
            <Button size="sm" variant="ghost" icon="x" onClick={() => { setDraft(""); ask.reset(); set({ q: null }); }}>Clear</Button>
          </div>
          <div className="card" aria-busy={fullTextPending}>
            {hits.length === 0 && (index.isPending || fullTextPending) && <PageRowsSkeleton />}
            {results.error && <ErrorState compact error={results.error} onRetry={() => results.refetch()} />}
            {nothingFound && (
              <div className="card-pad">
                {editor
                  ? <EmptyState inline title={`No guide matches “${term}”`} action={<Link className="btn" to={`/kb/new?${new URLSearchParams({ title: term })}`}>Write one</Link>} />
                  : <EmptyState inline title={`No guide matches “${term}”`}>The office sees what people search for, so they know which guides to write.</EmptyState>}
              </div>
            )}
            {hits.map((hit) => (
              <Link key={hit.id} to={`/kb/${hit.id}`} className="card-row" style={{ alignItems: "flex-start" }}>
                {hit.cover ? <GuideCover path={hit.cover} className="guide-thumb" /> : <span className="kb-doc"><Icon name="file" size={16} /></span>}
                <span className="grow stack-sm" style={{ gap: 3, minWidth: 0 }}>
                  <span className="row wrap" style={{ gap: 8 }}><strong>{hit.title}</strong>{hit.required && <span className="pill" data-tone={hit.acknowledged ? "success" : "warning"}>{hit.acknowledged ? "Read" : "Required"}</span>}</span>
                  <span className="muted small">{[hit.category, hit.snippet].filter(Boolean).join(" · ")}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : category ? (
        <section className="stack-sm" aria-labelledby="kb-category">
          <button type="button" className="back-link" style={{ border: 0, background: "none", padding: 0, marginBottom: 0 }} onClick={() => set({ category: null })}><Icon name="arrowLeft" size={14} />All categories</button>
          <h2 id="kb-category" className="section-title">{category.name}</h2>
          <GuideCards pages={pages.filter((p) => p.category_id === (category.id === "none" ? null : category.id))} loading={index.isPending} error={index.error} retry={() => index.refetch()} isRead={index.data?.isRead} empty={editor ? <NewGuideButton category={category.id !== "none" ? category.id : null} label="Write a guide" primary={false} /> : undefined} />
        </section>
      ) : (
        <>
          {pinned.length > 0 && (
            <section className="stack-sm" aria-labelledby="kb-pinned">
              <h2 id="kb-pinned" className="section-title">Pinned</h2>
              <GuideCards pages={pinned} loading={false} isRead={index.data?.isRead} showCategory={categories.data} />
            </section>
          )}
          <section className="stack-sm" aria-labelledby="kb-cats">
            <h2 id="kb-cats" className="section-title">Categories</h2>
            {categories.error ? (
              <div className="card"><ErrorState compact error={categories.error} onRetry={() => categories.refetch()} /></div>
            ) : categories.isPending ? (
              <CoverCardsSkeleton label="Loading categories" count={4} />
            ) : categories.data.length === 0 && uncategorized === 0 ? (
              <div className="card"><EmptyState icon="book" title="Your knowledge base is empty" action={editor && <NewGuideButton label="Write a guide" primary={false} />} /></div>
            ) : (
              <div className="guide-cards">
                {categories.data.map((c) => (
                  <button key={c.id} type="button" className="card guide-card category-tile" onClick={() => set({ category: c.id })}>
                    <GuideCover path={c.cover_path} />
                    <span className="guide-card-body">
                      <strong className="guide-card-title">{c.name}</strong>
                      <span className="muted small">{index.data ? `${countFor(c.id)} ${countFor(c.id) === 1 ? "guide" : "guides"}` : <Skeleton width={50} height={10} />}</span>
                    </span>
                  </button>
                ))}
                {uncategorized > 0 && (
                  <button type="button" className="card guide-card" onClick={() => set({ category: "none" })}>
                    <GuideCover path={null} />
                    <span className="guide-card-body">
                      <strong className="guide-card-title">Uncategorized</strong>
                      <span className="muted small">{uncategorized} {uncategorized === 1 ? "guide" : "guides"}</span>
                    </span>
                  </button>
                )}
              </div>
            )}
          </section>
          {pages.length > 0 && (
            <section className="stack-sm" aria-labelledby="kb-recent">
              <h2 id="kb-recent" className="section-title">Recently updated</h2>
              <GuideCards pages={[...pages].sort((a, b) => b.revised_at.localeCompare(a.revised_at)).slice(0, 6)} loading={false} isRead={index.data?.isRead} showCategory={categories.data} />
            </section>
          )}
        </>
      )}
      {managing && <CategoriesDialog onClose={() => setManaging(false)} counts={(id) => countFor(id)} />}
    </>
  );
}

function PageRowsSkeleton() {
  return <Loading label="Loading">{[0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton width={32} height={32} radius={8} /><span className="grow stack-sm"><Skeleton width="40%" /><Skeleton width="70%" height={10} /></span></div>)}</Loading>;
}

function CoverCardsSkeleton({ label, count }: { label: string; count: number }) {
  return (
    <Loading label={label}>
      <div className="guide-cards">{Array.from({ length: count }, (_, i) => <div key={i} className="card guide-card"><span className="guide-cover" /><span className="guide-card-body"><Skeleton width="70%" /><Skeleton width="45%" height={10} /></span></div>)}</div>
    </Loading>
  );
}

/** Guides as cards: the cover photo (or a book) over the title. */
function GuideCards({ pages, loading, error, retry, isRead, empty, showCategory }: { pages: SopIndexRow[]; loading: boolean; error?: unknown; retry?: () => void; isRead?: (p: SopIndexRow) => boolean; empty?: React.ReactNode; showCategory?: Array<{ id: string; name: string }> }) {
  if (error) return <div className="card"><ErrorState compact error={error} onRetry={retry} /></div>;
  if (loading) return <CoverCardsSkeleton label="Loading guides" count={3} />;
  if (!pages.length) return <div className="card"><EmptyState inline title="No guides here yet" action={empty} /></div>;
  return (
    <div className="guide-cards">
      {pages.map((p) => {
        const read = isRead?.(p);
        return (
          <Link key={p.id} to={`/kb/${p.id}`} className="card guide-card">
            <GuideCover path={p.cover_path} />
            <span className="guide-card-body">
              <strong className="guide-card-title">{p.title}</strong>
              <span className="muted small">{showCategory && <>{showCategory.find((c) => c.id === p.category_id)?.name ?? "Uncategorized"} · </>}Updated {timeAgo(p.revised_at)}{p.revision > 1 && ` · Revision ${p.revision}`}</span>
              {(p.status === "draft" || (p.required && p.status === "published")) && (
                <span className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                  {p.status === "draft" && <span className="pill">Draft</span>}
                  {p.required && p.status === "published" && <span className="pill" data-tone={read ? "success" : "warning"}>{read ? <><Icon name="check" size={12} strokeWidth={2} />Read</> : "Required"}</span>}
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
