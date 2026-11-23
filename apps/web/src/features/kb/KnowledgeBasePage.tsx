/**
 * SOP library (KB-Home, KB-Search, KB-Category, KB-Phone): one field to search or ask, required reading
 * and your job's training, pinned guides, categories as tiles and what changed lately; search as you
 * type (titles here, full text on the server) with the words that matched marked; a category's guides
 * grouped by what's yours to read; and questions answered from the SOPs, with their sources. A search
 * that finds nothing is noted for the office (Insights), so they know which guides to write.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, MetaLine, RowAge } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { DetailHeader } from "@/components/ui/DetailPage";
import { PageHeader } from "@/components/ui/PageHeader";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { InboxSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, SortMenu, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { CategoriesDialog } from "./CategoriesDialog";
import { guideFinder } from "./finder";
import { categoryLook, GuideTile, type CategoryLook } from "./GuideCover";
import { NewGuideButton } from "./NewGuide";
import { ShareGuideDialog } from "./ShareGuideDialog";
import { reviewDueAt, useCategories, useIsEditor, useSharedGuides, useSopIndex, useTraining, type SopIndexRow } from "./kbData";
import { t } from "@/lib/i18n";
import { UsingChatGptPlan } from "@/features/apps/UsingChatGptPlan";
import s from "./kb.module.css";

interface Answer { answer: string; sources: Array<{ id: string; title: string }> }

/** Searches already noted as finding nothing, this visit. */
const missed = new Set<string>();

/** A category's guides: all, yours to read, and for the office the ones due for review and the drafts. */
type Show = "all" | "toread" | "review" | "drafts";
/** Recently updated, for the office: everything, or only drafts or guides shared outside the team. */
type Recent = "all" | "drafts" | "shared";
type Order = "updated" | "title";

