/**
 * The worksheets behind a quote's lines (the paving calculator's working, public.paving_worksheets),
 * on the quote, its job and its paving project: what each priced at, its cost, profit and the
 * estimator's notes, to print or reopen, and which option it is when the quote offers options. While
 * the quote is open, another job priced on the calculator can be added as an option (up to three).
 * The office's only: the table is, and so is this card (callers show it to sales and the office).
 * Nothing shows when a quote has none.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { calculate, parseWorksheet } from "./calculator";

export const worksheetsKey = (quoteId: string) => ["paving-worksheets", quoteId];

/** A quote's worksheets, with its options to say which each is on. */
export function useWorksheets(quoteId: string) {
  return useQuery({
    queryKey: worksheetsKey(quoteId),
    queryFn: async () => {
      const db = supabase();
      const [rows, options] = await Promise.all([
        db.from("paving_worksheets").select("id, name, notes, data, line:quote_line_items(option_id)").eq("quote_id", quoteId).order("created_at"),
        db.from("quote_options").select("id, name, sort").eq("quote_id", quoteId).order("sort"),
      ]);
      return { rows: unwrap(rows), options: unwrap(options) };
    },
  });
}

export function WorksheetsCard({ quoteId, editable }: { quoteId: string; editable: boolean }) {
  const worksheets = useWorksheets(quoteId);
  if (!worksheets.data?.rows.length) return null;
  const { rows, options } = worksheets.data;
  const optionOf = (id: string | null | undefined) => {
    const i = options.findIndex((o) => o.id === id);
    return i < 0 ? null : `Option ${i + 1}`;
  };
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="calculator" size={18} />
        <strong>{rows.length === 1 ? "Worksheet" : "Worksheets"}</strong>
        <span className="calc-chip"><Icon name="lock" size={12} />Office only</span>
      </div>
      {rows.map((w) => {
        const saved = parseWorksheet(w.data);
        const calc = saved ? calculate(saved.setup, saved.input, saved.overrides) : null;
        const option = optionOf(w.line?.option_id);
        return (
          <div key={w.id} className="card-row" style={{ display: "grid", gap: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <strong className="grow">{option && <span className="muted">{option} · </span>}{w.name}</strong>
              {calc && <strong className="num">{formatMoney(calc.total)}</strong>}
            </div>
            {calc && (
              <span className="muted small">
                {formatNumber(calc.sqft)} sq ft · cost {formatMoney(calc.cost)} · profit {formatMoney(calc.profit + calc.toMinimum)}
                {calc.total > 0 ? ` (${Math.round(((calc.profit + calc.toMinimum) / calc.total) * 100)}%)` : ""}
              </span>
            )}
            {/* Profit inside the prices reads as no margin everywhere else in Crewtavo. */}
            {saved?.input.profit.by === "none" && <span className="muted small">Profit is in the prices on this one, where Crewtavo can't see it, so its margin shows as 0% (or just what the minimum charge adds).</span>}
            {w.notes && <span className="small" style={{ whiteSpace: "pre-wrap" }}>{w.notes}</span>}
            <div className="row wrap" style={{ gap: 8, marginTop: 2 }}>
              <Link className="btn btn-sm" to={`/paving/worksheets/${w.id}`}><Icon name="printer" size={14} />Print</Link>
              {editable && <Link className="btn btn-sm" to={`/paving/calculator?worksheet=${w.id}`}><Icon name="calculator" size={14} />Open in calculator</Link>}
            </div>
          </div>
        );
      })}
      {editable && options.length < 3 && (
        <div className="card-row">
          <Link className="btn btn-sm" to={`/paving/calculator?quote=${quoteId}&as=option`}><Icon name="plus" size={14} />Add another option</Link>
          <span className="muted small">Price another way to do it, and the client picks one.</span>
        </div>
      )}
    </div>
  );
}
