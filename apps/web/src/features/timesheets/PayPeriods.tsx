/**
 * Timesheets → Pay: each person's approved hours and pay for a period (breaks aren't paid; hours
 * over 40 in a week are counted for the payroll service), their piece pay (per square, per job or
 * per day, from work done on jobs in it), and marking them paid once the business has paid them
 * through its own payroll or bank. Crewtavo moves no money. The same work as AI assistants' pay
 * tools (apps/api/src/services/pay.ts).
 */
import { breakPay, SHORT_BREAK_MINUTES, type BreakPay } from "@crewtavo/core/breaks";
import { mondayOf } from "@crewtavo/core/pay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { owedFor, PAY_COLUMNS, payRows, pieceJobs, waitingFor, type PayPerson } from "./payCsv";

type PersonPay = PayPerson;
interface Summary { from: string; to: string; period_id: string | null; status: string; people: PersonPay[]; hours: number; hourly_amount: number; piece_amount: number; amount: number; overtime_hours: number; overtime_note: string | null; unapproved_hours: number; running_clocks: number }
interface Period { id: string; starts_on: string; ends_on: string; status: string; paid_total: number; lines: Array<{ user_id: string; name: string }> }

/** How the company pays breaks (Settings → Company), as the note under a period says it. */
const BREAK_RULE: Record<BreakPay, string> = {
  short_paid: `Breaks of ${SHORT_BREAK_MINUTES} minutes or less are paid; longer ones aren't.`,
  paid: "Breaks are paid.",
  unpaid: "Breaks aren't paid.",
};

