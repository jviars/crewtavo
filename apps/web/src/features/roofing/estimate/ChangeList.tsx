/**
 * What changed since the range, one line each: "+ Chimney flashing, 1 chimney · $650",
 * "− Valley flashing · −$304". The salesperson sees it before signing; the office sees it after.
 */
import type { LineChange } from "@crewtavo/core/estimates";
import type { ReactNode } from "react";
import { changeLabel, signedMoney } from "./rows";
import styles from "./estimate.module.css";

const SPOKEN: Record<LineChange["kind"], string> = { added: "Added", changed: "Changed", removed: "Taken off" };

export function ChangeList({ changes, empty, detail, size = "regular" }: {
  changes: readonly LineChange[];
  /** What to show when nothing changed (nothing by default). */
  empty?: ReactNode;
  /** A line under a change, like "Added by Mike · 1 photo". */
  detail?: (change: LineChange) => ReactNode;
  size?: "regular" | "large";
}) {
  if (!changes.length) return empty ? <>{empty}</> : null;
  return (
    <ul className={styles.changes} data-size={size}>
      {changes.map((c) => {
        const more = c.amount >= 0;
        const sub = detail?.(c);
        return (
          <li key={`${c.kind}:${c.id}`} className={styles.change}>
            <span className={styles.changeWhat}>
              <span className={styles.sign} data-sign={more ? "plus" : "minus"} aria-hidden="true">{more ? "+" : "−"}</span>
              <span className={styles.changeText}>
                <span><span className="sr-only">{SPOKEN[c.kind]}: </span>{changeLabel(c)}</span>
                {sub && <span className={styles.changeDetail}>{sub}</span>}
              </span>
            </span>
            <span className={styles.changeAmount}>{signedMoney(c.amount)}</span>
          </li>
        );
      })}
    </ul>
  );
}
