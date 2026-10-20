/**
 * Dragging visits on the schedule with pointer events, so it works with a mouse, a pen and a finger
 * (on touch screens a short press starts the drag, so a normal swipe still scrolls).
 *
 * Drop targets are plain elements marked with data attributes:
 *   data-drop="slot"        a time column: data-date, data-crew (optional), data-start-min, data-ppm
 *   data-drop="anytime"     the "anytime" row of a column: data-date, data-crew (optional)
 *   data-drop="day"         a month cell: data-date (the visit keeps its time of day)
 *   data-drop="unscheduled" the unscheduled list
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type DropTarget =
  | { type: "slot"; date: string; crew?: string; minutes: number }
  | { type: "anytime"; date: string; crew?: string }
  | { type: "day"; date: string }
  | { type: "unscheduled" };

export interface DragState<V> {
  visit: V;
  mode: "move" | "resize";
  target: DropTarget | null;
  /** Length in minutes (changes while resizing). */
  duration: number;
}

const TOUCH_DELAY = 320;

/** `step`: minutes a dropped visit snaps to (Settings → Schedule: 5 by default, like Google Calendar's app). */
function readTarget(x: number, y: number, offsetMin: number, duration: number, mode: "move" | "resize", startMin: number | null, step: number): { target: DropTarget; duration: number } | null {
  const snap = (m: number) => Math.round(m / step) * step;
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  if (!el) return null;
  const { drop, date = "", crew } = el.dataset;
  if (drop === "unscheduled") return mode === "move" ? { target: { type: "unscheduled" }, duration } : null;
  if (drop === "day") return mode === "move" ? { target: { type: "day", date }, duration } : null;
  if (drop === "anytime") return mode === "move" ? { target: { type: "anytime", date, crew }, duration } : null;
  if (drop !== "slot") return null;
  const rect = el.getBoundingClientRect();
  const top = Number(el.dataset.startMin ?? 0);
  const ppm = Number(el.dataset.ppm ?? 1);
  const at = top + (y - rect.top) / ppm;
  if (mode === "resize" && startMin !== null) {
    const length = Math.max(step, snap(at) - startMin);
    return { target: { type: "slot", date, crew, minutes: startMin }, duration: Math.min(length, 24 * 60 - startMin) };
  }
  const minutes = Math.max(0, Math.min(24 * 60 - Math.min(duration, 24 * 60), snap(at - offsetMin)));
  return { target: { type: "slot", date, crew, minutes }, duration };
}

export function useVisitDrag<V extends { id: string }>({
  enabled,
  step = 5,
  timing,
  onDrop,
}: {
  enabled: boolean;
  /** Minutes a drop snaps to. */
  step?: number;
  /** The visit's start (minutes after midnight, local) and length, or null start for anytime. */
  timing: (visit: V) => { start: number | null; duration: number };
  onDrop: (visit: V, target: DropTarget, duration: number) => void;
}) {
  const [drag, setDrag] = useState<DragState<V> | null>(null);
  const justDragged = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  const latest = useRef({ timing, onDrop, step });
  latest.current = { timing, onDrop, step };

  useEffect(() => () => cleanup.current?.(), []);

  const start = useCallback(
    (visit: V, mode: "move" | "resize") => (e: ReactPointerEvent) => {
      if (!enabled || (e.pointerType === "mouse" && e.button !== 0)) return;
      if (mode === "resize") e.stopPropagation();
      cleanup.current?.();
      const { start: startMin, duration: initial } = latest.current.timing(visit);
      const x0 = e.clientX;
      const y0 = e.clientY;
      const touch = e.pointerType === "touch";
      // Where on the card it was grabbed, so the card doesn't jump under the pointer.
      let offsetMin = 0;
      if (mode === "move" && startMin !== null) {
        const col = (e.target as HTMLElement).closest<HTMLElement>("[data-drop='slot']");
        if (col) {
          const at = Number(col.dataset.startMin ?? 0) + (y0 - col.getBoundingClientRect().top) / Number(col.dataset.ppm ?? 1);
          offsetMin = Math.max(0, Math.min(initial, at - startMin));
        }
      }
      let active = false;
      let current: { target: DropTarget; duration: number } | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const activate = () => {
        active = true;
        document.body.classList.add("is-dragging-visit");
        if (touch) navigator.vibrate?.(8);
        setDrag({ visit, mode, target: null, duration: initial });
      };
      const update = (x: number, y: number) => {
        const next = readTarget(x, y, offsetMin, initial, mode, startMin, latest.current.step);
        if (JSON.stringify(next) === JSON.stringify(current)) return;
        current = next;
        setDrag({ visit, mode, target: next?.target ?? null, duration: next?.duration ?? initial });
      };
      const onMove = (ev: PointerEvent) => {
        if (!active) {
          const moved = Math.hypot(ev.clientX - x0, ev.clientY - y0);
          if (touch) {
            if (moved > 8) finish(false); // a swipe: let the page scroll
            return;
          }
          if (moved < 4) return;
          activate();
        }
        update(ev.clientX, ev.clientY);
        // Scroll the page when dragging near its top or bottom edge.
        if (ev.clientY < 70) window.scrollBy(0, -12);
        else if (ev.clientY > window.innerHeight - 50) window.scrollBy(0, 12);
      };
      const onTouchMove = (ev: TouchEvent) => {
        if (active) ev.preventDefault();
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && finish(false);

      function finish(commit: boolean) {
        clearTimeout(timer);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("touchmove", onTouchMove);
        window.removeEventListener("keydown", onKey);
        document.body.classList.remove("is-dragging-visit");
        cleanup.current = null;
        if (!active) return;
        justDragged.current = true;
        setTimeout(() => (justDragged.current = false), 80);
        setDrag(null);
        if (commit && current) latest.current.onDrop(visit, current.target, current.duration);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("touchmove", onTouchMove, { passive: false });
      window.addEventListener("keydown", onKey);
      if (touch) timer = setTimeout(activate, TOUCH_DELAY);
      cleanup.current = () => finish(false);
    },
    [enabled],
  );

  /** For click handlers: true right after a drag, so dropping doesn't also open the visit. */
  const wasDragging = useCallback(() => justDragged.current, []);

  return { drag, start, wasDragging };
}
