/** Time for the week: the running clock, hours per person per day, edits, and approval for payroll. */
import { isIsoDate, localDate, localTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { initials } from "@/components/shell/AppShell";
import { api, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatMoney, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { ClockCard } from "../field/ClockCard";
import { CATEGORY_LABELS, type TimerCategory } from "../field/fieldData";
import { useMyCrews } from "../schedule/myCrews";
import { useDispatchOptions } from "../schedule/VisitDialog";
import { timeEntryProblem } from "@crewtavo/core/pay";
import { entrySpan } from "./entrySpan";
import { PayPeriods } from "./PayPeriods";

const hours = (start: string, end: string | null) => ((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 3_600_000;
const mondayOf = (date: string) => addDaysIso(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));

interface Entry {
  id: string;
  user_id: string;
  category: TimerCategory;
  started_at: string;
  ended_at: string | null;
  approved_at: string | null;
  /** The clock was left running and stopped by Crewtavo: the end time is a guess. */
  auto_stopped_at: string | null;
  notes: string | null;
  visit: { title: string } | null;
  job: { title: string } | null;
}
interface TeamMember { user_id: string; labor_rate: number | null; active: boolean; profile: { full_name: string; color: string | null } | null }

export function TimesheetsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office") && can(session, "timesheets");
  // Crew leads see their crew's time (the database limits the rows) and approve it with the area.
  const isLead = session.role === "crew_lead";
  const canApprove = isOffice || (isLead && can(session, "timesheets"));
  const approvable = (userId: string) => canApprove && !(isLead && userId === session.userId);
  const [week, setWeek] = useState(mondayOf(todayIn(tz)));
  // Pay (each person's pay for a period, and marking it paid) is for the office with job costs.
  const seesPay = hasRole(session, "admin", "office") && can(session, "job_costs");
  const [view, setView] = useState<"hours" | "pay">("hours");
  const [editing, setEditing] = useState<Entry | "new" | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(week, i));

  const data = useQuery({
    queryKey: ["time", session.company.id, week],
    queryFn: async () => {
      const [rows, team] = await Promise.all([
        supabase()
          .from("time_entries")
          .select("id, user_id, category, started_at, ended_at, approved_at, auto_stopped_at, notes, visit:visits(title), job:jobs(title)")
          .eq("company_id", session.company.id)
          .gte("started_at", zonedTimeToUtc(week, "00:00", tz).toISOString())
          .lt("started_at", zonedTimeToUtc(addDaysIso(week, 7), "00:00", tz).toISOString())
          .order("started_at"),
        api.get<TeamMember[]>("/team"),
      ]);
      return { rows: unwrap(rows) as unknown as Entry[], team };
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["time", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["running-timer"] });
    queryClient.invalidateQueries({ queryKey: ["job"] });
  };
  const approve = useMutation({
    meta: { success: (n: number) => `Approved ${n} ${n === 1 ? "entry" : "entries"}` },
    mutationFn: async (userIds: string[]) => {
      let count = 0;
      for (const userId of userIds) {
        const rate = data.data?.team.find((m) => m.user_id === userId)?.labor_rate ?? null;
        const ids = data.data!.rows.filter((r) => r.user_id === userId && r.ended_at && !r.approved_at).map((r) => r.id);
        if (!ids.length) continue;
        unwrap(await supabase().from("time_entries").update({ approved_at: new Date().toISOString(), approved_by: session.userId, labor_rate: rate }).in("id", ids));
        count += ids.length;
      }
      return count;
    },
    onSuccess: refresh,
  });
  const unapprove = useMutation({
    meta: { success: "Approval removed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("time_entries").update({ approved_at: null, approved_by: null }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Time entry deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("time_entries").delete().eq("id", id)),
    onSuccess: refresh,
  });

  const name = (id: string) => data.data?.team.find((m) => m.user_id === id)?.profile?.full_name ?? "Team member";
  const color = (id: string) => data.data?.team.find((m) => m.user_id === id)?.profile?.color ?? "var(--text-3)";
  const rows = data.data?.rows ?? [];
  const people = [...new Set(rows.map((r) => r.user_id))].sort((a, b) => name(a).localeCompare(name(b)));
  const dayOf = (iso: string) => localDate(new Date(iso), tz);
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const pendingAll = rows.filter((r) => r.ended_at && !r.approved_at && approvable(r.user_id)).length;
  const isThisWeek = week === mondayOf(todayIn(tz));

  const exportCsv = () =>
    downloadCsv(
      `timesheets-${week}.csv`,
      toCsv(
        rows.map((r) => ({
          person: name(r.user_id), date: dayOf(r.started_at), start: fmtTime(r.started_at), end: r.ended_at ? fmtTime(r.ended_at) : "",
          hours: r.ended_at ? hours(r.started_at, r.ended_at).toFixed(2) : "", category: CATEGORY_LABELS[r.category], work: r.visit?.title ?? r.job?.title ?? "", approved: r.approved_at ? "yes" : "no",
        })),
        [{ key: "person", label: "Person" }, { key: "date", label: "Date" }, { key: "start", label: "Start" }, { key: "end", label: "End" }, { key: "hours", label: "Hours" }, { key: "category", label: "Type" }, { key: "work", label: "Visit or job" }, { key: "approved", label: "Approved" }],
      ),
    );

  const tabs = seesPay && (
    <div className="underline-tabs" role="tablist" aria-label="Timesheets">
      <button type="button" role="tab" aria-selected={view === "hours"} onClick={() => setView("hours")}>Hours</button>
      <button type="button" role="tab" aria-selected={view === "pay"} onClick={() => setView("pay")}>Pay</button>
    </div>
  );
  if (view === "pay") {
    return (
      <>
        <PageHeader title="Timesheets" />
        {tabs}
        <PayPeriods />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Timesheets"
        actions={
          <>
            {isOffice && <Menu items={[{ label: "Download as spreadsheet", icon: "download", onSelect: exportCsv, disabled: !rows.length }]} />}
            <Button icon="plus" onClick={() => setEditing("new")}>Add time</Button>
            {canApprove && pendingAll > 0 && <Button variant="primary" icon="check" loading={approve.isPending} onClick={() => approve.mutate(people.filter(approvable))}>Approve all ({pendingAll})</Button>}
          </>
        }
      />
      {tabs}
      {isThisWeek && <ClockCard />}

      <div className="toolbar">
        <div className="btn-group">
          <Button size="sm" icon="chevronLeft" aria-label="Previous week" onClick={() => setWeek(addDaysIso(week, -7))} />
          <Button size="sm" onClick={() => setWeek(mondayOf(todayIn(tz)))}>This week</Button>
          <Button size="sm" icon="chevronRight" aria-label="Next week" onClick={() => setWeek(addDaysIso(week, 7))} />
        </div>
        <strong style={{ fontSize: 16 }}>{dayLabel(week)} – {dayLabel(addDaysIso(week, 6))}</strong>
      </div>

      {data.isPending && <Loading><div className="stack">{[0, 1].map((i) => <CardSkeleton key={i} lines={4} />)}</div></Loading>}
      {data.error && <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>}
      {data.data && people.length === 0 && <div className="card"><EmptyState icon="clock" title="No time recorded this week" action={<Button icon="plus" onClick={() => setEditing("new")}>Add time</Button>} /></div>}

      {people.map((userId) => {
        const mine = rows.filter((r) => r.user_id === userId);
        const total = mine.reduce((s, r) => s + hours(r.started_at, r.ended_at), 0);
        const pending = mine.filter((r) => r.ended_at && !r.approved_at).length;
        const rate = data.data?.team.find((m) => m.user_id === userId)?.labor_rate;
        return (
          <section key={userId} className="card">
            <div className="card-head" style={{ flexWrap: "wrap" }}>
              <span className="avatar" style={{ width: 30, height: 30, fontSize: 11, background: color(userId) }}>{initials(name(userId))}</span>
              <strong>{name(userId)}</strong>
              <span className="tabular"><strong>{total.toFixed(2)}</strong> h{isOffice && rate ? <span className="muted"> · {formatMoney(total * Number(rate))}</span> : null}</span>
              {total > 40 && <span className="chip chip-amber">{(total - 40).toFixed(1)} h over 40</span>}
              {approvable(userId) && pending > 0 && <Button size="sm" icon="check" loading={approve.isPending && approve.variables?.length === 1 && approve.variables[0] === userId} onClick={() => approve.mutate([userId])}>Approve {pending}</Button>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", borderBottom: "1px solid var(--divider)" }} className="hide-mobile">
              {days.map((d) => {
                const h = mine.filter((r) => dayOf(r.started_at) === d).reduce((s, r) => s + hours(r.started_at, r.ended_at), 0);
                return (
                  <div key={d} style={{ padding: "10px 12px", borderRight: "1px solid var(--row-divider)", background: d === todayIn(tz) ? "var(--green-tint)" : undefined }}>
                    <div className="muted small">{dayLabel(d).split(",")[0]}</div>
                    <div className="tabular strong" style={{ color: h ? "var(--ink)" : "var(--text-4)" }}>{h ? h.toFixed(1) : "—"}</div>
                  </div>
                );
              })}
            </div>
            {mine.map((r) => {
              const canEdit = isOffice || (!r.approved_at && (r.user_id === session.userId || isLead));
              return (
                <div key={r.id} className="card-row">
                  <span className="small strong" style={{ width: 92 }}>{dayLabel(dayOf(r.started_at))}</span>
                  <span className="grow">
                    <span className="tabular">{fmtTime(r.started_at)} – {r.ended_at ? fmtTime(r.ended_at) : "now"}</span>
                    <span className="muted small" style={{ display: "block" }}>{r.visit?.title ?? r.job?.title ?? CATEGORY_LABELS[r.category]}{r.notes ? ` · ${r.notes}` : ""}</span>
                  </span>
                  <span className="tabular strong">{hours(r.started_at, r.ended_at).toFixed(2)} h</span>
                  {r.auto_stopped_at && !r.approved_at && <span title="The clock was left running, so Crewtavo stopped it. Check the end time."><StatusPill label="Check end time" tone="danger" /></span>}
                  {r.approved_at ? <StatusPill label="Approved" tone="good" /> : r.ended_at ? <StatusPill label="Pending" tone="warning" /> : <StatusPill label="Running" tone="info" />}
                  {canEdit && (
                    <Menu
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      items={[
                        { label: "Edit", icon: "edit", hidden: !r.ended_at, onSelect: () => setEditing(r) },
                        { label: "Remove approval", icon: "undo", hidden: !approvable(r.user_id) || !r.approved_at, onSelect: () => unapprove.mutate(r.id) },
                        { label: "Delete", icon: "trash", danger: true, onSelect: async () => (await confirm({ title: "Delete this time entry?", confirmLabel: "Delete", danger: true })) && remove.mutate(r.id) },
                      ]}
                    />
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      {editing && <TimeEntryDialog entry={editing === "new" ? null : editing} team={data.data?.team ?? []} defaultDate={isThisWeek ? todayIn(tz) : week} onClose={() => setEditing(null)} onSaved={refresh} />}
    </>
  );
}

function TimeEntryDialog({ entry, team, defaultDate, onClose, onSaved }: { entry: Entry | null; team: TeamMember[]; defaultDate: string; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office", "crew_lead");
  const crew = useCrewmates(session.role === "crew_lead");
  const people = team.filter((m) => m.active && (session.role !== "crew_lead" || crew.has(m.user_id)));
  const [userId, setUserId] = useState(entry?.user_id ?? session.userId);
  const [date, setDate] = useState(entry ? localDate(new Date(entry.started_at), tz) : defaultDate);
  const [start, setStart] = useState(entry ? localTime(new Date(entry.started_at), tz) : "08:00");
  const [end, setEnd] = useState(entry?.ended_at ? localTime(new Date(entry.ended_at), tz) : "16:30");
  const [category, setCategory] = useState<TimerCategory>(entry?.category ?? "other");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  // Null while the date or a time is cleared (past midnight means the next day).
  const span = entrySpan(date, start, end, tz);
  const length = span ? (span.endAt.getTime() - span.startAt.getTime()) / 3_600_000 : 0;
  const future = Boolean(span && span.startAt.getTime() > Date.now());
  const save = useMutation({
    meta: { inline: true, success: entry ? "Time entry saved" : "Time added" },
    mutationFn: async () => {
      if (!span) throw new Error("Enter the date and the start and end times.");
      const { startAt, endAt } = span;
      // The same checks AI assistants' time tools make (packages/core/src/pay.ts).
      const problem = timeEntryProblem({ startAt, endAt });
      if (problem) throw new Error(problem);
      // A fixed entry is no longer a guess.
      const row = { started_at: startAt.toISOString(), ended_at: endAt.toISOString(), category, notes: notes.trim() || null, ...(entry ? { auto_stopped_at: null } : {}) };
      if (entry) unwrap(await supabase().from("time_entries").update(row).eq("id", entry.id));
      else unwrap(await supabase().from("time_entries").insert({ ...row, company_id: session.company.id, user_id: userId }));
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={entry ? "Edit time" : "Add time"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {isOffice && !entry && (
          <Field label="Person">
            <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {people.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name || "Team member"}</option>)}
            </select>
          </Field>
        )}
        <div className="form-grid">
          <Field label="Date" error={isIsoDate(date) ? null : "Pick a date"}><input className="input" type="date" value={date} max={todayIn(tz)} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label="Start"><input className="input" type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></Field>
          <Field label="End" hint={length > 0 ? `${length.toFixed(2)} hours${end <= start ? " (ends the next day)" : ""}` : undefined}><input className="input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} required /></Field>
        </div>
        <Field label="Type">
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as TimerCategory)}>
            {(Object.keys(CATEGORY_LABELS) as TimerCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </Field>
        <Field label="Note" optional><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Forgot to clock in at the Shah job" /></Field>
        {length > 12 && <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">That's a {length.toFixed(1)}-hour entry. Double-check the times.</div></div>}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={future || !span}>{entry ? "Save" : "Add time"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Me and the people on the crews I lead or am on (for a crew lead's "Add time"). */
function useCrewmates(enabled: boolean): Set<string> {
  const session = useSession();
  const crews = useMyCrews(enabled);
  const options = useDispatchOptions();
  const mine = crews.data ?? [];
  return new Set([
    session.userId,
    ...(options.data?.crewMembers ?? []).filter((m) => mine.includes(m.crew_id)).map((m) => m.user_id),
    ...(options.data?.crews ?? []).filter((c) => mine.includes(c.id) && c.lead_user_id).map((c) => c.lead_user_id!),
  ]);
}
