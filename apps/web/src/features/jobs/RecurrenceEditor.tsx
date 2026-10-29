/**
 * "Every 2 weeks on Tuesday, April to October" without typing an RRULE. Produces the rule string
 * (RFC 5545, no DTSTART) and season months, and previews the next visit dates. The job page says
 * the rule back in its own words with repeatText (repeatText.ts).
 */
import { buildSimpleRule, occurrenceDates, parseRule, parseSimpleRule, type SimpleRepeat } from "@crewtavo/core/recurrence";
import { useMemo } from "react";
import { addDaysIso, formatDay, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";

export interface Recurrence {
  rule: string;
  months: number[] | null;
  starts_on: string;
  ends_on: string | null;
}

const DAYS = [
  ["MO", "Mon"], ["TU", "Tue"], ["WE", "Wed"], ["TH", "Thu"], ["FR", "Fri"], ["SA", "Sat"], ["SU", "Sun"],
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Parsed = SimpleRepeat;
export { parseSimpleRule };
const buildRule = buildSimpleRule;

export function RecurrenceEditor({ value, onChange }: { value: Recurrence; onChange: (v: Recurrence) => void }) {
  const { company } = useSession();
  const parsed = parseSimpleRule(value.rule);
  const set = (patch: Partial<Parsed>) => onChange({ ...value, rule: buildRule({ ...parsed, ...patch }) });
  const preset = parsed.freq === "MONTHLY" ? `m${parsed.interval}` : `w${parsed.interval}`;

  const preview = useMemo(() => {
    try {
      const from = todayIn(company.timezone) > value.starts_on ? todayIn(company.timezone) : value.starts_on;
      return occurrenceDates({ starts_on: value.starts_on, ends_on: value.ends_on, recurrence_rule: value.rule, active_months: value.months }, from, addDaysIso(from, 400)).slice(0, 5);
    } catch {
      return null;
    }
  }, [value, company.timezone]);
  // A rule saved outside this editor (through the API, say) may be one jobs can't use: say why.
  const ruleError = useMemo(() => {
    try {
      parseRule(value.rule);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "This schedule can't be used.";
    }
  }, [value.rule]);

  return (
    <div className="stack" style={{ padding: 14, borderRadius: "var(--radius-control)", background: "var(--fill)", border: "1px solid var(--border)" }}>
      <div className="form-grid">
        <label className="field">
          <span>Repeats</span>
          <select
            className="select"
            value={preset}
            onChange={(e) => {
              const v = e.target.value;
              set({ freq: v.startsWith("m") ? "MONTHLY" : "WEEKLY", interval: Number(v.slice(1)) });
            }}
          >
            <option value="w1">Every week</option>
            <option value="w2">Every 2 weeks</option>
            <option value="w3">Every 3 weeks</option>
            <option value="w4">Every 4 weeks</option>
            <option value="m1">Every month</option>
            <option value="m2">Every 2 months</option>
            <option value="m3">Every 3 months</option>
          </select>
        </label>
        <label className="field">
          <span>First visit</span>
          <input className="input" type="date" value={value.starts_on} onChange={(e) => onChange({ ...value, starts_on: e.target.value })} required />
        </label>
        <label className="field">
          <span>Ends <span className="optional">(optional)</span></span>
          <input className="input" type="date" value={value.ends_on ?? ""} min={value.starts_on} onChange={(e) => onChange({ ...value, ends_on: e.target.value || null })} />
        </label>
      </div>
      {parsed.freq === "WEEKLY" ? (
        <div className="field">
          <span>On</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {DAYS.map(([key, label]) => {
              const on = parsed.days.includes(key);
              return (
                <button key={key} type="button" className="tab" aria-pressed={on} onClick={() => set({ days: on ? parsed.days.filter((d) => d !== key) : [...parsed.days, key] })}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <label className="field" style={{ maxWidth: 220 }}>
          <span>On day of the month</span>
          <select className="select" value={parsed.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      )}
      <div className="field">
        <span>Season <span className="optional">(leave all off for year-round)</span></span>
        <div className="row wrap" style={{ gap: 6 }}>
          {MONTHS.map((label, i) => {
            const month = i + 1;
            const on = value.months?.includes(month) ?? false;
            return (
              <button
                key={label}
                type="button"
                className="tab"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? (value.months ?? []).filter((m) => m !== month) : [...(value.months ?? []), month].sort((a, b) => a - b);
                  onChange({ ...value, months: next.length ? next : null });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="small">
        <span className="muted">Next visits: </span>
        {ruleError ? <span className="text-danger">{ruleError}</span> : preview === null ? <span className="text-danger">Check the dates.</span> : preview.length ? preview.map((d) => formatDay(`${d}T12:00:00`)).join(" · ") : <span className="muted">none in the next year</span>}
      </div>
    </div>
  );
}
