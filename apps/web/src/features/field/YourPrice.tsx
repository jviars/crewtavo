/**
 * A sub's own price for the job behind a visit: the pay that covers it (once the office agrees it,
 * never a draft), its lines, total and notes. Row-level security gives a sub only their own
 * (20261025003001_job_pay.sql), and nothing here shows anyone else's. A new price the office sent
 * shows here too, with a link to answer it in My jobs.
 */
import { isLivePay } from "@crewtavo/core/jobPay";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Section } from "@/components/ui/Section";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { formatRate, payStatusLabel, payTone, quantityWords } from "../subs/pay";
import { t } from "@/lib/i18n";

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
    <Section title={t("Your price")} action={<StatusPill label={p.status === "offered" ? t("New price") : payStatusLabel(p.status)} tone={payTone(p.status)} />} className="your-price">
      {p.status === "offered" && (
        <p className="field-hint">
          {t("The office sent a new price.")} <Link to={`/field/jobs/${p.id}`}>{t("Accept or decline it in My jobs")}</Link>
        </p>
      )}
      <PriceLines lines={lines} total={Number(p.total)} />
      {p.notes && <p className="field-hint pre-wrap">{p.notes}</p>}
    </Section>
  );
}

/** A sub's price as lines: each line's words and how it's counted, its amount on the right, then the total. */
export function PriceLines({ lines, total }: { lines: ReadonlyArray<{ id?: string; description: string; basis: string; unit: string | null; quantity: number; rate: number; amount: number }>; total: number }) {
  return (
    <ul className="price-lines">
      {lines.map((l, i) => (
        <li key={l.id ?? i}>
          <span className="price-line-what">
            {l.description}
            {l.basis !== "per_job" && <span className="price-line-how">{quantityWords(l.quantity, l.basis === "per_day" ? "day" : l.unit)} × {formatRate(l.rate)}</span>}
          </span>
          <span className="tabular">{formatMoneyCents(Number(l.amount))}</span>
        </li>
      ))}
      <li className="price-total"><span>{t("Total")}</span><span className="tabular">{formatMoneyCents(total)}</span></li>
    </ul>
  );
}
