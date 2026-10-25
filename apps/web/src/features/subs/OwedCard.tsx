/** Subs' pay for work that's done and not paid yet, across every sub: pick several and mark them paid at once. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { ErrorState } from "@/components/ui/States";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import { MarkPaidDialog } from "./MarkPaidDialog";
import { owedSelection } from "./pay";
import { useOwed } from "./payData";

export function OwedCard() {
  const session = useSession();
  const owed = useOwed(session.company.id, true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const rows = owed.data ?? [];
  // Only what's still owed counts as picked.
  const selected = new Set([...picked].filter((id) => rows.some((r) => r.id === id)));
  const sel = owedSelection(rows, selected);
  const all = owedSelection(rows, new Set(rows.map((r) => r.id)));
  const toggle = (id: string, on: boolean) => setPicked((p) => { const next = new Set(p); on ? next.add(id) : next.delete(id); return next; });

  if (owed.error && !owed.data) return <div className="card" style={{ marginBottom: 16 }}><ErrorState compact title="Couldn't load what's owed" error={owed.error} onRetry={() => owed.refetch()} /></div>;
  if (!rows.length) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Owed">
      <div className="card-head" style={{ flexWrap: "wrap", gap: 10 }}>
        <strong className="grow">Owed · {formatMoneyCents(all.total)}</strong>
        <span className="muted small">{sel.count ? `${sel.count} picked, ${formatMoneyCents(sel.total)}` : "Work that's done and not paid yet"}</span>
        {/* On a phone the table's heads are hidden, Pick all with them. */}
        <label className="mobile-only small" style={{ gridAutoFlow: "column", alignItems: "center", gap: 6, fontWeight: 600 }}>
          <input type="checkbox" checked={selected.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
          Pick all
        </label>
        <Button size="sm" variant="primary" icon="check" disabled={!sel.count} onClick={() => setPaying(true)}>{sel.count > 1 ? `Mark ${sel.count} paid` : "Mark paid"}</Button>
      </div>
      <table className="table table-stack">
        <thead>
          <tr>
            <th style={{ width: 36 }}>
              <input type="checkbox" aria-label="Pick all" checked={selected.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
            </th>
            <th>Sub</th><th>Job</th><th>Work done</th><th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td><input type="checkbox" aria-label={`Pick ${p.sub?.name ?? "this"} on job #${p.job?.number ?? ""}`} checked={selected.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /></td>
              <td>{p.sub ? <Link className="cell-link" to={`/subs/${p.sub.id}`}>{p.sub.name}</Link> : "Sub"}</td>
              <td>{p.job ? <Link to={`/jobs/${p.job.id}`}>#{p.job.number} {p.job.title}</Link> : "—"}</td>
              <td className="nowrap"><span className="mobile-inline">Done </span>{formatDate(p.earned_on)}</td>
              <td className="num tabular strong">{formatMoneyCents(p.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {paying && (
        <MarkPaidDialog
          pays={rows.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, total: r.total, label: `${r.sub?.name ?? "Sub"}, job #${r.job?.number ?? ""}` }))}
          onClose={() => setPaying(false)}
          onPaid={() => setPicked(new Set())}
        />
      )}
    </section>
  );
}
