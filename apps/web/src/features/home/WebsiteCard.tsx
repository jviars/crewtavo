/** Home: visitors to the business's website this week against last week, for people with Marketing (Website Analytics). */
import { addDays } from "@crewtavo/core/time";
import { Link } from "react-router-dom";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { formatNumber, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Change } from "../finance/change";
import { shortDate } from "../finance/range";
import { periodTotals, useWebStats } from "../marketing/website";

const WHOLE = (n: number) => formatNumber(n);

export function WebsiteCard() {
  const { company } = useSession();
  const today = todayIn(company.timezone);
  const week = { from: addDays(today, -6), to: today, days: 7 };
  const stats = useWebStats(week);
  if (!stats.data) return null;
  const { now, before } = periodTotals(stats.data.days, week);
  const byDay = new Map(stats.data.days.map((d) => [d.day, d.visitors]));
  const series = Array.from({ length: 7 }, (_, i) => {
    const day = addDays(week.from, i);
    return { label: shortDate(day), now: byDay.get(day) ?? 0, before: byDay.get(addDays(day, -7)) ?? 0 };
  });
  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <span className="muted small strong">Website visitors this week</span>
        <Link to="/marketing?tab=website" className="small strong">Marketing</Link>
      </div>
      <div className="row" style={{ alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <AnimatedNumber value={now.visitors} className="hero-number" />
        <Change now={now.visitors} before={before.visitors} compared="the 7 days before" same="Same as last week" />
      </div>
      <div className="stack-sm" style={{ gap: 4, margin: "2px 0 6px" }}>
        <LazySparkline
          data={series}
          height={56}
          format={WHOLE}
          config={{ now: { label: "This week", color: "var(--green)" }, before: { label: "Week before", color: "var(--text-4)", dashed: true } }}
        />
        <div className="spark-legend" aria-hidden="true"><span><i />This week</span><span><i className="dashed" />Week before</span></div>
      </div>
      <div className="row-between small muted"><span>Booking requests from your website</span><strong className="ink">{formatNumber(now.requests)}</strong></div>
    </div>
  );
}
