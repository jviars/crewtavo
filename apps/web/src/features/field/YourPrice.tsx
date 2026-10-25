/**
 * A sub's own price for the job behind a visit: the pay that covers it (once the office agrees it,
 * never a draft), its lines, total and notes. Row-level security gives a sub only their own
 * (20261025003001_job_pay.sql), and nothing here shows anyone else's. A new price the office sent
 * shows here too, with a link to answer it in My jobs.
 */
import { isLivePay } from "@crewtavo/core/jobPay";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { formatRate, payStatusLabel, payTone, quantityWords } from "../subs/pay";

interface MyPay {
  id: string;
  status: string;
  total: number;
  notes: string | null;
  lines: Array<{ id: string; description: string; basis: string; unit: string | null; quantity: number; rate: number; amount: number; sort: number }>;
}

export function YourPrice({ visitId }: { visitId: string }) {
  const pay = useQuery({
    queryKey: ["field-visit", visitId, "pay"],
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().from("job_pay_visits").select("pay:job_pay(id, status, total, notes, lines:job_pay_lines(id, description, basis, unit, quantity, rate, amount, sort))").eq("visit_id", visitId).limit(20));
      return rows.map((r) => r.pay as unknown as MyPay | null).filter((p): p is MyPay => Boolean(p) && isLivePay(p!.status) && p!.status !== "draft");
    },
  });
  const p = pay.data?.[0];
  if (!p) return null;
  const lines = [...p.lines].sort((a, b) => a.sort - b.sort);
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Your price</strong>
        <StatusPill label={p.status === "offered" ? "New price" : payStatusLabel(p.status)} tone={payTone(p.status)} />
      </div>
      {p.status === "offered" && (
        <span className="small">
          The office sent a new price. <Link to={`/field/jobs/${p.id}`}>Accept or decline it in My jobs</Link>
        </span>
      )}
      {lines.map((l) => (
        <div key={l.id} className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
          <span className="grow">
            {l.description}
            {l.basis !== "per_job" && <span className="muted small" style={{ display: "block" }}>{quantityWords(l.quantity, l.basis === "per_day" ? "day" : l.unit)} × {formatRate(l.rate)}</span>}
          </span>
          <span className="tabular">{formatMoneyCents(Number(l.amount))}</span>
        </div>
      ))}
      <div className="row-between"><strong>Total</strong><strong className="tabular">{formatMoneyCents(Number(p.total))}</strong></div>
      {p.notes && <p className="pre-wrap small muted" style={{ margin: 0 }}>{p.notes}</p>}
    </section>
  );
}
