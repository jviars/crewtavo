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
import { Button, useJustDone } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { SaveBar, Suffix, SwitchRow, unsavedCount } from "./SettingsKit";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";
import { NumberInput } from "@/components/ui/NumberInput";

const STEP_LABELS: Record<number, string> = { 1: "1 minute (exact)", 5: "5 minutes, like Google Calendar's app", 15: "15 minutes" };

export function ScheduleSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const details = useQuery({
    queryKey: ["company", company.id, "schedule"],
    queryFn: async () => {
      const [row, settings] = await Promise.all([supabase().from("companies").select("address").eq("id", company.id).single(), loadSettings(company.id)]);
      return { ...unwrap(row), settings };
    },
  });
  const [f, setF] = useState<ReturnType<typeof scheduleSettings> | null>(null);
  useEffect(() => {
    if (details.data && !f) setF(scheduleSettings(details.data.settings));
  }, [details.data, f]);

  const save = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const v = f!;
      if (!(v.speedMph >= 5 && v.speedMph <= 80)) throw new Error("Driving speed has to be between 5 and 80 mph.");
      if (!(v.setupMin >= 0 && v.setupMin <= 120)) throw new Error("Unloading time has to be between 0 and 120 minutes.");
      // Only settings.schedule, merged into the settings as they are when it saves, so a change made
      // since this page opened isn't undone.
      const schedule = { time_step: v.timeStep, auto_routes: v.autoRoutes, route_times: v.routeTimes, return_to_shop: v.returnToShop, speed_mph: v.speedMph, setup_min: Math.round(v.setupMin) };
      unwrap(await supabase().rpc("merge_company_settings", { p_company: company.id, p_settings: { schedule } }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      session.refresh();
    },
  });

  const saved = useJustDone(save);
  if (details.isPending || !f) return details.error ? <ErrorState error={details.error} onRetry={() => details.refetch()} /> : <SectionSkeleton rows={6} />;
  const settings = (details.data?.settings ?? {}) as { depot?: { lat: number; lng: number } | null };
  const address = addressLine(details.data?.address as Record<string, string> | null);
  const set = <K extends keyof typeof f>(key: K, value: (typeof f)[K]) => setF({ ...f, [key]: value });
  const unsaved = unsavedCount(f, details.data ? scheduleSettings(details.data.settings) : null);

  return (
    <form className="settings-body" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <Section level={3} title="Calendar">
        <Field label="Time steps" hint="Dragging a visit on the schedule snaps to this. You can always type any time, like 9:03, and any length.">
          <Select className="select set-narrow" value={f.timeStep} onChange={(e) => set("timeStep", Number(e.target.value))}>
            {TIME_STEPS.map((s) => <option key={s} value={s}>{STEP_LABELS[s]}</option>)}
          </Select>
        </Field>
      </Section>

      <Section level={3} title="Routes">
        <p className="set-note">
          On the schedule's Day view, <strong>Route</strong> puts a crew's stops in the shortest driving order and gives each a time, counting how long each visit takes and the drive between. Visits with a <strong>Fixed time</strong> keep it.
        </p>
        {settings.depot ? (
          <p className="set-note set-note-icon"><Icon name="home" size={14} />Routes start at the shop: {address || "your shop address"}.</p>
        ) : (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <div className="grow">Add your shop address in <Link to="/settings?tab=company">Settings → Company</Link> so routes start and end there. Until then they start at the first stop.</div>
          </div>
        )}
        <div className="set-rows">
          <SwitchRow
            label="Organize routes automatically"
            hint="Each crew's next 7 days are put in order once, and new anytime visits are fitted in where they add the least driving. A day someone ordered by hand is left alone, and so is today."
            checked={f.autoRoutes}
            onChange={(on) => set("autoRoutes", on)}
          />
          <SwitchRow label="Give each stop a time" hint="Off: stops are numbered in order and left as anytime that day." checked={f.routeTimes} onChange={(on) => set("routeTimes", on)} />
          <SwitchRow label="End the day back at the shop" checked={f.returnToShop} onChange={(on) => set("returnToShop", on)} />
        </div>
        <div className="set-grid">
          <Field label={<>Average driving speed<span className="sr-only"> (mph)</span></>} hint="For drive times. Around 25–35 in town.">
            <Suffix unit="mph"><NumberInput className="input" inputMode="numeric" min={5} max={80} value={f.speedMph} onChange={(e) => set("speedMph", Number(e.target.value))} /></Suffix>
          </Field>
          <Field label={<>Unload and load at each stop<span className="sr-only"> (minutes)</span></>} hint="Added between stops, on top of each visit's length.">
            <Suffix unit="min"><NumberInput className="input" inputMode="numeric" min={0} max={120} value={f.setupMin} onChange={(e) => set("setupMin", Number(e.target.value))} /></Suffix>
          </Field>
        </div>
      </Section>
      <FormError error={save.error} />
      <SaveBar note={unsaved ? (unsaved === 1 ? "1 unsaved change" : `${unsaved} unsaved changes`) : null}>
        <Button type="submit" variant="primary" loading={save.isPending} done={saved}>Save schedule settings</Button>
        <FormChecks />
      </SaveBar>
    </form>
  );
}
