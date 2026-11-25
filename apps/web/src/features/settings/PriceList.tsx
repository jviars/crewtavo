/**
 * Products and services: prices and costs that fill quotes, with optional measurement formulas, and
 * a picture of each for the iPad's site visit (the business's own photo, else a drawing of it).
 */
import { usesDepth } from "@crewtavo/core/formulas";
import { LAWN_SAMPLE, LAWN_VARIABLE_NAMES, LAWN_VARIABLES } from "@crewtavo/core/lawn";
import { PAVING_SAMPLE, PAVING_VARIABLE_NAMES, PAVING_VARIABLES } from "@crewtavo/core/paving";
import { ROOFING_SAMPLE, ROOFING_VARIABLE_NAMES, ROOFING_VARIABLES } from "@crewtavo/core/roofing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { InboxSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { base64Of, packagePicture } from "@/lib/files";
import { formatMoneyCents } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { ServicePicture } from "../roofing/visit/ServicePicture";
import { ImportPriceListDialog } from "./ImportPriceList";
import { SettingsActions } from "./SettingsKit";
import styles from "./PriceList.module.css";
import { Select } from "@/components/ui/Select";

/** A depth typed for an item: the inches, null for none, or undefined when it isn't a depth (services.default_depth_in takes over 0 up to 48). */
export function itemDepth(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const depth = Number(text);
  return Number.isFinite(depth) && depth > 0 && depth <= 48 ? Math.round(depth * 100) / 100 : undefined;
}

const SAMPLE = { area_sqft: 1000, area_sqyd: 111.1, length_ft: 100, count: 4, depth_in: 2, pitch_factor: 1.12, waste: 0.1, waste_pct: 10, eave_ft: 120, rake_ft: 80, ridge_ft: 40, hip_ft: 0, valley_ft: 20, ...LAWN_SAMPLE, ...ROOFING_SAMPLE, ...PAVING_SAMPLE };

