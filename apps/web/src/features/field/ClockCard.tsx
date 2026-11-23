/**
 * The running clock: what I'm on, for how long, and start/stop/switch. Used on My day and Timesheets.
 * On My day it also offers the visits under way, to clock back onto one after a break. Not there for
 * a sub unless the office keeps their hours.
 *
 * On the whole-day clock (Settings → Company → Time clock) it runs between visits too, on Driving,
 * so the way to end the day is here: Stop for the day.
 *
 * Its taps work with no signal, like a visit's: each is saved on the phone with when it was tapped
 * and sent in order when there's signal (clockTaps.ts, fieldActions.setClock), and the card shows
 * what the waiting taps will do.
 */
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { FIELD_SCOPE } from "@/lib/offline";
import { hasRole, keepsTime, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { clockChange, clockSaved, showClockTap, type ClockChange, type ClockTarget } from "./clockTaps";
import { CATEGORY_LABELS, clockPlace, onDayClock, recordsPlaces, useElapsed, useRunningTimer, type TimerCategory } from "./fieldData";
import { LocationNotice } from "./LocationNoticeDialog";
import { msg, t } from "@/lib/i18n";

interface VisitUnderWay { id: string; title: string; job_id: string | null }

/** Each kind of work the clock can go onto, in the Switch menu. */
export const CATEGORY_ICONS: Record<TimerCategory, IconName> = { visit: "job", assessment: "clipboard", drive: "truck", shop: "wrench", break: "pause", other: "clock" };

export function ClockCard({ visits = [] }: { visits?: VisitUnderWay[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const clocks = keepsTime(session);
  const day = onDayClock(session);
  const timer = useRunningTimer(session.company.id, session.userId, clocks);
  const elapsed = useElapsed(timer.data?.started_at);
  // Sent by the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts
  // notes when it's on its way, for the count of updates waiting.
  const action = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { day }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  // Finding where the phone is comes first and can take a few seconds; the tap is dated before it.
  const [locating, setLocating] = useState<"stop" | "start" | null>(null);
  const tap = async (target: ClockTarget | null) => {
    const at = new Date().toISOString();
    setLocating(target ? "start" : "stop");
    const place = await clockPlace(session);
    setLocating(null);
    action.mutate(clockChange(session, [session.userId], target, place, at));
  };
  const visit = timer.data?.visit as { id: string; title: string } | null | undefined;
  const on = Boolean(timer.data);
  // Which tap is on its way. One waiting for signal isn't: the card is free for the next.
  const going = locating ?? (action.isPending && !action.isPaused ? (action.variables?.target ? "start" : "stop") : null);
  if (!clocks) return null;
  // What it can go onto: a visit under way (to clock back on after a break), then the rest of the work.
  const targets: MenuEntry[] = [
    ...visits.filter((v) => v.id !== visit?.id).map((v) => ({ label: v.title, icon: "job" as const, disabled: going !== null, onSelect: () => void tap({ category: "visit", visit: { id: v.id, jobId: v.job_id, title: v.title } }) })),
    { separator: true },
    ...(["drive", "shop", "break", "other"] as TimerCategory[]).map((c) => ({
      label: t(CATEGORY_LABELS[c]),
      icon: CATEGORY_ICONS[c],
      // The one it's on now, when it isn't a visit.
      checked: on && !visit && timer.data?.category === c ? true : undefined,
      disabled: going !== null,
      onSelect: () => void tap({ category: c }),
    })),
  ];
  return (
    <div className="clock-card" data-on={on || undefined}>
      {/* What's saved about where they are, said once before the first tap that would save it. */}
      <LocationNotice />
      <span className="clock-dot" aria-hidden="true" />
      <div className="clock-text">
        {on ? (
          <>
            <div className="clock-what">{visit ? visit.title : t(CATEGORY_LABELS[timer.data!.category as TimerCategory] ?? msg("Working"))}</div>
            <div className="clock-meta tabular">{t("Clock running · {elapsed}", { elapsed })}</div>
            {day && <div className="clock-note">{t("It runs between visits too, until you stop for the day.")}</div>}
          </>
        ) : (
          <>
            <div className="clock-what">{t("Clock is off")}</div>
            {day && <div className="clock-note">{t("On my way or Start visit starts your day.")}</div>}
            {recordsPlaces(session.company) && !hasRole(session, "admin", "office") && <div className="clock-note">{t("Clocking in and out saves where you are, for the office.")}</div>}
          </>
        )}
      </div>
      <div className="clock-acts">
        <Menu
          label={on ? t("Switch") : t("Start timer")}
          title={on ? t("Switch") : t("Start timer")}
          triggerClassName={on ? "btn clock-switch" : "btn"}
          trigger={<>{going === "start" ? <Spinner size={16} /> : <Icon name={on ? "refresh" : "play"} size={16} />}<span className={on ? "clock-switch-text" : undefined}>{on ? t("Switch") : t("Start timer")}</span></>}
          items={targets}
        />
        {on && <Button icon="pause" className="clock-stop" loading={going === "stop"} disabled={going === "start"} onClick={() => void tap(null)}>{day ? t("Stop for the day") : t("Stop")}</Button>}
      </div>
    </div>
  );
}