export function KnowledgeBasePage() {
  const session = useSession();
  const { company } = session;
  const editor = useIsEditor();
  // Owners and admins who edit guides decide who a guide is shared with outside the team (as on the guide's own page).
  const sharer = editor && hasRole(session, "admin") && can(session, "kb_edit");
  const aiEnabled = session.config.features.ai;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const categoryId = params.get("category");
  const [draft, setDraft] = useState(query);
  const [managing, setManaging] = useState(false);
  const [sharing, setSharing] = useState<SopIndexRow | null>(null);
  const [show, setShow] = useState<Show>("all");
  const [recent, setRecent] = useState<Recent>("all");
  const [within, setWithin] = useState("");
  const [resultsIn, setResultsIn] = useState<string>("all");
  const order: Order = params.get("sort") === "title" ? "title" : "updated";
  // From a tag link or Back; not while typing, where the address follows the box (and would drop a trailing space).
  useEffect(() => setDraft((d) => (d.trim() === query ? d : query)), [query]);
  // A new category or search starts on all of it.
  useEffect(() => {
    setShow("all");
    setWithin("");
  }, [categoryId]);
  useEffect(() => setResultsIn("all"), [query]);
  const term = draft.trim();

  const categories = useCategories();
  const index = useSopIndex();
  const training = useTraining();
  const shared = useSharedGuides();
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
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["kb", company.id] });
  // A guide's row menu (a category's list, for the office): file it elsewhere, pin it, or delete it.
  const move = useMutation({
    meta: { success: t("Moved") },
    mutationFn: async ({ id, to }: { id: string; to: string | null }) => unwrap(await supabase().from("sop_pages").update({ category_id: to }).eq("id", id)),
    onSettled: refresh,
  });
  const pin = useMutation({
    meta: { success: (_: unknown, v: { on: boolean }) => (v.on ? t("Pinned to the top of the knowledge base") : t("Unpinned")) },
    mutationFn: async ({ id, on }: { id: string; on: boolean }) => unwrap(await supabase().from("sop_pages").update({ pinned_at: on ? new Date().toISOString() : null }).eq("id", id)),
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: t("Guide deleted") },
    mutationFn: async (id: string) => unwrap(await supabase().from("sop_pages").delete().eq("id", id)),
    onSettled: refresh,
  });

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
  const canAsk = aiEnabled && term.length >= 4;
  // ⌘↵ (Ctrl+↵) in the field asks instead of searching.
  const onFieldKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || !canAsk) return;
    e.preventDefault();
    ask.mutate(term);
  };
  const clear = () => {
    setDraft("");
    ask.reset();
    set({ q: null });
  };
  const category = categories.data?.find((c) => c.id === categoryId) ?? (categoryId === "none" ? { id: "none", name: t("Uncategorized"), cover_path: null } : null);
  const pages = index.data?.pages ?? [];
  const isRead = index.data?.isRead ?? (() => false);
  // Each category's look where it has no photo: a flat color and a subject icon, by its place in the list.
  const looks = useMemo(() => new Map((categories.data ?? []).map((c, i) => [c.id, categoryLook(c.name, i)])), [categories.data]);
  const lookOf = (id: string | null) => (id ? (looks.get(id) ?? null) : null);
  const nameOf = (id: string | null) => (id ? (categories.data?.find((c) => c.id === id)?.name ?? null) : null);
  // Their job's training (Settings → Roles): its description first, then the guides it links to. All of it is theirs to read.
  const myTraining = (training?.get(session.roleId ?? "") ?? []).flatMap((id) => pages.filter((p) => p.id === id));
  const jobGuide = myTraining[0];
  const trainingRead = myTraining.filter(isRead).length;
  const required = new Set((index.data?.toRead ?? []).map((p) => p.id));
  const toRead = [...(index.data?.toRead ?? []), ...myTraining.filter((p) => !isRead(p) && !required.has(p.id))];
  const isToRead = (p: SopIndexRow) => toRead.some((r) => r.id === p.id);
  // For the office: guides due for review and suggestions to look at (both on Insights).
  const now = new Date();
  const isDue = (p: SopIndexRow) => p.status === "published" && (reviewDueAt(p) ?? now) < now;
  const attention = editor ? pages.filter(isDue).length + (suggestions.data ?? 0) : 0;
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
      .map((p) => ({ id: p.id, title: p.title, category: names.get(p.category_id ?? "") ?? null, required: p.required, acknowledged: index.data?.isRead(p) ?? false, snippet: snippet.get(p.id) ?? null, page: p, inTitle: true }));
    const seen = new Set(listed.map((h) => h.id));
    return [...listed, ...server.filter((r) => !seen.has(r.id)).map((r) => ({ id: r.id, title: r.title, category: r.category, required: r.required, acknowledged: r.acknowledged, snippet: r.snippet, page: byId.get(r.id), inTitle: false }))].slice(0, 30);
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
  // When nothing has every word: the guides with some of them.
  const some = useQuery({
    queryKey: ["kb", company.id, "search-any", query],
    enabled: nothingFound && query === term,
    queryFn: async () => unwrap(await supabase().rpc("search_sops", { p_company: company.id, p_query: query, p_limit: 10, p_any: true })),
  });
  const countFor = (id: string | null) => pages.filter((p) => p.category_id === id).length;
  const uncategorized = countFor(null);
  const writeOne = `/kb/new?${new URLSearchParams({ title: term ? term[0]!.toUpperCase() + term.slice(1) : "" })}`;

  // A row's state on the right: what it is for you (to read, read, review due), else the guide's own (draft, shared).
  const yourState = (p: SopIndexRow) => {
    if (editor && isDue(p)) return <StatusPill tone="warning" label={t("Review due")} />;
    if (isToRead(p)) return <StatusPill tone="warning" label={t("To read")} />;
    if ((p.required || myTraining.some((m) => m.id === p.id)) && p.status === "published" && isRead(p)) return <StatusPill tone="good" label={t("Read")} />;
    return null;
  };
  const guideBadge = (p: SopIndexRow) =>
    p.status === "draft" ? (
      <span className={cx("tag", s.stateTag)} title={t("Only the office can see this")}>{t("Draft")}</span>
    ) : shared.has(p.id) ? (
      <span className={cx("tag", s.stateTag)} data-tone="info" title={shared.get(p.id) === "anyone" ? t("Anyone with the link can read this") : t("Shared with people outside the team")}>{t("Shared")}</span>
    ) : null;
  const rowMenu = (p: SopIndexRow): MenuEntry[] => [
    { label: t("Open guide"), icon: "arrowUpRight", onSelect: () => navigate(`/kb/${p.id}`) },
    { label: t("Edit"), icon: "edit", kbd: "E", onSelect: () => navigate(`/kb/${p.id}/edit`) },
    {
      label: t("Move to category"), icon: "folderMove", kbd: "M",
      items: [
        ...(categories.data ?? []).map((c) => ({ label: c.name, lead: <span className={s.swatch} style={{ background: lookOf(c.id)?.color }} />, checked: p.category_id === c.id, end: p.category_id === c.id ? undefined : String(countFor(c.id)), onSelect: () => move.mutate({ id: p.id, to: c.id }) })),
        { separator: true },
        { label: t("Uncategorized"), lead: <span className={cx(s.swatch, s.swatchNone)} />, checked: p.category_id === null, onSelect: () => move.mutate({ id: p.id, to: null }) },
      ],
    },
    { label: p.pinned_at ? t("Unpin") : t("Pin to the top"), icon: p.pinned_at ? "unpin" : "pushpin", onSelect: () => pin.mutate({ id: p.id, on: !p.pinned_at }) },
    { label: t("Share with a link"), icon: "share", hidden: !sharer, onSelect: () => setSharing(p) },
    { label: t("Revision history"), icon: "history", kbd: "H", end: p.revision > 1 ? String(p.revision) : undefined, onSelect: () => navigate(`/kb/${p.id}`, { state: { history: true } }) },
    { label: t("Make a copy"), icon: "copy", onSelect: () => navigate(`/kb/new?copy=${p.id}`) },
    { separator: true },
    {
      label: t("Delete guide"), icon: "trash", danger: true,
      onSelect: async () => { if (await confirm({ title: t("Delete this guide?"), body: t("It's removed for everyone, along with its revision history and read receipts."), confirmLabel: t("Delete"), danger: true })) remove.mutate(p.id); },
    },
  ];

  const header = category ? (
    <DetailHeader
      crumb={{ to: "/kb", label: t("All categories") }}
      title={
        <div className={s.catTitle}>
          <GuideTile path={category.cover_path} look={lookOf(category.id)} className={s.catTile} />
          <div className={s.catWords}>
            <h1 className="page-title">{category.name}</h1>
            {index.data && <CategoryMeta pages={pages.filter((p) => p.category_id === (category.id === "none" ? null : category.id))} toRead={toRead} />}
          </div>
        </div>
      }
      documentTitle={category.name}
      actions={
        editor && (
          <>
            <Button icon="layers" onClick={() => setManaging(true)}>{t("Categories")}</Button>
            <NewGuideButton category={category.id !== "none" ? category.id : null} label={category.id !== "none" ? t("New guide in {category}", { category: category.name }) : undefined} />
          </>
        )
      }
    />
  ) : (
    <PageHeader
      title={t("Knowledge base")}
      actions={
        editor && (
          <>
            <Link className="btn" to="/kb/insights" aria-label={attention ? t("Insights, {count} to look at", { count: attention }) : t("Insights")}>
              <Icon name="metrics" size={16} />{t("Insights")}{attention > 0 && <span className={cx("badge", s.attention)} aria-hidden="true">{attention}</span>}
            </Link>
            <Button icon="layers" onClick={() => setManaging(true)}>{t("Categories")}</Button>
            {/* With no match, Write one is the page's action; a phone has no room for a third round button. */}
            <NewGuideButton primary={!(nothingFound && searching)} className={nothingFound && searching ? "hide-mobile" : undefined} />
          </>
        )
      }
    />
  );

  return (
    <>
      {header}
      <div className={cx("m-grouped", s.page)}>
        {!category && (
          <>
            <form onSubmit={onSearch} onKeyDown={onFieldKey} className={s.ask} role="search" aria-label={aiEnabled ? t("Search or ask the knowledge base") : t("Search guides")}>
              <SearchField value={draft} onChange={setDraft} placeholder={aiEnabled ? t("Search or ask a question") : t("Search")} label={t("Search guides")} />
              {draft && <button type="button" className={s.clear} aria-label={t("Clear")} onClick={clear}><Icon name="x" size={15} /></button>}
              <span className={s.askSep} aria-hidden="true" />
              <Button type="submit" size="sm" variant="ghost" className={s.askBtn}>{t("Search")}<kbd className="kbd" aria-hidden="true">↵</kbd></Button>
              {aiEnabled && (
                <Button type="button" size="sm" variant="ghost" className={s.askBtn} icon="sparkle" loading={ask.isPending} disabled={!canAsk} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={() => ask.mutate(term)}>
                  {t("Ask")}<kbd className="kbd" aria-hidden="true">⌘↵</kbd>
                </Button>
              )}
            </form>
            {aiEnabled && !searching && !ask.data && <p className={s.askHint}>{t("Ask writes an answer from your guides and links the ones it used")}</p>}
          </>
        )}

        {(ask.isPending || ask.data || ask.error) && (
          <section className={s.answer} aria-live="polite" aria-label={t("Answer from your guides")}>
            <h2 className={s.answerHead}><Icon name="sparkle" size={14} />{t("Answer from your guides")}</h2>
            {ask.isPending && <Loading label={t("Thinking")}><div className="stack-sm"><Skeleton width="92%" /><Skeleton width="85%" /><Skeleton width="60%" /></div></Loading>}
            {ask.data && <div className={s.answerText}><Cited text={ask.data.answer} sources={ask.data.sources} /></div>}
            {ask.data && ask.data.sources.length > 0 && (
              <div className={s.sources}>
                <span className={s.sourcesLabel}>{t("Sources")}</span>
                {ask.data.sources.map((src, i) => <Link key={src.id} to={`/kb/${src.id}`} className={s.source}><span className={s.cite}>{i + 1}</span>{src.title}</Link>)}
              </div>
            )}
            {/* Whoever asks didn't set this up: they're told it's a machine's answer, and where the facts are. */}
            {ask.data && <p className={s.disclaimer}>{t("Written by AI from your guides. It can be wrong: check the guide before you rely on it.")}</p>}
            {ask.data && <UsingChatGptPlan />}
            <FormError error={ask.error} />
          </section>
        )}

        {searching ? (
          <SearchResults
            term={term}
            hits={hits}
            pending={fullTextPending}
            loading={hits.length === 0 && (index.isPending || fullTextPending)}
            error={results.error}
            retry={() => results.refetch()}
            nothingFound={nothingFound}
            editor={editor}
            writeOne={writeOne}
            some={(some.data ?? []).map((r) => ({ ...r, page: pages.find((p) => p.id === r.id), inTitle: false }))}
            resultsIn={resultsIn}
            setResultsIn={setResultsIn}
            lookOf={(p) => lookOf(p?.category_id ?? null)}
            stateOf={(h) => (h.required ? <StatusPill tone={h.acknowledged ? "good" : "warning"} label={h.acknowledged ? t("Read") : t("Required")} /> : h.page?.status === "draft" ? <StatusPill tone="muted" label={t("Draft")} /> : null)}
          />
        ) : category ? (
          <CategoryGuides
            pages={pages.filter((p) => p.category_id === (category.id === "none" ? null : category.id))}
            categoryName={category.name}
            loading={index.isPending}
            error={index.error}
            retry={() => index.refetch()}
            editor={editor}
            show={show}
            setShow={setShow}
            within={within}
            setWithin={setWithin}
            order={order}
            setOrder={(o) => set({ sort: o === "title" ? o : null }, true)}
            isToRead={isToRead}
            isDue={isDue}
            look={lookOf(category.id === "none" ? null : category.id)}
            badge={guideBadge}
            state={yourState}
            menu={rowMenu}
            empty={editor ? <NewGuideButton category={category.id !== "none" ? category.id : null} label={t("Write a guide")} primary={false} /> : undefined}
          />
        ) : (
          <>
            {(toRead.length > 0 || jobGuide || pinned.length > 0) && (
              <div className={cx(s.top, (toRead.length > 0 || jobGuide) && pinned.length > 0 && s.topTwo)}>
                {(toRead.length > 0 || jobGuide) && (
                  <Section flush title={t("Required reading")} icon="alert" count={toRead.length || undefined} className={toRead.length ? s.mustRead : undefined}>
                    {toRead.length > 0 && (
                      <InboxList label={t("Required reading")} inset className={s.guides}>
                        <InboxGroup>
                          {toRead.map((p) => (
                            <InboxRow
                              key={p.id}
                              to={`/kb/${p.id}`}
                              title={p.title}
                              avatar={<GuideTile path={p.cover_path} look={lookOf(p.category_id)} />}
                              square
                              meta={[nameOf(p.category_id), required.has(p.id) ? ((p.audience?.length || p.audience_roles?.length) ? t("Required for your role") : t("Required for everyone")) : t("Training for your job")]}
                              aside={<RowAge at={p.revised_at} />}
                            />
                          ))}
                        </InboxGroup>
                      </InboxList>
                    )}
                    {jobGuide && (
                      <Link to={`/kb/${jobGuide.id}`} className={s.job} aria-label={t("Your job: {role}. {guide}", { role: session.roleName, guide: jobGuide.title })}>
                        <span className={s.jobIcon}><Icon name="clipboard" size={18} /></span>
                        <span className={s.jobText}>
                          <strong>{t("Your job: {role}", { role: session.roleName })}</strong>
                          <MetaLine className={s.jobMeta} parts={[myTraining.length > 1 && <b>{t("{read} of {count} training guides read", { read: trainingRead, count: myTraining.length })}</b>, jobGuide.title === session.roleName ? t("Your job description") : jobGuide.title]} />
                        </span>
                        {myTraining.length > 1 && (
                          <span className={s.ticks} aria-hidden="true">
                            {myTraining.length <= 12 ? myTraining.map((p) => <i key={p.id} data-on={isRead(p) || undefined} />) : <span className="progress"><span style={{ width: `${(trainingRead / myTraining.length) * 100}%` }} /></span>}
                          </span>
                        )}
                        <Icon name="chevronRight" size={16} />
                      </Link>
                    )}
                  </Section>
                )}
                {pinned.length > 0 && (
                  <Section title={t("Pinned")} icon="pushpin" count={pinned.length}>
                    <RelatedList label={t("Pinned")}>
                      {pinned.map((p) => <RelatedRow key={p.id} to={`/kb/${p.id}`} lead={<GuideTile path={p.cover_path} look={lookOf(p.category_id)} className={s.pinTile} />} title={p.title} sub={nameOf(p.category_id) ?? t("Uncategorized")} />)}
                    </RelatedList>
                  </Section>
                )}
              </div>
            )}

            <Section
              flush
              title={t("Categories")}
              count={categories.data?.length || undefined}
              action={uncategorized > 0 && (categories.data?.length ?? 0) > 0 && <button type="button" onClick={() => set({ category: "none" })}>{t("{count} without a category", { count: uncategorized })}</button>}
            >
              {categories.error ? (
                <ErrorState compact error={categories.error} onRetry={() => categories.refetch()} />
              ) : categories.isPending ? (
                <Loading label={t("Loading categories")}><div className={s.tiles}>{[0, 1, 2, 3].map((i) => <span key={i} className={s.tile}><Skeleton height={64} radius={10} /><Skeleton width="60%" /><Skeleton width="40%" height={10} /></span>)}</div></Loading>
              ) : categories.data.length === 0 && uncategorized === 0 ? (
                <EmptyState icon="book" title={t("Your knowledge base is empty")} action={editor && <NewGuideButton label={t("Write a guide")} primary={false} />} />
              ) : (
                <div className={s.tiles}>
                  {categories.data.map((c) => {
                    const todo = toRead.filter((p) => p.category_id === c.id).length;
                    return (
                      <button key={c.id} type="button" className={s.tile} onClick={() => set({ category: c.id })}>
                        <GuideTile path={c.cover_path} look={lookOf(c.id)} className={s.tileCover} />
                        <span className={s.tileName}>{c.name}</span>
                        <span className={s.tileMeta}>
                          {index.data ? t.plural(countFor(c.id), { one: "{count} guide", other: "{count} guides" }) : <Skeleton width={50} height={10} />}
                          {todo > 0 && <> · <span className={s.todo}>{t("{count} to read", { count: todo })}</span></>}
                        </span>
                      </button>
                    );
                  })}
                  {categories.data.length === 0 && (
                    <button type="button" className={s.tile} onClick={() => set({ category: "none" })}>
                      <GuideTile path={null} look={null} className={s.tileCover} />
                      <span className={s.tileName}>{t("Uncategorized")}</span>
                      <span className={s.tileMeta}>{t.plural(uncategorized, { one: "{count} guide", other: "{count} guides" })}</span>
                    </button>
                  )}
                </div>
              )}
            </Section>

            {pages.length > 0 && (
              <RecentlyUpdated
                pages={pages}
                editor={editor}
                recent={recent}
                setRecent={setRecent}
                shared={shared}
                nameOf={nameOf}
                lookOf={lookOf}
                badge={guideBadge}
              />
            )}
          </>
        )}
      </div>
      {managing && <CategoriesDialog onClose={() => setManaging(false)} counts={(id) => countFor(id)} />}
      {sharing && <ShareGuideDialog pageId={sharing.id} title={sharing.title} onClose={() => setSharing(null)} />}
    </>
  );
}

