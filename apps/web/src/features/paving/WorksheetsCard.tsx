/**
 * The worksheets behind a quote's lines (the paving calculator's working, public.paving_worksheets),
 * on the quote, its job and its paving project: what each priced at, its cost, profit and the
 * estimator's notes, to print or reopen, and which option it is when the quote offers options. While
 * the quote is open, another job priced on the calculator can be added as an option (up to three).
 * A section on a hairline, its rows small related rows with the print and calculator as quiet icon
 * buttons, so it fits a record page's side column too. The office's only: the table is, and so is
 * this section (callers show it to sales and the office). Nothing shows when a quote has none.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { supabase, unwrap } from "@/lib/api";
import { formatMoney, formatNumber } from "@/lib/format";
import { calculate, parseWorksheet } from "./calculator";
import styles from "./paving.module.css";

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

/**
 * `level` 3 and `flush` when it sits inside another section (a paving project's estimate step), so it
 * reads as part of it and a phone's grouped page doesn't put a card inside a card.
 */
export function WorksheetsCard({ quoteId, editable, level = 2, flush }: { quoteId: string; editable: boolean; level?: 2 | 3; flush?: boolean }) {
  const worksheets = useWorksheets(quoteId);
  if (!worksheets.data?.rows.length) return null;
  const { rows, options } = worksheets.data;
  const optionOf = (id: string | null | undefined) => {
    const i = options.findIndex((o) => o.id === id);
    return i < 0 ? null : `Option ${i + 1}`;
  };
  return (
    <Section
      level={level}
      flush={flush}
      title={
        <span className={styles.worksheetsTitle}>
          {rows.length === 1 ? "Worksheet" : "Worksheets"}
          <span className={styles.office}><Icon name="lock" size={12} />Office only</span>
        </span>
      }
      action={editable && options.length < 3 && <Link to={`/paving/calculator?quote=${quoteId}&as=option`} title="Price another way to do it, and the client picks one."><Icon name="plus" size={14} />Add an option</Link>}
    >
      <RelatedList label={rows.length === 1 ? "Worksheet" : "Worksheets"}>
        {rows.map((w) => {
          const saved = parseWorksheet(w.data);
          const calc = saved ? calculate(saved.setup, saved.input, saved.overrides) : null;
          const option = optionOf(w.line?.option_id);
          const kept = calc ? calc.profit + calc.toMinimum : 0;
          return (
            <RelatedRow
              key={w.id}
              lead={option ?? undefined}
              title={w.name}
              sub={
                <span className={styles.worksheetSub}>
                  {calc && (
                    <span>
                      {formatNumber(calc.sqft)} sq ft · cost {formatMoney(calc.cost)} · profit {formatMoney(kept)}
                      {calc.total > 0 ? ` (${Math.round((kept / calc.total) * 100)}%)` : ""}
                    </span>
                  )}
                  {/* Profit inside the prices reads as no margin everywhere else in Crewtavo. */}
                  {saved?.input.profit.by === "none" && <span>Profit is in the prices on this one, where Crewtavo can't see it, so its margin shows as 0% (or just what the minimum charge adds).</span>}
                  {w.notes && <span className={styles.worksheetNotes}>{w.notes}</span>}
                </span>
              }
              end={calc && <b>{formatMoney(calc.total)}</b>}
              actions={
                <>
                  <Link className="btn btn-icon btn-sm" to={`/paving/worksheets/${w.id}`} aria-label={`Print ${w.name}`} title="Print"><Icon name="printer" size={15} /></Link>
                  {editable && <Link className="btn btn-icon btn-sm" to={`/paving/calculator?worksheet=${w.id}`} aria-label={`Open ${w.name} in the calculator`} title="Open in calculator"><Icon name="calculator" size={15} /></Link>}
                </>
              }
            />
          );
        })}
      </RelatedList>
    </Section>
  );
}
