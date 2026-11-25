import { autopaySettings } from "@crewtavo/core/autopay";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, type GroupTone } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { SelectionBar, useSelection } from "@/components/ui/Selection";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { api, searchTerm, supabase, unwrap } from "@/lib/api";
import { BULK_CHUNK, inChunks, reportBulk, type BulkResult } from "@/lib/bulk";
import { downloadCsv, toCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import { addDaysIso, dateLocale, formatMoney, timeAgo, todayIn } from "@/lib/format";
import { useStatusCounts } from "@/lib/listing";
import { everyRow, firstRows } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import { ChargeCardsDialog, InvoiceNudges, InvoiceSummary, RemindAllButton } from "./InvoiceTools";
import styles from "./invoices.module.css";

// Each filter is named for its status ("open" is everything still owed, under the sent status's name).
const FILTERS = [
  { key: "open", label: statusText("invoice", "sent"), statuses: ["sent", "partially_paid", "overdue"] },
  { key: "overdue", label: statusText("invoice", "overdue"), statuses: ["overdue"] },
  { key: "draft", label: statusText("invoice", "draft"), statuses: ["draft"] },
  { key: "paid", label: statusText("invoice", "paid"), statuses: ["paid"] },
  { key: "written_off", label: statusText("invoice", "written_off"), statuses: ["written_off"] },
  { key: "void", label: statusText("invoice", "void"), statuses: ["void"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
/** The filters whose counts are worth a look: what's owed and what's waiting to go out. Settled ones are history. */
const COUNTED: readonly FilterKey[] = ["open", "overdue", "draft"];
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
/** Sent and still owed: what a payment reminder is for (services/sales.ts remindInvoices). */
const OWED = ["sent", "partially_paid", "overdue"];
const DAY = 86_400_000;

type Remindable = { id: string; number: number | null; status: string; balance_due: number };

/**
 * Payment reminders for the picked invoices, BULK_CHUNK at a time (POST /invoices/remind). Only ones
 * still owed are sent, as the server does. The server says which it skipped and why; one it leaves
 * out without a word (paid since the list loaded) is looked up with `stillOwed`. A chunk that fails
 * says so for each in it and isn't tried again, since some of its emails may have gone.
 */
export async function remindInChunks(
  rows: readonly Remindable[],
  post: (ids: string[]) => Promise<{ sent: number; skipped: Array<{ number: number | null; reason: string }> }>,
  stillOwed: (ids: string[]) => Promise<string[]>,
): Promise<BulkResult> {
  const due = rows.filter((i) => OWED.includes(i.status) && Number(i.balance_due) > 0);
  const result: BulkResult = { done: [], failed: rows.filter((i) => !due.includes(i)).map((i) => ({ id: i.id, reason: i.status === "draft" ? "Not sent yet" : "Nothing owed on it" })) };
  for (let k = 0; k < due.length; k += BULK_CHUNK) {
    const chunk = due.slice(k, k + BULK_CHUNK);
    try {
      const r = await post(chunk.map((i) => i.id));
      const refused = new Map(r.skipped.map((x) => [x.number, x.reason]));
      result.failed.push(...chunk.filter((i) => refused.has(i.number)).map((i) => ({ id: i.id, reason: refused.get(i.number)! })));
      let rest = chunk.filter((i) => !refused.has(i.number));
      if (rest.length > r.sent) {
        const owed = new Set(await stillOwed(rest.map((i) => i.id)));
        result.failed.push(...rest.filter((i) => !owed.has(i.id)).map((i) => ({ id: i.id, reason: "Nothing owed on it any more" })));
        rest = rest.filter((i) => owed.has(i.id));
      }
      result.done.push(...rest.map((i) => i.id));
    } catch (error) {
      result.failed.push(...chunk.map((i) => ({ id: i.id, reason: errorMessage(error) })));
    }
  }
  return result;
}

/** How many invoices the list shows at first, and how many more each "Load more" brings. */
const PAGE = 300;
const LIST_COLUMNS = "id, number, kind, status, subject, issued_on, due_on, total, balance_due, client:clients(display_name), opened:hub_opens(last_at)";

/** The invoices a tab shows: its statuses, narrowed by what was typed. `settled`: paid, written off or void. */
export interface Showing { companyId: string; statuses: readonly string[]; term: string; settled: boolean }

/** What was typed as a filter: the subject has it, or the client's name does. Null for nothing typed, or for a number (an invoice's own). */
async function typedFilter({ companyId, term }: Showing): Promise<string | null> {
  if (!term || /^\d+$/.test(term)) return null;
  const { data } = await supabase().from("clients").select("id").eq("company_id", companyId).ilike("display_name", `%${term}%`).limit(60);
  const ids = (data ?? []).map((c) => c.id);
  return [`subject.ilike.%${term}%`, ids.length ? `client_id.in.(${ids.join(",")})` : null].filter(Boolean).join(",");
}

// Settled ones (paid, written off, void) newest first; ones still owed by when they're due.
const listOrder = ({ settled }: Showing) => ({ column: settled ? "issued_on" : "due_on", ascending: !settled, nullsFirst: false });

/** The first `limit` invoices of a tab, and how many it has in all (`total`). */
export async function loadInvoices(showing: Showing, limit: number) {
  const match = await typedFilter(showing);
  const { rows, total } = await firstRows(
    () => {
      let q = supabase().from("invoices").select(LIST_COLUMNS, { count: "exact" }).eq("company_id", showing.companyId).in("status", [...showing.statuses]);
      if (showing.term) q = match ? q.or(match) : q.eq("number", Number(showing.term));
      return q;
    },
    limit,
    { order: listOrder(showing) },
  );
  return { rows, total: total ?? rows.length };
}

/** Every invoice of a tab, for the spreadsheet: all of them, not only the ones the list has loaded. */
export async function everyInvoice(showing: Showing) {
  const match = await typedFilter(showing);
  return everyRow(
    () => {
      let q = supabase().from("invoices").select(LIST_COLUMNS).eq("company_id", showing.companyId).in("status", [...showing.statuses]);
      if (showing.term) q = match ? q.or(match) : q.eq("number", Number(showing.term));
      return q;
    },
    { order: listOrder(showing), most: Infinity },
  );
}

/** What every invoice of a tab adds up to, for the list's last line while it hasn't loaded them all. */
export async function invoiceTotals(showing: Showing) {
  const match = await typedFilter(showing);
  const rows = await everyRow(() => {
    let q = supabase().from("invoices").select("total, balance_due").eq("company_id", showing.companyId).in("status", [...showing.statuses]);
    if (showing.term) q = match ? q.or(match) : q.eq("number", Number(showing.term));
    return q;
  });
  return { billed: rows.reduce((s, i) => s + Number(i.total), 0), owed: rows.reduce((s, i) => s + Number(i.balance_due), 0) };
}

type ListedInvoice = { status: string; due_on: string | null; issued_on: string; total: number | string; balance_due: number | string };

/** How many days past its due date an invoice still owed is today (in the company's time zone); 0 when it isn't late. */
export function daysLate(i: Pick<ListedInvoice, "status" | "due_on" | "balance_due">, today: string): number {
  if (!i.due_on || Number(i.balance_due) <= 0 || !OWED.includes(i.status) || i.due_on >= today) return 0;
  return Math.round((Date.parse(today) - Date.parse(i.due_on)) / DAY);
}

/** "9 days late", "2 weeks late", "3 months late": how long a list row's wait has been, short. */
export function lateWords(days: number): string {
  if (days < 14) return plural(days, "day") + " late";
  if (days < 60) return `${Math.floor(days / 7)} weeks late`;
  return `${Math.floor(days / 30)} months late`;
}

/** "Nov 12", with the year when it isn't this one. */
const shortDate = (iso: string, today: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), iso.slice(0, 4) === today.slice(0, 4) ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });

/** The words a kind other than a plain invoice gets beside its number. */
const KIND_TAGS: Record<string, string> = { deposit: "Deposit", progress: "Progress", retainage: "Retainage", visits: "Visits" };

type Group<T> = { key: string; label: string; tone?: GroupTone; icon?: IconName; rows: T[] };

/**
 * The rows of a tab, grouped by what needs doing (in the list's order inside each group): still owed,
 * the past due first, then the rest awaiting payment; drafts, the ones ready to send first; and
 * settled ones by the month they were issued. Empty groups are left out.
 */
export function groupInvoices<T extends ListedInvoice>(rows: readonly T[], filter: FilterKey, today: string): Group<T>[] {
  const thisMonth = today.slice(0, 7);
  const lastMonth = addDaysIso(`${thisMonth}-01`, -1).slice(0, 7);
  const order: Array<Omit<Group<T>, "rows">> =
    filter === "open" || filter === "overdue"
      ? [{ key: "late", label: statusText("invoice", "overdue"), tone: "danger", icon: "clock" }, { key: "owed", label: statusText("invoice", "sent") }]
      : filter === "draft"
        ? [{ key: "ready", label: "Ready to send", tone: "good", icon: "send" }, { key: "empty", label: "No line items yet" }]
        : [{ key: "this", label: "This month" }, { key: "last", label: "Last month" }, { key: "earlier", label: "Earlier" }];
  const groups = new Map(order.map((g) => [g.key, { ...g, rows: [] as T[] }]));
  for (const r of rows) {
    const key =
      filter === "open" || filter === "overdue"
        ? daysLate(r, today) > 0 || r.status === "overdue" ? "late" : "owed"
        : filter === "draft"
          ? Number(r.total) !== 0 ? "ready" : "empty"
          : r.issued_on.slice(0, 7) === thisMonth ? "this" : r.issued_on.slice(0, 7) === lastMonth ? "last" : "earlier";
    groups.get(key)!.rows.push(r);
  }
  return [...groups.values()].filter((g) => g.rows.length);
}

export function InvoicesPage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <InvoicesPageScreen /> : <NoAccess title="Invoices" />;
}

function InvoicesPageScreen() {
  const session = useSession();
  const { company } = session;
  // Autopay's charges carry what clients owe: for the people who look after money.
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  // Charge cards: only while the company charges clients' saved cards (Settings → Payments).
  const chargesCards = seesMoney && autopaySettings(company.settings, company.trade_preset).enabled;
  const [charging, setCharging] = useState(false);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "open");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search));
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  // Settled ones (paid, written off, void) newest first; ones still owed by when they're due.
  const settled = filter === "paid" || filter === "written_off" || filter === "void";
  const counts = useStatusCounts("invoices", company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const today = todayIn(company.timezone);
  const queryClient = useQueryClient();
  // Picking several: reminders for ones still owed (by email, as Remind all), and drafts marked as sent.
  const remindable = (filter === "open" || filter === "overdue") && session.config.features.email;
  const selectable = remindable || filter === "draft";

  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, term]);
  const showing: Showing = { companyId: company.id, statuses, term, settled };
  const invoices = useQuery({
    queryKey: ["invoices", company.id, filter, term, limit],
    placeholderData: keepPreviousData,
    queryFn: () => loadInvoices(showing, limit),
  });
  const rows = invoices.data?.rows ?? [];
  const total = invoices.data?.total ?? 0;
  // The last line adds up every invoice in the tab. While the list hasn't loaded them all, that's read on its own.
  const partial = rows.length < total;
  const sums = useQuery({
    queryKey: ["invoices", company.id, filter, term, "totals"],
    enabled: partial,
    meta: { silent: true },
    queryFn: () => invoiceTotals(showing),
  });
  // The spreadsheet has every invoice in the tab, read again from the first to the last.
  const exportCsv = useMutation({
    meta: { success: (n: number) => `Exported ${plural(n, "invoice")}` },
    mutationFn: async () => {
      const all = await everyInvoice(showing);
      downloadCsv(
        `invoices-${filter}-${today}.csv`,
        toCsv(
          all.map((i) => ({ ...i, client: i.client?.display_name ?? "" })),
          [
            { key: "number", label: "Invoice" }, { key: "client", label: "Client" }, { key: "subject", label: "Subject" }, { key: "status", label: "Status" },
            { key: "issued_on", label: "Issued" }, { key: "due_on", label: "Due" }, { key: "total", label: "Total" }, { key: "balance_due", label: "Balance due" },
          ],
        ),
      );
      return all.length;
    },
  });

  const selection = useSelection(selectable ? rows.map((i) => i.id) : [], `${filter}|${term}`);
  const words = (verb: string, one = "invoice") => {
    const numbers = new Map(rows.map((i) => [i.id, i.number]));
    return { verb, one, many: `${one}s`, name: (id: string) => `#${numbers.get(id) ?? "?"}` };
  };
  const remind = useMutation({
    mutationFn: (picked: Remindable[]) =>
      remindInChunks(
        picked,
        (ids) => api.post("/invoices/remind", { invoice_ids: ids }),
        async (ids) => unwrap(await supabase().from("invoices").select("id").in("id", ids).in("status", OWED).gt("balance_due", 0)).map((i) => i.id),
      ),
    onSuccess: (result) => {
      reportBulk(result, words("sent", "reminder"), { tone: "invoice" });
      selection.clear();
    },
  });
  // As on an invoice's page: a draft is marked as sent once it has a line, and the database refuses one being charged.
  const markSent = useMutation({
    mutationFn: async (ids: string[]) => {
      const lined = new Set<string>();
      for (let k = 0; k < ids.length; k += BULK_CHUNK) {
        const found = unwrap(await supabase().from("invoices").select("id, invoice_line_items!inner(id)").in("id", ids.slice(k, k + BULK_CHUNK)).limit(1, { referencedTable: "invoice_line_items" }));
        for (const i of found) lined.add(i.id);
      }
      const empty: BulkResult = { done: [], failed: ids.filter((id) => !lined.has(id)).map((id) => ({ id, reason: "No line items yet" })) };
      const sent = await inChunks(
        ids.filter((id) => lined.has(id)),
        async (chunk) => unwrap(await supabase().from("invoices").update({ status: "sent" }).in("id", chunk).eq("status", "draft").select("id")).map((i) => i.id),
      );
      return { done: sent.done, failed: [...empty.failed, ...sent.failed] };
    },
    onSuccess: (result) => {
      reportBulk(result, words("marked as sent"), { tone: "invoice" });
      selection.clear();
      void queryClient.invalidateQueries({ queryKey: ["invoices", company.id] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  if (invoices.isPending) return <InboxPageSkeleton tabs={FILTERS.length} groups={2} />;
  // Of every invoice in the tab: added up here once they're all loaded, else as read apart (nothing until that's in).
  const figures = partial ? sums.data : { billed: rows.reduce((s, i) => s + Number(i.total), 0), owed: rows.reduce((s, i) => s + Number(i.balance_due), 0) };
  // What the foot's right side adds up: what's owed, or written off. Drafts, paid and void ones owe nothing yet or any more.
  const owedWord = filter === "open" || filter === "overdue" ? "owed" : filter === "written_off" ? "written off" : null;

  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          <>
            <Menu
              title="Invoices"
              items={[
                { label: "Charge cards", icon: "card", onSelect: () => setCharging(true), hidden: !chargesCards },
                { separator: true, hidden: !chargesCards },
                { label: "Stripe deposits", icon: "bank", onSelect: () => navigate("/payouts") },
                { label: exportCsv.isPending ? "Exporting…" : "Download as spreadsheet", icon: "download", onSelect: () => exportCsv.mutate(), disabled: !rows.length || exportCsv.isPending },
              ]}
            />
            <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>New invoice</Button>
          </>
        }
      />
      <InvoiceSummary onPick={setFilter} />
      <InvoiceNudges autopay={seesMoney} />
      <Toolbar
        filters={
          <FilterTabs
            label="Filter invoices"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: COUNTED.includes(f.key) ? counts.data?.[f.key] : undefined, countTone: f.key === "overdue" ? "danger" : undefined }))}
          />
        }
        search={<SearchField value={search} onChange={setSearch} placeholder="Search client, subject or #" label="Search invoices" />}
      />
      {invoices.error && !invoices.data ? (
        <ErrorState error={invoices.error} onRetry={() => invoices.refetch()} />
      ) : rows.length === 0 ? (
        term ? (
          <EmptyState icon="search" title="No invoices match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : (
          <EmptyState icon="invoice" title={filter === "open" ? "Nothing awaiting payment" : filter === "overdue" ? "Nothing past due" : "Nothing here"} action={filter === "open" && <Link className="btn" to="/jobs">Find jobs to invoice</Link>}>
            {filter === "open"
              ? "Invoice finished jobs from the job page, or create a standalone invoice."
              : filter === "overdue"
                ? "Every sent invoice is within its terms."
                : filter === "written_off"
                  ? "When a client is never going to pay, open the invoice and choose Write off from its menu."
                  : "No invoices have this status."}
          </EmptyState>
        )
      ) : (
        <>
          {selectable && (
            <SelectionBar selection={selection} noun="invoices" always>
              {filter === "draft" ? (
                <Button
                  size="sm"
                  icon="check"
                  loading={markSent.isPending}
                  onClick={async () => {
                    const ids = selection.ids;
                    if (await confirm({ title: `Mark ${plural(ids.length, "draft")} as sent?`, body: "They count as sent and owed. Nothing is emailed to the clients.", confirmLabel: "Mark as sent" })) markSent.mutate(ids);
                  }}
                >
                  Mark as sent
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon="send"
                  loading={remind.isPending}
                  onClick={async () => {
                    const picked = rows.filter((i) => selection.has(i.id));
                    const n = picked.filter((i) => Number(i.balance_due) > 0).length;
                    // None owed: nothing is sent, and the toast says why.
                    if (!n) return remind.mutate(picked);
                    if (await confirm({ title: `Email ${plural(n, "payment reminder")}?`, body: "Each client gets a friendly note with a link to view and pay.", confirmLabel: "Send reminders" })) remind.mutate(picked);
                  }}
                >
                  Send reminders
                </Button>
              )}
            </SelectionBar>
          )}
          <InboxList
            label="Invoices"
            className="il-plain"
            stale={invoices.isPlaceholderData}
            foot={
              <ListFoot
                end={figures && owedWord ? <><b>{formatMoney(figures.owed)}</b> {owedWord}</> : undefined}
                more={partial ? { onClick: () => setLimit((l) => l + PAGE), loading: invoices.isFetching } : undefined}
              >
                {partial ? `Showing ${rows.length} of ${total}` : plural(rows.length, "invoice")}{figures ? ` · ${formatMoney(figures.billed)} ${filter === "draft" ? "not sent yet" : filter === "void" ? "voided" : "billed"}` : ""}
              </ListFoot>
            }
          >
            {groupInvoices(rows, filter, today).map((g) => (
              <InboxGroup
                key={g.key}
                label={g.label}
                count={g.rows.length}
                tone={g.tone}
                icon={g.icon}
                // The past due all at once: a reminder to each, by email, as on an invoice's page.
                end={g.key === "late" ? <RemindAllButton ids={g.rows.filter((r) => Number(r.balance_due) > 0).map((r) => r.id)} /> : undefined}
              >
                {g.rows.map((i) => {
                  const late = daysLate(i, today);
                  const balance = Number(i.balance_due);
                  const owed = OWED.includes(i.status);
                  const shown = owed || i.status === "written_off" ? balance : Number(i.total);
                  return (
                    <InboxRow
                      key={i.id}
                      to={`/invoices/${i.id}`}
                      title={i.client?.display_name ?? `Invoice #${i.number}`}
                      number={i.number}
                      badge={KIND_TAGS[i.kind] ? <span className={`tag ${styles.kind}`}>{KIND_TAGS[i.kind]}</span> : undefined}
                      subject={i.subject}
                      meta={
                        owed
                          ? [
                              late > 0 ? (
                                <span className={styles.late}><Icon name="clock" size={13} /><span>{i.due_on && <span className="hide-mobile">Due {shortDate(i.due_on, today)} · </span>}{lateWords(late)}</span></span>
                              ) : (
                                <span><Icon name="clock" size={13} />{i.due_on ? `Due ${shortDate(i.due_on, today)}` : "Due on receipt"}</span>
                              ),
                              i.status === "partially_paid" && <EntityStatus kind="invoice" status={i.status} />,
                              // When the client last opened it in the Client Hub (hub_opens).
                              i.opened && `Opened ${timeAgo(i.opened.last_at)}`,
                            ]
                          : [
                              `Issued ${shortDate(i.issued_on, today)}`,
                              i.status === "draft" && (i.due_on ? `Due ${shortDate(i.due_on, today)}` : "Due on receipt"),
                            ]
                      }
                      aside={
                        <>
                          <span className={i.status === "void" ? `il-money ${styles.voided}` : "il-money"}>{formatMoney(shown)}</span>
                          {(owed || i.status === "written_off") && Math.abs(shown - Number(i.total)) >= 0.005 && <span className="il-sub">of {formatMoney(i.total)}</span>}
                        </>
                      }
                      selection={selectable ? selection : undefined}
                      id={i.id}
                      selectLabel={`Select invoice #${i.number}`}
                    />
                  );
                })}
              </InboxGroup>
            ))}
          </InboxList>
        </>
      )}
      {charging && <ChargeCardsDialog onClose={() => setCharging(false)} />}
      <NewInvoiceDialog open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} onCreated={(id) => navigate(`/invoices/${id}`)} />
    </>
  );
}

