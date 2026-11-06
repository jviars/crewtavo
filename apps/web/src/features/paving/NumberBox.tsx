import { useState } from "react";

/**
 * A number field that takes what's typed as it's typed ("1." stays on screen as 1) and shows an
 * empty box for 0, so a blank sheet reads as blank.
 */
export function NumberBox({ label, value, onChange, prefix, width = 92, small, big, invalid, autoFocus }: { label: string; value: number; onChange: (v: number) => void; prefix?: string; width?: number; small?: boolean; big?: boolean; invalid?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(Math.round(value * 1000) / 1000) : "");
  const box = (
    <input
      className={`input${small ? " input-sm" : ""}${big ? " calc-big" : ""}`}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      placeholder="0"
      value={shown}
      autoFocus={autoFocus}
      style={prefix ? undefined : { width }}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const typed = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
        setDraft(typed);
        onChange(Number(typed) || 0);
      }}
      onBlur={() => setDraft(null)}
    />
  );
  return prefix ? (
    <span className="input-group" style={{ width }}>
      <span className="addon">{prefix}</span>
      {box}
    </span>
  ) : (
    box
  );
}
