/**
 * The crew's day on a phone: the running clock, my visits today in order, one-tap status changes,
 * and the whole route in a maps app. A sub sees the same for the visits they're on, without a clock
 * unless the office keeps their hours.
 */
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { MapsLink, RouteMapsLink } from "@/components/ui/MapsLink";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, visitKindText } from "@/components/ui/StatusPill";
import { todayIn } from "@/lib/format";
import { visitPlace } from "@/lib/maps";
import { hasRole, isSub, keepsTime, useSession } from "@/lib/session";
import { CrewEquipmentCard } from "../equipment/CrewEquipmentCard";
import { dayRoute } from "../schedule/dayRoute";
import { useSchedulingRights } from "../schedule/myCrews";
import { ClockCard } from "./ClockCard";
import { visitContact } from "./contact";
import { CrewClockCard } from "./CrewClockCard";
import { showVisitStatus, statusSaved, type VisitStatusChange } from "./fieldActions";
import { useStatusTap } from "./fieldData";
import { GeofenceCard } from "./GeofenceCard";
import { InstallAppCard } from "./InstallAppCard";
import { SnowAvailabilityCard } from "../snow/SnowAvailabilityCard";
import { dayOrder, myDayKey, useMyDay, type MyDayVisit } from "./myDay";
import { OfflineNote } from "./OfflineNote";
import { SpanishOffer } from "./SpanishOffer";
import { featureOn } from "@/components/shell/nav";
import { FIELD_SCOPE } from "@/lib/offline";
import { toast } from "@/lib/toast";
import { intlLocale, languageChoice, msg, t } from "@/lib/i18n";

type Visit = MyDayVisit;

const clientName = (v: Visit) => visitContact(v.job?.client, v.contact).name;

/** A visit's next step, the card's main button. A scheduled visit can also go on its way first. */
const NEXT: Record<string, { status: string; label: string; icon: "play" | "check" } | null> = {
  scheduled: { status: "in_progress", label: msg("Start visit"), icon: "play" },
  en_route: { status: "in_progress", label: msg("Start visit"), icon: "play" },
  in_progress: { status: "completed", label: msg("Complete visit"), icon: "check" },
};

