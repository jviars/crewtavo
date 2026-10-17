/**
 * Chart building blocks on Recharts, after shadcn/ui's ChartContainer and ChartTooltip but styled
 * with our tokens (see .chart in components.css). A config names each series and gives it a color;
 * the container exposes those as --color-<key> so marks can use fill="var(--color-value)".
 */
import { createContext, useContext, useId, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis, type TooltipContentProps } from "recharts";

export type ChartConfig = Record<string, { label: ReactNode; color: string; dashed?: boolean }>;

const ChartContext = createContext<ChartConfig>({});

/** Shared timing for chart marks: short, ease-out, and off when the person prefers less motion ("auto"). */
export const CHART_MOTION = { isAnimationActive: "auto", animationDuration: 250, animationEasing: "ease-out" } as const;

/** `label` describes the chart to screen readers; leave it out for a decorative chart, which is then hidden from them. */
export function ChartContainer({ config, label, height, className, overlay, children }: { config: ChartConfig; label?: string; height: number; className?: string; overlay?: ReactNode; children: ReactElement }) {
  const vars = Object.fromEntries(Object.entries(config).map(([key, c]) => [`--color-${key}`, c.color]));
  return (
    <ChartContext.Provider value={config}>
      <figure className={`chart${className ? ` ${className}` : ""}`} style={{ ...vars, height } as CSSProperties} aria-label={label} aria-hidden={label ? undefined : true}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 320, height }}>
          {children}
        </ResponsiveContainer>
        {overlay}
      </figure>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = Tooltip;

type TooltipContent = Partial<TooltipContentProps<number, string>> & {
  /** Formats each value. */
  format?: (n: number) => string;
  /** Field of the data row to use as the heading (for example a longer date). */
  labelKey?: string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
};

export function ChartTooltipContent({ active, payload, label, format = String, labelKey, hideLabel, hideIndicator }: TooltipContent) {
  const config = useContext(ChartContext);
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload as Record<string, unknown> | undefined;
  const heading = labelKey && row ? row[labelKey] : label;
  const many = payload.length > 1;
  return (
    <div className="chart-tooltip">
      {!hideLabel && heading != null && heading !== "" && <div className="chart-tooltip-label">{String(heading)}</div>}
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.name ?? "value");
        const series = config[key];
        if (item.value == null) return null;
        return (
          <div key={key} className="chart-tooltip-row">
            {!hideIndicator && <span className="chart-tooltip-dot" style={{ background: `var(--color-${key}, ${item.color ?? "currentColor"})` }} />}
            {many && <span className="chart-tooltip-name">{series?.label ?? item.name}</span>}
            <span className="chart-tooltip-value">{format(Number(item.value))}</span>
          </div>
        );
      })}
    </div>
  );
}

const FIT_DOMAIN = ["dataMin", "dataMax"] as const;
const FLAT_DOMAIN = [0, (max: number) => (max > 0 ? max * 1.6 : 1)] as const;

/**
 * A small trend line with a soft fill: no axes, a tooltip on hover. Each row carries a `label` for
 * the tooltip and one number per series in the config (missing values leave a gap). Decorative: the
 * figure it sits beside should state the value.
 */
export function Sparkline({ data, config, format, height = 40, className }: { data: Array<Record<string, string | number | null>>; config: ChartConfig; format: (n: number) => string; height?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const keys = Object.keys(config);
  const values = data.flatMap((row) => keys.map((k) => row[k])).filter((v): v is number => typeof v === "number");
  const flat = values.length > 0 && values.every((v) => v === values[0]);
  return (
    <ChartContainer config={config} height={height} className={`sparkline${className ? ` ${className}` : ""}`}>
      <AreaChart data={data} margin={{ top: 4, right: 3, bottom: 4, left: 3 }} accessibilityLayer={false}>
        <defs>
          {keys.map((k) => (
            <linearGradient key={k} id={`${id}-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={`var(--color-${k})`} stopOpacity={config[k]!.dashed ? 0 : 0.22} />
              <stop offset="100%" stopColor={`var(--color-${k})`} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {/* Scaled to its own range, except a flat series, which is drawn against zero so it doesn't read as a trend. */}
        <YAxis hide domain={flat ? FLAT_DOMAIN : FIT_DOMAIN} />
        <ChartTooltip cursor={{ stroke: "var(--border)" }} isAnimationActive={false} allowEscapeViewBox={{ x: false, y: true }} offset={12} content={<ChartTooltipContent format={format} labelKey="label" />} />
        {/* Comparison series first so the main line draws on top. */}
        {[...keys].reverse().map((k) => (
          <Area
            key={k}
            type="monotone"
            dataKey={k}
            stroke={`var(--color-${k})`}
            strokeWidth={config[k]!.dashed ? 1.5 : 2}
            strokeDasharray={config[k]!.dashed ? "3 3" : undefined}
            fill={`url(#${id}-${k})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: `var(--color-${k})` }}
            connectNulls={false}
            {...CHART_MOTION}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}
