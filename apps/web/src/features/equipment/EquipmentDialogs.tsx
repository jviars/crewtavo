/** Adding and editing equipment, its maintenance schedules and paperwork, and logging work done on it. */
import {
  DOCUMENT_KINDS,
  EQUIPMENT_KINDS,
  defaultMeter,
  describeInterval,
  documentLabel,
  formatMeter,
  meterUnit,
  presetInterval,
  presetsFor,
  renewalChoices,
  type EquipmentKind,
  type IntervalUnit,
  type Meter,
  type PlanPreset,
} from "@crewtavo/core/equipment";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { uploadFile } from "@/lib/files";
import { formatDate, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { refreshEquipment, seesEquipmentCosts, type DueRow, type Equipment, type PaperRow } from "./equipmentData";

/** Digits and at most one decimal point. */
const decimal = (value: string) => value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
const toNumber = (value: string) => (value.trim() === "" ? null : Number(value));

function useCrews(companyId: string) {
  return useQuery({
    queryKey: ["crews", companyId, "active"],
    queryFn: async () => unwrap(await supabase().from("crews").select("id, name").eq("company_id", companyId).eq("active", true).order("name")),
  });
}

// ---------------------------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------------------------

export function EquipmentDialog({ equipment, onClose, onSaved }: { equipment: Equipment | null; onClose: () => void; onSaved: (id: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const crews = useCrews(session.company.id);
  const showCosts = seesEquipmentCosts(session);
  const price = useQuery({
    queryKey: ["equipment", equipment?.id, "financials"],
    enabled: Boolean(equipment && showCosts),
    queryFn: async () => unwrap(await supabase().from("equipment_financials").select("purchase_price").eq("equipment_id", equipment!.id).maybeSingle()),
  });
  const [f, setF] = useState({
    name: equipment?.name ?? "",
    kind: (equipment?.kind ?? "mower") as EquipmentKind,
    meter: (equipment?.meter ?? "hours") as Meter,
    meter_reading: equipment?.meter_reading != null ? String(equipment.meter_reading) : "",
    crew_id: equipment?.crew_id ?? "",
    status: equipment?.status ?? "active",
    make: equipment?.make ?? "",
    model: equipment?.model ?? "",
    year: equipment?.year ? String(equipment.year) : "",
    serial: equipment?.serial ?? "",
    plate: equipment?.plate ?? "",
    purchased_on: equipment?.purchased_on ?? "",
    purchase_price: "",
    notes: equipment?.notes ?? "",
    registration_on: "",
    inspection_on: "",
  });
  const [meterTouched, setMeterTouched] = useState(Boolean(equipment));
  const [presets, setPresets] = useState<string[]>(() => presetsFor(equipment?.kind ?? "mower", equipment?.meter ?? "hours").map((p) => p.name));
  const [photo, setPhoto] = useState<File | null>(null);
  const priceValue = f.purchase_price !== "" ? f.purchase_price : price.data?.purchase_price != null ? String(price.data.purchase_price) : "";
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const year = toNumber(f.year);
  const yearOk = year == null || (Number.isInteger(year) && year >= 1900 && year <= 2100);

  const vehicle = f.kind === "truck" || f.kind === "trailer";
  const pickKind = (kind: EquipmentKind) => {
    const meter = meterTouched ? f.meter : defaultMeter(kind);
    setF((prev) => ({ ...prev, kind, meter }));
    setPresets(presetsFor(kind, meter).map((p) => p.name));
  };
  const pickMeter = (meter: Meter) => {
    setMeterTouched(true);
    setF((prev) => ({ ...prev, meter }));
    if (!equipment) setPresets(presetsFor(f.kind, meter).map((p) => p.name));
  };

  const save = useMutation({
    meta: { inline: true, success: equipment ? "Equipment saved" : "Equipment added" },
    mutationFn: async () => {
      // The year's field says so too, but it may be folded away under More options.
      if (!yearOk) throw new Error("Enter a year like 2021, or leave the year empty.");
      const reading = f.meter === "none" ? null : toNumber(f.meter_reading);
      const photo_path = photo ? await uploadFile(session.company.id, "equipment", photo) : equipment?.photo_path ?? null;
      const row = {
        name: f.name.trim(),
        kind: f.kind,
        meter: f.meter,
        meter_reading: reading,
        crew_id: f.crew_id || null,
        status: f.status,
        make: f.make.trim() || null,
        model: f.model.trim() || null,
        year,
        serial: f.serial.trim() || null,
        plate: f.plate.trim() || null,
        purchased_on: f.purchased_on || null,
        notes: f.notes.trim() || null,
        photo_path,
      };
      let id = equipment?.id;
      if (equipment) {
        const readingChanged = reading !== (equipment.meter_reading != null ? Number(equipment.meter_reading) : null);
        unwrap(await supabase().from("equipment").update({ ...row, ...(readingChanged ? { meter_read_on: reading == null ? null : todayIn(session.company.timezone) } : {}) }).eq("id", equipment.id));
      } else {
        id = unwrap(await supabase().from("equipment").insert({ ...row, company_id: session.company.id }).select("id").single()).id;
        const chosen = presetsFor(f.kind, f.meter).filter((p) => presets.includes(p.name));
        if (chosen.length) {
          unwrap(await supabase().from("equipment_plans").insert(chosen.map((p) => planRow(session.company.id, id!, p, f.meter))));
        }
        const papers = vehicle
          ? ([["registration", f.registration_on], ["inspection", f.inspection_on]] as const).filter(([, on]) => on).map(([kind, expires_on]) => ({ company_id: session.company.id, equipment_id: id!, kind, expires_on }))
          : [];
        if (papers.length) unwrap(await supabase().from("equipment_documents").insert(papers));
      }
      if (showCosts && f.purchase_price !== "") {
        unwrap(await supabase().from("equipment_financials").upsert({ equipment_id: id!, company_id: session.company.id, purchase_price: toNumber(f.purchase_price) }));
      }
      return id!;
    },
    onSuccess: (id) => {
      refreshEquipment(queryClient);
      onClose();
      onSaved(id);
    },
  });
  const suggestions = equipment ? [] : presetsFor(f.kind, f.meter);
  // Schedules keep their numbers when the meter changes, so say what that does to them.
  const meterHint =
    equipment && f.meter !== equipment.meter && equipment.meter !== "none"
      ? f.meter === "none"
        ? `Schedules counted only in ${equipment.meter} stop coming due.`
        : `Schedules set in ${equipment.meter} count ${f.meter} instead. Check their numbers.`
      : undefined;

  return (
    <Dialog open onClose={onClose} title={equipment ? "Edit equipment" : "Add equipment"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name" hint="What the crew calls it.">
          <input className="input" value={f.name} onChange={set("name")} required maxLength={120} placeholder='Truck 2, 61" Scag, Skid steer' autoFocus />
        </Field>
        <div className="form-grid">
          <Field label="Type">
            <select className="select" value={f.kind} onChange={(e) => pickKind(e.target.value as EquipmentKind)}>
              {EQUIPMENT_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="Tracks" hint={meterHint}>
            <select className="select" value={f.meter} onChange={(e) => pickMeter(e.target.value as Meter)}>
              <option value="hours">Engine hours</option>
              <option value="miles">Miles</option>
              <option value="none">Dates only</option>
            </select>
          </Field>
          {f.meter !== "none" && (
            <Field label={f.meter === "miles" ? "Odometer now" : "Hour meter now"} optional>
              <span className="input-group">
                <input className="input" inputMode="decimal" value={f.meter_reading} onChange={(e) => setF({ ...f, meter_reading: decimal(e.target.value) })} placeholder="0" />
                <span className="addon addon-right addon-unit">{meterUnit(f.meter)}</span>
              </span>
            </Field>
          )}
          <Field label="Crew" optional>
            <select className="select" value={f.crew_id} onChange={set("crew_id")}>
              <option value="">No crew (shared)</option>
              {crews.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          {equipment && (
            <Field label="Status">
              <select className="select" value={f.status} onChange={set("status")}>
                <option value="active">In service</option>
                <option value="in_shop">In the shop</option>
                <option value="retired">Retired (sold or scrapped)</option>
              </select>
            </Field>
          )}
        </div>

        {suggestions.length > 0 && (
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="strong small" style={{ marginBottom: 6 }}>Maintenance to track</legend>
            {suggestions.map((p) => (
              <label key={p.name} className="checkbox">
                <input type="checkbox" checked={presets.includes(p.name)} onChange={(e) => setPresets(e.target.checked ? [...presets, p.name] : presets.filter((x) => x !== p.name))} />
                <span>{p.name} <span className="muted">· {describeInterval(presetInterval(p, f.meter), f.meter)}</span></span>
              </label>
            ))}
            <span className="muted small">Counted from today{f.meter !== "none" && f.meter_reading ? ` at ${formatMeter(Number(f.meter_reading), f.meter)}` : ""}. Change the intervals to match your manual any time.</span>
          </fieldset>
        )}

        {!equipment && vehicle && (
          <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="strong small" style={{ marginBottom: 6 }}>Tags and inspection</legend>
            <div className="form-grid">
              <Field label="Tags good through" optional hint="The month on the decal runs through its last day.">
                <input className="input" type="date" value={f.registration_on} onChange={set("registration_on")} />
              </Field>
              <Field label="Inspection sticker good through" optional hint="Leave either empty to add it later.">
                <input className="input" type="date" value={f.inspection_on} onChange={set("inspection_on")} />
              </Field>
            </div>
          </fieldset>
        )}

        <details className="more-options" open={Boolean(equipment && (equipment.make || equipment.model || equipment.serial || equipment.notes)) || undefined}>
          <summary>Make, model, serial and notes</summary>
          <div className="form-grid">
            <Field label="Make" optional><input className="input" value={f.make} onChange={set("make")} maxLength={80} placeholder="Ford, Scag, Bobcat" /></Field>
            <Field label="Model" optional><input className="input" value={f.model} onChange={set("model")} maxLength={80} /></Field>
            <Field label="Year" optional error={yearOk ? null : "Enter a year like 2021."}><input className="input" inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></Field>
            <Field label={f.kind === "truck" || f.kind === "trailer" ? "VIN or serial" : "Serial number"} optional><input className="input" value={f.serial} onChange={set("serial")} maxLength={80} /></Field>
            {(f.kind === "truck" || f.kind === "trailer") && <Field label="Plate" optional><input className="input" value={f.plate} onChange={set("plate")} maxLength={20} /></Field>}
            <Field label="Bought on" optional><input className="input" type="date" value={f.purchased_on} onChange={set("purchased_on")} /></Field>
            {showCosts && (
              <Field label="Price paid" optional hint="Only people who see job costs see this.">
                <span className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={priceValue} onChange={(e) => setF({ ...f, purchase_price: decimal(e.target.value) })} /></span>
              </Field>
            )}
          </div>
          <Field label="Notes" optional hint="Oil type, filter part numbers, where the keys are."><textarea className="textarea" value={f.notes} onChange={set("notes")} maxLength={4000} rows={3} /></Field>
          <label className="dropzone" style={{ padding: 14 }}>
            <Icon name="camera" size={20} />
            <span className="small strong">{photo ? photo.name : equipment?.photo_path ? "Replace the main photo" : "Add a main photo"}</span>
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
        </details>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} slowHint={photo ? false : undefined}>{equipment ? "Save" : "Add equipment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

const planRow = (companyId: string, equipmentId: string, p: PlanPreset, meter: Meter) => ({
  company_id: companyId,
  equipment_id: equipmentId,
  name: p.name,
  ...presetInterval(p, meter),
});

// ---------------------------------------------------------------------------------------------
// Maintenance schedules
// ---------------------------------------------------------------------------------------------

export function PlanDialog({ equipment, plan, hasHistory, onClose }: { equipment: Equipment; plan: DueRow | null; hasHistory: boolean; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const usesMeter = equipment.meter !== "none";
  const [f, setF] = useState({
    name: plan?.name ?? "",
    every_meter: plan?.every_meter != null ? String(plan.every_meter) : "",
    every_count: plan?.every_count != null ? String(plan.every_count) : "",
    every_unit: (plan?.every_unit ?? "month") as IntervalUnit,
    baseline_on: plan?.last_done_on ?? todayIn(session.company.timezone),
    baseline_meter: plan?.last_done_meter != null ? String(plan.last_done_meter) : equipment.meter_reading != null ? String(equipment.meter_reading) : "",
    notes: plan?.notes ?? "",
  });
  const everyMeter = usesMeter ? toNumber(f.every_meter) : null;
  const everyCount = toNumber(f.every_count);
  const valid = Boolean(f.name.trim()) && ((everyMeter ?? 0) > 0 || (everyCount ?? 0) >= 1);
  const presets = presetsFor(equipment.kind, equipment.meter);
  const usePreset = (p: PlanPreset) => {
    const every = presetInterval(p, equipment.meter);
    setF({ ...f, name: p.name, every_meter: every.every_meter ? String(every.every_meter) : "", every_count: every.every_count ? String(every.every_count) : "", every_unit: (every.every_unit as IntervalUnit | null) ?? f.every_unit });
  };

  const save = useMutation({
    meta: { inline: true, success: plan ? "Schedule saved" : "Schedule added" },
    mutationFn: async () => {
      if (!valid) throw new Error(usesMeter ? `Enter how many ${meterUnit(equipment.meter)}, how often, or both.` : "Enter how often it's due.");
      const row = {
        name: f.name.trim(),
        every_meter: everyMeter,
        every_count: everyCount,
        every_unit: everyCount ? f.every_unit : null,
        notes: f.notes.trim() || null,
        ...(!hasHistory ? { baseline_on: f.baseline_on || null, baseline_meter: usesMeter ? toNumber(f.baseline_meter) : null } : {}),
      };
      if (plan) unwrap(await supabase().from("equipment_plans").update(row).eq("id", plan.plan_id));
      else unwrap(await supabase().from("equipment_plans").insert({ ...row, company_id: session.company.id, equipment_id: equipment.id }));
    },
    onSuccess: () => {
      refreshEquipment(queryClient);
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={plan ? "Edit maintenance schedule" : "Add maintenance schedule"} description={equipment.name}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {!plan && presets.length > 0 && (
          <div className="add-chips" role="group" aria-label="Common schedules">
            {presets.map((p) => <Button key={p.name} size="sm" icon="plus" className="add-chip" onClick={() => usePreset(p)}>{p.name}</Button>)}
          </div>
        )}
        <Field label="What's done"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} placeholder="Oil change, sharpen blades" autoFocus /></Field>
        <div className="form-grid">
          {usesMeter && (
            <Field label={`Every so many ${meterUnit(equipment.meter)}`} optional>
              <span className="input-group">
                <input className="input" inputMode="decimal" value={f.every_meter} onChange={(e) => setF({ ...f, every_meter: decimal(e.target.value) })} placeholder={equipment.meter === "miles" ? "5000" : "100"} />
                <span className="addon addon-right addon-unit">{meterUnit(equipment.meter)}</span>
              </span>
            </Field>
          )}
          <Field label={usesMeter ? "Or every" : "Every"} optional={usesMeter} hint={usesMeter ? "Whichever comes first." : undefined}>
            <span className="row" style={{ gap: 6 }}>
              <input className="input" inputMode="numeric" style={{ width: 80 }} value={f.every_count} onChange={(e) => setF({ ...f, every_count: e.target.value.replace(/\D/g, "").slice(0, 4) })} aria-label="How many" />
              <select className="select" value={f.every_unit} onChange={(e) => setF({ ...f, every_unit: e.target.value as IntervalUnit })} aria-label="Unit">
                <option value="day">days</option>
                <option value="week">weeks</option>
                <option value="month">months</option>
                <option value="year">years</option>
              </select>
            </span>
          </Field>
        </div>
        {!hasHistory && (
          <div className="form-grid">
            <Field label="Last done" hint="So we know when it's next due."><input className="input" type="date" value={f.baseline_on} onChange={(e) => setF({ ...f, baseline_on: e.target.value })} max={todayIn(session.company.timezone)} /></Field>
            {usesMeter && everyMeter != null && (
              <Field label={`At ${meterUnit(equipment.meter)}`} optional>
                <input className="input" inputMode="decimal" value={f.baseline_meter} onChange={(e) => setF({ ...f, baseline_meter: decimal(e.target.value) })} />
              </Field>
            )}
          </div>
        )}
        <Field label="Notes" optional hint="Parts, fluids, steps."><textarea className="textarea" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} /></Field>
        {valid && <div className="muted small">{describeInterval({ every_meter: everyMeter, every_count: everyCount, every_unit: f.every_unit }, equipment.meter)}{everyMeter && everyCount ? ", whichever comes first" : ""}.</div>}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{plan ? "Save" : "Add schedule"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Logging work
// ---------------------------------------------------------------------------------------------

/** What some upkeep cost, as typed: the amount, where, a receipt, and whether to pay someone back. */
interface Cost {
  amount: string;
  vendor: string;
  reimbursable: boolean;
  receipt: File | null;
}
const NO_COST: Cost = { amount: "", vendor: "", reimbursable: false, receipt: null };

/** "Add what it cost", folded away until it's wanted. */
function CostFields({ cost, onChange }: { cost: Cost; onChange: (cost: Cost) => void }) {
  const amount = toNumber(cost.amount);
  return (
    <details className="more-options">
      <summary>Add what it cost</summary>
      <div className="form-grid">
        <Field label="Cost" error={amount == null || amount > 0 ? null : "Enter an amount like 86.40."}><span className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={cost.amount} onChange={(e) => onChange({ ...cost, amount: decimal(e.target.value) })} /></span></Field>
        <Field label="Where" optional><input className="input" value={cost.vendor} onChange={(e) => onChange({ ...cost, vendor: e.target.value })} maxLength={120} placeholder="Dealer, parts store" /></Field>
      </div>
      <label className="dropzone" style={{ padding: 12 }}>
        <Icon name="camera" size={20} />
        <span className="small strong">{cost.receipt ? cost.receipt.name : "Add a receipt photo"}</span>
        <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => onChange({ ...cost, receipt: e.target.files?.[0] ?? null })} />
      </label>
      <label className="checkbox"><input type="checkbox" checked={cost.reimbursable} onChange={(e) => onChange({ ...cost, reimbursable: e.target.checked })} /> I paid with my own money (reimburse me)</label>
    </details>
  );
}

/** Records a cost as an equipment upkeep expense (with its receipt); its id, or null when there's no amount. */
async function saveCost(companyId: string, equipment: Pick<Equipment, "id" | "name">, cost: Cost, what: string, on: string): Promise<string | null> {
  const amount = toNumber(cost.amount);
  if (amount == null) return null;
  const receipt_path = cost.receipt ? await uploadFile(companyId, "receipts", cost.receipt) : null;
  return unwrap(
    await supabase()
      .from("expenses")
      .insert({
        company_id: companyId,
        equipment_id: equipment.id,
        category: "Equipment upkeep",
        description: `${what || "Upkeep"}: ${equipment.name}`.slice(0, 300),
        vendor: cost.vendor.trim() || null,
        amount: Math.round(amount * 100) / 100,
        incurred_on: on,
        reimbursable: cost.reimbursable,
        receipt_path,
      })
      .select("id")
      .single(),
  ).id;
}

export type LogKind = "service" | "repair" | "reading" | "note";
const LOG_TITLES: Record<LogKind, string> = { service: "Log maintenance", repair: "Log a repair", reading: "Update the reading", note: "Add a note" };

/** Mark maintenance done, record a repair, update the hour meter or odometer, or leave a note. */
export function LogDialog({
  equipment,
  plans,
  kind: initialKind,
  planId,
  onClose,
}: {
  equipment: Pick<Equipment, "id" | "name" | "meter" | "meter_reading" | "status">;
  plans: Array<Pick<DueRow, "plan_id" | "name">>;
  kind: LogKind;
  planId?: string | null;
  onClose: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<LogKind>(initialKind);
  const usesMeter = equipment.meter !== "none";
  const current = equipment.meter_reading != null ? Number(equipment.meter_reading) : null;
  const [f, setF] = useState({
    plan_id: planId ?? (initialKind === "service" ? plans[0]?.plan_id ?? "" : ""),
    title: "",
    done_on: todayIn(session.company.timezone),
    meter_reading: initialKind === "reading" || current == null ? "" : String(current),
    notes: "",
  });
  const [cost, setCost] = useState<Cost>(NO_COST);
  const reading = usesMeter ? toNumber(f.meter_reading) : null;
  const amount = toNumber(cost.amount);
  const plan = plans.find((p) => p.plan_id === f.plan_id);
  const title = kind === "service" ? plan?.name ?? f.title.trim() : f.title.trim();
  const lower = reading != null && current != null && reading < current;
  const valid =
    (kind === "reading" ? reading != null : true) &&
    (kind === "repair" ? Boolean(f.title.trim()) : true) &&
    (kind === "service" ? Boolean(plan || f.title.trim()) : true) &&
    (kind === "note" ? Boolean(f.notes.trim()) : true) &&
    (amount == null || amount > 0);

  const save = useMutation({
    meta: { inline: true, success: kind === "service" ? "Maintenance logged" : kind === "repair" ? "Repair logged" : kind === "reading" ? "Reading saved" : "Note added" },
    mutationFn: async () => {
      // The browser checks what's required; this catches what it can't (a cost of 0, a name of only spaces).
      if (!valid) throw new Error(amount != null && !(amount > 0) ? "Enter a cost above zero, or leave it empty." : "Say what was done first.");
      const expense_id = kind === "service" || kind === "repair" ? await saveCost(session.company.id, equipment, cost, title, f.done_on) : null;
      unwrap(
        await supabase().from("equipment_logs").insert({
          company_id: session.company.id,
          equipment_id: equipment.id,
          kind,
          plan_id: kind === "service" ? f.plan_id || null : null,
          title: kind === "reading" ? null : title || null,
          done_on: f.done_on,
          meter_reading: reading,
          notes: f.notes.trim() || null,
          expense_id,
        }),
      );
    },
    onSuccess: () => {
      refreshEquipment(queryClient);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={LOG_TITLES[kind]} description={equipment.name}>
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (lower && !(await confirm({ title: `That's lower than the last reading (${formatMeter(current, equipment.meter)})`, body: "Save it anyway? Only if the meter was replaced or the last reading was wrong.", confirmLabel: "Save anyway" }))) return;
          save.mutate();
        }}
      >
        <div className="segmented" role="group" aria-label="What happened" style={{ justifySelf: "start" }}>
          {(["service", "repair", ...(usesMeter ? ["reading"] : []), "note"] as LogKind[]).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{{ service: "Maintenance", repair: "Repair", reading: usesMeter && equipment.meter === "miles" ? "Miles" : "Hours", note: "Note" }[k]}</button>
          ))}
        </div>
        {kind === "service" && (
          plans.length > 0 ? (
            <Field label="What was done">
              <select className="select" value={f.plan_id} onChange={(e) => setF({ ...f, plan_id: e.target.value })}>
                {plans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.name}</option>)}
                <option value="">Something else</option>
              </select>
            </Field>
          ) : null
        )}
        {(kind === "repair" || (kind === "service" && !plan)) && (
          <Field label={kind === "repair" ? "What was fixed" : "What was done"}>
            <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} required placeholder={kind === "repair" ? "Replaced deck belt" : "Changed spark plug"} autoFocus />
          </Field>
        )}
        <div className="form-grid">
          <Field label="Date" className={kind === "reading" ? "order-last" : undefined}><input className="input" type="date" value={f.done_on} onChange={(e) => setF({ ...f, done_on: e.target.value })} max={todayIn(session.company.timezone)} required /></Field>
          {usesMeter && kind !== "note" && (
            <Field label={equipment.meter === "miles" ? "Odometer" : "Hour meter"} optional={kind !== "reading"} hint={lower ? <span className="text-danger">Lower than the last reading ({formatMeter(current, equipment.meter)}).</span> : current != null && kind === "reading" ? `Last: ${formatMeter(current, equipment.meter)}` : undefined}>
              <span className="input-group">
                <input className="input" inputMode="decimal" value={f.meter_reading} onChange={(e) => setF({ ...f, meter_reading: decimal(e.target.value) })} required={kind === "reading"} autoFocus={kind === "reading"} />
                <span className="addon addon-right addon-unit">{meterUnit(equipment.meter)}</span>
              </span>
            </Field>
          )}
        </div>
        <Field label="Notes" optional={kind !== "note"}>
          <textarea className="textarea" rows={kind === "note" ? 4 : 2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={4000} required={kind === "note"} autoFocus={kind === "note"} placeholder={kind === "note" ? "Pulls left, check tire pressure" : undefined} />
        </Field>
        {(kind === "service" || kind === "repair") && <CostFields cost={cost} onChange={setCost} />}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} slowHint={cost.receipt ? false : undefined}>{kind === "service" ? "Mark done" : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Tags and inspection
// ---------------------------------------------------------------------------------------------

/** Kinds whose date is a month on a decal or sticker. */
const MONTH_DATED = ["registration", "inspection", "emissions", "dot_inspection"];

/** Add or change a piece of paperwork: what it is and the date it's good through. */
export function PaperDialog({ equipment, paper, taken, onClose }: { equipment: Pick<Equipment, "id" | "name">; paper: PaperRow | null; taken: string[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  // One of each kind per machine (the database holds to it), any number of something else.
  const kinds = DOCUMENT_KINDS.filter((k) => k.key === "other" || k.key === paper?.kind || !taken.includes(k.key));
  const [f, setF] = useState({
    kind: paper?.kind ?? kinds[0].key,
    name: paper?.name ?? "",
    expires_on: paper?.expires_on ?? "",
    permanent: Boolean(paper && !paper.expires_on),
    notes: paper?.notes ?? "",
  });
  const canBePermanent = f.kind === "registration" || f.kind === "other";
  const permanent = canBePermanent && f.permanent;

  const save = useMutation({
    meta: { inline: true, success: paper ? "Saved" : "Added" },
    mutationFn: async () => {
      if (!permanent && !f.expires_on) throw new Error("Enter the date it's good through.");
      const row = { kind: f.kind, name: f.kind === "other" ? f.name.trim() : null, expires_on: permanent ? null : f.expires_on, notes: f.notes.trim() || null };
      if (paper) unwrap(await supabase().from("equipment_documents").update(row).eq("id", paper.id));
      else unwrap(await supabase().from("equipment_documents").insert({ ...row, company_id: session.company.id, equipment_id: equipment.id }));
    },
    onSuccess: () => {
      refreshEquipment(queryClient);
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={paper ? documentLabel(paper.kind, paper.name) : "Add tags or inspection"} description={equipment.name}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {!paper && (
          <Field label="What it is">
            <select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} autoFocus>
              {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </Field>
        )}
        {f.kind === "other" && (
          <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} placeholder="Fire extinguisher tag, IFTA decal" /></Field>
        )}
        {!permanent && (
          <Field label="Good through" hint={MONTH_DATED.includes(f.kind) ? "The month on the decal or sticker runs through its last day." : undefined}>
            <input className="input" type="date" value={f.expires_on} onChange={(e) => setF({ ...f, expires_on: e.target.value })} required />
          </Field>
        )}
        {canBePermanent && (
          <label className="checkbox">
            <input type="checkbox" checked={f.permanent} onChange={(e) => setF({ ...f, permanent: e.target.checked })} />
            {f.kind === "registration" ? "Permanent plate (doesn't expire)" : "Doesn't expire"}
          </label>
        )}
        <Field label="Notes" optional><textarea className="textarea" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} placeholder="Plate state, policy number, where it's kept" /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{paper ? "Save" : "Add"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Renewed: the new date it's good through (with quick picks), any cost, and a line in the history. */
export function RenewDialog({ equipment, paper, onClose }: { equipment: Pick<Equipment, "id" | "name">; paper: PaperRow; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  const choices = renewalChoices(paper.kind, paper.expires_on, today);
  const [date, setDate] = useState(choices[0]?.date ?? "");
  const [notes, setNotes] = useState("");
  const [cost, setCost] = useState<Cost>(NO_COST);
  const amount = toNumber(cost.amount);
  const what = documentLabel(paper.kind, paper.name);

  const save = useMutation({
    meta: { inline: true, success: "Renewed" },
    mutationFn: async () => {
      if (!date) throw new Error("Enter the date it's good through now.");
      if (amount != null && !(amount > 0)) throw new Error("Enter a cost above zero, or leave it empty.");
      const expense = await saveCost(session.company.id, equipment, cost, `${what} renewed`, today);
      unwrap(await supabase().rpc("renew_equipment_document", { p_document: paper.id, p_expires_on: date, p_notes: notes.trim() || undefined, p_expense: expense ?? undefined }));
    },
    onSuccess: () => {
      refreshEquipment(queryClient);
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={`Renew: ${what}`} description={equipment.name}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        {paper.expires_on && <div className="muted small">{paper.days_left != null && paper.days_left < 0 ? "Was good through" : "Good through"} {formatDate(paper.expires_on)}.</div>}
        {choices.length > 1 && (
          <div className="segmented" role="group" aria-label="Renewed for" style={{ justifySelf: "start" }}>
            {choices.map((c) => <button key={c.label} type="button" aria-pressed={date === c.date} onClick={() => setDate(c.date)}>{c.label}</button>)}
          </div>
        )}
        <Field label="Now good through" hint={MONTH_DATED.includes(paper.kind) ? "Check it against the new decal or sticker." : undefined}>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <Field label="Notes" optional><textarea className="textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder={paper.kind === "inspection" ? "Where it was inspected, sticker number" : undefined} /></Field>
        <CostFields cost={cost} onChange={setCost} />
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} slowHint={cost.receipt ? false : undefined}>Renew</Button>
        </div>
      </form>
    </Dialog>
  );
}
