/**
 * Home: visitors to the business's website this week against last week, for people with Marketing
 * (Website Analytics). Two weeks with no visitors at all are the figure alone: a chart of two flat
 * lines says nothing.
 */
import { addDays } from "@crewtavo/core/time";
import { Link } from "react-router-dom";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { Section } from "@/components/ui/Section";
import { formatNumber, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { shortDate } from "../finance/range";
import { periodTotals, useWebStats } from "../marketing/website";
import { ChangeLine } from "./ChangeLine";
import styles from "./Home.module.css";

const WHOLE = (n: number) => formatNumber(n);

export function WebsiteSection() {
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
  const anyone = series.some((d) => d.now > 0 || d.before > 0);
  return (
    <Section title="Website visitors" count="This week" action={<Link to="/marketing?tab=website">Marketing</Link>}>
      <div className={styles.panel}>
        <div className={styles.figure}><AnimatedNumber value={now.visitors} className={styles.big} /></div>
        <ChangeLine now={now.visitors} before={before.visitors} compared="the 7 days before" same="Same as last week" vs="last week" />
        {anyone && (
          <div className={styles.spark}>
            <LazySparkline
              data={series}
              height={56}
              format={WHOLE}
              config={{ now: { label: "This week", color: "var(--green)" }, before: { label: "Week before", color: "var(--text-4)", dashed: true } }}
            />
            <div className="spark-legend" aria-hidden="true"><span><i />This week</span><span><i className="dashed" />Week before</span></div>
          </div>
        )}
        <dl className={styles.lines}>
          <div><dt>Booking requests from your website</dt><dd>{formatNumber(now.requests)}</dd></div>
        </dl>
      </div>
    </Section>
  );
}
