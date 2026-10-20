/**
 * Finance and Metrics visuals: a trend line over the period (Recharts), a split bar with its legend, a strip of
 * figures, a ranked bar list, cards to hold them and a sortable table with CSV export.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/Button";
import { CHART_MOTION, ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/Chart";
import { Icon } from "@/components/ui/Icon";
import { downloadCsv, toCsv } from "@/lib/csv";
import type { Bucket } from "./range";

const edgeDate = (d: string, year: boolean) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: year ? "numeric" : undefined, timeZone: "UTC" });

/**
 * A line over the period's buckets, with the axis on the right and the first and last dates under
 * it. `previous` draws the period before as a dashed line for comparison.
 */
export function TrendChart({ buckets, values, previous, format, label, color = "var(--green)", height = 150 }: { buckets: Bucket[]; values: number[]; previous?: number[]; format: (n: number) => string; label: string; color?: string; height?: number }) {
  const data = buckets.map((b, i) => ({ title: b.title, value: values[i] ?? 0, previous: previous?.[i] ?? null }));
  const empty = !values.some((v) => v !== 0) && !previous?.some((v) => v !== 0);
  // Counts (and whole-dollar sums) get whole-number ticks, so a small count doesn't show "0, 1, 1".
  const whole = [...values, ...(previous ?? [])].every(Number.isInteger);
  const config: ChartConfig = previous
    ? { value: { label: "This period", color }, previous: { label: "Previous period", color: "var(--text-4)", dashed: true } }
    : { value: { label, color } };
  const first = buckets[0];
  const last = buckets.at(-1);
  return (
    <div className="trend">
      <ChartContainer config={config} label={label} height={height} overlay={empty && <div className="chart-empty">Nothing in this period</div>}>
        <LineChart data={data} margin={{ top: 6, right: 0, bottom: 2, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="title" hide />
          <YAxis orientation="right" width={48} tickLine={false} axisLine={false} tickMargin={8} tickCount={4} allowDecimals={!whole} domain={[0, "auto"]} tickFormatter={(n: number) => (empty ? "" : format(n))} />
          <ChartTooltip
            cursor={{ stroke: "var(--text-4)", strokeDasharray: "3 3" }}
            isAnimationActive={false}
            content={<ChartTooltipContent labelKey="title" format={format} indicator="line" />}
          />
          {/* Nothing to draw: the empty note shows over bare gridlines rather than a colored zero line. */}
          {previous && !empty && <Line type="monotone" dataKey="previous" stroke="var(--color-previous)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} activeDot={false} {...CHART_MOTION} />}
          <Line
            hide={empty}
            type="monotone"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={false}
            activeDot={{ r: 4.5, fill: "var(--color-value)", stroke: "var(--surface)", strokeWidth: 2 }}
            {...CHART_MOTION}
          />
        </LineChart>
      </ChartContainer>
      {first && last && (
        <div className="trend-dates" aria-hidden>
          <span>{edgeDate(first.from, first.from.slice(0, 4) !== last.to.slice(0, 4))}</span>
          <span>{edgeDate(last.to, true)}</span>
        </div>
      )}
    </div>
  );
}

export interface Part { key: string; label: ReactNode; value: number; color: string; hint?: ReactNode }

/** How a total splits: one bar in parts, then a row per part with its amount. Negative parts (refunds) are listed but not drawn. */
export function Breakdown({ parts, format, empty = "Nothing in this period", label }: { parts: Part[]; format: (n: number) => string; empty?: string; label: string }) {
  const drawn = parts.filter((p) => p.value > 0);
  const total = drawn.reduce((s, p) => s + p.value, 0);
  if (!total && !parts.some((p) => p.value < 0)) return <p className="muted small" style={{ margin: 0 }}>{empty}</p>;
  return (
    <div className="breakdown">
      <div className="breakdown-bar" role="img" aria-label={`${label}: ${drawn.map((p) => `${typeof p.label === "string" ? p.label : p.key} ${format(p.value)}`).join(", ")}`}>
        {drawn.map((p) => <span key={p.key} title={`${typeof p.label === "string" ? p.label : p.key}: ${format(p.value)}`} style={{ flexGrow: p.value, background: p.color }} />)}
      </div>
      <ul className="breakdown-list">
        {parts.map((p) => (
          <li key={p.key}>
            <i style={{ background: p.color }} aria-hidden />
            <span className="ellipsis">{p.label}</span>
            {p.hint && <span className="muted">{p.hint}</span>}
            <strong className="tabular">{format(p.value)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HBars({ rows, format, empty = "Nothing in this period" }: { rows: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode; color?: string }>; format: (n: number) => string; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <p className="muted small" style={{ margin: 0 }}>{empty}</p>;
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      {rows.map((r, i) => (
        <div key={r.key} className="stack-sm" style={{ gap: 6 }}>
          <div className="row-between small"><span className="ellipsis" style={{ fontWeight: 600 }}>{r.label}</span><span className="tabular strong">{format(r.value)}{r.hint && <span className="muted" style={{ fontWeight: 500 }}> · {r.hint}</span>}</span></div>
          <div className="hbar"><span style={{ width: `${(r.value / max) * 100}%`, animationDelay: `${i * 40}ms`, ["--c" as string]: r.color }} /></div>
        </div>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
}

export function ReportTable<T>({ rows, columns, filename, initialSort, empty = "Nothing in this period", limit = 10, rowKey }: { rows: T[]; columns: Column<T>[]; filename: string; initialSort?: { key: string; desc: boolean }; empty?: string; limit?: number; rowKey: (row: T) => string }) {
  const [sort, setSort] = useState(initialSort ?? { key: columns[0]!.key, desc: false });
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sort.key) ?? columns[0]!;
    return [...rows].sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, columns, sort]);
  const shown = all ? sorted : sorted.slice(0, limit);
  const exportCsv = () =>
    downloadCsv(
      `${filename}.csv`,
      toCsv(sorted.map((r) => Object.fromEntries(columns.map((c) => [c.key, c.value(r)]))), columns.map((c) => ({ key: c.key, label: c.label }))),
    );
  return (
    <div className="stack-sm">
      {rows.length === 0 ? (
        <p className="muted small" style={{ margin: 0, padding: "4px 0" }}>{empty}</p>
      ) : (
        <div className="table-scroll" style={{ margin: "0 -20px" }}>
          <table className="table" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={`sortable${c.num ? " num" : ""}`} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined} onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : Boolean(c.num) })}>
                    {c.label}{sort.key === c.key && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={12} />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={rowKey(r)}>
                  {columns.map((c) => <td key={c.key} className={c.num ? "num" : undefined}>{c.render ? c.render(r) : c.value(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        {sorted.length > limit ? <Button size="sm" variant="ghost" icon={all ? "chevronUp" : "chevronDown"} onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${sorted.length}`}</Button> : <span />}
        {rows.length > 0 && <Button size="sm" variant="ghost" icon="download" onClick={exportCsv}>Download</Button>}
      </div>
    </div>
  );
}

/** Where a card's footer link goes: another screen, or a tab of this one. */
export type More = { label: string; to: string } | { label: string; onClick: () => void };

/**
 * A titled card. `info` explains the figure (shown on hover and to screen readers), `value` is its
 * headline number, and `footer`/`more` sit along the bottom edge so they line up across a row.
 */
export function ReportCard({ title, as: Heading = "h2", info, subtitle, value, action, footer, more, children, className }: { title: string; as?: "h2" | "h3"; info?: string; subtitle?: ReactNode; value?: ReactNode; action?: ReactNode; footer?: ReactNode; more?: More; children?: ReactNode; className?: string }) {
  return (
    <section className={`card report-card${className ? ` ${className}` : ""}`} aria-label={title}>
      <header className="report-card-head">
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <Heading className="report-card-title">
            {title}
            {info && <span className="info-tip" title={info} tabIndex={0} role="img" aria-label={info}><Icon name="info" size={14} /></span>}
          </Heading>
          {subtitle && <span className="muted small">{subtitle}</span>}
        </div>
        {action}
      </header>
      {value !== undefined && <div className="report-card-value">{value}</div>}
      {children}
      {(footer || more) && (
        <footer className="report-card-foot">
          <span>{footer}</span>
          {more && ("to" in more ? <Link to={more.to}>{more.label}</Link> : <button type="button" onClick={more.onClick}>{more.label}</button>)}
        </footer>
      )}
    </section>
  );
}

/** A row of figures in one card, divided by hairlines; wraps on narrow screens. */
export function KpiStrip({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="card kpi-strip" role="group" aria-label={label}>{children}</div>;
}

export function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={tone === "bad" ? { color: "var(--danger)" } : undefined}>{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: ReactNode; tone?: "good" | "bad" }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={tone === "bad" ? { color: "var(--danger)" } : undefined}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
