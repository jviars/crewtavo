/**
 * The schedule's time grid: hours down the side, one column per day (week) or per crew (day).
 * Visits sit at their time and length, tinted in their crew's color; side-by-side when they overlap,
 * marked when a crew is double-booked. A block shows only the rows its height has room for
 * (fitBlock). Anytime visits sit in a row above the hours. Click an empty spot to book it,
 * drag a visit to move it, drag its bottom edge to change its length. Events from other calendars
 * (Zoho, Outlook, Google...) sit among the visits, hatched in their calendar's color; they can be
 * opened but not moved.
 */
import { localTime } from "@crewtavo/core/time";
import { useEffect, useState, type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
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

/** An event from another calendar, as the grid shows it. */
export interface GridExternal {
  id: string;
  title: string;
  /** Timed events that fit in the day; others go in the Anytime row. */
  starts_at: string | null;
  ends_at: string | null;
  color: string | null;
  busy: boolean;
  calendar: string;
  /** The crew whose calendar it is, when its busy time should mark that crew double-booked. */
  crew_id: string | null;
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
/** On phones the hours are twice as tall, so a short visit still has room for its time and name. */
const PHONE_PPM = 1.6;
const PHONE = "(max-width: 700px)";
const MIN_HEIGHT = 22;

/** The height of each row in a visit block, in pixels: the line heights in features.css. */
const ROW = { line: 15, time: 13, people: 20 };
/** A block's border and padding above and below its rows. */
const BLOCK_PAD = 6;

export interface BlockFit {
  time: boolean;
  /** How many lines the title gets: whole lines only, so none shows cut through its letters. */
  title: number;
  /** The people on a row of their own (with first names), at the end of the title's line, or left out. */
  people: "row" | "inline" | false;
  hold: boolean;
  client: boolean;
}

/**
 * What a visit block of this height has room for, most important first: the title's first line,
 * the time, the people, a weather hold, the client, then more of the title. A row that doesn't fit
 * is left out rather than shown cut off, and the time always has its row to itself.
 */
export function fitBlock(height: number, has: { time?: boolean; people?: boolean; hold?: boolean; client?: boolean }): BlockFit {
  let room = height - BLOCK_PAD - ROW.line;
  const take = (wanted: boolean | undefined, px: number) => {
    if (!wanted || room < px) return false;
    room -= px;
    return true;
  };
  const time = take(has.time, ROW.time);
  const people = take(has.people, ROW.people) ? "row" : take(has.people, ROW.people - ROW.line) ? "inline" : false;
  const hold = take(has.hold, ROW.line);
  const client = take(has.client, ROW.line);
  // Faces at the end of the title's line keep it to one line.
  return { time, title: people === "inline" ? 1 : 1 + Math.min(2, Math.floor(room / ROW.line)), people, hold, client };
}

/** Pixels per minute for this screen, following it when the phone turns or the window resizes. */
export function useGridScale() {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const changed = () => setPhone(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return phone ? PHONE_PPM : PPM;
}

export const minutesOf = (iso: string, tz: string) => {
  const [h, m] = localTime(new Date(iso), tz).split(":").map(Number);
  return h * 60 + m;
};
/** A visit's length in minutes, any length (a 10-minute stop stays 10 minutes when it's moved). */
export const lengthOf = (v: { starts_at: string | null; ends_at: string | null }) =>
  v.starts_at && v.ends_at ? Math.max(1, Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60000)) : 60;
export const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * "1:30 – 2:30 PM", the way Google Calendar writes a time range. A narrow block drops the end and
 * shows "1:30 PM" instead (features.css), so its time is never cut off.
 */
export function TimeRange({ start, end }: { start: string; end?: string | null }) {
  const [, time = start, meridiem = ""] = /^(.*?)(\s*[AP]M)$/.exec(start) ?? [];
  const shared = Boolean(end && meridiem && end.endsWith(meridiem.trim()));
  return (
    <>
      {time}
      <span className={shared ? "tg-ampm" : undefined}>{meridiem}</span>
      {end && <span className="tg-end"> – {end}</span>}
    </>
  );
}

interface Placed<V> {
  v: V;
  start: number;
  end: number;
  lane: number;
  lanes: number;
  conflict: false | "visit" | "calendar";
}

/** A grid item: a visit, or another calendar's event dressed as one for placing. */
type Item<V> = V | (GridVisit & { ext: GridExternal });
const isExternal = <V,>(item: Item<V>): item is GridVisit & { ext: GridExternal } => typeof item === "object" && item !== null && "ext" in item;

/** Side-by-side lanes for overlapping visits, and which ones double-book a crew (with a visit or its own calendar). */
export function place<V extends GridVisit>(visits: Item<V>[], tz: string): Placed<Item<V>>[] {
  const timed = visits
    .filter((v) => v.starts_at && v.status !== "cancelled")
    .map((v) => {
      const start = minutesOf(v.starts_at!, tz);
      return { v, start, end: Math.min(24 * 60, start + lengthOf(v)), lane: 0, lanes: 1, conflict: false as Placed<V>["conflict"] };
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
  // Both visits of a double booking are marked. Work that's done or called off can't clash.
  const open = (p: (typeof timed)[number]) => p.v.status !== "completed" && p.v.status !== "cancelled";
  for (const a of timed) {
    if (!a.v.crew_id || isExternal(a.v) || !open(a)) continue;
    const clash = timed.filter((b) => b !== a && open(b) && b.v.crew_id === a.v.crew_id && b.start < a.end && a.start < b.end);
    a.conflict = clash.some((b) => !isExternal(b.v)) ? "visit" : clash.length ? "calendar" : false;
  }
  return timed;
}

const asItem = (e: GridExternal): GridVisit & { ext: GridExternal } => ({ id: `ext-${e.id}`, title: e.title, kind: "external", status: "scheduled", starts_at: e.starts_at, ends_at: e.ends_at, crew_id: e.crew_id, ext: e });

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
  ppm = PPM,
  canDispatch,
  canMove,
  drag,
  startDrag,
  wasDragging,
  onOpen,
  onCreate,
  content,
  stale,
  selected,
  externalFor,
  onOpenExternal,
}: {
  columns: GridColumn[];
  visitsFor: (column: GridColumn) => V[];
  /** Other calendars' events in a column: timed ones are placed, the rest go in the Anytime row. */
  externalFor?: (column: GridColumn) => GridExternal[];
  onOpenExternal?: (event: GridExternal) => void;
  tz: string;
  startMin: number;
  endMin: number;
  minColumn?: number;
  /** Pixels per minute (useGridScale). */
  ppm?: number;
  canDispatch: boolean;
  /** Per visit, when only some can be changed (a crew lead's own crew). Defaults to all. */
  canMove?: (visit: V) => boolean;
  drag: DragState<V> | null;
  startDrag: (visit: V, mode: "move" | "resize") => (e: PointerEvent) => void;
  wasDragging: () => boolean;
  onOpen: (visit: V) => void;
  onCreate: (column: GridColumn, minutes: number | null) => void;
  /** The text inside a visit: a block's, for its height in pixels (fitBlock), or an Anytime chip's one line. */
  content: (visit: V, height?: number) => ReactNode;
  stale?: boolean;
  /** The visit open in a dialog, drawn a little stronger so it's easy to find again. */
  selected?: string | null;
}) {
  const now = useNowMinutes(tz);
  const height = (endMin - startMin) * ppm;
  const hours = Array.from({ length: Math.ceil((endMin - startMin) / 60) }, (_, i) => startMin + i * 60);
  const style = { "--cols": columns.length, "--min-col": `${minColumn}px`, "--hour": `${60 * ppm}px` } as CSSProperties;
  const draggable = (v: V) => canDispatch && (canMove?.(v) ?? true) && !["completed", "cancelled"].includes(v.status);
  const targets = (col: GridColumn, t: DragState<V>["target"]) =>
    t && "date" in t && t.date === col.date && (col.crew === undefined || !("crew" in t) || t.crew === col.crew);

  const createAt = (col: GridColumn) => (e: MouseEvent<HTMLDivElement>) => {
    if (!canDispatch || wasDragging() || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    onCreate(col, Math.max(0, Math.min(24 * 60 - 30, Math.floor((startMin + y / ppm) / 30) * 30)));
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
            const allDay = (externalFor?.(col) ?? []).filter((e) => !e.starts_at);
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
                    data-selected={selected === v.id || undefined}
                    style={{ "--crew": (v as GridVisit & { crewColor?: string }).crewColor } as CSSProperties}
                    onPointerDown={draggable(v) ? startDrag(v, "move") : undefined}
                    onClick={() => !wasDragging() && onOpen(v)}
                  >
                    {content(v)}
                  </button>
                ))}
                {allDay.map((e) => (
                  <button key={e.id} type="button" className="tg-chip" data-external data-free={!e.busy || undefined} style={{ "--cal": e.color ?? undefined } as CSSProperties} title={`${e.title} · ${e.calendar}`} onClick={() => onOpenExternal?.(e)}>
                    {e.title}
                  </button>
                ))}
                {canDispatch && !items.length && <button type="button" className="tg-anyadd" aria-label="Add an anytime visit" onClick={() => onCreate(col, null)}>+</button>}
              </div>
            );
          })}
        </div>

        <div className="tg-row tg-body" role="row">
          <div className="tg-gutter tg-hours" style={{ height }} aria-hidden="true">
            {hours.map((m) => <span key={m} style={{ top: (m - startMin) * ppm }}>{clock(m)}</span>)}
          </div>
          {columns.map((col) => {
            const timedExternal = (externalFor?.(col) ?? []).filter((e) => e.starts_at).map(asItem);
            const placed = place<V>([...visitsFor(col), ...timedExternal], tz);
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
                data-ppm={ppm}
                data-today={col.today || undefined}
                data-past={col.past || undefined}
                data-can-create={canDispatch || undefined}
                style={{ height }}
                onClick={createAt(col)}
              >
                {placed.map(({ v: item, start, end, lane, lanes, conflict }) => {
                  const h = Math.max(MIN_HEIGHT, (end - start) * ppm - 2);
                  const box = { top: (start - startMin) * ppm + 1, height: h, left: `calc(${(lane / lanes) * 100}% + 2px)`, width: `calc(${100 / lanes}% - 4px)` };
                  if (isExternal(item)) {
                    const e = item.ext;
                    const fit = fitBlock(h, { time: true, client: true });
                    return (
                      <button key={item.id} type="button" className="tg-event tg-ext" data-free={!e.busy || undefined} title={`${e.title} · ${e.calendar}`} style={{ ...box, "--cal": e.color ?? undefined } as CSSProperties} onClick={() => onOpenExternal?.(e)}>
                        {fit.time && <span className="tg-t"><TimeRange start={clock(start)} end={clock(end)} /></span>}
                        <span className="tg-n" style={{ WebkitLineClamp: fit.title }}>{e.title}</span>
                        {fit.client && <span className="tg-m"><Icon name="calendar" size={12} /> {e.calendar}</span>}
                      </button>
                    );
                  }
                  const v = item as V;
                  return (
                    <button
                      key={v.id}
                      type="button"
                      className="tg-event"
                      data-status={v.status}
                      data-kind={v.kind}
                      data-conflict={conflict || undefined}
                      data-dragging={drag?.visit.id === v.id || undefined}
                      data-selected={selected === v.id || undefined}
                      title={conflict === "visit" ? "This crew is booked for another visit at the same time" : conflict === "calendar" ? "This crew's calendar shows them busy at this time" : undefined}
                      style={{ ...box, "--crew": (v as GridVisit & { crewColor?: string }).crewColor } as CSSProperties}
                      onPointerDown={draggable(v) ? startDrag(v, "move") : undefined}
                      onClick={() => !wasDragging() && onOpen(v)}
                    >
                      {content(v, h)}
                      {draggable(v) && <span className="tg-resize" aria-hidden="true" onPointerDown={startDrag(v, "resize")} />}
                    </button>
                  );
                })}
                {ghost && drag && (
                  <div className="tg-ghost" style={{ top: (ghost.minutes - startMin) * ppm + 1, height: Math.max(MIN_HEIGHT, drag.duration * ppm - 2) }}>
                    <TimeRange start={clock(ghost.minutes)} end={clock(ghost.minutes + drag.duration)} />
                  </div>
                )}
                {col.today && now >= startMin && now <= endMin && <div className="tg-now" style={{ top: (now - startMin) * ppm }} aria-hidden="true" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
