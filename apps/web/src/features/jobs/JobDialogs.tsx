/** Create a job directly, edit a job's details and schedule, and choose what kind of invoice to create. */
import { billingAnswers, billingModeOf, invoiceDayText, ONE_OFF_CHOICES, PRICING_CHOICES, SCHEDULE_CHOICES, type InvoiceSchedule, type JobPricing } from "@crewtavo/core/jobBilling";
import { parseRule } from "@crewtavo/core/recurrence";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { choose } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { CustomFieldInputs, customFieldsToSave, useCustomFields } from "../customFields/CustomFields";
import { RecurrenceEditor, type Recurrence } from "./RecurrenceEditor";

export function useCrews() {
  const session = useSession();
  return useQuery({
    queryKey: ["crews", session.company.id],
    queryFn: async () => unwrap(await supabase().from("crews").select("id, name").eq("company_id", session.company.id).eq("active", true).order("name")),
  });
}

/**
 * How a job is billed, as the dialogs ask it. A recurring job answers Jobber's two questions (how
 * it's priced, when it's invoiced, and for monthly the day); a one-off job is invoiced when it's
 * done or by progress. A job saved with another choice (a one-off job billed after each visit, a
 * recurring one when it's done) keeps it as an option.
 */
interface Billing {
  pricing: JobPricing;
  when: InvoiceSchedule | "on_completion" | "progress";
  /** "" is the last day of the month. */
  day: string;
}
const SCHEDULED = (when: Billing["when"]): when is InvoiceSchedule => when === "after_visit" || when === "monthly" || when === "as_needed";

function billingOf(job: { kind: string; billing_mode: string; pricing?: string | null; invoice_schedule?: string | null; invoice_day?: number | null }): Billing {
  const answers = billingAnswers(job);
  const day = job.invoice_day ? String(job.invoice_day) : "";
  if (!answers) return { pricing: "per_visit", when: job.billing_mode === "progress" ? "progress" : "on_completion", day };
  // A one-off job keeps after each visit; any other schedule on one is invoiced when it's done.
  if (job.kind !== "recurring" && answers.schedule !== "after_visit") return { pricing: "per_visit", when: "on_completion", day };
  return { pricing: answers.pricing, when: answers.schedule, day };
}

/** The columns to save (the database keeps billing_mode in step, and so does this). */
function billingFields(kind: string, b: Billing) {
  if (!SCHEDULED(b.when)) return { pricing: null, invoice_schedule: null, invoice_day: null, billing_mode: b.when };
  const pricing = kind === "recurring" ? b.pricing : "per_visit";
  return { pricing, invoice_schedule: b.when, invoice_day: b.when === "monthly" && b.day ? Number(b.day) : null, billing_mode: billingModeOf(pricing, b.when) };
}

