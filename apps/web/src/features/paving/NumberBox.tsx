import { useState } from "react";
import { decimalPoint } from "@/lib/decimal";
import styles from "./paving.module.css";

/**
 * A number field that takes what's typed as it's typed ("1." stays on screen as 1) and shows an
 * empty box for 0, so a blank sheet reads as blank. A decimal comma is a point ("2,5" is 2.5) and a
 * comma before three digits a thousands separator ("1,250"), as lib/decimal reads them.
 */
export function NumberBox({ label, value, onChange, prefix, width = 92, small, big, invalid, autoFocus }: { label: string; value: number; onChange: (v: number) => void; prefix?: string; width?: number; small?: boolean; big?: boolean; invalid?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? String(Math.round(value * 1000) / 1000) : "");
  const box = (
    <input
      className={`input${small ? " input-sm" : ""}${big ? ` ${styles.big}` : ""}`}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      placeholder="0"
      value={shown}
      autoFocus={autoFocus}
      style={prefix ? undefined : { width }}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const typed = e.target.value.replace(/[^0-9.,]/g, "");
        setDraft(typed);
        onChange(Number(decimalPoint(typed).replace(/(\..*)\./g, "$1")) || 0);
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
