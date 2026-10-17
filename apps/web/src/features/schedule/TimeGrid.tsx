/**
 * The schedule's time grid: hours down the side, one column per day (week) or per crew (day).
 * Visits sit at their time and length; side-by-side when they overlap, marked when a crew is
 * double-booked. Anytime visits sit in a row above the hours. Click an empty spot to book it,
 * drag a visit to move it, drag its bottom edge to change its length.
 */
import { localTime } from "@crewtavo/core/time";
import { useEffect, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { DragState } from "./useVisitDrag";

export interface GridVisit {
  id: string;
  title: string;
  kind: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  crew_id: string | null;
  hold_reason?: string | null;
}

export interface GridColumn {
  key: string;
  date: string;
  /** Set in the day view (one column per crew; "" = no crew). Dropping there assigns the crew. */
  crew?: string;
  label: ReactNode;
  today?: boolean;
  past?: boolean;
  color?: string | null;
  onHeaderClick?: () => void;
  headerExtra?: ReactNode;
}

export const PPM = 0.8; // pixels per minute: 48 px an hour
const MIN_HEIGHT = 22;

export const minutesOf = (iso: string, tz: string) => {
  const [h, m] = localTime(new Date(iso), tz).split(":").map(Number);
  return h * 60 + m;
};
export const lengthOf = (v: { starts_at: string | null; ends_at: string | null }) =>
  v.starts_at && v.ends_at ? Math.max(15, Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60000)) : 60;
export const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

interface Placed<V> {
  v: V;
  start: number;
  end: number;
  lane: number;
  lanes: number;
  conflict: boolean;
}

