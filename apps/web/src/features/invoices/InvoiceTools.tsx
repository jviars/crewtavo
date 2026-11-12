/**
 * The money at a glance on the Invoices screen, invoicing every finished job in one go, autopay
 * charges that need someone, charging many saved cards at once, and reminding everyone who's past due.
 */
import { laborRates } from "@crewtavo/core/billing";
import { monthText } from "@crewtavo/core/jobBilling";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormChecks, FormError } from "@/components/ui/Field";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { Change } from "../finance/change";
import { chargeBusy, chargeInChunks, chargeLiveText, chargeOutcomeText, chargeSummary, chargeTotal, type ChargeableInvoice, type ChargeResult } from "./charges";
import { invoiceTotals, readyJobs, type ReadyJob } from "./totals";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * What's owed and past due today, and what came in over the past 30 days, each with its change: the
 * balances against 30 days ago, money in against the 30 days before. The database adds them up
 * (invoice_summary): balances back then are walked back from today's through the payments since, so
 * they're close rather than exact.
 */
export function InvoiceSummary({ onPick }: { onPick: (filter: "open" | "overdue" | "paid") => void }) {
  const { company } = useSession();
  const today = todayIn(company.timezone);
  const summary = useQuery({
    queryKey: ["invoices", company.id, "summary"],
    queryFn: () => invoiceTotals(company.id, today),
  });
  const s = summary.data;
  const stat = (label: string, value: number, change: ReactNode, hint: string, filter: "open" | "overdue" | "paid", tone?: "bad") => (
    <button type="button" className="card stat stat-button" onClick={() => onPick(filter)}>
      <span className="label">{label}</span>
      <span className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="value" style={tone ? { color: "var(--danger)" } : undefined}><AnimatedNumber value={value} format={MONEY} /></span>
        {change}
      </span>
      <span className="hint">{hint}</span>
    </button>
  );
  if (!s) return <div className="stat-row">{[0, 1, 2].map((i) => <div key={i} className="card stat"><Skeleton width="50%" height={11} /><Skeleton width="70%" height={24} /><Skeleton width="60%" height={11} style={{ marginTop: 6 }} /></div>)}</div>;
  // A balance's chip compares it with 30 days ago, which the hint then says.
  const since = (shown: boolean) => (shown ? " · vs 30 days ago" : "");
  return (
    <div className="stat-row">
      {stat(statusText("invoice", "sent"), s.owed, <Change now={s.owed} before={s.before.owed} compared="30 days ago" same="No change" />, `${plural(s.owedCount, "invoice")}${since(s.before.owed > 0)}`, "open")}
      {stat(
        statusText("invoice", "overdue"),
        s.late,
        <Change now={s.late} before={s.before.pastDue} compared="30 days ago" same="No change" better="down" />,
        `${s.lateCount ? plural(s.lateCount, "invoice") : "Nothing late"}${since(s.before.pastDue > 0)}`,
        "overdue",
        s.lateCount ? "bad" : undefined,
      )}
      {stat("Collected", s.collected, <Change now={s.collected} before={s.before.collected} compared="the 30 days before" />, `${plural(s.payments, "payment")} · Past 30 days`, "paid")}
    </div>
  );
}

/** Before tax: a finished job's contract, a fixed price for each month due, nothing yet for visits. */
const amountOf = (j: ReadyJob) => (j.pricing === "per_visit" || j.billing_mode === "per_visit" ? 0 : Number(j.financials?.contract_total ?? 0) * (j.months?.length || 1));

/** Jobs waiting for their invoice (totals.ts readyJobs). */
function useReadyJobs() {
  const { company } = useSession();
  return useQuery({ queryKey: ["invoices", company.id, "ready-jobs"], queryFn: () => readyJobs(company.id) });
}

/**
 * Autopay charges someone has to see to, on the Invoices screen: ones that failed (the client was
 * sent the Pay link and a way to update their card), each name opening its invoice, and ones over
 * the autopay limit waiting for the office's OK. Nothing when there are none.
 */
