/**
 * "Every 2 weeks on Tuesday, April to October" without typing an RRULE. Produces the rule string
 * (RFC 5545, no DTSTART) and season months, says it back in a line (core repeatText), and previews
 * the next visit dates. Every N days, weeks or months; monthly on a date or a weekday ("the last
 * Friday"); ending never, on a date, or after a number of visits (COUNT in the rule, whose last
 * visit's day the server keeps as the job's ends_on).
 */
import { buildSimpleRule, occurrenceDates, parseRule, parseSimpleRule, ruleDay, scheduleText, type SimpleRepeat } from "@crewtavo/core/recurrence";
import { useMemo, useState } from "react";
import { addDaysIso, formatDate, formatDay, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";

export interface Recurrence {
  rule: string;
  months: number[] | null;
  starts_on: string;
  ends_on: string | null;
}

const DAYS = [
  ["MO", "Mon", "Monday"], ["TU", "Tue", "Tuesday"], ["WE", "Wed", "Wednesday"], ["TH", "Thu", "Thursday"], ["FR", "Fri", "Friday"], ["SA", "Sat", "Saturday"], ["SU", "Sun", "Sunday"],
] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Each unit, and the most of it a job repeats every. */
const UNITS = { DAILY: ["day", 30], WEEKLY: ["week", 8], MONTHLY: ["month", 12] } as const;
const WEEKS = [[1, "First"], [2, "Second"], [3, "Third"], [4, "Fourth"], [-1, "Last"]] as const;
const MAX_VISITS = 500;

export { parseSimpleRule };

export function RecurrenceEditor({ value, onChange }: { value: Recurrence; onChange: (v: Recurrence) => void }) {
  const { company } = useSession();
  const parsed = parseSimpleRule(value.rule);
  // A rule that ends after a number of visits has no end date of its own: the server works it out.
  const emit = (next: Recurrence) => onChange(parseSimpleRule(next.rule).count ? { ...next, ends_on: null } : next);
  const set = (patch: Partial<SimpleRepeat>) => emit({ ...value, rule: buildSimpleRule({ ...parsed, ...patch }) });
  // "On a date" picked, before a date is: the rest comes from the value.
  const [pickedDate, setPickedDate] = useState(false);
  const ends = parsed.count ? "count" : value.ends_on || pickedDate ? "date" : "never";
  const most = UNITS[parsed.freq][1];

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
        <div className="field">
          <span>Repeats every</span>
          <div className="row" style={{ gap: 6 }}>
            <select className="select" aria-label="How many" value={parsed.interval} onChange={(e) => set({ interval: Number(e.target.value) })}>
              {/* One saved with a longer gap (through the API) keeps it. */}
              {Array.from({ length: Math.max(most, parsed.interval) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select
              className="select"
              aria-label="Days, weeks or months"
              value={parsed.freq}
              onChange={(e) => {
                const freq = e.target.value as SimpleRepeat["freq"];
                set({ freq, interval: Math.min(parsed.interval, UNITS[freq][1]) });
              }}
            >
              {(Object.keys(UNITS) as Array<keyof typeof UNITS>).map((f) => <option key={f} value={f}>{UNITS[f][0]}{parsed.interval === 1 ? "" : "s"}</option>)}
            </select>
          </div>
        </div>
        <label className="field">
          <span>First visit</span>
          <input className="input" type="date" value={value.starts_on} onChange={(e) => emit({ ...value, starts_on: e.target.value })} required />
        </label>
        <label className="field">
          <span>Ends</span>
          <select
            className="select"
            value={ends}
            onChange={(e) => {
              const next = e.target.value as typeof ends;
              setPickedDate(next === "date");
              emit({ ...value, rule: buildSimpleRule({ ...parsed, count: next === "count" ? parsed.count ?? 10 : null }), ends_on: next === "date" ? value.ends_on : null });
            }}
          >
            <option value="never">Never</option>
            <option value="date">On a date</option>
            <option value="count">After a number of visits</option>
          </select>
        </label>
        {ends === "date" && (
          <label className="field">
            <span>Last day</span>
            <input className="input" type="date" value={value.ends_on ?? ""} min={value.starts_on} onChange={(e) => emit({ ...value, ends_on: e.target.value || null })} required />
          </label>
        )}
        {ends === "count" && (
          <label className="field">
            <span>Visits</span>
            <input className="input" type="number" inputMode="numeric" min={1} max={MAX_VISITS} value={parsed.count ?? 10} onChange={(e) => set({ count: Math.min(MAX_VISITS, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} required />
          </label>
        )}
      </div>
      {parsed.freq === "WEEKLY" && (
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
      )}
      {parsed.freq === "MONTHLY" && (
        <div className="field">
          <span>On</span>
          <div className="row wrap" style={{ gap: 6 }}>
            <div className="segmented" role="group" aria-label="Monthly on">
              <button type="button" aria-pressed={!parsed.weekday} onClick={() => set({ weekday: null })}>A date</button>
              {/* The first visit's weekday and week, to start from: the 3rd Tuesday for Nov 17. */}
              <button type="button" aria-pressed={Boolean(parsed.weekday)} onClick={() => set({ weekday: parsed.weekday ?? { week: Math.min(4, Math.ceil(Number(value.starts_on.slice(8, 10)) / 7) || 1), day: ruleDay(value.starts_on) } })}>A weekday</button>
            </div>
            {parsed.weekday ? (
              <>
                <select className="select" aria-label="Which week" value={parsed.weekday.week} onChange={(e) => set({ weekday: { ...parsed.weekday!, week: Number(e.target.value) } })} style={{ width: "auto" }}>
                  {WEEKS.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
                </select>
                <select className="select" aria-label="Day of the week" value={parsed.weekday.day} onChange={(e) => set({ weekday: { ...parsed.weekday!, day: e.target.value } })} style={{ width: "auto" }}>
                  {DAYS.map(([key, , name]) => <option key={key} value={key}>{name}</option>)}
                </select>
              </>
            ) : (
              <select className="select" aria-label="Day of the month" value={parsed.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })} style={{ width: "auto" }}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
          </div>
        </div>
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
                  emit({ ...value, months: next.length ? next : null });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {!ruleError && <strong className="small">{scheduleText(value.rule, value.months)}{ends === "date" && value.ends_on ? `, until ${formatDate(value.ends_on)}` : ""}</strong>}
      <div className="small">
        <span className="muted">Next visits: </span>
        {ruleError ? <span className="text-danger">{ruleError}</span> : preview === null ? <span className="text-danger">Check the dates.</span> : preview.length ? preview.map((d) => formatDay(`${d}T12:00:00`)).join(" · ") : <span className="muted">none in the next year</span>}
      </div>
    </div>
  );
}
