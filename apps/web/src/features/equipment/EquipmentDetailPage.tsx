/** One piece of equipment: what's due, its tags and inspection, its photos, its history, and its details. */
import { describeInterval, documentLabel, dueSummary, dueTone, expirySummary, formatMeter, kindLabel } from "@crewtavo/core/equipment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { MetaLine } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { useSession } from "@/lib/session";
import styles from "./Equipment.module.css";
import { undoable } from "@/lib/undo";
import { EquipmentDialog, LogDialog, PaperDialog, PlanDialog, RenewDialog, type LogKind } from "./EquipmentDialogs";
import { EquipmentPhotos, useEquipmentPhotos } from "./EquipmentPhotos";
import {
  EQUIPMENT_FIELDS,
  managesEquipment,
  refreshEquipment,
  seesEquipmentCosts,
  STATUS_LABELS,
  STATUS_TONES,
  useEquipmentDue,
  usePaperwork,
  type DueRow,
  type Equipment,
  type EquipmentLog,
  type PaperRow,
} from "./equipmentData";

const LOG_ICON: Record<EquipmentLog["kind"], IconName> = { service: "check", repair: "wrench", reading: "gauge", note: "note" };
/** The kind colours only its icon: done maintenance green, a repair amber. */
const LOG_TONE: Partial<Record<EquipmentLog["kind"], "good" | "warning">> = { service: "good", repair: "warning" };
/** A history entry with who logged it. */
type Logged = EquipmentLog & { by: string | null };

