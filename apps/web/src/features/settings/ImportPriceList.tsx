/**
 * Import a price list from a spreadsheet, such as Jobber's Products & Services export: name,
 * description, unit, price, cost, taxable and category. Names already in the price list are skipped.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

const COLUMNS = [
  { key: "name", label: "Name", match: /^(name|item|service|product|product ?\/ ?service|item ?name)$/i },
  { key: "description", label: "Description", match: /^(description|details)$/i },
  { key: "unit", label: "Unit", match: /^(unit|units|unit ?of ?measure|uom)$/i },
  { key: "unit_price", label: "Price", match: /^(price|unit ?price|rate|default ?unit ?price|sell ?price)$/i },
  { key: "unit_cost", label: "Cost", match: /^(cost|unit ?cost|default ?unit ?cost)$/i },
  { key: "taxable", label: "Taxable", match: /^tax(able)?$/i },
  { key: "category", label: "Category", match: /^(category|type|group)$/i },
] as const;
type Key = (typeof COLUMNS)[number]["key"];

const money = (value: string) => {
  const n = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export function ImportPriceListDialog({ existing, onClose }: { existing: string[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Partial<Record<Key, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const headers = rows[0] ?? [];

  const load = async (file: File) => {
    setError(null);
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setError("That file has no rows to import. The first row should be column names.");
    setRows(parsed);
    const guess: Partial<Record<Key, number>> = {};
    for (const c of COLUMNS) {
      const i = parsed[0]!.findIndex((h, idx) => c.match.test(h.trim()) && !Object.values(guess).includes(idx));
      if (i >= 0) guess[c.key] = i;
    }
    setMapping(guess);
  };

  const items = useMemo(() => {
    const have = new Set(existing.map((n) => n.trim().toLowerCase()));
    const get = (row: string[], key: Key) => (mapping[key] === undefined ? "" : (row[mapping[key]!] ?? "").trim());
    const seen = new Set<string>();
    return rows.slice(1).flatMap((row) => {
      const name = get(row, "name").slice(0, 200);
      const k = name.toLowerCase();
      if (!name || have.has(k) || seen.has(k)) return [];
      seen.add(k);
      const taxable = get(row, "taxable").toLowerCase();
      return [{
        name,
        description: get(row, "description") || null,
        unit: (get(row, "unit") || "ea").slice(0, 20),
        unit_price: money(get(row, "unit_price")) ?? 0,
        unit_cost: money(get(row, "unit_cost")),
        taxable: taxable ? !/^(no|n|false|0|non-?taxable|exempt)$/.test(taxable) : true,
        category: get(row, "category") || null,
      }];
    });
  }, [rows, mapping, existing]);

  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      for (let i = 0; i < items.length; i += 200) {
        unwrap(await supabase().from("services").insert(items.slice(i, i + 200).map((s, j) => ({ ...s, company_id: session.company.id, sort: existing.length + i + j + 1 }))));
      }
      return items.length;
    },
    onSuccess: (n) => {
      queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
      toast.success(`Added ${n} ${n === 1 ? "item" : "items"} to the price list`);
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title="Import a price list" size="lg">
      <div className="dialog-body">
        {!rows.length ? (
          <>
            <label className="dropzone">
              <Icon name="upload" size={28} />
              <strong>Choose a spreadsheet (.csv)</strong>
              <span className="small">Column names in the first row: name, description, unit, price, cost, taxable, category.</span>
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
            </label>
            <span className="muted small">From Jobber: Settings → Products & Services → Export, then choose that file here.</span>
          </>
        ) : (
          <>
            <div className="form-grid">
              {COLUMNS.map((c) => (
                <label key={c.key} className="field">
                  <span>{c.label}</span>
                  <select className="select" value={mapping[c.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [c.key]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                    <option value="">Don't import</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="muted small" style={{ margin: 0 }}>{items.length} new {items.length === 1 ? "item" : "items"}. Names already in your price list are skipped.</p>
          </>
        )}
        <FormError error={error ?? run.error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={run.isPending}>Cancel</Button>
          <Button variant="primary" icon="upload" loading={run.isPending} disabled={!items.length} onClick={() => run.mutate()}>Import {items.length || ""}</Button>
        </div>
      </div>
    </Dialog>
  );
}
