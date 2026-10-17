import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { dismissToast, getToasts, subscribeToasts, type ToastItem } from "@/lib/toast";
import { Icon } from "./Icon";

const supportsPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/**
 * Renders toasts in the browser's top layer (popover), so they appear above open dialogs.
 * Re-raised whenever a toast is added so it stacks above anything opened since.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  const ref = useRef<HTMLDivElement>(null);
  const count = toasts.length;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !supportsPopover) return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (count) el.showPopover();
    } catch {
      // Older browsers: the fallback attribute keeps it visible as a fixed element.
    }
  }, [count, toasts[count - 1]?.id]);

  return (
    <div
      ref={ref}
      className="toaster"
      popover={supportsPopover ? "manual" : undefined}
      data-fallback={supportsPopover ? undefined : ""}
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((t) => <Toast key={t.id} toast={t} />)}
    </div>
  );
}

function Toast({ toast }: { toast: ToastItem }) {
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const start = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => dismissToast(toast.id), toast.duration);
  };
  const stop = () => clearTimeout(timer.current);
  useEffect(() => {
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="toast" data-kind={toast.kind} data-leaving={toast.leaving || undefined} role={toast.kind === "error" ? "alert" : "status"} onMouseEnter={stop} onMouseLeave={start}>
      <span className="toast-icon"><Icon name={toast.kind === "success" ? "check" : toast.kind === "error" ? "x" : "info"} size={12} strokeWidth={3} /></span>
      <div className="toast-body">
        {toast.title}
        {toast.description && <div className="toast-desc">{toast.description}</div>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.onClick();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}><Icon name="x" size={14} /></button>
    </div>
  );
}
