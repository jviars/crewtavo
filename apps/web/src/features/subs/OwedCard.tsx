/** Subs' pay for work that's done and not paid yet, across every sub: pick several and mark them paid at once. */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Section } from "@/components/ui/Section";
import { ErrorState } from "@/components/ui/States";
import { formatDate, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import { MarkPaidDialog } from "./MarkPaidDialog";
import { owedSelection } from "./pay";
import { useOwed } from "./payData";
import styles from "./Subs.module.css";

export function OwedCard() {
  const session = useSession();
  const owed = useOwed(session.company.id, true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);
  const allBox = useRef<HTMLInputElement>(null);
  const rows = owed.data ?? [];
  // Only what's still owed counts as picked.
  const selected = new Set([...picked].filter((id) => rows.some((r) => r.id === id)));
  const sel = owedSelection(rows, selected);
  const all = owedSelection(rows, new Set(rows.map((r) => r.id)));
  const toggle = (id: string, on: boolean) => setPicked((p) => { const next = new Set(p); on ? next.add(id) : next.delete(id); return next; });
  // A dash in Pick all while only some are picked: there's no attribute for it, only the property.
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = selected.size > 0 && selected.size < rows.length;
  });

  if (owed.error && !owed.data) return <ErrorState compact title="Couldn't load what's owed" error={owed.error} onRetry={() => owed.refetch()} />;
  if (!rows.length) return null;
  return (
    <Section
      title="Owed"
      count={formatMoneyCents(all.total)}
      action={<Button icon="check" disabled={!sel.count} onClick={() => setPaying(true)}>{sel.count > 1 ? `Mark ${sel.count} paid` : "Mark paid"}</Button>}
    >
      <label className={styles.owedAll}>
        <input ref={allBox} type="checkbox" aria-label="Pick all" checked={selected.size === rows.length} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} />
        <span aria-live="polite">{sel.count ? `${sel.count} picked, ${formatMoneyCents(sel.total)}` : "Work that's done and not paid yet"}</span>
      </label>
      <ul className={styles.owed} role="list">
        {rows.map((p) => (
          <li key={p.id} className={styles.owedRow} data-picked={selected.has(p.id) || undefined}>
            {/* The label around the box makes the whole 44px square around it a target on a phone. */}
            <label className={styles.owedCheck}>
              <input type="checkbox" aria-label={`Pick ${p.sub?.name ?? "this"} on job #${p.job?.number ?? ""}`} checked={selected.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
            </label>
            {p.sub ? <Link className={styles.owedSub} to={`/subs/${p.sub.id}`}>{p.sub.name}</Link> : <span className={styles.owedSub}>Sub</span>}
            <span className={styles.owedJob}>{p.job && <Link to={`/jobs/${p.job.id}`}>Job #{p.job.number} · {p.job.title}</Link>}</span>
            <span className={styles.owedDone}>{p.earned_on && `Done ${formatDate(p.earned_on)}`}</span>
            <span className={styles.owedMoney}>{formatMoneyCents(p.total)}</span>
          </li>
        ))}
      </ul>
      {paying && (
        <MarkPaidDialog
          pays={rows.filter((r) => selected.has(r.id)).map((r) => ({ id: r.id, total: r.total, label: `${r.sub?.name ?? "Sub"}, job #${r.job?.number ?? ""}` }))}
          onClose={() => setPaying(false)}
          onPaid={() => setPicked(new Set())}
        />
      )}
    </Section>
  );
}
