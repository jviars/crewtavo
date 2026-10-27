import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";
import { titleOrClientFilter, useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession, type Session } from "@/lib/session";
import { NewRequestDialog } from "./NewRequestDialog";

const FILTERS = [
  { key: "open", label: "Open", statuses: ["new", "assessment_scheduled", "assessment_complete"] },
  { key: "new", label: "New", statuses: ["new"] },
  { key: "assessment", label: "Assessments", statuses: ["assessment_scheduled", "assessment_complete"] },
  { key: "done", label: "Quoted or converted", statuses: ["quoted", "converted"] },
  { key: "archived", label: "Archived", statuses: ["archived"] },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export const REQUEST_SOURCES: Record<string, string> = { web_form: "Booking form", phone: "Phone", email: "Email", hub: "Client Hub", manual: "In person", assistant: "AI assistant", referral: "Referral" };

/** Where a request came from, as people say it: a message from a website form (Apps → Website Forms) is a web_form request too. */
export const requestSource = (r: { source: string; website_form_id?: string | null }) => (r.website_form_id ? "Website form" : (REQUEST_SOURCES[r.source] ?? r.source));

/** Who can log a request: the roles the database lets add one (requests_insert). */
export const canLogRequests = (session: Pick<Session, "role">) => hasRole(session, "admin", "office", "estimator");

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

  const requests = useQuery({
    queryKey: ["requests", session.company.id, filter, term, fromWebsite],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("requests")
        .select("id, number, title, status, source, website_form_id, created_at, client:clients(id, display_name), property:properties(line1, city)")
        .eq("company_id", session.company.id)
        .in("status", [...statuses])
        .order("created_at", { ascending: false })
        .limit(200);
      if (fromWebsite) q = q.not("website_form_id", "is", null);
      if (term) q = /^\d+$/.test(term) ? q.eq("number", Number(term)) : q.or(await titleOrClientFilter(session.company.id, term));
      return unwrap(await q);
    },
  });

  if (requests.isPending) return <ListPageSkeleton columns={5} tabs={5} />;
  const rows = requests.data ?? [];

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
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search by client or #number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search requests" />
        </div>
        <div className="tabs" role="group" aria-label="Filter requests">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && !fromWebsite && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        {fromWebsite && (
          <button type="button" className="chip" aria-label="Show requests from everywhere" onClick={() => setParam("from", null)}>
            From website forms <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {requests.error && !requests.data ? (
        <div className="card"><ErrorState error={requests.error} onRetry={() => requests.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term ? (
            <EmptyState icon="search" title="No requests match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : fromWebsite ? (
            <EmptyState icon="requests" title="Nothing from your website forms here" action={<Button onClick={() => setParam("from", null)}>Show everything</Button>}>
              Messages people send with your website's forms show up here as they arrive.
            </EmptyState>
          ) : (
            <EmptyState icon="requests" title={filter === "open" ? "No open requests" : "Nothing here"} action={canSell && filter === "open" && (<><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New request</Button><Link className="btn" to="/booking">Set up online booking</Link></>)}>
              {filter === "open" ? "Requests from your booking and website forms, the Client Hub and referrals land here, along with ones you log by phone." : "No requests have this status."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={`card${requests.isPlaceholderData ? " is-stale" : ""}`}>
          <table className="table table-stack">
            <thead><tr><th>#</th><th>Request</th><th>Client</th><th>Received</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/requests/${r.id}`)}>
                  <td className="muted tabular" style={{ width: 56 }}>#{r.number}</td>
                  <td>
                    <Link className="cell-link" to={`/requests/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="muted small">{requestSource(r)}{r.property ? ` · ${r.property.line1}` : ""}</div>
                  </td>
                  <td>{r.client?.display_name}</td>
                  <td title={formatDate(r.created_at)}>
                    {timeAgo(r.created_at)}
                    {r.status === "new" && Date.now() - Date.parse(r.created_at) > 2 * 86_400_000 && <div className="small text-danger strong">Waiting over 2 days</div>}
                  </td>
                  <td><EntityStatus kind="request" status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NewRequestDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/requests/${id}`); }} />
    </>
  );
}
