import { autopaySettings } from "@crewtavo/core/autopay";
import { isPlaceholderEmail } from "@crewtavo/core/email";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { archiveWithUndo, SelectionBar, useSelection } from "@/components/ui/Selection";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { FilterMenu, FilterTabs, SearchField, SortMenu, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, textFilter, unwrap } from "@/lib/api";
import { inChunks, reportBulk } from "@/lib/bulk";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, dateIn, todayIn } from "@/lib/format";
import { t } from "@/lib/i18n";
import { everyRow, firstRows } from "@/lib/paging";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { NewQuoteDialog } from "../quotes/NewQuoteDialog";
import { NewClientDialog, useClientTags } from "./ClientForm";
import styles from "./clients.module.css";
import { ContactMessagesNotice } from "./ContactMessages";
import { ImportClientsDialog } from "./ImportClientsDialog";
import { Select } from "@/components/ui/Select";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "lead", label: "Leads" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
  { key: "no_card", label: "Card not set up" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const SORTS = [
  { value: "name", label: "Name A–Z" },
  { value: "newest", label: "Newest first" },
] as const;
type SortKey = (typeof SORTS)[number]["value"];
const PAGE = 50;
/** What POST /clients/autopay/invite takes at once. */
const INVITE_CHUNK = 200;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The first `limit` clients of a tab, by name or newest first, and how many it has in all (`total`).
 * `term` narrows them to a name, company, email or phone that has it, and `tags` to clients with any
 * of those tags.
 */
export async function loadClients({ companyId, filter, term, tags, sort }: { companyId: string; filter: FilterKey; term: string; tags: readonly string[]; sort: SortKey }, limit: number) {
  const match = textFilter(term, ["display_name", "company_name", "email", "phone"]);
  const { rows, total } = await firstRows(
    () => {
      let q = supabase()
        .from("clients")
        .select("id, display_name, company_name, email, phone, status, tags, created_at, properties(line1, city, region), card:autopay_authorizations(id, revoked_at, method:client_payment_methods!inner(status))", { count: "exact" })
        .eq("company_id", companyId);
      // Card not set up: active clients with no agreement in force on a card that can be charged (active,
      // or a bank account being checked). An anti-join: a removed card, or one saved but not agreed to, counts.
      if (filter === "no_card") q = q.eq("status", "active").is("card.revoked_at", null).in("card.method.status", ["active", "pending"]).is("card", null);
      else q = filter === "all" ? q.neq("status", "archived") : q.eq("status", filter);
      if (match) q = q.or(match);
      if (tags.length) q = q.overlaps("tags", [...tags]);
      return q;
    },
    limit,
    { order: { column: sort === "name" ? "display_name" : "created_at", ascending: sort === "name" } },
  );
  return { rows, total: total ?? rows.length };
}

/** Every client with their first property, by name, for the spreadsheet. */
export const everyClient = (companyId: string) =>
  everyRow(
    () => supabase().from("clients").select("display_name, company_name, email, phone, status, lead_source, tags, created_at, properties(line1, city, region, postal_code)").eq("company_id", companyId),
    { order: "display_name", most: Infinity },
  );

type ClientRow = Awaited<ReturnType<typeof loadClients>>["rows"][number];
type Group = { key: string; label: string; rows: ClientRow[] };

/** The letter a name is filed under: its first letter without accents, or "#" for a number or symbol. */
export const nameLetter = (name: string) => {
  const first = name.trim().normalize("NFD").replace(/[̀-ͯ]/g, "").charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
};

/**
 * By name, the clients under their letter (A, B, C…), as an address book files them. Newest first,
 * under when they were added: this week, this month, earlier (in the company's time zone).
 */
export function groupClients(rows: readonly ClientRow[], sort: SortKey, timeZone: string): Group[] {
  const today = todayIn(timeZone);
  const weekStart = addDaysIso(today, -new Date(`${today}T12:00:00Z`).getUTCDay());
  const monthStart = `${today.slice(0, 8)}01`;
  const groups = new Map<string, Group>();
  for (const c of rows) {
    let key: string;
    let label: string;
    if (sort === "name") key = label = nameLetter(c.display_name);
    else {
      const day = dateIn(c.created_at, timeZone);
      key = day >= weekStart ? "week" : day >= monthStart ? "month" : "earlier";
      label = key === "week" ? "Added this week" : key === "month" ? "Earlier this month" : "Earlier";
    }
    if (!groups.has(key)) groups.set(key, { key, label, rows: [] });
    groups.get(key)!.rows.push(c);
  }
  return [...groups.values()];
}

/** A card they agreed to be charged on, that can be: what the Card not set up tab leaves out. */
const hasCard = (c: ClientRow) => c.card.some((a) => !a.revoked_at && (a.method?.status === "active" || a.method?.status === "pending"));

/** Tags in use on the tab's clients and how many have each, for the tag filter. */
function useTagCounts(filter: FilterKey) {
  const { company } = useSession();
  const scope = filter === "no_card" ? "active" : filter;
  return useQuery({
    queryKey: ["client-tags", company.id, "counts", scope],
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const rows = await everyRow(() => {
        const q = supabase().from("clients").select("id, tags").eq("company_id", company.id).not("tags", "eq", "{}");
        return scope === "all" ? q.neq("status", "archived") : q.eq("status", scope);
      }, { most: 20_000 });
      const counts = new Map<string, number>();
      for (const r of rows) for (const tag of r.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      return counts;
    },
  });
}

export function ClientsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const autopay = autopaySettings(session.company.settings, session.company.trade_preset);
  const money = hasRole(session, "admin", "office") && can(session, "invoices");
  // Card not set up: active clients with no card they agreed to that can be charged, for the office when every client needs one on file.
  const noCard = money && autopay.enabled && autopay.card_required;
  const filters = FILTERS.filter((f) => f.key !== "no_card" || noCard);
  const [filter, setFilter] = useState<FilterKey>(() => (filters.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "all");
  const [picked, setPicked] = useState<string[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [importing, setImporting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [tagging, setTagging] = useState<"add" | "remove" | null>(null);
  const [quoting, setQuoting] = useState<{ id: string; display_name: string } | null>(null);
  const queryClient = useQueryClient();
  const term = useDeferredValue(search.trim());
  const sort: SortKey = params.get("sort") === "newest" ? "newest" : "name";
  const setParam = (name: string, value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value === null) next.delete(name);
      else next.set(name, value);
      return next;
    }, { replace: true });
  const creating = params.get("new") === "1";
  const setCreating = (on: boolean) => setParam("new", on ? "1" : null);
  const canEdit = hasRole(session, "admin", "office", "estimator");
  const canSell = canEdit && can(session, "sales");
  // Archiving and restoring are the office's, as on a client's page.
  const isOffice = hasRole(session, "admin", "office");
  // Autopay invites are for the people who look after money, once the company has autopay on and can send.
  const invites = money && autopay.enabled && (session.config.features.email || session.config.features.sms);
  const tags = useClientTags();
  const tagCounts = useTagCounts(filter);
  const tagKey = picked.join("|");
  useEffect(() => setLimit(PAGE), [filter, tagKey, term, sort]);

  const counts = useQuery({
    queryKey: ["clients", session.company.id, "counts", noCard],
    meta: { silent: true },
    queryFn: async () => {
      const count = async (status?: string) => {
        let q = supabase().from("clients").select("id", { count: "exact", head: true }).eq("company_id", session.company.id);
        q = status ? q.eq("status", status) : q.neq("status", "archived");
        return (await q).count ?? 0;
      };
      const withoutCard = async () =>
        (await supabase().from("clients").select("id, card:autopay_authorizations(id, method:client_payment_methods!inner(status))", { count: "exact", head: true }).eq("company_id", session.company.id).eq("status", "active")
          .is("card.revoked_at", null).in("card.method.status", ["active", "pending"]).is("card", null)).count ?? 0;
      const [all, lead, active, archived, no_card] = await Promise.all([count(), count("lead"), count("active"), count("archived"), noCard ? withoutCard() : 0]);
      return { all, lead, active, archived, no_card } as Record<FilterKey, number>;
    },
  });
  // How many pairs Possible duplicates lists: the same read as that page, so opening it is instant.
  const duplicates = useQuery({
    queryKey: ["clients", session.company.id, "duplicates"],
    enabled: money && canEdit,
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("client_duplicates", { p_company: session.company.id })) as unknown as unknown[],
  });

  const listKey = ["clients", session.company.id, filter, term, tagKey, sort, limit];
  const clients = useQuery({
    queryKey: listKey,
    placeholderData: keepPreviousData,
    queryFn: () => loadClients({ companyId: session.company.id, filter, term, tags: picked, sort }, limit),
  });

  const exportCsv = useMutation({
    meta: { success: (n: number) => `Exported ${n} ${n === 1 ? "client" : "clients"}` },
    mutationFn: async () => {
      const rows = (await everyClient(session.company.id)).map((c) => ({
        ...c,
        tags: c.tags.join("; "),
        address: c.properties[0]?.line1 ?? "",
        city: c.properties[0]?.city ?? "",
        state: c.properties[0]?.region ?? "",
        zip: c.properties[0]?.postal_code ?? "",
        created_at: c.created_at.slice(0, 10),
      }));
      const csv = toCsv(rows, [
        { key: "display_name", label: "Name" }, { key: "company_name", label: "Company" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
        { key: "address", label: "Address" }, { key: "city", label: "City" }, { key: "state", label: "State" }, { key: "zip", label: "ZIP" },
        { key: "status", label: "Status" }, { key: "lead_source", label: "Lead source" }, { key: "tags", label: "Tags" }, { key: "created_at", label: "Added" },
      ]);
      downloadCsv(`clients-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      return rows.length;
    },
  });

  const data = clients.data;
  const isFiltered = Boolean(term || picked.length || filter !== "all");
  const rows = data?.rows ?? [];
  const selection = useSelection(rows.map((c) => c.id), `${filter}|${term}|${tagKey}|${sort}`);
  const chosen = rows.filter((c) => selection.has(c.id));
  const words = (verb: string) => {
    const names = new Map(rows.map((c) => [c.id, c.display_name]));
    return { verb, one: "client", many: "clients", name: (id: string) => names.get(id) ?? "A client" };
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["clients", session.company.id] });
  const archive = async () => {
    const ids = selection.ids;
    if (!(await confirm({ title: `Archive ${plural(ids.length, "client")}?`, body: "Archiving hides them from lists and keeps their records.", confirmLabel: "Archive" }))) return;
    selection.clear();
    archiveWithUndo<{ rows: typeof rows; total: number }>({
      key: listKey,
      ids,
      title: `${plural(ids.length, "client")} archived`,
      // No list but Archived shows archived clients, and Archive isn't offered there.
      hide: (d, gone) => ({ rows: d.rows.filter((c) => !gone.has(c.id)), total: d.total - d.rows.filter((c) => gone.has(c.id)).length }),
      write: async (chunk) => unwrap(await supabase().from("clients").update({ status: "archived" }).in("id", chunk).neq("status", "archived").select("id")).map((c) => c.id),
      words: words("archived"),
      refresh,
    });
  };
  const restore = useMutation({
    mutationFn: (ids: string[]) => inChunks(ids, async (chunk) => unwrap(await supabase().from("clients").update({ status: "active" }).in("id", chunk).eq("status", "archived").select("id")).map((c) => c.id)),
    onSuccess: (result) => {
      reportBulk(result, words("restored"));
      selection.clear();
      void refresh();
    },
  });
  const clearFilters = () => {
    setSearch("");
    setPicked([]);
    setFilter("all");
  };

  if (clients.isPending && !data) return <InboxPageSkeleton tabs={4} groups={2} />;

  // Tags known to the company, with how many of this tab's clients have each; any picked stay listed.
  const tagNames = [...new Set([...(tags.data ?? []), ...picked])].sort((a, b) => a.localeCompare(b));
  const duplicatePairs = duplicates.data?.length ?? 0;

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          canEdit && (
            <>
              <Menu
                label={money ? "More actions" : "Import and export"}
                title="Clients"
                items={[
                  { label: "Import from a spreadsheet", icon: "upload", onSelect: () => setImporting(true) },
                  { label: exportCsv.isPending ? "Exporting…" : "Download as spreadsheet", icon: "download", onSelect: () => exportCsv.mutate(), disabled: exportCsv.isPending },
                  // Merging moves invoices and payments, so it's for the people who look after money.
                  { separator: true, hidden: !money },
                  { label: "Possible duplicates", icon: "copy", end: duplicatePairs ? String(duplicatePairs) : undefined, onSelect: () => navigate("/clients/duplicates"), hidden: !money },
                  { label: "Send autopay invites", icon: "card", onSelect: () => setInviting(true), hidden: !invites },
                ]}
              />
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New client</Button>
            </>
          )
        }
      />
      <ContactMessagesNotice />
      <Toolbar
        filters={
          <FilterTabs
            label="Filter clients"
            value={filter}
            onChange={setFilter}
            // No archived clients is nothing to see: that tab says no number (Page-Clients.dc.html).
            options={filters.map((f) => ({ value: f.key, label: f.label, count: f.key === "archived" && !counts.data?.archived ? undefined : counts.data?.[f.key] }))}
          />
        }
        search={<SearchField value={search} onChange={setSearch} placeholder="Name, email or phone" label="Search clients" />}
        tools={
          <>
            {tagNames.length > 0 && (
              <FilterMenu
                // The one control speaks one language: its button, search and foot all go through t().
                label={picked.length ? t("Tags") : t("Any tag")}
                icon="tag"
                options={tagNames.map((name) => ({ value: name, label: name, count: tagCounts.data ? (tagCounts.data.get(name) ?? 0) : undefined }))}
                selected={picked}
                onChange={setPicked}
                searchPlaceholder={t("Find a tag")}
                summary={(n) => (n ? t.plural(n, { one: "{count} tag", other: "{count} tags" }) : t("None picked"))}
              />
            )}
            <SortMenu value={sort} onChange={(s) => setParam("sort", s === "newest" ? s : null)} options={[...SORTS]} />
          </>
        }
      />

      {clients.error && !data ? (
        <ErrorState error={clients.error} onRetry={() => clients.refetch()} />
      ) : data && data.rows.length === 0 ? (
        filter === "no_card" && !term && !picked.length ? (
          <EmptyState icon="card" title="Every active client has a card set up" />
        ) : isFiltered ? (
          <EmptyState icon="search" title="No clients match" action={<Button onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <EmptyState
            icon="clients"
            title="No clients yet"
            // New client in the header is the page's one green button; these are the two ways to start.
            action={canEdit && (<><Button icon="plus" onClick={() => setCreating(true)}>Add your first client</Button><Button icon="upload" onClick={() => setImporting(true)}>Import from a spreadsheet</Button></>)}
          >
            Everyone you work for, with their properties, work, notes and messages in one place.
          </EmptyState>
        )
      ) : (
        data && (
          <>
            {canEdit && (
              <SelectionBar selection={selection} noun="clients" always>
                <Button size="sm" icon="tag" onClick={() => setTagging("add")}>Add tag</Button>
                <Button size="sm" icon="tag" disabled={!chosen.some((c) => c.tags.length)} onClick={() => setTagging("remove")}>Remove tag</Button>
                {isOffice && filter === "archived" && (
                  <Button
                    size="sm"
                    icon="restore"
                    loading={restore.isPending}
                    onClick={async () => {
                      const ids = selection.ids;
                      if (await confirm({ title: `Restore ${plural(ids.length, "client")}?`, body: "They show in your lists again, as active clients.", confirmLabel: "Restore" })) restore.mutate(ids);
                    }}
                  >
                    Restore
                  </Button>
                )}
                {isOffice && filter !== "archived" && <Button size="sm" icon="archive" onClick={() => void archive()}>Archive</Button>}
              </SelectionBar>
            )}
            <InboxList
              label="Clients"
              className={sort === "name" ? `il-plain ${styles.list} ${styles.byLetter}` : `il-plain ${styles.list}`}
              stale={clients.isPlaceholderData}
              foot={
                <ListFoot more={data.rows.length < data.total ? { onClick: () => setLimit((l) => l + PAGE), loading: clients.isFetching } : undefined}>
                  {data.rows.length < data.total ? `Showing ${data.rows.length} of ${data.total}` : plural(data.total, "client")}
                </ListFoot>
              }
            >
              {groupClients(data.rows, sort, session.company.timezone).map((g) => (
                <InboxGroup key={g.key} label={g.label} count={g.rows.length}>
                  {g.rows.map((c) => {
                    const place = c.properties[0] ? [c.properties[0].line1, c.properties[0].city].filter(Boolean).join(", ") : null;
                    const reach = [c.email, c.phone].filter(Boolean).join(" · ");
                    return (
                      <InboxRow
                        key={c.id}
                        to={`/clients/${c.id}`}
                        title={c.display_name}
                        badge={c.company_name && c.company_name !== c.display_name ? <span className={styles.company}>{c.company_name}</span> : undefined}
                        subject={reach || undefined}
                        meta={[
                          place && (
                            <span className={styles.place}>
                              <Icon name="pin" size={13} />
                              <span>{place}</span>
                              {c.properties.length > 1 && <span className={styles.more}>+{c.properties.length - 1}</span>}
                            </span>
                          ),
                          c.tags.length > 0 && (
                            <span className={styles.tags}>
                              {c.tags.slice(0, 3).map((tag) => <span key={tag} className="tag">{tag}</span>)}
                              {c.tags.length > 3 && <span className="tag">+{c.tags.length - 3}</span>}
                            </span>
                          ),
                        ]}
                        aside={
                          <>
                            <EntityStatus kind="client" status={c.status} />
                            {noCard && filter !== "no_card" && c.status === "active" && !hasCard(c) && <span className="il-sub">No card on file</span>}
                          </>
                        }
                        actions={
                          <>
                            {canSell && c.status !== "archived" && <Button size="sm" onClick={() => setQuoting({ id: c.id, display_name: c.display_name })}>New quote</Button>}
                            {(c.email || c.phone) && <Link className="btn btn-sm btn-icon" to={`/messages?client=${c.id}`} aria-label={`Message ${c.display_name}`} title="Message"><Icon name="messages" size={15} /></Link>}
                            {c.phone && <a className="btn btn-sm btn-icon" href={`tel:${c.phone}`} aria-label={`Call ${c.display_name}`} title={`Call ${c.phone}`}><Icon name="phone" size={15} /></a>}
                          </>
                        }
                        selection={canEdit ? selection : undefined}
                        id={c.id}
                        selectLabel={`Select ${c.display_name}`}
                      />
                    );
                  })}
                </InboxGroup>
              ))}
            </InboxList>
          </>
        )
      )}

      <NewClientDialog open={creating} initialName={search.trim()} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/clients/${id}`)} />
      {quoting && <NewQuoteDialog open onClose={() => setQuoting(null)} initialClient={quoting} onCreated={(qid) => navigate(`/quotes/${qid}`)} />}
      {importing && <ImportClientsDialog onClose={() => setImporting(false)} />}
      {inviting && <AutopayInvitesDialog onClose={() => setInviting(false)} />}
      {tagging && (
        <TagClientsDialog
          mode={tagging}
          clients={chosen}
          onClose={() => setTagging(null)}
          onDone={() => {
            setTagging(null);
            selection.clear();
            void refresh();
            void queryClient.invalidateQueries({ queryKey: ["client-tags", session.company.id] });
          }}
        />
      )}
    </>
  );
}


/**
 * Send autopay invites to many clients at once: every active client not on autopay, or those with
 * one tag, by email or by text. The server skips anyone invited in the last 7 days and stops at the
 * company's hourly limit; the toast says how many went.
 */
function AutopayInvitesDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const { company } = session;
  const features = session.config.features;
  const tags = useClientTags();
  const [tag, setTag] = useState("");
  const [channel, setChannel] = useState<"email" | "sms">(features.email ? "email" : "sms");
  const who = useQuery({
    queryKey: ["clients", company.id, "autopay-invites", tag],
    queryFn: async () => {
      const [clients, agreed] = await Promise.all([
        // Everyone it could go to, however many: the server takes them a chunk at a time.
        everyRow(() => {
          let q = supabase().from("clients").select("id, email, phone").eq("company_id", company.id).eq("status", "active");
          if (tag) q = q.contains("tags", [tag]);
          return q;
        }, { most: Infinity }),
        everyRow(() => supabase().from("autopay_authorizations").select("client_id").eq("company_id", company.id).is("revoked_at", null), { most: Infinity }),
      ]);
      const on = new Set(agreed.map((a) => a.client_id));
      return clients.filter((c) => !on.has(c.id));
    },
  });
  const rows = who.data ?? [];
  const reachable = rows.filter((c) => (channel === "email" ? Boolean(c.email) && !isPlaceholderEmail(c.email) : Boolean(c.phone)));
  const send = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      let sent = 0;
      let skipped = rows.length - reachable.length;
      const ids = reachable.map((c) => c.id);
      for (let i = 0; i < ids.length; i += INVITE_CHUNK) {
        const r = await api.post<{ sent: number; skipped: number }>("/clients/autopay/invite", { client_ids: ids.slice(i, i + INVITE_CHUNK), channel });
        sent += r.sent;
        skipped += r.skipped;
      }
      return { sent, skipped };
    },
    onSuccess: (r) => {
      toast.success(`Sent ${r.sent}. Skipped ${r.skipped}.`);
      onClose();
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reachable.length) return;
    const ok = await confirm({
      title: `Send ${plural(reachable.length, "autopay invite")}?`,
      body: "Each client gets a link to save a card or bank account and agree to be charged after each visit. Anyone invited in the last 7 days is skipped.",
      confirmLabel: "Send invites",
    });
    if (ok) send.mutate();
  };
  const without = rows.length - reachable.length;

  return (
    <Dialog open onClose={onClose} title="Send autopay invites" description="A link to save a card and agree to automatic charges. Clients already on autopay aren't sent one.">
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="Who">
            <Select className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All active clients not on autopay</option>
              {tags.data?.map((t) => <option key={t} value={t}>Active clients tagged {t}</option>)}
            </Select>
          </Field>
          <Field label="Send by">
            <Select className="select" value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
              <option value="email" disabled={!features.email}>Email</option>
              <option value="sms" disabled={!features.sms}>Text</option>
            </Select>
          </Field>
        </div>
        <span className="muted small" role="status">
          {who.isPending
            ? "Counting clients…"
            : `${plural(rows.length, "client")} not on autopay${tag ? `, tagged ${tag}` : ""}.${without ? ` ${without} without ${channel === "email" ? "an email address" : "a phone number"} ${without === 1 ? "is" : "are"} skipped.` : ""}`}
        </span>
        <FormError error={send.error ?? who.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={who.isPending || !reachable.length}>
            {reachable.length ? `Send ${plural(reachable.length, "invite")}` : "Send invites"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Add a tag to the picked clients, or take one off. Only those it changes are sent: one that has
 * the tag already (or hasn't it, to take off) stays as it is. change_client_tags changes each
 * client's tags as they are in the database, so a tag added meanwhile isn't lost.
 */
function TagClientsDialog({ mode, clients, onClose, onDone }: { mode: "add" | "remove"; clients: Array<{ id: string; display_name: string; tags: string[] }>; onClose: () => void; onDone: () => void }) {
  const known = useClientTags();
  const listId = useId();
  const present = [...new Set(clients.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b));
  const [tag, setTag] = useState(mode === "remove" ? (present[0] ?? "") : "");
  const name = tag.trim();
  // Tags match whatever their case, as the tag field does.
  const has = (c: { tags: string[] }, t: string) => c.tags.some((x) => x.toLowerCase() === t.toLowerCase());
  const changing = name ? clients.filter((c) => has(c, name) === (mode === "remove")) : [];
  const save = useMutation({
    meta: { inline: true },
    mutationFn: () =>
      inChunks(
        changing.map((c) => c.id),
        async (chunk) => unwrap(await supabase().rpc("change_client_tags", mode === "add" ? { p_clients: chunk, p_add: name } : { p_clients: chunk, p_remove: name })),
      ),
    onSuccess: (result) => {
      const names = new Map(clients.map((c) => [c.id, c.display_name]));
      reportBulk(result, { verb: `${mode === "add" ? "tagged" : "untagged"} ${name}`, one: "client", many: "clients", name: (id) => names.get(id) ?? "A client" });
      onDone();
    },
  });
  const left = clients.length - changing.length;
  return (
    <Dialog open onClose={onClose} title={mode === "add" ? "Add a tag" : "Remove a tag"} description={`For the ${plural(clients.length, "client")} picked.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (changing.length) save.mutate(); }}>
        <Field label="Tag">
          {mode === "add" ? (
            <>
              <input className="input" list={listId} value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} required placeholder="VIP, Spring cleanup…" autoComplete="off" />
              <datalist id={listId}>{known.data?.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          ) : (
            <Select className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              {present.map((t) => <option key={t} value={t}>{t} · {plural(clients.filter((c) => has(c, t)).length, "client")}</option>)}
            </Select>
          )}
        </Field>
        {name && left > 0 && (
          <span className="muted small" role="status">
            {mode === "add" ? `${plural(left, "client")} ${left === 1 ? "has" : "have"} it already.` : `${plural(left, "client")} ${left === 1 ? "doesn't have" : "don't have"} it.`}
          </span>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="tag" loading={save.isPending} disabled={!changing.length}>
            {!changing.length ? (mode === "add" ? "Add tag" : "Remove tag") : mode === "add" ? `Add to ${plural(changing.length, "client")}` : `Take off ${plural(changing.length, "client")}`}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
