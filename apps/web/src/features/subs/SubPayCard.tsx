/** A sub's pay on every job: what's owed, what was paid this year (and toward their 1099), and the history. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { RelatedRow, Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { MarkPaidDialog, type ToPay } from "./MarkPaidDialog";
import { offerChip, offerLine } from "./offers";
import { payStatusLine, yearPaid } from "./pay";
import { useSubPays } from "./payData";
import styles from "./Subs.module.css";

export function SubPayCard({ subId, name }: { subId: string; name: string }) {
  const session = useSession();
  const tz = session.company.timezone;
  const year = Number(todayIn(tz).slice(0, 4));
  const pays = useSubPays(session.company.id, subId);
  const [paying, setPaying] = useState<ToPay[] | null>(null);
  const [all, setAll] = useState(false);
  const rows = pays.data ?? [];
  const totals = yearPaid(rows, year, tz);
  const owed = rows.filter((p) => p.status === "done");
  const toPay = (p: (typeof rows)[number]): ToPay => ({ id: p.id, total: p.total, label: `${name}, job #${p.job?.number ?? ""}` });
  const shown = all ? rows : rows.slice(0, 8);
  const listRef = useListAnimation<HTMLUListElement>();

  return (
    <Section
      title="Pay"
      count={rows.length || undefined}
      action={owed.length > 1 ? <Button icon="check" onClick={() => setPaying(owed.map(toPay))}>Mark all {owed.length} paid</Button> : rows.length > 0 ? <Link to={`/subs/1099?year=${year}`}>Year-end totals</Link> : undefined}
    >
      {pays.isPending ? (
        <Skeleton width="50%" />
      ) : pays.error ? (
        <ErrorState compact error={pays.error} onRetry={() => pays.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState inline title="No pay yet">Add their pay from a job's page, under Sub and crew pay.</EmptyState>
      ) : (
        <div className={styles.pay}>
          <StatStrip label={`Pay in ${year}`}>
            <Stat
              label={`Paid in ${year}`}
              value={<AnimatedNumber value={totals.paid} format={MONEY_CENTS} />}
              note={totals.for1099 !== totals.paid ? `${formatMoneyCents(totals.for1099)} counts toward their 1099: card and payment-app payments are left out.` : undefined}
              to={`/subs/1099?year=${year}`}
              title="Year-end totals"
            />
            <Stat label="Owed now" value={<AnimatedNumber value={totals.owed} format={MONEY_CENTS} />} />
          </StatStrip>
          <ul className={`rel ${styles.payRows}`} role="list" ref={listRef}>
            {shown.map((p) => (
              <RelatedRow
                key={p.id}
                to={p.job ? `/jobs/${p.job.id}` : undefined}
                title={p.job ? `Job #${p.job.number} · ${p.job.title}` : "A job"}
                sub={offerLine(p, tz) ?? payStatusLine(p, tz)}
                end={
                  <>
                    <StatusPill {...offerChip(p, "sub")} />
                    <b>{formatMoneyCents(p.status === "paid" ? p.paid_amount : p.total)}</b>
                  </>
                }
                actions={p.status === "done" && <Button size="sm" onClick={() => setPaying([toPay(p)])}>Mark paid</Button>}
              />
            ))}
          </ul>
          {rows.length > 8 && (
            <div className={styles.more}>
              <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${rows.length}`}</button>
            </div>
          )}
        </div>
      )}
      {paying && <MarkPaidDialog pays={paying} onClose={() => setPaying(null)} />}
    </Section>
  );
}
