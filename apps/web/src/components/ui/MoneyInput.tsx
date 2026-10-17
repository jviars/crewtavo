import { useEffect, useState } from "react";

/** Dollar or percent field that saves on blur or Enter and rejects bad values. */
export function MoneyInput({ value, onSave, percent, max, width = 120, label }: { value: number; onSave: (v: number) => void; percent?: boolean; max?: number; width?: number; label?: string }) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState(false);
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
      setError(true);
      setDraft(String(value));
      setTimeout(() => setError(false), 1500);
      return;
    }
    const rounded = Math.round(n * 100) / 100;
    if (rounded !== value) onSave(rounded);
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
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
    </span>
  );
}
