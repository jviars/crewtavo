/**
 * Settings → Weather rules: the work that needs good weather, and how good. The weather task checks
 * the next few days' visits against them and warns on the schedule, Home and the crew's visit; it
 * never moves a visit. Kept in companies.settings.weather_rules (the trade preset's at sign-up, shape
 * in packages/core/src/weather.ts) and saved all at once with set_weather_rules, which the office with
 * Settings may use too, as with the price list and checklists. Above them, where every forecast
 * comes from, for these warnings and for Snow alike (settings.weather_source, set_weather_source).
 */
import { isPavingWork, PAVING_WORK, PAVING_WORK_IDS, pavingWorkLabel } from "@crewtavo/core/paving";
import { namedWeatherRules, WEATHER_SOURCE_LABELS, weatherRuleSummary, weatherSourceOf, type WeatherRule, type WeatherSource } from "@crewtavo/core/weather";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { SettingsActions } from "./SettingsKit";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";
import { NumberInput } from "@/components/ui/NumberInput";

interface Service { id: string; name: string; category: string | null; active: boolean }

const same = (a: WeatherRule, b: WeatherRule) => JSON.stringify(a) === JSON.stringify(b);

export function WeatherSettings() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["company", company.id, "weather"];
  const rules = useQuery({
    queryKey: key,
    queryFn: async () => {
      const list = (await loadSettings(company.id)).weather_rules;
      // Settings are JSON anyone with the key could have edited: anything that isn't a rule is skipped, as the weather task does.
      return Array.isArray(list) ? (list.filter((r) => r && typeof r === "object") as WeatherRule[]) : [];
    },
  });
  const services = useQuery({
    queryKey: ["services", company.id, "weather"],
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, category, active").eq("company_id", company.id).order("sort").order("name")) as Service[],
  });
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: async (list: WeatherRule[]) => unwrap(await supabase().rpc("set_weather_rules", { p_company: company.id, p_rules: list as never })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["company", company.id] }),
  });
  // Gone at once, with Undo; saved without it once the toast leaves.
  const remove = (rule: WeatherRule, at: number) =>
    undoable({
      title: "Weather rule deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<WeatherRule[]>(key, (list) => list?.filter((r) => !same(r, rule)));
      },
      restore: () => queryClient.setQueryData<WeatherRule[]>(key, (list) => (list && !list.some((r) => same(r, rule)) ? [...list.slice(0, at), rule, ...list.slice(at)] : list)),
      commit: () => save.mutateAsync(queryClient.getQueryData<WeatherRule[]>(key) ?? []),
    });

  if (rules.isPending) return <Loading label="Loading your weather rules"><SectionSkeleton rows={4} /></Loading>;
  if (rules.error) return <ErrorState error={rules.error} onRetry={() => rules.refetch()} />;
  const list = rules.data;
  // Each rule's item called what it's called now: a rule follows its item when it's renamed.
  const named = namedWeatherRules(list, new Map((services.data ?? []).map((s) => [s.id, s.name])));

  return (
    <>
      <SettingsActions><Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add a rule</Button></SettingsActions>
      <Section level={3} title="Rules" count={list.length || undefined}>
        {list.length ? (
          <ul className="rel" role="list">
            {list.map((rule, i) => {
              const summary = weatherRuleSummary(named[i]!);
              // "Sealcoat: at least 50°F, 24 dry hours after": the work as the row's title, its limits quietly under it.
              const cut = summary.lastIndexOf(": ");
              const limits = summary.slice(cut + 2);
              return (
                <RelatedRow
                  key={`${i}-${JSON.stringify(rule)}`}
                  onClick={() => setEditing(i)}
                  title={summary.slice(0, cut)}
                  sub={limits.charAt(0).toUpperCase() + limits.slice(1)}
                  actions={
                    <Menu
                      label={`More for ${summary}`}
                      title={summary.slice(0, cut)}
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      items={[
                        { label: "Edit rule", icon: "edit", kbd: "E", onSelect: () => setEditing(i) },
                        { separator: true },
                        { label: "Delete rule", icon: "trash", danger: true, onSelect: () => remove(rule, i) },
                      ]}
                    />
                  }
                />
              );
            })}
          </ul>
        ) : (
          <EmptyState inline title="No weather rules yet" action={<Button onClick={() => setEditing("new")}>Add a rule</Button>} />
        )}
      </Section>
      <ForecastSource />
      {editing !== null && (
        <RuleDialog
          rule={editing === "new" ? null : named[editing]!}
          services={services.data ?? []}
          calculator={featureOn(company.settings, "paving_app")}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            await save.mutateAsync(editing === "new" ? [...list, rule] : list.map((r, i) => (i === editing ? rule : r)));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

const LIMITS = [
  ["max_rain_pct", "Most chance of rain (%)", 0, 100],
  ["min_temp_f", "Lowest temperature (°F)", -40, 130],
  ["max_temp_f", "Highest temperature (°F)", -40, 130],
  ["max_wind_mph", "Most wind (mph)", 0, 100],
  ["requires_dry_hours", "Dry hours needed after", 1, 168],
] as const;
type Limit = (typeof LIMITS)[number][0];

/** A kind of paving calculator work as the Work list's value, told apart from an item's id or name. */
const KIND = "calculator:";

/**
 * Add a rule or change one: the work it's for (a price list item, every job, or with Paving installed
 * a kind of work on jobs priced with the paving calculator, which have no price list item) and its
 * limits, each optional.
 */
function RuleDialog({ rule, services, calculator, onClose, onSave }: { rule: WeatherRule | null; services: Service[]; calculator: boolean; onClose: () => void; onSave: (rule: WeatherRule) => Promise<void> }) {
  // The item's id; for a rule whose item isn't found (one from before ids, say), its name.
  const [work, setWork] = useState(isPavingWork(rule?.work) ? `${KIND}${rule.work}` : rule?.service_id ?? services.find((s) => s.name === rule?.applies_to)?.id ?? rule?.applies_to ?? "");
  const picked = work.startsWith(KIND) ? work.slice(KIND.length) : null;
  const kind = isPavingWork(picked) ? picked : null;
  const [limits, setLimits] = useState<Record<Limit, string>>(() => Object.fromEntries(LIMITS.map(([k]) => [k, rule?.[k] != null ? String(rule[k]) : ""])) as Record<Limit, string>);
  const save = useMutation({
    meta: { inline: true, success: rule ? "Weather rule saved" : "Weather rule added" },
    mutationFn: async () => {
      const item = services.find((s) => s.id === work);
      // An item not found keeps the rule's own: set_weather_rules goes by its name when the id is gone.
      const next: WeatherRule = kind
        ? { work: kind, applies_to: pavingWorkLabel(kind) }
        : item ? { service_id: item.id, applies_to: item.name } : work ? { ...(rule?.service_id && { service_id: rule.service_id }), applies_to: rule?.applies_to } : {};
      for (const [k] of LIMITS) if (limits[k].trim()) next[k] = Number(limits[k]);
      if (!LIMITS.some(([k]) => next[k] != null)) throw new Error("Give it at least one limit: rain, temperature, wind or dry hours.");
      if (next.min_temp_f != null && next.max_temp_f != null && next.min_temp_f > next.max_temp_f) throw new Error("The lowest temperature has to be below the highest.");
      await onSave(next);
    },
  });
  // A rule for an item no longer on the price list (removed, say) keeps it until it's changed.
  const offered = services.filter((s) => s.active || s.id === work);
  const missing = work && !kind && !offered.some((s) => s.id === work);
  const categories = [...new Set(offered.map((s) => s.category?.trim() || "Other"))];

  return (
    <Dialog open onClose={onClose} title={rule ? "Edit weather rule" : "Add a weather rule"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Work" hint={kind ? "Visits for jobs priced with the paving calculator that have this work are checked against the rule. Each calculator item says what kind of work it is in Paving → Calculator → Set up." : "Visits for jobs with this on them are checked against the rule."}>
          <Select className="select" value={work} onChange={(e) => setWork(e.target.value)}>
            <option value="">Every job</option>
            {missing && <option value={work}>{rule?.applies_to ?? "An item"} (not on your price list)</option>}
            {(calculator || kind) && (
              <optgroup label="Priced with the paving calculator">
                {PAVING_WORK_IDS.map((w) => <option key={w} value={`${KIND}${w}`}>{PAVING_WORK[w]}</option>)}
              </optgroup>
            )}
            {categories.map((c) => (
              <optgroup key={c} label={c}>
                {offered.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </Select>
        </Field>
        <div className="form-grid">
          {LIMITS.map(([k, label, min, max]) => (
            <Field key={k} label={label} optional hint={k === "requires_dry_hours" ? "Rain likely during them, the visit day included, gets a warning." : undefined}>
              <NumberInput className="input" min={min} max={max} step={k === "requires_dry_hours" ? 1 : "any"} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{rule ? "Save rule" : "Add rule"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What each forecast source is, under its name. */
const SOURCES: Array<{ source: WeatherSource; about: string }> = [
  { source: "nws", about: "Free for any use, from the government's own forecasters. United States only: a property anywhere else gets Open-Meteo's forecast." },
  { source: "open_meteo", about: "Free and worldwide, for every property. Open-Meteo's terms keep its free service to non-commercial use." },
  { source: "open_meteo_commercial", about: "The same forecasts from Open-Meteo's paid service, with your own key, for business use." },
];

/**
 * Where forecasts come from: one choice for weather warnings and Snow, the National Weather Service
 * unless the business picks another. Open-Meteo's paid service is
 * on the list only once the business has added the Open-Meteo app (its key, on the Apps page);
 * until then the list points there.
 */
function ForecastSource() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["company", company.id, "weather-source"];
  const chosen = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [row, app] = await Promise.all([
        loadSettings(company.id),
        supabase().from("integrations").select("status").eq("company_id", company.id).eq("provider", "open_meteo").maybeSingle(),
      ]);
      return { source: weatherSourceOf(row), paid: app.data?.status === "connected" };
    },
  });
  const pick = useMutation({
    meta: { success: (source: WeatherSource) => `Forecasts now come from ${WEATHER_SOURCE_LABELS[source]}` },
    mutationFn: async (source: WeatherSource) => unwrap(await supabase().rpc("set_weather_source", { p_company: company.id, p_source: source })) as WeatherSource,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      queryClient.invalidateQueries({ queryKey: ["snow", company.id] });
    },
  });
  const current = pick.isPending ? pick.variables : chosen.data?.source;
  const paid = Boolean(chosen.data?.paid);
  return (
    <Section level={3} title="Forecast source">
      <div className="set-rows" role="radiogroup" aria-label="Forecast source">
        {SOURCES.filter(({ source }) => source !== "open_meteo_commercial" || paid || current === source).map(({ source, about }) => (
          <label key={source} className="set-row set-choice">
            <input type="radio" name="weather-source" checked={current === source} disabled={chosen.isPending || pick.isPending} onChange={() => pick.mutate(source)} />
            <span className="set-row-text">
              <span className="set-row-label">{WEATHER_SOURCE_LABELS[source]}</span>
              <span className="set-row-hint">{about}</span>
            </span>
          </label>
        ))}
      </div>
      <FormError error={pick.error ?? chosen.error} />
      <p className="set-note">
        Used for the weather warnings on visits and for Snow. Official winter storm alerts on the Snow page always come from the National Weather Service.
        {chosen.data && !paid && <> A business that wants Open-Meteo's forecasts needs its paid service, which becomes a choice here once you add the <Link to="/apps/open_meteo">Open-Meteo (commercial) app</Link>.</>}
      </p>
    </Section>
  );
}
