/** Everything the company owns, what each one needs next (maintenance or paperwork), and who has it. */
import { dueTone, formatMeter } from "@crewtavo/core/equipment";
import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, type GroupTone } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { EquipmentDialog } from "./EquipmentDialogs";
import { EQUIPMENT_FIELDS, groupByEquipment, managesEquipment, nextUp, STATUS_LABELS, STATUS_TONES, useEquipmentDue, usePaperwork, type Equipment, type NextUp } from "./equipmentData";
import styles from "./Equipment.module.css";

const FILTERS = [
  { key: "all", label: "In use" },
  { key: "due", label: "Needs attention" },
  { key: "in_shop", label: "In the shop" },
  { key: "retired", label: "Retired" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

/** What an empty filter says, in the filter's own words. */
const EMPTY_TITLES: Record<FilterKey, string> = { all: "Nothing in use", due: "Everything is up to date", in_shop: "Nothing in the shop", retired: "Nothing retired" };

/** Each kind of equipment's mark in the list: a thing, so a rounded square rather than a face. */
export const KIND_ICONS: Record<string, IconName> = { truck: "truck", trailer: "truck", mower: "mower", machine: "gauge", tool: "wrench", other: "package" };

type GroupKey = "attention" | "active" | "in_shop" | "retired";
const GROUPS: Array<{ key: GroupKey; label: string; tone?: GroupTone; icon?: IconName }> = [
  { key: "attention", label: "Needs attention", tone: "danger", icon: "alert" },
  { key: "active", label: "In service" },
  { key: "in_shop", label: "In the shop" },
  { key: "retired", label: "Retired" },
];

/**
 * The list in what-needs-doing order: machines in service with maintenance or paperwork overdue or
 * coming due, then the rest in service, then what's in the shop, then retired. Empty groups are left out.
 */
export function groupEquipment(rows: readonly Equipment[], next: ReadonlyMap<string, Pick<NextUp, "state">>) {
  const groupOf = (e: Equipment): GroupKey => (e.status === "retired" ? "retired" : e.status === "in_shop" ? "in_shop" : (next.get(e.id)?.state ?? "ok") !== "ok" ? "attention" : "active");
  return GROUPS.map((g) => ({ ...g, rows: rows.filter((e) => groupOf(e) === g.key) })).filter((g) => g.rows.length > 0);
}

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
  const papers = usePaperwork(company.id);

  // What each machine needs next: its most urgent schedule or paperwork.
  const next = useMemo(() => {
    const plans = groupByEquipment(due.data);
    const docs = groupByEquipment(papers.data);
    const map = new Map<string, NextUp>();
    for (const id of new Set([...plans.keys(), ...docs.keys()])) {
      const n = nextUp(plans.get(id) ?? [], docs.get(id) ?? []);
      if (n) map.set(id, n);
    }
    return map;
  }, [due.data, papers.data]);
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

  if (list.isPending) return <InboxPageSkeleton tabs={4} groups={2} />;

  return (
    <>
      <PageHeader title="Equipment" actions={canManage && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" }, { replace: true })}>Add equipment</Button>} />
      {overdue > 0 && filter !== "due" && (
        // One quiet line between hairlines (Page-Equipment.dc.html). On a phone the Needs attention chip
        // and group say this already (Mobile-Business, Equipment).
        <div className={cx(styles.warnline, "hide-mobile")}>
          <Icon name="alert" size={15} />
          <span className="grow">{overdue} {overdue === 1 ? "machine has" : "machines have"} overdue maintenance or expired paperwork.</span>
          <button type="button" className="link-btn" onClick={() => setFilter("due")}>Show them</button>
        </div>
      )}
      {all.length > 0 && (
        <Toolbar
          filters={
            <FilterTabs
              label="Filter equipment"
              value={filter}
              onChange={setFilter}
              // A filter with nothing in it shows no count (a quiet "0" is only noise), except the whole list's.
              options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: f.key !== "all" && !counts[f.key] ? undefined : counts[f.key] }))}
            />
          }
          search={<SearchField value={search} onChange={setSearch} placeholder="Name, make, serial or crew" label="Search equipment" />}
        />
      )}
      {list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : all.length === 0 ? (
        // Add equipment is the page header's green button, so it isn't repeated here.
        <EmptyState icon="truck" title="Keep track of your trucks, mowers and tools">
          Log engine hours and miles, see what maintenance is coming up, and keep every repair and receipt in one place.
        </EmptyState>
      ) : rows.length === 0 ? (
        term ? (
          <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
        ) : (
          <EmptyState icon={filter === "due" ? "check" : "truck"} title={EMPTY_TITLES[filter]} />
        )
      ) : (
        <InboxList label="Equipment" className={styles.list} foot={<ListFoot>{rows.length} {rows.length === 1 ? "item" : "items"}</ListFoot>}>
          {groupEquipment(rows, next).map((g) => (
            <InboxGroup key={g.key} label={g.label} count={g.rows.length} tone={g.tone} icon={g.icon}>
              {g.rows.map((e) => {
                const n = next.get(e.id);
                const model = [e.year, e.make, e.model].filter(Boolean).join(" ");
                const reading = e.meter !== "none" && e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : null;
                return (
                  <InboxRow
                    key={e.id}
                    to={`/equipment/${e.id}`}
                    title={e.name}
                    badge={model ? <span className="il-num">{model}</span> : undefined}
                    avatar={<Icon name={KIND_ICONS[e.kind] ?? "package"} size={16} />}
                    square
                    subject={n ? <span className={styles.due} data-tone={n.state === "ok" || e.status === "retired" ? undefined : dueTone(n.state)}>{n.name} · {n.summary.toLowerCase()}</span> : <span className={styles.dueNone}>Nothing due</span>}
                    meta={[
                      e.crew ? <span className={styles.crew}><i aria-hidden="true" style={{ background: e.crew.color || "var(--fill-3)" }} />{e.crew.name}</span> : "Shared",
                      reading,
                    ]}
                    aside={n && n.state !== "ok" && e.status === "active" ? <StatusPill label={n.state === "overdue" ? "Overdue" : "Due soon"} tone={dueTone(n.state)} /> : <StatusPill label={STATUS_LABELS[e.status]} tone={STATUS_TONES[e.status]} />}
                  />
                );
              })}
            </InboxGroup>
          ))}
        </InboxList>
      )}
      {params.get("new") === "1" && canManage && <EquipmentDialog equipment={null} onClose={() => setParams({}, { replace: true })} onSaved={(id) => navigate(`/equipment/${id}`)} />}
    </>
  );
}