/** Under a category's name: how many guides, how many are yours to read, and when one last changed. */
function CategoryMeta({ pages, toRead }: { pages: SopIndexRow[]; toRead: SopIndexRow[] }) {
  const mine = pages.filter((p) => toRead.some((r) => r.id === p.id)).length;
  const latest = pages.reduce<string | null>((at, p) => (!at || p.revised_at > at ? p.revised_at : at), null);
  return <MetaLine className={s.catMeta} parts={[t.plural(pages.length, { one: "{count} guide", other: "{count} guides" }), mine > 0 && t("{count} to read", { count: mine }), latest && t("Updated {when}", { when: timeAgo(latest) })]} />;
}

/** What changed lately: the six newest revisions, or for the office every draft or every guide shared outside the team. */
function RecentlyUpdated({ pages, editor, recent, setRecent, shared, nameOf, lookOf, badge }: {
  pages: SopIndexRow[];
  editor: boolean;
  recent: Recent;
  setRecent: (r: Recent) => void;
  shared: Map<string, "anyone" | number>;
  nameOf: (id: string | null) => string | null;
  lookOf: (id: string | null) => CategoryLook | null;
  badge: (p: SopIndexRow) => ReactNode;
}) {
  const drafts = pages.filter((p) => p.status === "draft");
  const outside = pages.filter((p) => shared.has(p.id));
  const list = (recent === "drafts" ? drafts : recent === "shared" ? outside : pages).slice().sort((a, b) => b.revised_at.localeCompare(a.revised_at)).slice(0, recent === "all" ? 6 : 30);
  const filter = editor && (drafts.length > 0 || outside.length > 0) && (
    <div className={cx(s.smallTabs, "hide-mobile")}>
      <FilterTabs
        label={t("Show")}
        value={recent}
        onChange={setRecent}
        options={[
          { value: "all", label: t("All") },
          { value: "drafts", label: t("Drafts"), count: drafts.length, hidden: !drafts.length },
          { value: "shared", label: t("Shared"), count: outside.length, hidden: !outside.length },
        ]}
      />
    </div>
  );
  return (
    <Section flush title={t("Recently updated")} action={filter}>
      <InboxList label={t("Recently updated")} inset className={s.guides}>
        <InboxGroup>
          {list.map((p) => (
            <InboxRow
              key={p.id}
              to={`/kb/${p.id}`}
              title={p.title}
              badge={badge(p)}
              avatar={<GuideTile path={p.cover_path} look={lookOf(p.category_id)} />}
              square
              meta={[nameOf(p.category_id) ?? t("Uncategorized"), p.revision > 1 && t("Revision {number}", { number: p.revision })]}
              aside={<RowAge at={p.revised_at} />}
              actions={editor && <Link className="btn btn-sm" to={`/kb/${p.id}/edit`}><Icon name="edit" size={14} />{t("Edit")}</Link>}
            />
          ))}
        </InboxGroup>
      </InboxList>
    </Section>
  );
}