export function AutopayAttention() {
  const { company } = useSession();
  const charges = useQuery({
    queryKey: ["invoices", company.id, "autopay"],
    meta: { silent: true },
    queryFn: async () => {
      const select = "id, status, invoice:invoices!autopay_charges_invoice_fkey(id, number), client:clients!autopay_charges_client_fkey(display_name)";
      const [failed, asking] = await Promise.all([
        supabase().from("autopay_charges").select(select, { count: "exact" }).eq("company_id", company.id).in("status", ["failed", "needs_client"]).not("invoice_id", "is", null).order("updated_at", { ascending: false }).limit(5),
        // The one waiting longest is the one to look at first.
        supabase().from("autopay_charges").select(select, { count: "exact" }).eq("company_id", company.id).eq("status", "needs_approval").not("invoice_id", "is", null).order("created_at").limit(1),
      ]);
      return { failed: unwrap(failed), failedCount: failed.count ?? 0, asking: unwrap(asking)[0] ?? null, askingCount: asking.count ?? 0 };
    },
  });
  const data = charges.data;
  if (!data || (!data.failedCount && !data.askingCount)) return null;
  const failed = data.failed.filter((c) => c.invoice);
  // The same client twice (two invoices) says which is which.
  const name = (c: (typeof failed)[number]) => {
    const who = c.client?.display_name ?? `Invoice #${c.invoice!.number}`;
    return failed.filter((o) => o.client?.display_name === c.client?.display_name).length > 1 ? `${who} (#${c.invoice!.number})` : who;
  };
  return (
    <>
      {data.failedCount > 0 && (
        <div className="callout callout-danger">
          <Icon name="card" size={20} />
          <div className="grow">
            <strong>{plural(data.failedCount, "autopay charge")} failed:</strong>{" "}
            {failed.map((c, i) => (
              <Fragment key={c.id}>
                {i > 0 && ", "}
                <Link to={`/invoices/${c.invoice!.id}`}>{name(c)}</Link>
              </Fragment>
            ))}
            {data.failedCount > failed.length && ` and ${data.failedCount - failed.length} more`}
          </div>
        </div>
      )}
      {data.askingCount > 0 && data.asking?.invoice && (
        <div className="callout callout-warning">
          <Icon name="card" size={20} />
          <div className="grow">
            <strong>{data.askingCount === 1 ? "1 charge needs" : `${data.askingCount} charges need`} your OK.</strong>{" "}
            <span className="muted">{data.asking.client?.display_name ? `${data.asking.client.display_name} · ` : ""}Invoice #{data.asking.invoice.number}</span>
          </div>
          <Link className="btn btn-sm" to={`/invoices/${data.asking.invoice.id}`}>Review</Link>
        </div>
      )}
    </>
  );
}

export function ReadyToInvoice() {
  const ready = useReadyJobs();
  const [open, setOpen] = useState(false);
  const jobs = ready.data ?? [];
  if (!jobs.length) return null;
  return (
    <>
      <div className="callout callout-info">
        <Icon name="invoice" size={20} />
        <div className="grow">
          <strong>{jobs.length} {jobs.length === 1 ? "job is" : "jobs are"} ready to invoice.</strong>{" "}
          <span className="muted">{jobs.slice(0, 3).map((j) => j.client?.display_name ?? j.title).join(", ")}{jobs.length > 3 ? ` and ${jobs.length - 3} more` : ""}</span>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>Invoice them</Button>
      </div>
      {open && <BatchDialog jobs={jobs} onClose={() => setOpen(false)} />}
    </>
  );
}

