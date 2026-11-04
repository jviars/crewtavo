import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { archiveWithUndo, SelectAllCell, SelectCell, SelectionBar, useSelection } from "@/components/ui/Selection";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { reportBulk, type BulkResult } from "@/lib/bulk";
import { formatDate, formatMoney, timeAgo } from "@/lib/format";
import { titleOrClientFilter, useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession } from "@/lib/session";
import { choiceLabel, isSignedQuote } from "../documents/build";
import { NewQuoteDialog } from "./NewQuoteDialog";
import { listPrice, withOptionLines } from "./options";

// A tab for one status says it as the status pill does.
const FILTERS = [
  { key: "open", label: "Open", statuses: ["draft", "sent", "changes_requested", "approved"] },
  { key: "draft", label: statusText("quote", "draft"), statuses: ["draft"] },
  { key: "sent", label: statusText("quote", "sent"), statuses: ["sent"] },
  { key: "changes", label: statusText("quote", "changes_requested"), statuses: ["changes_requested"] },
  { key: "approved", label: statusText("quote", "approved"), statuses: ["approved"] },
  { key: "closed", label: "Converted or lost", statuses: ["converted", "lost", "archived"] },
  // Saved quotes that new ones start from (always drafts, without a client): no other tab has them.
  { key: "templates", label: "Quote templates", statuses: ["draft"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

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

  const listKey = ["quotes", session.company.id, filter, term];
  const quotes = useQuery({
    queryKey: listKey,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("quotes")
        .select("id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), sent_at, valid_until, updated_at, client:clients(display_name), options:quote_options!quote_options_quote_fkey(id), option:quote_options!quotes_option_fkey(name, tier)")
        .eq("company_id", session.company.id)
        .in("status", [...statuses])
        .eq("is_template", templates)
        .order("updated_at", { ascending: false })
        .limit(200);
      if (term) q = /^\d+$/.test(term) ? q.eq("number", Number(term)) : q.or(await titleOrClientFilter(session.company.id, term));
      return withOptionLines(unwrap(await q));
    },
  });

  // Templates aren't picked: each is a starting point, not a quote to archive with others.
  const selectable = canSell && !templates;
  const selection = useSelection(selectable ? (quotes.data ?? []).map((q) => q.id) : [], `${filter}|${term}`);

  if (quotes.isPending) return <ListPageSkeleton columns={5} tabs={7} />;
  const rows = quotes.data ?? [];
  // No Send for many at once: each quote is read over before it goes.
  const archive = async () => {
    const chosen = rows.filter((q) => selection.has(q.id));
    // As on a quote's page: a converted quote is its job's, and isn't archived.
    const archivable = chosen.filter((q) => q.status !== "archived" && q.status !== "converted");
    const skipped: BulkResult = { done: [], failed: chosen.filter((q) => !archivable.includes(q)).map((q) => ({ id: q.id, reason: q.status === "converted" ? "It became a job" : "Already archived" })) };
    const numbers = new Map(rows.map((q) => [q.id, q.number]));
    const words = { verb: "archived", one: "quote", many: "quotes", name: (id: string) => `#${numbers.get(id) ?? "?"}` };
    if (!archivable.length) return reportBulk(skipped, words, { tone: "quote" });
    const ok = await confirm({
      title: `Archive ${plural(archivable.length, "quote")}?`,
      body: `They move to Converted or lost, where each can be reopened as a draft.${skipped.failed.length ? ` ${plural(skipped.failed.length, "other")} picked can't be archived and ${skipped.failed.length === 1 ? "stays" : "stay"} as ${skipped.failed.length === 1 ? "it is" : "they are"}.` : ""}`,
      confirmLabel: "Archive",
    });
    if (!ok) return;
    selection.clear();
    archiveWithUndo<typeof rows>({
      key: listKey,
      ids: archivable.map((q) => q.id),
      title: `${plural(archivable.length, "quote")} archived`,
      tone: "quote",
      // Converted or lost shows archived quotes too: there they stay, as archived.
      hide: (d, gone) => d.map((q) => (gone.has(q.id) ? { ...q, status: "archived" as const } : q)).filter((q) => (statuses as readonly string[]).includes(q.status)),
      write: async (chunk) =>
        unwrap(await supabase().from("quotes").update({ status: "archived" }).in("id", chunk).eq("is_template", false).not("status", "in", "(archived,converted)").select("id")).map((q) => q.id),
      words,
      skipped,
      refresh: () => queryClient.invalidateQueries({ queryKey: ["quotes", session.company.id] }),
    });
  };
  const total = rows.reduce((s, q) => s + listPrice(q).amount, 0);

  return (
    <>
      <PageHeader
        title="Quotes"
        actions={
          <>
            <Link to="/pipeline" className="btn"><Icon name="pipeline" size={16} />Sales board</Link>
            {canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>New quote</Button>}
          </>
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search by title, client or #number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search quotes" />
        </div>
        <div className="tabs" role="group" aria-label="Filter quotes">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
      </div>
      {quotes.error && !quotes.data ? (
        <div className="card"><ErrorState error={quotes.error} onRetry={() => quotes.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term ? (
            <EmptyState icon="search" title="No quotes match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : templates ? (
            <EmptyState icon="quote" title="No quote templates yet">On a quote, choose Save as template from its menu. New quotes can then start from it.</EmptyState>
          ) : (
            <EmptyState icon="quote" title={filter === "open" ? "No open quotes" : "Nothing here"} action={canSell && filter === "open" && <Button icon="plus" onClick={() => setParams({ new: "1" })}>New quote</Button>}>
              {filter === "open" ? "Quotes your clients can approve online, with optional add-ons and deposits." : "No quotes have this status."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={`card${quotes.isPlaceholderData ? " is-stale" : ""}`}>
          {templates ? (
            <table className="table table-stack">
              <thead><tr><th>Quote template</th><th className="num">Total</th><th>Changed</th></tr></thead>
              <tbody>
                {rows.map((q) => {
                  const price = listPrice(q);
                  return (
                    <tr key={q.id} className="row-link" onClick={() => navigate(`/quotes/${q.id}`)}>
                      <td><Link className="cell-link" to={`/quotes/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.title}</Link></td>
                      <td className="num">{price.from ? `From ${formatMoney(price.amount)}` : formatMoney(price.amount)}</td>
                      <td title={formatDate(q.updated_at)}>{timeAgo(q.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <>
              {selectable && (
                <SelectionBar selection={selection} noun="quotes">
                  <Button size="sm" icon="archive" onClick={() => void archive()}>Archive</Button>
                </SelectionBar>
              )}
              <table className="table table-stack">
                <thead><tr>{selectable && <SelectAllCell selection={selection} label="Select all quotes on this page" />}<th>#</th><th>Quote</th><th className="num">Total</th><th>Sent</th><th>Status</th></tr></thead>
                <tbody>
                  {rows.map((q) => {
                    const note = optionsNote(q.status, q.options.length, q.option);
                    const price = listPrice(q);
                    return (
                      <tr key={q.id} className="row-link" data-selected={selection.has(q.id) || undefined} onClick={() => navigate(`/quotes/${q.id}`)}>
                        {selectable && <SelectCell selection={selection} id={q.id} label={`Select quote #${q.number}`} />}
                        <td className="muted tabular" style={{ width: 56 }}>#{q.number}</td>
                        <td>
                          <Link className="cell-link" to={`/quotes/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.title}</Link>
                          <div className="muted small">{q.client?.display_name}</div>
                        </td>
                        <td className="num">
                          {price.from ? <span title="Its cheapest option">From {formatMoney(price.amount)}</span> : formatMoney(price.amount)}
                          {note && <div className="muted small">{note}</div>}
                        </td>
                        <td title={q.sent_at ? formatDate(q.sent_at) : undefined}>{q.sent_at ? timeAgo(q.sent_at) : <span className="muted">—</span>}</td>
                        <td><EntityStatus kind="quote" status={q.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
          <div className="list-foot">
            <span>{rows.length} {templates ? (rows.length === 1 ? "quote template" : "quote templates") : rows.length === 1 ? "quote" : "quotes"}</span>
            {!templates && <strong className="tabular" style={{ color: "var(--ink)" }}>{formatMoney(total)}</strong>}
          </div>
        </div>
      )}
      <NewQuoteDialog open={params.get("new") === "1"} initialTemplate={params.get("template")} onClose={() => setParams({}, { replace: true })} onCreated={(id) => navigate(`/quotes/${id}`)} />
    </>
  );
}
