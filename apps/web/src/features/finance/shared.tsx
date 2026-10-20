/**
 * What Finance and Metrics share: the date range in the address bar and its picker, the tab bar,
 * the loading and error wrapper around a tab, and reading every row of a long result.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api, unwrap } from "@/lib/api";
import { formatNumber, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { PRESETS, resolveRange, shortDate, type PresetKey, type Range } from "./range";

export interface TeamMember { user_id: string; labor_rate: number | null; active: boolean; profile: { full_name: string; color: string | null } | null }

/** Supabase returns at most 1,000 rows per request; page through larger result sets. */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 25; i++) {
    const rows = unwrap(await page(i * 1000, i * 1000 + 999) as never) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

export type Rates = Record<string, number>;
/** The pay rate approved time was costed at, by entry, for people with job costs (only the server reads it). */
export const timeRates = (costs: boolean, filter: { job_ids: string[] } | { from: string; to: string }): Promise<Rates> =>
  costs ? api.post<Rates>("/time/rates", filter) : Promise.resolve({});

export const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
export const hrs = (n: number) => (n > 0 && n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${formatNumber(n, n < 10 && n % 1 ? 1 : 0)} h`);
export const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
export const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export function useTeam() {
  const session = useSession();
  return useQuery({ queryKey: ["team", session.company.id], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team") });
}

/** The date range (and tab) kept in the address bar, so a view can be bookmarked or shared. */
export function useRangeParams() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const presetKey = (PRESETS.find((p) => p.key === params.get("range"))?.key ?? "month") as PresetKey;
  const range = resolveRange(presetKey, today, tz, { from: params.get("from"), to: params.get("to") });
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };
  return { params, today, presetKey, range, update };
}
export type RangeParams = ReturnType<typeof useRangeParams>;

/** Carries the date range to another page's address: "range=month", or a custom range's dates. */
export const rangeQuery = (range: Range) => (range.key === "custom" ? `range=custom&from=${range.from}&to=${range.to}` : `range=${range.key}`);

/** The page title with its date range picker, the range in words, and the tab bar. */
export function RangeHeader<K extends string>({ title, state, tabs, tab }: { title: string; state: RangeParams; tabs: ReadonlyArray<{ key: K; label: string }>; tab: K }) {
  const { presetKey, range, today, update } = state;
  const first = tabs[0]?.key;
  return (
    <>
      <PageHeader
        title={title}
        actions={
          <div className="row wrap" style={{ gap: 8 }}>
            <label className="select-pill range-pill">
              <Icon name="calendar" size={15} />
              <span className="range-pill-label">Date range</span>
              <select value={presetKey} onChange={(e) => update(e.target.value === "custom" ? { range: "custom", from: range.from, to: range.to } : { range: e.target.value, from: null, to: null })}>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <Icon name="chevronDown" size={14} />
            </label>
            {presetKey === "custom" && (
              <div className="row" style={{ gap: 6 }}>
                <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && update({ from: e.target.value })} aria-label="From" style={{ width: 150 }} />
                <span className="muted">to</span>
                <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && update({ to: e.target.value })} aria-label="To" style={{ width: 150 }} />
              </div>
            )}
          </div>
        }
      />
      <p className="page-subtitle">{shortDate(range.from)}{range.from !== range.to && ` – ${shortDate(range.to)}`}{range.to.slice(0, 4) !== today.slice(0, 4) || range.from.slice(0, 4) !== today.slice(0, 4) ? `, ${range.to.slice(0, 4)}` : ""} · {plural(range.days, "day")}</p>
      <div className="underline-tabs" role="tablist" aria-label={title}>
        {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => update({ tab: t.key === first ? null : t.key })}>{t.label}</button>)}
      </div>
    </>
  );
}

export interface Loaded<T> { data: T | undefined; error: unknown; isPlaceholderData: boolean; refetch: () => unknown }

/** Two queries shown as one: loaded when both are. */
export function both<A, B>(a: Loaded<A>, b: Loaded<B>): Loaded<[A, B]> {
  return {
    data: a.data !== undefined && b.data !== undefined ? [a.data, b.data] : undefined,
    error: a.error ?? b.error,
    isPlaceholderData: a.isPlaceholderData || b.isPlaceholderData,
    refetch: () => Promise.all([a.refetch(), b.refetch()]),
  };
}

/** Shared loading/error/stale wrapper for a tab's queries. */
export function TabBody<T>({ query, skeleton, children }: { query: Loaded<T>; skeleton?: ReactNode; children: (data: T) => ReactNode }) {
  if (query.error && !query.data) return <div className="card"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  if (!query.data)
    return (
      <Loading label="Loading figures" className="stack">
        {skeleton ?? (
          <>
            <div className="card kpi-strip" aria-hidden>{[0, 1, 2, 3].map((i) => <div key={i} className="kpi" style={{ display: "grid", gap: 10 }}><Skeleton width="55%" height={10} /><Skeleton width="70%" height={22} /></div>)}</div>
            <div className="report-grid"><CardSkeleton height={240} /><CardSkeleton lines={5} /></div>
          </>
        )}
      </Loading>
    );
  return <div className={`stack${query.isPlaceholderData ? " is-stale" : ""}`} style={{ gap: 28 }}>{children(query.data)}</div>;
}

export function SectionHead({ title, id, children }: { title: string; id?: string; children?: ReactNode }) {
  return (
    <div className="fin-section-head">
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  );
}