/** Each kind of job's choices, and the job's own when it's one of the old ones. */
function BillingQuestions({ kind, value, kept, onChange }: { kind: string; value: Billing; kept?: Billing["when"]; onChange: (b: Billing) => void }) {
  const choice = (name: string, picked: boolean, label: string, hint: string, pick: () => void) => (
    <label key={label} className={`card-row choice-row${picked ? " picked" : ""}`} style={{ cursor: "pointer" }}>
      <input type="radio" name={name} checked={picked} onChange={pick} />
      <span className="grow"><strong style={{ display: "block" }}>{label}</strong><span className="muted small">{hint}</span></span>
    </label>
  );
  const legend = (text: string) => <legend className="strong" style={{ marginBottom: 6 }}>{text}</legend>;
  const fieldset = { border: 0, padding: 0, margin: 0 };
  if (kind !== "recurring") {
    return (
      <fieldset className="stack-sm" style={fieldset}>
        {legend("When do you invoice?")}
        {ONE_OFF_CHOICES.map((c) => choice("when", value.when === c.value, c.label, c.hint, () => onChange({ ...value, when: c.value })))}
        {kept === "after_visit" && choice("when", value.when === "after_visit", "After each visit", "Each finished visit is ready to invoice.", () => onChange({ ...value, when: "after_visit" }))}
      </fieldset>
    );
  }
  const old = kept && !SCHEDULED(kept) ? ONE_OFF_CHOICES.find((c) => c.value === kept) : undefined;
  return (
    <>
      <fieldset className="stack-sm" style={fieldset}>
        {legend("How is it priced?")}
        {PRICING_CHOICES.map((c) =>
          choice("pricing", SCHEDULED(value.when) && value.pricing === c.value, c.label, c.hint, () =>
            // A fixed price covers a period, so it isn't invoiced visit by visit.
            onChange({ ...value, pricing: c.value, when: !SCHEDULED(value.when) || (c.value === "fixed" && value.when === "after_visit") ? (c.value === "fixed" ? "monthly" : "after_visit") : value.when }),
          ),
        )}
      </fieldset>
      <fieldset className="stack-sm" style={fieldset}>
        {legend("When do you invoice?")}
        {SCHEDULE_CHOICES.filter((c) => !(c.value === "after_visit" && value.pricing === "fixed" && SCHEDULED(value.when))).map((c) =>
          choice("when", value.when === c.value, c.label, c.hint, () => onChange({ ...value, when: c.value })),
        )}
        {old && choice("when", value.when === old.value, old.label, old.hint, () => onChange({ ...value, when: old.value }))}
      </fieldset>
      {value.when === "monthly" && (
        <Field label="Invoice day" hint="Each month's invoice covers the days since the last one.">
          <select className="select" value={value.day} onChange={(e) => onChange({ ...value, day: e.target.value })}>
            <option value="">The last day of the month</option>
            {Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{invoiceDayText(i + 1).replace(/^the/, "The")}</option>)}
          </select>
        </Field>
      )}
    </>
  );
}