/** Side-by-side lanes for overlapping visits, and which ones double-book a crew. */
function place<V extends GridVisit>(visits: V[], tz: string): Placed<V>[] {
  const timed = visits
    .filter((v) => v.starts_at && v.status !== "cancelled")
    .map((v) => {
      const start = minutesOf(v.starts_at!, tz);
      return { v, start, end: Math.min(24 * 60, start + lengthOf(v)), lane: 0, lanes: 1, conflict: false };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: typeof timed = [];
  let clusterEnd = -1;
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
  };
  for (const p of timed) {
    if (p.start >= clusterEnd) close();
    const used = new Set(cluster.filter((o) => o.end > p.start).map((o) => o.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    p.lane = lane;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.end);
  }
  close();
  for (const a of timed) {
    a.conflict = Boolean(a.v.crew_id) && timed.some((b) => b !== a && b.v.crew_id === a.v.crew_id && b.start < a.end && a.start < b.end && b.v.status !== "completed");
  }
  return timed;
}

function useNowMinutes(tz: string) {
  const [now, setNow] = useState(() => minutesOf(new Date().toISOString(), tz));
  useEffect(() => {
    const t = setInterval(() => setNow(minutesOf(new Date().toISOString(), tz)), 60_000);
    return () => clearInterval(t);
  }, [tz]);
  return now;
}

export function TimeGrid<V extends GridVisit>({
  columns,
  visitsFor,
  tz,
  startMin,
  endMin,
  minColumn = 120,
  canDispatch,
  canMove,
  drag,
  startDrag,
  wasDragging,
  onOpen,
  onCreate,
  content,
  stale,
}: {
  columns: GridColumn[];
  visitsFor: (column: GridColumn) => V[];
  tz: string;
  startMin: number;
  endMin: number;
  minColumn?: number;
  canDispatch: boolean;
  /** Per visit, when only some can be changed (a crew lead's own crew). Defaults to all. */
  canMove?: (visit: V) => boolean;
  drag: DragState<V> | null;
  startDrag: (visit: V, mode: "move" | "resize") => (e: PointerEvent) => void;
  wasDragging: () => boolean;
  onOpen: (visit: V) => void;
  onCreate: (column: GridColumn, minutes: number | null) => void;
  /** The text inside a visit block. */
  content: (visit: V, size: "tiny" | "short" | "full") => ReactNode;
  stale?: boolean;
}) {
  const now = useNowMinutes(tz);
  const height = (endMin - startMin) * PPM;
  const hours = Array.from({ length: Math.ceil((endMin - startMin) / 60) }, (_, i) => startMin + i * 60);
  const style = { "--cols": columns.length, "--min-col": `${minColumn}px` } as CSSProperties;
  const draggable = (v: V) => canDispatch && (canMove?.(v) ?? true) && !["completed", "cancelled"].includes(v.status);
  const targets = (col: GridColumn, t: DragState<V>["target"]) =>
    t && "date" in t && t.date === col.date && (col.crew === undefined || !("crew" in t) || t.crew === col.crew);

  const createAt = (col: GridColumn) => (e: MouseEvent<HTMLDivElement>) => {
    if (!canDispatch || wasDragging() || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    onCreate(col, Math.max(0, Math.min(24 * 60 - 30, Math.floor((startMin + y / PPM) / 30) * 30)));
  };

  return (
    <div className={`tg-wrap${stale ? " is-stale" : ""}`}>
      <div className="tg" style={style} role="grid" aria-label="Schedule">
        <div className="tg-row tg-head" role="row">
          <div className="tg-gutter" />
          {columns.map((col) => (
            <div key={col.key} className="tg-colhead" role="columnheader" data-today={col.today || undefined} style={col.color ? ({ "--lane": col.color } as CSSProperties) : undefined}>
              {col.onHeaderClick ? <button type="button" className="link-btn" onClick={col.onHeaderClick}>{col.label}</button> : col.label}
              {col.headerExtra}
            </div>
          ))}
        </div>

        <div className="tg-row tg-anytime" role="row">
          <div className="tg-gutter tg-gutter-label" role="rowheader">Anytime</div>
          {columns.map((col) => {
            const items = visitsFor(col).filter((v) => !v.starts_at);
            const over = drag?.target?.type === "anytime" && targets(col, drag.target);
            return (
              <div key={col.key} className="tg-anycell" role="gridcell" data-drop="anytime" data-date={col.date} data-crew={col.crew} data-over={over || undefined} data-past={col.past || undefined}>
                {items.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className="tg-chip"
                    data-status={v.status}
                    data-kind={v.kind}
                    data-dragging={drag?.visit.id === v.id || undefined}
                    style={{ "--crew": (v as GridVisit & { crewColor?: string }).crewColor } as CSSProperties}
                    onPointerDown={draggable(v) ? startDrag(v, "move") : undefined}
                    onClick={() => !wasDragging() && onOpen(v)}
                  >
                    {content(v, "tiny")}
                  </button>
                ))}
                {canDispatch && !items.length && <button type="button" className="tg-anyadd" aria-label="Add an anytime visit" onClick={() => onCreate(col, null)}>+</button>}
              </div>
            );
          })}
        </div>

        <div className="tg-row tg-body" role="row">
          <div className="tg-gutter tg-hours" style={{ height }} aria-hidden="true">
            {hours.map((m) => <span key={m} style={{ top: (m - startMin) * PPM }}>{clock(m)}</span>)}
          </div>
          {columns.map((col) => {
            const placed = place(visitsFor(col), tz);
            const ghost = drag?.target?.type === "slot" && targets(col, drag.target) ? drag.target : null;
            return (
              <div
                key={col.key}
                className="tg-col"
                role="gridcell"
                data-drop="slot"
                data-date={col.date}
                data-crew={col.crew}
                data-start-min={startMin}
                data-ppm={PPM}
                data-today={col.today || undefined}
                data-past={col.past || undefined}
                data-can-create={canDispatch || undefined}
                style={{ height }}
                onClick={createAt(col)}
              >
                {placed.map(({ v, start, end, lane, lanes, conflict }) => {
                  const h = Math.max(MIN_HEIGHT, (end - start) * PPM - 2);
                  const size = h < 34 ? "tiny" : h < 60 ? "short" : "full";
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className="tg-event"
                      data-status={v.status}
                      data-kind={v.kind}
                      data-conflict={conflict || undefined}
                      data-dragging={drag?.visit.id === v.id || undefined}
                      title={conflict ? "This crew is booked for another visit at the same time" : undefined}
                      style={{
                        top: (start - startMin) * PPM + 1,
                        height: h,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                        "--crew": (v as GridVisit & { crewColor?: string }).crewColor,
                      } as CSSProperties}
                      onPointerDown={draggable(v) ? startDrag(v, "move") : undefined}
                      onClick={() => !wasDragging() && onOpen(v)}
                    >
                      {content(v, size)}
                      {draggable(v) && <span className="tg-resize" aria-hidden="true" onPointerDown={startDrag(v, "resize")} />}
                    </button>
                  );
                })}
                {ghost && drag && (
                  <div className="tg-ghost" style={{ top: (ghost.minutes - startMin) * PPM + 1, height: Math.max(MIN_HEIGHT, drag.duration * PPM - 2) }}>
                    {clock(ghost.minutes)} – {clock(ghost.minutes + drag.duration)}
                  </div>
                )}
                {col.today && now >= startMin && now <= endMin && <div className="tg-now" style={{ top: (now - startMin) * PPM }} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