export function FieldTodayPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const [showDone, setShowDone] = useState(false);
  const isLead = useSchedulingRights().canDispatch;
  useDocumentTitle(t("My day"));
  const time = (iso: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit", timeZone: tz });
  const key = myDayKey(session.company.id, today);
  const data = useMyDay();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["field"] });
    queryClient.invalidateQueries({ queryKey: ["field-visit"] });
    queryClient.invalidateQueries({ queryKey: ["schedule"] });
    // The Jobs list and job pages say Late, Today, Upcoming or Unscheduled from the visits (public.job_state).
    queryClient.invalidateQueries({ queryKey: ["job"] });
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.invalidateQueries({ queryKey: ["running-timer"] });
    // Finishing a visit ends the crew's clocks on it too.
    queryClient.invalidateQueries({ queryKey: ["crew-clock"] });
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
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      await queryClient.cancelQueries({ queryKey: key });
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const statusTap = useStatusTap((change) => setStatus.mutate(change));
  const changeStatus = (visit: Visit, status: string) => statusTap.tap({ id: visit.id, jobId: visit.job?.id ?? null }, status);

  const order = dayOrder;
  const visits = [...(data.data?.today ?? [])].sort(order);
  const open = visits.filter((v) => v.status !== "completed");
  const done = visits.filter((v) => v.status === "completed");
  const route = dayRoute(visits, session.company);
  // The visit to do now gets the one green button: the one under way, else the next on the route.
  const now = open.find((v) => v.status === "in_progress") ?? open.find((v) => v.status === "en_route") ?? open[0];

  return (
    <div className="field-app">
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>{new Date().toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric", timeZone: tz })}</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>{t("My day")}</h1>
      </div>

      <OfflineNote />
      {languageChoice() && <SpanishOffer />}
      {!hasRole(session, "admin", "office", "estimator") && <InstallAppCard />}
      {keepsTime(session) && <ClockCard visits={open.filter((v) => v.status === "in_progress").map((v) => ({ id: v.id, title: v.title, job_id: v.job?.id ?? null }))} />}
      {/* The clock at the property, when the company has it on: what the phone asks as they get there and leave. */}
      <GeofenceCard onStatus={(visit, status) => void statusTap.tap(visit, status)} />
      {session.role === "crew_lead" && <CrewClockCard visits={data.data?.today ?? []} />}
      {featureOn(session.company.settings, "snow_app") && <SnowAvailabilityCard />}

      {data.isPending && <Loading label={t("Loading your visits")}><div className="stack">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={2} />)}</div></Loading>}
      {data.error && !data.data && <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div>}
      {data.data && visits.length === 0 && (
        <div className="card">
          <EmptyState icon="calendar" title={t("Nothing assigned to you today")} action={isLead && <Link className="btn" to="/schedule">{t("Open the schedule")}</Link>}>
            {data.data.tomorrow.length ? t("Tomorrow's visits are below.") : undefined}
          </EmptyState>
        </div>
      )}
      {data.data && visits.length > 0 && (
        <div className="progress" role="progressbar" aria-label={t("Visits done")} aria-valuemin={0} aria-valuemax={visits.length} aria-valuenow={done.length} aria-valuetext={t.plural(visits.length, { one: "{done} of {count} visit done", other: "{done} of {count} visits done" }, { done: done.length })}><span style={{ width: `${(done.length / visits.length) * 100}%` }} /></div>
      )}

      {route.stops.length > 1 && (
        <RouteMapsLink className="btn big-action btn-block" route={route}>
          <Icon name="map" size={20} />
          {t("Open route in maps")}
        </RouteMapsLink>
      )}

      <div className="stack">
        {open.map((v, i) => {
          const next = NEXT[v.status];
          const place = visitPlace(v);
          // Which of the card's steps is on its way: finding the phone's place comes first for one that clocks.
          const going = statusTap.locating?.id === v.id ? statusTap.locating.status : setStatus.isPending && !setStatus.isPaused && setStatus.variables?.visitId === v.id ? setStatus.variables.status : null;
          return (
            <article key={v.id} className="field-card" data-now={v.status === "in_progress" || undefined}>
              <div className="field-card-info">
                <div className="row wrap" style={{ gap: 6 }}>
                  {v.route_order != null && <span className="chip chip-green">{t("Stop {number}", { number: v.route_order })}</span>}
                  <span className="chip">{v.starts_at ? time(v.starts_at) : v.route_order != null ? t("Anytime") : t("Stop {number}", { number: i + 1 })}</span>
                  <EntityStatus kind="visit" status={v.status} />
                  {v.kind !== "job" && <span className="chip">{visitKindText(v.kind)}</span>}
                  {v.series_total && v.series_total > 1 && <span className="chip chip-blue">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span>}
                </div>
                <Link to={`/field/visits/${v.id}`} className="field-card-title">
                  <strong>{v.title}</strong>
                  <span className="muted">{[clientName(v), v.property?.line1 ?? v.address].filter(Boolean).join(" · ")}</span>
                </Link>
                {v.hold_reason && <div className="small" style={{ color: "var(--warning)", fontWeight: 600 }}><Icon name="cloud" size={14} /> {t("Weather: {reason}", { reason: v.hold_reason })}</div>}
              </div>
              {/* The card's next step last and full width, where the thumb is (beside the rest on a wide screen). */}
              {(place || next) && (
                <div className="field-card-actions">
                  {(place || v.status === "scheduled") && (
                    <div className="field-card-more">
                      {place && <MapsLink className="btn big-action" place={place}><Icon name="navigation" size={20} />{t("Directions")}</MapsLink>}
                      {v.status === "scheduled" && <Button icon="navigation" className="big-action" loading={going === "en_route"} onClick={() => changeStatus(v, "en_route")}>{t("On my way")}</Button>}
                    </div>
                  )}
                  {next && (
                    <Button variant={v.id === now?.id ? "primary" : "secondary"} icon={next.icon} block className="big-action" loading={going === next.status} onClick={() => changeStatus(v, next.status)}>
                      {t(next.label)}
                    </Button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {done.length > 0 && (
        <section className="stack-sm">
          <button type="button" className="row link-btn" style={{ color: "var(--ink)" }} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <Icon name={showDone ? "chevronDown" : "chevronRight"} size={16} />
            <strong>{t("Done today ({count})", { count: done.length })}</strong>
          </button>
          {showDone && (
            <div className="card">
              {done.map((v) => (
                <Link key={v.id} to={`/field/visits/${v.id}`} className="card-row">
                  <Icon name="check" size={16} />
                  <span className="grow"><strong>{v.title}</strong><span className="muted small" style={{ display: "block" }}>{clientName(v)}</span></span>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {!!data.data?.tomorrow.length && (
        <section className="stack-sm">
          <h2 className="section-title">{t("Tomorrow")}</h2>
          <div className="card">
            {[...data.data.tomorrow].sort(order).map((v) => (
              <Link key={v.id} to={`/field/visits/${v.id}`} className="card-row">
                <span className="tabular strong small" style={{ width: 64 }}>{v.starts_at ? time(v.starts_at) : t("Anytime")}</span>
                <span className="grow"><strong>{v.title}</strong><span className="muted small" style={{ display: "block" }}>{[clientName(v), v.property?.line1 ?? v.address].filter(Boolean).join(" · ")}</span></span>
                <Icon name="chevronRight" size={16} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {!isSub(session) && <CrewEquipmentCard />}
    </div>
  );
}
