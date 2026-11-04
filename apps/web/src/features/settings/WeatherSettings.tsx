/**
 * Settings → Weather rules: the work that needs good weather, and how good. The weather task checks
 * the next few days' visits against them and warns on the schedule, Home and the crew's visit; it
 * never moves a visit. Kept in companies.settings.weather_rules (the trade preset's at sign-up, shape
 * in packages/core/src/weather.ts) and saved all at once with set_weather_rules, which the office with
 * Settings may use too, as with the price list and checklists.
 */
import { namedWeatherRules, weatherRuleSummary, type WeatherRule } from "@crewtavo/core/weather";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";

interface Service { id: string; name: string; category: string | null; active: boolean }

const same = (a: WeatherRule, b: WeatherRule) => JSON.stringify(a) === JSON.stringify(b);

export function WeatherSettings() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["company", company.id, "weather"];
  const rules = useQuery({
    queryKey: key,
    queryFn: async () => {
      const row = unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single());
      const list = (row.settings as { weather_rules?: unknown } | null)?.weather_rules;
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

  if (rules.isPending) return <Loading label="Loading your weather rules"><CardSkeleton lines={4} /></Loading>;
  if (rules.error) return <div className="card"><ErrorState error={rules.error} onRetry={() => rules.refetch()} /></div>;
  const list = rules.data;
  // Each rule's item called what it's called now: a rule follows its item when it's renamed.
  const named = namedWeatherRules(list, new Map((services.data ?? []).map((s) => [s.id, s.name])));

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="card card-pad stack-sm">
        <h2 className="section-title">Weather rules</h2>
        <p className="muted" style={{ margin: 0 }}>
          The work that needs good weather, and how good. Visits in the next few days for jobs with that work get a weather warning on the schedule, on Home and on the crew's visit. Nothing is moved by itself.
        </p>
      </div>
      <div className="row-between">
        <span className="muted small">{list.length === 1 ? "1 rule" : `${list.length} rules`}</span>
        <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add a rule</Button>
      </div>
      <div className="card">
        {list.map((rule, i) => (
          <div key={`${i}-${JSON.stringify(rule)}`} className="card-row">
            <span className="grow">{weatherRuleSummary(named[i]!)}</span>
            <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${weatherRuleSummary(named[i]!)}`} onClick={() => setEditing(i)} />
            <Button size="sm" variant="ghost" icon="trash" aria-label={`Delete ${weatherRuleSummary(named[i]!)}`} onClick={() => remove(rule, i)} />
          </div>
        ))}
        {!list.length && <EmptyState inline title="No weather rules yet" />}
      </div>
      {editing !== null && (
        <RuleDialog
          rule={editing === "new" ? null : named[editing]!}
          services={services.data ?? []}
          onClose={() => setEditing(null)}
          onSave={async (rule) => {
            await save.mutateAsync(editing === "new" ? [...list, rule] : list.map((r, i) => (i === editing ? rule : r)));
            setEditing(null);
          }}
        />
      )}
    </div>
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

/** Add a rule or change one: the work it's for (a price list item, or every job) and its limits, each optional. */
function RuleDialog({ rule, services, onClose, onSave }: { rule: WeatherRule | null; services: Service[]; onClose: () => void; onSave: (rule: WeatherRule) => Promise<void> }) {
  // The item's id; for a rule whose item isn't found (one from before ids, say), its name.
  const [work, setWork] = useState(rule?.service_id ?? services.find((s) => s.name === rule?.applies_to)?.id ?? rule?.applies_to ?? "");
  const [limits, setLimits] = useState<Record<Limit, string>>(() => Object.fromEntries(LIMITS.map(([k]) => [k, rule?.[k] != null ? String(rule[k]) : ""])) as Record<Limit, string>);
  const save = useMutation({
    meta: { inline: true, success: rule ? "Weather rule saved" : "Weather rule added" },
    mutationFn: async () => {
      const item = services.find((s) => s.id === work);
      // An item not found keeps the rule's own: set_weather_rules goes by its name when the id is gone.
      const next: WeatherRule = item ? { service_id: item.id, applies_to: item.name } : work ? { ...(rule?.service_id && { service_id: rule.service_id }), applies_to: rule?.applies_to } : {};
      for (const [k] of LIMITS) if (limits[k].trim()) next[k] = Number(limits[k]);
      if (!LIMITS.some(([k]) => next[k] != null)) throw new Error("Give it at least one limit: rain, temperature, wind or dry hours.");
      if (next.min_temp_f != null && next.max_temp_f != null && next.min_temp_f > next.max_temp_f) throw new Error("The lowest temperature has to be below the highest.");
      await onSave(next);
    },
  });
  // A rule for an item no longer on the price list (removed, say) keeps it until it's changed.
  const offered = services.filter((s) => s.active || s.id === work);
  const missing = work && !offered.some((s) => s.id === work);
  const categories = [...new Set(offered.map((s) => s.category?.trim() || "Other"))];

  return (
    <Dialog open onClose={onClose} title={rule ? "Edit weather rule" : "Add a weather rule"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Work" hint="Visits for jobs with this on them are checked against the rule.">
          <select className="select" value={work} onChange={(e) => setWork(e.target.value)}>
            <option value="">Every job</option>
            {missing && <option value={work}>{rule?.applies_to ?? "An item"} (not on your price list)</option>}
            {categories.map((c) => (
              <optgroup key={c} label={c}>
                {offered.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          {LIMITS.map(([k, label, min, max]) => (
            <Field key={k} label={label} optional hint={k === "requires_dry_hours" ? "Rain likely during them, the visit day included, gets a warning." : undefined}>
              <input className="input" type="number" min={min} max={max} step={k === "requires_dry_hours" ? 1 : "any"} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
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
