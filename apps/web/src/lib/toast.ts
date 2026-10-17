/**
 * Toast notifications: brief feedback after an action ("Quote sent", "Couldn't save").
 * A tiny external store so any module (React Query handlers included) can raise one.
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

export interface ToastItem extends ToastOptions {
  id: number;
  kind: ToastKind;
  title: string;
  duration: number;
  leaving?: boolean;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getToasts = () => items;

export function dismissToast(id: number) {
  if (!items.some((t) => t.id === id && !t.leaving)) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 180);
}

function push(kind: ToastKind, title: string, options: ToastOptions = {}): number {
  // The same message twice within 2s (several failing requests at once) shows once.
  const key = `${kind}:${title}:${options.description ?? ""}`;
  const last = recent.get(key);
  if (last && Date.now() - last < 2000) return -1;
  recent.set(key, Date.now());

  const id = nextId++;
  const duration = options.duration ?? (options.action ? 6000 : kind === "error" ? 6000 : 3500);
  items = [...items.filter((t) => !t.leaving).slice(-3), { id, kind, title, ...options, duration }];
  emit();
  return id;
}

export const toast = {
  success: (title: string, options?: ToastOptions) => push("success", title, options),
  error: (title: string, options?: ToastOptions) => push("error", title, options),
  info: (title: string, options?: ToastOptions) => push("info", title, options),
  dismiss: dismissToast,
};
