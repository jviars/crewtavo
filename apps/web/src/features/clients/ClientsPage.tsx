import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton, TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { hasRole, useSession } from "@/lib/session";
import { NewClientDialog, useClientTags } from "./ClientForm";
import { ImportClientsDialog } from "./ImportClientsDialog";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "lead", label: "Leads" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
const PAGE = 50;

export function ClientsPage() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "all");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<"name" | "newest">("name");
  const [limit, setLimit] = useState(PAGE);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [importing, setImporting] = useState(false);
  const term = useDeferredValue(searchTerm(search));
  const creating = params.get("new") === "1";
  const setCreating = (on: boolean) => setParams(on ? { new: "1" } : {}, { replace: true });
  const canEdit = hasRole(session, "admin", "office", "estimator");
  const tags = useClientTags();
  useEffect(() => setLimit(PAGE), [filter, tag, term, sort]);

  const counts = useQuery({
    queryKey: ["clients", session.company.id, "counts"],
    meta: { silent: true },
    queryFn: async () => {
      const count = async (status?: string) => {
        let q = supabase().from("clients").select("id", { count: "exact", head: true }).eq("company_id", session.company.id);
        q = status ? q.eq("status", status) : q.neq("status", "archived");
        return (await q).count ?? 0;
      };
      const [all, lead, active, archived] = await Promise.all([count(), count("lead"), count("active"), count("archived")]);
      return { all, lead, active, archived } as Record<FilterKey, number>;
    },
  });

  const clients = useQuery({
    queryKey: ["clients", session.company.id, filter, term, tag, sort, limit],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("clients")
        .select("id, display_name, company_name, email, phone, status, tags, created_at, properties(line1, city, region)", { count: "exact" })
        .eq("company_id", session.company.id)
        .order(sort === "name" ? "display_name" : "created_at", { ascending: sort === "name" })
        .limit(limit);
      q = filter === "all" ? q.neq("status", "archived") : q.eq("status", filter);
      if (term) q = q.or(`display_name.ilike.%${term}%,company_name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`);
      if (tag) q = q.contains("tags", [tag]);
      const { data, error, count } = await q;
      return { rows: unwrap({ data, error }), total: count ?? 0 };
    },
  });

  const exportCsv = useMutation({
    meta: { success: (n: number) => `Exported ${n} ${n === 1 ? "client" : "clients"}` },
    mutationFn: async () => {
      const rows: Array<Record<string, unknown>> = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(
          await supabase()
            .from("clients")
            .select("display_name, company_name, email, phone, status, lead_source, tags, created_at, properties(line1, city, region, postal_code)")
            .eq("company_id", session.company.id)
            .order("display_name")
            .range(from, from + 999),
        );
        rows.push(
          ...page.map((c) => ({
            ...c,
            tags: c.tags.join("; "),
            address: c.properties[0]?.line1 ?? "",
            city: c.properties[0]?.city ?? "",
            state: c.properties[0]?.region ?? "",
            zip: c.properties[0]?.postal_code ?? "",
            created_at: c.created_at.slice(0, 10),
          })),
        );
        if (page.length < 1000) break;
      }
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
  const isFiltered = Boolean(term || tag || filter !== "all");

  if (clients.isPending && !data) return <ListPageSkeleton columns={5} tabs={4} />;

  return (
    <>
      <PageHeader
        title="Clients"
        actions={
          canEdit && (
            <>
              <Menu
                label="Import and export"
                items={[
                  { label: "Import from a spreadsheet", icon: "upload", onSelect: () => setImporting(true) },
                  { label: exportCsv.isPending ? "Exporting…" : "Download as spreadsheet", icon: "download", onSelect: () => exportCsv.mutate(), disabled: exportCsv.isPending },
                ]}
              />
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New client</Button>
            </>
          )
        }
      />
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search name, company, email or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
        </div>
        <div className="tabs" role="group" aria-label="Filter clients">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        {!!tags.data?.length && (
          <select className="select" style={{ width: "auto" }} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
            <option value="">Any tag</option>
            {tags.data.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        <select className="select" style={{ width: "auto", marginLeft: "auto" }} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="name">Name A–Z</option>
          <option value="newest">Newest first</option>
        </select>
      </div>

      {clients.error && !data ? (
        <div className="card"><ErrorState error={clients.error} onRetry={() => clients.refetch()} /></div>
      ) : clients.isFetching && !data ? (
        <TableSkeleton columns={5} />
      ) : data && data.rows.length === 0 ? (
        <div className="card">
          {isFiltered ? (
            <EmptyState icon="search" title="No clients match" action={<Button onClick={() => { setSearch(""); setTag(""); setFilter("all"); }}>Clear filters</Button>} />
          ) : (
            <EmptyState
              icon="clients"
              title="No clients yet"
              action={canEdit && (<><Button variant="primary" icon="plus" onClick={() => setCreating(true)}>Add your first client</Button><Button icon="upload" onClick={() => setImporting(true)}>Import from a spreadsheet</Button></>)}
            />
          )}
        </div>
      ) : (
        data && (
          <div className={`card${clients.isPlaceholderData ? " is-stale" : ""}`}>
            <table className="table table-stack">
              <thead>
                <tr><th>Name</th><th>Contact</th><th>Service address</th><th>Tags</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.rows.map((c) => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/clients/${c.id}`)}>
                    <td>
                      <Link className="cell-link" to={`/clients/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.display_name}</Link>
                      {c.company_name && c.company_name !== c.display_name && <div className="muted small">{c.company_name}</div>}
                    </td>
                    <td>
                      <div className="ellipsis" style={{ maxWidth: 240 }}>{c.email ?? <span className="muted">No email</span>}</div>
                      <div className="muted small">{c.phone}</div>
                    </td>
                    <td>
                      {c.properties[0] ? [c.properties[0].line1, c.properties[0].city].filter(Boolean).join(", ") : <span className="muted">—</span>}
                      {c.properties.length > 1 && <span className="muted"> +{c.properties.length - 1}</span>}
                    </td>
                    <td><div className="row wrap" style={{ gap: 4 }}>{c.tags.slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}{c.tags.length > 3 && <span className="tag">+{c.tags.length - 3}</span>}</div></td>
                    <td><EntityStatus kind="client" status={c.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="list-foot">
              <span>Showing {data.rows.length} of {data.total}</span>
              {data.rows.length < data.total && <Button size="sm" loading={clients.isFetching} onClick={() => setLimit((l) => l + PAGE)}>Load more</Button>}
            </div>
          </div>
        )
      )}

      <NewClientDialog open={creating} initialName={search.trim()} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/clients/${id}`)} />
      {importing && <ImportClientsDialog onClose={() => setImporting(false)} />}
    </>
  );
}
