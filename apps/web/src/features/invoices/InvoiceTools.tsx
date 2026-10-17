/**
 * The money at a glance on the Invoices screen, invoicing every finished job in one go, and
 * reminding everyone who's past due.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Sparkline } from "@/components/ui/Chart";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, formatMoney, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { receivablesTrend } from "@/lib/trends";

const TREND_WEEKS = 12;

export function InvoiceSummary({ onPick }: { onPick: (filter: "open" | "overdue" | "paid") => void }) {
  const { company } = useSession();
  const today = todayIn(company.timezone);
  const since = addDaysIso(today, -30);
  const summary = useQuery({
    queryKey: ["invoices", company.id, "summary"],
    queryFn: async () => {
      const [open, paid, history] = await Promise.all([
        supabase().from("invoices").select("id, status, balance_due, issued_on, due_on").eq("company_id", company.id).in("status", ["sent", "partially_paid", "overdue"]).limit(5000),
        supabase().from("payments").select("amount").eq("company_id", company.id).gte("received_at", `${since}T00:00:00`).limit(5000),
        // Everything received in the trend window (plus 30 days for the rolling "collected" figure).
        supabase().from("payments").select("amount, received_at, invoice_id").eq("company_id", company.id).gte("received_at", `${addDaysIso(today, -(7 * (TREND_WEEKS - 1) + 31))}T00:00:00`).limit(5000),
      ]);
      const rows = unwrap(open);
      const late = rows.filter((r) => r.status === "overdue");
      const payments = unwrap(history);
      // Invoices paid during the window aren't open any more but still count toward earlier weeks.
      const openIds = new Set(rows.map((r) => r.id));
      const paidIds = [...new Set(payments.map((p) => p.invoice_id).filter((id): id is string => Boolean(id) && !openIds.has(id!)))];
      const closed = [];
      for (let i = 0; i < paidIds.length; i += 200) {
        closed.push(...unwrap(await supabase().from("invoices").select("id, status, balance_due, issued_on, due_on").in("id", paidIds.slice(i, i + 200)).not("status", "in", "(draft,void)")));
      }
      const s = {
        owed: rows.reduce((sum, r) => sum + Number(r.balance_due), 0),
        owedCount: rows.length,
        late: late.reduce((sum, r) => sum + Number(r.balance_due), 0),
        lateCount: late.length,
        collected: unwrap(paid).reduce((sum, p) => sum + Number(p.amount), 0),
      };
      const trend = receivablesTrend({ invoices: [...rows, ...closed], payments, today, tz: company.timezone, weeks: TREND_WEEKS });
      // The last point is exactly what the tile shows.
      trend[trend.length - 1] = { label: "Today", owed: s.owed, pastDue: s.late, collected: s.collected };
      return { ...s, trend };
    },
  });
  const s = summary.data;
  const stat = (label: string, value: number, hint: string, filter: "open" | "overdue" | "paid", series: "owed" | "pastDue" | "collected", tone?: "bad") => (
    <button type="button" className="card stat stat-button" onClick={() => onPick(filter)}>
      <span className="label">{label}</span>
      <span className="value" style={tone ? { color: "var(--danger)" } : undefined}><AnimatedNumber value={value} format={MONEY} /></span>
      <span className="hint">{hint}</span>
      <Sparkline
        data={s!.trend.map((p) => ({ label: p.label, [series]: p[series] }))}
        config={{ [series]: { label, color: tone ? "var(--danger)" : series === "collected" ? "var(--green)" : "var(--invoice)" } }}
        format={formatMoney}
      />
    </button>
  );
  if (!s) return <div className="stat-row">{[0, 1, 2].map((i) => <div key={i} className="card stat"><Skeleton width="50%" height={11} /><Skeleton width="70%" height={24} /><Skeleton width="100%" height={40} style={{ marginTop: 10 }} /></div>)}</div>;
  return (
    <div className="stat-row">
      {stat("Waiting on payment", s.owed, `${s.owedCount} ${s.owedCount === 1 ? "invoice" : "invoices"}`, "open", "owed")}
      {stat("Past due", s.late, s.lateCount ? `${s.lateCount} ${s.lateCount === 1 ? "invoice" : "invoices"}` : "Nothing late", "overdue", "pastDue", s.lateCount ? "bad" : undefined)}
      {stat("Collected, last 30 days", s.collected, "Payments received", "paid", "collected")}
    </div>
  );
}

interface ReadyJob {
  id: string;
  number: number;
  title: string;
  kind: string;
  billing_mode: string;
  client: { display_name: string; email: string | null } | null;
  financials: { contract_total: number } | null;
}

/** Jobs waiting for their invoice: finished one-off jobs, and per-visit jobs with completed visits not yet billed. */
function useReadyJobs() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["invoices", company.id, "ready-jobs"],
    queryFn: async () => {
      const select = "id, number, title, kind, billing_mode, client:clients(display_name, email), financials:job_financials(contract_total)";
      const [finished, visits] = await Promise.all([
        supabase().from("jobs").select(select).eq("company_id", company.id).eq("status", "requires_invoicing").order("number").limit(200),
        supabase().from("visits").select("job_id").eq("company_id", company.id).eq("status", "completed").eq("kind", "job").is("invoice_id", null).not("job_id", "is", null).limit(2000),
      ]);
      const ready = unwrap(finished) as unknown as ReadyJob[];
      const visitJobs = [...new Set(unwrap(visits).map((v) => v.job_id!))].filter((id) => !ready.some((j) => j.id === id));
      if (visitJobs.length) {
        const perVisit = unwrap(await supabase().from("jobs").select(select).in("id", visitJobs).eq("billing_mode", "per_visit").eq("status", "active")) as unknown as ReadyJob[];
        ready.push(...perVisit);
      }
      return ready;
    },
  });
}

