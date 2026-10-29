/** Adding and editing equipment and maintenance schedules, and logging work done on it. */
import {
  EQUIPMENT_KINDS,
  PLAN_PRESETS,
  defaultMeter,
  describeInterval,
  formatMeter,
  meterUnit,
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
import { todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { refreshEquipment, seesEquipmentCosts, type DueRow, type Equipment } from "./equipmentData";

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
  });
  const [meterTouched, setMeterTouched] = useState(Boolean(equipment));
  const [presets, setPresets] = useState<string[]>(() => PLAN_PRESETS[(equipment?.kind ?? "mower") as EquipmentKind].map((p) => p.name));
  const [photo, setPhoto] = useState<File | null>(null);
  const priceValue = f.purchase_price !== "" ? f.purchase_price : price.data?.purchase_price != null ? String(price.data.purchase_price) : "";
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const year = toNumber(f.year);
  const yearOk = year == null || (Number.isInteger(year) && year >= 1900 && year <= 2100);

  const pickKind = (kind: EquipmentKind) => {
    setF((prev) => ({ ...prev, kind, meter: meterTouched ? prev.meter : defaultMeter(kind) }));
    setPresets(PLAN_PRESETS[kind].map((p) => p.name));
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
        const chosen = PLAN_PRESETS[f.kind].filter((p) => presets.includes(p.name));
        if (chosen.length) {
          unwrap(await supabase().from("equipment_plans").insert(chosen.map((p) => planRow(session.company.id, id!, p, f.meter))));
        }
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
  const suggestions = equipment ? [] : PLAN_PRESETS[f.kind];

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
          <Field label="Tracks">
            <select className="select" value={f.meter} onChange={(e) => { setMeterTouched(true); setF({ ...f, meter: e.target.value as Meter }); }}>
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
                <span>{p.name} <span className="muted">· {describeInterval(p, f.meter)}</span></span>
              </label>
            ))}
            <span className="muted small">Counted from today{f.meter !== "none" && f.meter_reading ? ` at ${formatMeter(Number(f.meter_reading), f.meter)}` : ""}. Change the intervals to match your manual any time.</span>
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
            <span className="small strong">{photo ? photo.name : equipment?.photo_path ? "Replace the photo" : "Add a photo"}</span>
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
  every_meter: meter === "none" ? null : p.every_meter ?? null,
  every_count: p.every_count ?? null,
  every_unit: p.every_count ? p.every_unit ?? "month" : null,
  // Hours-only schedules on a machine without a meter fall back to once a year.
  ...(meter === "none" && !p.every_count ? { every_count: 1, every_unit: "year" } : {}),
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
  const presets = PLAN_PRESETS[equipment.kind as EquipmentKind] ?? [];
  const usePreset = (p: PlanPreset) =>
    setF({ ...f, name: p.name, every_meter: usesMeter && p.every_meter ? String(p.every_meter) : "", every_count: p.every_count ? String(p.every_count) : usesMeter ? "" : "1", every_unit: (p.every_unit as IntervalUnit) ?? (usesMeter ? "month" : "year") });

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
    amount: "",
    vendor: "",
    reimbursable: false,
  });
  const [receipt, setReceipt] = useState<File | null>(null);
  const reading = usesMeter ? toNumber(f.meter_reading) : null;
  const amount = toNumber(f.amount);
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
      let expense_id: string | null = null;
      if (amount != null && kind !== "reading" && kind !== "note") {
        const receipt_path = receipt ? await uploadFile(session.company.id, "receipts", receipt) : null;
        expense_id = unwrap(
          await supabase()
            .from("expenses")
            .insert({
              company_id: session.company.id,
              equipment_id: equipment.id,
              category: "Equipment upkeep",
              description: `${title || "Upkeep"}: ${equipment.name}`.slice(0, 300),
              vendor: f.vendor.trim() || null,
              amount: Math.round(amount * 100) / 100,
              incurred_on: f.done_on,
              reimbursable: f.reimbursable,
              receipt_path,
            })
            .select("id")
            .single(),
        ).id;
      }
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
        {(kind === "service" || kind === "repair") && (
          <details className="more-options">
            <summary>Add what it cost</summary>
            <div className="form-grid">
              <Field label="Cost" error={amount == null || amount > 0 ? null : "Enter an amount like 86.40."}><span className="input-group"><span className="addon">$</span><input className="input" inputMode="decimal" style={{ paddingLeft: 22 }} value={f.amount} onChange={(e) => setF({ ...f, amount: decimal(e.target.value) })} /></span></Field>
              <Field label="Where" optional><input className="input" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} maxLength={120} placeholder="Dealer, parts store" /></Field>
            </div>
            <label className="dropzone" style={{ padding: 12 }}>
              <Icon name="camera" size={20} />
              <span className="small strong">{receipt ? receipt.name : "Add a receipt photo"}</span>
              <input type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
            </label>
            <label className="checkbox"><input type="checkbox" checked={f.reimbursable} onChange={(e) => setF({ ...f, reimbursable: e.target.checked })} /> I paid with my own money (reimburse me)</label>
          </details>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} slowHint={receipt ? false : undefined}>{kind === "service" ? "Mark done" : "Save"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
