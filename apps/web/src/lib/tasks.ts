/**
 * Work that carries on in the background: a plan set uploading, a spreadsheet of clients importing.
 * A tiny external store like lib/toast.ts, so the work can report from anywhere and outlive the
 * screen that started it; components/ui/TaskIsland.tsx shows it. A finished task shows its message
 * for a moment and goes; a failed one stays until it's dismissed.
 */
import { useSyncExternalStore } from "react";

export type TaskStatus = "running" | "done" | "stopped" | "failed";

export interface TaskOptions {
  label: string;
  /** A second line: the file, or "2 of 3". */
  detail?: string;
  /** How much there is to do, in any unit (bytes, rows); left out while it isn't known yet. */
  total?: number;
  /** Offers Cancel. The work stops as soon as it can and then calls done (it shows as stopped) or dismiss. */
  cancel?: () => void;
}

export interface Task {
  id: number;
  label: string;
  detail?: string;
  loaded: number;
  total?: number;
  status: TaskStatus;
  /** Cancel was pressed and the work is winding down (an import finishing its current batch). */
  stopping?: boolean;
  /** Said once it's over: "File added", or what went wrong. */
  message?: string;
  cancel?: () => void;
}

export interface TaskHandle {
  id: number;
  progress(loaded: number, total?: number): void;
  rename(label: string, detail?: string): void;
  /** Finished: a check and the message for a moment, then it goes. After Cancel it shows as stopped. */
  done(message?: string): void;
  /** Failed: it turns red and stays until it's dismissed. */
  fail(message: string): void;
  /** Gone at once without a word: stopped by the person on the screen that started it, say. */
  dismiss(): void;
}

/** How long a finished task stays up with its message. */
const SHOW_DONE = 1600;

let tasks: Task[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeTasks(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getTasks = () => tasks;

/** Every task still up, oldest first: running, just finished, or failed and not yet dismissed. */
export const useTasks = () => useSyncExternalStore(subscribeTasks, getTasks);

function change(id: number, patch: Partial<Task>) {
  const current = tasks.find((t) => t.id === id);
  // Over already: what the work says after that (a late progress event) changes nothing.
  if (!current || current.status !== "running") return;
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch } : t));
  emit();
}

export function dismissTask(id: number) {
  if (!tasks.some((t) => t.id === id)) return;
  tasks = tasks.filter((t) => t.id !== id);
  emit();
}

/** Cancel on the island (or the screen's own Stop): asks the work to stop. */
export function cancelTask(id: number) {
  const task = tasks.find((t) => t.id === id);
  if (!task?.cancel || task.status !== "running" || task.stopping) return;
  change(id, { stopping: true });
  task.cancel();
}

export function startTask({ label, detail, total, cancel }: TaskOptions): TaskHandle {
  const id = nextId++;
  tasks = [...tasks, { id, label, detail, total, cancel, loaded: 0, status: "running" }];
  emit();
  const finish = (status: TaskStatus, message?: string) => {
    change(id, { status, message, cancel: undefined });
    if (status !== "failed") setTimeout(() => dismissTask(id), SHOW_DONE);
  };
  return {
    id,
    progress: (loaded, total) => change(id, total === undefined ? { loaded } : { loaded, total }),
    rename: (label, detail) => change(id, detail === undefined ? { label } : { label, detail }),
    done: (message) => finish(tasks.find((t) => t.id === id)?.stopping ? "stopped" : "done", message),
    fail: (message) => finish("failed", message),
    dismiss: () => dismissTask(id),
  };
}

/** How far along, 0 to 1, or undefined while the total isn't known. */
export const taskFraction = (task: Pick<Task, "loaded" | "total">) => (task.total ? Math.min(1, Math.max(0, task.loaded / task.total)) : undefined);
