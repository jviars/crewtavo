/**
 * Settings → Schedule and routes: how finely the schedule snaps (5 minutes, like Google Calendar's
 * app), and how routes are organized: automatically or not, with times or numbers only, back to
 * the shop or not, driving speed and unloading time. Kept in companies.settings.schedule and read
 * with scheduleSettings() (packages/core/src/routing.ts) by the web app and the API.
 */
import { scheduleSettings, TIME_STEPS } from "@crewtavo/core/routing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";

const STEP_LABELS: Record<number, string> = { 1: "1 minute (exact)", 5: "5 minutes, like Google Calendar's app", 15: "15 minutes" };

export function ScheduleSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id, "schedule"],
    queryFn: async () => unwrap(await supabase().from("companies").select("address, settings").eq("id", company.id).single()),
  });
  const [f, setF] = useState<ReturnType<typeof scheduleSettings> | null>(null);
  useEffect(() => {
    if (details.data && !f) setF(scheduleSettings(details.data.settings));
  }, [details.data, f]);

  const save = useMutation({
    meta: { inline: true, success: "Schedule settings saved" },
    mutationFn: async () => {
      const v = f!;
      if (!(v.speedMph >= 5 && v.speedMph <= 80)) throw new Error("Driving speed has to be between 5 and 80 mph.");
      if (!(v.setupMin >= 0 && v.setupMin <= 120)) throw new Error("Unloading time has to be between 0 and 120 minutes.");
      const previous = (details.data?.settings ?? {}) as Record<string, unknown>;
      const settings = {
        ...previous,
        schedule: { time_step: v.timeStep, auto_routes: v.autoRoutes, route_times: v.routeTimes, return_to_shop: v.returnToShop, speed_mph: v.speedMph, setup_min: Math.round(v.setupMin) },
      };
      unwrap(await supabase().from("companies").update({ settings: settings as never }).eq("id", company.id));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  if (details.isPending || !f) return details.error ? <div className="card"><ErrorState error={details.error} onRetry={() => details.refetch()} /></div> : <CardSkeleton lines={6} />;
  const settings = (details.data?.settings ?? {}) as { depot?: { lat: number; lng: number } | null };
  const address = addressLine(details.data?.address as Record<string, string> | null);
  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF({ ...f, [key]: value });

  return (
    <form className="stack" style={{ maxWidth: 760 }} onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="card card-pad stack">
        <strong>Calendar</strong>
        <Field label="Time steps" hint="Dragging a visit on the schedule snaps to this. You can always type any time, like 9:03, and any length.">
          <select className="select" value={f.timeStep} onChange={(e) => set("timeStep", Number(e.target.value))} style={{ maxWidth: 360 }}>
            {TIME_STEPS.map((s) => <option key={s} value={s}>{STEP_LABELS[s]}</option>)}
          </select>
        </Field>
      </div>

      <div className="card card-pad stack">
        <strong>Routes</strong>
        <span className="muted small">
          On the schedule's Day view, <strong>Route</strong> puts a crew's stops in the shortest driving order and gives each a time, counting how long each visit takes and the drive between. Visits with a <strong>Fixed time</strong> keep it.
        </span>
        {settings.depot ? (
          <span className="small"><Icon name="home" size={14} /> Routes start at the shop: {address || "your shop address"}.</span>
        ) : (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow small" style={{ fontWeight: 400 }}>Add your shop address in <Link to="/settings?tab=company">Settings → Company</Link> so routes start and end there. Until then they start at the first stop.</div>
          </div>
        )}
        <label className="switch-row" style={{ fontWeight: 500 }}>
          <input type="checkbox" className="switch" checked={f.autoRoutes} onChange={(e) => set("autoRoutes", e.target.checked)} />
          <span>
            Organize routes automatically
            <span className="muted small" style={{ display: "block", fontWeight: 400 }}>
              Each crew's next 7 days are put in order once, and new anytime visits are fitted in where they add the least driving. A day someone ordered by hand is left alone, and so is today.
            </span>
          </span>
        </label>
        <label className="switch-row" style={{ fontWeight: 500 }}>
          <input type="checkbox" className="switch" checked={f.routeTimes} onChange={(e) => set("routeTimes", e.target.checked)} />
          <span>
            Give each stop a time
            <span className="muted small" style={{ display: "block", fontWeight: 400 }}>Off: stops are numbered in order and left as anytime that day.</span>
          </span>
        </label>
        <label className="switch-row" style={{ fontWeight: 500 }}>
          <input type="checkbox" className="switch" checked={f.returnToShop} onChange={(e) => set("returnToShop", e.target.checked)} />
          End the day back at the shop
        </label>
        <div className="form-grid">
          <Field label="Average driving speed (mph)" hint="For drive times. Around 25–35 in town.">
            <input className="input" type="number" inputMode="numeric" min={5} max={80} value={f.speedMph} onChange={(e) => set("speedMph", Number(e.target.value))} />
          </Field>
          <Field label="Unload and load at each stop (minutes)" hint="Added between stops, on top of each visit's length.">
            <input className="input" type="number" inputMode="numeric" min={0} max={120} value={f.setupMin} onChange={(e) => set("setupMin", Number(e.target.value))} />
          </Field>
        </div>
      </div>
      <FormError error={save.error} />
      <div className="form-actions" style={{ justifyContent: "flex-start" }}><Button type="submit" variant="primary" loading={save.isPending}>Save schedule settings</Button></div>
    </form>
  );
}
