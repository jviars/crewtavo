/**
 * Where a price sits on the range the homeowner said yes to: a bar from the low end to the high end
 * with a marker for the price, amber once it's above the range.
 */
import { formatMoney } from "@/lib/format";
import { rangePosition } from "./rows";
import styles from "./estimate.module.css";

export function RangeBar({ low, high, value }: { low: number; high: number; value: number | null }) {
  const position = value === null ? null : rangePosition(low, high, value);
  const range = `${formatMoney(low)} to ${formatMoney(high)}`;
  const label = !position
    ? `The range: ${range}`
    : position.where === "above"
      ? `${formatMoney(value)}, ${formatMoney(position.over)} above the range of ${range}`
      : position.where === "below"
        ? `${formatMoney(value)}, below the range of ${range}`
        : `${formatMoney(value)}, inside the range of ${range}`;
  return (
    <div className={styles.rangeBar} role="img" aria-label={label}>
      <div className={styles.track}>
        {position && <span className={styles.marker} data-where={position.where} style={{ left: `${(position.at * 100).toFixed(1)}%` }} />}
      </div>
      <div className={styles.ends} aria-hidden="true">
        <span>{formatMoney(low)}</span>
        <span>{formatMoney(high)}</span>
      </div>
    </div>
  );
}
