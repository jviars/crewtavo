import { toUnits } from "@crewtavo/core/money";
import { useEffect, useState } from "react";

/**
 * What was typed in a MoneyInput, read as written and rounded to cents, or for a percent to
 * 0.0001% (the precision tax rates are kept to, so 8.875 stays 8.875). Null when it isn't valid.
 */
export function readAmount(draft: string, { percent, max }: { percent?: boolean; max?: number } = {}): number | null {
  const n = Number(draft);
  if (draft.trim() === "" || !Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) return null;
  const decimals = percent ? 4 : 2;
  return Number(toUnits(draft, decimals)) / 10 ** decimals;
}

/**
 * Dollar or percent field that saves on blur or Enter and rejects bad values. `onEdit` hears each
 * keystroke, for a page's "Edited" save status (components/ui/SaveStatus), and
 * `onUnchanged` hears a blur that saves nothing (the same value, or one it turned down).
 */
export function MoneyInput({ value, onSave, onEdit, onUnchanged, percent, max, width = 120, label }: { value: number; onSave: (v: number) => void; onEdit?: () => void; onUnchanged?: () => void; percent?: boolean; max?: number; width?: number; label?: string }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const rounded = readAmount(draft, { percent, max });
    if (rounded === null) {
      setError(true);
      setDraft(String(value));
      setTimeout(() => setError(false), 1500);
      onUnchanged?.();
      return;
    }
    if (rounded !== value) onSave(rounded);
    else onUnchanged?.();
  };
  return (
    <span className="input-group" style={{ width }}>
      <span className={percent ? "addon addon-right" : "addon"}>{percent ? "%" : "$"}</span>
      <input
        className="input input-sm"
        style={{ textAlign: "right", paddingLeft: percent ? 10 : 22, paddingRight: percent ? 24 : 10 }}
        inputMode="decimal"
        value={draft}
        aria-label={label}
        aria-invalid={error || undefined}
        title={error ? (max !== undefined ? `Enter 0 to ${max}` : "Enter a number") : undefined}
        onChange={(e) => {
          setDraft(e.target.value.replace(/[^0-9.]/g, ""));
          onEdit?.();
        }}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </span>
  );
}
