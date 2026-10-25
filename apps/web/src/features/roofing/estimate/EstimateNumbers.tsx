/**
 * "Your numbers": what the estimate costs the business (ABC Supply materials, labor and the rest),
 * the profit and the margin, with where the material prices came from, for the option being looked
 * at when it offers options. Only the team sees it; the homeowner never does. Hidden when nothing is
 * known about the cost.
 */
import { useId } from "react";
import { formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSupplier, type Supplier } from "../../materials/data";
import { estimateFigures, firstName, LOW_MARGIN, whenText, type FiguresQuote } from "./rows";
import styles from "./estimate.module.css";

/** The branch, as ABC names it ("ABC Supply - Lexington, KY"), with a note for sandbox test prices. */
export function branchLabel(supplier: Supplier | null | undefined): string | null {
  if (!supplier) return null;
  const branch = /abc/i.test(supplier.branch_name) ? supplier.branch_name : `ABC Supply, ${supplier.branch_name}`;
  return supplier.environment === "sandbox" ? `${branch} (ABC's sandbox test prices)` : branch;
}

/** The little "ABC" mark beside prices that came from ABC Supply. */
export function AbcBadge() {
  return <span className={styles.abcBadge} aria-hidden="true">ABC</span>;
}

export function EstimateNumbers({ quote, clientName, optionId, optionLabel }: {
  quote: FiguresQuote;
  clientName?: string | null;
  /** The option looked at (rows.ts estimateFigures); the one shown when left out. */
  optionId?: string | null;
  /** Its name in the heading ("Better"), when the estimate offers options. */
  optionLabel?: string | null;
}) {
  const { company } = useSession();
  const supplier = useSupplier();
  const id = useId();
  const figures = estimateFigures(quote, optionId === undefined ? (quote.option_id ?? null) : optionId);
  if (!figures) return null;
  const first = firstName(clientName);
  const branch = branchLabel(supplier.data);
  const low = figures.margin !== null && figures.margin < LOW_MARGIN;
  return (
    <section className={styles.numbers} aria-labelledby={id}>
      <h3 id={id} className={styles.numbersTitle}>
        Your numbers{optionLabel ? ` for ${optionLabel}` : ""} · {first ? `${first} never sees these` : "only your team sees these"}
      </h3>
      <dl className={styles.figures}>
        {figures.materials !== null && (
          <>
            <dt>ABC materials</dt>
            <dd>{formatMoney(figures.materials)}{figures.materialsPartial ? "+" : ""}</dd>
          </>
        )}
        <dt>Materials and labor</dt>
        <dd>{formatMoney(figures.cost)}{figures.costPartial ? "+" : ""}</dd>
        <dt>Profit</dt>
        <dd>{formatMoney(figures.profit)}</dd>
        <dt className={styles.strong}>Margin</dt>
        <dd className={styles.strong} data-low={low || undefined}>{figures.margin === null ? "—" : `${figures.margin}%`}</dd>
      </dl>
      {figures.pricedAt && (
        <p className={styles.abc}>
          <AbcBadge />
          <span>Materials at your ABC Supply prices{branch ? `, ${branch}` : ""}, priced {whenText(figures.pricedAt, company.timezone)}.</span>
        </p>
      )}
      {figures.costPartial && <p className={styles.note}>Some lines have no cost in your price list, so the real cost is higher and the margin lower.</p>}
      {figures.materialsPartial && <p className={styles.note}>The branch hasn't priced every material yet, so materials cost at least this.</p>}
    </section>
  );
}
