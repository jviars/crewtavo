/**
 * Storm prices by depth. The business sets its standard once (Snow → Customers → Standard storm
 * prices): what a storm bills by how much fell, as a multiple of what one push bills the customer.
 * A customer's own prices (SnowSiteDialog) are filled from it, so two alike are priced alike, and
 * stay theirs to change. Both are typed in the same rows, the last one open for anything deeper.
 */
import type { SnowBand } from "@crewtavo/core/snow";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { currencySymbol } from "@/lib/format";
import { useSession } from "@/lib/session";
import { bandsKey } from "./snowData";
import styles from "./snow.module.css";
import { NumberInput } from "@/components/ui/NumberInput";

/** A whole number or a decimal typed into a field, or null for an empty one. */
export const amount = (text: string) => (text.trim() === "" ? null : Number(text));
export const within = (n: number | null, most: number) => n == null || (n > 0 && n <= most);

/** A depth and what it bills, as typed: a price, or a multiple of the push price. */
export interface DepthRow { upTo: string; value: string }
export const depthRow = (upTo: number | null, value: number): DepthRow => ({ upTo: upTo == null ? "" : String(upTo), value: String(value) });

/** The rows as typed, shallowest first, with empty ones left out. Says what's wrong with them (`what`: "storm price"). */
export function readDepths(rows: DepthRow[], what: string): Array<{ up_to_in: number | null; value: number }> {
  const read = rows.filter((r) => r.value.trim() !== "" || r.upTo.trim() !== "").map((r) => ({ up_to_in: amount(r.upTo), value: Number(r.value) }));
  if (read.some((r) => !(r.value >= 0) || !within(r.up_to_in, 100))) throw new Error(`Each ${what} needs an amount, and a depth above 0 if it has one.`);
  if (read.filter((r) => r.up_to_in == null).length > 1) throw new Error(`Only the last ${what} can be left without a depth.`);
  return read.sort((a, b) => (a.up_to_in ?? Infinity) - (b.up_to_in ?? Infinity));
}

/** The rows to type them in, on hairlines. `money`: each is a price; otherwise a multiple of the push price. */
export function DepthRows({ rows, onChange, money, what, addLabel }: { rows: DepthRow[]; onChange: (rows: DepthRow[]) => void; money: boolean; what: string; addLabel: string }) {
  const set = (i: number, change: Partial<DepthRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...change } : r)));
  return (
    <div className={styles.depthList}>
      {rows.length > 0 && (
        <div className={styles.depths}>
          {rows.map((r, i) => (
            <div key={i} className={styles.depth}>
              <span className={styles.depthLabel}>Up to</span>
              <div className="input-group">
                <NumberInput className="input" inputMode="decimal" min={0.1} max={100} step={0.1} value={r.upTo} onChange={(e) => set(i, { upTo: e.target.value })} placeholder="any" aria-label={`${what} ${i + 1}: up to how many inches`} />
                <span className="addon addon-right addon-unit">in</span>
              </div>
              <div className="input-group">
                <span className="addon">{money ? currencySymbol() : "×"}</span>
                <NumberInput className="input" inputMode="decimal" min={0} step={0.01} value={r.value} onChange={(e) => set(i, { value: e.target.value })} aria-label={`${what} ${i + 1}: ${money ? "price" : "times the push price"}`} />
              </div>
              <Button size="sm" variant="ghost" icon="x" className={styles.depthRemove} aria-label={`Remove ${what.toLowerCase()} ${i + 1}`} title="Remove" onClick={() => onChange(rows.filter((_, n) => n !== i))} />
            </div>
          ))}
        </div>
      )}
      {rows.length < 8 && <Button size="sm" variant="ghost" icon="plus" className={styles.depthAdd} onClick={() => onChange([...rows, { upTo: "", value: "" }])}>{rows.length ? "Add another depth" : addLabel}</Button>}
    </div>
  );
}

export function StandardPricesDialog({ saved, onClose }: { saved: SnowBand[]; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState(() => saved.map((b) => depthRow(b.up_to_in, b.times)));
  const save = useMutation({
    meta: { inline: true, success: "Standard storm prices saved" },
    mutationFn: async () => {
      const bands = readDepths(rows, "depth").map((r) => ({ up_to_in: r.up_to_in, times: r.value }));
      unwrap(await supabase().rpc("set_snow_storm_prices", { p_company: company.id, p_bands: bands }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bandsKey(company.id) });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Standard storm prices">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="What a storm bills, by how much fell" hint="Each is a multiple of what one push bills the customer: 1 is the push price, 1.5 is one and a half times it. Leave the last depth empty for anything deeper.">
          <DepthRows rows={rows} onChange={setRows} money={false} what="Depth" addLabel="Add a depth" />
        </Field>
        <p className={styles.partHint}>A snow customer's own storm prices fill from these when you add or edit one. Customers already priced keep their prices until you fill them again.</p>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
