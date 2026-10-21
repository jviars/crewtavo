/**
 * The crew's day on a phone: the running clock, my visits today in order, one-tap status changes,
 * and the whole route in a maps app.
 */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { MapsLink, RouteMapsLink } from "@/components/ui/MapsLink";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, statusLabel, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { CrewEquipmentCard } from "../equipment/CrewEquipmentCard";
import { dayRoute } from "../schedule/dayRoute";
import { useSchedulingRights } from "../schedule/myCrews";
import { ClockCard } from "./ClockCard";
import { CrewClockCard } from "./CrewClockCard";
import { pendingVisitStatus, showVisitStatus, statusSaved, type VisitStatusChange } from "./fieldActions";
import { InstallAppCard } from "./InstallAppCard";
import { OfflineNote } from "./OfflineNote";
import { FIELD_SCOPE } from "@/lib/offline";
import { toast } from "@/lib/toast";

interface Visit {
  id: string;
  title: string;
  kind: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  scheduled_on: string | null;
  route_order: number | null;
  hold_reason: string | null;
  crew_id: string | null;
  job: { id: string; number: number; title: string; client: { display_name: string } | null } | null;
  property: { id: string; line1: string; line2?: string | null; city: string | null; region?: string | null; postal_code?: string | null; lat: number | null; lng: number | null } | null;
  assignees: Array<{ user_id: string }>;
  series_day: number | null;
  series_total: number | null;
}

const NEXT: Record<string, { status: string; label: string; icon: "navigation" | "play" | "check"; primary: boolean } | null> = {
  scheduled: { status: "en_route", label: "On my way", icon: "navigation", primary: false },
  en_route: { status: "in_progress", label: "Start", icon: "play", primary: true },
  in_progress: { status: "completed", label: "Complete", icon: "check", primary: true },
};