export function ReadyToInvoice() {
  const ready = useReadyJobs();
  const [open, setOpen] = useState(false);
  const jobs = ready.data ?? [];
  if (!jobs.length) return null;
  return (
    <>
      <div className="callout callout-info">
        <Icon name="invoice" size={18} />
        <div className="grow">
          <strong>{jobs.length} {jobs.length === 1 ? "job is" : "jobs are"} ready to invoice.</strong>{" "}
          <span className="muted">{jobs.slice(0, 3).map((j) => j.client?.display_name ?? j.title).join(", ")}{jobs.length > 3 ? ` and ${jobs.length - 3} more` : ""}</span>
        </div>
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Invoice them</Button>
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
  const run = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ results: Array<{ number: number; ok: boolean; sent?: boolean; error?: string }> }>("/invoices/batch", { job_ids: picked, send }),
    onSuccess: ({ results }) => {
      const made = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      const emailed = made.filter((r) => r.sent).length;
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      if (made.length) toast.success(`Created ${made.length} ${made.length === 1 ? "invoice" : "invoices"}${send ? `, emailed ${emailed}` : ". They're drafts until you send them"}.`);
      if (failed.length) toast.error(`${failed.length} couldn't be invoiced: ${failed.map((f) => `job #${f.number} (${f.error})`).join("; ")}`);
      const unsent = made.filter((r) => send && !r.sent);
      if (unsent.length) toast.error(`${unsent.length} not emailed (no email address on file). They're in Drafts.`);
      onClose();
    },
  });
  const total = jobs.filter((j) => picked.includes(j.id) && j.billing_mode !== "per_visit").reduce((s, j) => s + Number(j.financials?.contract_total ?? 0), 0);
  return (
    <Dialog open onClose={onClose} title="Invoice finished jobs" description="Each job gets its invoice, less any deposits or progress payments already billed." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); run.mutate(); }}>
        <div className="card" style={{ boxShadow: "none", maxHeight: 340, overflowY: "auto" }}>
          {jobs.map((j) => (
            <label key={j.id} className="card-row" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.includes(j.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, j.id] : picked.filter((x) => x !== j.id))} />
              <span className="grow" style={{ minWidth: 0 }}>
                <strong>{j.client?.display_name ?? j.title}</strong>
                <span className="muted small" style={{ display: "block" }}>Job #{j.number} · {j.title}{j.billing_mode === "per_visit" ? " · completed visits" : ""}{send && !j.client?.email ? " · no email on file" : ""}</span>
              </span>
              <span className="tabular">{j.billing_mode === "per_visit" ? <span className="muted small">per visit</span> : formatMoney(j.financials?.contract_total ?? 0)}</span>
            </label>
          ))}
        </div>
        {canEmail && (
          <label className="switch-row" style={{ fontWeight: 500 }}>
            <input type="checkbox" className="switch" checked={send} onChange={(e) => setSend(e.target.checked)} />
            Email each client their invoice now
          </label>
        )}
        <FormError error={run.error} />
        <div className="form-actions">
          <span className="muted small" style={{ marginRight: "auto" }}>{total > 0 ? `${formatMoney(total)} before tax` : null}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon={send ? "send" : "invoice"} loading={run.isPending} disabled={!picked.length}>
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
      if (r.sent) toast.success(`Sent ${r.sent} ${r.sent === 1 ? "reminder" : "reminders"}`);
      if (r.skipped.length) toast.error(`${r.skipped.length} not sent: ${r.skipped.map((s) => `#${s.number} (${s.reason})`).join("; ")}`);
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
