/**
 * Marketing → Reviews: Google reviews per month over the last 12, loaded with the chart library only
 * when there are reviews to chart (GoogleReviews.tsx). Only the counts go in TrendChart: it draws a
 * missing value as 0 from an axis that starts at 0, which would show a month with no reviews as a
 * 0-star dip and squash 4.6 against 4.9. The monthly average is a quiet line of figures under it,
 * for the months that had reviews: a month with none is left out, never shown as 0.
 */
import { reviewTrend, type ReviewMonth } from "@crewtavo/core/reviews";
import { TrendChart } from "../finance/Charts";
import styles from "./Presence.module.css";

export function ReviewTrend({ months, timeZone }: { months: ReviewMonth[]; timeZone: string }) {
  const trend = reviewTrend(months, new Date(), timeZone);
  const buckets = trend.map((m) => {
    const [year, month] = m.month.split("-").map(Number) as [number, number];
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { key: m.month, label: m.label, title: m.title, from: `${m.month}-01`, to: last };
  });
  const rated = trend.filter((m) => m.average !== null);
  return (
    <div className={styles.trend}>
      <TrendChart buckets={buckets} values={trend.map((m) => m.count)} format={(n) => `${n} ${n === 1 ? "review" : "reviews"}`} label="Google reviews each month" height={120} />
      {rated.length > 0 && (
        <dl className={styles.averages} aria-label="Average stars each month">
          {rated.map((m) => (
            <div key={m.month}>
              <dt>{m.label}</dt>
              <dd>{m.average!.toFixed(1)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