export function PriceList() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canEdit = hasRole(session, "admin", "office", "estimator") && can(session, "settings");
  // Search opens the price list on one service (?q=its name).
  const linked = useSearchParams()[0].get("q") ?? "";
  const [term, setTerm] = useState(linked);
  useEffect(() => setTerm(linked), [linked]);
  // Which items show: the ones offered on quotes (as before), the hidden ones, or all of them.
  const [show, setShow] = useState<"active" | "hidden" | "all">("active");
  const [importing, setImporting] = useState(false);
  const key = ["services", session.company.id, "all"];
  const services = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, category, description, unit, unit_price, unit_cost, taxable, formula, formula_target, default_depth_in, active, add_to_every_job, sort, picture").eq("company_id", session.company.id).order("sort").order("name")),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
  const add = useMutation({
    mutationFn: async () => unwrap(await supabase().from("services").insert({ company_id: session.company.id, name: "New service", unit: "ea", unit_price: 0, sort: (services.data?.length ?? 0) + 1 })),
    onSuccess: () => {
      toast.success("Service added", { description: "Name it and set the price." });
      return refresh();
    },
  });
  // Each field saves when it's left, and the toolbar says so.
  const saving = useSaveStatus();
  const update = useMutation({
    meta: { inline: true },
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => unwrap(await supabase().from("services").update(patch as never).eq("id", id)),
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<typeof services.data>(key, (old) => old?.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    },
    onSettled: refresh,
  });
  const change = (args: { id: string; patch: Record<string, unknown> }) => void saving.track(update.mutateAsync(args));
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("services").delete().eq("id", id)),
    onSettled: refresh,
  });
  type Service = NonNullable<typeof services.data>[number];
  // Gone at once, with Undo. Quotes and invoices keep their lines either way.
  const deleteService = (service: Service) =>
    undoable({
      title: "Service deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Service[]>(key, (old) => old?.filter((s) => s.id !== service.id));
      },
      restore: () =>
        queryClient.setQueryData<Service[]>(key, (old) => (old && !old.some((s) => s.id === service.id) ? [...old, service].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)) : old)),
      commit: () => remove.mutateAsync(service.id),
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
    change({ id, patch: { formula: value || null } });
  };

  const all = services.data ?? [];
  const counts = { active: all.filter((s) => s.active).length, hidden: all.filter((s) => !s.active).length, all: all.length };
  const rows = useMemo(
    () => (services.data ?? []).filter((s) => (show === "all" || (show === "hidden" ? !s.active : s.active)) && `${s.name} ${s.category ?? ""}`.toLowerCase().includes(term.trim().toLowerCase())),
    [services.data, show, term],
  );
  const groups = useMemo(() => byCategory(rows), [rows]);

  if (services.isPending) return <Loading label="Loading your price list"><InboxSkeleton rows={6} /></Loading>;
  if (services.error) return <ErrorState error={services.error} onRetry={() => services.refetch()} />;

  const download = () =>
    downloadCsv(`price-list-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(all, [{ key: "name", label: "Name" }, { key: "category", label: "Category" }, { key: "unit", label: "Unit" }, { key: "unit_price", label: "Price" }, { key: "unit_cost", label: "Cost" }, { key: "taxable", label: "Taxable" }, { key: "formula", label: "Formula" }]));

  return (
    <>
      <SettingsActions>
        <Menu
          label="More for the price list"
          title="Price list"
          triggerClassName="btn btn-icon"
          items={[
            { label: "Download as a spreadsheet", icon: "download", onSelect: download },
            { label: "Import from a spreadsheet", icon: "upload", hidden: !canEdit, onSelect: () => setImporting(true) },
          ]}
        />
        {canEdit && <Button variant="primary" icon="plus" loading={add.isPending} onClick={() => add.mutate()}>Add service</Button>}
      </SettingsActions>
      {importing && <ImportPriceListDialog existing={all.map((x) => x.name)} onClose={() => setImporting(false)} />}

      <div className={styles.list}>
        <Toolbar
          filters={
            <FilterTabs
              label="Show services"
              value={show}
              onChange={setShow}
              options={[
                { value: "active", label: "On quotes", count: counts.active },
                { value: "hidden", label: "Hidden", count: counts.hidden, hidden: !counts.hidden && show !== "hidden" },
                { value: "all", label: "All", count: counts.all },
              ]}
            />
          }
          search={<SearchField value={term} onChange={setTerm} placeholder="Search services" label="Search services" />}
          tools={<SaveStatus status={saving.status} />}
        />

        {!rows.length ? (
          <EmptyState inline title={term ? "No services match" : show === "hidden" ? "No hidden services" : "No services yet"} action={canEdit && !term && show !== "hidden" && <Button onClick={() => add.mutate()}>Add a service</Button>} />
        ) : (
          <div className={styles.table}>
            <div className={styles.head} aria-hidden="true">
              <span className={styles.cellService}>Service</span>
              <span className={styles.cellUnit}>Unit</span>
              <span className={styles.cellPrice}>Price</span>
              <span className={styles.cellCost}>Cost</span>
              <span className={styles.cellFormula}>Formula</span>
            </div>
            {groups.map((g) => (
              <Group key={g.label} label={g.label} count={groups.length > 1 ? g.rows.length : undefined}>
                {g.rows.map((s) => (
                  <ServiceRow key={s.id} service={s} canEdit={canEdit} onChange={change} onFormula={checkFormula} onDelete={() => deleteService(s)} />
                ))}
              </Group>
            ))}
          </div>
        )}

        <details className={styles.help}>
          <summary>How formulas work</summary>
          <div className={styles.helpBody}>
            <p>A formula fills in the quantity from a map measurement, for example <code>area_sqft * 1.1</code>. One that uses only the area also prices a line on a job or a quote from a size you type there. You can use area_sqft (square feet), area_sqyd (square yards), length_ft (feet), count, depth_in (inches), pitch_factor and waste, and for roofs eave_ft, rake_ft, ridge_ft, hip_ft and valley_ft (feet of lines marked as those edges on the map).</p>
            <p>Lawns add the ground's slope and what's marked on the map as lawn items. For example, <code>max(45, area_sqft / 1000 * 4.5) * (1 + steep_pct / 100) + trees * 2</code> doubles the price of the steep part and adds $2 a tree:</p>
            <ul>
              {LAWN_VARIABLE_NAMES.map((name) => <li key={name}><code>{name}</code> {LAWN_VARIABLES[name]}</li>)}
            </ul>
            <p>Roofs add their surface and squares, each section at its own pitch:</p>
            <ul>
              {ROOFING_VARIABLE_NAMES.map((name) => <li key={name}><code>{name}</code> {ROOFING_VARIABLES[name]}</li>)}
            </ul>
            <p>Paving takeoffs add a value for each item drawn on the map:</p>
            <ul>
              {PAVING_VARIABLE_NAMES.map((name) => <li key={name}><code>{name}</code> {PAVING_VARIABLES[name]}</li>)}
            </ul>
          </div>
        </details>
      </div>
    </>
  );
}

/** A price list item as the list reads it. */
type ServiceRowData = {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  unit_price: number | string;
  unit_cost: number | string | null;
  taxable: boolean;
  formula: string | null;
  formula_target: string;
  default_depth_in: number | null;
  active: boolean;
  add_to_every_job: boolean;
  picture: string | null;
};

/** The items under their categories, in the order the first of each comes; those with none last. */
export function byCategory<T extends { category: string | null }>(rows: T[]): Array<{ label: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const label = row.category?.trim() || "";
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  const named = [...groups.entries()].filter(([label]) => label);
  const none = groups.get("");
  return [...named.map(([label, list]) => ({ label, rows: list })), ...(none ? [{ label: named.length ? "No category" : "Services", rows: none }] : [])];
}

/** One category: its heading and its items, which slide in and out as they're added and deleted. */
function Group({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const list = useListAnimation<HTMLUListElement>();
  const id = useId();
  return (
    <section className={styles.group} aria-labelledby={id}>
      <div className="il-head">
        <h3 className="il-head-label" id={id}>{label}</h3>
        {count !== undefined && <span className="il-count">{count}</span>}
      </div>
      <ul className={styles.rows} role="list" ref={list}>{children}</ul>
    </section>
  );
}

/**
 * One item, edited where it is: each field saves when it's left. Its picture (as the iPad's site
 * visit shows it) changes when tapped; whether it's taxed, offered on quotes and added to every job
 * are in its menu, and say so under its name when they're not the usual.
 */
function ServiceRow({ service: s, canEdit, onChange, onFormula, onDelete }: {
  service: ServiceRowData;
  canEdit: boolean;
  onChange: (args: { id: string; patch: Record<string, unknown> }) => void;
  onFormula: (id: string, formula: string, previous: string | null) => void;
  onDelete: () => void;
}) {
  const picture = usePicture(s);
  const margin = Number(s.unit_price) > 0 && s.unit_cost != null ? Math.round(((Number(s.unit_price) - Number(s.unit_cost)) / Number(s.unit_price)) * 100) : null;
  const flags = [!s.active && "Hidden", !s.taxable && "Not taxed", s.add_to_every_job && "On every job"].filter(Boolean) as string[];
  return (
    <li className={styles.row} data-hidden={!s.active || undefined}>
      <div className={styles.cellThumb}>
        <button
          type="button"
          className={styles.thumb}
          disabled={!canEdit || picture.busy}
          aria-label={s.picture ? `Change the picture of ${s.name}` : `Add a picture of ${s.name}`}
          title={canEdit ? (s.picture ? "Change the picture" : "Add a picture") : undefined}
          onClick={picture.open}
        >
          <ServicePicture name={s.name} picture={s.picture} />
          {picture.adding ? (
            <span className={styles.thumbBusy}><Spinner size={16} /></span>
          ) : (
            canEdit && <span className={styles.thumbHint}><Icon name="camera" size={13} />{s.picture ? "Change" : "Add"}</span>
          )}
        </button>
        {picture.input}
      </div>
      <div className={styles.cellService}>
        <input className={`input input-sm ${styles.name}`} defaultValue={s.name} disabled={!canEdit} maxLength={200} onBlur={(e) => { const v = e.target.value.trim(); if (!v) { e.target.value = s.name; toast.error("A service needs a name."); } else if (v !== s.name) onChange({ id: s.id, patch: { name: v } }); }} aria-label="Service name" />
        <div className={styles.under}>
          <input className={`input input-sm ${styles.category}`} defaultValue={s.category ?? ""} disabled={!canEdit} maxLength={60} placeholder="Category" onBlur={(e) => (e.target.value.trim() || null) !== s.category && onChange({ id: s.id, patch: { category: e.target.value.trim() || null } })} aria-label="Category" />
          {flags.map((f) => <span key={f} className={styles.flag}>{f}</span>)}
        </div>
      </div>
      <label className={styles.cellUnit}>
        <span className={styles.cellLabel}>Unit</span>
        <input className="input input-sm" defaultValue={s.unit} disabled={!canEdit} maxLength={20} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== s.unit && onChange({ id: s.id, patch: { unit: e.target.value.trim() } })} aria-label="Unit" />
      </label>
      <div className={styles.cellPrice}>
        <span className={styles.cellLabel} aria-hidden="true">Price</span>
        {canEdit ? <MoneyInput value={Number(s.unit_price)} width={110} label="Price" onSave={(v) => onChange({ id: s.id, patch: { unit_price: v } })} /> : <span className={styles.money}>{formatMoneyCents(Number(s.unit_price))}</span>}
      </div>
      <div className={styles.cellCost}>
        <span className={styles.cellLabel} aria-hidden="true">Cost</span>
        {canEdit ? <MoneyInput value={Number(s.unit_cost ?? 0)} width={110} label="Cost" onSave={(v) => onChange({ id: s.id, patch: { unit_cost: v || null } })} /> : s.unit_cost != null && <span className={styles.money}>{formatMoneyCents(Number(s.unit_cost))}</span>}
        {margin !== null && <span className={styles.margin} data-tone={margin < 0 ? "danger" : undefined}>{margin}% margin</span>}
      </div>
      <div className={styles.cellFormula}>
        <span className={styles.cellLabel} aria-hidden="true">Formula</span>
        <input className={`input input-sm ${styles.formula}`} defaultValue={s.formula ?? ""} disabled={!canEdit} placeholder="None" maxLength={300} onBlur={(e) => onFormula(s.id, e.target.value, s.formula)} aria-label="Formula" />
        {s.formula && (
          <Select className={`select input-sm ${styles.small}`} value={s.formula_target} disabled={!canEdit} onChange={(e) => onChange({ id: s.id, patch: { formula_target: e.target.value } })} aria-label="Formula sets">
            <option value="quantity">Sets the quantity</option>
            <option value="unit_price">Sets the price</option>
          </Select>
        )}
        {usesDepth(s.formula) && (
          <label className={styles.depth} title="The depth this item's formula starts with when a drawing fills a quote. Each line's depth is shown to confirm then.">
            Depth
            <input
              key={s.default_depth_in ?? "none"}
              className="input input-sm"
              inputMode="decimal"
              defaultValue={s.default_depth_in ?? ""}
              disabled={!canEdit}
              placeholder="Any"
              aria-label={`${s.name}: depth in inches`}
              onBlur={(e) => {
                const depth = itemDepth(e.target.value);
                if (depth === undefined) {
                  toast.error("A depth is more than 0 and at most 48 inches.");
                  e.target.value = s.default_depth_in == null ? "" : String(s.default_depth_in);
                } else if (depth !== (s.default_depth_in ?? null)) onChange({ id: s.id, patch: { default_depth_in: depth } });
              }}
            />
            in
          </label>
        )}
      </div>
      <div className={styles.cellMore}>
        {canEdit && (
          <Menu
            label={`More for ${s.name}`}
            title={s.name}
            triggerClassName="btn btn-sm btn-ghost btn-icon"
            items={[
              { label: "Taxable", checkbox: true, checked: s.taxable, onSelect: () => onChange({ id: s.id, patch: { taxable: !s.taxable } }) },
              { label: "Show on quotes", checkbox: true, checked: s.active, onSelect: () => onChange({ id: s.id, patch: { active: !s.active } }) },
              // A trip charge, say: new jobs and quotes get it as a line (20261104000100_trip_fee_minimum.sql).
              { label: "Add to every job", description: "New jobs and quotes get it as a line, once.", checkbox: true, checked: s.add_to_every_job, onSelect: () => onChange({ id: s.id, patch: { add_to_every_job: !s.add_to_every_job } }) },
              { separator: true },
              { label: s.picture ? "Change picture" : "Add a picture", icon: "camera", disabled: picture.busy, onSelect: picture.open },
              { label: "Use the drawing", icon: "undo", hidden: !s.picture, disabled: picture.busy, onSelect: picture.remove },
              { separator: true },
              { label: "Delete service", icon: "trash", danger: true, onSelect: onDelete },
            ]}
          />
        )}
      </div>
    </li>
  );
}

/**
 * An item's picture, as the salesperson sees it on the iPad's site visit: chosen to add or change it
 * (a JPEG made here from the photo, as a package's is), and removed to go back to the drawing.
 */
function usePicture(service: { id: string; name: string; picture: string | null }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  // The price list, the visit's price list and the packages' quick adds all show it.
  const saved = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["services", company.id] }), queryClient.invalidateQueries({ queryKey: ["roof-packages", company.id] })]);
  // The thumbnail changing in place says it worked.
  const set = useMutation({
    mutationFn: async (file: File) => {
      const jpeg = await packagePicture(file);
      if (!jpeg) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
      return api.put<{ path: string; width: number; height: number }>(`/services/${service.id}/picture`, { picture: await base64Of(jpeg) });
    },
    onSuccess: saved,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/services/${service.id}/picture`),
    onSuccess: saved,
  });
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*,.heic,.heif"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) set.mutate(file);
      }}
    />
  );
  return { input, open: () => ref.current?.click(), remove: () => remove.mutate(), adding: set.isPending, busy: set.isPending || remove.isPending };
}
