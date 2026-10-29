/** Create a job directly, edit a job's details and schedule, and choose what kind of invoice to create. */
import { parseRule } from "@crewtavo/core/recurrence";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { RecurrenceEditor, type Recurrence } from "./RecurrenceEditor";

function useCrews() {
  const session = useSession();
  return useQuery({
    queryKey: ["crews", session.company.id],
    queryFn: async () => unwrap(await supabase().from("crews").select("id, name").eq("company_id", session.company.id).eq("active", true).order("name")),
  });
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
  // Pressed Create job without a client: the client picker says so (it isn't a field the browser checks).
  const [tried, setTried] = useState(false);
  const crews = useCrews();
  useEffect(() => setPropertyId(null), [client?.id]);

  const create = useMutation({
    meta: { inline: true, success: kind === "recurring" ? "Recurring job created and visits scheduled" : "Job created" },
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give the job a title.");
      if (kind === "recurring") parseRule(recurrence.rule); // says what's wrong before anything is saved
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
            ...(kind === "recurring"
              ? { recurrence_rule: recurrence.rule, active_months: recurrence.months, starts_on: recurrence.starts_on, ends_on: recurrence.ends_on, billing_mode: "per_visit" as const }
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
        {kind === "recurring" && <RecurrenceEditor value={recurrence} onChange={setRecurrence} />}
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
  po_number: string | null;
  permit_number: string | null;
  retainage_pct: number;
  warranty_until: string | null;
  instructions: string | null;
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
    billing_mode: job.billing_mode,
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
  const crews = useCrews();
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const retainage = Number(f.retainage_pct);

  const save = useMutation({
    meta: { inline: true, success: "Job saved" },
    mutationFn: async () => {
      if (!f.title.trim()) throw new Error("Give the job a title.");
      if (!(retainage >= 0 && retainage <= 100)) throw new Error("Retainage must be between 0 and 100%.");
      const recurring = f.kind === "recurring";
      if (recurring) parseRule(recurrence.rule); // says what's wrong before anything is saved
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
            // Any whole number of minutes, like Google Calendar: a 20-minute mow stays 20 minutes.
            visit_duration_min: Math.min(24 * 60, Math.max(1, Math.round(Number(f.visit_duration_min)) || 60)),
            visit_time_fixed: Boolean(f.visit_start_time) && f.visit_time_fixed === "1",
            default_crew_id: f.default_crew_id || null,
            billing_mode: f.billing_mode as "on_completion",
            po_number: f.po_number.trim() || null,
            permit_number: f.permit_number.trim() || null,
            retainage_pct: retainage,
            warranty_until: f.warranty_until || null,
            instructions: f.instructions.trim() || null,
          })
          .eq("id", job.id),
      );
      if (recurring) await api.post(`/jobs/${job.id}/generate-visits`);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title="Job details" size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value.trimStart() })} required maxLength={200} /></Field>
        <div className="segmented" role="group" aria-label="Job type">
          <button type="button" aria-pressed={f.kind === "one_off"} onClick={() => setF({ ...f, kind: "one_off" })}>One-off job</button>
          <button type="button" aria-pressed={f.kind === "recurring"} onClick={() => setF({ ...f, kind: "recurring" })}>Recurring job</button>
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
          <Field label="Billing">
            <select className="select" value={f.billing_mode} onChange={set("billing_mode")}>
              <option value="on_completion">When the work is done</option>
              <option value="per_visit">After each visit</option>
              <option value="fixed_schedule">Fixed schedule (monthly)</option>
              <option value="progress">Progress billing</option>
            </select>
          </Field>
        </div>
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

type InvoiceKind = "standard" | "deposit" | "progress" | "visits" | "retainage";

export function InvoiceJobDialog({
  job,
  onClose,
  onCreated,
}: {
  job: { id: string; contract_total: number; deposit: number; billed: number; uninvoicedVisits: number; kind: string; retainageHeld: number; finalInvoice: number | null };
  onClose: () => void;
  onCreated: (invoiceId: string) => void;
}) {
  const leftToBill = Math.max(Number(job.contract_total) - job.billed, 0);
  const [kind, setKind] = useState<InvoiceKind>(job.kind === "recurring" ? "visits" : job.finalInvoice ? (job.retainageHeld > 0.005 ? "retainage" : "progress") : "standard");
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
    { kind: "standard", title: "Final invoice", body: job.finalInvoice ? `Already created: invoice #${job.finalInvoice}. Void it to bill the job again.` : job.billed ? `All line items, less ${formatMoneyCents(job.billed)} already billed as deposits or progress.` : "All the job's line items." },
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
