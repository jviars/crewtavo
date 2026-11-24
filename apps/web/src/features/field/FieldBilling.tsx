/**
 * Finishing the paperwork on site (fieldMoney.ts says who): adding work to the visit's job from the
 * price list (on a repeating job, to this visit alone), and, once the visit is done, its invoice with its total, sent to the client, and cash
 * or check recorded against it. Each goes the office's own way: add_field_line() for the line, at
 * the office's price; POST /jobs/:id/invoice (create_invoice_for_job, with all its rules) for the
 * invoice; SendDialog for sending; recordPayment for the payment. No card payments on site.
 *
 * Adding work waits for signal like the visit's other updates. The invoice and payments need it.
 */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { EntityStatus } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { currencySymbol, formatMoneyCents } from "@/lib/format";
import { FIELD_SCOPE } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { recordPayment } from "../invoices/recordPayment";
import { scopeKey } from "../jobs/ScopeOfWork";
import { SendDialog } from "../quotes/SendDialog";
import { waitingScopeLine, type JobLineAdd } from "./fieldActions";
import { visitExtrasKey, waitingExtra, type ExtraScopeLine } from "./FieldExtras";
import { useSignal } from "./OfflineNote";
import { msg, t } from "@/lib/i18n";
import { Select } from "@/components/ui/Select";

/**
 * Add work: an item from the price list and how many. The office's price applies, and the crew never
 * sees it. `toVisit`: the job repeats, so it's extra work on this visit alone (fieldMoney addsToVisit).
 */
