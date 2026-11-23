/**
 * Marketing → Website: visits to the business's website (Apps → Crewtavo - Website Analytics) over
 * a date range, laid out like Finance: the figure against the period before with its trend, then
 * the pages people read, where they came from, campaigns and devices, each with the booking
 * requests it brought in. Owners and office staff with Marketing.
 *
 * As Page-Finance.dc.html's overview: the figure picked in a segmented control, large with its
 * change and the period before, its chart, and the four totals beside it on hairlines; then the
 * breakdowns as sections. On a phone the figure and its chart are an inset card on the grouped screen.
 */
import { CHANNEL_LABELS, DEVICE_LABELS, type Channel, type Device } from "@crewtavo/core/analytics";
import { previousRange } from "@crewtavo/core/reports";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Breakdown, Change, ReportCard, ReportTable, TrendChart } from "../finance/Charts";
import { bucketize, bucketizeShifted, bucketsFor, shortDate } from "../finance/range";
import { pct, plural, RangePicker, rangeWords, TabBody, useRangeParams } from "../finance/shared";
import styles from "./Presence.module.css";
import { periodTotals, useWebStats, type Figure } from "./website";

/** `short` names it in the segmented control, where four have to fit a phone. */
const FIGURES: Record<Figure, { label: string; short: string; chart: string }> = {
  visitors: { label: "Visitors", short: "Visitors", chart: "Visitors each day" },
  pageviews: { label: "Page views", short: "Views", chart: "Page views each day" },
  visits: { label: "Visits", short: "Visits", chart: "Visits each day" },
  requests: { label: "Booking requests", short: "Requests", chart: "Booking requests from your website each day" },
};

export const CHANNEL_COLORS: Record<Channel, string> = {
  search: "var(--green)",
  social: "var(--invoice)",
  directory: "var(--quote)",
  ads: "#d9a43b",
  ai: "var(--chat-purple)",
  email: "#2a9d8f",
  campaign: "#d97a3b",
  referral: "#9c6b4e",
  direct: "var(--text-4)",
};
const DEVICE_COLORS: Record<Device, string> = { phone: "var(--green)", tablet: "var(--req)", computer: "var(--invoice)" };

const count = (n: number) => formatNumber(n);

