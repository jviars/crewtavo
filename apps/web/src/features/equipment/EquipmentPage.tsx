/** Everything the company owns, what each one needs next, and who has it. */
import { dueSummary, dueTone, formatMeter, kindLabel } from "@crewtavo/core/equipment";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { EquipmentDialog } from "./EquipmentDialogs";
import { EQUIPMENT_FIELDS, managesEquipment, STATUS_LABELS, STATUS_TONES, useEquipmentDue, type DueRow, type Equipment } from "./equipmentData";

const FILTERS = [
  { key: "all", label: "In use" },
  { key: "due", label: "Needs maintenance" },
  { key: "in_shop", label: "In the shop" },
  { key: "retired", label: "Retired" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

export function EquipmentPage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((f) => f.key === params.get("show"))?.key as FilterKey | undefined) ?? "all");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(searchTerm(search).toLowerCase());
  const canManage = managesEquipment(session);

  const list = useQuery({
    queryKey: ["equipment", company.id, "list"],
    queryFn: async () => unwrap(await supabase().from("equipment").select(EQUIPMENT_FIELDS).eq("company_id", company.id).order("name").limit(1000)) as unknown as Equipment[],
  });
  const due = useEquipmentDue(company.id);

  // The most urgent schedule on each machine.
  const next = useMemo(() => {
    const map = new Map<string, DueRow>();
    for (const row of due.data ?? []) if (!map.has(row.equipment_id)) map.set(row.equipment_id, row);
    return map;
  }, [due.data]);
  const needing = (e: Equipment) => e.status !== "retired" && (next.get(e.id)?.state ?? "ok") !== "ok";

  const all = list.data ?? [];
  const counts: Record<FilterKey, number> = {
    all: all.filter((e) => e.status !== "retired").length,
    due: all.filter(needing).length,
    in_shop: all.filter((e) => e.status === "in_shop").length,
    retired: all.filter((e) => e.status === "retired").length,
  };
  const rows = all
    .filter((e) => (filter === "all" ? e.status !== "retired" : filter === "due" ? needing(e) : e.status === filter))
    .filter((e) => !term || [e.name, e.make, e.model, e.serial, e.plate, e.crew?.name].some((v) => v?.toLowerCase().includes(term)));
  const overdue = all.filter((e) => e.status !== "retired" && next.get(e.id)?.state === "overdue").length;

  if (list.isPending) return <ListPageSkeleton columns={5} tabs={4} />;

  return (
    <>
      <PageHeader title="Equipment" actions={canManage && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>Add equipment</Button>} />
      {overdue > 0 && filter !== "due" && (
        <div className="callout callout-danger">
          <Icon name="alert" size={18} />
          <div className="grow">{overdue} {overdue === 1 ? "machine is" : "machines are"} overdue for maintenance.</div>
          <Button size="sm" onClick={() => setFilter("due")}>Show them</Button>
        </div>
      )}
      {all.length > 0 && (
        <div className="toolbar">
          <div className="input-group">
            <span className="addon"><Icon name="search" size={16} /></span>
            <input className="input" type="search" placeholder="Search by name, make, serial or crew" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search equipment" />
          </div>
          <div className="tabs" role="group" aria-label="Filter equipment">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
                <span className="badge">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {list.error && !list.data ? (
        <div className="card"><ErrorState error={list.error} onRetry={() => list.refetch()} /></div>
      ) : all.length === 0 ? (
        <div className="card">
          <EmptyState icon="truck" title="Keep track of your trucks, mowers and tools" action={canManage && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>Add equipment</Button>}>
            Log engine hours and miles, see what maintenance is coming up, and keep every repair and receipt in one place.
          </EmptyState>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term ? (
            <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
          ) : (
            <EmptyState icon="check" title={filter === "due" ? "Everything is up to date" : "Nothing here"} />
          )}
        </div>
      ) : (
        <div className="card">
          <table className="table table-stack">
            <thead><tr><th>Equipment</th><th>Crew</th><th>Reading</th><th>Next maintenance</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((e) => {
                const n = next.get(e.id);
                return (
                  <tr key={e.id} className="row-link" onClick={() => navigate(`/equipment/${e.id}`)}>
                    <td>
                      <Link className="cell-link" to={`/equipment/${e.id}`} onClick={(ev) => ev.stopPropagation()}>{e.name}</Link>
                      <div className="muted small">{[kindLabel(e.kind), [e.year, e.make, e.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td>{e.crew ? <span className="row" style={{ gap: 6 }}><span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", flex: "none", background: e.crew.color || "var(--fill-3)" }} />{e.crew.name}</span> : <span className="muted">Shared</span>}</td>
                    <td className="tabular" style={{ whiteSpace: "nowrap" }}>{e.meter === "none" ? <span className="muted">—</span> : e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : <span className="muted">Not logged</span>}</td>
                    <td>
                      {n ? (
                        <>
                          <span className="strong">{n.name}</span>
                          <div className={`small ${n.state === "overdue" ? "text-danger strong" : n.state === "due_soon" ? "strong" : "muted"}`} style={n.state === "due_soon" ? { color: "var(--warning)" } : undefined}>{dueSummary(n)}</div>
                        </>
                      ) : (
                        <span className="muted">{e.status === "retired" ? "—" : "No schedule"}</span>
                      )}
                    </td>
                    <td>{n && n.state !== "ok" && e.status === "active" ? <StatusPill label={n.state === "overdue" ? "Overdue" : "Due soon"} tone={dueTone(n.state)} /> : <StatusPill label={STATUS_LABELS[e.status]} tone={STATUS_TONES[e.status]} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="list-foot"><span>{rows.length} {rows.length === 1 ? "item" : "items"}</span></div>
        </div>
      )}
      {params.get("new") === "1" && canManage && <EquipmentDialog equipment={null} onClose={() => setParams({}, { replace: true })} onSaved={(id) => navigate(`/equipment/${id}`)} />}
    </>
  );
}
