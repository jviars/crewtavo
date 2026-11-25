import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, type GroupTone } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { archiveWithUndo, SelectionBar, useSelection } from "@/components/ui/Selection";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { statusText } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { api, searchTerm, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { reportBulk, type BulkResult } from "@/lib/bulk";
import { dateLocale, formatMoney, timeAgo, todayIn } from "@/lib/format";
import { titleOrClientFilter, useStatusCounts } from "@/lib/listing";
import { firstRows } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { choiceLabel, isSignedQuote } from "../documents/build";
import { NewQuoteDialog } from "./NewQuoteDialog";
import { duplicateQuote, listPrice, withOptionLines } from "./options";
import styles from "./QuotesPage.module.css";

// A tab for one status says it as the status pill does.
const FILTERS = [
  { key: "open", label: "Open", statuses: ["draft", "sent", "changes_requested", "approved"] },
  { key: "draft", label: statusText("quote", "draft"), statuses: ["draft"] },
  { key: "sent", label: statusText("quote", "sent"), statuses: ["sent"] },
  // Open puts these first, so the tab only shows while it's the one picked (?status=changes).
  { key: "changes", label: statusText("quote", "changes_requested"), statuses: ["changes_requested"] },
  { key: "approved", label: statusText("quote", "approved"), statuses: ["approved"] },
  { key: "closed", label: "Converted or lost", statuses: ["converted", "lost", "archived"] },
  // Saved quotes that new ones start from (always drafts, without a client): no other tab has them.
  { key: "templates", label: "Templates", statuses: ["draft"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
/** The tabs whose number is worth a glance: what's still open. Closed quotes and templates only pile up. */
const COUNTED: readonly FilterKey[] = ["open", "draft", "sent", "changes", "approved"];
/** How many quotes the list shows at first, and how many more each "Load more" brings. */
const PAGE = 200;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The first `limit` quotes (or quote templates) with some statuses, the latest changed first, with
 * the lines their list price needs, and how many there are in all (`total`). `term` narrows them to
 * a quote number, or a title or client that has it.
 */
export async function loadQuotes({ companyId, statuses, templates, term }: { companyId: string; statuses: readonly string[]; templates: boolean; term: string }, limit: number) {
  const match = term && !/^\d+$/.test(term) ? await titleOrClientFilter(companyId, term) : null;
  const { rows, total } = await firstRows(
    () => {
      let q = supabase()
        .from("quotes")
        .select("id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), sent_at, approved_at, converted_at, lost_reason, valid_until, updated_at, change_order_for, client:clients(display_name), opened:hub_opens(last_at), options:quote_options!quote_options_quote_fkey(id), option:quote_options!quotes_option_fkey(name, tier)", { count: "exact" })
        .eq("company_id", companyId)
        .in("status", [...statuses])
        .eq("is_template", templates);
      if (term) q = match ? q.or(match) : q.eq("number", Number(term));
      return q;
    },
    limit,
    { order: { column: "updated_at", ascending: false } },
  );
  return { rows: await withOptionLines(rows), total: total ?? rows.length };
}

/**
 * Under a quote's price when it offers options (`count`): once it's signed, the option they chose
 * (`option`, quotes.option_id: "Better · Designer shingle"), whose total the price is; before, how
 * many there are ("3 options"), as the price is from the cheapest of them (options.ts listPrice).
 * The sales board says the same.
 */
export function optionsNote(status: string, count: number, option: { name: string; tier: string | null } | null): string | null {
  if (!count) return null;
  if (option && isSignedQuote(status)) return choiceLabel(option);
  return `${count} ${count === 1 ? "option" : "options"}`;
}

type QuoteRow = Awaited<ReturnType<typeof loadQuotes>>["rows"][number];
interface QuoteGroup<R> { key: string; label: string; tone?: GroupTone; icon?: IconName; rows: R[] }

/** The list's groups, what needs doing first: a client waiting on changes, then quotes ready to become jobs, then the rest. */
const GROUPS: ReadonlyArray<Omit<QuoteGroup<never>, "rows">> = [
  { key: "changes_requested", label: "Changes requested", tone: "warning", icon: "alert" },
  { key: "approved", label: "Approved: ready to become jobs", tone: "good", icon: "check" },
  { key: "sent", label: statusText("quote", "sent") },
  { key: "draft", label: statusText("quote", "draft") },
  { key: "converted", label: statusText("quote", "converted") },
  { key: "lost", label: statusText("quote", "lost") },
  { key: "archived", label: statusText("quote", "archived") },
];

/** Quotes under their group, in GROUPS' order and the list's order within each, leaving out empty groups. */
export function groupQuotes<R extends { status: string }>(rows: readonly R[]): QuoteGroup<R>[] {
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((r) => r.status === g.key) })).filter((g) => g.rows.length > 0);
}

/** "Nov 19" this year, "Nov 19, 2025" another, as a row's quiet line says a day. A plain date (valid_until) is that day anywhere. */
export function shortDate(value: string, timeZone: string, now = new Date()): string {
  const plain = value.length === 10;
  const day = new Date(plain ? `${value}T12:00:00Z` : value);
  const zone = plain ? "UTC" : timeZone;
  const year = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", timeZone: zone });
  return day.toLocaleDateString(dateLocale(), { month: "short", day: "numeric", ...(year(day) === year(now) ? {} : { year: "numeric" }), timeZone: zone });
}

/** A quote sent, or still a draft, whose "valid until" day has gone by in the company's time zone. */
export const isExpired = (q: { status: string; valid_until: string | null }, today: string) => Boolean(q.valid_until && q.valid_until < today && (q.status === "sent" || q.status === "draft"));

export function QuotesPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "open");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search));
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  const templates = filter === "templates";
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const counts = useStatusCounts("quotes", session.company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const queryClient = useQueryClient();
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, term]);
  const timeZone = session.company.timezone;

  const listKey = ["quotes", session.company.id, filter, term, limit];
  const quotes = useQuery({
    queryKey: listKey,
    placeholderData: keepPreviousData,
    queryFn: () => loadQuotes({ companyId: session.company.id, statuses, templates, term }, limit),
  });
  const rows = quotes.data?.rows ?? [];

  // What each client who asked for changes wrote, the latest first: the row says it.
  const asking = templates ? [] : rows.filter((q) => q.status === "changes_requested").map((q) => q.id);
  const asks = useQuery({
    queryKey: ["quotes", session.company.id, "asks", asking],
    enabled: asking.length > 0,
    placeholderData: keepPreviousData,
    meta: { silent: true },
    queryFn: async () =>
      unwrap(await supabase().from("messages").select("related_id, body, created_at").eq("related_type", "quote").eq("direction", "in").eq("subject", "Changes requested").in("related_id", asking).order("created_at", { ascending: false })),
  });
  const askOf = (id: string) => asks.data?.find((m) => m.related_id === id) ?? null;

  // Templates aren't picked: each is a starting point, not a quote to archive with others.
  const selectable = canSell && !templates;
  const selection = useSelection(selectable ? rows.map((q) => q.id) : [], `${filter}|${term}`);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["quotes", session.company.id] });
  // A row's own shortcuts (on hover): an approved quote becomes its job, any quote is copied.
  const convert = useMutation({
    meta: { success: "Converted to a job", tone: "job" },
    mutationFn: (id: string) => api.post<{ job_id: string }>(`/quotes/${id}/convert`),
    onSuccess: (res) => {
      void refresh();
      navigate(`/jobs/${res.job_id}`);
    },
  });
  const copy = useMutation({
    meta: { success: "Quote copied as a new draft", tone: "quote" },
    mutationFn: (id: string) => duplicateQuote(id),
    onSuccess: (res) => {
      void refresh();
      navigate(`/quotes/${res.id}`);
    },
  });

  if (quotes.isPending) return <InboxPageSkeleton tabs={6} groups={2} />;
  const count = quotes.data?.total ?? 0;
  const startQuote = (template?: string) => setParams(template ? { new: "1", template } : { new: "1" }, { replace: true });

  // No Send for many at once: each quote is read over before it goes. `ask`: a confirm first (picked in bulk).
  const archive = async (chosen: QuoteRow[], ask = true) => {
    // As on a quote's page: a converted quote is its job's, and isn't archived.
    const archivable = chosen.filter((q) => q.status !== "archived" && q.status !== "converted");
    const skipped: BulkResult = { done: [], failed: chosen.filter((q) => !archivable.includes(q)).map((q) => ({ id: q.id, reason: q.status === "converted" ? "It became a job" : "Already archived" })) };
    const numbers = new Map(rows.map((q) => [q.id, q.number]));
    const words = { verb: "archived", one: "quote", many: "quotes", name: (id: string) => `#${numbers.get(id) ?? "?"}` };
    if (!archivable.length) return reportBulk(skipped, words, { tone: "quote" });
    const ok =
      !ask ||
      (await confirm({
        title: `Archive ${plural(archivable.length, "quote")}?`,
        body: `They move to Converted or lost, where each can be reopened as a draft.${skipped.failed.length ? ` ${plural(skipped.failed.length, "other")} picked can't be archived and ${skipped.failed.length === 1 ? "stays" : "stay"} as ${skipped.failed.length === 1 ? "it is" : "they are"}.` : ""}`,
        confirmLabel: "Archive",
      }));
    if (!ok) return;
    selection.clear();
    archiveWithUndo<{ rows: typeof rows; total: number }>({
      key: listKey,
      ids: archivable.map((q) => q.id),
      title: `${plural(archivable.length, "quote")} archived`,
      tone: "quote",
      // Converted or lost shows archived quotes too: there they stay, as archived.
      hide: (d, gone) => {
        const kept = d.rows.map((q) => (gone.has(q.id) ? { ...q, status: "archived" as const } : q)).filter((q) => (statuses as readonly string[]).includes(q.status));
        return { rows: kept, total: d.total - (d.rows.length - kept.length) };
      },
      write: async (chunk) =>
        unwrap(await supabase().from("quotes").update({ status: "archived" }).in("id", chunk).eq("is_template", false).not("status", "in", "(archived,converted)").select("id")).map((q) => q.id),
      words,
      skipped,
      refresh,
    });
  };
  const sum = (list: readonly QuoteRow[]) => list.reduce((s, q) => s + listPrice(q).amount, 0);
  const more = rows.length < count;
  const today = todayIn(timeZone);

  /** The quiet line under a quote's title: what happened last, as its group needs it. */
  const metaOf = (q: QuoteRow) => {
    if (q.status === "changes_requested") {
      const ask = askOf(q.id);
      // On a phone their words get the whole line.
      return ask ? [<span className={styles.said}>“{ask.body.trim()}”</span>, <span className={styles.when}>{timeAgo(ask.created_at)}</span>] : ["Asked for changes", timeAgo(q.updated_at)];
    }
    if (q.status === "approved") return [q.approved_at ? `Approved ${shortDate(q.approved_at, timeZone)}` : null];
    // When the client last opened it in the Client Hub (hub_opens): whether to call them.
    if (q.status === "sent") return [q.sent_at ? `Sent ${timeAgo(q.sent_at)}` : null, q.opened && `Opened ${timeAgo(q.opened.last_at)}`, isExpired(q, today) && <span className={styles.said}>Expired {shortDate(q.valid_until!, timeZone)}</span>];
    if (q.status === "draft") return [`Edited ${timeAgo(q.updated_at)}`, isExpired(q, today) && <span className={styles.said}>Expired {shortDate(q.valid_until!, timeZone)}</span>];
    if (q.status === "converted") return [q.converted_at ? `Converted ${shortDate(q.converted_at, timeZone)}` : null];
    if (q.status === "lost") return [q.lost_reason, `Changed ${timeAgo(q.updated_at)}`];
    return [`Changed ${timeAgo(q.updated_at)}`];
  };
  const priceOf = (q: QuoteRow) => {
    const price = listPrice(q);
    return price.from ? <span className="il-money" title="Its cheapest option">From {formatMoney(price.amount)}</span> : <span className="il-money">{formatMoney(price.amount)}</span>;
  };

  return (
    <>
      <PageHeader
        title="Quotes"
        actions={
          <>
            <Link to="/pipeline" className="btn"><Icon name="pipeline" size={16} />Sales board</Link>
            {canSell && <Button variant="primary" icon="plus" onClick={() => startQuote()}>New quote</Button>}
          </>
        }
      />
      <Toolbar
        filters={
          <FilterTabs
            label="Filter quotes"
            value={filter}
            onChange={setFilter}
            // A zero says nothing a tab without a number doesn't.
            options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: counts.data && COUNTED.includes(f.key) ? counts.data[f.key] || undefined : undefined, hidden: f.key === "changes" && filter !== "changes" }))}
          />
        }
        search={<SearchField value={search} onChange={setSearch} placeholder="Search title, client or #" label="Search quotes" />}
      />
      {quotes.error && !quotes.data ? (
        <ErrorState error={quotes.error} onRetry={() => quotes.refetch()} />
      ) : rows.length === 0 ? (
        term ? (
          <EmptyState icon="search" title="No quotes match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : templates ? (
          <EmptyState icon="quote" title="No quote templates yet">On a quote, choose Save as template from its menu. New quotes can then start from it.</EmptyState>
        ) : (
          <EmptyState icon="quote" title={filter === "open" ? "No open quotes" : "Nothing here"} action={canSell && filter === "open" && <Button icon="plus" onClick={() => startQuote()}>New quote</Button>}>
            {filter === "open" ? "Quotes your clients can approve online, with optional add-ons and deposits." : "No quotes have this status."}
          </EmptyState>
        )
      ) : templates ? (
        <InboxList
          label="Quote templates"
          className="il-plain"
          stale={quotes.isPlaceholderData}
          foot={<ListFoot more={more ? { onClick: () => setLimit((l) => l + PAGE), loading: quotes.isFetching } : undefined}>{more ? `Showing ${rows.length} of ${count}` : plural(rows.length, "quote template")}</ListFoot>}
        >
          <InboxGroup>
            {rows.map((q) => (
              <InboxRow
                key={q.id}
                to={`/quotes/${q.id}`}
                title={q.title}
                avatar={<Icon name="quote" size={16} />}
                square
                meta={[`Changed ${timeAgo(q.updated_at)}`, optionsNote(q.status, q.options.length, q.option)]}
                aside={priceOf(q)}
                actions={canSell && <Button size="sm" icon="plus" onClick={() => startQuote(q.id)}>New quote from it</Button>}
              />
            ))}
          </InboxGroup>
        </InboxList>
      ) : (
        <>
          {selectable && (
            <SelectionBar selection={selection} noun="quotes" always>
              <Button size="sm" icon="archive" onClick={() => void archive(rows.filter((q) => selection.has(q.id)))}>Archive</Button>
            </SelectionBar>
          )}
          <InboxList
            label="Quotes"
            className="il-plain"
            stale={quotes.isPlaceholderData}
            foot={
              <ListFoot
                // The total is of the quotes in the list, so it says so while there are more to load.
                end={<><b>{formatMoney(sum(rows))}</b> {more ? "shown" : filter === "open" ? "open" : "in all"}</>}
                more={more ? { onClick: () => setLimit((l) => l + PAGE), loading: quotes.isFetching } : undefined}
              >
                {more ? `Showing ${rows.length} of ${count}` : plural(rows.length, filter === "open" ? "open quote" : "quote")}
              </ListFoot>
            }
          >
            {groupQuotes(rows).map((g) => (
              // A tab for one status is one group already: its name and sum are the tab's and the foot's.
              <InboxGroup key={g.key} {...(statuses.length > 1 ? { label: g.label, count: g.rows.length, tone: g.tone, icon: g.icon, end: formatMoney(sum(g.rows)) } : {})}>
                {g.rows.map((q) => {
                  const note = optionsNote(q.status, q.options.length, q.option);
                  const ready = canSell && q.status === "approved" && !q.change_order_for;
                  return (
                    <InboxRow
                      key={q.id}
                      to={`/quotes/${q.id}`}
                      title={q.client?.display_name ?? q.title}
                      number={q.number}
                      badge={q.change_order_for ? <span className="tag">Change order</span> : undefined}
                      subject={q.client ? q.title : undefined}
                      unread={q.status === "changes_requested" ? statusText("quote", "changes_requested") : undefined}
                      meta={metaOf(q)}
                      aside={
                        <>
                          {priceOf(q)}
                          {note && <span className="il-sub">{isSignedQuote(q.status) && q.option ? `chose ${note}` : note}</span>}
                        </>
                      }
                      actions={
                        canSell && (
                          <>
                            {ready && (
                              <Button size="sm" variant="primary" loading={convert.isPending && convert.variables === q.id} disabled={convert.isPending} onClick={() => convert.mutate(q.id)}>
                                Convert to job
                              </Button>
                            )}
                            <Menu
                              label={`More for quote #${q.number}`}
                              title={`Quote #${q.number}`}
                              triggerClassName="btn btn-sm btn-icon"
                              // The Menus board's row menu: open it, what to do with it, its link, then archiving last.
                              items={[
                                { label: "Open quote", icon: "arrowUpRight", kbd: "↵", onSelect: () => navigate(`/quotes/${q.id}`) },
                                { label: "Copy as new draft", icon: "copy", kbd: "D", disabled: copy.isPending, onSelect: () => copy.mutate(q.id) },
                                { separator: true },
                                { label: "Copy link", icon: "link", onSelect: () => void copyText(new URL(`/quotes/${q.id}`, window.location.origin).href, "Link copied") },
                                { separator: true },
                                { label: "Archive", icon: "archive", kbd: "E", danger: true, hidden: q.status === "archived" || q.status === "converted", onSelect: () => void archive([q], false) },
                              ]}
                            />
                          </>
                        )
                      }
                      id={q.id}
                      selection={selectable ? selection : undefined}
                      selectLabel={`Select quote #${q.number}`}
                    />
                  );
                })}
              </InboxGroup>
            ))}
          </InboxList>
        </>
      )}
      <NewQuoteDialog open={params.get("new") === "1"} initialTemplate={params.get("template")} onClose={() => setParams({}, { replace: true })} onCreated={(id) => navigate(`/quotes/${id}`)} />
    </>
  );
}
