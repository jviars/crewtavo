import { businessCountry } from "@crewtavo/core/countries";
import { autopayDueText, autopaySettings, methodLabel } from "@crewtavo/core/autopay";
import { lateFeeAmount, lateFeeCouldApply, lateFeeNotice, lateFeeOn, lateFeeSettings } from "@crewtavo/core/billing";
import { shownCustomFields } from "@crewtavo/core/customFields";
import type { TablesUpdate } from "@crewtavo/core/database";
import { lineTotal, taxName, taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { givenBackWords, goneInvoiceWords } from "@crewtavo/core/promos";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { ClientPreview } from "@/components/ui/ClientPreview";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { ActionBar, DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { Fact, Facts, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, NoAccess, PageError } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { ApiError, errorMessage, isAuthError, isNetworkError, isRestarting } from "@/lib/errors";
import { addDaysIso, companyCountry, currencySymbol, formatDate, formatMoneyCents, formatTaxRate, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { contractTemplate, documentCompany, invoiceDocument, invoiceFill, NO_CONTRACT, useDocumentTemplate, useInvoiceContract, useLetterhead, type DocumentInvoice, type InvoiceQuote } from "../documents/data";
import { DocumentSheet } from "../documents/EstimateDocument";
import { readJobDiscounts, refreshJobInvoices } from "../jobs/JobDiscountNote";
import { InvoiceDrawings } from "../measure/drawings";
import { LineItems } from "../quotes/LineItems";
import { DiscountRows } from "../quotes/PromoRow";
import { paidWords } from "./creditRules";
import { AddWorkDialog } from "./AddWorkDialog";
import { recordPayment, type PaymentMethod } from "./recordPayment";
import { owedAgainNote, recordRefund, refundToasts, type RefundResult } from "./recordRefund";
import { ReferralCredits } from "./ReferralCredits";
import { SendDialog } from "../quotes/SendDialog";
import { refundable, stripeCharge, stripeRefundable, stripeRefundToasts, type StripeRefundResult } from "./refunds";
import { settle } from "./settle";
import { autopayBankNote, bankPayment, bankPaymentNote, paidInStripe, paymentAmount, RECORD_IN_STRIPE } from "./stripeInvoices";
import { approvalText, bankLimitText, chargeOutcomeText, noOkForBank, type ChargeResult } from "./charges";
import { EditInvoiceDialog } from "./EditInvoiceDialog";
import { editOffer } from "./editInvoice";
import { lateFeeControls } from "./lateFees";
import { CustomFieldsCard, useCustomFields } from "../customFields/CustomFields";
import styles from "./invoices.module.css";
import { Select } from "@/components/ui/Select";

const METHODS: Record<string, string> = { check: "Check", cash: "Cash", card: "Card", ach: "Bank transfer", other: "Other" };
/** A charge still going, or waiting on someone: the database lets an invoice have one at a time. */
const LIVE_CHARGES = new Set(["waiting", "needs_approval", "charging", "processing", "failed", "needs_client"]);

export function InvoicePage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <InvoicePageScreen /> : <NoAccess title="Invoice" />;
}

function InvoicePageScreen() {
  const { id = "" } = useParams();
  const session = useSession();
  // What the business's documents call the tax ("VAT" in the UK), as they print it.
  const tax = taxName(session.company.settings, businessCountry(session.company));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "send" | "payment" | "work" | "edit">(null);
  const [refunding, setRefunding] = useState<null | { id: string; amount: number; method: string }>(null);
  const [stripeRefund, setStripeRefund] = useState<null | { id: string; amount: number; tip_amount: number; method: string; processor_ref: string | null }>(null);
  const today = todayIn(session.company.timezone);

  const invoice = useQuery({
    queryKey: ["invoice", id],
    queryFn: async () => {
      // Its autopay charges and referral credits come in alongside, by the same key: one select with
      // them embedded too is more than the typed client can read.
      const [row, autopay, credits] = await Promise.all([
        supabase()
          .from("invoices")
          .select("*, promo:promo_codes(code, kind, value, description), client:clients(id, display_name, email, phone, billing_address, sms_opt_out_at, tax_exempt, tax_exempt_note), job:jobs(id, number, title, po_number, kind, billing_mode, property:properties(line1, city, region, postal_code), quote:quotes!jobs_company_id_quote_id_fkey(approval, option_id, option:quote_options!quotes_option_fkey(name, warranty), package:roof_packages!quotes_roof_package_fkey(name, warranty))), lines:invoice_line_items(id, name, description, quantity, unit, unit_price, taxable, sort, service_id, discount_quote_id, time_entry_ids, material_ids, kind), payments(id, amount, tip_amount, method, received_at, processor, processor_ref, notes, fee_amount, payout:payouts(arrival_on, status)), stripe:stripe_invoices(stripe_id, origin, status, number, hosted_url, livemode, amount_due, created_at, detached_at, processing_at, collection, purpose)")
          .eq("id", id)
          .order("sort", { referencedTable: "invoice_line_items" })
          .order("received_at", { referencedTable: "payments" })
          .order("created_at", { referencedTable: "stripe_invoices", ascending: false })
          .maybeSingle(),
        supabase()
          .from("autopay_charges")
          .select("id, source, status, due_at, attempts, failures, last_error, decline_code, charged_at, approved_at, bank_limit, send_state, send_error, method:client_payment_methods!autopay_charges_method_fkey(type, brand, last4, bank_name, wallet)")
          .eq("invoice_id", id)
          .order("created_at", { ascending: false }),
        supabase().from("referral_credits").select("id, amount, note, referral_id, created_at").eq("invoice_id", id).order("created_at"),
      ]);
      return { ...unwrapOne(row, "This invoice"), autopay: unwrap(autopay), credits: unwrap(credits) };
    },
    // While it's being charged (or was just approved), look again every few seconds until Stripe
    // answers; and while it's on its way to the client instead (over a bank account's limit), until it has gone.
    refetchInterval: (query) =>
      query.state.data?.autopay.some((a) => a.status === "charging" || (a.status === "waiting" && a.approved_at) || a.send_state === "waiting" || a.send_state === "sending") ? 10_000 : false,
  });
  const inv = invoice.data;
  // Whether the company's Stripe key can make refunds (Settings → Payments reads the same), asked
  // only for an invoice with a payment Stripe took. Unknown (loading, or an older server) leaves
  // Refund on: the server says why if it can't.
  const autopayStatus = useQuery({
    queryKey: ["company", session.company.id, "payments"],
    enabled: Boolean(inv?.payments.some(stripeCharge)),
    meta: { silent: true },
    queryFn: () => api.get<{ can_refund: boolean }>("/autopay/status"),
  });
  const canRefund = autopayStatus.data?.can_refund !== false;
  // Charge card's card, when the server says it can be pressed: charging saved cards is on, it's
  // owed, and the client agreed to a card. Asked only while nothing is charging it already.
  const chargeable = useQuery({
    queryKey: ["invoice", id, "charge"],
    enabled: Boolean(inv && Number(inv.balance_due) > 0 && !inv.autopay.some((a) => LIVE_CHARGES.has(a.status))) && autopaySettings(session.company.settings, session.company.trade_preset).enabled,
    meta: { silent: true },
    queryFn: () => api.get<{ manual: { card: string } | null }>(`/invoices/${id}/charge`),
  });
  useDocumentTitle(inv ? `Invoice #${inv.number}` : "Invoice");
  useRememberRecent(session.company.id, inv ? { kind: "invoice", id: inv.id, title: `Invoice #${inv.number}`, subtitle: inv.client?.display_name, path: `/invoices/${inv.id}` } : null);

  const refresh = () => {
    // On a job's invoice, every invoice page and the job's: a change here can move the job's promo
    // discount to or off its other drafts (a promo line taken off, its Undo, Void).
    if (inv?.job) refreshJobInvoices(queryClient, { jobId: inv.job.id, clientId: inv.client_id });
    else queryClient.invalidateQueries({ queryKey: ["invoice", id] });
    queryClient.invalidateQueries({ queryKey: ["invoices", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  // A job's once-per-job promo discount on this invoice goes on the job's next invoice when it's voided
  // or deleted (the database moves it at commit): read where it is before and after, so the toast can say.
  const promoJobId = inv?.job && inv.lines.some((l) => l.discount_quote_id) ? inv.job.id : null;
  const followingPromo = async (change: () => Promise<unknown>) => {
    const before = promoJobId ? await readJobDiscounts(promoJobId) : null;
    await change();
    return before && promoJobId ? goneInvoiceWords(id, before, await readJobDiscounts(promoJobId)) : null;
  };
  // Status changes, from the header and its menu. Voided, the toast says where a promo discount went.
  const update = useMutation({
    meta: { success: (_: unknown, p: TablesUpdate<"invoices">) => (p.status === "sent" ? "Invoice marked as sent" : p.status === "draft" ? "Invoice moved back to draft" : null), tone: "invoice" },
    mutationFn: async (patch: TablesUpdate<"invoices">) => {
      const change = async () => unwrap(await supabase().from("invoices").update(patch).eq("id", id));
      if (patch.status === "void") return followingPromo(change);
      await change();
      return null;
    },
    onSuccess: (note, patch) => {
      if (patch.status === "void") toast.success("Invoice voided", { description: note ?? undefined, tone: "invoice" });
      refresh();
    },
  });
  // The fields on the page, saved as they're left: "Saving…" and "Saved" beside the status.
  const save = useSaveStatus();
  const edit = useMutation({
    meta: { inline: true },
    mutationFn: async (patch: TablesUpdate<"invoices">) => unwrap(await supabase().from("invoices").update(patch).eq("id", id)),
    onSuccess: refresh,
    // Offline or restarting, "Couldn't save" in the header is enough; a refusal also says why in a toast, since trying again won't help.
    onError: (error) => {
      if (!isNetworkError(error) && !isAuthError(error) && !(error instanceof ApiError && isRestarting(error.status))) toast.error(errorMessage(error));
    },
  });
  const saveField = (patch: TablesUpdate<"invoices">) => void save.track(edit.mutateAsync(patch));
  // A field left without a change takes back its "Edited".
  const unchanged = () => save.status === "edited" && save.reset();
  // Written off: what's left isn't counted as owed any more (or is again, undone).
  const writeOff = useMutation({
    meta: { success: (_: unknown, on: boolean) => (on ? "Invoice written off" : "Write-off undone"), tone: "invoice" },
    mutationFn: async (on: boolean) => unwrap(await supabase().from("invoices").update({ status: on ? "written_off" : "sent" }).eq("id", id)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => followingPromo(async () => unwrap(await supabase().from("invoices").delete().eq("id", id))),
    onSuccess: (note) => {
      toast.success("Draft invoice deleted", { description: note ?? undefined, tone: "invoice" });
      if (inv?.job) refreshJobInvoices(queryClient, { jobId: inv.job.id, clientId: inv.client_id, gone: id });
      queryClient.invalidateQueries({ queryKey: ["invoices", session.company.id] });
      navigate("/invoices", { replace: true });
    },
  });
  // Undone from its toast (see takeOff below), which also says when it fails.
  // Remove late fee: the fee line comes off and late fees are off for it (the database does both, and says why when it can't).
  const removeLateFee = useMutation({
    meta: { success: "Late fee removed", tone: "invoice" },
    mutationFn: async () => unwrap(await supabase().rpc("remove_late_fee", { p_invoice: id })),
    onSuccess: refresh,
  });
  const removePayment = useMutation({
    meta: { inline: true },
    mutationFn: async (paymentId: string) => unwrap(await supabase().from("payments").delete().eq("id", paymentId)),
    onSuccess: refresh,
  });
  const paymentRows = useListAnimation<HTMLUListElement>();
  const openClientView = useMutation({
    mutationFn: (print: boolean) => api.get<{ link: string }>(`/invoices/${id}/link`).then((r) => ({ ...r, print })),
    onSuccess: ({ link, print }) => window.open(print ? `${link}?print=1` : link, "_blank", "noopener"),
  });
  // What Stripe does next (a charge, a refund) is booked a few seconds later, so look again then too.
  const refreshSoon = () => {
    refresh();
    window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ["invoice", id] }), 5000);
  };
  // Approve charge: a charge over the autopay limit goes ahead, and the server starts on it at once.
  // Never on a bank account over its limit: the server says the invoice went to the client instead.
  const approveCharge = useMutation({
    meta: { success: (r: { to_client?: boolean }) => (r.to_client ? "Not charged. It's going to the client to pay" : "Charging it now"), tone: "invoice" },
    mutationFn: (chargeId: string) => api.post<{ to_client?: boolean }>(`/autopay/charges/${chargeId}/approve`, {}),
    onSuccess: refreshSoon,
  });
  // Charge card: queued for the autopay task, which the server starts on at once. Charge card goes
  // as soon as it's queued, so a second press can't queue another. It sends the balance the office
  // confirmed: if a line changed it since, the server says so (changed) and the page shows the new one.
  const chargeCard = useMutation({
    meta: { success: (r: { results: ChargeResult[] }) => (r.results[0]?.outcome === "queued" ? "Charging it now" : null), tone: "invoice" },
    mutationFn: (amount: number) => api.post<{ results: ChargeResult[] }>("/invoices/charge", { invoices: [{ id, amount }] }),
    onSuccess: ({ results }) => {
      const r = results[0];
      if (r && r.outcome !== "queued") toast.error("Not charged", { description: chargeOutcomeText(r) });
      queryClient.setQueryData(["invoice", id, "charge"], { manual: null });
      refreshSoon();
    },
  });
  // Send it the usual way: the charge is called off, and the draft goes out with the Send dialog.
  const callOffCharge = useMutation({
    mutationFn: (chargeId: string) => api.post(`/autopay/charges/${chargeId}/call-off`, {}),
    onSuccess: () => {
      refresh();
      setDialog("send");
    },
  });

  if (invoice.isPending) return <DetailSkeleton />;
  if (invoice.error || !inv) return <PageError error={invoice.error} onRetry={() => invoice.refetch()} back={<BackLink to="/invoices">Invoices</BackLink>} />;

  const draft = inv.status === "draft";
  const isVoid = inv.status === "void";
  // For the question before voiding or deleting: the promo discount it gives back to the job.
  const givenBack = async () => (promoJobId ? givenBackWords(inv.id, await readJobDiscounts(promoJobId)) : null);
  const writtenOff = inv.status === "written_off";
  const balance = Number(inv.balance_due);
  const paid = Number(inv.amount_paid);
  const daysLate = inv.due_on && balance > 0 && !draft && !isVoid && !writtenOff ? Math.floor((Date.parse(today) - Date.parse(inv.due_on)) / 86_400_000) : 0;
  // Late fees (Settings → Company): the day this one's goes on, once, if it's still owed then.
  const lateFee = lateFeeSettings(session.company.settings);
  const feeDay = lateFeeOn(inv, lateFee, session.company.timezone);
  const lateFeeDay = feeDay && feeDay > today ? feeDay : null;
  // Charged no tax for being exempt (one sent before they were keeps the tax it was sent with).
  const taxExempt = Boolean(inv.client?.tax_exempt) && Number(inv.tax_rate) === 0;
  const lastPayment = inv.payments.at(-1);
  // Written off by a refund's "Take it off the invoice too": what's left is money given back, not a debt given up on.
  const refundedOff = writtenOff && balance > 0 && -inv.payments.filter((p) => Number(p.amount) < 0).reduce((sum, p) => sum + Number(p.amount), 0) >= balance - 0.005;
  // The Stripe invoice that matters now: the live one, else the latest. A tip added after an
  // automatic charge is its own small Stripe invoice, and isn't the one for this invoice's bill.
  const billed = inv.stripe.filter((s) => s.purpose !== "tip");
  const stripe = billed.find((s) => s.status === "open" || s.status === "processing") ?? billed.find((s) => s.stripe_id);
  const bank = bankPayment(inv.stripe);
  // Charged automatically (autopay): its charge, if one is still going or done. Only one at a time
  // isn't called off, and one called off leaves the invoice to be sent and paid as usual.
  const charge = inv.autopay.find((a) => a.status !== "called_off") ?? null;
  // The task holds it: Stripe is charging it, and the database refuses changes to it meanwhile.
  const charging = charge?.status === "charging";
  const card = charge?.method ? methodLabel(charge.method) : "the saved card";
  // Its bank payment is on its way: it settles or bounces on its own, so payments, voiding and moving
  // it back to draft wait until then (the database holds them back too), and this says why. Not in a
  // Stripe account Crewtavo has since left: Crewtavo won't hear how that one ends, so the office
  // follows it there, as any bank payment there (bankNote says so), and nothing waits for it.
  const left = inv.stripe.some((s) => s.collection === "charge_automatically" && s.purpose === "invoice" && s.status === "processing" && Boolean(s.detached_at));
  const clearing = charge?.status === "processing" && !left;
  const clearingNote = clearing ? autopayBankNote(card, bank, session.company.timezone) : null;
  // Any other bank payment on its way: said next to Record payment, and asked about before recording one.
  const bankNote = bank && balance > 0 && !clearing ? bankPaymentNote(bank, session.company.timezone) : null;
  const clientName = inv.client?.display_name ?? "The client";
  // Over the limit, or with visits autopay didn't queue itself: the draft waits for the office.
  const asking = charge?.status === "needs_approval" && draft;
  // A bank account is never charged more than the limit, so there's no OK to give for one: the
  // database closes the charge at the task's next run, and the invoice goes to the client to pay.
  const cap = autopaySettings(session.company.settings, session.company.trade_preset).max_amount;
  const noOk = asking && autopaySettings(session.company.settings, session.company.trade_preset).enabled && noOkForBank(charge.method, balance, cap);
  // Closed for that already (its newest charge), and still owed: what happened to it, and why.
  const newest = inv.autopay[0];
  const toClient = !charge && newest?.status === "called_off" && newest.bank_limit != null && balance > 0 && !isVoid && !writtenOff ? newest : null;
  // Declined, or the client has to do something: they were sent the Pay link, and a reminder is the next step.
  // Not while their bank payment is on its way (bankNote says so): nothing is tried again meanwhile.
  // One in a Stripe account Crewtavo left doesn't hold the retry back, so that one still says it.
  // Moved back to be tried on a card the client agreed to since (autopay_try_new_card: no failures
  // on it): said as one waiting, so nothing says that card was declined.
  const onNewCard = charge?.status === "failed" && charge.failures === 0;
  const chargeFailed = ((charge?.status === "failed" && !onNewCard) || charge?.status === "needs_client") && balance > 0 && (!bank || bank.left);
  // A draft being charged stays as it is until it's done (the database refuses edits meanwhile).
  const editable = draft && !charging;
  // Made in Stripe: paid as Stripe billed it, so its total changes there, not here.
  const fromStripe = inv.stripe.some((s) => s.origin === "stripe");
  // Edit invoice: a sent invoice's lines, changed in place with its payments as they are (the
  // database's edit_invoice). It waits while the client is paying the amount as it stands.
  const editing = editOffer(inv, { fromStripe, charging, bankOnItsWay: Boolean(bank) || clearing });
  // Remove late fee, the "No late fee on this invoice" tick, and what's said once one was taken off.
  const fees = lateFeeControls(inv, { feesOn: Boolean(lateFee), fromStripe });
  const feeTotal = inv.lines.filter((l) => l.kind === "late_fee").reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_price), 0);
  // And while it's open there, so do its payments.
  const paysInStripe = paidInStripe(inv.stripe);
  // Charge card: not while a charge is going, or a bank payment (in a Stripe account left too, while
  // it may still clear there) or Stripe is collecting it already. The server says the same.
  const manual = balance > 0 && !inv.autopay.some((a) => LIVE_CHARGES.has(a.status)) && !paysInStripe && !bank ? (chargeable.data?.manual ?? null) : null;
  const chargeNow = async (card: string) => {
    const amount = formatMoneyCents(balance);
    const ok = await confirm({
      title: `Charge ${amount} to ${card}?`,
      body: `Invoice #${inv.number}${inv.client ? ` for ${inv.client.display_name}` : ""}. It's charged in the next minute or so, and this page shows when it goes through.${draft ? " The draft is marked as sent, without an email." : ""}`,
      confirmLabel: `Charge ${amount}`,
    });
    if (ok) chargeCard.mutate(balance);
  };

  // A payment marked by mistake goes at once, with Undo, and the balance goes back up with it. On a
  // paid invoice past its due date, the toast says what that means (the database raises no past-due
  // event that day: 20261113000430_owed_again_without_chasing.sql).
  type Loaded = typeof inv;
  const takeOff = (payment: Loaded["payments"][number]) => {
    const key = ["invoice", id];
    undoable({
      title: "Payment removed",
      description: owedAgainNote(inv, Number(payment.amount), today) ?? undefined,
      tone: "invoice",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Loaded>(key, (current) => current && settle(current, current.payments.filter((p) => p.id !== payment.id), today));
      },
      restore: () =>
        queryClient.setQueryData<Loaded>(key, (current) =>
          current && !current.payments.some((p) => p.id === payment.id) ? settle(current, [...current.payments, payment].sort((a, b) => a.received_at.localeCompare(b.received_at)), today) : current,
        ),
      commit: () => removePayment.mutateAsync(payment.id),
    });
  };

  // One green button: Send invoice on a draft (unless it waits for an OK to charge), Record payment on one still owed.
  const sendFirst = draft && !asking;
  const owes = !draft && !isVoid && balance > 0;
  const sendTitle = !inv.lines.length ? "Add a line item first" : charging ? `Charging ${card} now` : undefined;
  const recordTitle = paysInStripe ? "Made in Stripe: record its payments there" : charging ? `Charging ${card} now` : (clearingNote ?? bankNote ?? undefined);
  // The past-due note shows (with its reminder): the phone's bar says "Send a reminder" for Resend too.
  const lateShown = daysLate > 0 && !bank && !clearing;
  // A phone keeps the main actions in a bar above the tab bar, when there's a green one to put in it.
  const bar = sendFirst || owes;
  const sendButton = (inBar: boolean) =>
    !isVoid && !writtenOff && (
      <Button className={inBar ? (sendFirst ? undefined : styles.barQuiet) : bar ? "hide-mobile" : undefined} icon="send" variant={sendFirst ? "primary" : "secondary"} disabled={!inv.lines.length || charging} title={sendTitle} onClick={() => setDialog("send")}>
        {draft ? "Send invoice" : inBar && lateShown ? "Send a reminder" : "Resend"}
      </Button>
    );
  const recordButton = (inBar: boolean) =>
    owes && (
      <Button className={inBar ? (manual && !isVoid && !writtenOff ? styles.barWide : undefined) : "hide-mobile"} variant="primary" icon="dollar" disabled={paysInStripe || charging || clearing} title={recordTitle} onClick={() => setDialog("payment")}>
        Record payment
      </Button>
    );

  return (
    <>
      <DetailHeader
        crumb={{ to: "/invoices", label: "Invoices" }}
        title={`Invoice #${inv.number}`}
        status={<EntityStatus kind="invoice" status={inv.status} />}
        meta={[
          inv.client && <ClientPreview id={inv.client.id}><Link to={`/clients/${inv.client.id}`} className={styles.client}>{inv.client.display_name}</Link></ClientPreview>,
          inv.job && <Link to={`/jobs/${inv.job.id}`} className={styles.job}>Job #{inv.job.number}: {inv.job.title}</Link>,
          inv.kind === "progress" && <span className="tag">Pay application {inv.pay_app_number}</span>,
          inv.kind === "deposit" && <span className="tag">Deposit</span>,
          inv.kind === "retainage" && <span className="tag">Retainage</span>,
          inv.kind === "visits" && <span className="tag">Completed visits</span>,
          <SaveStatus status={save.status} />,
        ]}
        actions={
          <>
            {sendButton(false)}
            {manual && <Button className={bar ? "hide-mobile" : undefined} icon="card" loading={chargeCard.isPending} onClick={() => void chargeNow(manual.card)}>Charge card</Button>}
            {recordButton(false)}
          </>
        }
        // While it's being charged, or its bank payment is on its way, the menu leaves out what the database refuses until it's done.
        more={[
          { label: "Preview as client", icon: "eye", kbd: "V", onSelect: () => openClientView.mutate(false) },
          { label: "Print or save PDF", icon: "printer", kbd: "P", onSelect: () => openClientView.mutate(true) },
          { separator: true },
          { label: "Mark as sent", icon: "check", hidden: !draft || !inv.lines.length || charging, onSelect: () => update.mutate({ status: "sent" }) },
          { label: "Record payment", icon: "dollar", hidden: !draft || !inv.lines.length || charging || clearing, onSelect: () => setDialog("payment") },
          { label: "Edit invoice", icon: "edit", hidden: !editing.offered, disabled: Boolean(editing.waits), title: editing.waits ?? undefined, onSelect: () => setDialog("edit") },
          { label: "Move back to draft", icon: "undo", hidden: draft || isVoid || writtenOff || inv.payments.length > 0 || fromStripe || charging || clearing, onSelect: () => update.mutate({ status: "draft", sent_at: null }) },
          {
            label: "Remove late fee",
            icon: "x",
            hidden: !fees.remove || charging,
            // The client is paying the amount with the fee in it.
            disabled: Boolean(bank) || clearing,
            onSelect: async () => {
              const ok = await confirm({
                title: `Remove the ${formatMoneyCents(feeTotal)} late fee?`,
                body: `It comes off invoice #${inv.number}, and no late fee is added to this invoice again.`,
                confirmLabel: "Remove late fee",
              });
              if (ok) removeLateFee.mutate();
            },
          },
          {
            label: "Write off",
            icon: "archive",
            hidden: draft || isVoid || writtenOff || inv.status === "paid" || balance <= 0 || charging,
            // A bank payment on its way may still pay it.
            disabled: Boolean(bank) || clearing,
            onSelect: async () => {
              const ok = await confirm({
                title: `Write off invoice #${inv.number}?`,
                body: `${formatMoneyCents(balance)} stops counting as owed: it comes off your unpaid invoices and receivables, and no more reminders go out. The invoice still counts toward what you've invoiced. If ${inv.client?.display_name ?? "the client"} pays later, record the payment here. You can undo this.`,
                confirmLabel: "Write off",
              });
              if (ok) writeOff.mutate(true);
            },
          },
          { label: "Undo write-off", icon: "undo", hidden: !writtenOff, onSelect: () => writeOff.mutate(false) },
          { separator: true },
          {
            label: "Void invoice",
            icon: "x",
            danger: true,
            hidden: isVoid || paid !== 0 || charging || clearing,
            onSelect: async () => {
              const promo = await givenBack();
              if (await confirm({ title: `Void invoice #${inv.number}?`, body: `It stays on record but no longer counts as owed. Visits it covered can be invoiced again.${promo ? ` ${promo}` : ""}`, confirmLabel: "Void invoice", danger: true })) update.mutate({ status: "void" });
            },
          },
          {
            label: "Delete draft",
            icon: "trash",
            danger: true,
            hidden: !draft || paid !== 0 || charging || clearing,
            onSelect: async () => {
              const promo = await givenBack();
              if (await confirm({ title: `Delete draft invoice #${inv.number}?`, body: `This can't be undone.${promo ? ` ${promo}` : ""}`, confirmLabel: "Delete", danger: true })) remove.mutate();
            },
          },
        ]}
      >
        {/* A phone opens on what's owed (Mobile-Sales.dc.html, Invoice), and Totals leaves it out there; a desktop has it in Totals. */}
        {!isVoid && (
          <div className={styles.hero}>
            <span className={styles.heroLabel}>{writtenOff ? statusText("invoice", "written_off") : "Balance due"}</span>
            <span className={styles.heroValue} data-tone={balance > 0 && daysLate > 0 ? "danger" : writtenOff ? "muted" : undefined}>{formatMoneyCents(balance)}</span>
          </div>
        )}
      </DetailHeader>

      <DetailColumns
        grouped
        className={styles.cols}
        side={
          <>
            <Section title="Totals">
              <div className={`totals ${styles.totals}`}>
                <div className="line"><span>Subtotal</span><AnimatedNumber value={Number(inv.subtotal)} format={MONEY_CENTS} /></div>
                <DiscountRows
                  kind="invoice"
                  id={inv.id}
                  promo={inv.promo}
                  discount={Number(inv.discount_amount)}
                  subtotal={Number(inv.subtotal)}
                  canEditDiscount={editable}
                  // Not while a bank payment clears or the card is being charged: the client is paying what Stripe asked for (the database says why).
                  // One code to an invoice: one with its job's code on a line takes no other.
                  canChangePromo={!isVoid && !fromStripe && !bank && !charging && inv.payments.length === 0 && ["draft", "sent", "overdue"].includes(inv.status) && (Boolean(inv.promo) || !promoJobId)}
                  onSaveDiscount={(v) => saveField({ discount_amount: v })}
                  onEditDiscount={save.edited}
                  onUnchangedDiscount={unchanged}
                  onChanged={refresh}
                />
                <ReferralCredits invoice={inv} onChanged={refresh} />
                <div className="line">
                  <span>{taxExempt ? `Tax exempt${inv.client?.tax_exempt_note ? ` · ${inv.client.tax_exempt_note}` : ""}` : `${tax}${editable ? "" : ` (${formatTaxRate(inv.tax_rate)})`}`}</span>
                  {/* A tax-exempt client is never charged tax: the database keeps the rate at 0. */}
                  {editable && !taxExempt ? <MoneyInput percent label="Tax rate" value={taxPercent(inv.tax_rate)} max={99.99} onSave={(v) => saveField({ tax_rate: taxRateFromPercent(v) })} onEdit={save.edited} onUnchanged={unchanged} /> : <AnimatedNumber value={Number(inv.tax_amount)} format={MONEY_CENTS} />}
                </div>
                {editable && !taxExempt && <div className="line"><span>{tax} amount</span><AnimatedNumber value={Number(inv.tax_amount)} format={MONEY_CENTS} /></div>}
                <div className="line" data-total=""><span>Total</span><AnimatedNumber value={Number(inv.total)} format={MONEY_CENTS} /></div>
                {Number(inv.retainage_amount) > 0 && <div className="line"><span>Retainage held ({Number(inv.retainage_pct)}%)</span><span>−<AnimatedNumber value={Number(inv.retainage_amount)} format={MONEY_CENTS} /></span></div>}
                {paid !== 0 && <div className="line"><span>Paid</span><span>−<AnimatedNumber value={paid} format={MONEY_CENTS} /></span></div>}
              </div>
              {/* A void or written-off invoice's figure is quiet, under its status: on record, not owed. */}
              <div className={styles.due} data-repeated={!isVoid || undefined}>
                <span className={styles.dueLabel}>{isVoid ? statusText("invoice", "void") : writtenOff ? statusText("invoice", "written_off") : "Balance due"}</span>
                <span className={styles.dueValue} data-tone={balance > 0 && daysLate > 0 ? "danger" : writtenOff || isVoid ? "muted" : undefined}><AnimatedNumber value={balance} format={MONEY_CENTS} /></span>
              </div>
            </Section>
            <Section title="Dates">
              <Facts>
                <Fact label="Issued">
                  {draft ? <input className="input input-sm" type="date" style={{ width: 150 }} value={inv.issued_on} onChange={(e) => e.target.value && saveField({ issued_on: e.target.value })} aria-label="Issued on" /> : formatDate(inv.issued_on)}
                </Fact>
                <Fact label="Due" tone={daysLate > 0 ? "danger" : undefined}>
                  {draft ? <input className="input input-sm" type="date" style={{ width: 150 }} value={inv.due_on ?? ""} min={inv.issued_on} onChange={(e) => saveField({ due_on: e.target.value || null })} aria-label="Due on" /> : inv.due_on ? formatDate(inv.due_on) : "On receipt"}
                </Fact>
                <Fact label="Sent">{inv.sent_at && formatDate(inv.sent_at)}</Fact>
                <Fact label="PO">{inv.job?.po_number}</Fact>
              </Facts>
              {(draft || fees.tick || fees.note) && (
                <div className={styles.after}>
                  {draft && (
                    <div className={styles.terms} role="group" aria-label="Payment terms">
                      {[["On receipt", 0], ["Net 15", 15], ["Net 30", 30], ["Net 45", 45]].map(([l, d]) => (
                        <button key={l} type="button" aria-pressed={inv.due_on === addDaysIso(inv.issued_on, Number(d))} onClick={() => saveField({ due_on: addDaysIso(inv.issued_on, Number(d)) })}>{l}</button>
                      ))}
                    </div>
                  )}
                  {/* Late fees for this invoice: off with a tick before one goes on, and said once one was taken off. */}
                  {fees.tick && (
                    <label className="checkbox small">
                      <input type="checkbox" checked={Boolean(inv.no_late_fee)} disabled={edit.isPending} onChange={(e) => saveField({ no_late_fee: e.target.checked })} /> No late fee on this invoice
                    </label>
                  )}
                  {fees.note && <span className="muted small">{fees.note}</span>}
                </div>
              )}
            </Section>
            <CustomFieldsCard record="invoice" values={inv.custom_fields} editable={!isVoid} onSave={async (values) => { unwrap(await supabase().from("invoices").update({ custom_fields: values }).eq("id", inv.id)); refresh(); }} />
            {stripe?.stripe_id && <StripeSection stripe={stripe} />}
            <InvoiceDrawings invoiceId={inv.id} clientId={inv.client_id} jobId={inv.job?.id ?? null} editable={!isVoid} />
          </>
        }
      >
        {/* What someone must notice on this invoice: one line each, over its lines. */}
        <div className={styles.notes}>
          {isVoid && <div className="callout"><Icon name="x" size={16} /><div className="grow">This invoice is void and isn't owed.</div></div>}
          {writtenOff && (
            <div className="callout">
              <Icon name="archive" size={16} />
              <div className="grow">
                {refundedOff
                  ? `Refunded and taken off${inv.written_off_at ? ` on ${formatDate(inv.written_off_at)}` : ""}: the ${formatMoneyCents(balance)} given back isn't counted as owed.`
                  : `Written off${inv.written_off_at ? ` on ${formatDate(inv.written_off_at)}` : ""}: ${formatMoneyCents(balance)} isn't counted as owed. If the client pays after all, record it and the invoice is marked paid.`}
              </div>
              <Button size="sm" icon="undo" disabled={writeOff.isPending} onClick={() => writeOff.mutate(false)}>Undo write-off</Button>
            </div>
          )}
          {inv.status === "paid" && (
            <div className="callout callout-good">
              <Icon name="check" size={16} />
              <div className="grow">
                {charge?.status === "paid" ? `Paid automatically with ${card} on ${formatDate(charge.charged_at ?? lastPayment?.received_at)}.` : paidWords(paid, Number(inv.credit_amount), lastPayment?.received_at ? formatDate(lastPayment.received_at) : null)}
              </div>
            </div>
          )}
          {charging && <div className="callout callout-info"><Icon name="card" size={16} /><div className="grow">Charging {card} now.</div></div>}
          {/* Approved, or on its way back to the task after a moment's wait. */}
          {(charge?.status === "waiting" || onNewCard) && charge && (
            <div className="callout callout-info">
              <Icon name="card" size={16} />
              <div className="grow">{charge.approved_at ? `Charging ${card} in the next few minutes.` : `Charged automatically to ${card} ${autopayDueText(charge.due_at, session.company.timezone, undefined, companyCountry())}.`}</div>
            </div>
          )}
          {bankNote && <div className="callout callout-info"><Icon name="clock" size={16} /><div className="grow">{bankNote}</div></div>}
          {/* The bank payment the charge started: why Record payment waits. */}
          {clearingNote && !isVoid && balance > 0 && <div className="callout callout-info"><Icon name="clock" size={16} /><div className="grow">{clearingNote}</div></div>}
          {asking && charge && (
            <div className="callout callout-warning">
              <Icon name="card" size={16} />
              <div className="grow">{noOk ? bankLimitText(balance, cap!, card, clientName, charge.last_error ? "held" : "waiting", charge.last_error) : approvalText(charge, balance, cap)}</div>
              <div className="row wrap" style={{ gap: 6 }}>
                {!noOk && <Button size="sm" variant="primary" icon="check" loading={approveCharge.isPending} disabled={callOffCharge.isPending} onClick={() => approveCharge.mutate(charge.id)}>Approve charge</Button>}
                <Button size="sm" icon="send" loading={callOffCharge.isPending} disabled={approveCharge.isPending || !inv.lines.length} onClick={() => callOffCharge.mutate(charge.id)}>{noOk ? "Send it now" : "Send it the usual way"}</Button>
              </div>
            </div>
          )}
          {/* Over the limit for a bank account: not charged, by anyone. It's an unpaid invoice like any other from here. */}
          {toClient && (
            <div className="callout callout-info">
              <Icon name="card" size={16} />
              <div className="grow">{bankLimitText(balance, Number(toClient.bank_limit), toClient.method ? methodLabel(toClient.method) : "their bank account", clientName, toClient.send_state, toClient.send_error)}</div>
              {toClient.send_state !== "waiting" && toClient.send_state !== "sending" && (
                <Button size="sm" icon="send" disabled={!inv.lines.length} onClick={() => setDialog("send")}>{toClient.send_state === "sent" ? "Send again" : draft ? "Send invoice" : "Send a reminder"}</Button>
              )}
            </div>
          )}
          {chargeFailed && charge && (
            <div className="callout callout-danger">
              <Icon name="card" size={16} />
              <div className="grow">
                {charge.status === "failed"
                  ? `Autopay failed${charge.last_error ? `: ${clause(charge.last_error)}` : ""}. ${clientName} was sent the Pay link and a way to update their card. We'll try again ${autopayDueText(charge.due_at, session.company.timezone, undefined, companyCountry())}.`
                  : `Autopay needs ${clientName}: ${needsClientReason(charge)}.`}
              </div>
              <Button size="sm" icon="send" onClick={() => setDialog("send")}>Send a reminder</Button>
            </div>
          )}
          {/* Up front, rather than refused once someone has filled in a payment. */}
          {paysInStripe && !bank && !isVoid && balance > 0 && <div className="callout callout-info"><Icon name="info" size={16} /><div className="grow">{RECORD_IN_STRIPE}</div></div>}
          {lateShown && (
            <div className="callout callout-danger">
              <Icon name="clock" size={16} />
              <div className="grow"><strong>{daysLate} {daysLate === 1 ? "day" : "days"} past due.</strong> {formatMoneyCents(balance)} is still owed.{lateFeeDay ? ` A ${formatMoneyCents(lateFeeAmount(balance, lateFee!))} late fee goes on ${formatDate(lateFeeDay)}.` : ""}{inv.past_due_notice_pending ? " It was paid and is owed again, so the client isn't reminded today." : ""}</div>
              {/* A failed charge's callout above has the reminder already. */}
              {!chargeFailed && <Button size="sm" icon="send" className={bar ? "hide-mobile" : undefined} onClick={() => setDialog("send")}>Send a reminder</Button>}
            </div>
          )}
          {!isVoid && balance < 0 && <div className="callout callout-info"><Icon name="info" size={16} /><div className="grow">The client paid {formatMoneyCents(-balance)} more than they owed. Record a refund, or keep it as a credit for their next invoice.</div></div>}
        </div>
        {draft && <SubjectField value={inv.subject} onEdit={save.edited} onUnchanged={unchanged} onSave={(subject) => saveField({ subject })} />}
        <Section
          title="Line items"
          count={inv.lines.length || undefined}
          // A draft's editor is its own box; a sent invoice's lines are a phone's inset card.
          flush={editable}
          action={
            // Sent: its lines change through Edit invoice, in one step, with its payments left as they are.
            editing.offered ? (
              <Button size="sm" icon="edit" disabled={Boolean(editing.waits)} onClick={() => setDialog("edit")}>Edit invoice</Button>
            ) : editable && inv.job && ["standard", "visits"].includes(inv.kind) ? (
              <Button size="sm" icon="clock" onClick={() => setDialog("work")}>Add logged hours and materials</Button>
            ) : undefined
          }
        >
          <div className={editable ? undefined : "hide-mobile"}>
            <LineItems
              table="invoice_line_items"
              parent="invoice_id"
              parentId={inv.id}
              lines={inv.lines}
              editable={editable}
              onChanged={refresh}
              // Work that repeats has a next invoice for a once-per-job code to go on, which the toast can say.
              promoJob={inv.job ? { id: inv.job.id, repeats: inv.job.kind === "recurring" || inv.job.billing_mode === "per_visit" } : null}
            />
          </div>
          {/* A phone reads a sent invoice's lines as the kit's rows: the item, how many at what, its total (Mobile-Sales.dc.html). */}
          {!editable && (
            <ul className={`rel ${styles.phoneOnly}`} role="list" aria-label="Line items">
              {inv.lines.map((l) => (
                <RelatedRow key={l.id} title={l.name} sub={[`${formatQuantity(Number(l.quantity))} ${l.unit} × ${formatMoneyCents(Number(l.unit_price))}`, l.description]} end={<b>{formatMoneyCents(lineTotal(l.quantity, l.unit_price))}</b>} />
              ))}
            </ul>
          )}
          {editing.waits && <p className={styles.quiet}>{editing.waits}</p>}
        </Section>
        <NotesSection value={inv.notes} editable={!isVoid} onEdit={save.edited} onUnchanged={unchanged} onSave={(notes) => saveField({ notes })} />
        <Section title="Payments" count={inv.payments.length || undefined}>
          <ul className="rel" role="list" aria-label="Payments" ref={paymentRows}>
            {inv.payments.map((p) => {
              const shown = paymentAmount(p);
              return (
                <RelatedRow
                  key={p.id}
                  lead={<span className="rel-icon" data-tone={shown.back ? "danger" : "good"}><Icon name={shown.back ? "undo" : "dollar"} size={15} /></span>}
                  title={<>{shown.amount}{shown.tip && <span className={styles.tip}> {shown.tip}</span>}</>}
                  sub={[
                    `${METHODS[p.method] ?? p.method}${p.processor ? ` via ${p.processor === "stripe" ? "Stripe" : p.processor}` : ""}`,
                    p.notes,
                    Number(p.fee_amount) > 0 && `${formatMoneyCents(p.fee_amount)} fee`,
                    p.payout && `${p.payout.status === "paid" ? "Deposited" : "Arrives"} ${formatDate(p.payout.arrival_on)}`,
                  ]}
                  end={formatDate(p.received_at)}
                  actions={
                    /*
                      Payments recorded here are refunded and removed here. One Stripe took is refunded
                      through Stripe (Refund here, or in Stripe's dashboard), and either way the refund
                      is booked from Stripe, so it shows up here as a negative payment on its own.
                    */
                    !p.processor ? (
                      <Menu
                        triggerClassName="btn btn-sm btn-ghost btn-icon"
                        label="Payment actions"
                        title={shown.amount}
                        items={[
                          // Hidden once it's all been refunded.
                          { label: "Record a refund", icon: "undo", hidden: refundable(p, inv.payments) <= 0, onSelect: () => setRefunding({ id: p.id, amount: Number(p.amount), method: p.method }) },
                          { separator: true },
                          { label: "Remove payment", icon: "trash", danger: true, onSelect: () => takeOff(p) },
                        ]}
                      />
                    ) : (
                      stripeCharge(p) && (
                        <Menu
                          triggerClassName="btn btn-sm btn-ghost btn-icon"
                          label="Payment actions"
                          title={shown.amount}
                          items={[
                            // The menu can't explain a turned-off item itself, so it says why above it.
                            { heading: "Needs a new Stripe key", hidden: canRefund },
                            // Hidden once it's all been refunded.
                            { label: "Refund", icon: "undo", hidden: stripeRefundable(p, inv.payments) <= 0, disabled: !canRefund, title: canRefund ? undefined : "Your Stripe key can't make refunds. Update it on the Apps page.", onSelect: () => setStripeRefund(p) },
                          ]}
                        />
                      )
                    )
                  }
                />
              );
            })}
          </ul>
          {inv.payments.length === 0 && <EmptyState inline title="No payments yet" />}
        </Section>
        {/* What the client's copy says about a late fee, where one could still go on this invoice. */}
        <InvoicePaper invoice={inv} lateFeeNote={lateFeeCouldApply(inv, lateFee, fromStripe) ? lateFeeNotice(lateFee, formatMoneyCents) : null} />
      </DetailColumns>

      {bar && (
        <ActionBar>
          {owes && sendButton(true)}
          {manual && <Button className={styles.barQuiet} icon="card" loading={chargeCard.isPending} onClick={() => void chargeNow(manual.card)}>Charge card</Button>}
          {owes ? recordButton(true) : sendButton(true)}
        </ActionBar>
      )}

      {dialog === "send" && <SendDialog kind="invoice" id={inv.id} number={inv.number} email={inv.client?.email ?? null} phone={inv.client?.phone ?? null} textsOffSince={inv.client?.sms_opt_out_at} onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === "edit" && <EditInvoiceDialog invoice={{ id: inv.id, number: inv.number, updated_at: inv.updated_at, lines: inv.lines }} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "work" && inv.job && <AddWorkDialog invoiceId={inv.id} jobId={inv.job.id} onClose={() => { setDialog(null); refresh(); }} />}
      {dialog === "payment" && <PaymentDialog invoice={{ id: inv.id, client_id: inv.client_id, balance, draft }} bank={bankNote} onClose={() => setDialog(null)} onSaved={refresh} />}
      {refunding && <RefundDialog invoice={{ id: inv.id, client_id: inv.client_id, status: inv.status, due_on: inv.due_on, balance_due: balance }} payment={refunding} left={refundable(refunding, inv.payments)} onClose={() => setRefunding(null)} onSaved={refresh} />}
      {stripeRefund && <StripeRefundDialog invoice={{ status: inv.status, due_on: inv.due_on, balance_due: balance }} payment={stripeRefund} left={stripeRefundable(stripeRefund, inv.payments)} onClose={() => setStripeRefund(null)} onSaved={refreshSoon} />}
    </>
  );
}

/** A line's quantity as people write it: "4", "1.5", "1,600". */
const formatQuantity = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(n);

/** A message from Stripe or the database as part of a sentence: without its full stop. */
const clause = (text: string) => text.trim().replace(/[.\s]+$/, "");

/** Stripe's answers that mean the client's bank wants them to confirm the payment themselves. */
const CONFIRM_CODES = new Set(["authentication_required", "invoice_payment_intent_requires_action"]);

/**
 * Why a charge waits on the client, in the words the office is told (the database's notice for it):
 * a bank payment that bounced or a card declined twice pauses autopay until they update it (a
 * declined Charge card just sends them the Pay link); their
 * bank asking them to confirm the payment; else what Stripe said.
 */
function needsClientReason(charge: { source: string; failures: number; last_error: string | null; decline_code: string | null; method: { type: string } | null }): string {
  if (charge.failures > 0 && (charge.method?.type === "us_bank_account" || charge.decline_code === "bank_failed")) return "their bank payment didn't go through, so autopay is paused until they update it";
  // Charge card isn't tried again, and one decline the office asked for doesn't pause autopay.
  if (charge.failures > 0 && charge.source === "manual") return "the card was declined, so they were sent the Pay link and a way to update their card";
  if (charge.failures >= 2) return "the card was declined twice, so autopay is paused until they update it";
  if (CONFIRM_CODES.has(charge.decline_code ?? "") || !charge.last_error) return "their bank wants them to confirm the payment";
  return clause(charge.last_error);
}

/**
 * The invoice as it prints, and as the client's link shows it: letter pages on the business's
 * template (its default, as the link uses), with the template's terms and its invoice sections filled
 * in for this invoice. It follows the edits above as they're saved.
 */
function InvoicePaper({ invoice, lateFeeNote }: { invoice: DocumentInvoice & { custom_fields: unknown } & { client: { display_name: string; billing_address: unknown } | null; job: { property: unknown; quote?: InvoiceQuote | null } | null }; lateFeeNote: string | null }) {
  const session = useSession();
  const { template, isPending } = useDocumentTemplate(null);
  const letterhead = useLetterhead();
  const fields = useCustomFields("invoice");
  const terms = useInvoiceContract(
    isPending
      ? null
      : // {Option} and {Warranty} say what the client chose on the quote the job came from, as the client's link says them.
        { invoice: { number: invoice.number, issued_on: invoice.issued_on, total: invoice.total }, template, client: invoice.client, property: invoice.job?.property ?? null, fill: invoiceFill(invoice.job?.quote) },
  );
  const ready = !isPending && !terms.isPending;
  // Without the contract, the terms are left off too: the template's own would print with their fill-ins unfilled.
  const contract = terms.contract ?? (terms.error ? NO_CONTRACT : null);
  return (
    <Section title="As it prints" flush className={styles.paperLast}>
      {ready ? (
        <div className={styles.paper}>
          {terms.error && (
            <p className={styles.quiet}>
              The terms didn't load, so they're not on the pages below. The client's copy has them.{" "}
              <button type="button" className="link-btn" onClick={terms.refetch}>Try again</button>
            </p>
          )}
          <DocumentSheet
            template={contractTemplate(template, contract)}
            company={letterhead.data ?? documentCompany(session.company)}
            data={invoiceDocument({ ...invoice, pdf_fields: shownCustomFields(fields, invoice.custom_fields, "pdf", companyCountry()) }, { timeZone: session.company.timezone, contract, lateFeeNote })}
          />
        </div>
      ) : (
        <Skeleton height="auto" radius={4} style={{ aspectRatio: "8.5 / 11" }} />
      )}
    </Section>
  );
}

// Stripe's invoice states in Crewtavo's words where there's one for it.
const STRIPE_STATUS: Record<string, string> = {
  open: statusText("invoice", "sent"),
  processing: "Bank payment on its way",
  paid: statusText("invoice", "paid"),
  void: statusText("invoice", "void"),
  uncollectible: "Written off in Stripe",
};

/** Where this invoice is in Stripe, with a way to open it there or copy its payment page. Autopay's are charged to the saved card or bank account. */
function StripeSection({ stripe }: { stripe: { stripe_id: string | null; origin: string; status: string; number: string | null; hosted_url: string | null; livemode: boolean; collection: string } }) {
  const dashboard = `https://dashboard.stripe.com/${stripe.livemode ? "" : "test/"}invoices/${stripe.stripe_id}`;
  return (
    <Section title="Stripe" action={<a href={dashboard} target="_blank" rel="noreferrer">Open in Stripe <Icon name="external" size={14} /></a>}>
      <Facts>
        <Fact label={stripe.origin === "stripe" ? "Made in Stripe" : "Invoice"}>{stripe.number}</Fact>
        <Fact label="Status">{STRIPE_STATUS[stripe.status] ?? stripe.status}</Fact>
        {stripe.collection === "charge_automatically" && <Fact label="Charged">Automatically</Fact>}
        {stripe.hosted_url && stripe.status === "open" && (
          <Fact label="Payment link">
            <button type="button" className="link-btn" aria-label="Copy payment link" onClick={() => copyText(stripe.hosted_url!, "Payment link copied")}>Copy</button>
          </Fact>
        )}
      </Facts>
      {!stripe.livemode && <p className={styles.quiet}>Test mode: no real money moves.</p>}
    </Section>
  );
}

/** A draft's subject, over its lines. `onEdit` on every keystroke (the header says "Edited"), `onSave` when the field is left changed, `onUnchanged` when it's left as it was. */
function SubjectField({ value, onEdit, onUnchanged, onSave }: { value: string | null; onEdit: () => void; onUnchanged: () => void; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <label className={`field ${styles.subject}`}>
      <span>Subject <span className="optional">(shown at the top of the invoice)</span></span>
      <input className="input" value={draft} maxLength={200} onChange={(e) => { setDraft(e.target.value); onEdit(); }} onBlur={() => (draft.trim() !== (value ?? "") ? onSave(draft.trim() || null) : onUnchanged())} placeholder="Spring cleanup, May services…" />
    </label>
  );
}

/** The note on the client's copy: a thank-you, how to pay. Read-only, and left out when empty, on a void invoice. */
function NotesSection({ value, editable, onEdit, onUnchanged, onSave }: { value: string | null; editable: boolean; onEdit: () => void; onUnchanged: () => void; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  if (!editable) return value ? <Section title="Note to client"><p className={`pre-wrap ${styles.note}`}>{value}</p></Section> : null;
  return (
    <Section title="Note to client" flush>
      <textarea className={`textarea ${styles.noteInput}`} aria-label="Note to client" value={draft} maxLength={4000} onChange={(e) => { setDraft(e.target.value); onEdit(); }} onBlur={() => (draft.trim() !== (value ?? "") ? onSave(draft.trim() || null) : onUnchanged())} placeholder="Thank you for your business. Checks payable to…" />
    </Section>
  );
}

/**
 * `bank` says a bank payment from the Pay link is on its way, so recording another is confirmed first
 * (it isn't refused: it can bounce). Autopay's own is refused by the database until it clears or
 * bounces, so Record payment waits for that instead.
 */
function PaymentDialog({ invoice, bank, onClose, onSaved }: { invoice: { id: string; client_id: string; balance: number; draft: boolean }; bank: string | null; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [amount, setAmount] = useState(invoice.balance > 0 ? invoice.balance.toFixed(2) : "");
  const [tip, setTip] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("check");
  const [date, setDate] = useState(todayIn(session.company.timezone));
  const [notes, setNotes] = useState("");
  const value = Number(amount);
  const tooMuch = value > invoice.balance + 0.005;
  // The payment's id, made once: sent twice, it's still one payment (recordPayment.ts).
  const [paymentId] = useState(() => crypto.randomUUID());
  const save = useMutation({
    meta: { inline: true, success: "Payment recorded", tone: "invoice" },
    mutationFn: () =>
      recordPayment({
        id: paymentId,
        companyId: session.company.id,
        currency: session.company.currency,
        invoice,
        amount: value,
        tip: Number(tip),
        method,
        receivedAt: new Date(`${date}T12:00:00`).toISOString(),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Record payment" description={`Balance due ${formatMoneyCents(invoice.balance)}`}>
      <form
        onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          if (bank && !(await confirm({ title: "A bank payment is still clearing", body: bank, confirmLabel: "Record it anyway" }))) return;
          save.mutate();
        }}
      >
        <div className="form-grid">
          <Field label="Amount" requiredMessage="Enter the amount you received." error={tooMuch ? `More than the ${formatMoneyCents(invoice.balance)} balance.` : null}>
            <span className="input-group"><span className="addon">{currencySymbol()}</span><DecimalInput className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
          </Field>
          <Field label="Tip" optional>
            <span className="input-group"><span className="addon">{currencySymbol()}</span><DecimalInput className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value.replace(/[^0-9.]/g, ""))} /></span>
          </Field>
          <Field label="Method">
            <Select className="select" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {Object.entries(METHODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Received"><input className="input" type="date" value={date} max={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        <Field label="Reference" optional><input className="input" placeholder="Check number" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="dollar" loading={save.isPending}>Record {value > 0 ? formatMoneyCents(value) : "payment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Record a refund of a payment taken by hand. `left` is what hasn't been refunded yet (earlier
 * refunds count against the payment). A refund puts the balance back up by what went back, so
 * "Take it off the invoice too" writes that off, as the refund through Stripe does (recordRefund.ts),
 * and nobody asks the client to pay again for what they were given back. Left on the invoice, the
 * dialog says what that means when the invoice is past its due date.
 */
function RefundDialog({ invoice, payment, left, onClose, onSaved }: { invoice: { id: string; client_id: string; status: string; due_on: string | null; balance_due: number }; payment: { id: string; amount: number; method: string }; left: number; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const [amount, setAmount] = useState(left.toFixed(2));
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [takeOff, setTakeOff] = useState(true);
  const value = Number(amount);
  const tooMuch = value > left + 0.005;
  const limit = left < payment.amount ? `the ${formatMoneyCents(left)} left to refund on this payment` : `the ${formatMoneyCents(payment.amount)} payment`;
  const pastDue = owedAgainNote(invoice, value > 0 ? value : 0, today);
  const save = useMutation({
    meta: { inline: true, success: (result: RefundResult) => refundToasts(result, takeOff).success, tone: "invoice" },
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter an amount greater than zero.");
      if (tooMuch) throw new Error(`That's more than ${limit}.`);
      return recordRefund({
        companyId: session.company.id,
        invoice,
        payment,
        amount: value,
        receivedAt: new Date(`${date}T12:00:00`).toISOString(),
        notes: notes.trim() || null,
        takeOff,
      });
    },
    onSuccess: (result) => {
      // Ticked but not taken off: other money is still owed on it.
      const { note } = refundToasts(result, takeOff);
      if (note) toast.info(note.title, note.description ? { description: note.description } : undefined);
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Record a refund" description="Record money you gave back to the client.">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Amount" requiredMessage="Enter the amount you gave back." error={tooMuch ? `More than ${limit}.` : null}>
            <span className="input-group"><span className="addon">{currencySymbol()}</span><DecimalInput className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
          </Field>
          <Field label="Refunded on"><input className="input" type="date" value={date} max={todayIn(session.company.timezone)} onChange={(e) => setDate(e.target.value)} required /></Field>
        </div>
        <Field label="Note" optional><input className="input" placeholder="Check number or reason" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={180} /></Field>
        <div className="stack-sm">
          <label className="checkbox"><input type="checkbox" checked={takeOff} onChange={(e) => setTakeOff(e.target.checked)} /> Take it off the invoice too</label>
          <span className="muted small">
            {takeOff
              ? "The invoice stays settled: what you gave back isn't asked for again."
              : `The balance goes back up by the refund, and the client will be asked for it.${pastDue ? ` ${pastDue}` : ""}`}
          </span>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="undo" loading={save.isPending}>Record {value > 0 ? `${formatMoneyCents(value)} refund` : "refund"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Refund a payment Stripe took, all of it or part, through Stripe: the server makes the refund and
 * books it at once (Stripe's own report of it then finds it booked). `left` is what hasn't gone back
 * yet, tip included. A refund puts the balance back up by what went back, so "Take it off the
 * invoice too" writes that off, and nobody asks the client to pay again for what they were refunded.
 * When other money is still owed on it too, nothing is written off, and the office is told how much
 * is still asked for.
 */
function StripeRefundDialog({ invoice, payment, left, onClose, onSaved }: { invoice: { status: string; due_on: string | null; balance_due: number }; payment: { id: string; method: string }; left: number; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [amount, setAmount] = useState(left.toFixed(2));
  const [writeOff, setWriteOff] = useState(true);
  const value = Number(amount);
  const tooMuch = value > left + 0.005;
  // Left on a paid invoice past its due date: it reads past due, and the client isn't reminded that day.
  const pastDue = owedAgainNote(invoice, value > 0 ? value : 0, todayIn(session.company.timezone));
  const save = useMutation({
    // "Refund sent to Stripe", unless the note below says it all (stripeRefundToasts).
    meta: { inline: true, success: (result: StripeRefundResult) => stripeRefundToasts(result, writeOff).success, tone: "invoice" },
    mutationFn: async () => {
      if (!(value > 0)) throw new Error("Enter an amount greater than zero.");
      if (tooMuch) throw new Error(`That's more than the ${formatMoneyCents(left)} left to refund.`);
      return api.post<StripeRefundResult>(`/payments/${payment.id}/refund`, { amount: Math.round(value * 100) / 100, write_off: writeOff });
    },
    onSuccess: (result) => {
      // Ticked but not written off (other money is still owed), or not booked here yet.
      const { note } = stripeRefundToasts(result, writeOff);
      if (note) toast.info(note.title, note.description ? { description: note.description } : undefined);
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Refund payment" description={`The money goes back to their ${payment.method === "ach" ? "bank account" : "card"}. Stripe keeps its fee.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Amount" hint={`Up to ${formatMoneyCents(left)}`} requiredMessage="Enter the amount to refund." error={tooMuch ? `More than the ${formatMoneyCents(left)} left to refund.` : null}>
          <span className="input-group"><span className="addon">{currencySymbol()}</span><DecimalInput className="input" style={{ paddingLeft: 22 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={tooMuch || undefined} required /></span>
        </Field>
        <div className="stack-sm">
          <label className="checkbox"><input type="checkbox" checked={writeOff} onChange={(e) => setWriteOff(e.target.checked)} /> Take it off the invoice too</label>
          {!writeOff && <span className="muted small">The balance goes back up by the refund, and the client will be asked for it.{pastDue ? ` ${pastDue}` : ""}</span>}
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="undo" loading={save.isPending}>{value > 0 ? `Refund ${formatMoneyCents(value)}` : "Refund"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