export function WebsiteSection() {
  const { company } = useSession();
  const state = useRangeParams();
  const { range, today } = state;
  const stats = useWebStats(range);
  const [figure, setFigure] = useState<Figure>("visitors");
  const buckets = bucketsFor(range);
  const prev = previousRange(range);
  const tz = company.timezone;

  return (
    <div className={cx("m-grouped", styles.tab)}>
      <div className={styles.rangeRow}>
        <span className={styles.rangeWords}>{rangeWords(range, today)}</span>
        <RangePicker state={state} />
      </div>
      <TabBody query={stats}>
        {(d) => {
          const totals = periodTotals(d.days, range);
          const now = d.days.filter((x) => x.day >= range.from);
          const before = d.days.filter((x) => x.day < range.from);
          const series = bucketize(now, buckets, (x) => x.day, (x) => x[figure], tz);
          const previous = bucketizeShifted(before, buckets, (x) => x.day, (x) => x[figure], tz, range.days);
          const channels = new Map<Channel, number>();
          for (const s of d.sources) channels.set(s.channel, (channels.get(s.channel) ?? 0) + s.visits);
          const nothingYet = !d.days.some((x) => x.pageviews > 0);
          return (
            <>
              {nothingYet && (
                <div className="callout callout-info" role="status">
                  <Icon name="info" size={16} />
                  <div className="grow">
                    No visits in this period yet.
                    <span style={{ display: "block", fontWeight: 400 }}>
                      Visits show up here a minute after someone opens your website. If it's been longer, check the line is on it in <Link to="/apps/website_analytics">Apps</Link>.
                    </span>
                  </div>
                </div>
              )}

              <div className={styles.webHero}>
                <section className={styles.webHeroMain} aria-label="Website visits">
                  <div className="segmented" role="group" aria-label="Figure to chart">
                    {(Object.keys(FIGURES) as Figure[]).map((k) => (
                      <button key={k} type="button" aria-pressed={figure === k} title={FIGURES[k].label} onClick={() => setFigure(k)}>{FIGURES[k].short}</button>
                    ))}
                  </div>
                  <div className={styles.big}>{count(totals.now[figure])}<Change now={totals.now[figure]} before={totals.before[figure]} /></div>
                  <p className={styles.prev}>{range.label} · Previous period {count(totals.before[figure])}, {shortDate(prev.from)} – {shortDate(prev.to)}</p>
                  <div className={styles.webChart}>
                    <TrendChart key={figure} buckets={buckets} values={series} previous={previous} format={count} label={FIGURES[figure].chart} height={200} area />
                  </div>
                </section>
                <aside className={styles.totals} aria-label="This period's totals">
                  <Total label="Visitors" now={totals.now.visitors} before={totals.before.visitors} hint="Each person counts once a day" />
                  <Total label="Page views" now={totals.now.pageviews} before={totals.before.pageviews} hint={totals.now.visits ? `${formatNumber(totals.now.pageviews / totals.now.visits, 1)} pages a visit` : "Pages people opened"} />
                  <Total label="Visits" now={totals.now.visits} before={totals.before.visits} hint="Times people came to your website" />
                  <Total label="Booking requests" now={totals.now.requests} before={totals.before.requests} hint={totals.now.visits ? `${pct(totals.now.requests, totals.now.visits)} of visits` : "From your website's booking form"} />
                </aside>
              </div>

              {/* With no visits yet, the callout says so once: no empty breakdowns under it. */}
              {!nothingYet && (
                <>
                  <div className="report-grid">
                    <ReportCard title="Pages" info="Landings: visits that started on the page. Requests: booking requests whose visit started there." count={d.pages.length}>
                      <ReportTable
                        rows={d.pages}
                        rowKey={(r) => r.path}
                        filename={`website-pages-${range.from}-to-${range.to}`}
                        initialSort={{ key: "pageviews", desc: true }}
                        empty="No page views in this period."
                        columns={[
                          { key: "path", label: "Page", value: (r) => r.path, render: (r) => <span className="ellipsis" style={{ display: "block", maxWidth: 280 }} title={r.path}>{r.path === "/" ? "Home page (/)" : r.path}</span> },
                          { key: "visitors", label: "Visitors", num: true, value: (r) => r.visitors },
                          { key: "pageviews", label: "Views", num: true, value: (r) => r.pageviews },
                          { key: "entries", label: "Landings", num: true, value: (r) => r.entries },
                          { key: "requests", label: "Requests", num: true, value: (r) => r.requests },
                        ]}
                      />
                    </ReportCard>
                    <ReportCard title="Where visits came from" subtitle={plural(totals.now.visits, "visit")}>
                      <Breakdown
                        label="Visits by where they came from"
                        format={count}
                        empty="No visits in this period."
                        parts={[...channels].sort((a, b) => b[1] - a[1]).map(([channel, value]) => ({ key: channel, label: channelName(channel), value, color: CHANNEL_COLORS[channel] ?? "var(--text-4)" }))}
                      />
                    </ReportCard>
                  </div>

                  <div className="report-grid">
                    <ReportCard title="Sources" info="Search engines, social sites, directories, AI assistants, emails and other websites that sent visitors, and your own campaign links (utm_source).">
                      <ReportTable
                        rows={d.sources}
                        rowKey={(r) => `${r.source}|${r.channel}`}
                        filename={`website-sources-${range.from}-to-${range.to}`}
                        initialSort={{ key: "visits", desc: true }}
                        empty="No visits in this period."
                        columns={[
                          { key: "source", label: "Source", value: (r) => r.source, render: (r) => <SourceName name={r.source} channel={r.channel} /> },
                          { key: "visitors", label: "Visitors", num: true, value: (r) => r.visitors },
                          { key: "visits", label: "Visits", num: true, value: (r) => r.visits },
                          { key: "requests", label: "Requests", num: true, value: (r) => r.requests },
                          { key: "rate", label: "Booked", num: true, value: (r) => (r.visits ? Math.round((r.requests / r.visits) * 1000) / 10 : 0), render: (r) => pct(r.requests, r.visits) },
                        ]}
                      />
                    </ReportCard>
                    <ReportCard title="Devices" subtitle={plural(totals.now.visitors, "visitor")}>
                      <Breakdown
                        label="Visitors by device"
                        format={count}
                        empty="No visitors in this period."
                        parts={d.devices.map((x) => ({ key: x.device, label: DEVICE_LABELS[x.device] ?? x.device, value: x.visitors, color: DEVICE_COLORS[x.device] ?? "var(--text-4)" }))}
                      />
                    </ReportCard>
                  </div>

                  <ReportCard
                    title="Campaigns"
                    info="Links you tag with utm_campaign, like greenlawn.com/?utm_source=flyer&utm_campaign=spring on a flyer's QR code."
                  >
                    <ReportTable
                      rows={d.campaigns}
                      rowKey={(r) => r.campaign}
                      filename={`website-campaigns-${range.from}-to-${range.to}`}
                      initialSort={{ key: "visits", desc: true }}
                      empty="No campaign links were opened in this period. Add ?utm_campaign=name to a link you share to see it here."
                      columns={[
                        { key: "campaign", label: "Campaign", value: (r) => r.campaign, render: (r) => <strong>{r.campaign}</strong> },
                        { key: "visitors", label: "Visitors", num: true, value: (r) => r.visitors },
                        { key: "visits", label: "Visits", num: true, value: (r) => r.visits },
                        { key: "requests", label: "Requests", num: true, value: (r) => r.requests },
                      ]}
                    />
                  </ReportCard>
                </>
              )}
            </>
          );
        }}
      </TabBody>
    </div>
  );
}

/** A channel's name; one the app doesn't know yet in sentence case rather than its raw key ("organic" → "Organic"). */
function channelName(channel: string): string {
  return CHANNEL_LABELS[channel as Channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

function SourceName({ name, channel }: { name: string; channel: Channel }) {
  return (
    <span className={styles.source}>
      <i aria-hidden style={{ background: CHANNEL_COLORS[channel] ?? "var(--text-4)" }} />
      <span className={styles.sourceText}>
        <strong>{name}</strong>
        {name !== channelName(channel) && <span>{channelName(channel)}</span>}
      </span>
    </span>
  );
}

/** A total beside the chart, on a hairline, with its change from the period before. */
function Total({ label, now, before, hint }: { label: string; now: number; before: number; hint: ReactNode }) {
  return (
    <div className={styles.total}>
      <span className={styles.totalLabel}>{label}</span>
      <span className={styles.totalValue}>{count(now)}<Change now={now} before={before} /></span>
      <span className={styles.totalHint}>{hint}</span>
    </div>
  );
}