function BatchDialog({ jobs, onClose }: { jobs: ReadyJob[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[]>(jobs.map((j) => j.id));
  const canEmail = session.config.features.email;
  const [send, setSend] = useState(false);
  // Each job's logged hours (at an item sold by the hour) and priced materials, as Add logged work starts out ticked.
  const [work, setWork] = useState(false);
  const [rateId, setRateId] = useState("");
  const rates = useQuery({
    queryKey: ["services", session.company.id, "hourly"],
    enabled: work,
    queryFn: async () => laborRates(unwrap(await supabase().from("services").select("id, name, unit, unit_price, taxable, active").eq("company_id", session.company.id))),
  });
  const rate = rates.data?.find((r) => r.id === rateId) ?? rates.data?.[0];
  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      if (!picked.length) throw new Error("Pick at least one job to invoice.");
      return api.post<{ results: Array<{ number: number; ok: boolean; sent?: boolean; error?: string }> }>("/invoices/batch", { job_ids: picked, send, logged_work: work, rate_id: work ? rate?.id : undefined });
    },
    onSuccess: ({ results }) => {
      const made = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const emailed = made.filter((r) => r.sent).length;
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (made.length) {
        toast.success(`${plural(made.length, "invoice")} created${send && emailed ? ` and ${emailed} emailed` : ""}`, { tone: "invoice", description: send ? undefined : "They're drafts until you send them." });
      }
      if (failed.length) toast.error(`${failed.length} couldn't be invoiced`, { description: failed.map((f) => `Job #${f.number}: ${f.error}`).join(". ") });
      const unsent = made.filter((r) => send && !r.sent);
      if (unsent.length) toast.error(`${unsent.length} not emailed`, { description: "No email address on file. They're in Drafts." });
      onClose();
    },
  });
  const total = jobs.filter((j) => picked.includes(j.id)).reduce((s, j) => s + amountOf(j), 0);
  return (
    <Dialog open onClose={onClose} title="Invoice finished jobs" description="Each job gets its invoice, less any deposits or progress payments already billed. A monthly job's covers its month." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
          {jobs.map((j) => (
            <label key={j.id} className="card-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{j.client?.display_name ?? j.title}</strong>
                <span className="muted small" style={{ display: "block" }}>
                  Job #{j.number} · {j.title}
                  {j.months ? ` · ${j.months.map((m) => monthText(m)).join(", ")}` : j.billing_mode === "per_visit" ? " · completed visits" : ""}
                  {send && !j.client?.email ? " · no email on file" : ""}
                </span>
              </span>
              <span className="tabular">{amountOf(j) ? formatMoney(amountOf(j)) : <span className="muted small">per visit</span>}</span>
            </label>
          ))}
        </div>
        <label className="switch-row" style={{ fontWeight: 400 }}>
          <input type="checkbox" className="switch" checked={work} onChange={(e) => setWork(e.target.checked)} />
          Add logged hours and materials
        </label>
        {work && rates.data && (rates.data.length ? (
          <select className="select input-sm" style={{ width: "auto" }} value={rate?.id ?? ""} onChange={(e) => setRateId(e.target.value)} aria-label="Bill hours at">
            {rates.data.map((r) => <option key={r.id} value={r.id}>Hours at {r.name} · {formatMoneyCents(Number(r.unit_price))}/{r.unit}</option>)}
          </select>
        ) : (
          <span className="muted small">To bill hours, add an item sold by the hour (unit hr), like Labor, to your price list.</span>
        ))}
        {canEmail && (
          <label className="switch-row" style={{ fontWeight: 400 }}>
            <input type="checkbox" className="switch" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Email each client their invoice now
          </label>
        )}
        <FormError error={run.error ?? rates.error} />
        <div className="form-actions">
          <FormChecks />
          <span className="muted small" style={{ marginRight: "auto" }}>{total > 0 ? `${formatMoney(total)} before tax` : null}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={send ? "send" : "invoice"} loading={run.isPending}>
            {send ? "Create and send" : "Create"} {picked.length} {picked.length === 1 ? "invoice" : "invoices"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function RemindAllButton({ ids }: { ids: string[] }) {
  const { config } = useSession();
  const remind = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped: Array<{ number: number; reason: string }> }>("/invoices/remind", { invoice_ids: ids }),
    onSuccess: (r) => {
      if (r.sent) toast.success(`${plural(r.sent, "reminder")} sent`, { tone: "invoice" });
      if (r.skipped.length) toast.error(`${r.skipped.length} not sent`, { description: r.skipped.map((s) => `Invoice #${s.number}: ${s.reason}`).join(". ") });
    },
  });
  if (!ids.length || !config.features.email) return null;
  return (
    <Button
      icon="send"
      loading={remind.isPending}
      onClick={async () => {
        if (await confirm({ title: `Email ${ids.length} payment ${ids.length === 1 ? "reminder" : "reminders"}?`, body: "Each client gets a friendly note with a link to view and pay.", confirmLabel: "Send reminders" })) remind.mutate();
      }}
    >
      Remind all
    </Button>
  );
}

