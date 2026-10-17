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
  if (!current) return null;
  const finish = (ok: boolean) => {
    current.resolve(ok);
    pending = null;
    setTyped("");
    emit();
  };
  const blocked = Boolean(current.typeToConfirm) && typed.trim().toLowerCase() !== current.typeToConfirm!.toLowerCase();
  return (
    <Dialog open onClose={() => finish(false)} title={current.title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) finish(true);
        }}
      >
        {current.body && <div className="muted" style={{ marginTop: -6 }}>{current.body}</div>}
        {current.typeToConfirm && (
          <label className="field">
            <span>Type <strong>{current.typeToConfirm}</strong> to confirm</span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
        )}
        <div className="form-actions">
          <Button onClick={() => finish(false)}>{current.cancelLabel ?? "Cancel"}</Button>
          <Button type="submit" variant={current.danger ? "danger-solid" : "primary"} disabled={blocked}>{current.confirmLabel ?? "Confirm"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
