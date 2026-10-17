/**
 * Create or edit a visit, assessment, task or event: date, time (or anytime), crew, people, status
 * and notes, with "Find a time" for open slots. Used by Schedule, Job, Request and Home.
 */
import { localDate, localTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { initials } from "@/components/shell/AppShell";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSchedulingRights } from "./myCrews";

export interface VisitInput {
  id?: string;
  job_id?: string | null;
  request_id?: string | null;
  property_id?: string | null;
  title: string;
  kind?: string;
  status?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  scheduled_on?: string | null;
  crew_id?: string | null;
  notes?: string | null;
  assignee_ids?: string[];
  /** A new visit with no set time (from the schedule's "anytime" row). */
  anytime?: boolean;
  /** Shown for context, e.g. "Job #12 · Jordan Rivera". */
  context?: { label: string; to: string } | null;
}

const STATUSES: Array<[string, string]> = [
  ["scheduled", "Scheduled"],
  ["en_route", "On the way"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
  ["unscheduled", "Unscheduled (no date yet)"],
];
const KINDS: Array<[string, string]> = [["job", "Visit for a job"], ["assessment", "Assessment"], ["task", "Task"], ["event", "Event"]];
const LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600];
const lengthLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} ${m === 60 ? "hour" : "hours"}`);

interface TeamMember {
  user_id: string;
  role: string;
  active: boolean;
  profile: { full_name: string; color: string | null } | null;
}

export function useDispatchOptions() {
  const session = useSession();
  return useQuery({
    queryKey: ["dispatch-options", session.company.id],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [crews, members, team] = await Promise.all([
        supabase().from("crews").select("id, name, color, lead_user_id").eq("company_id", session.company.id).eq("active", true).order("name"),
        supabase().from("crew_members").select("crew_id, user_id").eq("company_id", session.company.id),
        api.get<TeamMember[]>("/team"),
      ]);
      return { crews: unwrap(crews), crewMembers: unwrap(members), team: team.filter((m) => m.active) };
    },
  });
}

export function VisitDialog({ visit, onClose, onSaved }: { visit: VisitInput; onClose: () => void; onSaved?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const rights = useSchedulingRights();
  const isNew = !visit.id;
  // The office schedules everyone; a crew lead without "Schedule the whole team" runs their own crew.
  const canDispatch = isNew ? rights.canDispatch : rights.canChange(visit.crew_id ?? null);
  const startDate = visit.starts_at ? localDate(new Date(visit.starts_at), tz) : visit.scheduled_on ?? todayIn(tz);
  const minutes = visit.starts_at && visit.ends_at ? Math.round((new Date(visit.ends_at).getTime() - new Date(visit.starts_at).getTime()) / 60000) : 60;

  const [title, setTitle] = useState(visit.title);
  const [kind, setKind] = useState(visit.kind ?? (visit.job_id ? "job" : "task"));
  // A new visit from the schedule can be for any active job: pick it here.
  const pickJob = isNew && !visit.job_id && !visit.request_id;
  const [job, setJob] = useState<PickedJob | null>(null);
  const [date, setDate] = useState(startDate);
  const [anytime, setAnytime] = useState(visit.anytime ?? (!visit.starts_at && !isNew ? true : !visit.starts_at && Boolean(visit.job_id)));
  const [time, setTime] = useState(visit.starts_at ? localTime(new Date(visit.starts_at), tz) : "08:00");
  const [duration, setDuration] = useState(minutes);
  const [crewId, setCrewId] = useState(visit.crew_id ?? "");
  const [status, setStatus] = useState(visit.status ?? "scheduled");
  const [notes, setNotes] = useState(visit.notes ?? "");
  const [assignees, setAssignees] = useState<string[]>(visit.assignee_ids ?? []);
  const [slots, setSlots] = useState<Array<{ starts_at: string; ends_at: string }> | null>(null);
  // Multi-day work: a new booking can span days (one linked visit per work day).
  const [days, setDays] = useState(1);
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [moveLater, setMoveLater] = useState(true);
  const [equipment, setEquipment] = useState<string[] | null>(isNew ? [] : null);
  const options = useDispatchOptions();
  const extra = useQuery({
    queryKey: ["visit-extra", visit.id],
    enabled: !isNew,
    queryFn: async () => unwrapOne(await supabase().from("visits").select("series_id, series_day, series_total, equipment:visit_equipment(equipment_id)").eq("id", visit.id!).maybeSingle(), "This visit"),
  });
  useEffect(() => {
    if (extra.data && equipment === null) setEquipment(extra.data.equipment.map((e) => e.equipment_id));
  }, [extra.data, equipment]);
  const series = extra.data?.series_total && extra.data.series_total > 1 ? { day: extra.data.series_day!, total: extra.data.series_total } : null;
  const machines = useEquipmentChoices();
  const picked = equipment ?? [];
  const start = !anytime && status !== "unscheduled" ? zonedTimeToUtc(date, time, tz) : null;
  const clashes = useQuery({
    queryKey: ["equipment-clash", picked.join(","), date, start?.toISOString(), duration, visit.id],
    enabled: picked.length > 0 && status !== "unscheduled",
    queryFn: async () =>
      unwrap(
        await supabase().rpc("equipment_conflicts", {
          p_company: session.company.id,
          p_equipment: picked,
          p_day: date,
          // Anytime visits have no times: null means "any time that day".
          p_starts: (start?.toISOString() ?? null) as string,
          p_ends: (start ? new Date(start.getTime() + duration * 60_000).toISOString() : null) as string,
          p_except: visit.id ?? undefined,
        }),
      ),
  });
  const unscheduled = status === "unscheduled";
  const crewChoices = (options.data?.crews ?? []).filter((c) => !rights.ownCrew || rights.myCrews.includes(c.id));
  // A crew lead puts people from their own crews on a visit (and keeps anyone the office added).
  const crewmates = new Set([
    session.userId,
    ...(options.data?.crewMembers ?? []).filter((m) => rights.myCrews.includes(m.crew_id)).map((m) => m.user_id),
    ...(options.data?.crews ?? []).filter((c) => rights.myCrews.includes(c.id) && c.lead_user_id).map((c) => c.lead_user_id!),
  ]);
  const people = (options.data?.team ?? []).filter((m) => !rights.ownCrew || crewmates.has(m.user_id) || assignees.includes(m.user_id));
  // Once the crews are known, a crew lead's new visit starts on their crew, with its people.
  useEffect(() => {
    if (rights.ownCrew && isNew && !crewId && rights.myCrews.length && options.data) chooseCrew(rights.myCrews[0]!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rights.ownCrew, rights.myCrews.length, options.data]);

  const chooseJob = (j: PickedJob | null) => {
    setJob(j);
    if (!j) return;
    if (!title.trim()) setTitle(j.title);
    if (!crewId && j.default_crew_id) chooseCrew(j.default_crew_id);
  };
  const chooseCrew = (id: string) => {
    setCrewId(id);
    // Picking a crew brings its people along, if nobody's been picked yet.
    if (id && !assignees.length && options.data) setAssignees(options.data.crewMembers.filter((m) => m.crew_id === id).map((m) => m.user_id));
  };

  const findTime = useMutation({
    mutationFn: () => api.post<{ slots: Array<{ starts_at: string; ends_at: string }> }>("/schedule/find-time", { date_from: date < todayIn(tz) ? todayIn(tz) : date, days: 7, duration_min: duration, crew_id: crewId || undefined }),
    onSuccess: (r) => setSlots(r.slots),
  });

  const refresh = () => {
    for (const key of ["schedule", "job", "request", "dashboard", "field"]) queryClient.invalidateQueries({ queryKey: [key] });
  };

  const save = useMutation({
    meta: { inline: true, success: isNew ? (unscheduled ? "Added to unscheduled" : days > 1 ? `Scheduled ${days} days` : "Scheduled") : "Visit saved" },
    mutationFn: async () => {
      const start = anytime || unscheduled ? null : zonedTimeToUtc(date, time, tz);
      const fields = {
        title: title.trim(),
        scheduled_on: unscheduled ? null : date,
        starts_at: start?.toISOString() ?? null,
        ends_at: start ? new Date(start.getTime() + duration * 60_000).toISOString() : null,
        crew_id: crewId || null,
        status,
        notes: notes.trim() || null,
      };
      if (!isNew) {
        const dateChanged = fields.scheduled_on !== startDate;
        await api.patch(`/visits/${visit.id}`, {
          ...fields,
          assignee_ids: canDispatch ? assignees : undefined,
          equipment_ids: canDispatch && equipment ? equipment : undefined,
          shift_series: Boolean(series && series.day < series.total && dateChanged && moveLater),
        });
        return;
      }
      await api.post<{ ids: string[] }>("/visits", {
        ...fields,
        job_id: visit.job_id ?? (kind === "job" ? job?.id ?? null : null),
        request_id: visit.request_id ?? null,
        property_id: visit.property_id ?? (kind === "job" ? job?.property_id ?? null : null),
        kind: kind === "job" && !visit.job_id && !job ? "task" : kind,
        days: unscheduled ? 1 : days,
        skip_weekends: skipWeekends,
        assignee_ids: assignees,
        equipment_ids: picked,
      });
      if (kind === "assessment" && visit.request_id) {
        await supabase().from("requests").update({ status: "assessment_scheduled" }).eq("id", visit.request_id).eq("status", "new");
      }
    },
    onSuccess: () => {
      refresh();
      onSaved?.();
      onClose();
    },
  });
  const remove = useMutation({
    meta: { success: "Visit deleted" },
    mutationFn: async () => unwrap(await supabase().from("visits").delete().eq("id", visit.id!)),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const heading = isNew ? (kind === "assessment" ? "Schedule an assessment" : kind === "job" ? "Schedule a visit" : kind === "event" ? "New event" : "New task") : series ? `Edit visit · day ${series.day} of ${series.total}` : "Edit visit";

  return (
    <Dialog open onClose={onClose} title={heading} description={visit.context ? <Link to={visit.context.to}>{visit.context.label}</Link> : undefined} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {pickJob && (
          <div className="segmented" role="group" aria-label="What is it?" style={{ justifySelf: "start" }}>
            {KINDS.map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}
          </div>
        )}
        {pickJob && kind === "job" && <JobPicker value={job} onChange={chooseJob} />}
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={!canDispatch} placeholder={kind === "job" ? "What the crew is doing" : "Drop off estimate, supply run…"} /></Field>

        {!unscheduled && (
          <>
            <div className="form-grid">
              <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setSlots(null); }} required disabled={!canDispatch} /></Field>
              <Field label="Start time"><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={anytime || !canDispatch} required={!anytime} /></Field>
              <Field label="Length">
                <select className="select" value={duration} onChange={(e) => { setDuration(Number(e.target.value)); setSlots(null); }} disabled={anytime || !canDispatch}>
                  {[...new Set([...LENGTHS, duration])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{lengthLabel(m)}</option>)}
                </select>
              </Field>
            </div>
            <div className="row-between wrap">
              <label className="switch-row" style={{ fontWeight: 500 }}>
                <input type="checkbox" className="switch" checked={anytime} onChange={(e) => setAnytime(e.target.checked)} disabled={!canDispatch} />
                Anytime that day
              </label>
              {canDispatch && !anytime && <Button size="sm" variant="ghost" icon="search" loading={findTime.isPending} onClick={() => findTime.mutate()}>Find a time</Button>}
            </div>
            {slots && (
              <div className="stack-sm">
                <span className="muted small">{slots.length ? `Open slots for ${lengthLabel(duration)}${crewId ? " for this crew" : ""}:` : "No open slots in the next 7 days during working hours."}</span>
                <div className="row wrap" style={{ gap: 6 }}>
                  {slots.map((s) => {
                    const d = localDate(new Date(s.starts_at), tz);
                    const t = localTime(new Date(s.starts_at), tz);
                    const active = d === date && t === time;
                    return (
                      <button key={s.starts_at} type="button" className="tab" aria-pressed={active} onClick={() => { setDate(d); setTime(t); }}>
                        {new Date(s.starts_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz })}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {isNew && canDispatch && (
              <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
                <Field label="How many days" hint={days > 1 ? `${days} linked visits: ${workDays(date, days, skipWeekends).map(shortDay).join(", ")}` : "Multi-day work becomes one visit per day."}>
                  <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 120 }}>
                    {Array.from({ length: 14 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? "1 day" : `${n} days`}</option>)}
                  </select>
                </Field>
                {days > 1 && (
                  <label className="switch-row" style={{ fontWeight: 500, paddingBottom: 26 }}>
                    <input type="checkbox" className="switch" checked={skipWeekends} onChange={(e) => setSkipWeekends(e.target.checked)} />
                    Skip weekends
                  </label>
                )}
              </div>
            )}
            {series && series.day < series.total && date !== startDate && (
              <label className="checkbox">
                <input type="checkbox" checked={moveLater} onChange={(e) => setMoveLater(e.target.checked)} />
                <span>Also move day{series.total - series.day > 1 ? "s" : ""} {series.day + 1}{series.total - series.day > 1 ? `–${series.total}` : ""} by the same amount</span>
              </label>
            )}
          </>
        )}

        <div className="form-grid">
          <Field label="Crew">
            {options.isPending ? <Skeleton height={38} radius={8} /> : (
              <select className="select" value={crewId} onChange={(e) => chooseCrew(e.target.value)} disabled={!canDispatch}>
                {!rights.ownCrew && <option value="">No crew</option>}
                {crewChoices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>

        {canDispatch && (
          <div className="field">
            <span>People</span>
            {options.isPending ? <Skeleton height={32} /> : !people.length ? (
              <span className="muted small">{rights.ownCrew ? "Nobody is on your crew yet. Ask the office to add people to it in Settings → Crews." : "Invite your team in Settings to assign people."}</span>
            ) : (
              <div className="row wrap" style={{ gap: 6 }}>
                {people.map((m) => {
                  const on = assignees.includes(m.user_id);
                  const name = m.profile?.full_name || "Team member";
                  const locked = rights.ownCrew && !crewmates.has(m.user_id);
                  return (
                    <button
                      key={m.user_id}
                      type="button"
                      className="tab"
                      aria-pressed={on}
                      disabled={locked}
                      title={locked ? "Added by the office" : undefined}
                      onClick={() => setAssignees(on ? assignees.filter((x) => x !== m.user_id) : [...assignees, m.user_id])}
                      style={{ paddingLeft: 4 }}
                    >
                      <span className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: m.profile?.color || "var(--text-3)" }}>{initials(name)}</span>
                      {name}
                      {on && <Icon name="check" size={12} strokeWidth={3} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {canDispatch && machines.data && machines.data.length > 0 && (
          <div className="field">
            <span>Equipment</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {machines.data.map((m) => {
                const on = picked.includes(m.id);
                const shop = m.status === "in_shop";
                return (
                  <button key={m.id} type="button" className="tab" aria-pressed={on} disabled={shop && !on} title={shop ? "In the shop" : undefined} onClick={() => setEquipment(on ? picked.filter((x) => x !== m.id) : [...picked, m.id])}>
                    <Icon name="truck" size={13} />
                    {m.name}{shop ? " (in the shop)" : ""}
                    {on && <Icon name="check" size={12} strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
            {!!clashes.data?.length && (
              <div className="callout callout-warning" style={{ marginTop: 6 }}>
                <Icon name="alert" size={16} />
                <div className="grow small" style={{ fontWeight: 400 }}>
                  {clashes.data.map((cl) => (
                    <div key={`${cl.equipment_id}-${cl.visit_id}`}>
                      <strong>{machines.data.find((m) => m.id === cl.equipment_id)?.name}</strong> is also booked on {cl.title}{cl.starts_at ? ` (${new Date(cl.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}${cl.ends_at ? `–${new Date(cl.ends_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}` : ""})` : " that day"}.
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <Field label="Instructions for the crew" optional><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} /></Field>
        <p className="muted small" style={{ margin: 0 }}>Times are in {tz.replace(/_/g, " ")}.</p>
        <FormError error={save.error} />
        <div className="form-actions">
          {!isNew && canDispatch && (
            <Button
              variant="danger"
              icon="trash"
              loading={remove.isPending}
              onClick={async () => {
                if (await confirm({ title: "Delete this visit?", body: "Time logged against it is kept.", confirmLabel: "Delete visit", danger: true })) remove.mutate();
              }}
            >
              Delete
            </Button>
          )}
          <span className="spacer" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!title.trim() || (pickJob && kind === "job" && !job)}>{isNew ? (unscheduled ? "Add to unscheduled" : "Schedule") : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface PickedJob {
  id: string;
  number: number;
  title: string;
  property_id: string | null;
  default_crew_id: string | null;
  client: { display_name: string } | null;
}

/** Search the active jobs and pick one. */
function JobPicker({ value, onChange }: { value: PickedJob | null; onChange: (job: PickedJob | null) => void }) {
  const session = useSession();
  const [term, setTerm] = useState("");
  const jobs = useQuery({
    queryKey: ["jobs", session.company.id, "visit-picker"],
    staleTime: 60_000,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("jobs")
          .select("id, number, title, property_id, default_crew_id, client:clients(display_name)")
          .eq("company_id", session.company.id)
          .in("status", ["active", "requires_invoicing"])
          .order("created_at", { ascending: false })
          .limit(500),
      ) as PickedJob[],
  });
  if (value) {
    return (
      <div className="field">
        <span>Job</span>
        <div className="row" style={{ gap: 8, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 10 }}>
          <Icon name="job" size={16} />
          <span className="grow" style={{ minWidth: 0 }}>
            <strong>{value.title}</strong>
            <span className="muted small" style={{ display: "block" }}>Job #{value.number}{value.client ? ` · ${value.client.display_name}` : ""}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
        </div>
      </div>
    );
  }
  const q = term.trim().toLowerCase();
  const matches = (jobs.data ?? []).filter((j) => !q || `${j.title} ${j.client?.display_name ?? ""} #${j.number}`.toLowerCase().includes(q)).slice(0, 6);
  return (
    <div className="field">
      <span>Job</span>
      <input className="input" placeholder="Search by job, client or number" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search jobs" autoFocus />
      <div className="card" style={{ boxShadow: "none" }}>
        {jobs.isPending && <div className="card-row"><Skeleton width="60%" /></div>}
        {matches.map((j) => (
          <button key={j.id} type="button" className="card-row" style={{ width: "100%", border: 0, background: "transparent", textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => onChange(j)}>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{j.title}</strong>
              <span className="muted small" style={{ display: "block" }}>Job #{j.number}{j.client ? ` · ${j.client.display_name}` : ""}</span>
            </span>
          </button>
        ))}
        {jobs.data && !matches.length && <div className="empty" style={{ padding: 14 }}>{jobs.data.length ? "No jobs match." : "No active jobs yet. Turn a quote into a job first, or schedule a task."}</div>}
      </div>
    </div>
  );
}

/** Equipment that can go out on a visit (not retired), for the visit's equipment picker. */
function useEquipmentChoices() {
  const session = useSession();
  return useQuery({
    queryKey: ["equipment-choices", session.company.id],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("equipment").select("id, name, kind, status").eq("company_id", session.company.id).neq("status", "retired").order("name")),
  });
}

/** The dates a multi-day booking lands on, the same way the API picks them. */
function workDays(first: string, count: number, skipWeekends: boolean): string[] {
  const out: string[] = [];
  for (let d = first; out.length < count; d = addDaysIso(d, 1)) {
    const weekend = [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
    if (count > 1 && skipWeekends && weekend && out.length > 0) continue;
    out.push(d);
  }
  return out;
}
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
