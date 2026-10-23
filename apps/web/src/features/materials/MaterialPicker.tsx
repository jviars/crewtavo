/**
 * Adding a material to a service, from the supplier's catalog: search, pick the item, then say how
 * many go into one unit of the service ("3 bundles per square", "1 roll per 10 squares"). The guess
 * comes from how ABC describes the item, and the dialog shows what this estimate would order.
 */
import { describePerUnit, orderQuantity, suggestPerUnit } from "@crewtavo/core/materials";
import { lineTotal } from "@crewtavo/core/money";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { formatMoney, formatMoneyCents, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { searchFor, type CatalogItem, type CatalogUom } from "./data";
import { MaterialSearch } from "./MaterialSearch";

export interface PickerService { id: string; name: string; unit: string }

export function MaterialPicker({ service, lineQuantity, onClose, onAdded }: { service: PickerService; lineQuantity: number | null; onClose: () => void; onAdded: () => void }) {
  const [item, setItem] = useState<CatalogItem | null>(null);
  return (
    <Dialog open onClose={onClose} size="lg" title={`Materials for ${service.name}`} description={item ? "Check how many it takes, then add it." : "Pick what goes into it from ABC Supply's catalog, at your prices at your branch."}>
      {item ? (
        <AddMaterial service={service} item={item} lineQuantity={lineQuantity} onBack={() => setItem(null)} onAdded={() => { onAdded(); onClose(); }} />
      ) : (
        <div className="dialog-body stack">
          <MaterialSearch initial={searchFor(service.name)} onPick={setItem} autoFocus />
        </div>
      )}
    </Dialog>
  );
}

function AddMaterial({ service, item, lineQuantity, onBack, onAdded }: { service: PickerService; item: CatalogItem; lineQuantity: number | null; onBack: () => void; onAdded: () => void }) {
  const { company } = useSession();
  const [uom, setUom] = useState(item.uom);
  const [length, setLength] = useState<number | null>(null);
  const units = item.uoms.length ? item.uoms : [{ code: item.uom, name: item.uom, role: null }];
  const unit = units.find((u) => u.code === uom) ?? units[0]!;
  const [perUnit, setPerUnit] = useState(() => suggestPerUnit(`${item.name} ${item.family ?? ""}`, uom, service.unit).per_unit);
  // The item again for another unit or length: its lengths, and its price that way.
  const detail = useQuery({
    queryKey: ["material-item", company.id, item.item_number, uom, length],
    enabled: item.dimensional || uom !== item.uom,
    queryFn: () => api.get<{ item: CatalogItem & { lengths: number[] }; length_ft: number | null; unit_price: number | null; note: string | null }>(`/materials/items/${encodeURIComponent(item.item_number)}?${new URLSearchParams({ uom, ...(length ? { length_ft: String(length) } : {}) })}`),
  });
  const lengths = detail.data?.item.lengths ?? [];
  const chosenLength = item.dimensional ? (length ?? detail.data?.length_ft ?? null) : null;
  const price = item.dimensional || uom !== item.uom ? (detail.data?.unit_price ?? null) : item.unit_price;
  const note = item.dimensional || uom !== item.uom ? detail.data?.note : item.note;

  const add = useMutation({
    meta: { inline: true, success: `${item.name} added to ${service.name}` },
    mutationFn: () => api.post(`/services/${service.id}/materials`, { item_number: item.item_number, uom, per_unit: perUnit, length_ft: chosenLength }),
    onSuccess: onAdded,
  });
  const order = lineQuantity !== null ? orderQuantity(lineQuantity, perUnit) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (perUnit > 0) add.mutate();
  };
  return (
    <form onSubmit={submit}>
      <div className="material-picked">
        <strong>{item.name}</strong>
        <span className="muted small">{[item.item_number, item.color, price !== null ? `${formatMoneyCents(price)} / ${unit.name.toLowerCase()}` : (note ?? (detail.isPending ? "Getting the price…" : null))].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
        {units.length > 1 && (
          <Field label="Priced by the">
            <select className="select" value={uom} onChange={(e) => { setUom(e.target.value); setPerUnit(suggestPerUnit(`${item.name} ${item.family ?? ""}`, e.target.value, service.unit).per_unit); }}>
              {units.map((u) => <option key={u.code} value={u.code}>{u.name}{u.role === "stocking" ? " (how it's ordered)" : ""}</option>)}
            </select>
          </Field>
        )}
        {item.dimensional && (
          <Field label="Length">
            <select className="select" value={chosenLength ?? ""} onChange={(e) => setLength(Number(e.target.value) || null)} disabled={!lengths.length}>
              {!lengths.length && <option value="">{detail.isPending ? "Loading lengths…" : "No lengths listed"}</option>}
              {lengths.map((l) => <option key={l} value={l}>{formatNumber(l, 2)} ft</option>)}
            </select>
          </Field>
        )}
      </div>
      <HowMany perUnit={perUnit} onChange={setPerUnit} uom={unit} serviceUnit={service.unit} />
      {order !== null && order > 0 && (
        <div className="callout" role="status">
          <span className="grow">
            For this estimate: <strong>{formatNumber(order)} {unit.name.toLowerCase()}{order === 1 ? "" : "s"}</strong>
            {price !== null ? <> × {formatMoneyCents(price)} = <strong>{formatMoney(lineTotal(order, price))}</strong></> : null}
            <span className="muted small" style={{ display: "block" }}>{formatNumber(lineQuantity!, 1)} {service.unit} × {describePerUnit(perUnit, unit.name, service.unit)}, rounded up to whole ones.</span>
          </span>
        </div>
      )}
      <FormError error={add.error} />
      <div className="form-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" icon="plus" loading={add.isPending} disabled={!(perUnit > 0) || (item.dimensional && !chosenLength)}>Add to {service.name}</Button>
      </div>
    </form>
  );
}

/**
 * How many of an item go into one unit of a service: "3 bundles per square", or for something that
 * covers more than a unit, "1 roll covers 10 squares". Either way it's kept as how many per unit.
 */
export function HowMany({ perUnit, onChange, uom, serviceUnit }: { perUnit: number; onChange: (perUnit: number) => void; uom: CatalogUom | { code: string; name: string }; serviceUnit: string }) {
  const [covers, setCovers] = useState(perUnit > 0 && perUnit < 1);
  const [draft, setDraft] = useState(() => String(round(covers ? 1 / perUnit : perUnit)));
  const name = uom.name.toLowerCase();
  const set = (text: string, coverMode = covers) => {
    setDraft(text);
    const n = Number(text);
    onChange(n > 0 ? (coverMode ? 1 / n : n) : 0);
  };
  const switchMode = (next: boolean) => {
    setCovers(next);
    const n = Number(draft);
    if (n > 0) set(String(round(1 / n)), next);
  };
  return (
    <Field label="How many?" hint={perUnit > 0 ? `Kept as ${describePerUnit(perUnit, uom.name, serviceUnit)}.` : "Type how many."}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="segmented" role="group" aria-label="How to say it">
          <button type="button" aria-pressed={!covers} onClick={() => switchMode(false)}>Per {serviceUnit}</button>
          <button type="button" aria-pressed={covers} onClick={() => switchMode(true)}>One covers</button>
        </div>
        {covers ? (
          <span className="row" style={{ gap: 8 }}>
            One {name} covers
            <input className="input" style={{ width: 90 }} inputMode="decimal" value={draft} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={`How many ${serviceUnit} one ${name} covers`} />
            {serviceUnit}
          </span>
        ) : (
          <span className="row" style={{ gap: 8 }}>
            <input className="input" style={{ width: 90 }} inputMode="decimal" value={draft} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={`How many ${name}s per ${serviceUnit}`} />
            {name}s per {serviceUnit}
          </span>
        )}
      </div>
    </Field>
  );
}

const round = (n: number) => Math.round(n * 1000) / 1000;
