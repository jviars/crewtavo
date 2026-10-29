/**
 * Promise-based confirmation for destructive or irreversible actions:
 *   if (await confirm({ title: "Delete this quote?", danger: true })) remove.mutate();
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Ask the person to type this word to confirm (for deleting a lot of data). */
  typeToConfirm?: string;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirm(options: ConfirmOptions): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...options, resolve };
    emit();
  });
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
  const [typed, setTyped] = useState("");
  // The answered question stays on screen, closed, while the dialog animates out.
  const [shown, setShown] = useState(current);
  if (current && current !== shown) {
    setShown(current);
    setTyped("");
  }
  const view = current ?? shown;
  if (!view) return null;
  const finish = (ok: boolean) => {
    if (!current) return;
    current.resolve(ok);
    pending = null;
    emit();
  };
  const blocked = Boolean(view.typeToConfirm) && typed.trim().toLowerCase() !== view.typeToConfirm!.toLowerCase();
  return (
    <Dialog open={Boolean(current)} onClose={() => finish(false)} onExited={() => setShown(null)} title={view.title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) finish(true);
        }}
      >
        {view.body && <div className="muted" style={{ marginTop: -6 }}>{view.body}</div>}
        {view.typeToConfirm && (
          <label className="field">
            <span>Type <strong>{view.typeToConfirm}</strong> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="form-actions">
          <Button onClick={() => finish(false)}>{view.cancelLabel ?? "Cancel"}</Button>
          <Button type="submit" variant={view.danger ? "danger-solid" : "primary"} disabled={blocked}>{view.confirmLabel ?? "Confirm"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
