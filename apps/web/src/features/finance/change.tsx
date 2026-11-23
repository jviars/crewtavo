/**
 * The change from the period before in colored words: "+3%" in green, "−12%" in red, "Same as last
 * month" quiet when it rounds to nothing, and nothing at all without an earlier figure to compare
 * with. Its own module so Home and Invoices can show it without loading the chart library (Charts.tsx).
 */
import { formatNumber } from "@/lib/format";

/** The change in whole percent, or a multiple from ten times up ("24×"); null without an earlier figure. */
function changeText(now: number, before: number): { change: number; text: string } | null {
  if (!before) return null;
  const change = Math.round(((now - before) / Math.abs(before)) * 100);
  const text = change >= 900 ? `${formatNumber(Math.round(now / before))}×` : `${change > 0 ? "+" : change < 0 ? "−" : ""}${formatNumber(Math.abs(change))}%`;
  return { change, text };
}

/**
 * `compared` names the period before ("last month", "30 days ago") for the hover and screen readers,
 * and `same` is what an unchanged figure says. `better` is "down" for figures that should shrink
 * (what's past due), so a drop shows green.
 */
export function Change({ now, before, compared = "the previous period", same, better = "up" }: { now: number; before: number; compared?: string; same?: string; better?: "up" | "down" }) {
  const c = changeText(now, before);
  if (!c) return null;
  if (c.change === 0) return <span className="chip" title={`Compared with ${compared}`}>{same ?? `Same as ${compared}`}</span>;
  const up = c.change > 0;
  return (
    <span className={`chip tabular ${up === (better === "up") ? "chip-green" : "chip-red"}`} title={`Compared with ${compared}`}>
      <span className="sr-only">{up ? "Up " : "Down "}</span>
      <span aria-hidden="true">{c.text}</span>
      <span className="sr-only">{c.text.replace(/^[+−]/, "")} from {compared}</span>
    </span>
  );
}

/** The same change for a StatStrip figure's `delta`: { text: "+8%", tone: "good" }, or nothing to compare. */
export function changeDelta(now: number, before: number, better: "up" | "down" = "up", after?: string): { text: string; tone?: "good" | "danger"; after?: string } | undefined {
  const c = changeText(now, before);
  if (!c || c.change === 0) return undefined;
  return { text: c.text, tone: c.change > 0 === (better === "up") ? "good" : "danger", after };
}
