/**
 * Timesheets → Pay: each person's approved hours and pay for a period (breaks aren't paid; hours
 * over 40 in a week are counted for the payroll service), their piece pay (per square, per job or
 * per day, from work done on jobs in it), and marking them paid once the business has paid them
 * through its own payroll or bank. Crewtavo moves no money. The same work as AI assistants' pay
 * tools (apps/api/src/services/pay.ts).
 */
import { breakPay, SHORT_BREAK_MINUTES, type BreakPay } from "@crewtavo/core/breaks";
import { mondayOf, STATE_OVERTIME_NOTE } from "@crewtavo/core/pay";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { RowPerson } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { FilterTabs } from "@/components/ui/Toolbar";
import { api } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { addDaysIso, englishDateLocale, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { owedFor, PAY_COLUMNS, payRows, pieceJobs, waitingFor, type PayPerson } from "./payCsv";
import { inEnglish } from "@/lib/i18n";
import styles from "./Timesheets.module.css";
import { Select } from "@/components/ui/Select";

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
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(englishDateLocale(), { month: "short", day: "numeric", timeZone: "UTC" });

export function PayPeriods({ header }: { header: (actions: ReactNode) => ReactNode }) {
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
  // Your own pay is an owner's to mark paid, as your pay rate is (the server and the database hold to it).
  const mine = (p: PersonPay) => p.user_id === session.userId && session.role !== "owner";
  // Everyone still owed, your own pay included: what the period still has to pay.
  const owed = d ? d.people.filter((p) => owedFor(p) && !p.paid) : [];
  // Those you can mark paid yourself.
  const unpaid = owed.filter((p) => !mine(p));
  const ownLeft = owed.some(mine);
  // Marking paid is refused while anyone it marks has time not approved (piece pay alone included).
  const waiting = waitingFor(unpaid);
  const piece = (d?.piece_amount ?? 0) > 0;
  const anyPaid = Boolean(d?.people.some((p) => p.paid));
  const stillOwed = owed.reduce((s, p) => s + p.amount, 0);
  const exportCsv = () => d && downloadCsv(`pay-${d.from}-to-${d.to}.csv`, inEnglish(() => toCsv(payRows(d.people, methodLabel), [...PAY_COLUMNS])));
  const takeBack = async () => (await confirm({ title: "Take back the paid mark?", body: "Everyone in this period goes back to not paid, and their time can be changed again. Nothing is paid or refunded.", confirmLabel: "Take it back" })) && unmark.mutate();
  const preset = presets.find((p) => p.from === range.from && p.to === range.to)?.label ?? "";

  const actions = d && d.people.length > 0 && (
    <>
      <Menu
        title="Pay"
        items={[
          { label: "Download as spreadsheet", icon: "download", onSelect: exportCsv },
          { separator: true, hidden: !anyPaid },
          { label: "Take back paid", icon: "undo", hidden: !anyPaid, disabled: unmark.isPending, onSelect: () => void takeBack() },
        ]}
      />
      {unpaid.length > 0 && <Button variant="primary" icon="check" disabled={waiting.length > 0} onClick={() => setMarking(true)}>Mark paid</Button>}
    </>
  );

  return (
    <>
      {header(actions)}
      <div className={styles.periodBar}>
        <FilterTabs label="Period" value={preset} onChange={(label) => { const p = presets.find((x) => x.label === label); if (p) setRange({ from: p.from, to: p.to }); }} options={presets.map((p) => ({ value: p.label, label: p.label }))} />
        <div className={styles.dates}>
          <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} aria-label="From" />
          <span className="muted">to</span>
          <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} aria-label="To" />
        </div>
      </div>

      <div className="stack-lg m-grouped">
        {summary.isPending && <Loading className="stack-lg"><StatsSkeleton count={3} /><SectionSkeleton rows={4} /></Loading>}
        {summary.error && <ErrorState error={summary.error} onRetry={() => summary.refetch()} />}
        {d && !d.people.length && <EmptyState icon="clock" title="No time or piece pay in this period" />}
        {d && d.people.length > 0 && (
          <>
            <StatStrip label={`Pay for ${dayLabel(d.from)} – ${dayLabel(d.to)}`}>
              <Stat label="Approved hours" value={`${d.hours.toFixed(2)} h`} note={d.overtime_hours > 0 ? `${d.overtime_hours.toFixed(1)} h over 40` : `${dayLabel(d.from)} – ${dayLabel(d.to)}`} />
              <Stat label="Pay" value={formatMoney(d.amount)} note={piece ? `${formatMoney(d.piece_amount)} of it piece pay` : "At each person's rate"} />
              <Stat label="Still to pay" value={formatMoney(stillOwed)} note={owed.length ? `${owed.length} ${owed.length === 1 ? "person" : "people"}` : "Everyone's paid"} />
            </StatStrip>
            {ownLeft && (
              <div className="callout callout-info">
                <Icon name="info" size={16} />
                <div className="grow">An owner marks your own pay paid.</div>
              </div>
            )}
            {waiting.length > 0 && (
              <div className="callout callout-warning">
                <Icon name="alert" size={16} />
                <div className="grow">
                  <div>Approve everyone's time before marking the period paid.</div>
                  {waiting.map((p) => `${p.name} (${p.running ? "a clock is running" : `${p.unapproved_hours.toFixed(2)} h not approved`})`).join(", ")}.
                </div>
              </div>
            )}
            <Section title="People" count={d.people.length}>
              <RelatedList>
                {d.people.map((p) => (
                  <RelatedRow
                    key={p.user_id}
                    lead={<RowPerson name={p.name} />}
                    title={p.name}
                    sub={[
                      `${p.hours.toFixed(2)} h`,
                      p.overtime_hours > 0 && `${p.overtime_hours.toFixed(1)} over 40`,
                      (p.already_paid_hours ?? 0) > 0 && `${p.already_paid_hours!.toFixed(2)} h already paid`,
                      p.break_hours > 0 && `${p.break_hours.toFixed(1)} h unpaid breaks`,
                      piece && `${formatMoney(p.hourly_amount)} hourly · ${p.piece_amount > 0 ? `${formatMoney(p.piece_amount)} piece pay` : "no piece pay"}`,
                      p.piece.length > 0 && pieceJobs(p, formatMoneyCents),
                    ]}
                    end={
                      <>
                        {p.paid ? (
                          <span title={[methodLabel(p.paid.method), p.paid.reference].filter(Boolean).join(" · ")}><StatusPill label={`Paid ${formatMoney(p.paid.paid_amount)}`} tone="good" /></span>
                        ) : p.unapproved_hours > 0 || p.running ? (
                          <StatusPill label={p.running ? "Clock running" : `${p.unapproved_hours.toFixed(1)} h to approve`} tone="warning" />
                        ) : owedFor(p) ? (
                          <StatusPill label="Not paid yet" tone="muted" />
                        ) : (p.already_paid_hours ?? 0) > 0 ? (
                          <StatusPill label="Already paid" tone="good" />
                        ) : null}
                        <b>{formatMoney(p.amount)}</b>
                      </>
                    }
                  />
                ))}
              </RelatedList>
              <p className={styles.note}>
                Approved time at each person's pay rate{piece ? ", plus piece pay for work done on jobs in this period" : ""}. {BREAK_RULE[breakPay(session.company.settings)]}{" "}
                {d.overtime_note ?? "Hours over 40 in a week are shown for your payroll service; the amounts here are at straight time."}{" "}
                {STATE_OVERTIME_NOTE}
                {d.people.some((p) => (p.already_paid_hours ?? 0) > 0) && " Hours already paid with another period aren't counted again."}
              </p>
            </Section>
          </>
        )}

        {Boolean(history.data?.length) && (
          <Section title="Paid periods" count={history.data!.length}>
            <RelatedList>
              {history.data!.map((p) => (
                <RelatedRow
                  key={p.id}
                  onClick={() => setRange({ from: p.starts_on, to: p.ends_on })}
                  current={p.starts_on === range.from && p.ends_on === range.to}
                  title={`${dayLabel(p.starts_on)} – ${dayLabel(p.ends_on)}`}
                  detail={`${p.lines.length} ${p.lines.length === 1 ? "person" : "people"}`}
                  end={
                    <>
                      <StatusPill label={p.status === "paid" ? "Paid" : "Partly paid"} tone={p.status === "paid" ? "good" : "pending"} />
                      <b>{formatMoney(p.paid_total)}</b>
                    </>
                  }
                />
              ))}
            </RelatedList>
          </Section>
        )}
      </div>

      {marking && d && <MarkPaidDialog summary={d} people={unpaid} onClose={() => setMarking(false)} onSaved={refresh} />}
    </>
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
          <Select className="select" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Reference" optional hint="A check number or your payroll run's ID."><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></Field>
        <Field label="Paid on"><input className="input" type="date" value={paidOn} onChange={(e) => e.target.value && setPaidOn(e.target.value)} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Mark paid</Button>
        </div>
      </form>
    </Dialog>
  );
}
