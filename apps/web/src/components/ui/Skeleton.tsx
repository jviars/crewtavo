/**
 * Skeleton placeholders shaped like the content that's loading. They fade in after a short delay
 * (.skeleton-wrap), so fast loads never flash a placeholder, and after three seconds a caption says
 * it's taking longer than usual (.skeleton-slow, all CSS).
 */
import type { CSSProperties } from "react";

export function Skeleton({ width, height = 12, radius, circle, style }: { width?: number | string; height?: number | string; radius?: number; circle?: boolean; style?: CSSProperties }) {
  return <span className={circle ? "skeleton skeleton-circle" : "skeleton"} style={{ width: width ?? "100%", height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, lastWidth = "60%" }: { lines?: number; lastWidth?: string }) {
  return (
    <span style={{ display: "grid", gap: 8 }} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={i === lines - 1 && lines > 1 ? lastWidth : "100%"} />)}
    </span>
  );
}

/** Shown over the top of a skeleton that's still up after three seconds; out of the flow, so nothing moves. */
const SlowCaption = () => <span className="skeleton-slow" aria-hidden="true">Taking longer than usual…</span>;

/** Wrapper that announces loading to screen readers and delays the fade-in. */
export function Loading({ children, label = "Loading", className }: { children: React.ReactNode; label?: string; className?: string }) {
  return (
    <div className={className ? `skeleton-wrap ${className}` : "skeleton-wrap"} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}…</span>
      <SlowCaption />
      {children}
    </div>
  );
}

const widths = ["70%", "52%", "64%", "45%", "58%", "40%"];
const first = ["62%", "48%", "70%", "55%", "40%", "66%"];

/** Rows shaped like a list table. */
export function TableSkeleton({ rows = 6, columns = 4, header = true }: { rows?: number; columns?: number; header?: boolean }) {
  return (
    <Loading>
      <div className="card" style={{ overflow: "hidden" }}>
        {header && (
          <div style={{ display: "flex", gap: 24, padding: "12px 16px", borderBottom: "1px solid var(--divider)" }}>
            {Array.from({ length: columns }, (_, c) => <Skeleton key={c} width={c === 0 ? 80 : 56} height={10} />)}
          </div>
        )}
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} style={{ display: "flex", gap: 24, alignItems: "center", padding: "16px", borderTop: r ? "1px solid var(--row-divider)" : 0 }}>
            {Array.from({ length: columns }, (_, c) => (
              <span key={c} style={{ flex: c === 0 ? 2 : 1, display: "grid", gap: 6 }}>
                <Skeleton width={c === 0 ? first[r % first.length] : c === columns - 1 ? 84 : widths[(r + c) % widths.length]} height={c === columns - 1 ? 22 : 12} radius={c === columns - 1 ? 999 : undefined} />
                {c === 0 && <Skeleton width="40%" height={10} />}
              </span>
            ))}
          </div>
        ))}
      </div>
    </Loading>
  );
}

export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="stat-row" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card stat" style={{ display: "grid", gap: 10 }}>
          <Skeleton width="55%" height={10} />
          <Skeleton width="70%" height={22} />
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, title = true, height }: { lines?: number; title?: boolean; height?: number }) {
  return (
    <div className="card card-pad" style={{ display: "grid", gap: 14, minHeight: height }} aria-hidden="true">
      {title && <Skeleton width="40%" height={14} />}
      <SkeletonText lines={lines} />
    </div>
  );
}

/** Header + filter row + table: the shape of every list screen. */
export function ListPageSkeleton({ columns = 5, tabs = 4 }: { columns?: number; tabs?: number }) {
  return (
    <Loading>
      <div style={{ display: "grid", gap: 28 }}>
        <div className="row-between"><Skeleton width={180} height={34} /><Skeleton width={130} height={38} radius={8} /></div>
        <div className="row wrap">{Array.from({ length: tabs }, (_, i) => <Skeleton key={i} width={i ? 76 : 96} height={32} radius={999} />)}</div>
        <TableSkeleton columns={columns} />
      </div>
    </Loading>
  );
}

/** Back link, title, meta and a two-column body: the shape of every record screen. */
export function DetailSkeleton() {
  return (
    <Loading>
      <div style={{ display: "grid", gap: 28 }}>
        <Skeleton width={80} height={12} />
        <div className="row-between wrap"><Skeleton width="min(420px, 70%)" height={34} /><div className="row"><Skeleton width={96} height={38} radius={8} /><Skeleton width={120} height={38} radius={8} /></div></div>
        <div className="row"><Skeleton width={70} height={12} /><Skeleton width={110} height={22} radius={999} /><Skeleton width={140} height={12} /></div>
        <div className="two-col">
          <div className="wide stack-lg">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
          </div>
          <div className="narrow stack">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={2} />
          </div>
        </div>
      </div>
    </Loading>
  );
}

/** Sidebar + top bar outline while the session loads. */
export function ShellSkeleton() {
  return (
    <div className="shell skeleton-wrap" role="status" aria-busy="true">
      <span className="sr-only">Loading Crewtavo…</span>
      <aside className="sidebar" aria-hidden="true">
        <div className="row" style={{ margin: "0 0 14px 6px" }}><Skeleton width={34} height={34} radius={10} /><Skeleton width={100} height={14} /></div>
        {Array.from({ length: 11 }, (_, i) => (
          <div key={i} className="row" style={{ height: 38, padding: "0 12px", gap: 12 }}><Skeleton width={18} height={18} radius={5} /><Skeleton width={`${50 + ((i * 17) % 35)}%`} height={11} /></div>
        ))}
      </aside>
      <div className="main">
        <div className="topbar" aria-hidden="true"><div className="business"><Skeleton width={30} height={30} radius={8} /><Skeleton width={140} height={13} /></div></div>
        <div className="content" style={{ animation: "none", position: "relative" }}>
          <SlowCaption />
          <Skeleton width={160} height={14} />
          <Skeleton width={340} height={38} style={{ marginTop: -14 }} />
          <div className="card" style={{ height: 150 }} />
          <div className="two-col"><div className="wide card" style={{ height: 260 }} /><div className="narrow card" style={{ height: 260 }} /></div>
        </div>
      </div>
    </div>
  );
}
