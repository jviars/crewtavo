/**
 * Finance and Metrics visuals (Page-Finance.dc.html, Page-Metrics.dc.html): a quiet trend line over
 * the period (Recharts) with only a baseline and a few gridlines, the change from the period before,
 * a total split in parts, a ranked bar list, rows of figures, a section to hold them and a sortable
 * table with CSV export. All flat on hairlines; on a phone each section is an inset card
 * (.m-grouped). Marketing's Website section and Subcontractors' reports use them too.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { cx } from "@/components/ui/Button";
import { CHART_MOTION, ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/Chart";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { downloadCsv, toCsv } from "@/lib/csv";
import styles from "./Finance.module.css";
import { shortDate, type Bucket } from "./range";

export { Change, changeDelta } from "./change";

/** The dates under a chart: four, evenly spaced, the first and last at its edges ("Nov 1 … Nov 21"). */
export function axisDates(buckets: Bucket[], count = 4): Array<{ at: number; label: string }> {
  const n = buckets.length;
  if (!n) return [];
  // Month buckets are keyed by their month (range.ts bucketsFor), whatever their label: "Sept" in the UK.
  const months = n > 1 && /^\d{4}-\d{2}$/.test(buckets[0]!.key);
  const spansYears = buckets[0]!.from.slice(0, 4) !== buckets[n - 1]!.to.slice(0, 4);
  const word = (b: Bucket, last: boolean) => {
    if (months) return spansYears && (last || b === buckets[0]) ? `${b.label} ${(last ? b.to : b.from).slice(0, 4)}` : b.label;
    return shortDate(last ? b.to : b.from);
  };
  if (n === 1) return [{ at: 0, label: word(buckets[0]!, true) }];
  const picks = [...new Set(Array.from({ length: Math.min(count, n) }, (_, i) => Math.round((i * (n - 1)) / (Math.min(count, n) - 1))))];
  return picks.map((i) => ({ at: i / (n - 1), label: word(buckets[i]!, i === n - 1) }));
}

/**
 * A line over the period's buckets with the dates under it. `previous` draws the period before as a
 * dashed quiet line for comparison; `area` fills softly under this period's line. No value axis: the
 * figure beside the chart states the total, and the tooltip each point's value in full.
 */
export function TrendChart({ buckets, values, previous, format, label, color = "var(--green)", height = 150, area = false }: { buckets: Bucket[]; values: number[]; previous?: number[]; format: (n: number) => string; label: string; color?: string; height?: number; area?: boolean }) {
  const data = buckets.map((b, i) => ({ title: b.title, value: values[i] ?? 0, previous: previous?.[i] ?? null }));
  const empty = !values.some((v) => v !== 0) && !previous?.some((v) => v !== 0);
  const config: ChartConfig = previous
    ? { value: { label: "This period", color }, previous: { label: "Previous period", color: "var(--quiet)", dashed: true } }
    : { value: { label, color } };
  return (
    <div className={styles.trend}>
      <ChartContainer config={config} label={label} height={height} overlay={empty && <div className="chart-empty">Nothing in this period</div>}>
        <AreaChart data={data} margin={{ top: 6, right: 2, bottom: 1, left: 2 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="title" hide />
          <YAxis hide tickCount={4} domain={[0, "auto"]} />
          <ChartTooltip cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }} isAnimationActive={false} content={<ChartTooltipContent labelKey="title" format={format} indicator="line" />} />
          {/* Nothing to draw: the empty note shows over bare gridlines rather than a colored zero line. */}
          {previous && !empty && <Area type="monotone" dataKey="previous" stroke="var(--color-previous)" strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} activeDot={false} {...CHART_MOTION} />}
          <Area
            hide={empty}
            type="monotone"
            dataKey="value"
            stroke="var(--color-value)"
            strokeWidth={2.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill={area ? "var(--color-value)" : "none"}
            fillOpacity={area ? 0.1 : 0}
            dot={false}
            activeDot={{ r: 4, fill: "var(--color-value)", stroke: "var(--page)", strokeWidth: 2 }}
            {...CHART_MOTION}
          />
        </AreaChart>
      </ChartContainer>
      <div className={styles.axis} aria-hidden="true">
        {axisDates(buckets).map((d) => <span key={d.at} style={{ left: `${d.at * 100}%` }}>{d.label}</span>)}
      </div>
    </div>
  );
}

