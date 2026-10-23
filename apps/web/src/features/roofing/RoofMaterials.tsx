/**
 * The estimate's materials, priced at the business's own ABC Supply account (Apps → ABC Supply):
 * for each line, what goes into it from ABC's catalog, how many to order for this roof (whole
 * bundles, rolls and pieces) and what that comes to, with the labor and the rest beside it.
 *
 * Materials belong to the price list's services, so picking them once prices every roof after.
 * The estimate is priced again by itself whenever its lines, quantities or materials change, and
 * keeps the prices it was priced with (quote_line_items.materials) until then.
 */
import { describePerUnit, lineUnitCost, orderQuantity, type PricedMaterial } from "@crewtavo/core/materials";
import { lineTotal, optionLabels, toCents } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCents, formatNumber, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { useServiceMaterials, useSupplier, uomName, type ServiceMaterial } from "../materials/data";
import { HowMany, MaterialPicker } from "../materials/MaterialPicker";
import type { Line, Quote } from "../paving/ProjectFlow";

interface ServiceCost { id: string; name: string; unit: string; labor_cost: number | null }

/** A material on a line as shown: what to order, at the price the estimate has (or the last one). */
interface Row extends PricedMaterial { link: ServiceMaterial | null }

const sameItems = (line: Line, links: ServiceMaterial[]) => {
  const items = line.materials?.items ?? [];
  return items.length === links.length && items.every((item, i) => item.item_number === links[i]!.item_number && item.uom === links[i]!.uom && Number(item.per_unit) === Number(links[i]!.per_unit) && Number(item.length_ft ?? 0) === Number(links[i]!.length_ft ?? 0));
};

