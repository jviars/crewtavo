/**
 * What Finance and Metrics share: the date range in the address bar and its menu, the sections'
 * tabs, and the loading and error wrapper around a tab.
 */
import { useQuery } from "@tanstack/react-query";
import type { KeyboardEvent, ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, StatsSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatNumber, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./Finance.module.css";
import { PRESETS, resolveRange, shortDate, type PresetKey, type Range } from "./range";

export interface TeamMember { user_id: string; labor_rate: number | null; active: boolean; profile: { full_name: string; color: string | null } | null; sub?: { id: string; name: string } }
export { memberName } from "../subs/memberName";

export { timeRates, type Rates } from "./jobCosts";

/** A share in whole percent; nothing (an empty cell, not "—") when there's nothing to divide by. */
export const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "");
export const hrs = (n: number) => (n > 0 && n < 1 ? `${Math.max(1, Math.round(n * 60))} min` : `${formatNumber(n, n < 10 && n % 1 ? 1 : 0)} h`);
export const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
export const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export function useTeam() {
  const session = useSession();
  // Subs too: one the office keeps hours for has time in these reports (GET /team?with_subs=1).
  return useQuery({ queryKey: ["team", session.company.id, "with-subs"], staleTime: 5 * 60_000, queryFn: () => api.get<TeamMember[]>("/team?with_subs=1") });
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

/** The button's words: the preset ("This month"), or "Custom range". */
const presetWords = (key: PresetKey) => (key === "custom" ? "Custom range" : (PRESETS.find((p) => p.key === key)?.label ?? key));

/** A custom range's two dates. */
export function CustomRange({ state }: { state: RangeParams }) {
  const { range, update } = state;
  return (
    <div className={styles.custom} role="group" aria-label="Custom range">
      <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && update({ from: e.target.value })} aria-label="From" />
      <span>to</span>
      <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && update({ to: e.target.value })} aria-label="To" />
    </div>
  );
}

/**
 * The date range: a small button saying the range ("This month ⌄") that opens a menu of the presets,
 * the chosen one checked, then Custom range. With a custom range its two dates follow, unless
 * `dates` is false (RangeHeader puts them on their own line under the title).
 */
export function RangePicker({ state, dates = true }: { state: RangeParams; dates?: boolean }) {
  const { presetKey, range, update } = state;
  const items: MenuEntry[] = [
    ...PRESETS.filter((p) => p.key !== "custom").map((p) => ({ label: p.label, checked: presetKey === p.key, onSelect: () => update({ range: p.key, from: null, to: null }) })),
    { separator: true },
    { label: "Custom range", checked: presetKey === "custom", onSelect: () => update({ range: "custom", from: range.from, to: range.to }) },
  ];
  const menu = (
    <Menu
      items={items}
      label={`Date range: ${presetWords(presetKey)}`}
      title="Date range"
      align="end"
      triggerClassName={cx("btn btn-sm", styles.rangeBtn)}
      trigger={<>{presetWords(presetKey)}<Icon name="chevronDown" size={14} /></>}
    />
  );
  if (!dates || presetKey !== "custom") return menu;
  return <div className={styles.picker}><CustomRange state={state} />{menu}</div>;
}

/** Two dates in words: "Oct 1 – Oct 20", with the year when it isn't this one ("Jan 2 – Dec 31, 2024"). */
export function datesWords(from: string, to: string, today: string): string {
  const year = to.slice(0, 4) !== today.slice(0, 4) || from.slice(0, 4) !== today.slice(0, 4) ? `, ${to.slice(0, 4)}` : "";
  return `${shortDate(from)}${from !== to ? ` – ${shortDate(to)}` : ""}${year}`;
}

/** The range in words: "Oct 1 – Oct 20 · 20 days", with the year when it isn't this one. */
export function rangeWords(range: Range, today: string): string {
  return `${datesWords(range.from, range.to, today)} · ${plural(range.days, "day")}`;
}

/** Ids that tie a section's tab to its panel. */
export const tabId = (key: string) => `report-tab-${key}`;
export const PANEL_ID = "report-panel";

/**
 * The page title with the range in words under it and its menu beside it, then the sections as
 * underline tabs (chips on a phone). Arrow keys, Home and End move between the tabs.
 */
export function RangeHeader<K extends string>({ title, state, tabs, tab }: { title: string; state: RangeParams; tabs: ReadonlyArray<{ key: K; label: string }>; tab: K }) {
  const { range, today, update, presetKey } = state;
  const first = tabs[0]?.key;
  const open = (key: K) => update({ tab: key === first ? null : key });
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.key === tab);
    const to = e.key === "ArrowRight" ? (at + 1) % tabs.length : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    open(tabs[to]!.key);
    document.getElementById(tabId(tabs[to]!.key))?.focus();
  };
  return (
    <>
      <PageHeader title={title} lede={rangeWords(range, today)} actions={<RangePicker state={state} dates={false} />}>
        {presetKey === "custom" && <CustomRange state={state} />}
      </PageHeader>
      <div className={cx("underline-tabs", styles.tabs)} role="tablist" aria-label={title} onKeyDown={keys}>
        {tabs.map((t) => (
          <button key={t.key} id={tabId(t.key)} type="button" role="tab" aria-selected={tab === t.key} aria-controls={PANEL_ID} tabIndex={tab === t.key ? 0 : -1} onClick={() => open(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** The panel under the tabs: the chosen section's parts, a grouped look on a phone. */
export function TabPanel({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <div key={tab} id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(tab)} className={cx("m-grouped", styles.panel)} style={{ animation: "page-in var(--dur-slow) var(--ease-out)" }}>
      {children}
    </div>
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
  if (query.error && !query.data) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data)
    return (
      <Loading label="Loading figures" className={styles.body}>
        {skeleton ?? (
          <>
            <StatsSkeleton count={4} />
            <div className={styles.cols2}><CardSkeleton lines={6} /><CardSkeleton lines={4} /></div>
          </>
        )}
      </Loading>
    );
  return <div className={cx(styles.body, query.isPlaceholderData && "is-stale")} aria-busy={query.isPlaceholderData || undefined}>{children(query.data)}</div>;
}