export interface Part { key: string; label: ReactNode; value: number; color: string; hint?: ReactNode }

/** How a total splits: one thin bar in parts, then a row per part with its amount. Negative parts (refunds) are listed but not drawn. */
export function Breakdown({ parts, format, empty = "Nothing in this period", label }: { parts: Part[]; format: (n: number) => string; empty?: string; label: string }) {
  const drawn = parts.filter((p) => p.value > 0);
  const total = drawn.reduce((s, p) => s + p.value, 0);
  if (!total && !parts.some((p) => p.value < 0)) return <EmptyState inline title={empty} />;
  const name = (p: Part) => (typeof p.label === "string" ? p.label : p.key);
  return (
    <div className={styles.split}>
      <div className={styles.splitBar} role="img" aria-label={`${label}: ${drawn.map((p) => `${name(p)} ${format(p.value)}`).join(", ")}`}>
        {drawn.map((p) => <span key={p.key} title={`${name(p)}: ${format(p.value)}`} style={{ flexGrow: p.value, background: p.color }} />)}
      </div>
      <ul className={cx("rel", styles.legend)}>
        {parts.map((p) => (
          <li key={p.key} className={styles.legendRow}>
            <i className={styles.swatch} style={{ background: p.color }} aria-hidden="true" />
            <span className={styles.legendLabel}>{p.label}</span>
            {p.hint && <span className={styles.legendNote}>{p.hint}</span>}
            <span className={styles.legendValue}>{format(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A ranked list of bars: the label, a bar as long as its share of the largest, and the figure. `quiet` dims a row ("No reason given"). */
export function HBars({ rows, format, empty = "Nothing in this period", color }: { rows: Array<{ key: string; label: ReactNode; value: number; hint?: ReactNode; color?: string; quiet?: boolean }>; format: (n: number) => string; empty?: string; color?: string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length || max === 0) return <EmptyState inline title={empty} />;
  return (
    <ul className={cx("rel", styles.bars)}>
      {rows.map((r, i) => (
        <li key={r.key} className={styles.bar} data-quiet={r.quiet || undefined}>
          <span className={styles.barLabel}>{r.label}</span>
          <span className={styles.barTrack} aria-hidden="true">
            <span className={styles.barFill} style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? color, animationDelay: `${i * 30}ms` }} />
          </span>
          <span className={styles.barValue}>{format(r.value)}{r.hint && <span> · {r.hint}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

/** A label, a quiet note and a figure on a hairline: Unpaid invoices by age, Time to get paid. `tone` colors a figure someone must act on. */
export interface LineRow { key: string; label: ReactNode; note?: ReactNode; value: ReactNode; tone?: "warning" | "danger"; none?: boolean }
export function Lines({ rows, label }: { rows: LineRow[]; label?: string }) {
  return (
    <ul className={cx("rel", styles.lines)} aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={styles.line} data-none={r.none || undefined}>
          <span className={styles.lineLabel}>{r.label}</span>
          {r.note && <span className={styles.lineNote}>{r.note}</span>}
          <span className={styles.lineValue} data-tone={r.none ? undefined : r.tone}>{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Column<T> {
  key: string;
  label: string;
  num?: boolean;
  value: (row: T) => string | number | null;
  render?: (row: T) => ReactNode;
}

/**
 * A table of figures to compare across columns: quiet heads that sort, hairline rows, and under it
 * "Show all" past `limit` and Download (CSV). On a phone each row reads as a list row: the first
 * column, the last on the right after its name, the others in a quiet line under them, with a Sort menu.
 */
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
  if (rows.length === 0) return <EmptyState inline title={empty} />;
  const shown = all ? sorted : sorted.slice(0, limit);
  const sortBy = (c: Column<T>) => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : Boolean(c.num) });
  const current = columns.find((c) => c.key === sort.key) ?? columns[0]!;
  const exportCsv = () =>
    downloadCsv(
      `${filename}.csv`,
      toCsv(sorted.map((r) => Object.fromEntries(columns.map((c) => [c.key, c.value(r)]))), columns.map((c) => ({ key: c.key, label: c.label }))),
    );
  const last = columns.length - 1;
  return (
    <>
      <div className={cx("rel", styles.rt)}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col" className={c.num ? styles.num : undefined} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
                  <button type="button" className={styles.sort} onClick={() => sortBy(c)}>
                    {c.label}
                    {sort.key === c.key && <Icon name={sort.desc ? "chevronDown" : "chevronUp"} size={12} />}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={rowKey(r)}>
                {/* The last column's name rides with its figure on a phone ("Booked 0%"), as the middle ones do in the quiet line. */}
                {columns.map((c, i) => (
                  <td key={c.key} className={cx(c.num && styles.num, i > 0 && i < last && styles.mid, i > 0 && i === last && styles.end)} data-label={i > 0 ? c.label : undefined}>
                    {c.render ? c.render(r) : c.value(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={cx("rel", styles.foot)}>
        {sorted.length > limit && (
          <button type="button" className={styles.footBtn} onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </button>
        )}
        <span className={styles.footEnd}>
          <Menu
            items={columns.map((c) => ({ label: c.label, checked: c.key === current.key, end: c.key === current.key ? (sort.desc ? "High to low" : "Low to high") : undefined, onSelect: () => sortBy(c) }))}
            label={`Sort by ${current.label}`}
            title="Sort by"
            triggerClassName={cx(styles.footBtn, styles.phoneOnly)}
            trigger={<><Icon name="sort" size={15} />Sort</>}
          />
          <button type="button" className={styles.footBtn} onClick={exportCsv}><Icon name="download" size={14} />Download</button>
        </span>
      </div>
    </>
  );
}

/** Where a section's link goes: another screen, or a tab of this one. */
export type More = { label: string; to: string } | { label: string; onClick: () => void };

const moreLink = (more: More) => ("to" in more ? <Link to={more.to}>{more.label}</Link> : <button type="button" onClick={more.onClick}>{more.label}</button>);

/**
 * A small quiet (i) after a heading that explains its figure on hover. It stays out of the heading's
 * name: ReportCard gives a screen reader the same words right after the heading.
 */
export function InfoTip({ text }: { text: string }) {
  return <span className={styles.info} title={text} aria-hidden="true"><Icon name="info" size={13} /></span>;
}

/**
 * A titled part of a report (a Section): the heading on a hairline with a quiet figure after it
 * (`count`, or `value` when it's plain words), one quiet link on the right (`more`, or your own
 * `action`), a quiet line under it (`subtitle`), the content, and a quiet line at the end (`footer`).
 * `info` explains the figure: an (i) to hover after the heading, and words a screen reader reads after
 * it. They sit in the heading's row, not the body, so the body's first rows still meet the hairline.
 */
export function ReportCard({ title, as = "h2", info, subtitle, value, count, action, footer, more, children, className }: { title: string; as?: "h2" | "h3"; info?: string; subtitle?: ReactNode; value?: ReactNode; count?: string | number; action?: ReactNode; footer?: ReactNode; more?: More; children?: ReactNode; className?: string }) {
  const plainValue = typeof value === "string" || typeof value === "number";
  return (
    <Section
      title={info ? <>{title}<InfoTip text={info} /></> : title}
      count={count ?? (plainValue ? (value as string | number) : undefined)}
      level={as === "h3" ? 3 : 2}
      className={className}
      action={(action || more || info) && <>{info && <span className="sr-only">{info}</span>}{action}{more && moreLink(more)}</>}
    >
      {subtitle && <p className={styles.sub}>{subtitle}</p>}
      {value !== undefined && !plainValue && <div className={styles.value}>{value}</div>}
      {children}
      {footer && <p className={styles.sub}>{footer}</p>}
    </Section>
  );
}

/** Re-exported for screens that lay sections out with the report's columns. */
export const reportStyles = styles;
