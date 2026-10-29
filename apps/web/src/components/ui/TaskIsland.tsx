/**
 * Background work, at the bottom center of the window (above the tab bar on a phone): a pill that
 * grows out of a dot when something starts (lib/tasks.ts), with a progress ring and what's going on.
 * Pressed, it lists everything running, each with Cancel. A finished task shows a check and its
 * message for a moment before the island goes; a failure turns it red until it's dismissed. In the
 * top layer, so it stays above open dialogs, and it tells the toasts how much room to leave
 * (--island-space).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cancelTask, dismissTask, taskFraction, useTasks, type Task } from "@/lib/tasks";
import { Icon } from "./Icon";
import { motion, play, topLayerProps, useSpace, useTopLayer } from "./topLayer";

/** A dot in the middle of the pill, then a circle as tall as it, then the whole pill. */
const DOT = "inset(calc(50% - 4px) calc(50% - 4px) round 999px)";
const ROUND = "inset(0 calc(50% - 20px) round 999px)";
const WHOLE = "inset(0 0 round 999px)";

export function TaskIsland() {
  const tasks = useTasks();
  const ref = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // In the top layer from the first task until its exit has played.
  const [shown, setShown] = useState(false);
  const visible = tasks.length > 0;
  // While it leaves it keeps showing what it last said.
  const last = useRef<Task[]>([]);
  if (visible) last.current = tasks;
  const list = visible ? tasks : last.current;

  useEffect(() => {
    if (visible) return setShown(true);
    setOpen(false);
    if (!shown) return;
    let current = true;
    void play(pill.current, [{ clipPath: WHOLE, opacity: 1 }, { clipPath: DOT, opacity: 0 }], { ...motion("exit"), fill: "forwards" }).then((done) => done && current && setShown(false));
    return () => {
      current = false;
    };
  }, [visible, shown]);
  useTopLayer(ref, shown);
  useSpace(ref, "--island-space", shown && visible);
  // Grows out of a dot once it's up; again if a task starts while it leaves.
  useLayoutEffect(() => {
    if (!visible || !shown) return;
    void play(pill.current, [{ clipPath: DOT, opacity: 0 }, { clipPath: ROUND, opacity: 1, offset: 0.35 }, { clipPath: WHOLE, opacity: 1 }], motion("slide"));
  }, [visible, shown]);

  // The list closes on a press anywhere else, and on Escape.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  // Closing the tab would end an upload halfway: the browser asks first.
  const running = tasks.some((t) => t.status === "running");
  useEffect(() => {
    if (!running) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [running]);

  const head = headline(list);
  const others = list.length - 1;
  const failedOthers = list.some((t) => t !== head && t.status === "failed");
  return (
    <div ref={ref} className="task-island" data-open={open || undefined} data-shown={shown || undefined} {...topLayerProps}>
      {head && (
        <div ref={pill} className="task-island-pill" data-status={head.status}>
          <button
            ref={main}
            type="button"
            className="task-island-main"
            aria-expanded={open}
            aria-controls={open ? "task-island-list" : undefined}
            aria-label={`${says(head)}${others ? `, and ${others} more` : ""}. Show background tasks`}
            onClick={() => setOpen(!open)}
          >
            <TaskMark task={head} />
            <span className="task-island-label">{says(head)}</span>
            {others > 0 && <span className="task-island-count" data-failed={failedOthers || undefined}>+{others}</span>}
          </button>
          {head.status === "failed" && (
            <button type="button" className="task-island-dismiss" aria-label="Dismiss" onClick={() => dismissTask(head.id)}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      )}
      {/* After the pill, so Tab goes on into it; drawn above the pill (order in components.css). */}
      {open && (
        <div className="task-island-list" id="task-island-list" role="group" aria-label="Background tasks">
          {list.map((task) => <TaskRow key={task.id} task={task} onCancel={() => main.current?.focus()} />)}
        </div>
      )}
      <span className="sr-only" role="status">{head && head.status !== "running" ? says(head) : ""}</span>
    </div>
  );
}

/** What the pill shows: one that just finished, then a failure waiting to be seen, then the oldest still running. */
function headline(list: Task[]): Task | undefined {
  return list.filter((t) => t.status === "done" || t.status === "stopped").at(-1) ?? list.find((t) => t.status === "failed") ?? list[0];
}

function says(task: Task): string {
  if (task.status === "running") return task.stopping ? "Stopping…" : task.label;
  return task.message ?? (task.status === "done" ? "Done" : task.status === "stopped" ? "Stopped" : "That didn't go through");
}

/** `onCancel`: Cancel turns into a disabled "Stopping…" (or the row goes), so focus moves to the pill rather than the page. */
function TaskRow({ task, onCancel }: { task: Task; onCancel: () => void }) {
  const fraction = taskFraction(task);
  const running = task.status === "running";
  const detail = running ? [task.detail, fraction !== undefined && `${Math.round(fraction * 100)}%`].filter(Boolean).join(" · ") : task.status === "failed" ? task.message : task.detail;
  return (
    <div className="task-row" data-status={task.status}>
      <TaskMark task={task} />
      <div className="task-row-body">
        <span className="task-row-label">{running || task.status === "failed" ? task.label : says(task)}</span>
        {detail && <span className="task-row-detail">{detail}</span>}
        {running && fraction !== undefined && (
          <span className="task-row-bar" aria-hidden="true"><span style={{ transform: `scaleX(${fraction})` }} /></span>
        )}
      </div>
      {running && task.cancel && (
        <button
          type="button"
          className="task-row-action"
          disabled={task.stopping}
          onClick={() => {
            onCancel();
            cancelTask(task.id);
          }}
        >
          {task.stopping ? "Stopping…" : "Cancel"}
        </button>
      )}
      {task.status === "failed" && <button type="button" className="task-row-action" onClick={() => dismissTask(task.id)}>Dismiss</button>}
    </div>
  );
}

/** A progress ring while it runs (spinning while there's no total yet), then a check, a stop or a cross. */
function TaskMark({ task }: { task: Task }) {
  if (task.status === "done") return <span className="task-mark" data-status="done"><Icon name="check" size={12} strokeWidth={2} /></span>;
  if (task.status === "stopped") return <span className="task-mark" data-status="stopped"><Icon name="minus" size={12} strokeWidth={2} /></span>;
  if (task.status === "failed") return <span className="task-mark" data-status="failed"><Icon name="x" size={12} strokeWidth={2} /></span>;
  const fraction = taskFraction(task);
  const circumference = 2 * Math.PI * 8;
  return (
    <svg className="task-ring" data-spinning={fraction === undefined || task.stopping || undefined} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="task-ring-track" cx="10" cy="10" r="8" />
      <circle className="task-ring-fill" cx="10" cy="10" r="8" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (fraction ?? 0.25))} />
    </svg>
  );
}
