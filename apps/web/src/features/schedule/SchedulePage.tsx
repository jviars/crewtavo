/**
 * The schedule: a time grid for a day (one lane per crew) or a week, and a month view. Drag a visit
 * to move it (mouse or finger), drag its bottom edge to change its length, click an open spot to
 * book it, and drag visits in and out of the unscheduled list. Every change can be undone.
 * Click a visit to see it all (Edit changes it). Drops snap to the time step in Settings → Schedule.
 * Also: rain-day shifts, a visit for many jobs at once, and Organize route for each crew's day.
 * Events from other calendars (added on the Apps page) show alongside, and can be hidden.
 * Each visit shows the initials of the people on it, and the board can show one person's visits.
 */
import { scheduleSettings } from "@crewtavo/core/routing";
import { localDate, localTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { initials } from "@/components/shell/AppShell";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, formatTime, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { CalendarEventDialog, monthLabel, type CalendarEvent } from "./CalendarEventDialog";
import { RouteDialog } from "./RouteDialog";
import { clock, lengthOf, minutesOf, TimeGrid, useGridScale, type GridColumn, type GridExternal } from "./TimeGrid";
import { useVisitDrag, type DropTarget } from "./useVisitDrag";
import { VisitDetails } from "./VisitDetails";
import { VisitDialog, type VisitInput } from "./VisitDialog";
import { useSchedulingRights } from "./myCrews";

interface Visit {
  id: string;
  title: string;
  kind: string;
  status: string;
  scheduled_on: string | null;
  starts_at: string | null;
  ends_at: string | null;
  route_order: number | null;
  time_fixed?: boolean;
  hold_reason: string | null;
  crew_id: string | null;
  notes: string | null;
  job: { id: string; number: number; title: string; client: { id: string; display_name: string } | null } | null;
  property: { id: string; line1: string; city: string | null; lat: number | null; lng: number | null } | null;
  assignees: Array<{ user_id: string }>;
  series_day: number | null;
  series_total: number | null;
  crewColor?: string;
}
interface ScheduleData {
  visits: Visit[];
  unscheduled: Visit[];
  crews: Array<{ id: string; name: string; color: string | null }>;
  /** Other calendars' events (people who see the whole schedule). */
  events?: CalendarEvent[];
}
type View = "day" | "week" | "month";
/** Someone on the team, from GET /api/team (former members too, so old visits keep their names). */
interface Person { user_id: string; active: boolean; profile: { full_name: string | null; email: string | null; color: string | null } | null }
type Patch = Partial<Pick<Visit, "scheduled_on" | "starts_at" | "ends_at" | "crew_id" | "status">>;

/** Monday of the week containing `date`. */
function weekStart(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return addDaysIso(date, -((d.getUTCDay() + 6) % 7));
}
const label = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const lengthLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} ${m === 60 ? "hour" : "hours"}`);
const toMinutes = (t: string | undefined, fallback: number) => {
  const [h, m] = (t ?? "").split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : fallback;
};
const sameTime = (a: string | null | undefined, b: string | null | undefined) => (a && b ? Date.parse(a) === Date.parse(b) : (a ?? null) === (b ?? null));

function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: not remembered
  }
}

export function SchedulePage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const [params, setParams] = useSearchParams();
  const [view, setViewState] = useState<View>(() => {
    const choice = params.get("view") ?? readPref("crewtavo.schedule.view");
    if (choice === "day" || choice === "week" || choice === "month") return choice;
    return window.matchMedia("(max-width: 700px)").matches ? "day" : "week";
  });
  const [anchor, setAnchor] = useState(params.get("date") ?? today);
  const [crewId, setCrewId] = useState("");
  // Whose visits: "" everyone, a person's id, or "none" for visits nobody is on yet.
  const [person, setPersonState] = useState(() => readPref("crewtavo.schedule.person") ?? "");
  const [editing, setEditing] = useState<VisitInput | null>(null);
  const [dialog, setDialog] = useState<null | "shift" | "bulk">(null);
  const [panel, setPanelState] = useState<boolean | null>(() => (readPref("crewtavo.schedule.panel") === "closed" ? false : null));
  const [showCalendars, setShowCalendarsState] = useState(() => readPref("crewtavo.schedule.calendars") !== "hidden");
  const [viewing, setViewing] = useState<CalendarEvent | null>(null);
  const [details, setDetails] = useState<Visit | null>(null);
  const [routing, setRouting] = useState<{ crew: string; name: string } | null>(null);
  const rights = useSchedulingRights();
  const { canDispatch, wholeTeam } = rights;
  const canMove = (v: { crew_id: string | null }) => rights.canChange(v.crew_id);
  const hours = (session.company.settings?.working_hours ?? {}) as { start?: string; end?: string };
  const workStart = toMinutes(hours.start, 7 * 60);
  const workEnd = toMinutes(hours.end, 18 * 60);
  const { timeStep } = scheduleSettings(session.company.settings);

  useEffect(() => {
    if (params.get("new") === "1") {
      setEditing({ title: "", kind: "job", scheduled_on: anchor });
      setParams({}, { replace: true });
    }
  }, [params, setParams, anchor]);
  const setView = (v: View) => {
    setViewState(v);
    writePref("crewtavo.schedule.view", v);
  };
  const setPanel = (open: boolean) => {
    setPanelState(open);
    writePref("crewtavo.schedule.panel", open ? "open" : "closed");
  };
  const setShowCalendars = (on: boolean) => {
    setShowCalendarsState(on);
    writePref("crewtavo.schedule.calendars", on ? "shown" : "hidden");
  };
  const setPerson = (id: string) => {
    setPersonState(id);
    writePref("crewtavo.schedule.person", id);
  };
  const ppm = useGridScale();

  const range = useMemo(() => {
    if (view === "day") return { from: anchor, to: anchor };
    if (view === "week") {
      const from = weekStart(anchor);
      return { from, to: addDaysIso(from, 6) };
    }
    const first = `${anchor.slice(0, 7)}-01`;
    const from = weekStart(first);
    return { from, to: addDaysIso(from, 41) };
  }, [view, anchor]);
  const days = useMemo(() => Array.from({ length: view === "day" ? 1 : view === "week" ? 7 : 42 }, (_, i) => addDaysIso(range.from, i)), [range.from, view]);
  const key = ["schedule", session.company.id, range.from, range.to, crewId];

  const schedule = useQuery({
    queryKey: key,
    placeholderData: keepPreviousData,
    // Changes someone else makes (another dispatcher, a crew finishing a visit) show up within 20
    // seconds while the board is open, and right away when it comes back into view.
    refetchInterval: 20_000,
    queryFn: () => api.get<ScheduleData>(`/schedule?from=${range.from}&to=${range.to}${crewId ? `&crew_id=${crewId}` : ""}`),
  });

  // Names and colors for the initials on each visit. Field crew see only their own visits, so they
  // have nobody else's to pick.
  const team = useQuery({ queryKey: ["team", session.company.id], staleTime: 5 * 60_000, queryFn: () => api.get<Person[]>("/team") });
  const personById = new Map((team.data ?? []).map((p) => [p.user_id, p]));
  const nameOf = (id: string) => {
    const p = personById.get(id);
    return id === session.userId ? "You" : p?.profile?.full_name || p?.profile?.email || "Someone";
  };
  const pickable = (team.data ?? [])
    .filter((p) => p.active && p.user_id !== session.userId)
    .sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id)));
  const canPickPerson = session.role !== "field_crew" && pickable.length > 0;
  // A remembered person who has since left the team shows everyone again.
  const shownPerson = !canPickPerson || (team.data && person && person !== "none" && person !== session.userId && !pickable.some((p) => p.user_id === person)) ? "" : person;
  const forPerson = (v: Visit) => !shownPerson || (shownPerson === "none" ? v.assignees.length === 0 : v.assignees.some((a) => a.user_id === shownPerson));

  // Card times in the company's zone, like the grid and the visit dialog.
  const timeOf = (iso: string) => formatTime(iso, tz);
  const crews = schedule.data?.crews ?? [];
  const crewOf = (id: string | null) => crews.find((c) => c.id === id);
  const withColor = (v: Visit): Visit => ({ ...v, crewColor: crewOf(v.crew_id)?.color ?? undefined });
  const scheduled = (schedule.data?.visits ?? []).map(withColor).filter(forPerson);
  const unscheduled = (schedule.data?.unscheduled ?? []).map(withColor).filter(forPerson);
  // A route's stop numbers set the order; otherwise timed visits by time, then anytime ones.
  const byDay = (date: string) =>
    scheduled
      .filter((v) => v.scheduled_on === date)
      .sort((a, b) =>
        a.route_order != null && b.route_order != null
          ? a.route_order - b.route_order
          : a.starts_at && b.starts_at
            ? a.starts_at.localeCompare(b.starts_at)
            : a.starts_at
              ? -1
              : b.starts_at
                ? 1
                : (a.route_order ?? 999) - (b.route_order ?? 999),
      );
  /** Opening a visit shows it; its Edit button opens the form. */
  const show = (v: Visit) => setDetails(v);
  const open = (v: Visit) => setEditing({ ...v, job_id: v.job?.id ?? null, property_id: v.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id), context: v.job ? { label: `Job #${v.job.number}${v.job.client ? ` · ${v.job.client.display_name}` : ""}`, to: `/jobs/${v.job.id}` } : null });

  // ---- Other calendars ---------------------------------------------------------------------------
  const allEvents = schedule.data?.events ?? [];
  const events = showCalendars ? allEvents : [];
  const calendarsShown = [...new Map(allEvents.filter((e) => e.source).map((e) => [e.source!.id, e.source!])).values()];
  const eventById = new Map(allEvents.map((e) => [e.id, e]));
  /** An event as one day's column shows it: timed if it fits in the day, otherwise in Anytime. */
  const onDay = (e: CalendarEvent, date: string): GridExternal => {
    const fits = !e.all_day && e.starts_at && e.ends_at && e.starts_on === e.ends_on;
    return {
      id: `${e.id}:${date}`,
      title: e.title,
      starts_at: fits ? e.starts_at : null,
      ends_at: fits ? e.ends_at : null,
      color: e.source?.color ?? null,
      busy: e.busy,
      calendar: e.source?.name ?? "Calendar",
      // A crew's own busy time marks its visits double-booked.
      crew_id: e.busy && e.source?.blocks_time ? e.source.crew_id : null,
    };
  };
  const eventsOn = (date: string) => events.filter((e) => e.starts_on <= date && e.ends_on >= date);
  const ownCrew = (e: CalendarEvent) => (e.source?.crew_id && crews.some((c) => c.id === e.source!.crew_id) ? e.source.crew_id : null);
  /** Day view: a crew's calendars in its lane, the whole team's in "No crew" (or the one lane when filtered). */
  const externalFor = (col: GridColumn) =>
    eventsOn(col.date)
      .filter((e) => col.crew === undefined || Boolean(crewId) || (col.crew ? ownCrew(e) === col.crew : !ownCrew(e)))
      .map((e) => onDay(e, col.date));
  const openExternal = (g: GridExternal) => {
    const e = eventById.get(g.id.split(":")[0]!);
    if (e) setViewing(e);
  };

  // ---- Changes from dragging, with undo ----------------------------------------------------------
  const update = useMutation({
    mutationFn: ({ visit, patch }: { visit: Visit; patch: Patch; message: string; undoable: boolean }) => api.patch(`/visits/${visit.id}`, patch),
    onMutate: async ({ visit, patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ScheduleData>(key);
      queryClient.setQueryData<ScheduleData>(key, (old) => {
        if (!old) return old;
        const next = { ...visit, ...patch } as Visit;
        const off = next.status === "unscheduled" || !next.scheduled_on;
        const inRange = !off && next.scheduled_on! >= range.from && next.scheduled_on! <= range.to;
        return {
          ...old,
          visits: [...old.visits.filter((v) => v.id !== visit.id), ...(inRange ? [next] : [])],
          unscheduled: [...old.unscheduled.filter((v) => v.id !== visit.id), ...(off ? [next] : [])],
        };
      });
      return { previous };
    },
    onError: (_e, _v, context) => context?.previous && queryClient.setQueryData(key, context.previous),
    onSuccess: (_d, { visit, patch, message, undoable }) => {
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, visit[k as keyof Patch]])) as Patch;
      toast.success(message, undoable ? { action: { label: "Undo", onClick: () => update.mutate({ visit: { ...visit, ...patch } as Visit, patch: before, message: "Change undone", undoable: false }) } } : undefined);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const drop = (visit: Visit, target: DropTarget, duration: number) => {
    const wasOff = visit.status === "unscheduled";
    const when = (date: string) => label(date, { weekday: "short", month: "short", day: "numeric" });
    const crewPart = (crew: string | undefined): Patch => (crew !== undefined && (crew || null) !== visit.crew_id ? { crew_id: crew || null } : {});
    const crewNote = (crew: string | undefined) => (crew !== undefined && (crew || null) !== visit.crew_id ? ` · ${crewOf(crew || null)?.name ?? "no crew"}` : "");
    let patch: Patch;
    let message: string;
    if (target.type === "unscheduled") {
      if (wasOff) return;
      patch = { status: "unscheduled", scheduled_on: null, starts_at: null, ends_at: null };
      message = "Moved to unscheduled";
    } else if (target.type === "day") {
      if (visit.scheduled_on === target.date && !wasOff) return;
      patch = { ...patchFor(visit, target.date, tz), ...(wasOff ? { status: "scheduled" } : {}) };
      message = `Moved to ${when(target.date)}`;
    } else if (target.type === "anytime") {
      patch = { scheduled_on: target.date, starts_at: null, ends_at: null, ...crewPart(target.crew), ...(wasOff ? { status: "scheduled" } : {}) };
      message = `${when(target.date)}, anytime${crewNote(target.crew)}`;
    } else {
      const start = zonedTimeToUtc(target.date, hhmm(target.minutes), tz);
      patch = {
        scheduled_on: target.date,
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + duration * 60_000).toISOString(),
        ...crewPart(target.crew),
        ...(wasOff ? { status: "scheduled" } : {}),
      };
      const resized = visit.scheduled_on === target.date && sameTime(visit.starts_at, patch.starts_at) && !sameTime(visit.ends_at, patch.ends_at);
      message = resized ? `Now ${lengthLabel(duration)}` : `${when(target.date)} at ${clock(target.minutes)}${crewNote(target.crew)}`;
    }
    const changed = (Object.keys(patch) as Array<keyof Patch>).some((k) => (k === "starts_at" || k === "ends_at" ? !sameTime(visit[k], patch[k]) : (visit[k] ?? null) !== (patch[k] ?? null)));
    if (changed) update.mutate({ visit, patch, message, undoable: true });
  };

  const { drag, start: startDrag, wasDragging } = useVisitDrag<Visit>({
    enabled: canDispatch,
    step: timeStep,
    timing: (v) => ({ start: v.starts_at ? minutesOf(v.starts_at, tz) : null, duration: lengthOf(v) }),
    onDrop: drop,
  });

  const step = (dir: 1 | -1) => {
    if (view === "month") {
      const d = new Date(`${anchor.slice(0, 7)}-15T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + dir);
      setAnchor(d.toISOString().slice(0, 10));
    } else setAnchor(addDaysIso(anchor, view === "week" ? 7 * dir : dir));
  };
  const heading =
    view === "day"
      ? label(anchor, { weekday: "long", month: "long", day: "numeric" })
      : view === "week"
        ? range.from.slice(5, 7) === range.to.slice(5, 7)
          ? `${label(range.from, { month: "short", day: "numeric" })} – ${Number(range.to.slice(8))}, ${range.to.slice(0, 4)}`
          : `${label(range.from, { month: "short", day: "numeric" })} – ${label(range.to, { month: "short", day: "numeric" })}, ${range.to.slice(0, 4)}`
        : label(`${anchor.slice(0, 7)}-15`, { month: "long", year: "numeric" });

  // The hours shown: the workday plus an hour either side, stretched to fit any visit.
  const span = useMemo(() => {
    let lo = workStart - 60;
    let hi = workEnd + 60;
    const timed = [...(schedule.data?.visits ?? []), ...(showCalendars ? (schedule.data?.events ?? []).filter((e) => !e.all_day && e.starts_on === e.ends_on) : [])];
    for (const v of timed) {
      if (!v.starts_at) continue;
      const s = minutesOf(v.starts_at, tz);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s + lengthOf(v));
    }
    return { startMin: Math.max(0, Math.floor(lo / 60) * 60), endMin: Math.min(24 * 60, Math.ceil(hi / 60) * 60) };
  }, [schedule.data, tz, workStart, workEnd, showCalendars]);

  const namesOn = (v: Visit) => v.assignees.map((a) => nameOf(a.user_id)).join(", ");
  const firstNames = (v: Visit) => v.assignees.map((a) => nameOf(a.user_id).split(/\s+/)[0]).join(", ");
  /** The initials of the people on a visit, in their colors; yours ringed. */
  const faces = (v: Visit) => {
    if (!v.assignees.length) return null;
    const names = namesOn(v);
    return (
      <span className="tg-people" title={names}>
        {v.assignees.slice(0, 3).map(({ user_id: id }) => {
          const p = personById.get(id);
          return <i key={id} data-me={id === session.userId || undefined} style={{ "--p": p?.profile?.color ?? undefined } as CSSProperties} aria-hidden="true">{initials(p?.profile?.full_name || p?.profile?.email)}</i>;
        })}
        {v.assignees.length > 3 && <i data-more aria-hidden="true">+{v.assignees.length - 3}</i>}
        <span className="sr-only">With {names.replace(/^You\b/, "you")}</span>
      </span>
    );
  };

  const content = (v: Visit, size: "tiny" | "short" | "full") => {
    const who = v.job?.client?.display_name ?? v.property?.line1;
    const done = v.status === "completed" ? "✓ " : "";
    const day = v.series_total && v.series_total > 1 ? ` · day ${v.series_day}/${v.series_total}` : "";
    const stop = v.route_order && v.status === "scheduled" ? `${v.route_order}. ` : "";
    if (size === "tiny") return <span className="tg-line"><span className="tg-n" style={{ WebkitLineClamp: 1 }}>{stop}{done}{v.title}{day}</span>{faces(v)}</span>;
    // A short visit keeps the people beside its time; a longer one has room to name them.
    const time = v.starts_at && <span className="tg-t">{stop}{timeOf(v.starts_at)}{v.ends_at ? ` – ${timeOf(v.ends_at)}` : ""}</span>;
    return (
      <>
        {size === "short" ? <span className="tg-line">{time}{faces(v)}</span> : time}
        <span className="tg-n">{done}{v.title}{day}</span>
        {size === "full" && who && <span className="tg-m">{who}</span>}
        {size === "full" && v.assignees.length > 0 && <span className="tg-line tg-who">{faces(v)}<span className="tg-m" aria-hidden="true">{firstNames(v)}</span></span>}
        {size === "full" && v.hold_reason && <span className="tg-w" title={v.hold_reason}>⚠ {v.hold_reason.split(";")[0]}</span>}
      </>
    );
  };

  const newAt = (col: GridColumn, minutes: number | null) => {
    const start = minutes === null ? null : zonedTimeToUtc(col.date, hhmm(minutes), tz);
    setEditing({
      title: "",
      kind: "job",
      scheduled_on: col.date,
      starts_at: start?.toISOString() ?? null,
      ends_at: start ? new Date(start.getTime() + 60 * 60_000).toISOString() : null,
      anytime: minutes === null,
      crew_id: col.crew || null,
    });
  };

  const inLane = (crew: string | undefined) => (v: Visit) => crew === undefined || (crew ? v.crew_id === crew : !v.crew_id || !crews.some((c) => c.id === v.crew_id));
  const laneVisits = (col: GridColumn) => byDay(col.date).filter(inLane(col.crew));
  const lanes: GridColumn[] = [
    ...(crewId ? crews.filter((c) => c.id === crewId) : crews).map((c) => ({ key: c.id, date: anchor, crew: c.id, color: c.color, label: c.name })),
    ...(crewId ? [] : [{ key: "none", date: anchor, crew: "", label: "No crew" }]),
  ];
  const dayColumns: GridColumn[] = lanes.map((col) => {
    const lane = laneVisits(col);
    const stops = lane.filter((v) => v.status === "scheduled");
    return {
      ...col,
      today: anchor === today,
      past: anchor < today,
      headerExtra: (
        <span className="row" style={{ gap: 4 }}>
          {canDispatch && stops.length > 0 && anchor >= today && rights.canChange(col.crew || null) && (
            <Button size="sm" variant="ghost" icon="navigation" title="Organize this crew's route by distance" onClick={() => setRouting({ crew: col.crew ?? "", name: typeof col.label === "string" ? col.label : "Crew" })}>Route</Button>
          )}
          <span className="muted small">{lane.length || ""}</span>
        </span>
      ),
    };
  });
  const weekColumns: GridColumn[] = days.map((date) => ({
    key: date,
    date,
    today: date === today,
    past: date < today,
    label: label(date, { weekday: "short", day: "numeric" }),
    onHeaderClick: () => {
      setAnchor(date);
      setView("day");
    },
    headerExtra: <span className="muted small">{byDay(date).length || ""}</span>,
  }));

  const showPanel = (panel ?? unscheduled.length > 0) && (canDispatch || unscheduled.length > 0);
  const grid = {
    tz,
    ...span,
    canDispatch,
    canMove,
    drag,
    startDrag,
    wasDragging,
    onOpen: show,
    onCreate: newAt,
    content,
    ppm,
    visitsFor: laneVisits,
    externalFor,
    onOpenExternal: openExternal,
    stale: schedule.isPlaceholderData,
  };

  return (
    <>
      <PageHeader
        title="Schedule"
        actions={
          canDispatch && (
            <>
              <Menu
                label="More scheduling tools"
                items={[
                  { label: "Rain day: move a day's visits", icon: "cloud", onSelect: () => setDialog("shift") },
                  { label: "Add a visit to many jobs", icon: "calendarCheck", hidden: !wholeTeam, onSelect: () => setDialog("bulk") },
                ]}
              />
              <Button variant="primary" icon="plus" onClick={() => setEditing({ title: "", kind: "job", scheduled_on: view === "day" ? anchor : today })}>New visit</Button>
            </>
          )
        }
      />
      <div className="toolbar">
        <div className="btn-group">
          <Button size="sm" icon="chevronLeft" aria-label="Previous" onClick={() => step(-1)} />
          <Button size="sm" onClick={() => setAnchor(today)}>Today</Button>
          <Button size="sm" icon="chevronRight" aria-label="Next" onClick={() => step(1)} />
        </div>
        <strong style={{ fontSize: 16, minWidth: 200 }}>{heading}</strong>
        {schedule.isFetching && !schedule.isPending && <span className="spinner" style={{ width: 14, height: 14, color: "var(--text-3)" }} aria-label="Refreshing" />}
        <span className="grow" />
        {(canDispatch || unscheduled.length > 0) && !showPanel && (
          <Button size="sm" icon="inbox" onClick={() => setPanel(true)}>Unscheduled{unscheduled.length ? ` · ${unscheduled.length}` : ""}</Button>
        )}
        {(allEvents.length > 0 || !showCalendars) && (
          <Button size="sm" icon="calendar" title={showCalendars ? "Hide events from other calendars" : "Show events from other calendars"} onClick={() => setShowCalendars(!showCalendars)}>
            {showCalendars ? "Hide calendars" : "Show calendars"}
          </Button>
        )}
        {canPickPerson && (
          <select className="select" style={{ width: "auto" }} value={shownPerson} onChange={(e) => setPerson(e.target.value)} aria-label="Whose visits to show">
            <option value="">Everyone</option>
            <option value={session.userId}>Just mine</option>
            {pickable.map((p) => <option key={p.user_id} value={p.user_id}>{nameOf(p.user_id)}</option>)}
            {canDispatch && <option value="none">Nobody assigned yet</option>}
          </select>
        )}
        {crews.length > 1 && (
          <select className="select" style={{ width: "auto" }} value={crewId} onChange={(e) => setCrewId(e.target.value)} aria-label="Filter by crew">
            <option value="">All crews</option>
            {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <div className="segmented" role="group" aria-label="View">
          {(["day", "week", "month"] as const).map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}
        </div>
      </div>
      {((crews.length > 0 && view !== "day") || (showCalendars && calendarsShown.length > 0)) && (
        <div className="crew-legend">
          {view !== "day" && crews.map((c) => <span key={c.id}><i style={{ ["--c" as string]: c.color ?? "var(--text-4)" }} />{c.name}</span>)}
          {showCalendars && calendarsShown.map((s) => <span key={s.id} title="Another calendar"><i data-calendar style={{ ["--c" as string]: s.color ?? "var(--text-4)" }} />{s.name}</span>)}
        </div>
      )}

      {schedule.error && !schedule.data && <div className="card"><ErrorState error={schedule.error} onRetry={() => schedule.refetch()} /></div>}
      {schedule.isPending && <ScheduleSkeleton view={view} />}

      {schedule.data && (
        <div className="schedule-layout" data-panel={showPanel || undefined}>
          <div style={{ minWidth: 0 }}>
            {view === "week" && <TimeGrid columns={weekColumns} minColumn={96} {...grid} />}
            {view === "day" && <TimeGrid columns={dayColumns} minColumn={160} {...grid} />}
            {view === "month" && (
              <div className={`month${schedule.isPlaceholderData ? " is-stale" : ""}`}>
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="month-head">{d}</div>)}
                {days.map((date) => {
                  const visits = byDay(date);
                  const shown = visits.slice(0, 3);
                  const dayEvents = eventsOn(date);
                  const shownEvents = dayEvents.slice(0, Math.max(0, 3 - shown.length));
                  const more = visits.length + dayEvents.length - shown.length - shownEvents.length;
                  return (
                    <div
                      key={date}
                      className="month-cell"
                      data-drop="day"
                      data-date={date}
                      data-over={(drag?.target?.type === "day" && drag.target.date === date) || undefined}
                      data-outside={date.slice(0, 7) !== anchor.slice(0, 7) || undefined}
                      data-today={date === today || undefined}
                    >
                      <button type="button" className="month-day" onClick={() => { setAnchor(date); setView("day"); }}>
                        <span>{Number(date.slice(8))}</span>
                        {visits.length > 0 && <span className="muted small">{visits.length}</span>}
                      </button>
                      {shown.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className="month-chip"
                          data-status={v.status}
                          style={{ ["--crew" as string]: v.crewColor }}
                          title={v.assignees.length ? `${v.title} · ${namesOn(v)}` : v.title}
                          onPointerDown={canDispatch && canMove(v) && !["completed", "cancelled"].includes(v.status) ? startDrag(v, "move") : undefined}
                          onClick={() => !wasDragging() && show(v)}
                        >
                          {v.starts_at ? `${timeOf(v.starts_at)} ` : ""}{v.title}
                        </button>
                      ))}
                      {shownEvents.map((e) => (
                        <button key={e.id} type="button" className="month-chip" data-external data-free={!e.busy || undefined} style={{ ["--cal" as string]: e.source?.color ?? undefined }} title={`${e.title} · ${e.source?.name ?? "Calendar"}`} onClick={() => setViewing(e)}>
                          {monthLabel(e, date, tz)}
                        </button>
                      ))}
                      {more > 0 && <button type="button" className="month-more" onClick={() => { setAnchor(date); setView("day"); }}>+{more} more</button>}
                    </div>
                  );
                })}
              </div>
            )}
            {canDispatch && view !== "month" && <p className="muted small" style={{ margin: "8px 2px 0" }}>Drag a visit to move it, drag its bottom edge to change how long it takes, or click an open time to book it.</p>}
          </div>

          {showPanel && (
            <aside className="unscheduled-panel" aria-label="Unscheduled visits" data-drop="unscheduled" data-over={drag?.target?.type === "unscheduled" || undefined}>
              <div className="row-between">
                <strong>Unscheduled</strong>
                <span className="row" style={{ gap: 4 }}>
                  {unscheduled.length > 0 && <span className="badge">{unscheduled.length}</span>}
                  <Button size="sm" variant="ghost" icon="x" aria-label="Hide unscheduled" onClick={() => setPanel(false)} />
                </span>
              </div>
              {unscheduled.length === 0 ? (
                <span className="muted small">Nothing waiting. Drag a visit here to take it off the calendar.</span>
              ) : (
                <>
                  {canDispatch && <span className="muted small">Drag onto the calendar to schedule.</span>}
                  {unscheduled.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="tg-chip"
                      data-dragging={drag?.visit.id === v.id || undefined}
                      style={{ "--crew": v.crewColor } as CSSProperties}
                      onPointerDown={canDispatch && canMove(v) ? startDrag(v, "move") : undefined}
                      onClick={() => !wasDragging() && show(v)}
                    >
                      <span className="tg-line"><strong className="grow">{v.title}</strong>{faces(v)}</span>
                      {(v.job?.client || v.property) && <span className="muted small">{v.job?.client?.display_name ?? v.property?.line1}</span>}
                    </button>
                  ))}
                </>
              )}
            </aside>
          )}
        </div>
      )}

      {details && (
        <VisitDetails
          visitId={details.id}
          onClose={() => setDetails(null)}
          onEdit={canMove(details) ? () => { const v = details; setDetails(null); open(v); } : undefined}
        />
      )}
      {editing && <VisitDialog visit={editing} onClose={() => setEditing(null)} />}
      {routing && <RouteDialog date={anchor} crewId={routing.crew} crewName={routing.name} onClose={() => setRouting(null)} />}
      {viewing && (
        <CalendarEventDialog
          event={viewing}
          tz={tz}
          onClose={() => setViewing(null)}
          // "Add to schedule": a new visit with the event's time and words, ready to adjust.
          onAddVisit={canDispatch ? (input) => { setViewing(null); setEditing(input); } : undefined}
        />
      )}
      {dialog === "shift" && <ShiftDialog defaultDate={view === "day" ? anchor : today} crews={wholeTeam ? crews : crews.filter((c) => rights.myCrews.includes(c.id))} allCrews={wholeTeam} onClose={() => setDialog(null)} />}
      {dialog === "bulk" && <BulkVisitsDialog defaultDate={view === "day" ? anchor : addDaysIso(today, 1)} crews={crews} onClose={() => setDialog(null)} />}
    </>
  );
}

/** New date for a visit, keeping its local start time and length. */
function patchFor(visit: Visit, date: string, tz: string) {
  if (!visit.starts_at) return { scheduled_on: date, status: visit.status === "unscheduled" ? "scheduled" : visit.status };
  const start = zonedTimeToUtc(date, localTime(new Date(visit.starts_at), tz), tz);
  const length = visit.ends_at ? Date.parse(visit.ends_at) - Date.parse(visit.starts_at) : 3_600_000;
  return { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + length).toISOString(), scheduled_on: localDate(start, tz) };
}

function ScheduleSkeleton({ view }: { view: View }) {
  const cols = view === "day" ? 3 : 7;
  return (
    <Loading>
      <div className={view === "month" ? "month" : "week"} style={view === "day" ? { gridTemplateColumns: "repeat(3, 1fr)" } : undefined}>
        {Array.from({ length: view === "month" ? 35 : cols }, (_, i) => (
          <div key={i} className={view === "month" ? "month-cell" : "day-col"}>
            <Skeleton width="50%" height={11} />
            {Array.from({ length: view === "month" ? 1 : 2 + (i % 3) }, (_, j) => <Skeleton key={j} height={view === "month" ? 14 : 54} radius={8} />)}
          </div>
        ))}
      </div>
    </Loading>
  );
}

function ShiftDialog({ defaultDate, crews, allCrews, onClose }: { defaultDate: string; crews: Array<{ id: string; name: string }>; allCrews: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [fromDate, setFromDate] = useState(defaultDate);
  const [toDate, setToDate] = useState(addDaysIso(defaultDate, 1));
  // A crew lead moves their own crew's day; the office can move everyone's.
  const [crewId, setCrewId] = useState(allCrews ? "" : crews[0]?.id ?? "");
  const shift = useMutation({
    meta: { inline: true, success: (r: { moved: number }) => (r.moved ? `Moved ${r.moved} ${r.moved === 1 ? "visit" : "visits"} to ${label(toDate, { weekday: "short", month: "short", day: "numeric" })}` : "No open visits on that day") },
    mutationFn: () => api.post<{ moved: number }>("/schedule/shift", { from_date: fromDate, to_date: toDate, crew_id: crewId || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Rain day" description="Move all open visits to another day. Start times stay the same.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); shift.mutate(); }}>
        <div className="form-grid">
          <Field label="From"><input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} required /></Field>
          <Field label="To"><input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} required /></Field>
          <Field label="Crew">
            <select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              {allCrews && <option value="">All crews</option>}
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        {fromDate === toDate && <p className="error-text">Pick two different days.</p>}
        <FormError error={shift.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="cloud" loading={shift.isPending} disabled={fromDate === toDate}>Move visits</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Snow day or storm cleanup: one visit for each chosen job on a date. */
function BulkVisitsDialog({ defaultDate, crews, onClose }: { defaultDate: string; crews: Array<{ id: string; name: string }>; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [date, setDate] = useState(defaultDate);
  const [crewId, setCrewId] = useState("");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const jobs = useQuery({
    queryKey: ["jobs", session.company.id, "bulk-picker"],
    queryFn: async () => unwrap(await supabase().from("jobs").select("id, number, title, client:clients(display_name)").eq("company_id", session.company.id).eq("status", "active").order("title").limit(500)),
  });
  const shown = (jobs.data ?? []).filter((j) => `${j.title} ${j.client?.display_name ?? ""} ${j.number}`.toLowerCase().includes(term.toLowerCase()));
  const create = useMutation({
    meta: { inline: true, success: (r: { created: number }) => `Added ${r.created} ${r.created === 1 ? "visit" : "visits"}` },
    mutationFn: () => api.post<{ created: number }>("/schedule/bulk-visits", { job_ids: picked, date, crew_id: crewId || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Add a visit to many jobs" size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <div className="form-grid">
          <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label="Crew">
            <select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">Each job's default crew</option>
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="row-between">
          <input className="input" style={{ maxWidth: 280 }} placeholder="Filter jobs" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Filter jobs" />
          <span className="row">
            <span className="muted small">{picked.length} selected</span>
            <Button size="sm" variant="ghost" onClick={() => setPicked(picked.length === shown.length ? [] : shown.map((j) => j.id))}>{picked.length === shown.length && shown.length ? "Clear" : "Select all"}</Button>
          </span>
        </div>
        <div className="card" style={{ maxHeight: 300, overflowY: "auto", boxShadow: "none" }}>
          {jobs.isPending && <div className="card-row"><Skeleton width="60%" /></div>}
          {shown.map((j) => (
            <label key={j.id} className="card-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
              <span className="grow"><strong>{j.title}</strong><span className="muted small" style={{ display: "block" }}>Job #{j.number} · {j.client?.display_name}</span></span>
            </label>
          ))}
          {jobs.data && !shown.length && <div className="empty">No active jobs match.</div>}
        </div>
        <FormError error={create.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="calendarCheck" loading={create.isPending} disabled={!picked.length}>Add {picked.length || ""} {picked.length === 1 ? "visit" : "visits"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

