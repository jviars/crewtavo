import { autopayAllowed, autopayDueText, autopaySettings, methodLabel, type AutopaySettings } from "@crewtavo/core/autopay";
import { billingText, billsByVisit, monthText } from "@crewtavo/core/jobBilling";
import { costedExtras, extrasByVisit, takesExtras, visitTakesExtras } from "@crewtavo/core/visitExtras";
import type { TablesUpdate } from "@crewtavo/core/database";
import { askRefusal, marketingOn } from "@crewtavo/core/marketing";
import { contractDiscountNote } from "@crewtavo/core/promos";
import { belowProfitLine, profitAlertPercent } from "@crewtavo/core/reports";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { ClientPreview } from "@/components/ui/ClientPreview";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DetailColumns, DetailHeader } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { ListFoot, MetaLine } from "@/components/ui/InboxList";
import { MapsLink } from "@/components/ui/MapsLink";
import type { MenuEntry } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { DetailSkeleton, SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill, statusText, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap, unwrapOne } from "@/lib/api";
import { addressLine, formatDate, formatMoney, formatTime, todayIn } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useRememberRecent } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { intlLocale } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { AddWorkDialog } from "../invoices/AddWorkDialog";
import { LineItems } from "../quotes/LineItems";
import { VisitDialog, type VisitInput } from "../schedule/VisitDialog";
import { useSchedulingRights } from "../schedule/myCrews";
import { handlesSubPay, useJobPays } from "../subs/payData";
import { ChangeOrders, useStartChangeOrder } from "./ChangeOrders";
import { closeQuestion } from "./closing";
import { ExpensesCard, useJobExpenses } from "./ExpensesCard";
import { useReceiptDrafts } from "./ReceiptDrafts";
import { MaterialsCard, useJobMaterials } from "./JobMaterials";
import { PhotosCard } from "../files/PhotosCard";
import { ShowcaseDialog } from "../marketing/ShowcaseDialog";
import { JobChecklists } from "./FilledChecklists";
import { PlansCard } from "../plans/PlansCard";
import { WorksheetsCard } from "../paving/WorksheetsCard";
import { PropertyEquipment } from "../clients/PropertyEquipment";
import { InvoiceJobDialog, JobDetailsDialog, PauseJobDialog, type JobRecord } from "./JobDialogs";
import { JobDiscountNote } from "./JobDiscountNote";
import { FieldAddedLines } from "./FieldAddedLines";
import { jobPageCosts } from "./jobCosts";
import { JobPayCard, seesJobPay } from "./JobPayCard";
import { JobPaymentSchedule } from "./JobPaymentSchedule";
import { repeatText } from "./repeatText";
import { ScopeOfWork } from "./ScopeOfWork";
import { ExtraWorkDialog, ExtrasToReview, useEditsExtras, useJobExtras, VisitExtraLines } from "./VisitExtras";
import { askToastKind, type AskResult } from "../marketing/askForm";
import { CustomFieldFacts, useCustomFields } from "../customFields/CustomFields";
import { memberName, useTeam } from "../requests/RequestsPage";
import styles from "./jobs.module.css";

/** The sections a job only shows once it uses them, offered under its line items until then. */
type Extra = "materials" | "expenses" | "pay";

/** When a one-off job's finished work is charged, in the words of Mark work complete's question. */
function chargedWhen(s: Pick<AutopaySettings, "timing" | "days">): string {
  if (s.timing === "now") return "right away";
  if (s.timing !== "days") return "at the end of the day";
  const days = s.days ?? 1;
  return `${days} ${days === 1 ? "day" : "days"} after the work is marked complete`;
}

