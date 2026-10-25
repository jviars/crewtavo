/** A sub's pay on every job: what's owed, what was paid this year (and toward their 1099), and the history. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { MarkPaidDialog, type ToPay } from "./MarkPaidDialog";
import { offerChip, offerLine } from "./offers";
import { payStatusLine, yearPaid } from "./pay";
import { useSubPays } from "./payData";

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

  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Pay</h2>
        {rows.length > 0 && <Link className="small" to={`/subs/1099?year=${year}`}>Year-end totals</Link>}
      </div>
      <div className="card">
        {pays.isPending ? (
          <div className="card-row"><Skeleton width="50%" /></div>
        ) : pays.error ? (
          <div className="card-row"><ErrorState compact error={pays.error} onRetry={() => pays.refetch()} /></div>
        ) : rows.length === 0 ? (
          <EmptyState compact icon="dollar" title="No pay yet">Add their pay from a job's page, under Sub and crew pay.</EmptyState>
        ) : (
          <>
            <div className="card-row" style={{ flexWrap: "wrap", gap: 16 }}>
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 140 }}>
                <span className="muted small">Paid in {year}</span>
                <strong className="tabular" style={{ fontSize: 18 }}>{formatMoneyCents(totals.paid)}</strong>
                {totals.for1099 !== totals.paid && <span className="muted small">{formatMoneyCents(totals.for1099)} counts toward their 1099: card and payment-app payments are left out.</span>}
              </span>
              <span className="grow stack-sm" style={{ gap: 2, minWidth: 140 }}>
                <span className="muted small">Owed now</span>
                <strong className="tabular" style={{ fontSize: 18 }}>{formatMoneyCents(totals.owed)}</strong>
              </span>
              {owed.length > 1 && <Button size="sm" variant="primary" icon="check" onClick={() => setPaying(owed.map(toPay))}>Mark all {owed.length} paid</Button>}
            </div>
            {shown.map((p) => (
              <div key={p.id} className="card-row" style={{ flexWrap: "wrap" }}>
                <span className="grow" style={{ minWidth: 180 }}>
                  {p.job ? <Link className="strong" to={`/jobs/${p.job.id}`}>Job #{p.job.number} · {p.job.title}</Link> : <strong>A job</strong>}
                  <span className="muted small" style={{ display: "block" }}>{offerLine(p, tz) ?? payStatusLine(p, tz)}</span>
                </span>
                <span className="tabular strong">{formatMoneyCents(p.status === "paid" ? p.paid_amount : p.total)}</span>
                <StatusPill {...offerChip(p, "sub")} />
                {p.status === "done" && <Button size="sm" onClick={() => setPaying([toPay(p)])}>Mark paid</Button>}
              </div>
            ))}
            {rows.length > 8 && (
              <div className="list-foot">
                <span />
                <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${rows.length}`}</Button>
              </div>
            )}
          </>
        )}
      </div>
      {paying && <MarkPaidDialog pays={paying} onClose={() => setPaying(null)} />}
    </section>
  );
}
