/** SOP library: required reading, categories, full-text search, and questions answered from the SOPs. */
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { CategoriesDialog } from "./CategoriesDialog";
import { useCategories, useIsEditor, useSopIndex, type SopIndexRow } from "./kbData";

interface Answer { answer: string; sources: Array<{ id: string; title: string }> }

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
  useEffect(() => setDraft(query), [query]);

  const categories = useCategories();
  const index = useSopIndex();
  const results = useQuery({
    queryKey: ["kb", company.id, "search", query],
    enabled: query.length > 1,
    placeholderData: keepPreviousData,
    queryFn: async () => unwrap(await supabase().rpc("search_sops", { p_company: company.id, p_query: query, p_limit: 25 })),
  });
  const ask = useMutation({ meta: { inline: true }, mutationFn: (question: string) => api.post<Answer>("/kb/ask", { question }) });

  const set = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p);
  };
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    ask.reset();
    set({ q: draft.trim() || null, category: null });
  };
  const category = categories.data?.find((c) => c.id === categoryId) ?? (categoryId === "none" ? { id: "none", name: "Uncategorized" } : null);
  const pages = index.data?.pages ?? [];
  const countFor = (id: string | null) => pages.filter((p) => p.category_id === id).length;
  const uncategorized = countFor(null);

  return (
    <>
      <PageHeader
        title="Knowledge base"
        actions={
          editor && (
            <>
              <Button variant="ghost" icon="layers" onClick={() => setManaging(true)}>Categories</Button>
              <Link className="btn btn-primary" to={`/kb/new${category && category.id !== "none" ? `?category=${category.id}` : ""}`}><Icon name="plus" size={16} />New guide</Link>
            </>
          )
        }
      />

      <form onSubmit={onSearch} className="kb-search" role="search">
        <div className="input-group grow">
          <span className="addon"><Icon name="search" size={17} /></span>
          <input className="input input-lg" type="search" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={aiEnabled ? "Search or ask a question" : "Search"} aria-label="Search guides" maxLength={200} />
        </div>
        <Button type="submit" size="lg">Search</Button>
        {aiEnabled && (
          <Button type="button" size="lg" variant="primary" icon="sparkle" loading={ask.isPending} disabled={draft.trim().length < 4} onClick={() => ask.mutate(draft.trim())}>Ask</Button>
        )}
      </form>

      {(ask.isPending || ask.data || ask.error) && (
        <section className="card card-pad stack-sm kb-answer" aria-live="polite" aria-label="Answer from your guides">
          <div className="row" style={{ gap: 8 }}><span className="kb-answer-icon"><Icon name="sparkle" size={15} /></span><strong>Answer from your guides</strong></div>
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

      {index.data && index.data.toRead.length > 0 && !query && !category && (
        <section className="sop-required" aria-label="Required reading">
          <Icon name="alert" size={20} />
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <strong>You have {index.data.toRead.length} required {index.data.toRead.length === 1 ? "guide" : "guides"} to read</strong>
            <div className="row wrap" style={{ gap: 6 }}>
              {index.data.toRead.slice(0, 6).map((p) => <Link key={p.id} to={`/kb/${p.id}`} className="chip" style={{ background: "var(--surface)" }}>{p.title}</Link>)}
              {index.data.toRead.length > 6 && <span className="small">and {index.data.toRead.length - 6} more</span>}
            </div>
          </div>
        </section>
      )}

      {query ? (
        <section className="stack-sm" aria-labelledby="kb-results">
          <div className="row-between">
            <h2 id="kb-results" className="section-title">Results for “{query}”</h2>
            <Button size="sm" variant="ghost" icon="x" onClick={() => { setDraft(""); ask.reset(); set({ q: null }); }}>Clear</Button>
          </div>
          <div className={`card${results.isPlaceholderData ? " is-stale" : ""}`}>
            {results.isPending && <PageRowsSkeleton />}
            {results.error && <ErrorState compact error={results.error} onRetry={() => results.refetch()} />}
            {results.data?.length === 0 && <EmptyState compact icon="search" title="No matches" />}
            {results.data?.map((hit) => (
              <Link key={hit.id} to={`/kb/${hit.id}`} className="card-row" style={{ alignItems: "flex-start" }}>
                <span className="kb-doc"><Icon name="file" size={16} /></span>
                <span className="grow stack-sm" style={{ gap: 3, minWidth: 0 }}>
                  <span className="row wrap" style={{ gap: 8 }}><strong>{hit.title}</strong>{hit.required && <span className="pill" data-tone={hit.acknowledged ? "success" : "warning"}>{hit.acknowledged ? "Read" : "Required"}</span>}</span>
                  <span className="muted small">{hit.category && <>{hit.category} · </>}{hit.snippet}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : category ? (
        <section className="stack-sm" aria-labelledby="kb-category">
          <button type="button" className="back-link" style={{ border: 0, background: "none", padding: 0, marginBottom: 0 }} onClick={() => set({ category: null })}><Icon name="arrowLeft" size={14} />All categories</button>
          <h2 id="kb-category" className="section-title">{category.name}</h2>
          <PageList pages={pages.filter((p) => p.category_id === (category.id === "none" ? null : category.id))} loading={index.isPending} error={index.error} retry={() => index.refetch()} isRead={index.data?.isRead} empty={editor ? <Link className="btn btn-primary" to={`/kb/new${category.id !== "none" ? `?category=${category.id}` : ""}`}><Icon name="plus" size={16} />Write the first guide</Link> : undefined} />
        </section>
      ) : (
        <>
          <section className="stack-sm" aria-labelledby="kb-cats">
            <h2 id="kb-cats" className="section-title">Categories</h2>
            {categories.error ? (
              <div className="card"><ErrorState compact error={categories.error} onRetry={() => categories.refetch()} /></div>
            ) : categories.isPending ? (
              <Loading label="Loading categories"><div className="grid-cards">{[0, 1, 2, 3].map((i) => <CardSkeleton key={i} lines={1} />)}</div></Loading>
            ) : categories.data.length === 0 && uncategorized === 0 ? (
              <div className="card"><EmptyState icon="book" title="Your knowledge base is empty" action={editor && <Link className="btn btn-primary" to="/kb/new"><Icon name="plus" size={16} />Write your first guide</Link>} /></div>
            ) : (
              <div className="grid-cards">
                {categories.data.map((c) => (
                  <button key={c.id} type="button" className="card card-pad category-card" onClick={() => set({ category: c.id })}>
                    <span className="c-icon"><Icon name="book" size={18} /></span>
                    <strong>{c.name}</strong>
                    <span className="muted small">{index.data ? `${countFor(c.id)} ${countFor(c.id) === 1 ? "guide" : "guides"}` : <Skeleton width={50} height={10} />}</span>
                  </button>
                ))}
                {uncategorized > 0 && (
                  <button type="button" className="card card-pad category-card" onClick={() => set({ category: "none" })}>
                    <span className="c-icon" style={{ background: "var(--fill-2)", color: "var(--text-3)" }}><Icon name="file" size={18} /></span>
                    <strong>Uncategorized</strong>
                    <span className="muted small">{uncategorized} {uncategorized === 1 ? "guide" : "guides"}</span>
                  </button>
                )}
              </div>
            )}
          </section>
          {pages.length > 0 && (
            <section className="stack-sm" aria-labelledby="kb-recent">
              <h2 id="kb-recent" className="section-title">Recently updated</h2>
              <PageList pages={[...pages].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6)} loading={false} isRead={index.data?.isRead} showCategory={categories.data} />
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

function PageList({ pages, loading, error, retry, isRead, empty, showCategory }: { pages: SopIndexRow[]; loading: boolean; error?: unknown; retry?: () => void; isRead?: (p: SopIndexRow) => boolean; empty?: React.ReactNode; showCategory?: Array<{ id: string; name: string }> }) {
  if (error) return <div className="card"><ErrorState compact error={error} onRetry={retry} /></div>;
  if (loading) return <div className="card"><PageRowsSkeleton /></div>;
  if (!pages.length) return <div className="card"><EmptyState compact icon="file" title="No guides here yet" action={empty} /></div>;
  return (
    <div className="card">
      {pages.map((p) => {
        const read = isRead?.(p);
        return (
          <Link key={p.id} to={`/kb/${p.id}`} className="card-row">
            <span className="kb-doc"><Icon name="file" size={16} /></span>
            <span className="grow stack-sm" style={{ gap: 2, minWidth: 0 }}>
              <strong className="ellipsis">{p.title}</strong>
              <span className="muted small">{showCategory && <>{showCategory.find((c) => c.id === p.category_id)?.name ?? "Uncategorized"} · </>}Updated {timeAgo(p.updated_at)}{p.revision > 1 && ` · Revision ${p.revision}`}</span>
            </span>
            {p.status === "draft" && <span className="pill">Draft</span>}
            {p.required && p.status === "published" && <span className="pill" data-tone={read ? "success" : "warning"}>{read ? <><Icon name="check" size={12} strokeWidth={3} />Read</> : "Required"}</span>}
            <Icon name="chevronRight" size={16} />
          </Link>
        );
      })}
    </div>
  );
}
