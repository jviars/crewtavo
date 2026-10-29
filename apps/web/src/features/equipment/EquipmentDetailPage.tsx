/** One piece of equipment: what's due, its history, and its details. */
import { describeInterval, dueSummary, dueTone, formatMeter, kindLabel } from "@crewtavo/core/equipment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader, useDocumentTitle } from "@/components/ui/PageHeader";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { EquipmentDialog, LogDialog, PlanDialog, type LogKind } from "./EquipmentDialogs";
import {
  EQUIPMENT_FIELDS,
  managesEquipment,
  refreshEquipment,
  seesEquipmentCosts,
  STATUS_LABELS,
  STATUS_TONES,
  useEquipmentDue,
  type DueRow,
  type Equipment,
  type EquipmentLog,
} from "./equipmentData";

const LOG_ICON: Record<EquipmentLog["kind"], IconName> = { service: "check", repair: "wrench", reading: "gauge", note: "note" };
/** A history entry with who logged it. */
type Logged = EquipmentLog & { by: string | null };

export function EquipmentDetailPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = managesEquipment(session);
  const showCosts = seesEquipmentCosts(session);
  const [dialog, setDialog] = useState<null | "edit" | { plan: DueRow | null } | { log: LogKind; planId?: string | null }>(null);
  const [showAll, setShowAll] = useState(false);
  const plansRef = useListAnimation<HTMLDivElement>();
  const historyRef = useListAnimation<HTMLDivElement>();

  const item = useQuery({
    queryKey: ["equipment", session.company.id, "item", id],
    queryFn: async () => {
      const row = unwrapOne(await supabase().from("equipment").select(EQUIPMENT_FIELDS).eq("id", id).maybeSingle(), "This equipment") as unknown as Equipment;
      const photo = row.photo_path ? (await signedUrls([row.photo_path]).catch(() => ({}) as Record<string, string>))[row.photo_path] ?? null : null;
      return { ...row, photo_url: photo };
    },
  });
  const plans = useEquipmentDue(session.company.id, { equipmentId: id });
  // Paused schedules and retired equipment aren't in equipment_due, so the full list comes from the table.
  const allPlans = useQuery({
    queryKey: ["equipment", session.company.id, "plans", id],
    queryFn: async () => unwrap(await supabase().from("equipment_plans").select("id, name, every_count, every_unit, every_meter, last_done_on, last_done_meter, baseline_on, notes, active").eq("equipment_id", id).order("name")),
  });
  const logsKey = ["equipment", session.company.id, "logs", id];
  const logs = useQuery({
    queryKey: logsKey,
    queryFn: async () => {
      const rows = unwrap(
        await supabase()
          .from("equipment_logs")
          .select("id, kind, plan_id, title, done_on, meter_reading, notes, user_id, created_at, expense:expenses(amount, vendor)")
          .eq("equipment_id", id)
          .order("done_on", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(200),
      ) as unknown as EquipmentLog[];
      const ids = [...new Set(rows.flatMap((r) => (r.user_id ? [r.user_id] : [])))];
      const people = ids.length ? unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const names = new Map(people.map((p) => [p.user_id, p.full_name]));
      return rows.map((r) => ({ ...r, by: r.user_id ? names.get(r.user_id) ?? null : null }));
    },
  });
  const costs = useQuery({
    queryKey: ["equipment", session.company.id, "costs", id],
    enabled: showCosts,
    queryFn: async () => {
      const [financials, expenses] = await Promise.all([
        supabase().from("equipment_financials").select("purchase_price").eq("equipment_id", id).maybeSingle(),
        supabase().from("expenses").select("amount").eq("equipment_id", id),
      ]);
      return { price: Number(unwrap(financials)?.purchase_price ?? 0), upkeep: unwrap(expenses).reduce((s, e) => s + Number(e.amount), 0) };
    },
  });

  const e = item.data;
  useDocumentTitle(e?.name ?? "Equipment");
  useRememberRecent(session.company.id, e ? { kind: "equipment", id: e.id, title: e.name, subtitle: kindLabel(e.kind), path: `/equipment/${e.id}` } : null);

  const update = useMutation({
    meta: { success: (_: unknown, patch: Partial<Equipment>) => (patch.status === "in_shop" ? "Marked in the shop" : patch.status === "retired" ? "Retired" : "Back in service") },
    mutationFn: async (patch: Partial<Pick<Equipment, "status">>) => unwrap(await supabase().from("equipment").update(patch).eq("id", id)),
    onSuccess: () => refreshEquipment(queryClient),
  });
  const remove = useMutation({
    meta: { success: "Equipment deleted" },
    mutationFn: async () => unwrap(await supabase().from("equipment").delete().eq("id", id)),
    onSuccess: () => {
      refreshEquipment(queryClient);
      navigate("/equipment", { replace: true });
    },
  });
  const removePlan = useMutation({
    meta: { success: "Schedule removed" },
    mutationFn: async (planId: string) => unwrap(await supabase().from("equipment_plans").delete().eq("id", planId)),
    onSuccess: () => refreshEquipment(queryClient),
  });
  const setPlanActive = useMutation({
    meta: { success: (_: unknown, v: { active: boolean }) => (v.active ? "Schedule turned back on" : "Schedule paused") },
    mutationFn: async ({ planId, active }: { planId: string; active: boolean }) => unwrap(await supabase().from("equipment_plans").update({ active }).eq("id", planId)),
    onSuccess: () => refreshEquipment(queryClient),
  });
  const removeLog = useMutation({
    meta: { inline: true },
    mutationFn: async (logId: string) => unwrap(await supabase().from("equipment_logs").delete().eq("id", logId)),
    onSuccess: () => refreshEquipment(queryClient),
  });
  // Gone from the history at once with Undo on the toast; deleted for real (and the schedule it
  // counted for moved back) once the toast leaves.
  const removeLater = (l: Logged) =>
    undoable({
      title: "Entry deleted",
      description: l.kind === "service" && l.plan_id ? "Its schedule goes back to when it was done before." : undefined,
      hide: () => {
        void queryClient.cancelQueries({ queryKey: logsKey });
        queryClient.setQueryData<Logged[]>(logsKey, (rows) => rows?.filter((r) => r.id !== l.id));
      },
      restore: () =>
        queryClient.setQueryData<Logged[]>(logsKey, (rows) =>
          rows && !rows.some((r) => r.id === l.id) ? [...rows, l].sort((a, b) => b.done_on.localeCompare(a.done_on) || b.created_at.localeCompare(a.created_at)) : rows,
        ),
      commit: () => removeLog.mutateAsync(l.id),
    });

  if (item.isPending) return <DetailSkeleton />;
  if (item.error || !e) return <PageError error={item.error} onRetry={() => item.refetch()} back={<BackLink to="/equipment">Equipment</BackLink>} />;

  const due = plans.data ?? [];
  const paused = (allPlans.data ?? []).filter((p) => !p.active);
  const planOptions = due.map((p) => ({ plan_id: p.plan_id, name: p.name }));
  const history = logs.data ?? [];
  const shown = showAll ? history : history.slice(0, 15);
  const retired = e.status === "retired";
  const hasHistory = (planId: string) => history.some((l) => l.plan_id === planId && l.kind === "service");
  const details: Array<[string, string | null]> = [
    ["Type", kindLabel(e.kind)],
    ["Make and model", [e.year, e.make, e.model].filter(Boolean).join(" ") || null],
    [e.kind === "truck" || e.kind === "trailer" ? "VIN or serial" : "Serial", e.serial],
    ["Plate", e.plate],
    ["Crew", e.crew?.name ?? "Shared"],
    ["Bought", e.purchased_on ? formatDate(e.purchased_on) : null],
  ];

  return (
    <>
      <BackLink to="/equipment">Equipment</BackLink>
      <PageHeader
        title={e.name}
        actions={
          <>
            {!retired && e.meter !== "none" && <Button icon="gauge" onClick={() => setDialog({ log: "reading" })}>{e.meter === "miles" ? "Log miles" : "Log hours"}</Button>}
            {!retired && <Button variant="primary" icon="check" onClick={() => setDialog({ log: "service" })}>Log work</Button>}
            <Menu
              items={[
                { label: "Log a repair", icon: "wrench", hidden: retired, onSelect: () => setDialog({ log: "repair" }) },
                { label: "Add a note", icon: "note", onSelect: () => setDialog({ log: "note" }) },
                { separator: true, hidden: !canManage },
                { label: "Edit details", icon: "edit", hidden: !canManage, onSelect: () => setDialog("edit") },
                { label: "Add maintenance schedule", icon: "plus", hidden: !canManage || retired, onSelect: () => setDialog({ plan: null }) },
                { label: "Mark in the shop", icon: "alert", hidden: !canManage || e.status !== "active", onSelect: () => update.mutate({ status: "in_shop" }) },
                { label: "Back in service", icon: "check", hidden: !canManage || e.status === "active", onSelect: () => update.mutate({ status: "active" }) },
                {
                  label: "Retire",
                  icon: "archive",
                  hidden: !canManage || retired,
                  onSelect: async () => (await confirm({ title: `Retire ${e.name}?`, body: "Use this when it's sold or scrapped. Its history stays and its maintenance stops coming due.", confirmLabel: "Retire" })) && update.mutate({ status: "retired" }),
                },
                {
                  label: "Delete",
                  icon: "trash",
                  danger: true,
                  hidden: !canManage,
                  onSelect: async () => {
                    if (await confirm({ title: `Delete ${e.name}?`, body: history.length ? "Its maintenance history is deleted too. To keep the history, retire it instead." : "This can't be undone.", confirmLabel: "Delete", danger: true, typeToConfirm: history.length > 5 ? "delete" : undefined })) remove.mutate();
                  },
                },
              ]}
            />
          </>
        }
      />
      <div className="page-meta">
        <StatusPill label={STATUS_LABELS[e.status]} tone={STATUS_TONES[e.status]} />
        <span className="muted">{kindLabel(e.kind)}</span>
        {e.meter !== "none" && (
          <span className="muted tabular">
            {e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : e.meter === "miles" ? "No miles logged" : "No hours logged"}
            {e.meter_read_on && ` · read ${formatDate(e.meter_read_on)}`}
          </span>
        )}
      </div>

      {e.status === "in_shop" && (
        <div className="callout callout-warning">
          <Icon name="alert" size={20} />
          <div className="grow">In the shop. Crews know not to count on it.</div>
          {canManage && <Button size="sm" onClick={() => update.mutate({ status: "active" })}>Back in service</Button>}
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Maintenance</h2>
              {canManage && !retired && <Button size="sm" icon="plus" onClick={() => setDialog({ plan: null })}>Add schedule</Button>}
            </div>
            <div className="card" ref={plansRef}>
              {plans.isPending && [0, 1].map((i) => <div key={i} className="card-row"><span className="grow stack-sm"><Skeleton width="40%" /><Skeleton width="30%" height={10} /></span><Skeleton width={80} height={24} radius={12} /></div>)}
              {/* Add schedule is in the heading, so the empty line doesn't repeat it. */}
              {plans.data && due.length === 0 && (
                <EmptyState inline title={retired ? "Retired equipment has no maintenance due" : paused.length ? "No schedules running" : "No maintenance schedules yet"}>
                  {!retired && !paused.length ? "Oil changes, blade sharpening, inspections: anything that comes due by date, hours or miles." : null}
                </EmptyState>
              )}
              {due.map((p) => (
                <div key={p.plan_id} className="card-row">
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong>{p.name}</strong>
                    <span className="muted small" style={{ display: "block" }}>
                      {describeInterval(p, e.meter)}
                      {p.last_done_on ? ` · last done ${formatDate(p.last_done_on)}` : ""}
                      {p.last_done_meter != null && p.every_meter ? ` at ${formatMeter(p.last_done_meter, e.meter)}` : ""}
                    </span>
                    {p.notes && <span className="muted small ellipsis" style={{ display: "block" }}>{p.notes}</span>}
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <StatusPill label={dueSummary(p)} tone={dueTone(p.state)} />
                    <span className="muted small" style={{ display: "block", marginTop: 2 }}>
                      {[p.next_due_on ? formatDate(p.next_due_on) : null, p.next_due_meter != null ? formatMeter(p.next_due_meter, e.meter) : null].filter(Boolean).join(" or ")}
                    </span>
                  </span>
                  <Button size="sm" icon="check" onClick={() => setDialog({ log: "service", planId: p.plan_id })}>Mark done</Button>
                  {canManage && (
                    <Menu
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      label={`${p.name} actions`}
                      items={[
                        { label: "Edit schedule", icon: "edit", onSelect: () => setDialog({ plan: p }) },
                        { label: "Pause", icon: "pause", onSelect: () => setPlanActive.mutate({ planId: p.plan_id, active: false }) },
                        { label: "Remove", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: `Remove "${p.name}"?`, body: "Past maintenance stays in the history.", confirmLabel: "Remove", danger: true })) && removePlan.mutate(p.plan_id) },
                      ]}
                    />
                  )}
                </div>
              ))}
              {paused.length > 0 && (
                <div className="list-foot">
                  <span>Paused: {paused.map((p) => p.name).join(", ")}</span>
                  {canManage && <Button size="sm" variant="ghost" onClick={() => paused.forEach((p) => setPlanActive.mutate({ planId: p.id, active: true }))}>Turn back on</Button>}
                </div>
              )}
            </div>
          </section>

          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">History</h2>
              {history.length > 0 && <span className="muted small">{history.length} {history.length === 1 ? "entry" : "entries"}</span>}
            </div>
            <div className="card" ref={historyRef}>
              {logs.isPending && [0, 1, 2].map((i) => <div key={i} className="card-row"><Skeleton width={32} height={32} radius={8} /><span className="grow stack-sm"><Skeleton width="45%" /><Skeleton width="30%" height={10} /></span></div>)}
              {logs.data && history.length === 0 && <EmptyState inline title="Nothing logged yet" />}
              {shown.map((l) => {
                const mine = l.user_id === session.userId;
                return (
                  <div key={l.id} className="card-row" style={{ alignItems: "flex-start" }}>
                    <span className="n-icon" style={{ width: 32, height: 32, borderRadius: "var(--radius-control)", display: "grid", placeItems: "center", flex: "none", background: l.kind === "service" ? "var(--green-tint)" : l.kind === "repair" ? "var(--warning-tint)" : "var(--fill-2)", color: l.kind === "service" ? "var(--green-dark)" : l.kind === "repair" ? "var(--warning)" : "var(--text-2)" }}>
                      <Icon name={LOG_ICON[l.kind]} size={16} />
                    </span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <strong>{l.kind === "reading" ? `${e.meter === "miles" ? "Odometer" : "Hour meter"}: ${formatMeter(l.meter_reading, e.meter)}` : l.title || (l.kind === "note" ? "Note" : l.kind === "repair" ? "Repair" : "Maintenance")}</strong>
                      <span className="muted small" style={{ display: "block" }}>
                        {[formatDate(l.done_on), l.kind !== "reading" && l.meter_reading != null && e.meter !== "none" ? formatMeter(l.meter_reading, e.meter) : null, l.by, l.expense?.vendor].filter(Boolean).join(" · ")}
                      </span>
                      {l.notes && <span className="small pre-wrap" style={{ display: "block", marginTop: 4 }}>{l.notes}</span>}
                    </span>
                    {l.expense && <strong className="tabular">{formatMoneyCents(l.expense.amount)}</strong>}
                    {(mine || canManage) && (
                      <Menu
                        triggerClassName="btn btn-sm btn-ghost btn-icon"
                        label="Entry actions"
                        items={[{ label: "Delete entry", icon: "trash", danger: true, onSelect: () => removeLater(l) }]}
                      />
                    )}
                  </div>
                );
              })}
              {history.length > 15 && (
                <div className="list-foot">
                  <span />
                  <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${history.length}`}</Button>
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="narrow stack">
          {e.photo_url && (
            <a href={e.photo_url} target="_blank" rel="noreferrer" className="card" style={{ overflow: "hidden", display: "block" }}>
              <img src={e.photo_url} alt={e.name} style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", display: "block" }} />
            </a>
          )}
          <div className="card card-pad stack-sm">
            <div className="row-between">
              <strong>Details</strong>
              {canManage && <Button size="sm" variant="ghost" icon="edit" onClick={() => setDialog("edit")}>Edit</Button>}
            </div>
            <dl className="kv">
              {details.filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>)}
            </dl>
            {e.notes && <p className="pre-wrap small" style={{ margin: 0, padding: 10, background: "var(--note)", borderRadius: "var(--radius-control)", border: "1px solid var(--note-border)" }}>{e.notes}</p>}
          </div>
          {showCosts && (
            <div className="card card-pad stack-sm">
              <strong>Cost to own</strong>
              {costs.isPending ? <Skeleton height={48} /> : (
                <div className="totals">
                  <div className="line"><span>Bought for</span><span>{costs.data?.price ? formatMoneyCents(costs.data.price) : "—"}</span></div>
                  <div className="line"><span>Upkeep logged</span><span>{formatMoneyCents(costs.data?.upkeep ?? 0)}</span></div>
                  <div className="line grand" style={{ fontSize: 16, fontWeight: 700 }}><span>Total</span><span>{formatMoneyCents((costs.data?.price ?? 0) + (costs.data?.upkeep ?? 0))}</span></div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {dialog === "edit" && <EquipmentDialog equipment={e} onClose={() => setDialog(null)} onSaved={() => undefined} />}
      {dialog && typeof dialog === "object" && "plan" in dialog && <PlanDialog equipment={e} plan={dialog.plan} hasHistory={dialog.plan ? hasHistory(dialog.plan.plan_id) : false} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "log" in dialog && <LogDialog equipment={e} plans={planOptions} kind={dialog.log} planId={dialog.planId} onClose={() => setDialog(null)} />}
    </>
  );
}