export function RoofMaterials({ quote, editable, onChanged }: { quote: Quote; editable: boolean; onChanged: () => void }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const canSetUp = hasRole(session, "admin") && can(session, "apps");
  const canEdit = editable && hasRole(session, "admin", "office", "estimator") && can(session, "settings");
  const supplier = useSupplier();
  const lines = quote.lines.filter((l) => l.service_id);
  const serviceIds = lines.map((l) => l.service_id!);
  const links = useServiceMaterials(serviceIds);
  const services = useQuery({
    queryKey: ["service-costs", company.id, [...new Set(serviceIds)].sort()],
    enabled: serviceIds.length > 0,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, unit, labor_cost").in("id", [...new Set(serviceIds)])) as ServiceCost[],
  });
  const linksOf = useMemo(() => {
    const map = new Map<string, ServiceMaterial[]>();
    for (const link of links.data ?? []) map.set(link.service_id, [...(map.get(link.service_id) ?? []), link]);
    return (serviceId: string | null) => (serviceId ? (map.get(serviceId) ?? []) : []);
  }, [links.data]);
  const serviceOf = (id: string | null) => services.data?.find((s) => s.id === id);

  const refreshMaterials = () => {
    queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
    queryClient.invalidateQueries({ queryKey: ["service-costs", company.id] });
    queryClient.invalidateQueries({ queryKey: ["services", company.id] });
  };
  const price = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ priced_at: string | null }>(`/quotes/${quote.id}/material-prices`),
    onSuccess: () => {
      refreshMaterials();
      onChanged();
    },
  });

  // Lines whose materials, quantity or labor changed since they were priced get priced again, once
  // for each change, so a failure (ABC down) doesn't keep asking.
  const connected = supplier.data?.status === "connected";
  const ready = connected && editable && links.isSuccess && services.isSuccess;
  const stale = ready
    ? lines.filter((l) => {
        const own = linksOf(l.service_id);
        if (!own.length) return Boolean(l.materials);
        if (!l.materials || l.materials.line_quantity !== Number(l.quantity) || !sameItems(l, own)) return true;
        return l.unit_cost === null || Number(l.unit_cost) !== lineUnitCost(Number(l.material_cost ?? 0), serviceOf(l.service_id)?.labor_cost ?? null, l.quantity);
      })
    : [];
  const signature = stale.map((l) => `${l.id}:${l.quantity}:${linksOf(l.service_id).map((m) => `${m.id}/${m.per_unit}`).join(",")}:${serviceOf(l.service_id)?.labor_cost}`).join("|");
  const tried = useRef("");
  useEffect(() => {
    if (!signature || signature === tried.current || price.isPending) return;
    tried.current = signature;
    price.mutate();
  }, [signature, price]);

  const [picking, setPicking] = useState<Line | null>(null);
  const [editing, setEditing] = useState<{ link: ServiceMaterial; unit: string } | null>(null);
  const remove = useMutation({
    meta: { success: (_: unknown, link: ServiceMaterial) => `${link.name} taken out` },
    mutationFn: (link: ServiceMaterial) => api.delete(`/services/${link.service_id}/materials/${link.id}`),
    onSettled: refreshMaterials,
  });
  const labor = useMutation({
    meta: { success: "Labor updated" },
    mutationFn: ({ serviceId, value }: { serviceId: string; value: number }) => api.put(`/services/${serviceId}/labor`, { labor_cost: value }),
    onSettled: refreshMaterials,
  });

  if (supplier.isPending || !lines.length) return null;
  const anyPriced = lines.some((l) => l.materials);
  const anyLinks = lines.some((l) => linksOf(l.service_id).length);

  // Not connected and nothing priced yet: what ABC Supply would do here.
  if (!supplier.data && !anyPriced) {
    return (
      <div className="callout" role="note">
        <Icon name="truck" size={18} />
        <span className="grow stack-sm" style={{ gap: 6 }}>
          <span>See exactly what this roof's materials cost. Connect your ABC Supply account and every bundle, roll and piece is priced at your branch, at your prices.</span>
          {canSetUp ? <Link className="btn btn-sm" style={{ justifySelf: "start" }} to="/apps/abc_supply">Set up ABC Supply</Link> : <span className="muted small" style={{ fontWeight: 400 }}>An owner or admin can install ABC Supply in Apps.</span>}
        </span>
      </div>
    );
  }

  const choices = optionLabels(quote.lines);
  /** What's on a line: from its materials as they are now while it can change, or as it was priced once it can't. */
  const rowsOf = (line: Line): Row[] => {
    const priced = line.materials?.items ?? [];
    if (!editable) return priced.map((item) => ({ ...item, link: null }));
    return linksOf(line.service_id).map((link) => {
      const quantity = orderQuantity(line.quantity, link.per_unit);
      const was = priced.find((p) => p.item_number === link.item_number && p.uom === link.uom);
      const unitPrice = was ? was.unit_price : link.unit_price !== null && Number(link.unit_price) > 0 ? Number(link.unit_price) : null;
      return {
        item_number: link.item_number,
        name: link.name,
        uom: link.uom,
        uom_name: link.uom_name,
        per_unit: Number(link.per_unit),
        length_ft: link.length_ft,
        quantity,
        unit_price: unitPrice,
        total: unitPrice === null ? null : lineTotal(quantity, unitPrice),
        note: unitPrice === null ? (was?.note ?? link.price_note ?? "No price yet") : null,
        link,
      };
    });
  };
  const counts = (l: Line) => !l.optional || l.selected;
  const lineCost = (rows: Row[]) => rows.reduce((t, r) => t + toCents(r.total ?? 0), 0) / 100;
  const shown = lines.map((line) => ({ line, rows: rowsOf(line) }));
  const total = shown.reduce((t, s) => t + (counts(s.line) ? toCents(lineCost(s.rows)) : 0), 0) / 100;
  const unpriced = shown.some((s) => counts(s.line) && s.rows.some((r) => r.total === null && r.quantity > 0));
  const pricedAt = lines.map((l) => l.materials?.priced_at).filter((d): d is string => Boolean(d)).sort().at(-1);
  // Branch names already say ABC Supply ("ABC Supply - Lexington, KY").
  const branch = supplier.data ? (/abc/i.test(supplier.data.branch_name) ? supplier.data.branch_name : `ABC Supply, ${supplier.data.branch_name}`) : null;
  const where = branch && supplier.data?.environment === "sandbox" ? `${branch} (ABC's sandbox test prices)` : branch;

  return (
    <section className="stack-sm" style={{ gap: 10 }} aria-labelledby="roof-materials">
      <div className="material-summary">
        <span className="grow">
          <strong id="roof-materials">Materials for this roof</strong>
          <span className="muted small">
            {where ?? "ABC Supply isn't connected, so these are the last prices"}
            {price.isPending ? " · getting today's prices…" : pricedAt ? ` · priced ${timeAgo(pricedAt)}` : ""}
            {editable && connected && anyLinks && !price.isPending && <> · <button type="button" className="link-btn small" onClick={() => price.mutate()}>Update prices</button></>}
          </span>
        </span>
        <strong className="num material-total">{formatMoney(total)}{unpriced ? "+" : ""}</strong>
      </div>
      {supplier.data?.status === "error" && (
        <span className="field-error" role="alert">
          {supplier.data.last_error ?? "ABC Supply needs attention."} {canSetUp && <Link to="/apps/abc_supply">Open ABC Supply</Link>}
        </span>
      )}
      {price.error && <span className="field-error" role="alert">{(price.error as Error).message}</span>}
      {!anyLinks && editable && (
        <span className="muted small">Add what goes into each line from ABC's catalog: the shingles, underlayment and starter for the roof, the drip edge for the edges. You pick them once; every roof after is priced the same way.</span>
      )}

      <div className="material-lines">
        {shown.map(({ line, rows }) => {
          const service = serviceOf(line.service_id);
          const unit = service?.unit ?? line.unit;
          const choice = choices.get(line.id);
          const own = linksOf(line.service_id);
          return (
            <div key={line.id} className="material-line" data-optional={!counts(line) || undefined}>
              <div className="material-line-head">
                <strong className="grow">{choice && <span className="chip chip-blue estimate-choice">{choice}</span>}{line.name}</strong>
                <span className="muted small nowrap">{formatNumber(Number(line.quantity), Number(line.quantity) < 100 ? 1 : 0)} {line.unit}</span>
                <strong className="num">{rows.length ? formatMoney(lineCost(rows)) : <span className="muted">—</span>}</strong>
              </div>
              {rows.length > 0 && (
                <ul className="material-items">
                  {rows.map((row) => (
                    <li key={`${row.item_number}:${row.uom}:${row.link?.id ?? ""}`}>
                      <span className="grow">
                        <span>{row.name}</span>
                        <span className="muted small">{row.item_number}{row.length_ft ? ` · ${formatNumber(row.length_ft, 2)} ft` : ""} · {describePerUnit(row.per_unit, row.uom_name ?? row.uom, unit)}</span>
                      </span>
                      <span className="num nowrap small">
                        {formatNumber(row.quantity)} {uomName(row)}{row.quantity === 1 ? "" : "s"} × {row.unit_price === null ? <span className="muted" title={row.note ?? undefined}>call for price</span> : formatMoneyCents(row.unit_price)}
                      </span>
                      <strong className="num">{row.total === null ? <span className="muted">—</span> : formatMoney(row.total)}</strong>
                      {canEdit && row.link && (
                        <span className="material-actions">
                          <button type="button" className="icon-btn" aria-label={`Change how many ${row.name} per ${unit}`} onClick={() => setEditing({ link: row.link!, unit })}><Icon name="edit" size={15} /></button>
                          <button type="button" className="icon-btn" aria-label={`Take ${row.name} out of ${line.name}`} disabled={remove.isPending} onClick={() => remove.mutate(row.link!)}><Icon name="x" size={15} /></button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && connected && service && (
                <div className="row wrap material-line-foot">
                  <button type="button" className="link-btn small" onClick={() => setPicking(line)}><Icon name="plus" size={14} /> {own.length ? "Add another material" : "Add materials from ABC"}</button>
                  {own.length > 0 && (
                    <span className="row small" style={{ gap: 8 }}>
                      <span className="muted">Labor and the rest</span>
                      <MoneyInput value={Number(service.labor_cost ?? 0)} width={110} label={`Labor and the rest per ${unit} for ${line.name}`} onSave={(value) => labor.mutate({ serviceId: service.id, value })} />
                      <span className="muted">per {unit}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {unpriced && <span className="muted small">The branch hasn't priced everything yet ("call for price"), so the materials total is at least this much. Call the branch, or pick another item.</span>}

      {picking && serviceOf(picking.service_id) && (
        <MaterialPicker
          service={{ id: picking.service_id!, name: serviceOf(picking.service_id)!.name, unit: serviceOf(picking.service_id)!.unit }}
          lineQuantity={Number(picking.quantity)}
          onClose={() => setPicking(null)}
          onAdded={refreshMaterials}
        />
      )}
      {editing && <PerUnitDialog link={editing.link} unit={editing.unit} onClose={() => setEditing(null)} onSaved={refreshMaterials} />}
    </section>
  );
}

/** How many of a material go into a unit, changed. */
function PerUnitDialog({ link, unit, onClose, onSaved }: { link: ServiceMaterial; unit: string; onClose: () => void; onSaved: () => void }) {
  const [perUnit, setPerUnit] = useState(Number(link.per_unit));
  const save = useMutation({
    meta: { inline: true, success: `${link.name} changed` },
    mutationFn: () => api.patch(`/services/${link.service_id}/materials/${link.id}`, { per_unit: perUnit }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={link.name} description={`${link.item_number} · how many go into each ${unit}`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (perUnit > 0) save.mutate(); }}>
        <HowMany perUnit={perUnit} onChange={setPerUnit} uom={{ code: link.uom, name: link.uom_name ?? link.uom }} serviceUnit={unit} />
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!(perUnit > 0)}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