/** An invoice that isn't tied to a job: a product sale, a one-time charge. */
function NewInvoiceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const settings = company.settings as { payment_terms_days?: number; default_tax_rate?: number };
  const [client, setClient] = useState<PickedClient>(null);
  const [subject, setSubject] = useState("");
  // Said under the client picker once Create is pressed without one.
  const [noClient, setNoClient] = useState(false);
  const create = useMutation({
    meta: { inline: true, success: "Draft invoice created", tone: "invoice" },
    mutationFn: async () => {
      const today = todayIn(company.timezone);
      return unwrap(
        await supabase()
          .from("invoices")
          .insert({
            company_id: company.id,
            client_id: client!.id,
            subject: subject.trim() || null,
            issued_on: today,
            due_on: addDaysIso(today, Number(settings.payment_terms_days ?? 30)),
            tax_rate: Number(settings.default_tax_rate ?? 0),
          })
          .select("id")
          .single(),
      ).id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["invoices", company.id] });
      onCreated(id);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New invoice"
      onExited={() => {
        setClient(null);
        setSubject("");
        setNoClient(false);
        create.reset();
      }}
    >
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); else setNoClient(true); }}>
        <Field label="Client" error={noClient && !client ? "Choose who this invoice is for." : null}><ClientPicker value={client} onChange={setClient} /></Field>
        <Field label="Subject" optional><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} placeholder="Salt delivery, March services…" /></Field>
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create invoice</Button>
        </div>
      </form>
    </Dialog>
  );
}
