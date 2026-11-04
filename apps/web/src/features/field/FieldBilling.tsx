/**
 * Finishing the paperwork on site (fieldMoney.ts says who): adding work to the visit's job from the
 * price list, and, once the visit is done, its invoice with its total, sent to the client, and cash
 * or check recorded against it. Each goes the office's own way: add_field_line() for the line, at
 * the office's price; POST /jobs/:id/invoice (create_invoice_for_job, with all its rules) for the
 * invoice; SendDialog for sending; recordPayment for the payment. No card payments on site.
 *
 * Adding work waits for signal like the visit's other updates. The invoice and payments need it.
 */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { formatMoneyCents } from "@/lib/format";
import { FIELD_SCOPE } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { recordPayment } from "../invoices/recordPayment";
import { scopeKey } from "../jobs/ScopeOfWork";
import { SendDialog } from "../quotes/SendDialog";
import { waitingScopeLine, type JobLineAdd } from "./fieldActions";
import { useSignal } from "./OfflineNote";

/** Add work: an item from the price list and how many. The office's price applies, and the crew never sees it. */
export function AddWork({ visitId, jobId }: { visitId: string; jobId: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Loaded with the visit, not when the dialog opens, so the price list is on the phone with no signal (Log material shares it).
  const choices = useQuery({
    queryKey: ["material-choices", session.company.id],
    staleTime: 5 * 60_000,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("material_choices", { p_company: session.company.id })),
  });
  // Sent by the action registered for it (fieldActions.ts), like the visit's status and notes.
  const add = useMutation({
    mutationKey: ["job-line-add"],
    scope: FIELD_SCOPE,
    meta: { success: "Added to the job" },
    onMutate: (v: JobLineAdd) => {
      if (!onlineManager.isOnline()) toast.info("Saved on this phone", { description: "It sends when you have signal." });
      queryClient.setQueryData<Array<ReturnType<typeof waitingScopeLine>>>(scopeKey(jobId), (old) => old && [...old, waitingScopeLine(v)]);
    },
    // The job's checklists can come with its new item.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: scopeKey(jobId) });
      void queryClient.invalidateQueries({ queryKey: ["checklist", visitId] });
    },
  });
  return (
    <>
      <Button icon="plus" style={{ justifySelf: "start" }} onClick={() => setOpen(true)}>Add work</Button>
      {open && (
        <AddWorkDialog
          choices={choices.data}
          loading={choices.isPending && !choices.isPaused}
          onClose={() => setOpen(false)}
          onAdd={(item, quantity) => {
            add.mutate({ visitId, jobId, lineId: crypto.randomUUID(), serviceId: item.id, quantity, name: item.name, unit: item.unit });
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

type Choice = { id: string; name: string; unit: string };

function AddWorkDialog({ choices, loading, onClose, onAdd }: { choices: Choice[] | undefined; loading: boolean; onClose: () => void; onAdd: (item: Choice, quantity: number) => void }) {
  const [serviceId, setServiceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [problem, setProblem] = useState<string | null>(null);
  const item = choices?.find((c) => c.id === serviceId);
  const amount = Number(quantity);
  return (
    <Dialog open onClose={onClose} title="Add work" description="Extra work or a part, from the price list. The office's price applies, and they'll see you added it.">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!item) return setProblem("Choose what you added.");
          if (!(amount > 0 && amount <= 100_000)) return setProblem("Enter how many.");
          onAdd(item, Math.round(amount * 1000) / 1000);
        }}
      >
        <Field label="What" requiredMessage="Choose what you added.">
          {loading ? <Skeleton height={44} radius={8} /> : (
            <select className="select" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required autoFocus>
              <option value="">{choices?.length ? "Choose from the price list…" : "The price list isn't on this phone yet"}</option>
              {choices?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit})</option>)}
            </select>
          )}
        </Field>
        <Field label="How many" hint={item?.unit} requiredMessage="Enter how many.">
          <input className="input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ""))} required />
        </Field>
        <FormError error={problem} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="plus">Add</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface VisitInvoiceRow {
  id: string;
  number: number;
  kind: string;
  status: string;
  total: number;
  balance_due: number;
  client_id: string;
  client: { email: string | null; phone: string | null; sms_opt_out_at: string | null } | null;
}

/**
 * The invoice that bills this visit: a per-visit job's for the visit (visits.invoice_id), a one-off
 * job's final one. Null until it's made.
 */
async function visitInvoice(visitId: string, jobId: string, kind: "standard" | "visits"): Promise<VisitInvoiceRow | null> {
  const [visit, invoices] = await Promise.all([
    supabase().from("visits").select("invoice_id").eq("id", visitId).maybeSingle(),
    supabase().from("invoices").select("id, number, kind, status, total, balance_due, client_id, client:clients(email, phone, sms_opt_out_at)").eq("job_id", jobId).neq("status", "void").order("number"),
  ]);
  const invoiceId = unwrapOne(visit, "This visit").invoice_id;
  const rows = unwrap(invoices) as VisitInvoiceRow[];
  return (kind === "visits" ? rows.find((i) => i.id === invoiceId) : rows.find((i) => i.kind === "standard")) ?? null;
}

/** The visit's invoice once it's done: Create invoice, its total, Send to client and Record cash or check. */
export function VisitInvoice({ visitId, jobId, kind }: { visitId: string; jobId: string; kind: "standard" | "visits" }) {
  const online = useSignal();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "send" | "payment">(null);
  // Not a field-visit key: money is never kept on the phone (lib/offline.ts).
  const key = ["visit-invoice", visitId];
  const invoice = useQuery({ queryKey: key, queryFn: () => visitInvoice(visitId, jobId, kind) });
  const refresh = () => {
    for (const k of [key, ["invoices"], ["job", jobId], ["dashboard"]]) void queryClient.invalidateQueries({ queryKey: k });
  };
  const create = useMutation({
    meta: { inline: true, success: "Invoice created", tone: "invoice" },
    // The office's Create invoice, with every rule it has (create_invoice_for_job).
    mutationFn: () => api.post<{ invoice_id: string }>(`/jobs/${jobId}/invoice`, { kind }),
    onSuccess: refresh,
  });
  const inv = invoice.data;
  const balance = Number(inv?.balance_due ?? 0);
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between">
        <strong>{inv ? `Invoice #${inv.number}` : "Invoice"}</strong>
        {inv && <EntityStatus kind="invoice" status={inv.status} />}
      </div>
      {!online && <span className="muted small"><Icon name="wifiOff" size={14} /> Invoicing and payments need signal.</span>}
      {invoice.isPending ? (online && <Skeleton height={44} radius={8} />) : inv ? (
        <>
          <div className="row-between">
            <span className="muted">Total</span>
            <strong className="tabular" style={{ fontSize: 22 }}>{formatMoneyCents(Number(inv.total))}</strong>
          </div>
          {balance !== Number(inv.total) && <div className="row-between"><span className="muted">{balance > 0 ? "Still owed" : "Paid"}</span><span className="tabular">{balance > 0 ? formatMoneyCents(balance) : <Icon name="check" size={16} />}</span></div>}
          <div className="field-actions">
            <Button icon="send" className="big-action" disabled={!online} onClick={() => setDialog("send")}>Send to client</Button>
            {balance > 0 && <Button variant="primary" icon="cash" className="big-action" disabled={!online} onClick={() => setDialog("payment")}>Record cash or check</Button>}
          </div>
        </>
      ) : (
        <Button variant="primary" icon="invoice" className="big-action" disabled={!online} loading={create.isPending} onClick={() => create.mutate()}>Create invoice</Button>
      )}
      <FormError error={create.error ?? invoice.error} />
      {dialog === "send" && inv && (
        <SendDialog kind="invoice" id={inv.id} number={inv.number} email={inv.client?.email ?? null} phone={inv.client?.phone ?? null} textsOffSince={inv.client?.sms_opt_out_at} onClose={() => setDialog(null)} onSent={refresh} />
      )}
      {dialog === "payment" && inv && <CashOrCheckDialog invoice={{ id: inv.id, client_id: inv.client_id, balance, draft: inv.status === "draft" }} onClose={() => setDialog(null)} onSaved={refresh} />}
    </section>
  );
}

/** Record cash or check: the office's Record payment, with the check number and a note. */
function CashOrCheckDialog({ invoice, onClose, onSaved }: { invoice: { id: string; client_id: string; balance: number; draft: boolean }; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [amount, setAmount] = useState(invoice.balance.toFixed(2));
  const [method, setMethod] = useState<"cash" | "check">("cash");
  const [checkNumber, setCheckNumber] = useState("");
  const [note, setNote] = useState("");
  const value = Number(amount);
  const save = useMutation({
    meta: { inline: true, success: "Payment recorded", tone: "invoice" },
    mutationFn: () =>
      recordPayment({
        companyId: session.company.id,
        currency: session.company.currency,
        invoice,
        amount: value,
        method,
        receivedAt: new Date().toISOString(),
        // As the office writes it: the check number is the payment's reference.
        notes: [method === "check" ? checkNumber.trim() : "", note.trim()].filter(Boolean).join(" · ") || null,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Record cash or check" description={`Still owed ${formatMoneyCents(invoice.balance)}`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="segmented" role="group" aria-label="Paid by">
          <button type="button" aria-pressed={method === "cash"} onClick={() => setMethod("cash")}>Cash</button>
          <button type="button" aria-pressed={method === "check"} onClick={() => setMethod("check")}>Check</button>
        </div>
        <Field label="Amount" requiredMessage="Enter the amount you received.">
          <span className="input-group"><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required /></span>
        </Field>
        {method === "check" && (
          <Field label="Check number" requiredMessage="Enter the check number.">
            <input className="input" inputMode="numeric" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} maxLength={40} required />
          </Field>
        )}
        <Field label="Note" optional><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={150} placeholder="Left in the mailbox, paid by a neighbor…" /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="cash" loading={save.isPending}>Record {value > 0 ? formatMoneyCents(value) : "payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
