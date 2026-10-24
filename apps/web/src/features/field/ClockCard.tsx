/**
 * The running clock: what I'm on, for how long, and start/stop/switch. Used on My day and Timesheets.
 * On My day it also offers the visits under way, to clock back onto one after a break.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { hasRole, useSession } from "@/lib/session";
import { CATEGORY_LABELS, clockPlace, clockVisit, recordsPlaces, startTimer, stopTimers, useElapsed, useRunningTimer, type TimerCategory } from "./fieldData";

interface VisitUnderWay { id: string; title: string; job_id: string | null }
type ClockAction = TimerCategory | "stop" | VisitUnderWay;

export function ClockCard({ visits = [] }: { visits?: VisitUnderWay[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const timer = useRunningTimer(session.company.id, session.userId);
  const elapsed = useElapsed(timer.data?.started_at);
  const action = useMutation({
    meta: { success: (_: unknown, v: ClockAction) => (v === "stop" ? "Clock stopped" : typeof v === "object" ? `${v.title}: clock started` : `${CATEGORY_LABELS[v]}: clock started`) },
    mutationFn: async (a: ClockAction) => {
      const place = await clockPlace(session.company);
      if (a === "stop") return stopTimers(session.company.id, session.userId, place);
      if (typeof a === "object") return clockVisit(session.company.id, session.userId, a, "start", new Date().toISOString(), place);
      return startTimer(session.company.id, session.userId, a, place);
    },
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  const visit = timer.data?.visit as { id: string; title: string } | null | undefined;
  const on = Boolean(timer.data);
  // Finding where the phone is can take a few seconds.
  const starting = action.isPending && action.variables !== "stop";
  return (
    <div className="card card-pad row wrap" style={{ gap: 12, background: on ? "var(--green-tint)" : undefined, borderColor: on ? "transparent" : undefined, transition: "background 200ms" }}>
      <span className="avatar" style={{ width: 40, height: 40, background: on ? "var(--green-solid)" : "var(--fill-3)", color: on ? "#fff" : "var(--text-2)" }}><Icon name="clock" size={20} /></span>
      <div className="grow">
        {on ? (
          <>
            <div className="strong">{visit ? visit.title : CATEGORY_LABELS[timer.data!.category as TimerCategory] ?? "Working"}</div>
            <div className="small" style={{ color: "var(--green-dark)" }}>Clock running · {elapsed}</div>
          </>
        ) : (
          <>
            <div className="strong">Clock is off</div>
            {recordsPlaces(session.company) && !hasRole(session, "admin", "office") && <div className="small muted">Clocking in and out saves where you are, for the office.</div>}
          </>
        )}
      </div>
      {on && <Button variant="dark" icon="pause" loading={action.isPending && action.variables === "stop"} disabled={starting} onClick={() => action.mutate("stop")}>Stop</Button>}
      <Menu
        label="Start a timer"
        triggerClassName="btn"
        trigger={<>{starting ? <Spinner size={16} /> : <Icon name="play" size={16} />}{on ? "Switch" : "Start timer"}</>}
        items={[
          ...visits.filter((v) => v.id !== visit?.id).map((v) => ({ label: v.title, disabled: action.isPending, onSelect: () => action.mutate(v) })),
          ...(["drive", "shop", "break", "other"] as TimerCategory[]).map((c) => ({ label: CATEGORY_LABELS[c], disabled: action.isPending, onSelect: () => action.mutate(c) })),
        ]}
      />
    </div>
  );
}
