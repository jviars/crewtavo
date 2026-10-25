/**
 * Products and services: prices and costs that fill quotes, with optional measurement formulas, and
 * a picture of each for the iPad's site visit (the business's own photo, else a drawing of it).
 */
import { PAVING_SAMPLE, PAVING_VARIABLE_NAMES, PAVING_VARIABLES } from "@crewtavo/core/paving";
import { ROOFING_SAMPLE, ROOFING_VARIABLE_NAMES, ROOFING_VARIABLES } from "@crewtavo/core/roofing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { base64Of, packagePicture } from "@/lib/files";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { ServicePicture } from "../roofing/visit/ServicePicture";
import { ImportPriceListDialog } from "./ImportPriceList";
import styles from "./PriceList.module.css";

const SAMPLE = { area_sqft: 1000, area_sqyd: 111.1, length_ft: 100, count: 4, depth_in: 2, pitch_factor: 1.12, waste: 0.1, waste_pct: 10, eave_ft: 120, rake_ft: 80, ridge_ft: 40, hip_ft: 0, valley_ft: 20, ...ROOFING_SAMPLE, ...PAVING_SAMPLE };

export function PriceList() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canEdit = hasRole(session, "admin", "office", "estimator") && can(session, "settings");
  // Search opens the price list on one service (?q=its name).
  const linked = useSearchParams()[0].get("q") ?? "";
  const [term, setTerm] = useState(linked);
  useEffect(() => setTerm(linked), [linked]);
  const [showInactive, setShowInactive] = useState(false);
  const [importing, setImporting] = useState(false);
  const key = ["services", session.company.id, "all"];
  const services = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, category, description, unit, unit_price, unit_cost, taxable, formula, formula_target, active, sort, picture").eq("company_id", session.company.id).order("sort").order("name")),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
  const add = useMutation({
    meta: { success: "Service added. Name it and set the price." },
    mutationFn: async () => unwrap(await supabase().from("services").insert({ company_id: session.company.id, name: "New service", unit: "ea", unit_price: 0, sort: (services.data?.length ?? 0) + 1 })),
    onSuccess: refresh,
  });
  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => unwrap(await supabase().from("services").update(patch as never).eq("id", id)),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<typeof services.data>(key, (old) => old?.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    meta: { success: "Service deleted" },
    mutationFn: async (id: string) => unwrap(await supabase().from("services").delete().eq("id", id)),
    onSuccess: refresh,
  });
  const checkFormula = async (id: string, formula: string, previous: string | null) => {
    const value = formula.trim();
    if ((value || null) === previous) return;
    if (value) {
      try {
        await api.post("/formulas/evaluate", { formula: value, variables: SAMPLE });
      } catch (error) {
        toast.error("That formula doesn't work. Check the spelling, for example area_sqft.");
        return;
      }
    }
    update.mutate({ id, patch: { formula: value || null } });
  };

  const rows = useMemo(
    () => (services.data ?? []).filter((s) => (showInactive || s.active) && `${s.name} ${s.category ?? ""}`.toLowerCase().includes(term.trim().toLowerCase())),
    [services.data, showInactive, term],
  );

  if (services.isPending) return <TableSkeleton columns={6} />;
  if (services.error) return <div className="card"><ErrorState error={services.error} onRetry={() => services.refetch()} /></div>;

  return (
    <div className="stack">
      <div className="toolbar">
        <div className="input-group"><span className="addon"><Icon name="search" size={16} /></span><input className="input" type="search" placeholder="Search services" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search services" /></div>
        <label className="switch-row" style={{ fontWeight: 500 }}><input type="checkbox" className="switch" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />Show hidden</label>
        <span className="grow" />
        <Button icon="download" onClick={() => downloadCsv(`price-list-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(services.data ?? [], [{ key: "name", label: "Name" }, { key: "category", label: "Category" }, { key: "unit", label: "Unit" }, { key: "unit_price", label: "Price" }, { key: "unit_cost", label: "Cost" }, { key: "taxable", label: "Taxable" }, { key: "formula", label: "Formula" }]))}>Download</Button>
        {canEdit && <Button icon="upload" onClick={() => setImporting(true)}>Import</Button>}
        {canEdit && <Button variant="primary" icon="plus" loading={add.isPending} onClick={() => add.mutate()}>Add service</Button>}
      </div>
      {importing && <ImportPriceListDialog existing={(services.data ?? []).map((x) => x.name)} onClose={() => setImporting(false)} />}
      <details className="muted small">
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Using formulas</summary>
        <p style={{ margin: "6px 0 0" }}>A formula fills in the quantity from a map measurement, for example <code>area_sqft * 1.1</code>. You can use area_sqft (square feet), area_sqyd (square yards), length_ft (feet), count, depth_in (inches), pitch_factor and waste, and for roofs eave_ft, rake_ft, ridge_ft, hip_ft and valley_ft (feet of lines marked as those edges on the map).</p>
        <p style={{ margin: "6px 0 0" }}>Roofs add their surface and squares, each section at its own pitch:</p>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {ROOFING_VARIABLE_NAMES.map((name) => <li key={name}><code>{name}</code> {ROOFING_VARIABLES[name]}</li>)}
        </ul>
        <p style={{ margin: "6px 0 0" }}>Paving takeoffs add a value for each item drawn on the map:</p>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {PAVING_VARIABLE_NAMES.map((name) => <li key={name}><code>{name}</code> {PAVING_VARIABLES[name]}</li>)}
        </ul>
      </details>
      {!rows.length ? (
        <div className="card"><EmptyState icon="list" title={term ? "No services match" : "No services yet"} action={canEdit && !term && <Button variant="primary" icon="plus" onClick={() => add.mutate()}>Add your first service</Button>} /></div>
      ) : (
        <div className="card table-scroll">
          <table className="table table-stack">
            <thead><tr><th style={{ width: 96 }}>Picture</th><th style={{ minWidth: 220 }}>Service</th><th style={{ width: 90 }}>Unit</th><th className="num" style={{ width: 130 }}>Price</th><th className="num" style={{ width: 130 }}>Cost</th><th style={{ width: 230 }}>Formula</th><th style={{ width: 120 }} /></tr></thead>
            <tbody>
              {rows.map((s) => {
                const margin = Number(s.unit_price) > 0 && s.unit_cost != null ? Math.round(((Number(s.unit_price) - Number(s.unit_cost)) / Number(s.unit_price)) * 100) : null;
                return (
                  <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
                    <td><PictureCell service={s} canEdit={canEdit} /></td>
                    <td>
                      <input className="input input-sm" defaultValue={s.name} disabled={!canEdit} maxLength={200} onBlur={(e) => { const v = e.target.value.trim(); if (!v) { e.target.value = s.name; toast.error("A service needs a name."); } else if (v !== s.name) update.mutate({ id: s.id, patch: { name: v } }); }} aria-label="Service name" style={{ fontWeight: 700 }} />
                      <input className="input input-sm" defaultValue={s.category ?? ""} disabled={!canEdit} maxLength={60} placeholder="Category" onBlur={(e) => (e.target.value.trim() || null) !== s.category && update.mutate({ id: s.id, patch: { category: e.target.value.trim() || null } })} aria-label="Category" style={{ marginTop: 4, fontSize: 12 }} />
                    </td>
                    <td><input className="input input-sm" defaultValue={s.unit} disabled={!canEdit} maxLength={20} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.unit && update.mutate({ id: s.id, patch: { unit: e.target.value.trim() } })} aria-label="Unit" /></td>
                    <td className="num">{canEdit ? <MoneyInput value={Number(s.unit_price)} width={120} label="Price" onSave={(v) => update.mutate({ id: s.id, patch: { unit_price: v } })} /> : `$${Number(s.unit_price).toFixed(2)}`}</td>
                    <td className="num">
                      {canEdit ? <MoneyInput value={Number(s.unit_cost ?? 0)} width={120} label="Cost" onSave={(v) => update.mutate({ id: s.id, patch: { unit_cost: v || null } })} /> : s.unit_cost ?? "—"}
                      {margin !== null && <div className={`small ${margin < 0 ? "text-danger" : "muted"}`} style={{ marginTop: 2 }}>{margin}% margin</div>}
                    </td>
                    <td>
                      <input className="input input-sm" defaultValue={s.formula ?? ""} disabled={!canEdit} placeholder="None" maxLength={300} onBlur={(e) => checkFormula(s.id, e.target.value, s.formula)} aria-label="Formula" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }} />
                      {s.formula && (
                        <select className="select input-sm" style={{ marginTop: 4, fontSize: 12 }} value={s.formula_target} disabled={!canEdit} onChange={(e) => update.mutate({ id: s.id, patch: { formula_target: e.target.value } })} aria-label="Formula sets">
                          <option value="quantity">Sets the quantity</option>
                          <option value="unit_price">Sets the price</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <div className="stack-sm" style={{ justifyItems: "start" }}>
                        <label className="checkbox small"><input type="checkbox" checked={s.taxable} disabled={!canEdit} onChange={(e) => update.mutate({ id: s.id, patch: { taxable: e.target.checked } })} />Taxable</label>
                        <label className="checkbox small"><input type="checkbox" checked={s.active} disabled={!canEdit} onChange={(e) => update.mutate({ id: s.id, patch: { active: e.target.checked } })} />Show on quotes</label>
                        {canEdit && <button type="button" className="link-btn small" style={{ color: "var(--danger)" }} onClick={async () => (await confirm({ title: `Delete “${s.name}”?`, body: "Existing quotes and invoices keep their lines. To keep it but stop offering it, untick “Show on quotes” instead.", confirmLabel: "Delete", danger: true })) && remove.mutate(s.id)}>Delete</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * An item's picture, as the salesperson sees it on the iPad's site visit: tapped to add or change it
 * (a JPEG made here from the photo, as a package's is), and Remove to go back to the drawing.
 */
function PictureCell({ service, canEdit }: { service: { id: string; name: string; picture: string | null }; canEdit: boolean }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  // The price list, the visit's price list and the packages' quick adds all show it.
  const saved = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["services", company.id] }), queryClient.invalidateQueries({ queryKey: ["roof-packages", company.id] })]);
  const set = useMutation({
    meta: { success: "Picture saved" },
    mutationFn: async (file: File) => {
      const jpeg = await packagePicture(file);
      if (!jpeg) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
      return api.put<{ path: string; width: number; height: number }>(`/services/${service.id}/picture`, { picture: await base64Of(jpeg) });
    },
    onSuccess: saved,
  });
  const remove = useMutation({
    meta: { success: "Picture removed" },
    mutationFn: () => api.delete<{ ok: true }>(`/services/${service.id}/picture`),
    onSuccess: saved,
  });
  return (
    <div className={styles.pictureCell}>
      <button
        type="button"
        className={styles.thumb}
        disabled={!canEdit || set.isPending || remove.isPending}
        aria-label={service.picture ? `Change the picture of ${service.name}` : `Add a picture of ${service.name}`}
        title={canEdit ? (service.picture ? "Change the picture" : "Add a picture") : undefined}
        onClick={() => input.current?.click()}
      >
        <ServicePicture name={service.name} picture={service.picture} />
        {set.isPending ? (
          <span className={styles.thumbBusy}><Spinner size={16} /></span>
        ) : (
          canEdit && <span className={styles.thumbHint}><Icon name="camera" size={13} />{service.picture ? "Change" : "Add"}</span>
        )}
      </button>
      {canEdit && service.picture && (
        <button type="button" className="link-btn small" disabled={remove.isPending || set.isPending} onClick={() => remove.mutate()}>
          Remove
        </button>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) set.mutate(file);
        }}
      />
    </div>
  );
}
