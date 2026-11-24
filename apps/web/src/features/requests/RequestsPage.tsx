import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, RowAge, RowPerson, type GroupTone } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, SortMenu, Toolbar } from "@/components/ui/Toolbar";
import { api, searchTerm, supabase } from "@/lib/api";
import { dateIn, weekStartOf } from "@/lib/format";
import { titleOrClientFilter, useStatusCounts } from "@/lib/listing";
import { firstRows } from "@/lib/paging";
import { can, hasRole, useSession, type Session } from "@/lib/session";
import { askedFor, BookAskedTime } from "./AskedTime";
import { NewRequestDialog } from "./NewRequestDialog";

// A tab for one status says it as the status pill does.
const FILTERS = [
  { key: "open", label: "Open", statuses: ["new", "assessment_scheduled", "assessment_complete"] },
  { key: "new", label: statusText("request", "new"), statuses: ["new"] },
  { key: "assessment", label: "Assessments", statuses: ["assessment_scheduled", "assessment_complete"] },
  { key: "done", label: "Quoted or converted", statuses: ["quoted", "converted"] },
  { key: "archived", label: statusText("request", "archived"), statuses: ["archived"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
] as const;
type SortKey = (typeof SORTS)[number]["value"];
/** How many requests the list shows at first, and how many more each "Load more" brings. */
const PAGE = 200;
const DAY = 86_400_000;

/**
 * The first `limit` requests with some statuses, newest first (oldest first with `oldest`), and how
 * many there are in all (`total`). `term` narrows them to a request number, or a title or client that
 * has it; `fromWebsite` to the ones a website form sent.
 */
export async function loadRequests({ companyId, statuses, term, fromWebsite, oldest = false }: { companyId: string; statuses: readonly string[]; term: string; fromWebsite: boolean; oldest?: boolean }, limit: number) {
  const match = term && !/^\d+$/.test(term) ? await titleOrClientFilter(companyId, term) : null;
  const { rows, total } = await firstRows(
    () => {
      let q = supabase()
        .from("requests")
        .select("id, number, title, status, source, website_form_id, assigned_to, created_at, asked_starts_at, asked_ends_at, client:clients(id, display_name), property:properties(line1, city)", { count: "exact" })
        .eq("company_id", companyId)
        .in("status", [...statuses]);
      if (fromWebsite) q = q.not("website_form_id", "is", null);
      if (term) q = match ? q.or(match) : q.eq("number", Number(term));
      return q;
    },
    limit,
    { order: { column: "created_at", ascending: oldest } },
  );
  return { rows, total: total ?? rows.length };
}

export const REQUEST_SOURCES: Record<string, string> = { web_form: "Booking form", phone: "Phone", email: "Email", hub: "Client Hub", manual: "In person", assistant: "AI assistant", referral: "Referral" };
/** The small icon before where a request came from, in its row and on its page. */
export const SOURCE_ICONS: Record<string, IconName> = { web_form: "calendar", phone: "phone", email: "mail", hub: "user", manual: "users", assistant: "sparkle", referral: "gift" };

/** Where a request came from, as people say it: a message from a website form (Apps → Website Forms) is a web_form request too. */
export const requestSource = (r: { source: string; website_form_id?: string | null }) => (r.website_form_id ? "Website form" : (REQUEST_SOURCES[r.source] ?? r.source));

/** The team, for who a request is assigned to (the same list as Settings → People). */
export interface TeamMember { user_id: string; role: string; active: boolean; profile: { full_name: string; email?: string | null } | null }
export const useTeam = (companyId: string) => useQuery({ queryKey: ["team", companyId], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
export const memberName = (m: TeamMember | undefined) => (m ? m.profile?.full_name || m.profile?.email || "Team member" : null);

/** Who can log a request: the roles the database lets add one (requests_insert). */
export const canLogRequests = (session: Pick<Session, "role">) => hasRole(session, "admin", "office", "estimator");

type RequestRow = Awaited<ReturnType<typeof loadRequests>>["rows"][number];
type Group = { key: string; label: string; tone?: GroupTone; icon?: IconName; rows: RequestRow[] };

/** A new request nobody has answered in two days. */
const waiting = (r: RequestRow, now: number) => r.status === "new" && now - Date.parse(r.created_at) > 2 * DAY;

/**
 * What needs doing first: new requests waiting over two days, then the rest by when they came in
 * (today, this week, earlier), in the company's time zone and the list's order.
 */
export function groupRequests(rows: RequestRow[], timeZone: string, now = Date.now()): Group[] {
  const today = dateIn(new Date(now), timeZone);
  const weekStart = weekStartOf(today);
  const groups = new Map<string, Group>([["waiting", { key: "waiting", label: "Waiting over 2 days", tone: "warning", icon: "clock", rows: [] }]]);
  for (const r of rows) {
    const day = dateIn(r.created_at, timeZone);
    const key = waiting(r, now) ? "waiting" : day === today ? "today" : day >= weekStart ? "week" : "earlier";
    if (!groups.has(key)) groups.set(key, { key, label: key === "today" ? "Today" : key === "week" ? "This week" : "Earlier", rows: [] });
    groups.get(key)!.rows.push(r);
  }
  return [...groups.values()].filter((g) => g.rows.length);
}

export function RequestsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "open");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search));
  // ?new=1 opens the form only for people who can log a request: the installed app's "New request"
  // shortcut is on everyone's phone, and the crew get Requests without a form they can't save.
  const creating = params.get("new") === "1" && canLogRequests(session);
  // ?from=website: only messages from website forms (Apps → Website Forms opens Requests this way).
  const fromWebsite = params.get("from") === "website";
  const sort: SortKey = params.get("sort") === "oldest" ? "oldest" : "newest";
  const setParam = (name: string, value: string | null) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value === null) next.delete(name);
      else next.set(name, value);
      return next;
    }, { replace: true });
  const setCreating = (on: boolean) => setParam("new", on ? "1" : null);
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const counts = useStatusCounts("requests", session.company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const team = useTeam(session.company.id);
  const timeZone = session.company.timezone;

  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [filter, term, fromWebsite, sort]);

  const requests = useQuery({
    queryKey: ["requests", session.company.id, filter, term, fromWebsite, sort, limit],
    placeholderData: keepPreviousData,
    queryFn: () => loadRequests({ companyId: session.company.id, statuses, term, fromWebsite, oldest: sort === "oldest" }, limit),
  });

  if (requests.isPending) return <InboxPageSkeleton tabs={5} groups={2} />;
  const rows = requests.data?.rows ?? [];
  const total = requests.data?.total ?? 0;
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Requests"
        actions={
          <>
            {canSell && <Link to="/pipeline" className="btn"><Icon name="pipeline" size={16} />Sales board</Link>}
            {canSell && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New request</Button>}
          </>
        }
      />
      <Toolbar
        filters={
          <FilterTabs
            label="Filter requests"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: counts.data && !fromWebsite ? counts.data[f.key] : undefined }))}
          />
        }
        search={<SearchField value={search} onChange={setSearch} placeholder="Search by client or #number" label="Search requests" />}
        tools={<SortMenu value={sort} onChange={(s) => setParam("sort", s === "oldest" ? s : null)} options={[...SORTS]} />}
      >
        {fromWebsite && (
          <button type="button" className="chip" aria-label="Show requests from everywhere" onClick={() => setParam("from", null)}>
            From website forms <Icon name="x" size={12} />
          </button>
        )}
      </Toolbar>
      {requests.error && !requests.data ? (
        <ErrorState error={requests.error} onRetry={() => requests.refetch()} />
      ) : rows.length === 0 ? (
        term ? (
          <EmptyState icon="search" title="No requests match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : fromWebsite ? (
          <EmptyState icon="requests" title="Nothing from your website forms here" action={<Button onClick={() => setParam("from", null)}>Show everything</Button>}>
            Messages people send with your website's forms show up here as they arrive.
          </EmptyState>
        ) : (
          <EmptyState icon="requests" title={filter === "open" ? "No open requests" : "Nothing here"} action={canSell && filter === "open" && (<><Button icon="plus" onClick={() => setCreating(true)}>New request</Button><Link className="btn" to="/booking">Set up online booking</Link></>)}>
            {filter === "open" ? "Requests from your booking and website forms, the Client Hub and referrals land here, along with ones you log by phone." : "No requests have this status."}
          </EmptyState>
        )
      ) : (
        <InboxList
          label="Requests"
          className="il-plain"
          stale={requests.isPlaceholderData}
          foot={
            <ListFoot more={rows.length < total ? { onClick: () => setLimit((l) => l + PAGE), loading: requests.isFetching } : undefined}>
              {rows.length < total ? `Showing ${rows.length} of ${total}` : `${rows.length} ${rows.length === 1 ? "request" : "requests"}`}
            </ListFoot>
          }
        >
          {groupRequests(rows, timeZone, now).map((g) => (
            <InboxGroup key={g.key} label={g.label} count={g.rows.length} tone={g.tone} icon={g.icon}>
              {g.rows.map((r) => {
                const when = askedFor(r, timeZone);
                const assessment = r.status === "assessment_scheduled" || r.status === "assessment_complete";
                const source = SOURCE_ICONS[r.website_form_id ? "" : r.source] ?? "globe";
                return (
                  <InboxRow
                    key={r.id}
                    to={`/requests/${r.id}`}
                    title={r.client?.display_name ?? r.title}
                    number={r.number}
                    subject={r.client ? r.title : undefined}
                    unread={r.status === "new" ? statusText("request", "new") : undefined}
                    badge={assessment ? <span className="il-note"><Icon name="calendar" size={13} />{statusText("request", r.status)}</span> : undefined}
                    meta={[
                      r.status !== "new" && !assessment && <EntityStatus kind="request" status={r.status} />,
                      <span><Icon name={source} size={13} />{requestSource(r)}</span>,
                      r.property?.line1,
                      // A time picked online that waits for the office's OK, with one press to book it.
                      when && <span className="meta-break"><span className="il-ask">Asked for {when}</span>{canSell && <BookAskedTime request={r} size="sm" />}</span>,
                    ]}
                    aside={
                      <>
                        <RowAge at={r.created_at} tone={waiting(r, now) ? "warning" : undefined} timeZone={timeZone} />
                        <RowPerson name={memberName(team.data?.find((m) => m.user_id === r.assigned_to))} empty="No salesperson yet" />
                      </>
                    }
                  />
                );
              })}
            </InboxGroup>
          ))}
        </InboxList>
      )}
      <NewRequestDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/requests/${id}`); }} />
    </>
  );
}
