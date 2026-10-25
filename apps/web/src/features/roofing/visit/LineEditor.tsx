/**
 * Changing one line of the estimate by hand on the iPad (VisitPage): opened by tapping it in the
 * line items or on the paper. How many (for a count: a measured line's comes from the roof), its
 * price for one, and the words printed under its name. Saved through the estimate's editor, so it
 * shows at once on the list and the paper, and saves in line with − and +.
 */
import { lineTotal, toCents } from "@crewtavo/core/money";
import { useId, useState, type FormEvent } from "react";
import { readAmount } from "@/components/ui/MoneyInput";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import type { EstimateEditor, LinePatch } from "../estimate/data";
import { countText, lineDetail, lineKind, money } from "../estimate/rows";
import type { EstimateLine } from "../estimate/types";
import { priceInputText, readQuantity } from "./price";
import styles from "./visit.module.css";

const DESCRIPTION_MAX = 2000;

export function LineEditor({ line, editor, onClose }: { line: EstimateLine | null; editor: EstimateEditor; onClose: () => void }) {
  return (
    <Dialog open={Boolean(line)} onClose={onClose} title={line?.name ?? "The line"} description="What you change shows on the estimate straight away.">
      {line && <LineForm key={line.id} line={line} editor={editor} onClose={onClose} />}
    </Dialog>
  );
}

function LineForm({ line, editor, onClose }: { line: EstimateLine; editor: EstimateEditor; onClose: () => void }) {
  const id = useId();
  // Counts are set by hand; a measured line's quantity is worked out from the roof.
  const counted = lineKind(line) === "count";
  const [quantity, setQuantity] = useState(countText(Number(line.quantity)));
  const [price, setPrice] = useState(priceInputText(Number(line.unit_price)));
  const [words, setWords] = useState(line.description ?? "");
  const q = counted ? readQuantity(quantity) : Number(line.quantity);
  const p = readAmount(price.replace(/[\s$,]/g, ""), { max: 10_000_000 });
  const amount = q !== null && p !== null ? lineTotal(q, p) : null;

  const step = (by: number) => {
    const now = readQuantity(quantity) ?? 0;
    const next = Math.max(1, Math.round((now + by) * 1000) / 1000);
    setQuantity(countText(next));
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (q === null || p === null) return;
    const patch: LinePatch = {};
    if (counted && q !== Number(line.quantity)) patch.quantity = q;
    if (toCents(p) !== toCents(line.unit_price)) patch.unit_price = p;
    const description = words.trim() || null;
    if (description !== (line.description?.trim() || null)) patch.description = description;
    if (Object.keys(patch).length) editor.setLine(line, patch);
    onClose();
  };

  return (
    <form onSubmit={save} className={styles.lineForm}>
      {counted ? (
        <div className={styles.lineField}>
          <label htmlFor={`${id}-qty`}>How many</label>
          <div className={styles.qtyRow}>
            <button type="button" className={styles.qtyStep} aria-label="One fewer" onClick={() => step(-1)}>
              <Icon name="minus" size={18} strokeWidth={2.5} />
            </button>
            <input
              id={`${id}-qty`}
              className={`input ${styles.qtyInput}`}
              inputMode="decimal"
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={q === null || undefined}
              value={quantity}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <button type="button" className={styles.qtyStep} aria-label="One more" onClick={() => step(1)}>
              <Icon name="plus" size={18} strokeWidth={2.5} />
            </button>
          </div>
          {q === null && <span className={styles.priceError} role="alert">Type how many, like 3.</span>}
        </div>
      ) : (
        <p className={styles.smallNote}>{lineDetail(line)}. The amount comes from the roof's measurements.</p>
      )}

      <div className={styles.lineField}>
        <label htmlFor={`${id}-price`}>{counted ? "Price for one" : "Price"}</label>
        <span className={styles.moneyField}>
          <span aria-hidden="true">$</span>
          <input
            id={`${id}-price`}
            className={`input ${styles.moneyInput}`}
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            aria-invalid={p === null || undefined}
            value={price}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setPrice(e.target.value)}
          />
        </span>
        {p === null && <span className={styles.priceError} role="alert">Type the price in dollars, like {priceInputText(Number(line.unit_price))}.</span>}
      </div>

      <div className={styles.lineField}>
        <label htmlFor={`${id}-words`}>Under the name on the estimate</label>
        <textarea
          id={`${id}-words`}
          className={`textarea ${styles.lineWords}`}
          maxLength={DESCRIPTION_MAX}
          placeholder="Optional, like “Both chimneys, step and counter flashing”"
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
      </div>

      <p className={styles.lineAmount}>
        <span>Comes to</span>
        <strong>{amount === null ? "—" : money(amount)}</strong>
      </p>

      <div className="form-actions">
        <Button
          variant="ghost"
          className={styles.takeOff}
          onClick={() => {
            editor.remove(line);
            onClose();
          }}
        >
          Take it off
        </Button>
        <span className="spacer" />
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={q === null || p === null}>Save</Button>
      </div>
    </form>
  );
}