/**
 * Charge cards: unpaid invoices whose client saved a card and agreed to be charged, ticked and
 * charged in one go. One with a charge under way shows what it's doing but can't be ticked. Each is a
 * charge the autopay task makes, for the balance shown, so a declined card sends that client the Pay
 * link, as autopay does; once they're sent, each invoice says what happened.
 */
export function ChargeCardsDialog({ onClose }: { onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: ["invoices", company.id, "chargeable"],
    queryFn: () => api.get<{ invoices: ChargeableInvoice[] }>("/invoices/chargeable"),
  });
  const rows = list.data?.invoices ?? [];
  const open = rows.filter((r) => !chargeBusy(r));
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = open.filter((r) => picked.includes(r.id));
  const total = chargeTotal(chosen);
  // The rows go with their results: the list changes under them once they're charging or paid. Looked
  // at again however it ends, since a chunk that failed may still have queued some.
  const charge = useMutation({
    meta: { inline: true },
    mutationFn: (batch: ChargeableInvoice[]) => chargeInChunks(batch, (body) => api.post<{ results: ChargeResult[] }>("/invoices/charge", body)),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["invoice"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen.length || charge.isPending) return;
    const ok = await confirm({
      title: `Charge ${plural(chosen.length, "invoice")}?`,
      body: `${formatMoneyCents(total)} in all, each to the card its client saved. If a card is declined, that client is sent the Pay link.`,
      confirmLabel: `Charge ${formatMoneyCents(total)}`,
    });
    if (ok) charge.mutate(chosen);
  };
  const done = charge.data?.rows;
  const all = open.length > 0 && chosen.length === open.length;

  return (
    <Dialog open onClose={onClose} title="Charge saved cards" description="Unpaid invoices whose client saved a card and agreed to be charged." size="lg">
      {done ? (
        <div className="stack">
          <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
            {done.map(({ row, result }) => (
              <div key={row.id} className="card-row">
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{row.client_name}</strong>
                  <span className="muted small" style={{ display: "block" }}>#{row.number} · {row.card}</span>
                </span>
                <span style={{ textAlign: "right" }}>
                  <span className="tabular">{formatMoneyCents(row.balance_due)}</span>
                  <span className={`small ${result.outcome === "queued" || result.outcome === "in_progress" ? "muted" : "text-danger"}`} style={{ display: "block" }}>{chargeOutcomeText(result)}</span>
                </span>
              </div>
            ))}
          </div>
          <FormError error={charge.data?.error} />
          <span className="muted small" role="status">{chargeSummary(done.map((d) => d.result))}</span>
          <div className="form-actions">
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          {list.isPending ? (
            <span className="muted small" role="status">Finding unpaid invoices…</span>
          ) : rows.length === 0 && !list.error ? (
            <EmptyState inline title="No saved cards to charge">Unpaid invoices show here once their client saves a card and agrees to be charged.</EmptyState>
          ) : (
            rows.length > 0 && (
              <>
                <label className="row" style={{ gap: 8, cursor: open.length ? "pointer" : "default" }}>
                  <input type="checkbox" checked={all} disabled={!open.length} onChange={(e) => setPicked(e.target.checked ? open.map((r) => r.id) : [])} />
                  Select all ({open.length})
                </label>
                <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
                  {rows.map((r) => (
                    <label key={r.id} className="card-row" style={{ cursor: chargeBusy(r) ? "default" : "pointer" }}>
                      <input type="checkbox" disabled={chargeBusy(r)} checked={!chargeBusy(r) && picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <strong>{r.client_name}</strong>
                        <span className="muted small" style={{ display: "block" }}>
                          #{r.number} · <span className={r.status === "overdue" ? "text-danger" : undefined}>{r.due_on ? `Due ${formatDate(r.due_on)}` : "Due on receipt"}</span> · {r.card}
                        </span>
                      </span>
                      <span style={{ textAlign: "right" }}>
                        <span className="tabular">{formatMoneyCents(r.balance_due)}</span>
                        {chargeBusy(r) && <span className="muted small" style={{ display: "block" }}>{chargeLiveText(r)}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )
          )}
          <FormError error={charge.error ?? list.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="card" loading={charge.isPending} disabled={!chosen.length}>
              {chosen.length ? `Charge ${plural(chosen.length, "invoice")} · ${formatMoneyCents(total)}` : "Charge invoices"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
