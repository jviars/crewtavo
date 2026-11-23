/**
 * The money at a glance on the Invoices screen, invoicing every finished job in one go, autopay
 * charges that need someone, charging many saved cards at once, and reminding everyone who's past due.
 */
import { laborRates } from "@crewtavo/core/billing";
import { monthText } from "@crewtavo/core/jobBilling";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormChecks, FormError } from "@/components/ui/Field";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow } from "@/components/ui/Section";
import { StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState } from "@/components/ui/States";
import { statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatDate, formatMoney, formatMoneyCents, formatNumber, todayIn } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { failureText, invoiceInChunks, type BatchResult } from "./batch";
import { chargeBusy, chargeInChunks, chargeLiveText, chargeOutcomeText, chargeSummary, chargeTotal, type ChargeableInvoice, type ChargeResult } from "./charges";
import { invoiceTotals, readyJobs, type ReadyJob } from "./totals";
import styles from "./invoices.module.css";
import { Select } from "@/components/ui/Select";

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * A figure's change from an earlier one, as the strip says it after its note: "+8%" in green when it
 * went the better way, red when not ("down" is better for what's past due), "24×" past ten times, and
 * nothing without an earlier figure to compare with.
 */
export function changeFrom(now: number, before: number, better: "up" | "down" = "up", after = "vs 30 days ago"): { text: string; tone?: "good" | "danger"; after: string } | undefined {
  if (!before) return undefined;
  const change = Math.round(((now - before) / Math.abs(before)) * 100);
  if (change === 0) return { text: "No change", after };
  const up = change > 0;
  const text = change >= 900 ? `${formatNumber(Math.round(now / before))}×` : `${up ? "+" : "−"}${formatNumber(Math.abs(change))}%`;
  return { text, tone: up === (better === "up") ? "good" : "danger", after };
}

/**
 * What's owed and past due today, and what came in over the past 30 days, each with its change: the
 * balances against 30 days ago, money in against the 30 days before. The database adds them up
 * (invoice_summary): balances back then are walked back from today's through the payments since, so
 * they're close rather than exact. Each figure opens its tab. A phone shows the first two.
 */
export function InvoiceSummary({ onPick }: { onPick: (filter: "open" | "overdue" | "paid") => void }) {
  const { company } = useSession();
  const today = todayIn(company.timezone);
  const summary = useQuery({
    queryKey: ["invoices", company.id, "summary"],
    queryFn: () => invoiceTotals(company.id, today),
  });
  const s = summary.data;
  if (!s) return <StatsSkeleton count={3} />;
  return (
    <StatStrip label="Invoice totals" className={styles.summary}>
      <Stat label={statusText("invoice", "sent")} value={<AnimatedNumber value={s.owed} format={MONEY} />} note={plural(s.owedCount, "invoice")} delta={changeFrom(s.owed, s.before.owed)} onClick={() => onPick("open")} />
      <Stat
        label={statusText("invoice", "overdue")}
        value={<AnimatedNumber value={s.late} format={MONEY} />}
        tone={s.lateCount ? "danger" : undefined}
        note={s.lateCount ? plural(s.lateCount, "invoice") : "Nothing late"}
        delta={changeFrom(s.late, s.before.pastDue, "down")}
        onClick={() => onPick("overdue")}
      />
      <Stat label="Collected" value={<AnimatedNumber value={s.collected} format={MONEY} />} note={`${plural(s.payments, "payment")} · past 30 days`} delta={changeFrom(s.collected, s.before.collected, "up", "vs the 30 days before")} onClick={() => onPick("paid")} />
    </StatStrip>
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
 * Autopay charges someone has to see to: ones that failed (the client was sent the Pay link and a way
 * to update their card), and ones over the autopay limit waiting for the office's OK.
 */
function useAutopayAttention(enabled: boolean) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["invoices", company.id, "autopay"],
    enabled,
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
}

/**
 * What wants the office on the Invoices screen, as quiet rows over the list (Page-Invoices.dc.html):
 * finished jobs waiting for their invoice, with Invoice them; and, for `autopay` (the people who look
 * after money), autopay charges that failed, each name opening its invoice, and one waiting for an OK.
 * Nothing when there's nothing.
 */
export function InvoiceNudges({ autopay }: { autopay: boolean }) {
  const ready = useReadyJobs();
  const charges = useAutopayAttention(autopay);
  const [batching, setBatching] = useState(false);
  const jobs = ready.data ?? [];
  const data = autopay ? charges.data : undefined;
  const failed = (data?.failed ?? []).filter((c) => c.invoice);
  const asking = data && data.askingCount > 0 && data.asking?.invoice ? data.asking : null;
  if (!jobs.length && !data?.failedCount && !asking) return null;
  // Who the jobs are for, each once (a client with two jobs ready is one name).
  const who = [...new Set(jobs.map((j) => j.client?.display_name ?? j.title))];
  // The same client twice (two invoices) says which is which.
  const name = (c: (typeof failed)[number]) => {
    const who = c.client?.display_name ?? `Invoice #${c.invoice!.number}`;
    return failed.filter((o) => o.client?.display_name === c.client?.display_name).length > 1 ? `${who} (#${c.invoice!.number})` : who;
  };
  return (
    <>
      <RelatedList label="Needs attention">
        {jobs.length > 0 && (
          <RelatedRow
            lead={<span className="rel-icon" data-tone="good"><Icon name="job" size={15} /></span>}
            title={`${jobs.length} ${jobs.length === 1 ? "job is" : "jobs are"} ready to invoice`}
            detail={<span className={styles.who}>{`${who.slice(0, 3).join(", ")}${who.length > 3 ? ` and ${who.length - 3} more` : ""}`}</span>}
            actions={<button type="button" className="link-btn" onClick={() => setBatching(true)}>Invoice them</button>}
          />
        )}
        {data && data.failedCount > 0 && (
          <RelatedRow
            lead={<span className="rel-icon" data-tone="danger"><Icon name="card" size={15} /></span>}
            title={`${plural(data.failedCount, "autopay charge")} failed`}
            detail={
              <>
                {failed.map((c, i) => (
                  <Fragment key={c.id}>
                    {i > 0 && ", "}
                    <Link to={`/invoices/${c.invoice!.id}`}>{name(c)}</Link>
                  </Fragment>
                ))}
                {data.failedCount > failed.length && ` and ${data.failedCount - failed.length} more`}
              </>
            }
            actions={failed.length === 1 ? <Link className="link-btn" to={`/invoices/${failed[0]!.invoice!.id}`}>Review</Link> : undefined}
          />
        )}
        {data && asking && (
          <RelatedRow
            lead={<span className="rel-icon" data-tone="warning"><Icon name="card" size={15} /></span>}
            title={data.askingCount === 1 ? "1 charge needs your OK" : `${data.askingCount} charges need your OK`}
            detail={`${asking.client?.display_name ? `${asking.client.display_name} · ` : ""}Invoice #${asking.invoice!.number}`}
            actions={<Link className="link-btn" to={`/invoices/${asking.invoice!.id}`}>Review</Link>}
          />
        )}
      </RelatedList>
      {batching && <BatchDialog jobs={jobs} onClose={() => setBatching(false)} />}
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
  // How many jobs have their invoice so far, while the groups go one after another.
  const [progress, setProgress] = useState<{ invoiced: number; total: number } | null>(null);
  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // In the list's order, a group at a time (the server takes 50 a call): a group that fails is reported and the rest still go.
      const chosen = jobs.filter((j) => picked.includes(j.id));
      if (!chosen.length) throw new Error("Pick at least one job to invoice.");
      setProgress({ invoiced: 0, total: chosen.length });
      return invoiceInChunks(
        chosen,
        (job_ids) => api.post<{ results: BatchResult[] }>("/invoices/batch", { job_ids, send, logged_work: work, rate_id: work ? rate?.id : undefined }),
        (invoiced, total) => setProgress({ invoiced, total }),
      );
    },
    onSuccess: (results) => {
      const made = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const emailed = made.filter((r) => r.sent).length;
      if (made.length) {
        toast.success(`${plural(made.length, "invoice")} created${send && emailed ? ` and ${emailed} emailed` : ""}`, { tone: "invoice", description: send ? undefined : "They're drafts until you send them." });
      }
      if (failed.length) toast.error(`${failed.length} couldn't be invoiced`, { description: failureText(failed) });
      const unsent = made.filter((r) => send && !r.sent);
      if (unsent.length) toast.error(`${unsent.length} not emailed`, { description: "No email address on file. They're in Drafts." });
      onClose();
    },
    // Looked at again however it ends: a group that failed may still have made some.
    onSettled: () => {
      setProgress(null);
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const total = jobs.filter((j) => picked.includes(j.id)).reduce((s, j) => s + amountOf(j), 0);
  return (
    <Dialog open onClose={onClose} title="Invoice finished jobs" description="Each job gets its invoice, less any deposits or progress payments already billed. A monthly job's covers its month." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <ul className={styles.picks} role="list" aria-label="Jobs to invoice">
          {jobs.map((j) => (
            <li key={j.id}>
              <label className={styles.pick}>
                <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
                <span className={styles.pickText}>
                  <span className={styles.pickName}>{j.client?.display_name ?? j.title}</span>
                  <span className={styles.pickSub}>
                    Job #{j.number} · {j.title}
                    {j.months ? ` · ${j.months.map((m) => monthText(m)).join(", ")}` : j.billing_mode === "per_visit" ? " · completed visits" : ""}
                    {send && !j.client?.email ? " · no email on file" : ""}
                  </span>
                </span>
                <span className={styles.pickEnd}>{amountOf(j) ? formatMoney(amountOf(j)) : <span className={styles.pickNote}>per visit</span>}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className={styles.switches}>
          <label className="switch-row">
            <input type="checkbox" className="switch" checked={work} onChange={(e) => setWork(e.target.checked)} />
            Add logged hours and materials
          </label>
          {work && rates.data && (rates.data.length ? (
            <Select className="select input-sm" style={{ width: "auto" }} value={rate?.id ?? ""} onChange={(e) => setRateId(e.target.value)} aria-label="Bill hours at">
              {rates.data.map((r) => <option key={r.id} value={r.id}>Hours at {r.name} · {formatMoneyCents(Number(r.unit_price))}/{r.unit}</option>)}
            </Select>
          ) : (
            <span className="muted small">To bill hours, add an item sold by the hour (unit hr), like Labor, to your price list.</span>
          ))}
          {canEmail && (
            <label className="switch-row">
              <input type="checkbox" className="switch" checked={send} onChange={(e) => setSend(e.target.checked)} />
              Email each client their invoice now
            </label>
          )}
        </div>
        <FormError error={run.error ?? rates.error} />
        <div className="form-actions">
          <FormChecks />
          <span className="muted small" style={{ marginRight: "auto" }} role={progress ? "status" : undefined}>
            {progress ? `Invoiced ${progress.invoiced} of ${progress.total}` : total > 0 ? `${formatMoney(total)} before tax` : null}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={send ? "send" : "invoice"} loading={run.isPending}>
            {send ? "Create and send" : "Create"} {picked.length} {picked.length === 1 ? "invoice" : "invoices"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const notSent = (skipped: Array<{ number: number; reason: string }>) => skipped.map((s) => `Invoice #${s.number}: ${s.reason}`).join(". ");

/**
 * Remind the past due, all at once, by email: the action on the Past due group's heading, so it draws
 * as green words there. "Remind both" for two. Nothing without email, or with nobody owing.
 */
export function RemindAllButton({ ids }: { ids: string[] }) {
  const { config } = useSession();
  const remind = useMutation({
    // One toast says it's sending and then how it went, failing included.
    meta: { inline: true },
    mutationFn: () =>
      toast.promise(api.post<{ sent: number; skipped: Array<{ number: number; reason: string }> }>("/invoices/remind", { invoice_ids: ids }), {
        loading: { title: `Sending ${plural(ids.length, "reminder")}…`, tone: "invoice" },
        success: (r) => (r.sent ? { title: `${plural(r.sent, "reminder")} sent`, tone: "invoice" } : r.skipped.length ? { kind: "error", title: `${r.skipped.length} not sent`, description: notSent(r.skipped) } : null),
        error: (e) => ({ title: "Reminders not sent", description: errorMessage(e) }),
      }),
    // Some went and some didn't: the ones that didn't get their own toast.
    onSuccess: (r) => {
      if (r.sent && r.skipped.length) toast.error(`${r.skipped.length} not sent`, { description: notSent(r.skipped) });
    },
  });
  if (!ids.length || !config.features.email) return null;
  return (
    <button
      type="button"
      disabled={remind.isPending}
      aria-busy={remind.isPending || undefined}
      onClick={async () => {
        if (await confirm({ title: `Email ${ids.length} payment ${ids.length === 1 ? "reminder" : "reminders"}?`, body: "Each client gets a friendly note with a link to view and pay.", confirmLabel: "Send reminders" })) remind.mutate();
      }}
    >
      {remind.isPending && <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />}
      {ids.length === 1 ? "Send a reminder" : ids.length === 2 ? "Remind both" : "Remind all"}
    </button>
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
          <ul className={styles.picks} role="list" aria-label="Invoices charged">
            {done.map(({ row, result }) => (
              <li key={row.id} className={styles.pick} data-static="">
                <span className={styles.pickText}>
                  <span className={styles.pickName}>{row.client_name}</span>
                  <span className={styles.pickSub}>#{row.number} · {row.card}</span>
                </span>
                <span className={styles.pickEnd}>
                  {formatMoneyCents(row.balance_due)}
                  <span className={styles.pickNote} data-tone={result.outcome === "queued" || result.outcome === "in_progress" ? undefined : "danger"}>{chargeOutcomeText(result)}</span>
                </span>
              </li>
            ))}
          </ul>
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
              <div className={styles.pickGroup}>
                <label className={styles.pickAll} data-off={!open.length || undefined}>
                  <input type="checkbox" checked={all} disabled={!open.length} onChange={(e) => setPicked(e.target.checked ? open.map((r) => r.id) : [])} />
                  Select all ({open.length})
                </label>
                <ul className={styles.picks} role="list" aria-label="Unpaid invoices">
                  {rows.map((r) => (
                    <li key={r.id}>
                      <label className={styles.pick} data-off={chargeBusy(r) || undefined}>
                        <input type="checkbox" disabled={chargeBusy(r)} checked={!chargeBusy(r) && picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
                        <span className={styles.pickText}>
                          <span className={styles.pickName}>{r.client_name}</span>
                          <span className={styles.pickSub}>
                            #{r.number} · <span className={r.status === "overdue" ? "text-danger" : undefined}>{r.due_on ? `Due ${formatDate(r.due_on)}` : "Due on receipt"}</span> · {r.card}
                          </span>
                        </span>
                        <span className={styles.pickEnd}>
                          {formatMoneyCents(r.balance_due)}
                          {chargeBusy(r) && <span className={styles.pickNote}>{chargeLiveText(r)}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
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