const METHODS = [
  ["direct_deposit", "Direct deposit"],
  ["payroll_service", "Payroll service"],
  ["check", "Check"],
  ["cash", "Cash"],
  ["other", "Other"],
] as const;
const methodLabel = (m: string | null) => METHODS.find(([k]) => k === m)?.[1] ?? m ?? "";
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function PayPeriods() {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const lastMonday = addDaysIso(mondayOf(today), -7);
  const presets = [
    { label: "Last week", from: lastMonday, to: addDaysIso(lastMonday, 6) },
    { label: "This week", from: mondayOf(today), to: addDaysIso(mondayOf(today), 6) },
    { label: "Last 2 weeks", from: addDaysIso(lastMonday, -7), to: addDaysIso(lastMonday, 6) },
    { label: "This month", from: `${today.slice(0, 7)}-01`, to: addDaysIso(`${addDaysIso(`${today.slice(0, 7)}-01`, 32).slice(0, 7)}-01`, -1) },
    { label: "Last month", from: `${addDaysIso(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`, to: addDaysIso(`${today.slice(0, 7)}-01`, -1) },
  ];
  const [range, setRange] = useState({ from: presets[0].from, to: presets[0].to });
  const [marking, setMarking] = useState(false);
  const key = ["pay", session.company.id, range.from, range.to];
  const summary = useQuery({ queryKey: key, queryFn: () => api.get<Summary>(`/pay/summary?from=${range.from}&to=${range.to}`) });
  const history = useQuery({ queryKey: ["pay-periods", session.company.id], queryFn: () => api.get<Period[]>("/pay/periods") });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["pay", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["pay-periods", session.company.id] });
  };
  const unmark = useMutation({
    meta: { success: "Paid mark taken back. Their time can be changed again." },
    mutationFn: () => api.post("/pay/unmark-paid", range),
    onSuccess: refresh,
  });

  const d = summary.data;
  const unpaid = d ? d.people.filter((p) => owedFor(p) && !p.paid) : [];
  // Marking paid is refused while anyone it marks has time not approved (piece pay alone included).
  const waiting = waitingFor(unpaid);
  const piece = (d?.piece_amount ?? 0) > 0;
  const exportCsv = () => d && downloadCsv(`pay-${d.from}-to-${d.to}.csv`, toCsv(payRows(d.people, methodLabel), [...PAY_COLUMNS]));

  return (
    <div className="stack">
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <div className="btn-group">
          {presets.map((p) => (
            <Button key={p.label} size="sm" variant={range.from === p.from && range.to === p.to ? "primary" : undefined} onClick={() => setRange({ from: p.from, to: p.to })}>{p.label}</Button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} aria-label="From" style={{ width: 150 }} />
          <span className="muted">to</span>
          <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} aria-label="To" style={{ width: 150 }} />
        </div>
      </div>

      {summary.isPending && <Loading><CardSkeleton lines={5} /></Loading>}
      {summary.error && <div className="card"><ErrorState error={summary.error} onRetry={() => summary.refetch()} /></div>}
      {d && !d.people.length && <div className="card"><EmptyState icon="clock" title="No time or piece pay in this period" /></div>}
      {d && d.people.length > 0 && (
        <section className="card">
          <div className="card-head" style={{ flexWrap: "wrap", gap: 10 }}>
            <strong className="grow">{dayLabel(d.from)} – {dayLabel(d.to)}</strong>
            <span className="tabular"><strong>{d.hours.toFixed(2)}</strong> h{piece ? <> · <strong>{formatMoney(d.piece_amount)}</strong> piece</> : null} · <strong>{formatMoney(d.amount)}</strong></span>
            {d.overtime_hours > 0 && <span className="chip chip-amber">{d.overtime_hours.toFixed(1)} h over 40</span>}
            <Button size="sm" icon="download" onClick={exportCsv}>Download</Button>
            {unpaid.length > 0 && <Button size="sm" variant="primary" icon="check" disabled={waiting.length > 0} onClick={() => setMarking(true)}>Mark paid</Button>}
            {d.people.some((p) => p.paid) && (
              <Button size="sm" variant="ghost" loading={unmark.isPending} onClick={async () => (await confirm({ title: "Take back the paid mark?", body: "Everyone in this period goes back to not paid, and their time can be changed again. Nothing is paid or refunded.", confirmLabel: "Take it back" })) && unmark.mutate()}>Take back paid</Button>
            )}
          </div>
          {waiting.length > 0 && (
            <div className="callout callout-warning" style={{ margin: 12 }}>
              <span className="grow small">Approve everyone's time before marking the period paid: {waiting.map((p) => `${p.name} (${p.running ? "a clock is running" : `${p.unapproved_hours.toFixed(2)} h not approved`})`).join(", ")}.</span>
            </div>
          )}
          {d.people.map((p) => (
            <div key={p.user_id} className="card-row" style={{ flexWrap: "wrap" }}>
              <span className="grow" style={{ minWidth: 140 }}>
                <strong>{p.name}</strong>
                {p.piece.length > 0 && <span className="muted small" style={{ display: "block" }}>{pieceJobs(p, formatMoneyCents)}</span>}
              </span>
              <span className="tabular">{p.hours.toFixed(2)} h</span>
              {p.overtime_hours > 0 && <span className="muted small tabular">{p.overtime_hours.toFixed(1)} over 40</span>}
              {p.break_hours > 0 && <span className="muted small tabular">{p.break_hours.toFixed(1)} h unpaid breaks</span>}
              {piece && (
                <span className="muted small tabular" style={{ minWidth: 150, textAlign: "right" }}>
                  {formatMoney(p.hourly_amount)} hourly · {p.piece_amount > 0 ? `${formatMoney(p.piece_amount)} piece pay` : "no piece pay"}
                </span>
              )}
              <span className="tabular strong" style={{ minWidth: 90, textAlign: "right" }}>{formatMoney(p.amount)}</span>
              {p.paid ? (
                <span title={[methodLabel(p.paid.method), p.paid.reference].filter(Boolean).join(" · ")}><StatusPill label={`Paid ${formatMoney(p.paid.paid_amount)}`} tone="good" /></span>
              ) : p.unapproved_hours > 0 || p.running ? (
                <StatusPill label={p.running ? "Clock running" : `${p.unapproved_hours.toFixed(1)} h to approve`} tone="warning" />
              ) : owedFor(p) ? (
                <StatusPill label="Not paid yet" tone="muted" />
              ) : null}
            </div>
          ))}
          <p className="muted small" style={{ margin: 12 }}>
            Approved time at each person's pay rate{piece ? ", plus piece pay for work done on jobs in this period" : ""}. {BREAK_RULE[breakPay(session.company.settings)]}{" "}
            {d.overtime_note ?? "Hours over 40 in a week are shown for your payroll service; the amounts here are at straight time."}
          </p>
        </section>
      )}

      {Boolean(history.data?.length) && (
        <section className="card">
          <div className="card-head"><strong>Paid periods</strong></div>
          {history.data!.map((p) => (
            <button key={p.id} type="button" className="card-row" style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer" }} onClick={() => setRange({ from: p.starts_on, to: p.ends_on })}>
              <span className="grow">{dayLabel(p.starts_on)} – {dayLabel(p.ends_on)} <span className="muted small">· {p.lines.length} {p.lines.length === 1 ? "person" : "people"}</span></span>
              <span className="tabular strong">{formatMoney(p.paid_total)}</span>
              <StatusPill label={p.status === "paid" ? "Paid" : "Partly paid"} tone={p.status === "paid" ? "good" : "warning"} />
            </button>
          ))}
        </section>
      )}

      {marking && d && <MarkPaidDialog summary={d} people={unpaid} onClose={() => setMarking(false)} onSaved={refresh} />}
    </div>
  );
}

function MarkPaidDialog({ summary, people, onClose, onSaved }: { summary: Summary; people: PersonPay[]; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const [method, setMethod] = useState<(typeof METHODS)[number][0]>("direct_deposit");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(todayIn(session.company.timezone));
  const total = people.reduce((s, p) => s + p.amount, 0);
  const save = useMutation({
    meta: { inline: true, success: `Marked ${people.length} ${people.length === 1 ? "person" : "people"} paid` },
    mutationFn: () => api.post("/pay/mark-paid", { from: summary.from, to: summary.to, user_ids: people.map((p) => p.user_id), method, reference: reference.trim() || null, paid_on: paidOn }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Mark paid" description={`${people.length} ${people.length === 1 ? "person" : "people"}, ${formatMoney(total)}. Record this after you've paid them: Crewtavo doesn't send money. Their time and piece pay in this period are then locked.`}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="How they were paid">
          <select className="select" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Reference" optional hint="A check number or your payroll run's ID."><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></Field>
        <Field label="Paid on"><input className="input" type="date" value={paidOn} onChange={(e) => e.target.value && setPaidOn(e.target.value)} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Mark paid</Button>
        </div>
      </form>
    </Dialog>
  );
}
