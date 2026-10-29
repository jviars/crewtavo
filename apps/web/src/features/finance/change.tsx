/**
 * The change from the period before as a small chip: "↑ 3%" in green, "↓ 12%" in red, "Same as last
 * month" when it rounds to nothing, and nothing at all without an earlier figure to compare with. Its
 * own module so Home and Invoices can show it without loading the chart library (Charts.tsx).
 */
import { formatNumber } from "@/lib/format";

/**
 * `compared` names the period before ("last month", "30 days ago") for the hover and screen readers,
 * and `same` is what an unchanged figure says. `better` is "down" for figures that should shrink
 * (what's past due), so a drop shows green.
 */
export function Change({ now, before, compared = "the previous period", same, better = "up" }: { now: number; before: number; compared?: string; same?: string; better?: "up" | "down" }) {
  if (!before) return null;
  const change = Math.round(((now - before) / Math.abs(before)) * 100);
  if (change === 0) return <span className="chip" title={`Compared with ${compared}`}>{same ?? `Same as ${compared}`}</span>;
  const up = change > 0;
  // Ten times or more reads better as a multiple: "24×", not "2,300%".
  const text = change >= 900 ? `${formatNumber(Math.round(now / before))}×` : `${formatNumber(Math.abs(change))}%`;
  return (
    <span className={`chip tabular ${up === (better === "up") ? "chip-green" : "chip-red"}`} title={`Compared with ${compared}`}>
      <span aria-hidden="true">{up ? "↑" : "↓"}</span>
      <span className="sr-only">{up ? "Up" : "Down"}</span>
      {text}
      <span className="sr-only"> from {compared}</span>
    </span>
  );
}