/** A job without a quote: walk-in work, a phone booking, or recurring service. */
export function NewJobDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(session.company.timezone);
  const [client, setClient] = useState<PickedClient>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"one_off" | "recurring">("one_off");
  const [recurrence, setRecurrence] = useState<Recurrence>({ rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", months: null, starts_on: today, ends_on: null });
  const [crewId, setCrewId] = useState("");
  const [billing, setBilling] = useState<Billing>({ pricing: "per_visit", when: "after_visit", day: "" });
  // Pressed Create job without a client: the client picker says so (it isn't a field the browser checks).
  const [tried, setTried] = useState(false);
  const crews = useCrews();
  const customFields = useCustomFields("job");
  const [custom, setCustom] = useState<Record<string, string>>({});
  useEffect(() => setPropertyId(null), [client?.id]);

  const create = useMutation({
    meta: { inline: true, success: kind === "recurring" ? "Recurring job created and visits scheduled" : "Job created" },
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give the job a title.");
      if (kind === "recurring") parseRule(recurrence.rule); // says what's wrong before anything is saved
      const values = Object.keys(custom).length ? { custom_fields: customFieldsToSave(customFields, null, custom) } : {};
      const job = unwrap(
        await supabase()
          .from("jobs")
          .insert({
            company_id: session.company.id,
            client_id: client!.id,
            property_id: propertyId,
            title: title.trim(),
            kind,
            default_crew_id: crewId || null,
            ...values,
            ...(kind === "recurring"
              ? { recurrence_rule: recurrence.rule, active_months: recurrence.months, starts_on: recurrence.starts_on, ends_on: recurrence.ends_on, ...billingFields(kind, billing) }
              : {}),
          })
          .select("id")
          .single(),
      );
      if (kind === "recurring") await api.post(`/jobs/${job.id}/generate-visits`);
      unwrap(await supabase().from("clients").update({ status: "active" }).eq("id", client!.id).eq("status", "lead"));
      return job.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
      onCreated(id);
    },
  });

  // A fresh form next time, once this one has animated away.
  const reset = () => {
    setClient(null);
    setTitle("");
    setKind("one_off");
    setRecurrence({ rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", months: null, starts_on: todayIn(session.company.timezone), ends_on: null });
    setCrewId("");
    setBilling({ pricing: "per_visit", when: "after_visit", day: "" });
    setCustom({});
    setTried(false);
    create.reset();
  };

  return (
    <Dialog open={open} onClose={onClose} onExited={reset} title="New job" size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); else setTried(true); }} onInvalidCapture={() => setTried(true)}>
        <Field label="Client" error={tried && !client ? "Choose who the job is for." : null}><ClientPicker value={client} onChange={setClient} /></Field>
        {client && <Field label="Property"><PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} /></Field>}
        <div className="form-grid">
          <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value.trimStart())} required maxLength={200} placeholder="Weekly mowing, driveway repair…" /></Field>
          <Field label="Crew" optional>
            <select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
              <option value="">No crew yet</option>
              {crews.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="segmented" role="group" aria-label="Job type">
          <button type="button" aria-pressed={kind === "one_off"} onClick={() => setKind("one_off")}>One-off job</button>
          <button type="button" aria-pressed={kind === "recurring"} onClick={() => setKind("recurring")}>Recurring job</button>
        </div>
        {kind === "recurring" && (
          <>
            <RecurrenceEditor value={recurrence} onChange={setRecurrence} />
            <BillingQuestions kind={kind} value={billing} onChange={setBilling} />
          </>
        )}
        <CustomFieldInputs fields={customFields} current={null} draft={custom} onChange={setCustom} />
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create job</Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface JobRecord {
  id: string;
  title: string;
  kind: "one_off" | "recurring";
  recurrence_rule: string | null;
  active_months: number[] | null;
  starts_on: string | null;
  ends_on: string | null;
  visit_start_time: string | null;
  visit_duration_min: number;
  visit_time_fixed?: boolean;
  default_crew_id: string | null;
  billing_mode: string;
  pricing?: string | null;
  invoice_schedule?: string | null;
  invoice_day?: number | null;
  po_number: string | null;
  permit_number: string | null;
  retainage_pct: number;
  warranty_until: string | null;
  instructions: string | null;
  custom_fields?: unknown;
}

export function JobDetailsDialog({ job, onClose, onSaved }: { job: JobRecord; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const [f, setF] = useState({
    title: job.title,
    kind: job.kind,
    visit_start_time: job.visit_start_time ? job.visit_start_time.slice(0, 5) : "",
    visit_duration_min: job.visit_duration_min ?? 60,
    visit_time_fixed: job.visit_time_fixed ? "1" : "",
    default_crew_id: job.default_crew_id ?? "",
    po_number: job.po_number ?? "",
    permit_number: job.permit_number ?? "",
    retainage_pct: String(job.retainage_pct ?? 0),
    warranty_until: job.warranty_until ?? "",
    instructions: job.instructions ?? "",
  });
  const [recurrence, setRecurrence] = useState<Recurrence>({
    rule: job.recurrence_rule ?? "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
    months: job.active_months,
    starts_on: job.starts_on ?? today,
    ends_on: job.ends_on,
  });
  // The job's billing as it was saved, kept as a choice when it's one the dialog no longer offers
  // (and back again when the job type is switched back).
  const [billing, setBilling] = useState<Billing>(() => billingOf(job));
  const kept = billingOf(job).when;
  const crews = useCrews();
  const customFields = useCustomFields("job");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const retainage = Number(f.retainage_pct);

  const save = useMutation({
    meta: { inline: true, success: (saved: boolean) => (saved ? "Job saved" : null) },
    mutationFn: async () => {
      if (!f.title.trim()) throw new Error("Give the job a title.");
      if (!(retainage >= 0 && retainage <= 100)) throw new Error("Retainage must be between 0 and 100%.");
      const recurring = f.kind === "recurring";
      if (recurring) parseRule(recurrence.rule); // says what's wrong before anything is saved
      // Only when one was typed into, so saved values are never written over unseen.
      const values = Object.keys(custom).length ? { custom_fields: customFieldsToSave(customFields, job.custom_fields, custom) } : {};
      // Any whole number of minutes, like Google Calendar: a 20-minute mow stays 20 minutes.
      const duration = Math.min(24 * 60, Math.max(1, Math.round(Number(f.visit_duration_min)) || 60));
      const timeFixed = Boolean(f.visit_start_time) && f.visit_time_fixed === "1";
      // Visits already on the schedule keep the old title, crew and time unless the office says otherwise.
      // Both buttons save; closing the question (Escape, the X) saves nothing, as closing a confirm does.
      let upcoming = false;
      const visitsChange =
        f.title.trim() !== job.title ||
        (f.visit_start_time || null) !== (job.visit_start_time?.slice(0, 5) ?? null) ||
        duration !== job.visit_duration_min ||
        timeFixed !== Boolean(job.visit_time_fixed) ||
        (f.default_crew_id || null) !== job.default_crew_id;
      if (recurring && job.kind === "recurring" && visitsChange) {
        const { count, error } = await supabase()
          .from("visits")
          .select("id", { count: "exact", head: true })
          .eq("job_id", job.id)
          .eq("status", "scheduled")
          .not("recurrence_key", "is", null)
          .gte("scheduled_on", today);
        if (error) throw error;
        if (count) {
          const one = count === 1;
          const choice = await choose({
            title: one ? "Change the upcoming visit too?" : `Change the ${count} upcoming visits too?`,
            body: `${one ? "It's" : "They're"} already on the schedule with the old title, crew or time. Change ${one ? "it" : "them"} too, and ${one ? "it takes" : "they take"} the new ones. Visits that are done or started stay as they are.`,
            confirmLabel: one ? "Change it too" : "Change them too",
            cancelLabel: "Only new visits",
          });
          if (choice === null) return false;
          upcoming = choice;
        }
      }
      unwrap(
        await supabase()
          .from("jobs")
          .update({
            title: f.title.trim(),
            kind: f.kind,
            recurrence_rule: recurring ? recurrence.rule : null,
            active_months: recurring ? recurrence.months : null,
            starts_on: recurring ? recurrence.starts_on : null,
            ends_on: recurring ? recurrence.ends_on : null,
            visit_start_time: f.visit_start_time || null,
            visit_duration_min: duration,
            visit_time_fixed: timeFixed,
            default_crew_id: f.default_crew_id || null,
            ...billingFields(f.kind, billing),
            po_number: f.po_number.trim() || null,
            permit_number: f.permit_number.trim() || null,
            retainage_pct: retainage,
            warranty_until: f.warranty_until || null,
            instructions: f.instructions.trim() || null,
            ...values,
          })
          .eq("id", job.id),
      );
      if (recurring) await api.post(`/jobs/${job.id}/generate-visits`, { upcoming });
      return true;
    },
    onSuccess: (saved) => {
      if (!saved) return;
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title="Job details" size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value.trimStart() })} required maxLength={200} /></Field>
        <div className="segmented" role="group" aria-label="Job type">
          <button type="button" aria-pressed={f.kind === "one_off"} onClick={() => { setF({ ...f, kind: "one_off" }); setBilling(job.kind === "one_off" ? billingOf(job) : { ...billing, when: "on_completion" }); }}>One-off job</button>
          <button type="button" aria-pressed={f.kind === "recurring"} onClick={() => { setF({ ...f, kind: "recurring" }); setBilling(job.kind === "recurring" ? billingOf(job) : { pricing: "per_visit", when: "after_visit", day: "" }); }}>Recurring job</button>
        </div>
        {f.kind === "recurring" && (
          <>
            <RecurrenceEditor value={recurrence} onChange={setRecurrence} />
            <div className="form-grid">
              <Field label="Visit time" hint="Leave empty for anytime."><input className="input" type="time" value={f.visit_start_time} onChange={set("visit_start_time")} /></Field>
              <Field label="Minutes per visit"><input className="input" type="number" inputMode="numeric" min={1} max={1440} step={1} value={f.visit_duration_min} onChange={set("visit_duration_min")} /></Field>
            </div>
            {f.visit_start_time && (
              <label className="switch-row" style={{ fontWeight: 400 }}>
                <input type="checkbox" className="switch" checked={f.visit_time_fixed === "1"} onChange={(e) => setF({ ...f, visit_time_fixed: e.target.checked ? "1" : "" })} />
                Keep this time when routes are organized
              </label>
            )}
          </>
        )}
        <div className="form-grid">
          <Field label="Default crew">
            <select className="select" value={f.default_crew_id} onChange={set("default_crew_id")}>
              <option value="">None</option>
              {crews.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>
        <BillingQuestions kind={f.kind} value={billing} kept={job.kind === f.kind ? kept : undefined} onChange={setBilling} />
        <Field label="Instructions for the crew" optional><textarea className="textarea" value={f.instructions} onChange={set("instructions")} maxLength={5000} /></Field>
        <details className="more-options" open={Boolean(f.po_number || f.permit_number || Number(f.retainage_pct) > 0 || f.warranty_until) || undefined}>
          <summary>PO, permit, retainage and warranty</summary>
          <div className="form-grid">
            <Field label="PO number" optional><input className="input" value={f.po_number} onChange={set("po_number")} maxLength={60} /></Field>
            <Field label="Permit number" optional><input className="input" value={f.permit_number} onChange={set("permit_number")} maxLength={60} /></Field>
            <Field label="Retainage %" hint="Held back from each invoice until the work is accepted." error={retainage >= 0 && retainage <= 100 ? null : "Enter 0 to 100."}><input className="input" inputMode="decimal" value={f.retainage_pct} onChange={(e) => setF({ ...f, retainage_pct: e.target.value.replace(/[^0-9.]/g, "") })} /></Field>
            <Field label="Warranty until" optional><input className="input" type="date" value={f.warranty_until} onChange={set("warranty_until")} /></Field>
          </div>
        </details>
        <CustomFieldInputs fields={customFields} current={job.custom_fields} draft={custom} onChange={setCustom} />
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

/**
 * Pause a recurring job (a vacation, the off season): its upcoming visits come off and no new ones,
 * monthly invoices or plan charges are made until it resumes, by hand or on the day given. The
 * server takes the visits off (generate-visits), as it does when a schedule changes.
 */
export function PauseJobDialog({ jobId, canSchedule, onClose, onSaved }: { jobId: string; canSchedule: boolean; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const tomorrow = addDaysIso(todayIn(session.company.timezone), 1);
  const [resumeOn, setResumeOn] = useState("");
  const pause = useMutation({
    meta: { inline: true, success: "Job paused", tone: "job" },
    mutationFn: async () => {
      unwrap(await supabase().from("jobs").update({ paused_at: new Date().toISOString(), resume_on: resumeOn || null }).eq("id", jobId));
      // Without the right to schedule the team, the nightly run takes them off.
      if (canSchedule) await api.post(`/jobs/${jobId}/generate-visits`);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Pause job" description="Upcoming visits come off the schedule, and no visits, monthly invoices or plan charges are made while it's paused. Visits with work logged stay.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); pause.mutate(); }}>
        <Field label="Resume on" optional hint="Leave it empty to resume it yourself.">
          <input className="input" type="date" value={resumeOn} min={tomorrow} onChange={(e) => setResumeOn(e.target.value)} />
        </Field>
        <FormError error={pause.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pause.isPending}>Pause job</Button>
        </div>
      </form>
    </Dialog>
  );
}

type InvoiceKind = "standard" | "deposit" | "progress" | "visits" | "retainage";

export function InvoiceJobDialog({
  job,
  onClose,
  onCreated,
}: {
  /** fixed: a recurring job at a fixed price, whose invoice is its lines once. */
  job: { id: string; contract_total: number; deposit: number; billed: number; uninvoicedVisits: number; kind: string; fixed?: boolean; retainageHeld: number; finalInvoice: number | null };
  onClose: () => void;
  onCreated: (invoiceId: string) => void;
}) {
  const leftToBill = Math.max(Number(job.contract_total) - job.billed, 0);
  const [kind, setKind] = useState<InvoiceKind>(job.kind === "recurring" ? (job.fixed ? "standard" : "visits") : job.finalInvoice ? (job.retainageHeld > 0.005 ? "retainage" : "progress") : "standard");
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState(kind === "deposit" && job.deposit ? String(job.deposit) : "");
  useEffect(() => setValue(kind === "deposit" && job.deposit ? String(job.deposit) : ""), [kind, job.deposit]);
  const amount = kind === "progress" && mode === "percent" ? (Number(value) / 100) * Number(job.contract_total) : Number(value);
  const needsAmount = kind === "deposit" || kind === "progress";
  const overLimit = needsAmount && job.kind !== "recurring" && amount > leftToBill + 0.005;
  // Create invoice stays pressable; what stops it is said under the form (an amount over the limit, under its field).
  const blocked =
    kind === "standard" && job.finalInvoice !== null ? `Invoice #${job.finalInvoice} already bills the job. Void it to bill the job again.`
      : kind === "visits" && !job.uninvoicedVisits ? "No completed visits are waiting to be invoiced."
        : needsAmount && !(amount > 0) ? "Enter an amount above zero."
          : null;
  const create = useMutation({
    meta: { inline: true, success: "Invoice created as a draft", tone: "invoice" },
    mutationFn: () => {
      if (blocked) throw new Error(blocked);
      return api.post<{ invoice_id: string }>(`/jobs/${job.id}/invoice`, { kind, amount: needsAmount ? Math.round(amount * 100) / 100 : undefined });
    },
    onSuccess: (r) => onCreated(r.invoice_id),
  });
  const options: Array<{ kind: InvoiceKind; title: string; body: string; hidden?: boolean }> = [
    { kind: "standard", title: job.fixed ? "The job's price" : "Final invoice", body: job.fixed ? "All the job's line items, once." : job.finalInvoice ? `Already created: invoice #${job.finalInvoice}. Void it to bill the job again.` : job.billed ? `All line items, less ${formatMoneyCents(job.billed)} already billed as deposits or progress.` : "All the job's line items." },
    { kind: "visits", title: "Completed visits", body: job.uninvoicedVisits ? `${job.uninvoicedVisits} completed ${job.uninvoicedVisits === 1 ? "visit isn't" : "visits aren't"} invoiced yet.` : "No completed visits are waiting to be invoiced.", hidden: job.kind !== "recurring" && !job.uninvoicedVisits },
    { kind: "deposit", title: "Deposit", body: job.deposit ? `The quote asked for ${formatMoneyCents(job.deposit)}.` : "Bill an amount up front." },
    { kind: "progress", title: "Progress payment", body: "Bill part of the contract now (a pay application).", hidden: Boolean(job.finalInvoice) },
    { kind: "retainage", title: "Retainage", body: `Bill the ${formatMoneyCents(job.retainageHeld)} held back on earlier invoices.`, hidden: !(job.retainageHeld > 0.005) },
  ];
  return (
    <Dialog open onClose={onClose} title="Create invoice">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (!overLimit) create.mutate(); }}>
        <div className="stack-sm" role="radiogroup" aria-label="Invoice type">
          {options.filter((o) => !o.hidden).map((o) => (
            <label key={o.kind} className="card card-pad" style={{ display: "flex", gap: 10, cursor: "pointer", padding: 14, borderColor: kind === o.kind ? "var(--green)" : undefined, boxShadow: kind === o.kind ? "var(--ring)" : undefined }}>
              <input type="radio" name="kind" checked={kind === o.kind} onChange={() => setKind(o.kind)} style={{ marginTop: 3 }} />
              <span><strong>{o.title}</strong><span className="muted small" style={{ display: "block" }}>{o.body}</span></span>
            </label>
          ))}
        </div>
        {kind === "progress" && (
          <div className="row wrap">
            <div className="segmented" role="group" aria-label="Bill by">
              <button type="button" aria-pressed={mode === "percent"} onClick={() => setMode("percent")}>Percent</button>
              <button type="button" aria-pressed={mode === "amount"} onClick={() => setMode("amount")}>Amount</button>
            </div>
            <span className="muted small">Contract {formatMoneyCents(job.contract_total)}{job.billed ? ` · ${formatMoneyCents(leftToBill)} left to bill` : ""}</span>
          </div>
        )}
        {needsAmount && (
          <Field
            label={kind === "progress" && mode === "percent" ? "Percent of contract" : "Amount"}
            error={overLimit ? `That's more than the ${formatMoneyCents(leftToBill)} left to bill.` : null}
            hint={kind === "progress" && mode === "percent" && amount > 0 ? `${formatMoneyCents(amount)}` : undefined}
          >
            <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={kind === "progress" && mode === "percent" ? "25" : "500.00"} required autoFocus />
          </Field>
        )}
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="invoice" loading={create.isPending}>Create invoice</Button>
        </div>
      </form>
    </Dialog>
  );
}
