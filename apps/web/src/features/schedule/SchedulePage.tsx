/**
 * The schedule: a time grid for a day (one lane per crew) or a week, and a month view. Drag a visit
 * to move it (mouse or finger), drag its bottom edge to change its length, click an open spot to
 * book it, and drag visits in and out of the unscheduled list. Every change can be undone.
 * Click a visit to see it all (Edit changes it). Drops snap to the time step in Settings → Schedule.
 * Also: rain-day shifts, a visit for many jobs at once, and Organize route for each crew's day, which
 * opens in Apple Maps or Google Maps from the crew's lane.
 * Events from other calendars (added on the Apps page) show alongside, and can be hidden.
 * Each visit shows the initials of the people on it, and the board can show one person's visits.
 * Crews | People switches the day and week views between a lane per crew and a row per person
 * (dropping a visit on someone puts them on it, and someone on two visits at once is marked). List
 * shows a day's, week's or month's visits under each day, and Map a day's visits as pins.
 */
import { scheduleSettings } from "@crewtavo/core/routing";
import { localDate, localTime, zonedTimeToUtc } from "@crewtavo/core/time";
import { crewPeople, visitPeople, type CrewMember } from "@crewtavo/core/visitPeople";
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow } from "@/components/ui/InboxList";
import { RouteMapsLink } from "@/components/ui/MapsLink";
import { Menu, type MenuEntry, type MenuSearch } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { Face } from "@/components/ui/Avatar";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, addressLine, formatTime, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { CalendarEventDialog, monthLabel, type CalendarEvent } from "./CalendarEventDialog";
import { dayRoute } from "./dayRoute";
import { RouteDialog } from "./RouteDialog";
import { clock, conflictsOf, conflictText, fitBlock, lengthOf, minutesOf, TimeGrid, TimeRange, useGridScale, useMedia, usePhoneGrid, type GridColumn, type GridExternal } from "./TimeGrid";
import { useVisitDrag, type DropTarget } from "./useVisitDrag";
import { VisitDetails } from "./VisitDetails";
import { VisitDialog, type VisitInput } from "./VisitDialog";
import { usePendingChanges } from "./changeRequests";
import { useSchedulingRights } from "./myCrews";
import { eventOnRow, movePeople, onRow, peopleRows } from "./people";
import { filterLine } from "./filterLine";
import { spanDays, stepMonth, weekStart, type Span } from "./range";
import { intlLocale, msg, t } from "@/lib/i18n";
import { Select } from "@/components/ui/Select";

const ScheduleMap = lazy(() => import("./ScheduleMap").then((m) => ({ default: m.ScheduleMap })));

/** The Jobs list and job pages say Late, Today, Upcoming or Unscheduled from the visits (public.job_state). */
const refreshJobs = (queryClient: QueryClient) => {
  for (const key of ["jobs", "job"]) queryClient.invalidateQueries({ queryKey: [key] });
};

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
  property: { id: string; line1: string; line2?: string | null; city: string | null; region?: string | null; postal_code?: string | null; lat: number | null; lng: number | null } | null;
  /** Where an entry with no client property is (a task). */
  address?: string | null;
  assignees: Array<{ user_id: string }>;
  series_day: number | null;
  series_total: number | null;
  crewColor?: string;
}
interface ScheduleData {
  visits: Visit[];
  unscheduled: Visit[];
  crews: Array<{ id: string; name: string; color: string | null }>;
  /** Who's on each crew: a visit with nobody listed has its crew's members on it. */
  crew_members?: CrewMember[];
  /** Other calendars' events (people who see the whole schedule). */
  events?: CalendarEvent[];
}
type View = "day" | "week" | "month" | "list" | "map";
const VIEWS: View[] = ["day", "week", "month", "list", "map"];
/** Each view by name, said in the person's language where it's shown. */
const VIEW_LABELS: Record<View, string> = { day: msg("Day"), week: msg("Week"), month: msg("Month"), list: msg("List"), map: msg("Map") };
const VIEW_ICONS: Record<View, IconName> = { day: "clock", week: "table", month: "calendar", list: "list", map: "map" };
const SPANS: Span[] = ["day", "week", "month"];
type Board = "crews" | "people";
/** Someone on the team, from GET /api/team (former members too, so old visits keep their names). */
/** Someone on visits (GET /team?with_subs=1): the team, and subs, with their business as `sub`. */
interface Person { user_id: string; active: boolean; profile: { full_name: string | null; email: string | null; color: string | null; avatar_url?: string | null } | null; sub?: { id: string; name: string } }
type Moves = Partial<Pick<Visit, "scheduled_on" | "starts_at" | "ends_at" | "crew_id" | "status">>;
type Patch = Moves & { assignee_ids?: string[] };
/** A visit with a change made: the people go to the API as assignee_ids, and the board reads them as assignees. */
const applied = (visit: Visit, patch: Patch): Visit => ({ ...visit, ...patch, ...(patch.assignee_ids && { assignees: patch.assignee_ids.map((user_id) => ({ user_id })) }) });

