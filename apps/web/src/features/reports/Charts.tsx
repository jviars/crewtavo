/** Report visuals: a bar chart over time (Recharts), a ranked bar list and a sortable table with CSV export. */
import { useMemo, useState, type ReactNode } from "react";
import { Bar, BarChart as RBarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/Button";
import { CHART_MOTION, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/Chart";
import { Icon } from "@/components/ui/Icon";
import { downloadCsv, toCsv } from "@/lib/csv";
import type { Bucket } from "./range";

export function BarChart({ buckets, values, format, label, color = "var(--green)" }: { buckets: Bucket[]; values: number[]; format: (n: number) => string; label: string; color?: string }) {
  const data = buckets.map((b, i) => ({ label: b.label, title: b.title, value: values[i] ?? 0 }));
  const empty = !values.some((v) => v > 0);
  return (
    <ChartContainer config={{ value: { label, color } }} label={label} height={232} overlay={empty && <div className="chart-empty">Nothing in this period</div>}>
      <RBarChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} barCategoryGap={buckets.length > 20 ? "14%" : "28%"}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={Math.ceil(buckets.length / 12) - 1} />
        <YAxis width={52} tickLine={false} axisLine={false} tickMargin={4} tickCount={3} tickFormatter={(n: number) => (empty ? "" : format(n))} />
        <ChartTooltip cursor={{ fill: "var(--fill-2)", radius: 4 }} animationDuration={150} animationEasing="ease-out" content={<ChartTooltipContent labelKey="title" format={format} hideIndicator />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={44} minPointSize={empty ? 0 : 2} {...CHART_MOTION} />
      </RBarChart>
    </ChartContainer>
  );
}

export function HBars({ rows, format, empty = "Nothing in this period" }: { rows: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode; color?: string }>; format: (n: number) => string; empty?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <p className="muted small" style={{ margin: 0 }}>{empty}</p>;
  return (
    <div className="stack-sm" style={{ gap: 12 }}>
      {rows.map((r, i) => (
        <div key={r.key} className="stack-sm" style={{ gap: 4 }}>
          <div className="row-between small"><span className="strong ellipsis">{r.label}</span><span className="num strong">{format(r.value)}{r.hint && <span className="muted" style={{ fontWeight: 500 }}> · {r.hint}</span>}</span></div>
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

export function ReportCard({ title, subtitle, action, children, className }: { title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card card-pad stack${className ? ` ${className}` : ""}`} style={{ gap: 14 }} aria-label={title}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <h2 className="section-title" style={{ fontSize: 16 }}>{title}</h2>
          {subtitle && <span className="muted small">{subtitle}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
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