export function FieldTodayPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const [showDone, setShowDone] = useState(false);
  const isLead = useSchedulingRights().canDispatch;
  useDocumentTitle("My day");
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
  const key = ["field", session.company.id, today];

  const data = useQuery({
    queryKey: key,
    refetchInterval: 60_000,
    queryFn: async () => {
      const [schedule, crews] = await Promise.all([
        api.get<{ visits: Visit[] }>(`/schedule?from=${today}&to=${addDaysIso(today, 1)}`),
        supabase().from("crew_members").select("crew_id").eq("user_id", session.userId),
      ]);
      const myCrews = new Set(unwrap(crews).map((c) => c.crew_id));
      const mine = schedule.visits
        .filter((v) => v.status !== "cancelled" && (v.assignees.some((a) => a.user_id === session.userId) || (v.crew_id && myCrews.has(v.crew_id))))
        .map((v) => ({ ...v, status: pendingVisitStatus(queryClient, v.id) ?? v.status }));
      return { today: mine.filter((v) => v.scheduled_on === today), tomorrow: mine.filter((v) => v.scheduled_on !== today && !["completed", "cancelled"].includes(v.status)) };
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["field"] });
    queryClient.invalidateQueries({ queryKey: ["field-visit"] });
    queryClient.invalidateQueries({ queryKey: ["schedule"] });
    queryClient.invalidateQueries({ queryKey: ["running-timer"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  // Works offline: the tap is saved on the phone (with its time) and sent when there's signal. Sent
  // by the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts notes
  // when it's on its way, for the count of updates waiting.
  const setStatus = useMutation({
    mutationKey: ["visit-status"],
    scope: FIELD_SCOPE,
    meta: { success: statusSaved },
    onMutate: async (change: VisitStatusChange) => {
      if (!onlineManager.isOnline()) toast.info("Saved on this phone. It'll send when you have signal.");
      await queryClient.cancelQueries({ queryKey: key });
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const changeStatus = (visit: Visit, status: string) =>
    setStatus.mutate({ companyId: session.company.id, userId: session.userId, visitId: visit.id, jobId: visit.job?.id ?? null, status, at: new Date().toISOString() });

  // The route the office or crew lead set (Organize route), else timed visits by time, then the rest.
  const order = (a: Visit, b: Visit) =>
    a.route_order != null && b.route_order != null
      ? a.route_order - b.route_order
      : a.starts_at && b.starts_at
        ? a.starts_at.localeCompare(b.starts_at)
        : a.starts_at
          ? -1
          : b.starts_at
            ? 1
            : (a.route_order ?? 999) - (b.route_order ?? 999);
  const visits = [...(data.data?.today ?? [])].sort(order);
  const open = visits.filter((v) => v.status !== "completed");
  const done = visits.filter((v) => v.status === "completed");
  const route = dayRoute(visits, session.company);

  return (
    <>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-2)" }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz })}</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>My day</h1>
      </div>

      <OfflineNote />
      {!hasRole(session, "admin", "office", "estimator") && <InstallAppCard />}
      <ClockCard />
      {session.role === "crew_lead" && <CrewClockCard visits={data.data?.today ?? []} />}

      {data.isPending && <Loading label="Loading your visits"><div className="stack">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={2} />)}</div></Loading>}
      {data.error && !data.data && <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>}
      {data.data && visits.length === 0 && (
        <div className="card">
          <EmptyState icon="calendar" title="Nothing assigned to you today" action={isLead && <Link className="btn" to="/schedule">Open the schedule</Link>}>
            {data.data.tomorrow.length ? "Tomorrow's visits are below." : undefined}
          </EmptyState>
        </div>
      )}
      {data.data && visits.length > 0 && (
        <div className="progress" role="progressbar" aria-label="Visits done" aria-valuemin={0} aria-valuemax={visits.length} aria-valuenow={done.length} aria-valuetext={`${done.length} of ${visits.length} visits done`}><span style={{ width: `${(done.length / visits.length) * 100}%` }} /></div>
      )}

      {route.stops.length > 1 && (
        <RouteMapsLink className="btn big-action btn-block" route={route}>
          <Icon name="map" size={18} />
          Open route in maps
        </RouteMapsLink>
      )}

      <div className="stack">
        {open.map((v, i) => {
          const next = NEXT[v.status];
          const busy = setStatus.isPending && !setStatus.isPaused && setStatus.variables?.visitId === v.id;
          return (
            <article key={v.id} className="field-card" style={v.status === "in_progress" ? { borderColor: "var(--green)", boxShadow: "var(--ring)" } : undefined}>
              <div className="row">
                {v.route_order != null && <span className="chip chip-green">Stop {v.route_order}</span>}
                <span className="chip">{v.starts_at ? time(v.starts_at) : v.route_order != null ? "Anytime" : `Stop ${i + 1}`}</span>
                <StatusPill label={statusLabel(v.status)} tone={visitTone(v.status)} />
                {v.kind !== "job" && <span className="chip">{statusLabel(v.kind)}</span>}
                {v.series_total && v.series_total > 1 && <span className="chip chip-blue">Day {v.series_day} of {v.series_total}</span>}
              </div>
              <Link to={`/field/visits/${v.id}`} style={{ color: "var(--ink)" }}>
                <strong style={{ fontSize: 17, display: "block" }}>{v.title}</strong>
                <span className="muted">{[v.job?.client?.display_name, v.property?.line1].filter(Boolean).join(" · ")}</span>
              </Link>
              {v.hold_reason && <div className="small" style={{ color: "var(--warning)", fontWeight: 700 }}><Icon name="cloud" size={14} /> Weather: {v.hold_reason}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
                {v.property && <MapsLink className="btn big-action" place={v.property}><Icon name="navigation" size={18} />Directions</MapsLink>}
                {next && (
                  <Button variant={next.primary ? "primary" : "secondary"} icon={next.icon} className="big-action" loading={busy} onClick={() => changeStatus(v, next.status)}>{next.label}</Button>
                )}
                {v.status === "scheduled" && <Button variant="primary" icon="play" className="big-action" loading={busy} onClick={() => changeStatus(v, "in_progress")}>Start</Button>}
              </div>
            </article>
          );
        })}
      </div>

      {done.length > 0 && (
        <section className="stack-sm">
          <button type="button" className="row link-btn" style={{ color: "var(--ink)" }} onClick={() => setShowDone(!showDone)}>
            <Icon name={showDone ? "chevronDown" : "chevronRight"} size={16} />
            <strong>Done today ({done.length})</strong>
          </button>
          {showDone && (
            <div className="card">
              {done.map((v) => (
                <Link key={v.id} to={`/field/visits/${v.id}`} className="card-row">
                  <Icon name="check" size={16} />
                  <span className="grow"><strong>{v.title}</strong><span className="muted small" style={{ display: "block" }}>{v.job?.client?.display_name}</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {!!data.data?.tomorrow.length && (
        <section className="stack-sm">
          <h2 className="section-title">Tomorrow</h2>
          <div className="card">
            {[...data.data.tomorrow].sort(order).map((v) => (
              <Link key={v.id} to={`/field/visits/${v.id}`} className="card-row">
                <span className="tabular strong small" style={{ width: 64 }}>{v.starts_at ? time(v.starts_at) : "Anytime"}</span>
                <span className="grow"><strong>{v.title}</strong><span className="muted small" style={{ display: "block" }}>{[v.job?.client?.display_name, v.property?.line1].filter(Boolean).join(" · ")}</span></span>
                <Icon name="chevronRight" size={16} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <CrewEquipmentCard />
    </>
  );
}