export function JobPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const jobFields = useCustomFields("job");
  const [visit, setVisit] = useState<VisitInput | null>(null);
  // ?invoice=1 (from a paving project's Invoice step) opens Create invoice straight away.
  const [params] = useSearchParams();
  const [dialog, setDialog] = useState<null | "details" | "invoice" | "pause" | "showcase">(() => (params.get("invoice") ? "invoice" : null));
  // The invoice just made, while its next step offers the job's logged hours and materials.
  const [madeInvoice, setMadeInvoice] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  // The visit whose extra work is being added to (a repeating job's).
  const [extraVisit, setExtraVisit] = useState<{ id: string; title: string; scheduled_on: string | null } | null>(null);
  const editsExtras = useEditsExtras();
  // The empty section an add button under the line items just opened, shown while its dialog is up.
  const [adding, setAdding] = useState<Extra | null>(null);
  // The add button pressed goes as its section shows, so when the dialog closes keyboard focus goes back
  // to it, or (something was added, so it's gone for good) to the section's own add button, not the page.
  const wasAdding = useRef<Extra | null>(null);
  useEffect(() => {
    const was = wasAdding.current;
    wasAdding.current = adding;
    if (adding || !was || (document.activeElement && document.activeElement !== document.body)) return;
    (document.querySelector<HTMLElement>(`[data-add="${was}"]`) ?? document.querySelector<HTMLElement>(`[data-extra="${was}"] :is(.section-head, .sec-head) button`))?.focus({ preventScroll: true });
  }, [adding]);
  const visitsRef = useListAnimation<HTMLUListElement>();
  const isOffice = hasRole(session, "admin", "office");
  const seesInvoices = isOffice && can(session, "invoices");
  const seesCosts = isOffice && can(session, "job_costs");
  const seesPay = seesJobPay(session);
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const canDispatch = useSchedulingRights().canDispatch;
  const today = todayIn(session.company.timezone);
  // Autopay is the office's with the invoices area, once the company has it on (Settings → Payments).
  const autopay = autopaySettings(session.company.settings, session.company.trade_preset);
  const autopayOn = seesInvoices && autopay.enabled;
  // The same queries the sections use, to know which ones this job has anything in.
  const materialRows = useJobMaterials(id);
  const expenseRows = useJobExpenses(id, seesCosts);
  // Receipts dropped in to confirm keep the Expenses card in sight too.
  const receiptDrafts = useReceiptDrafts(id);
  const payRows = useJobPays(session.company.id, id, seesPay);
  const team = useTeam(session.company.id);

  const job = useQuery({
    queryKey: ["job", id],
    queryFn: async () =>
      unwrapOne(
        await supabase()
          .from("jobs")
          .select("*, job_state, financials:job_financials(contract_total), client:clients(id, display_name, phone, email, status, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at), property:properties(id, line1, city, region, postal_code, lat, lng), quote:quotes!jobs_company_id_quote_id_fkey(id, number, deposit_amount), crew:crews(name), lines:job_line_items(id, name, description, quantity, unit, unit_price, unit_cost, unit_labor_cost, parts, taxable, sort, service_id, source_quote_id, discount_billing, discount_key, added_in_field_by, added_in_field_at), visits(id, title, kind, status, scheduled_on, starts_at, ends_at, crew_id, notes, hold_reason, invoice_id, completed_at, crew:crews(name, color), assignees:visit_assignees(user_id))")
          .eq("id", id)
          .order("sort", { referencedTable: "job_line_items" })
          .order("scheduled_on", { referencedTable: "visits" })
          .maybeSingle(),
        "This job",
      ),
  });
  // With Snow installed: whether this job is a snow customer (the Snow page keeps its triggers).
  const snowSite = useQuery({
    enabled: featureOn(session.company.settings, "snow_app") && Boolean(id),
    queryKey: ["snow", session.company.id, "site", id],
    queryFn: async () => (await supabase().from("snow_sites").select("trigger_in").eq("job_id", id!).maybeSingle()).data,
  }).data;
  const j = job.data;
  useDocumentTitle(j ? `Job #${j.number}` : "Job");
  const clientId = j?.client?.id ?? null;
  // Extra work on single visits of a repeating job: billed once with its visit, never part of the job's price.
  const extras = useJobExtras(id, j?.kind === "recurring");
  // Whether the client can be charged now (an agreement in force, not paused, its card active: the
  // rule private.autopay_ready keeps), and the charge waiting for this job's finished work.
  const jobAutopay = useQuery({
    queryKey: ["job", id, "autopay"],
    enabled: autopayOn && Boolean(clientId),
    queryFn: async () => {
      const db = supabase();
      const [agreements, waiting] = await Promise.all([
        db.from("autopay_authorizations").select("payment_method_id, paused_at").eq("client_id", clientId!).is("revoked_at", null).limit(1),
        db.from("autopay_charges").select("id, due_at").eq("job_id", id).eq("status", "waiting").is("invoice_id", null).order("due_at").limit(1),
      ]);
      const live = unwrap(agreements)[0] ?? null;
      const method = live?.payment_method_id
        ? unwrap(await db.from("client_payment_methods").select("type, brand, last4, bank_name, wallet, status").eq("id", live.payment_method_id).limit(1))[0] ?? null
        : null;
      return {
        agreed: Boolean(live),
        // A card they agreed to that can be charged, or a bank account being checked.
        onFile: method?.status === "active" || method?.status === "pending",
        paused: Boolean(live?.paused_at),
        // A bank account still being checked: not a card to update.
        checking: method?.status === "pending",
        ready: Boolean(live && !live.paused_at && method?.status === "active"),
        card: method ? methodLabel(method) : null,
        waiting: unwrap(waiting)[0] ?? null,
      };
    },
  });
  useRememberRecent(session.company.id, j ? { kind: "job", id: j.id, title: j.title, subtitle: `Job #${j.number} · ${j.client?.display_name ?? ""}`, path: `/jobs/${j.id}` } : null);

  const invoices = useQuery({
    queryKey: ["job", id, "invoices"],
    enabled: seesInvoices,
    queryFn: async () => unwrap(await supabase().from("invoices").select("id, number, kind, status, subtotal, total, balance_due, retainage_amount, pay_app_number").eq("job_id", id).order("number")),
  });
  // The months a monthly job still has to invoice (made on its invoice day).
  const dueMonths = useQuery({
    queryKey: ["job", id, "due-invoices"],
    enabled: seesInvoices,
    queryFn: async () => unwrap(await supabase().from("due_invoices").select("month").eq("job_id", id).order("month")),
  });
  const invoiceMonth = useMutation({
    meta: { success: "Invoice created as a draft", tone: "invoice" },
    mutationFn: (month: string) => api.post<{ invoice_id: string }>(`/jobs/${id}/invoice`, { kind: j?.pricing === "fixed" ? "standard" : "visits", month }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      navigate(`/invoices/${r.invoice_id}`);
    },
  });
  const costs = useQuery({
    queryKey: ["job", id, "costs"],
    enabled: seesCosts,
    queryFn: async () => {
      const [time, expenses, rates, crewPay] = await Promise.all([
        supabase().from("time_entries").select("id, started_at, ended_at").eq("job_id", id),
        supabase().from("expenses").select("amount, in_line_costs").eq("job_id", id),
        // Pay rates come from the server: nobody reads them on time entries directly.
        api.post<Record<string, number>>("/time/rates", { job_ids: [id] }),
        // Sub and crew pay that's agreed, done or paid (totals only).
        supabase().rpc("job_pay_costs", { p_jobs: [id] }),
      ]);
      const entries = unwrap(time);
      const hours = entries.reduce((s, t) => s + (t.ended_at ? (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 3_600_000 : 0), 0);
      // The rows as they are: jobPageCosts adds them up, as the hourly profit check does.
      return { hours, time: entries, rates, pay: unwrap(crewPay), expenses: unwrap(expenses) };
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["job", id] });
    queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
  };
  const update = useMutation({
    meta: { success: (_: unknown, p: TablesUpdate<"jobs">) => (p.status === "requires_invoicing" ? "Job marked complete" : p.status === "archived" ? "Job archived" : p.status === "active" ? "Job reopened" : p.status === "completed" ? "Job closed" : "Job saved"), tone: "job" },
    mutationFn: async (patch: TablesUpdate<"jobs">) => {
      unwrap(await supabase().from("jobs").update(patch).eq("id", id));
      // A recurring job reopened gets back the visits closing it took off (the server's, as when it's
      // resumed). If that can't be done now, the nightly run makes them.
      if (patch.status === "active" && j?.kind === "recurring" && canDispatch) await api.post(`/jobs/${id}/generate-visits`).catch(() => undefined);
    },
    onSuccess: refresh,
  });
  // The switch moves the moment it's flipped, and back if the database refuses it (no toast: the switch shows it).
  const setAutopay = useMutation({
    mutationFn: async (on: boolean) => unwrap(await supabase().from("jobs").update({ autopay: on }).eq("id", id)),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: ["job", id], exact: true });
      const before = queryClient.getQueryData<typeof job.data>(["job", id]);
      queryClient.setQueryData<typeof job.data>(["job", id], (old) => old && { ...old, autopay: on });
      return { before };
    },
    onError: (_error, _on, context) => {
      if (context?.before) queryClient.setQueryData(["job", id], context.before);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["job", id] });
      if (clientId) queryClient.invalidateQueries({ queryKey: ["client", clientId, "autopay"] });
    },
  });
  // Its visits are made again from today (the server's, as when the schedule changes; else the nightly run).
  const resume = useMutation({
    meta: { success: "Job resumed", tone: "job" },
    mutationFn: async () => {
      unwrap(await supabase().from("jobs").update({ paused_at: null }).eq("id", id));
      if (canDispatch) await api.post(`/jobs/${id}/generate-visits`);
    },
    onSuccess: refresh,
  });
  const completeVisit = useMutation({
    meta: { success: "Visit completed", tone: "job" },
    mutationFn: (visitId: string) => api.patch(`/visits/${visitId}`, { status: "completed" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { success: "Job deleted", tone: "job" },
    mutationFn: async () => unwrap(await supabase().from("jobs").delete().eq("id", id)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["jobs", session.company.id] });
      navigate("/jobs", { replace: true });
    },
  });
  const review = useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<AskResult>("/reviews/request", { client_id: j!.client!.id, job_id: id, channel }),
    onSuccess: (r) => toast[askToastKind(r)](r.detail),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["review-requests", session.company.id] }),
  });

  const changeOrder = useStartChangeOrder({ id, title: j?.title ?? "", client: j?.client ?? null, property: j?.property ?? null });

  if (job.isPending) return <DetailSkeleton />;
  if (job.error || !j) return <PageError error={job.error} onRetry={() => job.refetch()} back={<BackLink to="/jobs">Jobs</BackLink>} />;

  const contract = Number(j.financials?.contract_total ?? 0);
  const visits = j.visits;
  const visitExtras = extrasByVisit(extras.data ?? []);
  const cost = jobPageCosts({ price: contract, lines: j.lines, time: costs.data?.time ?? [], rates: costs.data?.rates ?? {}, expenses: costs.data?.expenses ?? [], logged: materialRows.data ?? [], pay: costs.data?.pay ?? [], extras: costedExtras(extras.data ?? [], visits) });
  const { materials, labor, crew, expenses, profit, margin } = cost;
  // The company's profit line (Settings → Company → Job costing), as the hourly check holds the job to it.
  const profitLine = profitAlertPercent(session.company.settings);
  const belowLine = j.status !== "archived" && belowProfitLine(j, { price: contract + cost.extras, margin, has_actual_costs: cost.hasActualCosts }, profitLine);
  const upcoming = visits.filter((v) => !["completed", "cancelled"].includes(v.status));
  const past = visits.filter((v) => ["completed", "cancelled"].includes(v.status));
  // A finished visit whose extra work isn't on an invoice yet stays in sight with the upcoming ones.
  const owed = showPast ? [] : past.filter((v) => v.status === "completed" && visitExtras.get(v.id)?.some((e) => !e.invoice_id));
  const shownVisits = [...owed, ...upcoming.slice(0, 12), ...(showPast ? past : [])];
  const addsExtras = editsExtras && takesExtras(j);
  const uninvoiced = visits.filter((v) => v.status === "completed" && !v.invoice_id && v.kind === "job").length;
  const billed = (invoices.data ?? []).filter((i) => ["deposit", "progress"].includes(i.kind) && i.status !== "void").reduce((s, i) => s + Number(i.subtotal), 0);
  const hasInvoices = Boolean(invoices.data?.length);
  const live = (invoices.data ?? []).filter((i) => i.status !== "void");
  const retainageHeld =
    live.filter((i) => i.kind !== "retainage").reduce((s, i) => s + Number(i.retainage_amount), 0) -
    live.filter((i) => i.kind === "retainage").reduce((s, i) => s + Number(i.subtotal), 0);
  const finalInvoice = j.kind !== "recurring" ? live.find((i) => i.kind === "standard")?.number ?? null : null;
  // Made by hand, or as the client approved the quote in the Client Hub: Create invoice says so rather than offer the quote's deposit again.
  const depositInvoice = live.find((i) => i.kind === "deposit")?.number ?? null;
  // Work that repeats takes a once-per-job promo code off its first invoice only, which the job says.
  const repeats = j.kind === "recurring" || j.billing_mode === "per_visit";
  const contractNote = repeats ? contractDiscountNote(j.lines) : null;
  // By email, or by text when email can't reach them, as the client's page offers it: not to a client
  // who opted out or is archived. Marketing uninstalled, nobody's asked.
  const ready = { email: session.config.features.email, sms: session.config.features.sms };
  const reviewBy = j.client ? (["email", "sms"] as const).find((channel) => !askRefusal(j.client!, channel, ready)) ?? null : null;
  // A charge is already waiting for this job's finished work: it bills itself, so nobody invoices it by hand.
  const charging = autopayOn && j.autopay && jobAutopay.data?.waiting ? jobAutopay.data.waiting : null;
  const autopayHint = !autopayAllowed(j.kind, j.billing_mode, j.pricing, j.invoice_schedule)
    ? "Autopay works with recurring jobs billed per visit or at a fixed price monthly, or one-off jobs billed when the work is done."
    : jobAutopay.data && !jobAutopay.data.ready && j.client
      ? jobAutopay.data.paused ? `Autopay is paused for ${j.client.display_name}.`
        : jobAutopay.data.checking ? `Charges start once ${j.client.display_name}'s bank account is checked.`
          : jobAutopay.data.agreed ? `${j.client.display_name}'s card needs updating before it's charged.`
            : `Charges start once ${j.client.display_name} agrees to autopay.`
      : null;
  /** Mark work complete: on an autopay job the office is told first that it's charged on its own. */
  const markComplete = async () => {
    const a = jobAutopay.data;
    if (autopayOn && j.autopay && a?.ready && j.client) {
      const ok = await confirm({ title: "Mark work complete?", body: `${j.client.display_name}'s ${a.card ?? "saved card"} is charged automatically ${chargedWhen(autopay)}.`, confirmLabel: "Mark complete" });
      if (!ok) return;
    }
    update.mutate({ status: "requires_invoicing" });
  };
  /**
   * Close or archive. The visits its schedule made that are still to come go with it
   * (20261113000120_closed_jobs_leave_the_schedule.sql), so when there are any it's asked first, with how many.
   */
  const closeJob = async (status: "completed" | "archived") => {
    const waiting = await supabase().rpc("job_visits_to_remove", { p_job: id });
    const question = closeQuestion(status, j.number, waiting.data ?? 0);
    if (question && !(await confirm(question))) return;
    update.mutate({ status });
  };
  const newVisit = (): VisitInput => ({ job_id: j.id, property_id: j.property?.id ?? null, title: j.title, crew_id: j.default_crew_id, kind: "job", context: { label: `Job #${j.number} · ${j.client?.display_name ?? ""}`, to: `/jobs/${j.id}` } });

  // Materials, expenses and sub pay take no room until they have something (or failed to load, to
  // say so). Until then they're small add buttons under the line items, each opening the same dialog
  // as the section's own button and showing the section while it's open.
  const used = (extra: Extra, rows: { data?: readonly unknown[]; error: unknown }) => Boolean(rows.data?.length) || Boolean(rows.error) || adding === extra;
  const shows = { materials: used("materials", materialRows), expenses: seesCosts && (used("expenses", expenseRows) || Boolean(receiptDrafts.data?.length)), pay: seesPay && used("pay", payRows) };
  const offers: Array<{ key: Extra; label: string; name: string }> = [];
  if (materialRows.data?.length === 0 && !shows.materials) offers.push({ key: "materials", label: "Materials", name: "Log materials" });
  if (seesCosts && expenseRows.data?.length === 0 && !shows.expenses) offers.push({ key: "expenses", label: "Expense", name: "Add an expense" });
  if (seesPay && j.status !== "archived" && payRows.data?.length === 0 && !shows.pay) {
    const label = handlesSubPay(session) ? "Sub pay" : "Crew pay";
    offers.push({ key: "pay", label, name: `Add ${label.toLowerCase()}` });
  }
  const addButtons = offers.length > 0 && (
    <div className={cx("add-chips", styles.adds)} role="group" aria-label="Add to this job">
      {offers.map((o) => <Button key={o.key} size="sm" icon="plus" className="add-chip" aria-label={o.name} data-add={o.key} onClick={() => setAdding(o.key)}>{o.label}</Button>)}
    </div>
  );
  const doneAdding = () => setAdding(null);
  // Green says the job made money: ink while there's nothing to count, red when it lost some.
  const profitTone = profit >= 0.005 ? "good" : profit <= -0.005 ? "danger" : undefined;
  const askable = (channel: "email" | "sms") => Boolean(j.client) && !askRefusal(j.client!, channel, ready);
  const timeZone = session.company.timezone;
  const doneCount = past.filter((v) => v.status === "completed").length;
  const openVisit = (v: (typeof visits)[number]) => setVisit({ ...v, job_id: j.id, property_id: j.property?.id ?? null, assignee_ids: v.assignees.map((a) => a.user_id), context: { label: `Job #${j.number}`, to: `/jobs/${j.id}` } });
  const place = j.property ? [j.property.line1, j.property.city].filter(Boolean).join(", ") : null;

  // Everything but the page's buttons: what it is, then what happens to it (danger last).
  const more: MenuEntry[] = [
    { label: "Edit details and schedule", icon: "edit", kbd: "E", onSelect: () => setDialog("details") },
    { label: "New change order", icon: "quote", hidden: !["active", "requires_invoicing"].includes(j.status) || !j.client, onSelect: () => changeOrder.mutate() },
    j.client?.reviewed_at
      ? { label: "Already left a Google review", icon: "star", hidden: !marketingOn(session.company.settings), disabled: true, onSelect: () => undefined }
      : {
          // By email, or by text: only the ways an ask can go to this client.
          label: "Ask for a review", icon: "star",
          hidden: !marketingOn(session.company.settings) || !j.client, disabled: !reviewBy,
          items: [
            { label: "By email", icon: "mail", hidden: !askable("email"), onSelect: () => review.mutate("email") },
            { label: "By text", icon: "messages", hidden: !askable("sms"), onSelect: () => review.mutate("sms") },
          ],
        },
    {
      // A finished job's before and after photos, on a page to share (Marketing → Showcases).
      label: "Make a showcase", icon: "image",
      hidden: !marketingOn(session.company.settings) || !isOffice || !can(session, "marketing") || !(["requires_invoicing", "completed"].includes(j.status) || visits.some((v) => v.status === "completed")),
      onSelect: () => setDialog("showcase"),
    },
    { separator: true },
    { label: "Pause job", icon: "pause", hidden: j.status !== "active" || j.kind !== "recurring" || Boolean(j.paused_at), onSelect: () => setDialog("pause") },
    { label: "Resume job", icon: "play", hidden: !j.paused_at, onSelect: () => resume.mutate() },
    { label: "Mark work complete", icon: "check", hidden: j.status !== "active" || j.kind === "one_off", onSelect: () => update.mutate({ status: "requires_invoicing" }) },
    { label: "Close job", icon: "check", hidden: !["requires_invoicing"].includes(j.status), onSelect: () => closeJob("completed") },
    { label: "Reopen job", icon: "undo", hidden: j.status === "active", onSelect: () => update.mutate({ status: "active" }) },
    { label: "Archive job", icon: "archive", hidden: j.status === "archived", onSelect: () => closeJob("archived") },
    { separator: true },
    {
      label: "Delete job",
      icon: "trash",
      danger: true,
      hidden: !isOffice || hasInvoices,
      onSelect: async () => {
        if (await confirm({ title: `Delete job #${j.number}?`, body: "Its visits, line items and checklists are deleted too. Logged time and expenses are kept. This can't be undone.", confirmLabel: "Delete job", danger: true, typeToConfirm: visits.length > 5 ? "delete" : undefined })) remove.mutate();
      },
    },
  ];

  return (
    <>
      {/* The status (an active job's late, today, upcoming or unscheduled), its number, who it's for, where, and how often it repeats. */}
      <DetailHeader
        crumb={{ to: "/jobs", label: "Jobs" }}
        title={j.title}
        documentTitle={`Job #${j.number}`}
        status={<EntityStatus kind="job" status={j.job_state ?? j.status} />}
        meta={[
          `Job #${j.number}`,
          j.client && <ClientPreview id={j.client.id}><Link to={`/clients/${j.client.id}`}>{j.client.display_name}</Link></ClientPreview>,
          place,
          j.kind === "recurring" && (j.recurrence_rule ? repeatText(j.recurrence_rule) : "Recurring"),
          // Every client needs a card on file, and this one has none they agreed to that can be charged.
          autopay.card_required && jobAutopay.data && !jobAutopay.data.onFile && !["completed", "archived"].includes(j.status) && <span className="chip chip-amber"><Icon name="card" size={12} />Card not set up</span>,
        ]}
        actions={
          <>
            {seesInvoices && j.status !== "archived" && <Button icon="invoice" variant={j.status === "requires_invoicing" && !charging ? "primary" : "secondary"} onClick={() => setDialog("invoice")}>Create invoice</Button>}
            {canSell && j.status === "active" && j.kind === "one_off" && <Button variant="primary" icon="check" loading={update.isPending} onClick={markComplete}>Mark work complete</Button>}
          </>
        }
        more={canSell ? more : undefined}
      />

      {/* The database made the change the Mark work complete button makes (20261113000100), so the page says how, and how to undo it. */}
      {j.finished_by_visits_at && ["requires_invoicing", "completed"].includes(j.status) && (
        <div className={styles.note}>
          <Icon name="check" size={14} />
          <span>Marked complete when its last visit was finished{canSell ? ". Reopen it if another visit is needed." : "."}</span>
          {canSell && <Button size="sm" variant="ghost" icon="undo" loading={update.isPending && update.variables?.status === "active"} onClick={() => update.mutate({ status: "active" })}>Reopen job</Button>}
        </div>
      )}
      {/* At rest, not a problem: the quiet callout. */}
      {j.paused_at && j.status === "active" && (
        <div className="callout">
          <Icon name="pause" size={16} />
          <div className="grow"><div>Paused since {formatDate(j.paused_at)}.</div>{j.resume_on ? `Visits start again on ${formatDate(j.resume_on)}.` : "No visits are scheduled until it's resumed."}</div>
          {canSell && <Button size="sm" icon="play" loading={resume.isPending} onClick={() => resume.mutate()}>Resume</Button>}
        </div>
      )}
      {/* Requires invoicing needs no banner: the pill says so and Create invoice is the page's green button. */}
      {uninvoiced > 0 && seesInvoices && j.status === "active" && j.billing_mode === "per_visit" && !charging && (
        <div className="callout callout-good">
          <Icon name="invoice" size={16} />
          <div className="grow">{uninvoiced} completed {uninvoiced === 1 ? "visit is" : "visits are"} ready to invoice.</div>
          <Button size="sm" onClick={() => setDialog("invoice")}>Invoice visits</Button>
        </div>
      )}
      {/* A monthly job's month that's due: its invoice, made here or with the others on Invoices. */}
      {seesInvoices && !charging && dueMonths.data?.map((d) => (
        <div key={d.month} className="callout callout-good">
          <Icon name="invoice" size={16} />
          <div className="grow">{monthText(d.month!)} needs its invoice.</div>
          <Button size="sm" loading={invoiceMonth.isPending && invoiceMonth.variables === d.month} onClick={() => invoiceMonth.mutate(d.month!)}>Invoice {monthText(d.month!).split(" ")[0]}</Button>
        </div>
      ))}
      {charging && j.status !== "archived" && (
        <div className={styles.note}><Icon name="card" size={14} /><span>Charged automatically {autopayDueText(charging.due_at, session.company.timezone)}.</span></div>
      )}
      {extras.data && extras.data.length > 0 && <ExtrasToReview jobId={j.id} extras={extras.data} visits={visits} />}

      <DetailColumns
        grouped
        side={
          <>
            {/* How the quote it came from was priced (the paving calculator): the office's only, and fixed once sold. */}
            {canSell && j.quote && <WorksheetsCard quoteId={j.quote.id} editable={false} />}
            {seesCosts && (costs.isPending ? <SectionSkeleton rows={6} /> : (
              <Section title="Job costing" className={styles.stacked}>
                {belowLine && (
                  <div className="callout callout-warning" role="status">
                    <Icon name="alert" size={16} />
                    <div className="grow">At {margin}% profit, this job is below your {profitLine}%.</div>
                  </div>
                )}
                <ProfitBar price={contract + cost.extras} labor={labor} crew={crew} expenses={expenses} materials={materials} />
                {/* The figures roll to their new values as line items, time and costs change. Each cost's dot is its color in the bar. */}
                <Facts label="Job costing">
                  {/* What it brings in has no part of the bar: its label keeps the dots' column so all of them line up. */}
                  <Fact label={<CostKey>Price</CostKey>}>
                    <AnimatedNumber value={contract} format={MONEY_CENTS} />
                    {contractNote && <span className={styles.factNote}>{contractNote}</span>}
                  </Fact>
                  {/* Billed once each with its visit, on top of the price, which it doesn't change. */}
                  {cost.extras !== 0 && <Fact label={<CostKey>Extra work on visits</CostKey>}><AnimatedNumber value={cost.extras} format={MONEY_CENTS} /></Fact>}
                  <Fact label={<CostKey part="materials">{cost.actualLabor ? "Line item materials" : "Line item costs"}</CostKey>}><AnimatedNumber value={materials} format={MONEY_CENTS} /></Fact>
                  <Fact label={<CostKey part="labor">Labor ({(costs.data?.hours ?? 0).toFixed(1)} h)</CostKey>}><AnimatedNumber value={labor} format={MONEY_CENTS} /></Fact>
                  <Fact label={<CostKey part="crew">Sub and crew pay</CostKey>}><AnimatedNumber value={crew} format={MONEY_CENTS} /></Fact>
                  <Fact label={<CostKey part="expenses">Expenses</CostKey>}><AnimatedNumber value={expenses} format={MONEY_CENTS} /></Fact>
                  <Fact label={<CostKey part="profit"><strong>Profit</strong></CostKey>} tone={profitTone}>
                    <AnimatedNumber value={profit} format={MONEY_CENTS} />{margin !== null ? ` (${margin}%)` : ""}
                  </Fact>
                </Facts>
                {(cost.note || cost.materialNote || cost.expenseNote || (labor === 0 && (costs.data?.hours ?? 0) > 0)) && (
                  <div className={styles.notes}>
                    {cost.note && <p>{cost.note}</p>}
                    {cost.materialNote && <p>{cost.materialNote}</p>}
                    {cost.expenseNote && <p>{cost.expenseNote}</p>}
                    {labor === 0 && (costs.data?.hours ?? 0) > 0 && <p>Set labor rates in Settings → Team to cost tracked hours.</p>}
                  </div>
                )}
              </Section>
            ))}
            <Section title="Details" action={canSell && <button type="button" onClick={() => setDialog("details")}><Icon name="edit" size={14} />Edit</button>}>
              <Facts label="Job details">
                {canSell && (
                  <Fact label="Contract">
                    <AnimatedNumber value={contract} format={MONEY_CENTS} />
                    {contractNote && <span className={styles.factNote}>{contractNote}</span>}
                  </Fact>
                )}
                <Fact label="Billing">{billingText(j)}</Fact>
                {autopayOn && j.client && (
                  <Fact label="Autopay">
                    <label className="switch-row" style={{ fontWeight: 400 }}>
                      <input type="checkbox" className="switch" checked={j.autopay} disabled={!autopayAllowed(j.kind, j.billing_mode, j.pricing, j.invoice_schedule) || j.status === "archived"} onChange={(e) => setAutopay.mutate(e.target.checked)} />
                      Charge their saved card
                    </label>
                    {autopayHint && <span className={styles.factNote}>{autopayHint}</span>}
                  </Fact>
                )}
                {j.kind === "recurring" && <Fact label="Repeats">{j.recurrence_rule ? repeatText(j.recurrence_rule) : "Recurring"}{j.starts_on ? `, from ${formatDate(j.starts_on)}` : ""}{j.ends_on ? ` to ${formatDate(j.ends_on)}` : ""}</Fact>}
                <Fact label="Crew">{j.crew?.name}</Fact>
                {snowSite && featureOn(session.company.settings, "snow_app") && <Fact label="Snow"><Link to={`/snow?edit=${j.id}`}>Plows at {Number(snowSite.trigger_in)} in</Link></Fact>}
                <Fact label="PO">{j.po_number}</Fact>
                <Fact label="Permit">{j.permit_number}</Fact>
                <Fact label="Retainage">{Number(j.retainage_pct) > 0 && `${Number(j.retainage_pct)}%`}</Fact>
                <Fact label="Warranty">{j.warranty_until && `Until ${formatDate(j.warranty_until)}`}</Fact>
                {j.quote && <Fact label="From"><Link to={`/quotes/${j.quote.id}`}>Quote #{j.quote.number}</Link></Fact>}
                {/* Who to ask about what was promised: the estimate's salesperson, for crew leads too (they can't open the estimate). */}
                {j.salesperson_id && team.data && <Fact label="Sold by">{memberName(team.data.find((m) => m.user_id === j.salesperson_id)) ?? "Former team member"}</Fact>}
                <CustomFieldFacts fields={jobFields} values={j.custom_fields} />
                {j.instructions && <Fact label="Instructions for the crew" wide><Note className={styles.instructions} text={j.instructions} /></Fact>}
              </Facts>
            </Section>
            {/* The quote's payment schedule, for the people who look after money (nothing shows without one). */}
            {seesInvoices && j.quote && <JobPaymentSchedule jobId={j.id} finalInvoice={live.find((i) => i.kind === "standard") ?? null} />}
            {j.client && (
              <Section
                title="Client"
                className={styles.stacked}
                action={j.property && <MapsLink className={styles.directions} place={j.property}><Icon name="navigation" size={14} />Directions</MapsLink>}
              >
                <Facts label="Client">
                  <Fact label="Name"><Link to={`/clients/${j.client.id}`}>{j.client.display_name}</Link></Fact>
                  <Fact label="Phone">{j.client.phone && <a href={`tel:${j.client.phone}`}>{j.client.phone}</a>}</Fact>
                  <Fact label="Property">{j.property && addressLine(j.property)}</Fact>
                </Facts>
                {j.property && <PropertyEquipment propertyId={j.property.id} inCard />}
              </Section>
            )}
          </>
        }
      >
        <Section
          title="Visits"
          count={visits.length > 0 ? `${doneCount} of ${visits.length} done` : undefined}
          className={styles.visits}
          action={canDispatch && j.status !== "archived" && <button type="button" onClick={() => setVisit(newVisit())}><Icon name="plus" size={14} />Add visit</button>}
        >
          {visits.length === 0 ? (
            <EmptyState inline title="No visits scheduled">
              {j.kind === "recurring" ? "Set how it repeats in Edit details, and visits are made for the next year." : null}
            </EmptyState>
          ) : shownVisits.length === 0 ? (
            // Every visit is done or cancelled: the way to them is on the same line. As they show, the button
            // goes, so keyboard focus moves to the one that hides them again.
            <EmptyState
              inline
              title="No visits coming up"
              action={
                <Button onClick={() => { setShowPast(true); requestAnimationFrame(() => document.querySelector<HTMLElement>(`.${styles.visits} .il-more`)?.focus()); }}>
                  {`Show ${past.length} past ${past.length === 1 ? "visit" : "visits"}`}
                </Button>
              }
            />
          ) : (
            <ul className="rel" role="list" aria-label="Visits" ref={visitsRef}>
              {shownVisits.map((v) => {
                const open = !["completed", "cancelled"].includes(v.status);
                const overdue = open && Boolean(v.scheduled_on) && v.scheduled_on! < today;
                const crewOf = v.crew as { name: string; color?: string | null } | null;
                const day = v.scheduled_on ? visitDay(v.scheduled_on, today) : null;
                const title = (
                  <>
                    <span className="rel-title">{v.title}</span>
                    {day && <span className="sr-only">, {day.weekday} {day.date}</span>}
                  </>
                );
                return (
                  <li key={v.id} className={cx("rel-row", canDispatch && "rel-row-link", styles.visit)} data-done={!open || undefined}>
                    <span className={cx("rel-lead", styles.visitDay)} data-tone={overdue ? "danger" : undefined} aria-hidden="true">
                      {day ? <><span>{day.weekday}</span><b>{day.date}</b></> : <Icon name="calendar" size={15} />}
                    </span>
                    <div className="rel-body">
                      {canDispatch ? <button type="button" className="rel-link" onClick={() => openVisit(v)}>{title}</button> : <span className="rel-head">{title}</span>}
                      <MetaLine
                        className="rel-sub"
                        parts={[
                          v.starts_at ? formatTime(v.starts_at, timeZone) : v.scheduled_on ? "Anytime" : "Not scheduled",
                          crewOf && <span className={styles.crew}><i style={{ background: crewOf.color || "var(--fill-3)" }} aria-hidden="true" />{crewOf.name}</span>,
                          overdue && <span className={styles.overdue}>Overdue</span>,
                          v.invoice_id && "Invoiced",
                        ]}
                      />
                      {v.hold_reason && <div className={styles.hold}>Weather: {v.hold_reason}</div>}
                      <VisitExtraLines extras={visitExtras.get(v.id) ?? []} visit={v} />
                    </div>
                    <span className="rel-end"><StatusPill label={statusText("visit", v.status)} tone={visitTone(v.status)} /></span>
                    {/* Every row keeps the column, so the statuses line up whether a row has actions or not. */}
                    {(addsExtras || canDispatch) && (
                      <span className="rel-actions">
                        {addsExtras && v.kind === "job" && visitTakesExtras(v) && (
                          <Button size="sm" variant="ghost" icon="plus" aria-label={`Extra work on ${v.title}${v.scheduled_on ? `, ${formatDate(v.scheduled_on)}` : ""}`} title="Extra work on this visit" onClick={() => setExtraVisit({ id: v.id, title: v.title, scheduled_on: v.scheduled_on })}>Extra work</Button>
                        )}
                        {canDispatch && open && (
                          // An icon on a desktop's hover; on a phone, with its word, as the row's actions sit on a line of their own.
                          <Button size="sm" variant="ghost" icon="check" aria-label={`Complete ${v.title}`} title="Mark complete" loading={completeVisit.isPending && completeVisit.variables === v.id} onClick={() => completeVisit.mutate(v.id)}><span className={styles.phoneWord}>Complete</span></Button>
                        )}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {shownVisits.length > 0 && (upcoming.length > 12 || past.length > 0) && (
            <ListFoot more={past.length > 0 ? { onClick: () => setShowPast(!showPast), label: showPast ? "Hide past visits" : `Show ${past.length} past ${past.length === 1 ? "visit" : "visits"}` } : undefined}>
              {upcoming.length > 12 ? `${upcoming.length - 12} more upcoming` : ""}
            </ListFoot>
          )}
        </Section>

        <JobChecklists jobId={j.id} />

        {!hasRole(session, "admin", "office", "estimator") && (
          <>
            <ScopeOfWork jobId={j.id} />
            {addButtons}
          </>
        )}

        {hasRole(session, "admin", "office", "estimator") && (
          <Section title="Line items" count={j.lines.length || undefined} className={styles.stacked}>
            <LineItems table="job_line_items" parent="job_id" parentId={j.id} lines={j.lines} editable={canSell && ["active", "requires_invoicing"].includes(j.status)} onChanged={refresh} propertyId={j.property?.id} />
            <FieldAddedLines jobId={j.id} lines={j.lines} />
            {repeats && <JobDiscountNote jobId={j.id} lines={j.lines} seesInvoices={seesInvoices} canSwitch={canSell && j.status === "active"} onChanged={refresh} />}
            {addButtons}
          </Section>
        )}

        {canSell && <ChangeOrders jobId={j.id} onStart={() => changeOrder.mutate()} starting={changeOrder.isPending} />}

        <PhotosCard jobId={j.id} />
        <PlansCard scope={{ kind: "job", id: j.id, propertyId: j.property?.id ?? null }} />

        {/* Each wrapped (display: contents) so focus can find its add button as its dialog closes. */}
        {shows.materials && <div data-extra="materials" style={{ display: "contents" }}><MaterialsCard jobId={j.id} showCosts={seesCosts} use={seesCosts ? cost.materialRows : undefined} startAdding={adding === "materials"} onAddClosed={doneAdding} /></div>}

        {shows.expenses && <div data-extra="expenses" style={{ display: "contents" }}><ExpensesCard jobId={j.id} onChanged={() => queryClient.invalidateQueries({ queryKey: ["job", id, "costs"] })} startAdding={adding === "expenses"} onAddClosed={doneAdding} /></div>}

        {shows.pay && <div data-extra="pay" style={{ display: "contents" }}><JobPayCard job={{ id: j.id, number: j.number, title: j.title, archived: j.status === "archived" }} visits={visits} lines={j.lines} startAdding={adding === "pay"} onAddClosed={doneAdding} /></div>}

        {seesInvoices && (
          <Section title="Invoices" count={invoices.data?.length || undefined}>
            {invoices.isPending ? (
              <div className={styles.loadingRow}><Skeleton width="50%" /></div>
            ) : invoices.data?.length ? (
              <RelatedList label="Invoices">
                {invoices.data.map((inv) => (
                  <RelatedRow
                    key={inv.id}
                    to={`/invoices/${inv.id}`}
                    lead={`#${inv.number}`}
                    title={inv.kind === "progress" ? `Pay app ${inv.pay_app_number}` : inv.kind === "deposit" ? "Deposit" : inv.kind === "visits" ? "Visits" : inv.kind === "retainage" ? "Retainage" : "Invoice"}
                    end={<><EntityStatus kind="invoice" status={inv.status} /><b>{formatMoney(inv.total)}</b></>}
                  />
                ))}
              </RelatedList>
            ) : (
              // Create invoice is in the page header, so the empty line doesn't repeat it.
              <EmptyState inline title="Not invoiced yet" />
            )}
          </Section>
        )}
      </DetailColumns>

      {visit && <VisitDialog visit={visit} onClose={() => setVisit(null)} onSaved={refresh} />}
      {extraVisit && <ExtraWorkDialog visit={extraVisit} jobId={j.id} onClose={() => setExtraVisit(null)} />}
      {dialog === "details" && <JobDetailsDialog job={j as unknown as JobRecord} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "showcase" && <ShowcaseDialog jobId={j.id} onClose={() => setDialog(null)} />}
      {dialog === "pause" && <PauseJobDialog jobId={j.id} canSchedule={canDispatch} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "invoice" && (
        <InvoiceJobDialog
          job={{ id: j.id, contract_total: contract, deposit: Number(j.quote?.deposit_amount ?? 0), depositInvoice, billed, uninvoicedVisits: uninvoiced, kind: j.kind, fixed: j.kind === "recurring" && j.pricing === "fixed", byVisit: billsByVisit(j), retainageHeld, finalInvoice }}
          onClose={() => setDialog(null)}
          onCreated={(invoiceId) => {
            refresh();
            setDialog(null);
            setMadeInvoice(invoiceId);
          }}
        />
      )}
      {madeInvoice && <AddWorkDialog invoiceId={madeInvoice} jobId={j.id} skipEmpty onClose={() => navigate(`/invoices/${madeInvoice}`)} />}
    </>
  );
}

/** A visit's day for the left of its row: "Wed" (or "Today") over "Nov 4", with the year when it isn't this one. */
function visitDay(date: string, today: string) {
  const at = new Date(`${date}T12:00:00`);
  return {
    weekday: date === today ? "Today" : at.toLocaleDateString(intlLocale(), { weekday: "short" }),
    date: at.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: date.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" }),
  };
}

/** The bar's parts, each with its color: the same dot keys each cost's line under it. */
const COST_PARTS = [
  { key: "materials", label: "Line item costs", color: "#c9852a" },
  { key: "labor", label: "Labor", color: "#3474d4" },
  { key: "crew", label: "Sub and crew pay", color: "#0e9aa7" },
  { key: "expenses", label: "Expenses", color: "#8b5cf6" },
  { key: "profit", label: "Profit", color: "var(--green)" },
] as const;

/** A cost's label with its color in the bar before it; with no part (the price), an empty place for the dot. */
function CostKey({ part, children }: { part?: (typeof COST_PARTS)[number]["key"]; children: ReactNode }) {
  return <span className={styles.costKey}><i style={part ? { background: COST_PARTS.find((p) => p.key === part)!.color } : undefined} aria-hidden="true" />{children}</span>;
}

/** Price split into costs and profit, like Jobber's job profit bar. */
function ProfitBar({ price, labor, crew, expenses, materials }: { price: number; labor: number; crew: number; expenses: number; materials: number }) {
  const total = Math.max(price, labor + crew + expenses + materials, 1);
  const values: Record<(typeof COST_PARTS)[number]["key"], number> = { materials, labor, crew, expenses, profit: Math.max(0, price - labor - crew - expenses - materials) };
  const parts = COST_PARTS.map((p) => ({ ...p, value: values[p.key] }));
  return (
    <div className={styles.bar} role="img" aria-label={parts.map((p) => `${p.label} ${formatMoney(p.value)}`).join(", ")}>
      {parts.map((p) => p.value > 0 && <span key={p.key} title={`${p.label}: ${formatMoney(p.value)}`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />)}
    </div>
  );
}
