/**
 * The crew's day on a phone: the running clock, my visits today in order, one-tap status changes,
 * and the whole route in a maps app. A sub sees the same for the visits they're on, without a clock
 * unless the office keeps their hours.
 *
 * Mobile-Work.dc.html, My day: the date over a large title, the clock in an inset card, how many
 * visits are done with the route a tap away, then each visit as a card: its stop, time and status,
 * what and where, and its buttons. The visit to do now has the screen's one green button. On a
 * desktop or a tablet across, the clocks stand in a column beside the visits.
 */
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { MapsLink, RouteMapsLink } from "@/components/ui/MapsLink";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
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
import { FieldHeader } from "./fieldUi";
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
const where = (v: Visit) => [clientName(v), v.property?.line1 ?? v.address].filter(Boolean).join(" · ");

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
  // Which of a card's steps is on its way: finding the phone's place comes first for one that clocks.
  const goingFor = (v: Visit) => (statusTap.locating?.id === v.id ? statusTap.locating.status : setStatus.isPending && !setStatus.isPaused && setStatus.variables?.visitId === v.id ? setStatus.variables.status : null);
  const clocks = keepsTime(session) || session.role === "crew_lead" || featureOn(session.company.settings, "snow_app");

  return (
    <div className="field-app m-grouped">
      <FieldHeader kicker={new Date().toLocaleDateString(intlLocale(), { weekday: "long", month: "long", day: "numeric", timeZone: tz })} title={t("My day")} />

      <OfflineNote />
      {languageChoice() && <SpanishOffer />}
      {!hasRole(session, "admin", "office", "estimator") && <InstallAppCard />}
      {/* The clock at the property, when the company has it on: what the phone asks as they get there and leave. */}
      <GeofenceCard onStatus={(visit, status) => void statusTap.tap(visit, status)} />

      <div className="day-cols" data-side={clocks || undefined}>
        <div className="day-main">
          {data.isPending && (
            <Loading label={t("Loading your visits")}>
              <div className="day-list">
                {[0, 1].map((i) => (
                  <div key={i} className="day-visit">
                    <div className="day-visit-info"><Skeleton width="38%" height={14} /><Skeleton width="62%" height={18} /><Skeleton width="48%" /></div>
                  </div>
                ))}
              </div>
            </Loading>
          )}
          {data.error && !data.data && <ErrorState error={data.error} onRetry={() => data.refetch()} />}
          {data.data && visits.length === 0 && (
            <EmptyState icon="calendar" title={t("Nothing assigned to you today")} action={isLead && <Link className="btn" to="/schedule">{t("Open the schedule")}</Link>}>
              {data.data.tomorrow.length ? t("Tomorrow's visits are below.") : undefined}
            </EmptyState>
          )}

          {visits.length > 0 && (
            <div className="day-progress">
              <div className="day-progress-line">
                <span aria-hidden="true">{t.plural(visits.length, { one: "{done} of {count} visit done", other: "{done} of {count} visits done" }, { done: done.length })}</span>
                {route.stops.length > 1 && <RouteMapsLink className="day-route" route={route}>{t("Route in maps")}</RouteMapsLink>}
              </div>
              <div className="progress" role="progressbar" aria-label={t("Visits done")} aria-valuemin={0} aria-valuemax={visits.length} aria-valuenow={done.length} aria-valuetext={t.plural(visits.length, { one: "{done} of {count} visit done", other: "{done} of {count} visits done" }, { done: done.length })}><span style={{ width: `${(done.length / visits.length) * 100}%` }} /></div>
            </div>
          )}

          {open.length > 0 && (
            <div className="day-list">
              {open.map((v, i) => (
                <DayVisit key={v.id} visit={v} index={i} now={v.id === now?.id} when={v.starts_at ? time(v.starts_at) : null} going={goingFor(v)} onStatus={(status) => changeStatus(v, status)} />
              ))}
            </div>
          )}

          {done.length > 0 && (
            <Section
              title={
                <button type="button" className="day-done-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                  <Icon name={showDone ? "chevronDown" : "chevronRight"} size={16} />
                  {t("Done today")}
                </button>
              }
              count={done.length}
            >
              {showDone && (
                <RelatedList>
                  {done.map((v) => (
                    <RelatedRow key={v.id} to={`/field/visits/${v.id}`} lead={<span className="rel-icon" data-tone="good"><Icon name="check" size={15} /></span>} title={v.title} sub={clientName(v)} />
                  ))}
                </RelatedList>
              )}
            </Section>
          )}

          {!!data.data?.tomorrow.length && (
            <Section title={t("Tomorrow")} count={data.data.tomorrow.length}>
              <RelatedList>
                {[...data.data.tomorrow].sort(order).map((v) => (
                  <RelatedRow key={v.id} to={`/field/visits/${v.id}`} lead={v.starts_at ? time(v.starts_at) : t("Anytime")} title={v.title} sub={where(v)} />
                ))}
              </RelatedList>
            </Section>
          )}

          {!isSub(session) && <CrewEquipmentCard />}
        </div>

        {clocks && (
          <div className="day-side">
            {keepsTime(session) && <ClockCard visits={open.filter((v) => v.status === "in_progress").map((v) => ({ id: v.id, title: v.title, job_id: v.job?.id ?? null }))} />}
            {session.role === "crew_lead" && <CrewClockCard visits={data.data?.today ?? []} />}
            {featureOn(session.company.settings, "snow_app") && <SnowAvailabilityCard />}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One of today's visits: its stop on the route, time and status, what and where (the whole card
 * opens it), and its buttons. The one to do now has the green button, full width where the thumb
 * is; the others have quiet ones.
 */
function DayVisit({ visit: v, index, now, when, going, onStatus }: { visit: Visit; index: number; now: boolean; when: string | null; going: string | null; onStatus: (status: string) => void }) {
  const next = NEXT[v.status];
  const place = visitPlace(v);
  // Its stop on the route the office or crew lead set; one with no time is told apart by its place in the day.
  const stop = v.route_order ?? (v.starts_at ? null : index + 1);
  const titleId = `day-visit-${v.id}`;
  // Under way, they're there: no Directions. Scheduled, they can say they're on their way first.
  const directions = place && v.status !== "in_progress" && (
    <MapsLink className="btn" place={place}>{t("Directions")}</MapsLink>
  );
  const onMyWay = v.status === "scheduled" && <Button loading={going === "en_route"} onClick={() => onStatus("en_route")}>{t("On my way")}</Button>;
  const quiet = [directions, onMyWay, !now && next && <Button loading={going === next.status} onClick={() => onStatus(next.status)}>{t(next.label)}</Button>].filter(Boolean);
  return (
    <article className="day-visit" data-now={now || undefined} aria-labelledby={titleId}>
      <div className="day-visit-info">
        <div className="day-visit-top">
          {stop != null && <span className="stop-chip">{t("Stop {number}", { number: stop })}</span>}
          {when ? <span className="tabular">{when}</span> : v.route_order != null && <span>{t("Anytime")}</span>}
          <EntityStatus kind="visit" status={v.status} />
          {v.kind !== "job" && <span className="chip">{visitKindText(v.kind)}</span>}
          {v.series_total && v.series_total > 1 && <span className="chip">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span>}
        </div>
        <Link to={`/field/visits/${v.id}`} className="day-visit-link">
          <span className="day-visit-title" id={titleId}>{v.title}</span>
          {where(v) && <span className="day-visit-where">{where(v)}</span>}
        </Link>
        {v.hold_reason && <div className="day-visit-warn"><Icon name="cloud" size={15} />{t("Weather: {reason}", { reason: v.hold_reason })}</div>}
      </div>
      {(quiet.length > 0 || (now && next)) && (
        <div className="day-visit-acts">
          {quiet.length > 0 && <div className="day-visit-quiet" data-count={quiet.length}>{quiet.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>}
          {/* The next step last and full width, where the thumb is. */}
          {now && next && (
            <Button variant="primary" block loading={going === next.status} onClick={() => onStatus(next.status)}>{t(next.label)}</Button>
          )}
        </div>
      )}
    </article>
  );
}