export function EquipmentDetailPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = managesEquipment(session);
  const showCosts = seesEquipmentCosts(session);
  const [dialog, setDialog] = useState<null | "edit" | { plan: DueRow | null } | { log: LogKind; planId?: string | null } | { paper: PaperRow | null } | { renew: PaperRow }>(null);
  const [showAll, setShowAll] = useState(false);
  const plansRef = useListAnimation<HTMLUListElement>();
  const historyRef = useListAnimation<HTMLUListElement>();

  const item = useQuery({
    queryKey: ["equipment", session.company.id, "item", id],
    queryFn: async () => {
      const row = unwrapOne(await supabase().from("equipment").select(EQUIPMENT_FIELDS).eq("id", id).maybeSingle(), "This equipment") as unknown as Equipment;
      const photo = row.photo_path ? (await signedUrls([row.photo_path]).catch(() => ({}) as Record<string, string>))[row.photo_path] ?? null : null;
      return { ...row, photo_url: photo };
    },
  });
  const plans = useEquipmentDue(session.company.id, { equipmentId: id });
  const papers = usePaperwork(session.company.id, { equipmentId: id });
  const photos = useEquipmentPhotos(id);
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
  const removePaper = useMutation({
    meta: { success: "Removed" },
    mutationFn: async (paperId: string) => unwrap(await supabase().from("equipment_documents").delete().eq("id", paperId)),
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
  // The main photo, or else the first one added.
  const cover = e.photo_url ?? photos.photos.find((p) => p.url)?.url ?? null;
  const paperRows = papers.data ?? [];
  // Trucks and trailers have tags and stickers; anything else shows the section once it has paperwork.
  const showPapers = !retired && (e.kind === "truck" || e.kind === "trailer" || paperRows.length > 0);
  const hasHistory = (planId: string) => history.some((l) => l.plan_id === planId && l.kind === "service");
  const model = [e.year, e.make, e.model].filter(Boolean).join(" ");
  const askRetire = async () => (await confirm({ title: `Retire ${e.name}?`, body: "Use this when it's sold or scrapped. Its history stays and its maintenance stops coming due.", confirmLabel: "Retire" })) && update.mutate({ status: "retired" });
  const setStatus = (status: Equipment["status"]) => (status === e.status ? undefined : status === "retired" ? void askRetire() : update.mutate({ status }));
  const more: MenuEntry[] = [
    { label: "Log a repair", icon: "wrench", kbd: "R", hidden: retired, onSelect: () => setDialog({ log: "repair" }) },
    { label: "Add a note", icon: "note", kbd: "N", onSelect: () => setDialog({ log: "note" }) },
    { separator: true, hidden: !canManage },
    { label: "Edit details", icon: "edit", kbd: "E", hidden: !canManage, onSelect: () => setDialog("edit") },
    {
      label: "Add",
      icon: "plus",
      hidden: !canManage || retired,
      items: [
        { label: "Maintenance schedule", icon: "wrench", onSelect: () => setDialog({ plan: null }) },
        { label: "Tags or inspection", icon: "file", onSelect: () => setDialog({ paper: null }) },
      ],
    },
    {
      label: "Status",
      icon: "circle",
      end: STATUS_LABELS[e.status],
      hidden: !canManage,
      items: [
        { label: STATUS_LABELS.active, checked: e.status === "active", onSelect: () => setStatus("active") },
        { label: STATUS_LABELS.in_shop, description: "Crews know not to count on it", checked: e.status === "in_shop", onSelect: () => setStatus("in_shop") },
        { label: STATUS_LABELS.retired, description: "Sold or scrapped", checked: retired, onSelect: () => setStatus("retired") },
      ],
    },
    { separator: true, hidden: !canManage },
    {
      label: "Delete",
      icon: "trash",
      danger: true,
      hidden: !canManage,
      onSelect: async () => {
        if (await confirm({ title: `Delete ${e.name}?`, body: history.length ? "Its maintenance history is deleted too. To keep the history, retire it instead." : "This can't be undone.", confirmLabel: "Delete", danger: true, typeToConfirm: history.length > 5 ? "delete" : undefined })) remove.mutate();
      },
    },
  ];
  const loadingRows = (n: number) => (
    <ul className="rel" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => <li key={i} className="rel-row"><span className="rel-body stack-sm"><Skeleton width="40%" /><Skeleton width="28%" height={10} /></span><Skeleton width={80} height={12} /></li>)}
    </ul>
  );

  return (
    <>
      <DetailHeader
        crumb={{ to: "/equipment", label: "Equipment" }}
        title={e.name}
        status={<StatusPill label={STATUS_LABELS[e.status]} tone={STATUS_TONES[e.status]} />}
        meta={[
          kindLabel(e.kind),
          model,
          e.meter !== "none" && (
            <span className="tabular">
              {e.meter_reading != null ? formatMeter(e.meter_reading, e.meter) : e.meter === "miles" ? "No miles logged" : "No hours logged"}
              {e.meter_read_on && ` · read ${formatDate(e.meter_read_on)}`}
            </span>
          ),
        ]}
        actions={
          <>
            {!retired && e.meter !== "none" && <Button icon="gauge" onClick={() => setDialog({ log: "reading" })}>{e.meter === "miles" ? "Log miles" : "Log hours"}</Button>}
            {!retired && <Button variant="primary" icon="check" onClick={() => setDialog({ log: "service" })}>Log work</Button>}
          </>
        }
        more={more}
      />

      {e.status === "in_shop" && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">In the shop. Crews know not to count on it.</div>
          {canManage && <button type="button" className="link-btn" onClick={() => update.mutate({ status: "active" })}>Back in service</button>}
        </div>
      )}

      <DetailColumns
        grouped
        side={
          <>
            {cover && (
              <a href={cover} target="_blank" rel="noreferrer" className={styles.cover}>
                <img src={cover} alt={e.name} />
              </a>
            )}
            <Section title="Details" action={canManage && <button type="button" onClick={() => setDialog("edit")}>Edit</button>}>
              <Facts>
                <Fact label="Type">{kindLabel(e.kind)}</Fact>
                <Fact label="Make and model">{model}</Fact>
                <Fact label={e.kind === "truck" || e.kind === "trailer" ? "VIN or serial" : "Serial"}>{e.serial}</Fact>
                <Fact label="Plate">{e.plate}</Fact>
                <Fact label="Crew">{e.crew ? <span className={styles.crew}><i aria-hidden="true" style={{ background: e.crew.color || "var(--fill-3)" }} />{e.crew.name}</span> : "Shared"}</Fact>
                <Fact label="Bought">{e.purchased_on ? formatDate(e.purchased_on) : null}</Fact>
                <Fact label="Notes" wide>{e.notes && <span className="pre-wrap">{e.notes}</span>}</Fact>
              </Facts>
            </Section>
            {showCosts && (
              <Section title="Cost to own">
                {costs.isPending ? (
                  loadingRows(2)
                ) : (
                  <Facts>
                    <Fact label="Bought for">{costs.data?.price ? formatMoneyCents(costs.data.price) : null}</Fact>
                    <Fact label="Upkeep logged">{formatMoneyCents(costs.data?.upkeep ?? 0)}</Fact>
                    <Fact label="Total"><b>{formatMoneyCents((costs.data?.price ?? 0) + (costs.data?.upkeep ?? 0))}</b></Fact>
                  </Facts>
                )}
              </Section>
            )}
          </>
        }
      >
        <Section title="Maintenance" count={due.length || undefined} action={canManage && !retired && <Button icon="plus" onClick={() => setDialog({ plan: null })}>Add schedule</Button>}>
          {plans.isPending && loadingRows(2)}
          {/* Add schedule is in the heading, so the empty line doesn't repeat it. */}
          {plans.data && due.length === 0 && (
            <EmptyState inline title={retired ? "Retired equipment has no maintenance due" : paused.length ? "No schedules running" : "No maintenance schedules yet"}>
              {!retired && !paused.length ? "Oil changes, blade sharpening, inspections: anything that comes due by date, hours or miles." : null}
            </EmptyState>
          )}
          {due.length > 0 && (
            <ul className={`rel ${styles.wrapRows}`} role="list" ref={plansRef}>
              {due.map((p) => (
                <RelatedRow
                  key={p.plan_id}
                  title={p.name}
                  sub={[
                    describeInterval(p, e.meter),
                    // On a phone when it was last done (and the notes) get a line of their own, rather than wrapping after a dangling dot.
                    (p.last_done_on || p.notes) && (
                      <span key="last" className="meta-break">
                        {[p.last_done_on && `last done ${formatDate(p.last_done_on)}${p.last_done_meter != null && p.every_meter ? ` at ${formatMeter(p.last_done_meter, e.meter)}` : ""}`, p.notes].filter(Boolean).join(" · ")}
                      </span>
                    ),
                  ]}
                  end={
                    <span className={styles.when}>
                      <StatusPill label={dueSummary(p)} tone={dueTone(p.state)} />
                      <small>{[p.next_due_on ? formatDate(p.next_due_on) : null, p.next_due_meter != null ? formatMeter(p.next_due_meter, e.meter) : null].filter(Boolean).join(" or ")}</small>
                    </span>
                  }
                  actions={
                    <>
                      <Button size="sm" icon="check" onClick={() => setDialog({ log: "service", planId: p.plan_id })}>Mark done</Button>
                      {canManage && (
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          label={`${p.name} actions`}
                          title={p.name}
                          items={[
                            { label: "Edit schedule", icon: "edit", onSelect: () => setDialog({ plan: p }) },
                            { label: "Pause", icon: "pause", onSelect: () => setPlanActive.mutate({ planId: p.plan_id, active: false }) },
                            { separator: true },
                            { label: "Remove", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: `Remove "${p.name}"?`, body: "Past maintenance stays in the history.", confirmLabel: "Remove", danger: true })) && removePlan.mutate(p.plan_id) },
                          ]}
                        />
                      )}
                    </>
                  }
                />
              ))}
            </ul>
          )}
          {paused.length > 0 && (
            <div className={styles.foot}>
              <span>Paused: {paused.map((p) => p.name).join(", ")}</span>
              {canManage && <button type="button" className="link-btn" onClick={() => paused.forEach((p) => setPlanActive.mutate({ planId: p.id, active: true }))}>Turn back on</button>}
            </div>
          )}
        </Section>

        {showPapers && (
          <Section title="Tags and inspection" count={paperRows.length || undefined} action={canManage && <Button icon="plus" onClick={() => setDialog({ paper: null })}>Add</Button>}>
            {papers.isPending && loadingRows(1)}
            {papers.data && paperRows.length === 0 && (
              <EmptyState inline title="No tags or inspection tracked yet">Registration, inspection sticker, insurance: anything that runs out on a date. You hear 30 days before.</EmptyState>
            )}
            {paperRows.length > 0 && (
              <div className={styles.wrapRows}><RelatedList>
                {paperRows.map((p) => (
                  <RelatedRow
                    key={p.id}
                    title={documentLabel(p.kind, p.name)}
                    sub={[p.expires_on ? `${p.state === "overdue" ? "Was good through" : "Good through"} ${formatDate(p.expires_on)}` : "Permanent, doesn't expire", p.notes && <span key="notes" className="meta-break">{p.notes}</span>]}
                    end={p.expires_on ? <StatusPill label={expirySummary(p.days_left, p.expires_on)} tone={dueTone(p.state)} /> : undefined}
                    actions={
                      canManage && (
                        <>
                          {p.expires_on && <Button size="sm" icon="check" onClick={() => setDialog({ renew: p })}>Renew</Button>}
                          <Menu
                            triggerClassName="btn btn-sm btn-ghost btn-icon"
                            label={`${documentLabel(p.kind, p.name)} actions`}
                            title={documentLabel(p.kind, p.name)}
                            items={[
                              { label: "Edit", icon: "edit", onSelect: () => setDialog({ paper: p }) },
                              { separator: true },
                              { label: "Remove", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: `Remove "${documentLabel(p.kind, p.name)}"?`, body: "Renewals stay in the history.", confirmLabel: "Remove", danger: true })) && removePaper.mutate(p.id) },
                            ]}
                          />
                        </>
                      )
                    }
                  />
                ))}
              </RelatedList></div>
            )}
          </Section>
        )}

        <EquipmentPhotos photos={photos} name={e.name} />

        <Section title="History" count={history.length || undefined}>
          {logs.isPending && loadingRows(3)}
          {logs.data && history.length === 0 && <EmptyState inline title="Nothing logged yet" />}
          {history.length > 0 && (
            <ul className="rel" role="list" ref={historyRef}>
              {shown.map((l) => {
                const mine = l.user_id === session.userId;
                const title = l.kind === "reading" ? `${e.meter === "miles" ? "Odometer" : "Hour meter"}: ${formatMeter(l.meter_reading, e.meter)}` : l.title || (l.kind === "note" ? "Note" : l.kind === "repair" ? "Repair" : "Maintenance");
                return (
                  <li key={l.id} className={`rel-row ${styles.logRow}`}>
                    <span className="rel-lead"><span className="rel-icon" data-tone={LOG_TONE[l.kind]}><Icon name={LOG_ICON[l.kind]} size={15} /></span></span>
                    <div className="rel-body">
                      <span className="rel-head"><span className="rel-title">{title}</span></span>
                      {/* On a phone who logged it starts the second line, so no line ends on a dangling dot. */}
                      <MetaLine className="rel-sub" parts={[formatDate(l.done_on), l.kind !== "reading" && l.meter_reading != null && e.meter !== "none" ? formatMeter(l.meter_reading, e.meter) : null, l.by ? <span key="by" className="meta-break">{[l.by, l.expense?.vendor].filter(Boolean).join(" · ")}</span> : l.expense?.vendor]} />
                      {l.notes && <p className={styles.logNotes}>{l.notes}</p>}
                    </div>
                    {l.expense && <span className="rel-end"><b>{formatMoneyCents(l.expense.amount)}</b></span>}
                    {(mine || canManage) && (
                      <span className="rel-actions">
                        <Menu triggerClassName="btn btn-sm btn-ghost btn-icon" label="Entry actions" title={title} items={[{ label: "Delete entry", icon: "trash", danger: true, onSelect: () => removeLater(l) }]} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {history.length > 15 && (
            <div className={styles.foot}>
              <span>{showAll ? `All ${history.length} entries` : `15 of ${history.length} entries`}</span>
              <button type="button" className="link-btn" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${history.length}`}</button>
            </div>
          )}
        </Section>
      </DetailColumns>

      {dialog === "edit" && <EquipmentDialog equipment={e} onClose={() => setDialog(null)} onSaved={() => undefined} />}
      {dialog && typeof dialog === "object" && "plan" in dialog && <PlanDialog equipment={e} plan={dialog.plan} hasHistory={dialog.plan ? hasHistory(dialog.plan.plan_id) : false} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "paper" in dialog && <PaperDialog equipment={e} paper={dialog.paper} taken={paperRows.map((p) => p.kind)} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "renew" in dialog && <RenewDialog equipment={e} paper={dialog.renew} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === "object" && "log" in dialog && <LogDialog equipment={e} plans={planOptions} kind={dialog.log} planId={dialog.planId} onClose={() => setDialog(null)} />}
    </>
  );
}