export function AddWork({ visitId, jobId, toVisit = false }: { visitId: string; jobId: string; toVisit?: boolean }) {
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
    meta: { success: toVisit ? t("Added to this visit") : t("Added to the job") },
    onMutate: (v: JobLineAdd) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      if (v.extra) queryClient.setQueryData<ExtraScopeLine[]>(visitExtrasKey(visitId), (old) => old && [...old, waitingExtra(v)]);
      else queryClient.setQueryData<Array<ReturnType<typeof waitingScopeLine>>>(scopeKey(jobId), (old) => old && [...old, waitingScopeLine(v)]);
    },
    // The job's checklists can come with its new item.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: scopeKey(jobId) });
      void queryClient.invalidateQueries({ queryKey: visitExtrasKey(visitId) });
      void queryClient.invalidateQueries({ queryKey: ["checklist", visitId] });
    },
  });
  return (
    <>
      <button type="button" className="field-add" onClick={() => setOpen(true)}><Icon name="plus" size={18} />{t("Add work")}</button>
      {open && (
        <AddWorkDialog
          toVisit={toVisit}
          choices={choices.data}
          loading={choices.isPending && !choices.isPaused}
          onClose={() => setOpen(false)}
          onAdd={(item, quantity) => {
            add.mutate({ visitId, jobId, lineId: crypto.randomUUID(), serviceId: item.id, quantity, name: item.name, unit: item.unit, ...(toVisit && { extra: true }) });
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

type Choice = { id: string; name: string; unit: string };

function AddWorkDialog({ choices, loading, toVisit, onClose, onAdd }: { choices: Choice[] | undefined; loading: boolean; toVisit: boolean; onClose: () => void; onAdd: (item: Choice, quantity: number) => void }) {
  const [serviceId, setServiceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [problem, setProblem] = useState<string | null>(null);
  const item = choices?.find((c) => c.id === serviceId);
  const amount = Number(quantity);
  return (
    <Dialog open onClose={onClose} title={t("Add work")} description={toVisit ? t("Extra work or a part on this visit only, from the price list. The office's price applies, and they'll see you added it.") : t("Extra work or a part, from the price list. The office's price applies, and they'll see you added it.")}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!item) return setProblem(t("Choose what you added."));
          if (!(amount > 0 && amount <= 100_000)) return setProblem(t("Enter how many."));
          onAdd(item, Math.round(amount * 1000) / 1000);
        }}
      >
        <Field label={t("What")} requiredMessage={t("Choose what you added.")}>
          {loading ? <Skeleton height={44} radius={8} /> : (
            <Select className="select" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required autoFocus>
              <option value="">{choices?.length ? t("Choose from the price list…") : t("The price list isn't on this phone yet")}</option>
              {choices?.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.unit})</option>)}
            </Select>
          )}
        </Field>
        <Field label={t("How many")} hint={item?.unit} requiredMessage={t("Enter how many.")}>
          <DecimalInput className="input" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.]/g, ""))} required />
        </Field>
        <FormError error={problem} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="plus">{t("Add")}</Button>
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
  const invoiceId = unwrapOne(visit, msg("This visit")).invoice_id;
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
    meta: { inline: true, success: t("Invoice created"), tone: "invoice" },
    // The office's Create invoice, with every rule it has (create_invoice_for_job).
    mutationFn: () => api.post<{ invoice_id: string }>(`/jobs/${jobId}/invoice`, { kind }),
    onSuccess: refresh,
  });
  const inv = invoice.data;
  const balance = Number(inv?.balance_due ?? 0);
  return (
    <Section title={inv ? t("Invoice #{number}", { number: inv.number }) : t("Invoice")} action={inv && <EntityStatus kind="invoice" status={inv.status} />} className="visit-invoice">
      {!online && <p className="field-hint"><Icon name="wifiOff" size={14} /> {t("Invoicing and payments need signal.")}</p>}
      {invoice.isPending ? (online && <Skeleton height={44} radius={8} />) : inv ? (
        <>
          <Facts>
            <Fact label={t("Total")}><span className="visit-invoice-total tabular">{formatMoneyCents(Number(inv.total))}</span></Fact>
            {balance !== Number(inv.total) && <Fact label={balance > 0 ? t("Still owed") : t("Paid")}>{balance > 0 ? <span className="tabular">{formatMoneyCents(balance)}</span> : <Icon name="check" size={16} />}</Fact>}
          </Facts>
          <div className="visit-invoice-acts">
            <Button icon="send" disabled={!online} onClick={() => setDialog("send")}>{t("Send to client")}</Button>
            {balance > 0 && <Button variant="primary" icon="cash" disabled={!online} onClick={() => setDialog("payment")}>{t("Record cash or check")}</Button>}
          </div>
        </>
      ) : (
        <div className="visit-invoice-acts">
          <Button variant="primary" icon="invoice" disabled={!online} loading={create.isPending} onClick={() => create.mutate()}>{t("Create invoice")}</Button>
        </div>
      )}
      <FormError error={create.error ?? invoice.error} />
      {dialog === "send" && inv && (
        <SendDialog kind="invoice" id={inv.id} number={inv.number} email={inv.client?.email ?? null} phone={inv.client?.phone ?? null} textsOffSince={inv.client?.sms_opt_out_at} onClose={() => setDialog(null)} onSent={refresh} />
      )}
      {dialog === "payment" && inv && <CashOrCheckDialog invoice={{ id: inv.id, client_id: inv.client_id, balance, draft: inv.status === "draft" }} onClose={() => setDialog(null)} onSaved={refresh} />}
    </Section>
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
  // The payment's id, made once: sent twice on a weak signal, it's still one payment (recordPayment.ts).
  const [paymentId] = useState(() => crypto.randomUUID());
  const save = useMutation({
    meta: { inline: true, success: t("Payment recorded"), tone: "invoice" },
    mutationFn: () =>
      recordPayment({
        id: paymentId,
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
    <Dialog open onClose={onClose} title={t("Record cash or check")} description={t("Still owed {amount}", { amount: formatMoneyCents(invoice.balance) })}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="segmented" role="group" aria-label={t("Paid by")}>
          <button type="button" aria-pressed={method === "cash"} onClick={() => setMethod("cash")}>{t("Cash")}</button>
          <button type="button" aria-pressed={method === "check"} onClick={() => setMethod("check")}>{t("Check")}</button>
        </div>
        <Field label={t("Amount")} requiredMessage={t("Enter the amount you received.")}>
          <span className="input-group"><span className="addon">{currencySymbol()}</span><DecimalInput className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} required /></span>
        </Field>
        {method === "check" && (
          <Field label={t("Check number")} requiredMessage={t("Enter the check number.")}>
            <input className="input" inputMode="numeric" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} maxLength={40} required />
          </Field>
        )}
        <Field label={t("Note")} optional><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={150} placeholder={t("Left in the mailbox, paid by a neighbor…")} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="cash" loading={save.isPending}>{value > 0 ? t("Record {amount}", { amount: formatMoneyCents(value) }) : t("Record payment")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