/** A category's guides: filters and a search over them, then the ones you have to read, then the rest. */
function CategoryGuides({ pages, categoryName, loading, error, retry, editor, show, setShow, within, setWithin, order, setOrder, isToRead, isDue, look, badge, state, menu, empty }: {
  pages: SopIndexRow[];
  categoryName: string;
  loading: boolean;
  error: unknown;
  retry: () => void;
  editor: boolean;
  show: Show;
  setShow: (s: Show) => void;
  within: string;
  setWithin: (v: string) => void;
  order: Order;
  setOrder: (o: Order) => void;
  isToRead: (p: SopIndexRow) => boolean;
  isDue: (p: SopIndexRow) => boolean;
  look: CategoryLook | null;
  badge: (p: SopIndexRow) => ReactNode;
  state: (p: SopIndexRow) => ReactNode;
  menu: (p: SopIndexRow) => MenuEntry[];
  empty?: ReactNode;
}) {
  const counts = { all: pages.length, toread: pages.filter(isToRead).length, review: pages.filter(isDue).length, drafts: pages.filter((p) => p.status === "draft").length };
  const words = within.trim().toLowerCase();
  const shown = pages
    .filter((p) => (show === "toread" ? isToRead(p) : show === "review" ? isDue(p) : show === "drafts" ? p.status === "draft" : true))
    .filter((p) => !words || p.title.toLowerCase().includes(words) || p.tags.some((tag) => tag.toLowerCase().includes(words)))
    .sort((a, b) => (order === "title" ? a.title.localeCompare(b.title) : b.revised_at.localeCompare(a.revised_at)));
  const mine = shown.filter(isToRead);
  const rest = shown.filter((p) => !isToRead(p));
  const filters = [
    { value: "all" as const, label: t("All"), count: counts.all },
    { value: "toread" as const, label: t("To read"), count: counts.toread, hidden: !counts.toread },
    { value: "review" as const, label: t("Review due"), count: counts.review, hidden: !editor || !counts.review },
    { value: "drafts" as const, label: t("Drafts"), count: counts.drafts, hidden: !editor || !counts.drafts },
  ];
  const mineAll = pages.filter((p) => isToRead(p) || p.required);
  const row = (p: SopIndexRow) => (
    <InboxRow
      key={p.id}
      to={`/kb/${p.id}`}
      title={p.title}
      badge={badge(p)}
      avatar={<GuideTile path={p.cover_path} look={look} />}
      square
      meta={[
        t("Updated {when}", { when: timeAgo(p.revised_at) }),
        p.revision > 1 && <span className={s.metaMore}>{t("Revision {number}", { number: p.revision })}</span>,
        p.tags.length > 0 && <span className={s.metaMore}>{p.tags.slice(0, 3).join(", ")}</span>,
      ]}
      aside={state(p)}
      actions={editor && (
        <>
          <Link className="btn btn-sm" to={`/kb/${p.id}/edit`}><Icon name="edit" size={14} />{t("Edit")}</Link>
          <Menu items={menu(p)} label={t("More actions for {title}", { title: p.title })} title={p.title} triggerClassName="btn btn-sm btn-icon" />
        </>
      )}
    />
  );

  if (error) return <ErrorState error={error} onRetry={retry} />;
  if (loading) return <InboxSkeleton rows={4} />;
  if (!pages.length) return <EmptyState icon="book" title={t("No guides here yet")} action={empty} />;
  return (
    <>
      <Toolbar
        // A lone "All" isn't a choice: the filters show once there's something else to pick.
        filters={filters.filter((f) => !f.hidden).length > 1 && <FilterTabs label={t("Show guides")} value={show} onChange={setShow} options={filters} />}
        search={<SearchField value={within} onChange={setWithin} placeholder={t("Search in {category}", { category: categoryName })} label={t("Search guides in {category}", { category: categoryName })} />}
        tools={<SortMenu value={order} onChange={setOrder} options={[{ value: "updated", label: t("Recently updated") }, { value: "title", label: t("Title A to Z") }]} />}
      />
      {shown.length === 0 ? (
        <EmptyState icon="search" title={t("No guides match")} action={<Button onClick={() => { setWithin(""); setShow("all"); }}>{t("Show all")}</Button>} />
      ) : (
        <InboxList
          label={categoryName}
          inset
          className={cx(s.guides, s.catRows)}
          foot={editor && counts.drafts > 0 && <ListFoot>{t("Drafts show only to the office")}</ListFoot>}
        >
          {mine.length > 0 && (
            <InboxGroup
              label={t("Required for you")}
              count={mine.length}
              tone="warning"
              icon="book"
              end={mineAll.length > 0 && (
                <span className={s.meterEnd}>
                  <span className={s.meter} aria-hidden="true"><b style={{ width: `${((mineAll.length - pages.filter(isToRead).length) / mineAll.length) * 100}%` }} /></span>
                  {t("{read} of {count} read", { read: mineAll.length - pages.filter(isToRead).length, count: mineAll.length })}
                </span>
              )}
            >
              {mine.map(row)}
            </InboxGroup>
          )}
          {rest.length > 0 && (mine.length > 0 ? <InboxGroup label={t("Other guides")} count={rest.length}>{rest.map(row)}</InboxGroup> : <InboxGroup>{rest.map(row)}</InboxGroup>)}
        </InboxList>
      )}
    </>
  );
}

