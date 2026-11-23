/**
 * Skeleton placeholders shaped like the content that's loading. They fade in after a short delay
 * (.skeleton-wrap), so fast loads never flash a placeholder, and after three seconds a caption says
 * it's taking longer than usual (.skeleton-slow, all CSS).
 */
import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";

export function Skeleton({ width, height = 12, radius, circle, style, className }: { width?: number | string; height?: number | string; radius?: number; circle?: boolean; style?: CSSProperties; className?: string }) {
  return <span className={["skeleton", circle && "skeleton-circle", className].filter(Boolean).join(" ")} style={{ width: width ?? "100%", height, borderRadius: radius, ...style }} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, lastWidth = "60%" }: { lines?: number; lastWidth?: string }) {
  return (
    <span style={{ display: "grid", gap: 8 }} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} width={i === lines - 1 && lines > 1 ? lastWidth : "100%"} />)}
    </span>
  );
}

/** Shown over the top of a skeleton that's still up after three seconds; out of the flow, so nothing moves. */
const SlowCaption = () => <span className="skeleton-slow" aria-hidden="true">{t("Taking longer than usual…")}</span>;

/** Wrapper that announces loading to screen readers and delays the fade-in. */
export function Loading({ children, label = t("Loading"), className }: { children: React.ReactNode; label?: string; className?: string }) {
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
const names = ["32%", "26%", "38%", "29%", "24%", "35%"];
const subjects = ["50%", "58%", "44%", "55%", "47%", "52%"];

/** Rows shaped like a list table. */
export function TableSkeleton({ rows = 6, columns = 4, header = true }: { rows?: number; columns?: number; header?: boolean }) {
  return (
    <Loading>
      <div>
        {header && (
          <div style={{ display: "flex", gap: 24, padding: "10px 4px", borderBottom: "1px solid var(--divider)" }}>
            {Array.from({ length: columns }, (_, c) => <Skeleton key={c} width={c === 0 ? 80 : 56} height={10} />)}
          </div>
        )}
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} style={{ display: "flex", gap: 24, alignItems: "center", padding: "14px 4px", borderBottom: "1px solid var(--row-divider)" }}>
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

/** A stats strip's shape (StatStrip.tsx): figures between hairlines. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="strip" data-count={count} aria-hidden="true">
      <div className="strip-grid">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="strip-item" style={{ gap: 8 }}>
            <Skeleton width="55%" height={10} />
            <Skeleton width="70%" height={22} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A section's shape (Section.tsx): a heading on a hairline and a few lines under it. */
export function CardSkeleton({ lines = 3, title = true, height }: { lines?: number; title?: boolean; height?: number }) {
  return (
    <div className="sec" style={{ minHeight: height }} aria-hidden="true">
      {title && <div className="sec-head"><Skeleton width="34%" height={13} /></div>}
      <div className="sec-body"><SkeletonText lines={lines} /></div>
    </div>
  );
}

/** A section of facts: a heading, then label and value rows on hairlines. */
export function SectionSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="sec" aria-hidden="true">
      <div className="sec-head"><Skeleton width="34%" height={13} /></div>
      <div className="sec-body">
        <div className="facts">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="fact" style={{ alignItems: "center" }}>
              <Skeleton width="70%" height={10} />
              <Skeleton width={widths[i % widths.length]} height={10} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Inbox rows (InboxList.tsx): a group heading, then an avatar, two lines and a figure on the right. */
export function InboxSkeleton({ rows = 6, groups = 1 }: { rows?: number; groups?: number }) {
  const each = Math.max(1, Math.ceil(rows / groups));
  return (
    <div className="il" aria-hidden="true">
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className="il-group">
          <div className="il-head"><Skeleton width={g ? 72 : 116} height={10} /></div>
          <div className="il-rows">
            {Array.from({ length: each }, (_, r) => (
              <div key={r} className="il-row il-row-skeleton">
                <span className="skeleton skeleton-circle il-avatar" />
                <span className="il-body">
                  <Skeleton width={names[(r + g) % names.length]} height={12} />
                  <Skeleton width={subjects[(r + g * 2) % subjects.length]} height={11} />
                  <Skeleton width="24%" height={9} />
                </span>
                <span className="il-aside"><Skeleton width={36} height={11} /></span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A list page converted to inbox rows: the title and its button, the filters and search, then rows. */
export function InboxPageSkeleton({ rows = 7, tabs = 4, groups = 1 }: { rows?: number; tabs?: number; groups?: number }) {
  return (
    <Loading>
      <div className="stack-lg">
        <div className="row-between"><Skeleton width={150} height={28} /><Skeleton width={124} height={36} radius={8} className="hide-mobile" /></div>
        <div className="row-between"><Skeleton width={`min(${tabs * 92}px, 100%)`} height={36} radius={10} /><Skeleton width={240} height={32} radius={8} className="hide-mobile" /></div>
        <InboxSkeleton rows={rows} groups={groups} />
      </div>
    </Loading>
  );
}

/** Header + filter row + table: the shape of a list screen that is still a table. */
export function ListPageSkeleton({ columns = 5, tabs = 4 }: { columns?: number; tabs?: number }) {
  return (
    <Loading>
      <div className="stack-lg">
        <div className="row-between"><Skeleton width={150} height={28} /><Skeleton width={124} height={36} radius={8} className="hide-mobile" /></div>
        <Skeleton width={`min(${tabs * 92}px, 100%)`} height={36} radius={10} />
        <TableSkeleton columns={columns} />
      </div>
    </Loading>
  );
}

/** Crumb, title, meta and a main and a side column of sections: the shape of every record screen (DetailPage.tsx). */
export function DetailSkeleton() {
  return (
    <Loading>
      <div className="stack-lg">
        <div style={{ display: "grid", gap: 10 }}>
          <Skeleton width={64} height={11} />
          <div className="row-between wrap"><Skeleton width="min(380px, 70%)" height={28} /><div className="row hide-mobile"><Skeleton width={110} height={36} radius={8} /><Skeleton width={36} height={36} radius={8} /></div></div>
          <div className="row"><Skeleton width={64} height={11} /><Skeleton width={110} height={11} /><Skeleton width={140} height={11} /></div>
        </div>
        <div className="detail-cols">
          <div className="detail-main">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={3} />
          </div>
          <div className="detail-side">
            <SectionSkeleton rows={5} />
            <SectionSkeleton rows={2} />
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
      <span className="sr-only">{t("Loading Crewtavo…")}</span>
      <aside className="sidebar" aria-hidden="true">
        <div className="row" style={{ margin: "0 0 14px 6px" }}><Skeleton width={34} height={34} radius={8} /><Skeleton width={100} height={14} /></div>
        {Array.from({ length: 11 }, (_, i) => (
          <div key={i} className="row" style={{ height: 38, padding: "0 12px", gap: 12 }}><Skeleton width={18} height={18} radius={4} /><Skeleton width={`${50 + ((i * 17) % 35)}%`} height={11} /></div>
        ))}
      </aside>
      <div className="main">
        <div className="topbar" aria-hidden="true"><div className="business"><Skeleton width={30} height={30} radius={8} /><Skeleton width={140} height={13} /></div></div>
        <div className="content" style={{ animation: "none", position: "relative" }}>
          <SlowCaption />
          <Skeleton width={160} height={14} />
          <Skeleton width={340} height={38} style={{ marginTop: -14 }} />
          <StatsSkeleton count={4} />
          <div className="detail-cols"><div className="detail-main"><InboxSkeleton rows={4} /></div><div className="detail-side"><SectionSkeleton rows={4} /></div></div>
        </div>
      </div>
    </div>
  );
}