const label = (date: string, opts: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString(intlLocale(), { ...opts, timeZone: "UTC" });
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const lengthLabel = (m: number) => (m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} ${m === 60 ? "hour" : "hours"}`);
const toMinutes = (t: string | undefined, fallback: number) => {
  // A time that was never set is the fallback: Number("") is 0, which would read as midnight.
  const [h, m] = t ? t.split(":").map(Number) : [];
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
  // The view and Crews | People are each person's own on this device, so a shared tablet keeps everyone's.
  const viewKey = `crewtavo.schedule.view.${session.company.id}.${session.userId}`;
  const boardKey = `crewtavo.schedule.board.${session.company.id}.${session.userId}`;
  const listKey = `crewtavo.schedule.list.${session.company.id}.${session.userId}`;
  const [listSpan, setListSpanState] = useState<Span>(() => {
    const choice = readPref(listKey) ?? readPref(viewKey);
    return SPANS.includes(choice as Span) ? (choice as Span) : "week";
  });
  const [view, setViewState] = useState<View>(() => {
    const choice = params.get("view") ?? readPref(viewKey) ?? readPref("crewtavo.schedule.view");
    if (VIEWS.includes(choice as View)) return choice as View;
    return window.matchMedia("(max-width: 700px)").matches ? "day" : "week";
  });
  const [boardChoice, setBoardChoice] = useState(() => readPref(boardKey));
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
  const setListSpan = (s: Span) => {
    setListSpanState(s);
    writePref(listKey, s);
  };
  const setView = (v: View) => {
    setViewState(v);
    writePref(viewKey, v);
    // List shows the days of the view it's opened from, until its Range is changed.
    if (SPANS.includes(v as Span)) setListSpan(v as Span);
  };
  const setBoard = (b: Board) => {
    setBoardChoice(b);
    writePref(boardKey, b);
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
  // A phone's day shows every crew in one column, in their colors (Mobile-Work.dc.html), not a lane each.
  const phoneGrid = usePhoneGrid();
  // Where the phone's header and menus take over from the desktop's bar (components.css's 900px).
  const phoneLayout = useMedia("(max-width: 900px)");
  const unscheduledList = useListAnimation<HTMLDivElement>();

  // The map shows a day, and the list a day, a week or a month (its own days, not the month grid's).
  const period: Span = view === "list" ? listSpan : view === "map" ? "day" : view;
  const oneDay = period === "day";
  const days = useMemo(() => spanDays(period, anchor, view !== "list"), [period, anchor, view]);
  const range = { from: days[0]!, to: days[days.length - 1]! };
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
  // Subs on visits aren't on the team: they come too, named by their business (also once they
  // can't sign in, so old visits keep their names).
  const team = useQuery({ queryKey: ["team", session.company.id, "with-subs"], staleTime: 5 * 60_000, queryFn: () => api.get<Person[]>("/team?with_subs=1") });
  const personById = new Map((team.data ?? []).map((p) => [p.user_id, p]));
  const nameOf = (id: string) => {
    const p = personById.get(id);
    return id === session.userId ? t("You") : p?.sub?.name || p?.profile?.full_name || p?.profile?.email || t("Someone");
  };
  const pickable = (team.data ?? [])
    .filter((p) => p.active && !p.sub && p.user_id !== session.userId)
    .sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id)));
  const canPickPerson = hasRole(session, "admin", "office", "estimator", "crew_lead") && pickable.length > 0;
  // A remembered person who has since left the team shows everyone again.
  const shownPerson = !canPickPerson || (team.data && person && person !== "none" && person !== session.userId && !pickable.some((p) => p.user_id === person)) ? "" : person;
  // Who's on a visit: the people listed on it or, with nobody listed, its crew's members (visitPeople).
  const crewMembers = schedule.data?.crew_members;
  const onCrews = useMemo(() => crewPeople(crewMembers), [crewMembers]);
  const forPerson = (v: Visit) => !shownPerson || onRow(v, shownPerson === "none" ? "" : shownPerson, onCrews);

  // Card times in the company's zone, like the grid and the visit dialog.
  const timeOf = (iso: string) => formatTime(iso, tz);
  const crews = schedule.data?.crews ?? [];
  const crewOf = (id: string | null) => crews.find((c) => c.id === id);
  const withColor = (v: Visit): Visit => ({ ...v, crewColor: crewOf(v.crew_id)?.color ?? undefined });
  const scheduled = (schedule.data?.visits ?? []).map(withColor).filter(forPerson);
  const unscheduled = (schedule.data?.unscheduled ?? []).map(withColor).filter(forPerson);
  // Until someone picks, a business with no crews sees People.
  const board: Board = boardChoice === "crews" || boardChoice === "people" ? boardChoice : schedule.data && !crews.length ? "people" : "crews";
  const byPerson = board === "people" && (view === "day" || view === "week");
  // One column for the whole day on a phone, every crew's visits side by side in their colors.
  const merged = phoneGrid && view === "day" && !byPerson && !crewId && crews.length > 0;
  // A row (lane) per person, and one for visits nobody's on yet, like "No crew". Picking a person shows only theirs.
  const rowPeople = peopleRows(team.data ?? [], scheduled, nameOf, session.userId, onCrews);
  const rowIds = new Set(rowPeople.map((p) => p.user_id));
  const personLanes: GridColumn[] = [
    ...rowPeople.map((p): GridColumn => ({ key: p.user_id, date: anchor, person: p.user_id, color: p.profile?.color, label: nameOf(p.user_id) })),
    { key: "nobody", date: anchor, person: "", label: t("Nobody assigned") },
  ].filter((col) => !shownPerson || col.person === (shownPerson === "none" ? "" : shownPerson));
  const who = (id: string) => (id === session.userId ? "you" : nameOf(id));
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
  const open = (v: Visit) => setEditing({ ...v, job_id: v.job?.id ?? null, property_id: v.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id), context: v.job ? { label: `${t("Job #{number}", { number: v.job.number })}${v.job.client ? ` · ${v.job.client.display_name}` : ""}`, to: `/jobs/${v.job.id}` } : null });
  // Clients' requests to move or cancel a visit, marked on it; a link to one (?visit=) opens its dialog
  // once the day's visits are in.
  const changes = new Set((usePendingChanges(canDispatch).data ?? []).map((r) => r.visit_id));
  const linked = params.get("visit");
  useEffect(() => {
    const v = linked ? schedule.data?.visits.find((x) => x.id === linked) : undefined;
    if (!v) return;
    if (canMove(v)) open(withColor(v));
    else setDetails(withColor(v));
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, schedule.data]);

  // ---- Other calendars ---------------------------------------------------------------------------
  const allEvents = schedule.data?.events ?? [];
  // A calendar can be one person's (set on the Apps page).
  const ownerOf = (e: CalendarEvent) => e.source?.user_id ?? null;
  // One person's schedule keeps the team's calendars and theirs, not other people's.
  const events = showCalendars ? allEvents.filter((e) => !shownPerson || !ownerOf(e) || ownerOf(e) === shownPerson) : [];
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
      // A crew's own busy time marks its visits double-booked, and a person's theirs on their row.
      crew_id: e.busy && e.source?.blocks_time ? e.source.crew_id : null,
      person: e.busy && e.source?.blocks_time ? ownerOf(e) : null,
    };
  };
  const eventsOn = (date: string) => events.filter((e) => e.starts_on <= date && e.ends_on >= date);
  const ownCrew = (e: CalendarEvent) => (e.source?.crew_id && crews.some((c) => c.id === e.source!.crew_id) ? e.source.crew_id : null);
  /**
   * Day view: a crew's calendars in its lane, the whole team's in "No crew" (or the one lane when filtered).
   * People lanes put a person's own calendar on their row, and the rest in "Nobody assigned".
   */
  const externalFor = (col: GridColumn) =>
    eventsOn(col.date)
      .filter((e) => (col.person !== undefined ? eventOnRow(ownerOf(e), col.person, rowIds) : col.crew === undefined || Boolean(crewId) || (col.crew ? ownCrew(e) === col.crew : !ownCrew(e))))
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
        const next = applied(visit, patch);
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
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, k === "assignee_ids" ? visit.assignees.map((a) => a.user_id) : visit[k as keyof Moves]])) as Patch;
      toast.success(message, { tone: "job", ...(undoable && { action: { label: t("Undo"), onClick: () => update.mutate({ visit: applied(visit, patch), patch: before, message: t("Change undone"), undoable: false }) } }) });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule", session.company.id] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      refreshJobs(queryClient);
    },
  });

  const drop = (visit: Visit, target: DropTarget, duration: number, from?: string) => {
    const wasOff = visit.status === "unscheduled";
    const when = (date: string) => label(date, { weekday: "short", month: "short", day: "numeric" });
    const crewPart = (crew: string | undefined): Moves => (crew !== undefined && (crew || null) !== visit.crew_id ? { crew_id: crew || null } : {});
    const crewNote = (crew: string | undefined) => (crew !== undefined && (crew || null) !== visit.crew_id ? ` · ${crewOf(crew || null)?.name ?? t("no crew")}` : "");
    let patch: Moves;
    let message: string;
    if (target.type === "unscheduled") {
      if (wasOff) return;
      patch = { status: "unscheduled", scheduled_on: null, starts_at: null, ends_at: null };
      message = t("Moved to unscheduled");
    } else if (target.type === "day") {
      patch = visit.scheduled_on === target.date && !wasOff ? {} : { ...patchFor(visit, target.date, tz), ...(wasOff ? { status: "scheduled" } : {}) };
      message = t("Moved to {when}", { when: when(target.date) });
    } else if (target.type === "anytime") {
      patch = { scheduled_on: target.date, starts_at: null, ends_at: null, ...crewPart(target.crew), ...(wasOff ? { status: "scheduled" } : {}) };
      message = `${t("{when}, anytime", { when: when(target.date) })}${crewNote(target.crew)}`;
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
      message = resized ? t("Now {length}", { length: lengthLabel(duration) }) : `${t("{when} at {time}", { when: when(target.date), time: clock(target.minutes) })}${crewNote(target.crew)}`;
    }
    const changed = (Object.keys(patch) as Array<keyof Moves>).some((k) => (k === "starts_at" || k === "ends_at" ? !sameTime(visit[k], patch[k]) : (visit[k] ?? null) !== (patch[k] ?? null)));
    // People view: off the row it was dragged from, onto the row it was dropped on.
    const to = target.type === "unscheduled" ? undefined : target.person;
    const assignees = to === undefined ? null : movePeople(visitPeople(visit, onCrews), from, to);
    const peopleNote = assignees && (to ? (from ? t("Moved to {who}", { who: who(to) }) : t("Added {who}", { who: who(to) })) : t("Took {who} off", { who: who(from!) }));
    if (changed || assignees) {
      update.mutate({ visit, patch: { ...(changed && patch), ...(assignees && { assignee_ids: assignees }) }, message: [changed && message, peopleNote].filter(Boolean).join(" · "), undoable: true });
    }
  };

  const { drag, start: startDrag, wasDragging } = useVisitDrag<Visit>({
    enabled: canDispatch,
    step: timeStep,
    timing: (v) => ({ start: v.starts_at ? minutesOf(v.starts_at, tz) : null, duration: lengthOf(v) }),
    onDrop: drop,
  });

  const step = (dir: 1 | -1) => setAnchor(period === "month" ? stepMonth(anchor, dir) : addDaysIso(anchor, oneDay ? dir : 7 * dir));
  const heading =
    oneDay
      ? label(anchor, { weekday: "long", month: "long", day: "numeric" })
      : period === "week"
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
  /** The faces of the people on a visit (photos, or initials in their colors); yours ringed. */
  const faces = (v: Visit) => {
    if (!v.assignees.length) return null;
    const names = namesOn(v);
    return (
      <span className="tg-people" title={names}>
        {v.assignees.slice(0, 3).map(({ user_id: id }) => {
          const p = personById.get(id);
          return <i key={id} data-me={id === session.userId || undefined} style={{ "--p": p?.profile?.color ?? undefined } as CSSProperties} aria-hidden="true"><Face name={p?.sub?.name || p?.profile?.full_name || p?.profile?.email} photo={p?.profile?.avatar_url} /></i>;
        })}
        {v.assignees.length > 3 && <i data-more aria-hidden="true">+{v.assignees.length - 3}</i>}
        <span className="sr-only">{t("With {names}", { names: names.replace(/^You\b/, "you") })}</span>
      </span>
    );
  };

  /** Its stop in the crew's route, as a small number: "Stop 2" to a screen reader. */
  const stopOf = (v: Visit) =>
    v.route_order && v.status === "scheduled" ? (
      <span className="tg-stop"><span aria-hidden="true">{v.route_order}</span><span className="sr-only">{t("Stop {number}", { number: v.route_order })} </span></span>
    ) : null;
  /** Done: a green check at the end of its first row, its words quieter. On the way or started: a blue dot. */
  const doneMark = (v: Visit) => v.status === "completed" && <span className="tg-done" title={statusText("visit", "completed")}><Icon name="check" size={12} bold /><span className="sr-only">{statusText("visit", "completed")}</span></span>;
  const liveMark = (v: Visit) => (v.status === "in_progress" || v.status === "en_route") && <span className="tg-live" title={statusText("visit", v.status)}><span className="sr-only">{statusText("visit", v.status)} </span></span>;

  /**
   * A visit's words: an Anytime chip's one line, or the rows a block's height has room for
   * (fitBlock). The time keeps a row of its own, so the people never squeeze it. On a phone's one
   * column for every crew, the time also says whose crew it is.
   */
  const content = (v: Visit, height?: number) => {
    const who = v.job?.client?.display_name ?? v.property?.line1 ?? v.address;
    const day = v.series_total && v.series_total > 1 ? ` · ${t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}` : "";
    const changed = changes.has(v.id);
    const asked = changed && <span className="tg-ask" title={t("Change requested")}><Icon name="refresh" size={11} bold /><span className="sr-only">{t("Change requested:")} </span></span>;
    if (height === undefined) return <span className="tg-line">{stopOf(v)}{liveMark(v)}<span className="tg-n" style={{ WebkitLineClamp: 1 }}>{asked}{v.title}{day}</span>{doneMark(v)}{faces(v)}</span>;
    // A change requested takes the weather hold's row: it's what to see to first.
    const fit = fitBlock(height, { time: Boolean(v.starts_at), people: v.assignees.length > 0, hold: Boolean(v.hold_reason) || changed, client: Boolean(who) });
    const crew = merged && crewOf(v.crew_id)?.name;
    const time = fit.time && v.starts_at && (
      <span className="tg-t">
        {stopOf(v)}
        {liveMark(v)}
        <span className="tg-when"><TimeRange start={timeOf(v.starts_at)} end={v.ends_at && timeOf(v.ends_at)} />{crew && <span className="tg-crew"> · {crew}</span>}</span>
        {doneMark(v)}
      </span>
    );
    const title = <span className="tg-n" style={{ WebkitLineClamp: fit.title }}>{!fit.hold && asked}{time ? null : stopOf(v)}{v.title}{day}</span>;
    return (
      <>
        {time}
        {fit.people === "inline" ? <span className="tg-line">{title}{!time && doneMark(v)}{faces(v)}</span> : title}
        {fit.client && <span className="tg-m">{who}</span>}
        {fit.people === "row" && <span className="tg-line tg-who">{faces(v)}<span className="tg-m" aria-hidden="true">{firstNames(v)}</span></span>}
        {fit.hold && (changed ? <span className="tg-w"><Icon name="refresh" size={12} bold />{t("Change requested")}</span> : <span className="tg-w" title={v.hold_reason ?? undefined}><Icon name="cloud" size={12} bold />{v.hold_reason?.split(";")[0]}</span>)}
        {!fit.people && v.assignees.length > 0 && <span className="sr-only">{t("With {names}", { names: namesOn(v).replace(/^You\b/, "you") })}</span>}
        {!time && fit.people !== "inline" && v.status === "completed" && <span className="sr-only">{statusText("visit", "completed")}</span>}
      </>
    );
  };

  /** How many visits a day (or a crew's lane) has, rolling to the new count as visits move. */
  const visitCount = (n: number) => n > 0 && <span className="sched-count"><AnimatedNumber value={n} /><span className="sr-only">{n === 1 ? t(" visit") : t(" visits")}</span></span>;

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
      ...(col.person && { assignee_ids: [col.person] }),
    });
  };

  const inLane = (crew: string | undefined) => (v: Visit) => crew === undefined || (crew ? v.crew_id === crew : !v.crew_id || !crews.some((c) => c.id === v.crew_id));
  const laneVisits = (col: GridColumn) => byDay(col.date).filter(inLane(col.crew)).filter((v) => col.person === undefined || onRow(v, col.person, onCrews));
  const lanes: GridColumn[] = [
    ...(crewId ? crews.filter((c) => c.id === crewId) : crews).map((c) => ({ key: c.id, date: anchor, crew: c.id, color: c.color, label: c.name })),
    ...(crewId ? [] : [{ key: "none", date: anchor, crew: "", label: t("No crew") }]),
  ];
  // A crew's day can be put in route order (by whoever runs that crew) once it has stops to visit.
  const canRoute = (col: GridColumn) => canDispatch && anchor >= today && rights.canChange(col.crew || null) && laneVisits(col).some((v) => v.status === "scheduled");
  const planRoute = (col: GridColumn) => setRouting({ crew: col.crew ?? "", name: typeof col.label === "string" ? col.label : t("Crew") });
  const dayColumns: GridColumn[] = lanes.map((col) => {
    const lane = laneVisits(col);
    const route = dayRoute(lane, session.company);
    return {
      ...col,
      today: anchor === today,
      past: anchor < today,
      headerExtra: (
        <>
          {visitCount(lane.length)}
          <span className="tg-colhead-end">
            {route.stops.length > 1 && anchor >= today && (
              <RouteMapsLink className="btn btn-ghost btn-sm btn-icon tg-colhead-btn" route={route}>
                <Icon name="map" size={14} />
                <span className="sr-only">{t("Open route in maps")}</span>
              </RouteMapsLink>
            )}
            {canRoute(col) && (
              <button type="button" className="tg-colhead-link" title={t("Organize this crew's route by distance")} onClick={() => planRoute(col)}>{t("Plan route")}</button>
            )}
          </span>
        </>
      ),
    };
  });
  const personColumns: GridColumn[] = personLanes.map((col) => ({ ...col, today: anchor === today, past: anchor < today, headerExtra: visitCount(laneVisits(col).length) }));
  // Day view on a phone: one column, under the week strip that already says which day it is.
  const mergedColumns: GridColumn[] = [{ key: "all", date: anchor, today: anchor === today, past: anchor < today, label: heading }];
  const weekColumns: GridColumn[] = days.map((date) => ({
    key: date,
    date,
    today: date === today,
    past: date < today,
    label: (
      <>
        <span className="tg-dow">{label(date, { weekday: "short" })}</span>
        <span className="tg-date">{Number(date.slice(8))}</span>
        <span className="sr-only">{label(date, { month: "long" })}</span>
      </>
    ),
    onHeaderClick: () => {
      setAnchor(date);
      setView("day");
    },
    headerExtra: visitCount(byDay(date).length),
  }));

  // Open by itself when something's waiting, except on a phone, where it would sit under the whole board.
  const showPanel = (panel ?? (unscheduled.length > 0 && !phoneLayout)) && (canDispatch || unscheduled.length > 0);
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
    selected: details?.id ?? editing?.id ?? null,
  };

  // List: the week's days that have visits. Map: the day's visits, numbered in the day's order.
  const listDays = view === "list" ? days.map((date) => ({ date, visits: byDay(date) })).filter((d) => d.visits.length) : [];
  const mapVisits = view === "map" ? byDay(anchor) : [];
  const located = (v: Visit) => v.property?.lat != null && v.property.lng != null;
  const mapPins = mapVisits.flatMap((v, i) =>
    located(v) ? [{ id: v.id, lat: v.property!.lat!, lng: v.property!.lng!, label: String(i + 1), title: [v.starts_at ? timeOf(v.starts_at) : t("Anytime"), v.title, v.job?.client?.display_name].filter(Boolean).join(" · "), color: v.crewColor }] : [],
  );

  // ---- The bar over the board -------------------------------------------------------------------
  const onToday = view === "day" || view === "map" ? anchor === today : days.includes(today);
  const goToday = () => setAnchor(today);
  // A phone's title is the month it's showing, as a phone's calendar says it (with the year when it isn't this one).
  const phoneTitle = label(anchor, { month: "long", ...(anchor.slice(0, 4) !== today.slice(0, 4) && { year: "numeric" }) });
  const weekDays = spanDays("week", anchor);
  const crewNameOf = (id: string) => crews.find((c) => onCrews.get(c.id)?.includes(id))?.name;
  const face = (id: string | null) => {
    const p = id ? personById.get(id) : undefined;
    return id ? (
      <span className="sched-face" style={{ "--p": p?.profile?.color ?? undefined } as CSSProperties} aria-hidden="true"><Face name={p?.sub?.name || p?.profile?.full_name || p?.profile?.email} photo={p?.profile?.avatar_url} /></span>
    ) : (
      <span className="sched-face" data-none aria-hidden="true" />
    );
  };
  const swatch = (color: string | null | undefined) => <span className="sched-swatch" style={{ "--c": color ?? "var(--text-4)" } as CSSProperties} aria-hidden="true" />;
  const [personQuery, setPersonQuery] = useState("");
  const personMatch = (name: string) => !personQuery.trim() || name.toLowerCase().includes(personQuery.trim().toLowerCase());
  const personItems: MenuEntry[] = [
    // A round, quiet "everyone" the size of the faces under it, so every name starts at the same place.
    { label: t("Everyone"), lead: <span className="sched-face" data-all aria-hidden="true"><Icon name="users" size={phoneLayout ? 17 : 12} /></span>, checked: shownPerson === "", hidden: !personMatch(t("Everyone")), onSelect: () => setPerson("") },
    { label: t("You"), lead: face(session.userId), checked: shownPerson === session.userId, hidden: !personMatch(t("You")), onSelect: () => setPerson(session.userId) },
    { separator: true },
    ...pickable.map((p): MenuEntry => ({ label: nameOf(p.user_id), lead: face(p.user_id), end: crewNameOf(p.user_id), checked: shownPerson === p.user_id, hidden: !personMatch(nameOf(p.user_id)), onSelect: () => setPerson(p.user_id) })),
    { separator: true },
    { label: t("Nobody assigned"), lead: face(""), checked: shownPerson === "none", hidden: !canDispatch || !personMatch(t("Nobody assigned")), onSelect: () => setPerson("none") },
  ];
  // A long team gets a field to find someone in.
  const personSearch: MenuSearch | undefined = pickable.length > 8 ? { value: personQuery, onChange: setPersonQuery, placeholder: t("Search"), label: t("Person") } : undefined;
  const personName = shownPerson === "" ? t("Everyone") : shownPerson === "none" ? t("Nobody assigned") : nameOf(shownPerson);
  const crewItems: MenuEntry[] = [
    { label: t("All"), lead: swatch("transparent"), checked: !crewId, onSelect: () => setCrewId("") },
    { separator: true },
    ...crews.map((c): MenuEntry => ({ label: c.name, lead: swatch(c.color), checked: crewId === c.id, onSelect: () => setCrewId(c.id) })),
  ];
  const crewName = crews.find((c) => c.id === crewId)?.name ?? t("All");
  const rangeItems: MenuEntry[] = SPANS.map((s) => ({ label: t(VIEW_LABELS[s]), checked: listSpan === s, onSelect: () => setListSpan(s) }));
  const canSeeUnscheduled = canDispatch || unscheduled.length > 0;
  const canToggleCalendars = allEvents.length > 0 || !showCalendars;
  // The rare tools, in More; a phone has them under its View button with the rest.
  const tools: MenuEntry[] = [
    { label: t("Other calendars"), checkbox: true, checked: showCalendars, hidden: !canToggleCalendars, title: showCalendars ? t("Hide events from other calendars") : t("Show events from other calendars"), onSelect: () => setShowCalendars(!showCalendars) },
    { separator: true },
    { label: t("Rain day: move a day's visits"), icon: "cloud", hidden: !canDispatch, onSelect: () => setDialog("shift") },
    { label: t("Add a visit to many jobs"), icon: "calendarCheck", hidden: !canDispatch || !wholeTeam, onSelect: () => setDialog("bulk") },
  ];
  const viewItems: MenuEntry[] = [
    ...VIEWS.map((v): MenuEntry => ({ label: t(VIEW_LABELS[v]), icon: VIEW_ICONS[v], checked: view === v, onSelect: () => setView(v) })),
    { separator: true, hidden: view !== "day" && view !== "week" },
    { heading: t("Show by"), hidden: view !== "day" && view !== "week" },
    ...(["crews", "people"] as const).map((b): MenuEntry => ({ label: b === "crews" ? t("Crews") : t("People"), icon: b === "crews" ? "truck" : "users", checked: board === b, hidden: view !== "day" && view !== "week", onSelect: () => setBoard(b) })),
    { separator: true, hidden: view !== "list" },
    { heading: t("Range"), hidden: view !== "list" },
    ...SPANS.map((s): MenuEntry => ({ label: t(VIEW_LABELS[s]), checked: listSpan === s, hidden: view !== "list", onSelect: () => setListSpan(s) })),
    { separator: true },
    { label: t("Unscheduled"), checkbox: true, checked: Boolean(showPanel), end: unscheduled.length ? String(unscheduled.length) : undefined, hidden: !canSeeUnscheduled, onSelect: () => setPanel(!showPanel) },
    {
      label: t("Plan route"),
      icon: "navigation",
      hidden: view !== "day" || byPerson,
      items: dayColumns.map((col): MenuEntry => ({ label: typeof col.label === "string" ? col.label : t("Crew"), lead: swatch(col.color), hidden: !canRoute(col), onSelect: () => planRoute(col) })),
    },
    ...tools,
  ];
  const phoneFilters: MenuEntry[] = [
    { heading: t("Person"), hidden: !canPickPerson },
    ...personItems.map((e) => ({ ...e, hidden: !canPickPerson || e.hidden })),
    { separator: true },
    { heading: t("Crew"), hidden: crews.length < 2 },
    ...crewItems.filter((e) => !("separator" in e)).map((e) => ({ ...e, hidden: crews.length < 2 })),
  ];
  const filtered = Boolean(shownPerson || crewId);
  const shownLine = filterLine(shownPerson, session.userId, personName, crews.find((c) => c.id === crewId)?.name);
  const shownCount = view === "map" || view === "day" || oneDay ? byDay(anchor).length : scheduled.length;

  /** A visit as a row in the List and beside the Map: its time (or stop) first, then what, for whom, who's on it. */
  const visitRow = (v: Visit, lead: ReactNode, compact?: { off: boolean }) => {
    const when = v.starts_at ? `${timeOf(v.starts_at)}${v.ends_at ? ` – ${timeOf(v.ends_at)}` : ""}` : t("Anytime");
    const crew = crewOf(v.crew_id);
    return (
      <InboxRow
        key={v.id}
        onClick={() => show(v)}
        className={v.status === "completed" ? "sched-row is-done" : "sched-row"}
        current={grid.selected === v.id}
        avatar={lead}
        title={<><span className="sr-only">{when}: </span>{v.title}</>}
        badge={v.series_total && v.series_total > 1 ? <span className="il-num">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span> : undefined}
        subject={(v.job?.client || v.property || v.address) && [v.job?.client?.display_name, addressLine(v.property) || v.address].filter(Boolean).join(" · ")}
        // Its status as a dot and words; a client's request or a weather hold in color, since someone has to see to it.
        // Beside the map the pin's number leads the row, so its start time begins the line, and a visit that's
        // simply scheduled says nothing more (the narrow column keeps its room for what needs seeing to).
        meta={[
          compact && <span key="when" className="sched-meta-when" aria-hidden="true">{v.starts_at ? timeOf(v.starts_at) : t("Anytime")}</span>,
          !(compact && v.status === "scheduled") && <EntityStatus key="status" kind="visit" status={v.status} />,
          compact?.off && <span key="off" className="il-note" data-tone="warning">{t("No map location yet")}</span>,
          changes.has(v.id) && <span key="asked" className="il-note"><Icon name="refresh" size={13} />{t("Change requested")}</span>,
          v.hold_reason && <span key="hold" className="il-note" data-tone="warning" title={v.hold_reason}><Icon name="cloud" size={13} />{v.hold_reason.split(";")[0]}</span>,
          crew && <span key="crew" className="sched-meta-crew">{swatch(crew.color)}<span>{crew.name}</span></span>,
          // Beside the map there's room for less: who's on it is in the visit itself. On a phone the
          // faces on the right say who (the names stay for a screen reader).
          !compact && <span key="who" className="sched-meta-who" data-faces={v.assignees.length > 0 || undefined}>{namesOn(v) || t("Nobody assigned")}</span>,
        ]}
        // The names are on the quiet line already, for a screen reader.
        aside={!compact && v.assignees.length > 0 ? <span aria-hidden="true">{faces(v)}</span> : undefined}
      />
    );
  };
  /** "8:00 AM", "Anytime": the time in the row's left column, as Home's Today list has it. */
  const timeLead = (v: Visit) => (v.starts_at ? <TimeRange start={timeOf(v.starts_at)} /> : <span className="sched-row-anytime">{t("Anytime")}</span>);

  return (
    <>
      <PageHeader
        documentTitle={t("Schedule")}
        title={
          <h1 className="page-title">
            <span className="sched-title-desk">{t("Schedule")}</span>
            <span className="sched-title-phone">{phoneTitle}</span>
          </h1>
        }
        actions={
          <>
            {!onToday && <button type="button" className="btn sched-phone sched-today" onClick={goToday}>{t("Today")}</button>}
            {(canPickPerson || crews.length > 1) && (
              <Menu
                label={t("Filter by person or crew")}
                title={t("Show")}
                triggerClassName={`btn sched-phone${filtered ? " sched-filtered" : ""}`}
                trigger={<Icon name="filter" size={20} />}
                items={phoneFilters}
                search={personSearch}
                footer={{ text: t.plural(shownCount, { one: "{count} visit", other: "{count} visits" }), action: filtered ? { label: t("Clear"), onSelect: () => { setPerson(""); setCrewId(""); } } : undefined }}
              />
            )}
            <Menu label={t("View")} title={t("View")} triggerClassName="btn sched-phone" trigger={<Icon name="calendar" size={20} />} items={viewItems} />
            <Menu label={t("More scheduling tools")} triggerClassName="btn btn-icon sched-desk" items={tools} />
            {canDispatch && <Button variant="primary" icon="plus" onClick={() => setEditing({ title: "", kind: "job", scheduled_on: oneDay ? anchor : today })}>{t("New visit")}</Button>}
          </>
        }
      />

      {/* A desktop's bar: the days shown and stepping through them, who and which crew, then how they're laid out. */}
      <div className="sched-bar">
        <div className="sched-step">
          <Button size="sm" variant="ghost" icon="chevronLeft" aria-label={t("Previous")} onClick={() => step(-1)} />
          <Button size="sm" onClick={goToday}>{t("Today")}</Button>
          <Button size="sm" variant="ghost" icon="chevronRight" aria-label={t("Next")} onClick={() => step(1)} />
          <h2 className="sched-range" aria-live="polite">{heading}</h2>
          {schedule.isFetching && !schedule.isPending && <span className="spinner sched-spinner" aria-label={t("Refreshing")} />}
        </div>
        {canPickPerson && <PickMenu label={t("Person")} value={personName} items={personItems} search={personSearch} clear={shownPerson ? { label: t("Show everyone"), onClick: () => setPerson("") } : undefined} />}
        {crews.length > 1 && <PickMenu label={t("Crew")} value={crewName} items={crewItems} clear={crewId ? { label: t("Show all crews"), onClick: () => setCrewId("") } : undefined} />}
        {view === "list" && <PickMenu label={t("Range")} value={t(VIEW_LABELS[listSpan])} items={rangeItems} />}
        <span className="grow" />
        {canSeeUnscheduled && (
          <Button size="sm" variant="ghost" className="sched-uns-toggle" aria-pressed={Boolean(showPanel)} title={showPanel ? t("Hide unscheduled") : t("Show unscheduled")} onClick={() => setPanel(!showPanel)}>
            {t("Unscheduled")}
            {unscheduled.length > 0 && <span className="badge">{unscheduled.length}</span>}
          </Button>
        )}
        {(view === "day" || view === "week") && (
          <div className="segmented" role="group" aria-label={t("Show by")}>
            {(["crews", "people"] as const).map((b) => <button key={b} type="button" aria-pressed={board === b} onClick={() => setBoard(b)}>{b === "crews" ? t("Crews") : t("People")}</button>)}
          </div>
        )}
        <div className="segmented" role="group" aria-label={t("View")}>
          {VIEWS.map((v) => <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>{t(VIEW_LABELS[v])}</button>)}
        </div>
      </div>

      {/* A phone's: the week's days to pick from (Day), or the span shown with a step either side. */}
      <div className="sched-phone-nav">
        {view === "day" ? (
          <div className="sched-strip" role="group" aria-label={t("Week")}>
            <button type="button" className="sched-strip-step" aria-label={t("Previous")} onClick={() => setAnchor(addDaysIso(anchor, -7))}><Icon name="chevronLeft" size={18} /></button>
            {weekDays.map((d) => (
              <button key={d} type="button" className="sched-strip-day" aria-pressed={d === anchor} aria-current={d === today ? "date" : undefined} aria-label={label(d, { weekday: "long", month: "long", day: "numeric" })} onClick={() => setAnchor(d)}>
                <span aria-hidden="true">{label(d, { weekday: "narrow" })}</span>
                <b aria-hidden="true">{Number(d.slice(8))}</b>
              </button>
            ))}
            <button type="button" className="sched-strip-step" aria-label={t("Next")} onClick={() => setAnchor(addDaysIso(weekStart(anchor), 7))}><Icon name="chevronRight" size={18} /></button>
          </div>
        ) : (
          <div className="sched-phone-step">
            <button type="button" className="sched-strip-step" aria-label={t("Previous")} onClick={() => step(-1)}><Icon name="chevronLeft" size={18} /></button>
            <span className="sched-phone-range" aria-live="polite">{heading}</span>
            <button type="button" className="sched-strip-step" aria-label={t("Next")} onClick={() => step(1)}><Icon name="chevronRight" size={18} /></button>
          </div>
        )}
      </div>

      {/* Under the bar, so a phone's header and strip stay put: whose visits these are, and the way back. */}
      {shownLine && (
        <p className="sched-filter-line">
          {shownLine.text}
          {/* The line goes once it's clicked, so focus lands on the bar's first filter, not the page. */}
          <button type="button" className="link-btn" onClick={() => { document.querySelector<HTMLElement>(".sched-bar .sched-pick")?.focus(); setPerson(""); setCrewId(""); }}>{shownLine.clear}</button>
        </p>
      )}

      {!merged && ((crews.length > 0 && view !== "list" && view !== "map") || (showCalendars && calendarsShown.length > 0)) && (
        <div className="crew-legend">
          {view !== "list" && view !== "map" && crews.map((c) => <span key={c.id}><i style={{ ["--c" as string]: c.color ?? "var(--text-4)" }} />{c.name}</span>)}
          {showCalendars && calendarsShown.map((s) => <span key={s.id} title={t("Another calendar")}><i data-calendar style={{ ["--c" as string]: s.color ?? "var(--text-4)" }} />{s.name}</span>)}
        </div>
      )}

      {schedule.error && !schedule.data && <ErrorState error={schedule.error} onRetry={() => schedule.refetch()} />}
      {schedule.isPending && <ScheduleSkeleton view={view} />}

      {schedule.data && (
        <div className="schedule-layout" data-panel={showPanel || undefined}>
          <div className="schedule-main">
            {view === "week" && !byPerson && <TimeGrid columns={weekColumns} minColumn={96} {...grid} />}
            {view === "day" && <TimeGrid columns={merged ? mergedColumns : byPerson ? personColumns : dayColumns} minColumn={160} bare={merged} {...grid} />}
            {view === "week" && byPerson && (
              <div className={`tg-wrap people-week${schedule.isPlaceholderData ? " is-stale" : ""}`}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col"><span className="sr-only">{t("Person")}</span></th>
                      {days.map((date) => (
                        <th key={date} scope="col" data-today={date === today || undefined}>
                          <button type="button" className="link-btn" onClick={() => { setAnchor(date); setView("day"); }}>
                            <span className="tg-dow">{label(date, { weekday: "short" })}</span>
                            <span className="tg-date">{Number(date.slice(8))}</span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {personLanes.map((row) => (
                      <tr key={row.key}>
                        <th scope="row"><span className="people-week-who">{face(row.person || "")}<span>{row.label}</span></span></th>
                        {days.map((date) => {
                          const visits = byDay(date).filter((v) => onRow(v, row.person!, onCrews));
                          const rowEvents = eventsOn(date).filter((e) => eventOnRow(ownerOf(e), row.person!, rowIds));
                          // Marked like the person's row in Day view: on two visits at once, or busy in their calendar.
                          const marks = conflictsOf(visits, rowEvents.map((e) => onDay(e, date)), tz, row.person);
                          return (
                            <td
                              key={date}
                              data-drop="day"
                              data-date={date}
                              data-person={row.person}
                              data-today={date === today || undefined}
                              data-over={(drag?.target?.type === "day" && drag.target.date === date && drag.target.person === row.person) || undefined}
                            >
                              {visits.map((v) => {
                                const conflict = marks.get(v.id)?.conflict;
                                return (
                                  <button
                                    key={v.id}
                                    type="button"
                                    className="tg-chip"
                                    data-status={v.status}
                                    data-conflict={conflict || undefined}
                                    data-dragging={drag?.visit.id === v.id || undefined}
                                    data-selected={grid.selected === v.id || undefined}
                                    style={{ "--crew": v.crewColor } as CSSProperties}
                                    title={conflictText(conflict ?? false, true) ?? (v.assignees.length ? `${v.title} · ${namesOn(v)}` : v.title)}
                                    onPointerDown={canDispatch && canMove(v) && !["completed", "cancelled"].includes(v.status) ? startDrag(v, "move") : undefined}
                                    onClick={() => !wasDragging() && show(v)}
                                  >
                                    <span className="tg-line">
                                      {v.starts_at && <span className="tg-chip-time">{timeOf(v.starts_at)}</span>}
                                      <span className="tg-n">{v.title}</span>
                                      {doneMark(v)}
                                    </span>
                                  </button>
                                );
                              })}
                              {rowEvents.map((e) => (
                                <button key={e.id} type="button" className="tg-chip" data-external data-free={!e.busy || undefined} style={{ "--cal": e.source?.color ?? undefined } as CSSProperties} title={`${e.title} · ${e.source?.name ?? t("Calendar")}`} onClick={() => setViewing(e)}>
                                  {monthLabel(e, date, tz)}
                                </button>
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {view === "list" &&
              (listDays.length === 0 ? (
                <EmptyState icon="calendar" title={period === "day" ? t("Nothing scheduled this day") : period === "week" ? t("Nothing scheduled this week") : t("Nothing scheduled this month")} />
              ) : (
                <InboxList label={t("Schedule")} stale={schedule.isPlaceholderData} className="sched-list">
                  {listDays.map(({ date, visits }) => (
                    <InboxGroup key={date} label={label(date, { weekday: "long", month: "long", day: "numeric" })} count={visits.length} end={date === today ? t("Today") : undefined}>
                      {visits.map((v) => visitRow(v, timeLead(v)))}
                    </InboxGroup>
                  ))}
                </InboxList>
              ))}
            {view === "map" && (
              <div className={`sched-map${schedule.isPlaceholderData ? " is-stale" : ""}`}>
                <div className="sched-map-main">
                  {mapPins.length > 0 ? (
                    <Suspense fallback={<Skeleton height={420} radius={12} />}>
                      <ScheduleMap pins={mapPins} onOpen={(id) => { const v = mapVisits.find((x) => x.id === id); if (v) show(v); }} />
                    </Suspense>
                  ) : (
                    <EmptyState icon="map" title={mapVisits.length ? t("None of this day's visits has a map location yet") : t("Nothing scheduled this day")} />
                  )}
                </div>
                {mapVisits.length > 0 && (
                  <InboxList label={t("Map of the day's visits")} className="sched-list sched-map-list">
                    <InboxGroup>
                      {mapVisits.map((v, i) =>
                        visitRow(v, <span className="sched-pin" data-off={!located(v) || undefined} style={{ "--crew": v.crewColor } as CSSProperties}>{i + 1}</span>, { off: !located(v) }),
                      )}
                    </InboxGroup>
                  </InboxList>
                )}
              </div>
            )}
            {view === "month" && (
              <div className={`month${schedule.isPlaceholderData ? " is-stale" : ""}`}>
                {days.slice(0, 7).map((d) => <div key={d} className="month-head">{label(d, { weekday: "short" })}</div>)}
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
                      <button type="button" className="month-day" onClick={() => { setAnchor(date); setView("day"); }} aria-label={label(date, { weekday: "long", month: "long", day: "numeric" })}>
                        <span className="month-num">{Number(date.slice(8))}</span>
                        {visitCount(visits.length)}
                      </button>
                      {shown.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className="month-chip"
                          data-status={v.status}
                          data-selected={grid.selected === v.id || undefined}
                          style={{ ["--crew" as string]: v.crewColor }}
                          title={v.assignees.length ? `${v.title} · ${namesOn(v)}` : v.title}
                          onPointerDown={canDispatch && canMove(v) && !["completed", "cancelled"].includes(v.status) ? startDrag(v, "move") : undefined}
                          onClick={() => !wasDragging() && show(v)}
                        >
                          {v.starts_at && <span className="month-time">{timeOf(v.starts_at)} </span>}{v.title}
                        </button>
                      ))}
                      {shownEvents.map((e) => (
                        <button key={e.id} type="button" className="month-chip" data-external data-free={!e.busy || undefined} style={{ ["--cal" as string]: e.source?.color ?? undefined }} title={`${e.title} · ${e.source?.name ?? t("Calendar")}`} onClick={() => setViewing(e)}>
                          {monthLabel(e, date, tz)}
                        </button>
                      ))}
                      {more > 0 && <button type="button" className="month-more" onClick={() => { setAnchor(date); setView("day"); }}>{t("+{count} more", { count: more })}</button>}
                    </div>
                  );
                })}
              </div>
            )}
            {canDispatch && (view === "day" || view === "week") && (
              <p className="sched-hint">
                {byPerson ? t("Drag a visit onto someone to put them on it, or from one person to another to move it.") : t("Drag a visit to move it, drag its bottom edge to change how long it takes, or click an open time to book it.")}
              </p>
            )}
          </div>

          {showPanel && (
            <aside className="unscheduled-panel" aria-label={t("Unscheduled visits")} data-drop="unscheduled" data-over={drag?.target?.type === "unscheduled" || undefined}>
              <div className="unscheduled-head">
                <h2>{t("Unscheduled")}</h2>
                {unscheduled.length > 0 && <span className="sched-count">{unscheduled.length}</span>}
                <Button size="sm" variant="ghost" icon="x" className="unscheduled-close" aria-label={t("Hide unscheduled")} onClick={() => setPanel(false)} />
              </div>
              <p className="unscheduled-hint">
                {unscheduled.length === 0 ? t("Nothing waiting. Drag a visit here to take it off the calendar.") : canDispatch ? t("Drag onto the calendar to schedule.") : null}
              </p>
              <div className="unscheduled-list" ref={unscheduledList}>
                {unscheduled.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="unscheduled-row"
                    data-dragging={drag?.visit.id === v.id || undefined}
                    data-selected={grid.selected === v.id || undefined}
                    data-can-drag={(canDispatch && canMove(v)) || undefined}
                    style={{ "--crew": v.crewColor } as CSSProperties}
                    onPointerDown={canDispatch && canMove(v) ? startDrag(v, "move") : undefined}
                    onClick={() => !wasDragging() && show(v)}
                  >
                    <span className="unscheduled-title"><span className="grow">{v.title}</span>{faces(v)}</span>
                    <span className="unscheduled-sub">{[v.job?.client?.display_name ?? v.property?.line1 ?? v.address, v.job && t("Job #{number}", { number: v.job.number }), crewOf(v.crew_id)?.name].filter(Boolean).join(" · ")}</span>
                  </button>
                ))}
              </div>
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
      {dialog === "shift" && <ShiftDialog defaultDate={oneDay ? anchor : today} crews={wholeTeam ? crews : crews.filter((c) => rights.myCrews.includes(c.id))} allCrews={wholeTeam} onClose={() => setDialog(null)} />}
      {dialog === "bulk" && <BulkVisitsDialog defaultDate={oneDay ? anchor : addDaysIso(today, 1)} crews={crews} onClose={() => setDialog(null)} />}
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

/**
 * A filter that says what it filters, "Person Everyone ⌄" (Page-Schedule.dc.html): a quiet name and the
 * choice, opening a menu of the choices with a check by the one shown. Heard as "Person: Everyone".
 * With `clear` it's on (ScheduleFilter.dc.html): a green tint, and an × at its end that sets it back.
 */
function PickMenu({ label, value, items, search, clear }: { label: string; value: string; items: MenuEntry[]; search?: MenuSearch; clear?: { label: string; onClick: () => void } }) {
  // Always the one wrapper, so turning it on or off doesn't remount the trigger and drop its focus.
  return (
    <span className={clear ? "sched-pick-on" : "sched-pick-off"}>
      <Menu
        items={items}
        align="start"
        label={`${label}: ${value}`}
        title={label}
        search={search}
        triggerClassName="btn btn-sm sched-pick"
        trigger={
          <>
            <span className="sched-pick-label">{label}</span>
            <span className="sched-pick-value">{value}</span>
            {!clear && <Icon name="chevronDown" size={14} />}
          </>
        }
      />
      {clear && (
        <button type="button" className="sched-pick-clear" aria-label={clear.label} title={clear.label} onClick={(e) => { (e.currentTarget.parentElement?.firstElementChild as HTMLElement | null)?.focus(); clear.onClick(); }}>
          <Icon name="x" size={14} />
        </button>
      )}
    </span>
  );
}

/** While the schedule loads: the board's lines with a few quiet blocks, or the month's cells, or a list's rows. */
function ScheduleSkeleton({ view }: { view: View }) {
  if (view === "list" || view === "map") return <InboxSkeleton rows={5} />;
  if (view === "month") {
    return (
      <Loading>
        <div className="month">
          {Array.from({ length: 35 }, (_, i) => (
            <div key={i} className="month-cell">
              <Skeleton width={18} height={11} />
              {i % 4 === 1 && <Skeleton height={14} radius={5} />}
            </div>
          ))}
        </div>
      </Loading>
    );
  }
  const cols = view === "day" ? 3 : 7;
  return (
    <Loading>
      <div className="sched-skel" style={{ "--cols": cols } as CSSProperties}>
        <div className="sched-skel-gutter" />
        {Array.from({ length: cols }, (_, i) => (
          <div key={i} className="sched-skel-col">
            <Skeleton width="45%" height={11} />
            {Array.from({ length: 1 + (i % 3) }, (_, j) => <Skeleton key={j} height={44 + ((i + j) % 3) * 24} radius={7} style={{ marginTop: 18 + j * 30 }} />)}
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
    meta: { inline: true, tone: "job", success: (r: { moved: number }) => (r.moved ? t.plural(r.moved, { one: "Moved {count} visit to {day}", other: "Moved {count} visits to {day}" }, { day: label(toDate, { weekday: "short", month: "short", day: "numeric" }) }) : t("No open visits on that day")) },
    mutationFn: () => api.post<{ moved: number }>("/schedule/shift", { from_date: fromDate, to_date: toDate, crew_id: crewId || undefined }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      refreshJobs(queryClient);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t("Rain day")} description={t("Move all open visits to another day. Start times stay the same.")}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); shift.mutate(); }}>
        <div className="form-grid">
          <Field label={t("From")}><input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} required /></Field>
          <Field label={t("To")} error={fromDate && fromDate === toDate ? t("Pick a different day.") : null}>
            {/* The same day twice also stops Move visits, and counts in "1 field needs a look". */}
            <input ref={(el) => el?.setCustomValidity(fromDate && fromDate === toDate ? t("Pick a different day.") : "")} className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} required />
          </Field>
          <Field label={t("Crew")}>
            <Select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              {allCrews && <option value="">{t("All crews")}</option>}
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <FormError error={shift.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="cloud" loading={shift.isPending}>{t("Move visits")}</Button>
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
    meta: { inline: true, tone: "job", success: (r: { created: number }) => t.plural(r.created, { one: "Added {count} visit", other: "Added {count} visits" }) },
    mutationFn: async () => {
      if (!picked.length) throw new Error(t("Pick at least one job."));
      return api.post<{ created: number }>("/schedule/bulk-visits", { job_ids: picked, date, crew_id: crewId || undefined });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      refreshJobs(queryClient);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={t("Add a visit to many jobs")} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); create.mutate(); }}>
        <div className="form-grid">
          <Field label={t("Date")}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label={t("Crew")}>
            <Select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">{t("Each job's default crew")}</option>
              {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="visit-pick-tools">
          <label className="search-field">
            <Icon name="search" size={15} />
            <input type="search" placeholder={t("Filter jobs")} value={term} onChange={(e) => setTerm(e.target.value)} aria-label={t("Filter jobs")} autoComplete="off" />
          </label>
          <span className="visit-pick-count">{t("{count} selected", { count: picked.length })}</span>
          <Button size="sm" variant="ghost" onClick={() => setPicked(picked.length === shown.length ? [] : shown.map((j) => j.id))}>{picked.length === shown.length && shown.length ? t("Clear") : t("Select all")}</Button>
        </div>
        <div className="visit-pick-list" role="group" aria-label={t("Jobs")}>
          {jobs.isPending && <div className="visit-pick-row"><Skeleton width="60%" /></div>}
          {shown.map((j) => (
            <label key={j.id} className="visit-pick-row" data-on={picked.includes(j.id) || undefined}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
              <span className="visit-pick-text"><strong>{j.title}</strong><span className="visit-pick-sub">{[t("Job #{number}", { number: j.number }), j.client?.display_name].filter(Boolean).join(" · ")}</span></span>
            </label>
          ))}
          {jobs.data && !shown.length && <EmptyState inline title={t("No active jobs match")} />}
        </div>
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="calendarCheck" loading={create.isPending}>{picked.length ? t.plural(picked.length, { one: "Add {count} visit", other: "Add {count} visits" }) : t("Add visits")}</Button>
        </div>
      </form>
    </Dialog>
  );
}