type Hit = { id: string; title: string; category: string | null; required: boolean; acknowledged: boolean; snippet: string | null; page?: SopIndexRow; inTitle: boolean };

/** What a search found: in titles and tags first, then in the words of guides, the matched words marked. */
function SearchResults({ term, hits, pending, loading, error, retry, nothingFound, editor, writeOne, some, resultsIn, setResultsIn, lookOf, stateOf }: {
  term: string;
  hits: Hit[];
  pending: boolean;
  loading: boolean;
  error: unknown;
  retry: () => void;
  nothingFound: boolean;
  editor: boolean;
  writeOne: string;
  some: Hit[];
  resultsIn: string;
  setResultsIn: (v: string) => void;
  lookOf: (p: SopIndexRow | undefined) => CategoryLook | null;
  stateOf: (h: Hit) => ReactNode;
}) {
  const words = useMemo(() => stems(term), [term]);
  const places = [...new Set(hits.map((h) => h.category ?? ""))];
  const shown = resultsIn === "all" ? hits : hits.filter((h) => (h.category ?? "") === resultsIn);
  const row = (h: Hit) => (
    <InboxRow
      key={h.id}
      to={`/kb/${h.id}`}
      title={<Marked text={h.title} words={words} />}
      avatar={<GuideTile path={h.page?.cover_path ?? null} look={lookOf(h.page)} />}
      square
      subject={h.snippet && <Marked text={h.snippet} words={words} />}
      meta={[h.category ?? t("Uncategorized"), h.page && h.page.revision > 1 && t("Revision {number}", { number: h.page.revision })]}
      aside={stateOf(h)}
    />
  );
  const inTitle = shown.filter((h) => h.inTitle);
  const inText = shown.filter((h) => !h.inTitle);
  return (
    <section className={s.results} aria-labelledby="kb-results" aria-busy={pending}>
      <div className={s.resultsHead} hidden={nothingFound}>
        <h2 id="kb-results">{t("Results for “{term}”", { term })}</h2>
        {hits.length > 0 && <span className="sec-count">{hits.length}</span>}
      </div>
      {places.length > 1 && (
        <FilterTabs
          label={t("Filter results by category")}
          value={resultsIn}
          onChange={setResultsIn}
          options={[{ value: "all", label: t("All"), count: hits.length }, ...places.map((p) => ({ value: p, label: p || t("Uncategorized"), count: hits.filter((h) => (h.category ?? "") === p).length }))]}
        />
      )}
      {loading && <InboxSkeleton rows={3} />}
      {error ? <ErrorState compact error={error} onRetry={retry} /> : null}
      {nothingFound && (
        <div className={s.none}>
          <h2>{t("No guide matches “{term}”", { term })}</h2>
          {editor ? (
            <>
              <p>{t("It's listed in Insights under Searches that found nothing, so you know which guides to write.")}</p>
              <div className={s.noneActions}>
                <Link className="btn btn-primary" to={writeOne}><Icon name="edit" size={16} />{t("Write one")}</Link>
                <span className={s.noneHint}>{t("Opens a new guide titled “{title}”.", { title: term[0]!.toUpperCase() + term.slice(1) })}</span>
              </div>
            </>
          ) : (
            <p>{t("The office sees what people search for, so they know which guides to write.")}</p>
          )}
        </div>
      )}
      {nothingFound && some.length > 0 && (
        <InboxList label={t("Guides with some of these words")} inset className={cx(s.guides, s.resultList)}>
          <InboxGroup label={t("Guides with some of these words")} count={some.length}>
            {some.map(row)}
          </InboxGroup>
        </InboxList>
      )}
      {shown.length > 0 && (
        <InboxList label={t("Results")} inset className={cx(s.guides, s.resultList)} stale={pending}>
          {inTitle.length > 0 && <InboxGroup label={t("In the title or tags")} count={inTitle.length}>{inTitle.map(row)}</InboxGroup>}
          {inText.length > 0 && <InboxGroup label={t("In the guide text")} count={inText.length}>{inText.map(row)}</InboxGroup>}
        </InboxList>
      )}
    </section>
  );
}

/** The searched words, cut back to their stem (so "calibrate" marks "calibration"), longest first. */
function stems(term: string): string[] {
  return [...new Set(term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).map((w) => (w.length > 4 ? w.replace(/(ations?|ions?|ing|ed|es|s|e)$/, "") : w)))].sort((a, b) => b.length - a.length);
}

/** Text with each word that starts with a searched stem marked (neutral, so amber still means someone has to act). */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])((?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[\\p{L}\\p{N}]*)`, "giu");
  const parts = text.split(re);
  return <>{parts.map((part, i) => (i % 2 ? <mark key={i} className={s.hit}>{part}</mark> : <Fragment key={i}>{part}</Fragment>))}</>;
}

/** An answer's words with its [1], [2] as small numbers that open the guide they came from. */
function Cited({ text, sources }: { text: string; sources: Answer["sources"] }) {
  const parts = text.split(/\[(\d+)\]/g);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        const source = sources[Number(part) - 1];
        return source ? <Link key={i} to={`/kb/${source.id}`} className={s.cite} aria-label={t("Source {number}, {title}", { number: part, title: source.title })}>{part}</Link> : <Fragment key={i}>[{part}]</Fragment>;
      })}
    </>
  );
}
