/** The running clock: what I'm on, for how long, and start/stop/switch. Used on My day and Timesheets. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { useSession } from "@/lib/session";
import { CATEGORY_LABELS, startTimer, stopTimers, useElapsed, useRunningTimer, type TimerCategory } from "./fieldData";

export function ClockCard() {
  const session = useSession();
  const queryClient = useQueryClient();
  const timer = useRunningTimer(session.company.id, session.userId);
  const elapsed = useElapsed(timer.data?.started_at);
  const action = useMutation({
    meta: { success: (_: unknown, v: TimerCategory | "stop") => (v === "stop" ? "Clock stopped" : `${CATEGORY_LABELS[v]}: clock started`) },
    mutationFn: async (a: TimerCategory | "stop") => (a === "stop" ? stopTimers(session.company.id, session.userId) : startTimer(session.company.id, session.userId, a)),
    onSettled: () => {
      for (const k of ["running-timer", "time", "field"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  const visit = timer.data?.visit as { id: string; title: string } | null | undefined;
  const on = Boolean(timer.data);
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
          </>
        )}
      </div>
      {on && <Button variant="dark" icon="pause" loading={action.isPending && action.variables === "stop"} onClick={() => action.mutate("stop")}>Stop</Button>}
      <Menu
        label="Start a timer"
        triggerClassName="btn"
        trigger={<><Icon name="play" size={16} />{on ? "Switch" : "Start timer"}</>}
        items={(["drive", "shop", "break", "other"] as TimerCategory[]).map((c) => ({ label: CATEGORY_LABELS[c], onSelect: () => action.mutate(c) }))}
      />
    </div>
  );
}
