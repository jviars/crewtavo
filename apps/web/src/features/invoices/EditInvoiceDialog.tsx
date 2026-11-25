/**
 * Edit invoice: a sent invoice's lines, changed in place and saved in one step (editInvoice.ts; the
 * database's edit_invoice). The invoice stays on the client's link the whole time, with its
 * payments as they are. What it would come to is the database's own answer (its preview), asked
 * for as the lines are typed, so the figures and the refusals here are the ones saving would give.
 */
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import styles from "./invoices.module.css";
import { editRows, lockedLines, newRow, resultWords, rowsProblem, rowsToLines, type EditResult, type EditRow, type InvoiceLine } from "./editInvoice";

const decimal = (value: string, negative = false) => value.replace(negative ? /[^0-9.-]/g : /[^0-9.]/g, "");

export function EditInvoiceDialog({ invoice, onClose, onSaved }: { invoice: { id: string; number: number | null; updated_at: string; lines: InvoiceLine[] }; onClose: () => void; onSaved: () => void }) {
  // The invoice as it was when this opened: saving is refused if it has changed since (a payment came in).
  const [opened] = useState(() => ({ lines: invoice.lines, updatedAt: invoice.updated_at }));
  const [rows, setRows] = useState<EditRow[]>(() => editRows(opened.lines));
  const locked = useMemo(() => lockedLines(opened.lines), [opened]);
  const problem = rowsProblem(rows, locked.length);
  const lines = useMemo(() => (problem ? null : rowsToLines(rows)), [rows, problem]);
  // Asked a moment after the typing stops.
  const typed = lines ? JSON.stringify(lines) : null;
  const [asked, setAsked] = useState(typed);
  // The lines as they were when this opened: if the database won't take even those, this invoice can't be edited.
  const [first] = useState(typed);
  useEffect(() => {
    const timer = window.setTimeout(() => setAsked(typed), 400);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const edit = async (preview: boolean) =>
    unwrap(await supabase().rpc("edit_invoice", { p_invoice: invoice.id, p_lines: JSON.parse(preview ? asked! : typed!), p_preview: preview, p_updated_at: opened.updatedAt })) as unknown as EditResult;
  const preview = useQuery({
    queryKey: ["invoice-edit", invoice.id, opened.updatedAt, asked],
    enabled: asked !== null,
    queryFn: () => edit(true),
    retry: false,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });
  const save = useMutation({
    meta: { inline: true, success: "Invoice updated", tone: "invoice" },
    mutationFn: () => edit(false),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const change = (key: string, patch: Partial<EditRow>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  // What the database says the lines as typed come to; while it's being asked, the last answer stays up.
  const settled = asked === typed && !preview.isFetching;
  const result = !problem && !preview.error ? preview.data : undefined;
  const refusal = problem ?? (asked === typed && preview.error ? preview.error : null);
  const unchanged = settled && result?.changed === 0;
  // Refused before anything was typed (a deposit the job's final invoice has taken off, say): it says why, and there's nothing to edit.
  const closed = typed === first && asked === first && preview.error ? preview.error : null;

  if (closed) {
    return (
      <Dialog open onClose={onClose} title={`Edit invoice #${invoice.number}`} description="This invoice can't be edited as it stands.">
        <div className="dialog-body stack">
          <FormError error={closed} />
          <div className="form-actions"><Button onClick={onClose}>Close</Button></div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={`Edit invoice #${invoice.number}`} description="Payments on it stay as they are. The client's link shows the new lines as soon as you save." size="xl">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (!refusal && settled && !unchanged) save.mutate(); }} className="stack">
        <div className={styles.editLines}>
          {rows.map((row, index) => (
            <div key={row.key} className={styles.editLine}>
              <div className="row wrap" style={{ gap: 8, alignItems: "flex-end" }}>
                <label className="field grow" style={{ minWidth: 180 }}>
                  <span className="small">Item</span>
                  <input className="input" value={row.name} maxLength={300} onChange={(e) => change(row.key, { name: e.target.value })} aria-label={`Line ${index + 1} name`} />
                </label>
                <label className="field" style={{ width: 84 }}>
                  <span className="small">Qty</span>
                  <DecimalInput className="input" inputMode="decimal" value={row.quantity} onChange={(e) => change(row.key, { quantity: decimal(e.target.value) })} aria-label={`Line ${index + 1} quantity`} />
                </label>
                <label className="field" style={{ width: 84 }}>
                  <span className="small">Unit</span>
                  <input className="input" value={row.unit} maxLength={30} onChange={(e) => change(row.key, { unit: e.target.value })} aria-label={`Line ${index + 1} unit`} />
                </label>
                <label className="field" style={{ width: 120 }}>
                  <span className="small">Price</span>
                  <DecimalInput className="input" inputMode="decimal" value={row.unit_price} placeholder="0.00" onChange={(e) => change(row.key, { unit_price: decimal(e.target.value, true) })} aria-label={`Line ${index + 1} price`} />
                </label>
                <Button icon="trash" variant="ghost" aria-label={`Remove line ${index + 1}`} title="Remove this line" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))} />
              </div>
              <div className="row wrap" style={{ gap: 12 }}>
                <input className="input input-sm grow" style={{ minWidth: 180 }} value={row.description} maxLength={2000} placeholder="Description (optional)" onChange={(e) => change(row.key, { description: e.target.value })} aria-label={`Line ${index + 1} description`} />
                <label className="checkbox"><input type="checkbox" checked={row.taxable} onChange={(e) => change(row.key, { taxable: e.target.checked })} /> Taxable</label>
              </div>
            </div>
          ))}
        </div>
        <div><Button size="sm" icon="plus" onClick={() => setRows((list) => [...list, newRow(list, crypto.randomUUID())])}>Add line</Button></div>
        {locked.length > 0 && (
          <div className={styles.pickGroup}>
            <h3 className={styles.pickHead}>Staying as they are</h3>
            <ul className={styles.picks} role="list">
              {locked.map(({ line, reason }) => (
                <li key={line.id} className={styles.pick} data-static="">
                  <span className={styles.pickText}>
                    <span className={styles.pickName}>{line.name}</span>
                    <span className={styles.pickSub}>{reason}</span>
                  </span>
                  <span className={styles.pickEnd}>{formatMoneyCents(Number(line.quantity) * Number(line.unit_price))}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <FormError error={save.error ?? refusal} />
        <div className="form-actions">
          <span className="muted small" style={{ marginRight: "auto" }} aria-live="polite">
            {result ? resultWords(result) : refusal ? "" : "Working out the total…"}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} disabled={Boolean(refusal) || !settled || unchanged} title={unchanged ? "Nothing has changed yet" : undefined}>Save changes</Button>
        </div>
      </form>
    </Dialog>
  );
}
