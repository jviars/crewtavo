/**
 * The clock at the property on My day and a visit's screen (geofence.ts runs it while this is on
 * screen): what the phone asks as someone gets to a visit's property or leaves it ("You're at
 * 12 Oak St. Start the visit?"), with what it did already, and a line saying it's on.
 *
 * Starting and completing a visit stay the person's own taps, through the screen's own buttons
 * (`onStatus`): starting one can text the client, and Complete visit checks the checklist first on
 * the visit's screen. "Start my clock" and "Stop my clock" are clock taps like the clock card's,
 * dated when they're tapped. On the visits-only clock "Stop my clock" is the only way the clock at
 * the property ever stops a clock: the phone asks and never takes anyone off the clock by itself.
 */
import { onlineManager, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { FIELD_SCOPE } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { clockChange, clockSaved, showClockTap, type ClockChange } from "./clockTaps";
import { clockPlace, onDayClock, useRunningTimer } from "./fieldData";
import { dismissPrompt, promptStands, promptText, useGeofence, useGeofencePrompts, type GeofencePrompt } from "./geofence";
import { useMyDay } from "./myDay";
import { t } from "@/lib/i18n";

/** On My day: every visit's questions. On a visit's screen (`visitId`): that visit's. */
export function GeofenceCard({ visitId, onStatus }: { visitId?: string; onStatus: (visit: { id: string; jobId: string | null }, status: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const { mode, watching, denied } = useGeofence();
  const prompts = useGeofencePrompts();
  const day = useMyDay(mode !== "off");
  const timer = useRunningTimer(session.company.id, session.userId, mode !== "off");
  const dayClock = onDayClock(session);
  const clock = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { day: dayClock }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["running-timer", "time", "field", "field-visit", "crew-clock"]) void queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  if (mode === "off") return null;

  const statusOf = (id: string) => day.data?.today.find((v) => v.id === id)?.status;
  // Two of today's visits at one place: the question says which it means.
  const shared = (p: GeofencePrompt) => (day.data?.today ?? []).some((v) => v.id !== p.visitId && v.status !== "completed" && v.status !== "cancelled" && (v.property?.line1 || v.title) === p.place);
  const shown = prompts.filter((p) => (!visitId || p.visitId === visitId) && promptStands(p, statusOf(p.visitId), timer.data));
  // A tap on the clock, dated now, with where the phone is where the company keeps that.
  const tapClock = async (p: GeofencePrompt, start: boolean) => {
    dismissPrompt(p.id);
    const at = new Date().toISOString();
    const place = await clockPlace(session);
    const target = start ? { category: "visit" as const, visit: { id: p.visitId, jobId: p.jobId, title: p.title } } : dayClock ? { category: "drive" as const } : null;
    clock.mutate({ ...clockChange(session, [session.userId], target, place, at), ...(!start && { fromVisit: p.visitId }) });
  };
  const status = (p: GeofencePrompt, next: string) => {
    dismissPrompt(p.id);
    onStatus({ id: p.visitId, jobId: p.jobId }, next);
  };

  return (
    <>
      {shown.map((p) => {
        const text = promptText(p);
        return (
          <div key={p.id} className="callout callout-good" role="alert">
            <Icon name="pin" size={16} />
            <div className="grow geofence-ask">
              <div>{text.title}</div>
              {shared(p) && <span className="small">{p.title}</span>}
              {p.done && <span>{p.done}.</span>}
              <span>{text.question}</span>
              <span className="field-ask-acts">
                {p.kind === "start" && !p.clockOnly && <Button size="sm" variant="primary" icon="play" onClick={() => status(p, "in_progress")}>{t("Start visit")}</Button>}
                {p.kind === "start" && p.clockOnly && <Button size="sm" variant="primary" icon="play" onClick={() => void tapClock(p, true)}>{t("Start my clock")}</Button>}
                {p.kind === "finish" && p.complete && <Button size="sm" variant="primary" icon="check" onClick={() => status(p, "completed")}>{t("Complete visit")}</Button>}
                {p.kind === "finish" && p.stopClock && <Button size="sm" icon="pause" onClick={() => void tapClock(p, false)}>{dayClock ? t("Switch to driving") : t("Stop my clock")}</Button>}
                <Button size="sm" variant="ghost" onClick={() => dismissPrompt(p.id)}>{t("Not now")}</Button>
              </span>
            </div>
          </div>
        );
      })}
      {watching && denied && (
        <div className="callout callout-warning" role="status">
          <Icon name="pin" size={16} />
          <div className="grow">
            <div>{t("Location is off for Crewtavo")}</div>
            {mode === "clock" ? t("Your clock can't start at the property. Turn on location for Crewtavo in your phone's settings.") : t("Crewtavo can't remind you at the property. Turn on location for Crewtavo in your phone's settings.")}
          </div>
        </div>
      )}
      {!visitId && watching && !denied && (
        <p className="field-hint">
          {mode === "clock"
            ? dayClock
              ? t("Your clock starts when Crewtavo is open on this phone at your next visit, not when you pull in. Once it sees you've left, it moves your clock to driving. Open it when you get there and when you leave, or tap the clock yourself.")
              : t("Your clock starts when Crewtavo is open on this phone at your next visit, not when you pull in. It never stops your clock by itself: once it sees you've left, it asks you. Open it when you get there and when you leave, or tap the clock yourself.")
            : t("Crewtavo reminds you to start and finish visits when it's open on this phone at the property. It can't tell while the phone is locked.")}
        </p>
      )}
    </>
  );
}
