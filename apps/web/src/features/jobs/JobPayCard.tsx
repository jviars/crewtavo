/**
 * Sub and crew pay on a job (docs/subcontractors-plan.md, phase C): a sub's price for it, and what
 * someone on the team earns on it per square, per job or per day. Lines are filled in from their
 * rates (with where each quantity came from) and can be changed while the pay is a draft or agreed.
 * Agreeing puts a sub on the visits it covers; the work is done once they are, and a sub's pay is
 * then marked paid here (a team member's goes into their pay period).
 *
 * A sub who signs in can be sent their pay as an offer instead (phase D), with a time to answer by:
 * they take it or turn it down in the field app, and an agreed price is changed the same way, by
 * sending them the new one. Work agreed on the phone is still agreed here, with Agree.
 *
 * A sub's pay shows for the office with the Subcontractors area, a team member's with Job costs:
 * the database leaves out what the person can't see. A sub's paperwork only ever warns.
 */
import { isLivePay } from "@crewtavo/core/jobPay";
import { insuranceWarning, insuranceWarningItems, insuranceWarningText, isChangeOffer, type InsuranceWarningItem } from "@crewtavo/core/subOffers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, statusText } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { dateIn, formatDate, formatMoneyCents, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { MarkPaidDialog, type ToPay } from "../subs/MarkPaidDialog";
import { RatesCard } from "../subs/RatesCard";
import {
  AGREE_CHANGE_LABEL,
  agreeChangeConfirm,
  agreedAmount,
  countsAsAgreed,
  offerActionLabel,
  offerActions,
  offerChip,
  offerLine,
  shownOnJob,
  subChoices,
  visitsForElsewhere,
  withdrawConfirm,
  withdrawnToast,
  type OfferAction,
} from "../subs/offers";
import { inOrder, type PaperworkRow } from "../subs/paperwork";
import {
  actionLabel,
  agreedToast,
  byPayOrder,
  cutShortNote,
  draftAmount,
  draftOf,
  finishedOn,
  formatRate,
  lastWorkDay,
  lineChange,
  lineNote,
  linesTotal,
  newLine,
  overCounted,
  payActions,
  payeeOf,
  payPaperworkWarning,
  payStatusLabel,
  payStatusLine,
  quantityWords,
  startingVisits,
  visitsHint,
  warnsPaperwork,
  type LineDraft,
  type PayLine,
} from "../subs/pay";
import {
  acceptPay,
  cancelPay,
  deletePay,
  handlesSubPay,
  handlesTeamPay,
  markPayDone,
  refreshPay,
  startPay,
  unmarkPaid,
  useJobPays,
  withdrawOffer,
  useSuggestion,
  type JobPay,
  type PayeeRef,
} from "../subs/payData";
import { SUB_FIELDS, useSubPaperwork, type Sub } from "../subs/subsData";
import { ChangePriceDialog, SendOfferDialog } from "./OfferDialogs";

/** A visit as the job page has it. */
export interface JobVisit { id: string; title: string; status: string; scheduled_on: string | null; completed_at: string | null; assignees: Array<{ user_id: string }> }
/** A job line, for comparing the pay's per-unit quantities with the job's. */
export interface JobLine { service_id: string | null; name: string; quantity: number | string; unit?: string | null; unit_price?: number | string | null }
interface TeamMember { user_id: string; active: boolean; profile: { full_name: string | null } | null }

/** Who the pay is for, by name. */
function usePayees(enabled: { subs: boolean; team: boolean }) {
  const session = useSession();
  const cid = session.company.id;
  const subs = useQuery({
    queryKey: ["subs", cid, "list"],
    enabled: enabled.subs,
    queryFn: async () => unwrap(await supabase().from("subcontractors").select(SUB_FIELDS).eq("company_id", cid).order("name").limit(2000)) as unknown as Sub[],
  });
  const team = useQuery({ queryKey: ["team", cid], enabled: enabled.team, queryFn: () => api.get<TeamMember[]>("/team") });
  const paperwork = useSubPaperwork(cid, undefined, enabled.subs);
  const nameOf = (p: PayeeRef & { sub?: { name: string } | null }) =>
    p.subcontractor_id ? (p.sub?.name ?? subs.data?.find((s) => s.id === p.subcontractor_id)?.name ?? "Sub") : (team.data?.find((m) => m.user_id === p.user_id)?.profile?.full_name || (team.data ? "Former team member" : "Team member"));
  const statusesOf = (subId: string): PaperworkRow[] => inOrder((paperwork.data ?? []).filter((r) => r.subcontractor_id === subId));
  // Unknown (undefined) until the list is in; a sub who's been turned off has no paperwork status.
  const subActive = (subId: string) => subs.data?.find((s) => s.id === subId)?.active;
  // What's wrong with a sub's insurance for work through `workUntil`, as an offer records it (it only warns).
  const insuranceOf = (subId: string, workUntil: string | null): InsuranceWarningItem[] =>
    paperwork.data && subActive(subId) !== false ? insuranceWarning(statusesOf(subId) as unknown as Parameters<typeof insuranceWarning>[0], workUntil) : [];
  return { subs, team, paperwork, nameOf, statusesOf, subActive, insuranceOf };
}
type Payees = ReturnType<typeof usePayees>;

export function JobPayCard({ job, visits, lines = [] }: { job: { id: string; number: number | null; title: string; archived: boolean }; visits: readonly JobVisit[]; lines?: readonly JobLine[] }) {
  const session = useSession();
  const subsArea = handlesSubPay(session);
  const teamArea = handlesTeamPay(session);
  const pays = useJobPays(session.company.id, job.id, subsArea || teamArea);
  const payees = usePayees({ subs: subsArea, team: teamArea });
  const [open, setOpen] = useState<string | null>(null);
  // Adding pay: for anyone, or for a sub (offering the job to someone else after an offer ended,
  // for the visits that offer covered).
  const [adding, setAdding] = useState<null | "any" | { elsewhere: readonly string[] }>(null);
  const [showOver, setShowOver] = useState(false);
  if (!subsArea && !teamArea) return null;

  const list = [...(pays.data ?? [])].sort(byPayOrder);
  const { shown: inPlay, hidden: over } = shownOnJob(list);
  const shown = showOver ? list : inPlay;
  const agreed = list.filter(countsAsAgreed);
  const total = Math.round(agreed.reduce((s, p) => s + agreedAmount(p) * 100, 0)) / 100;
  const openPay = list.find((p) => p.id === open);
  const twice = overCounted(list, lines);
  const addButton = !job.archived && <Button size="sm" icon="plus" onClick={() => setAdding("any")}>Add pay</Button>;

  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Sub and crew pay</h2>
        {list.length > 0 && <span className="muted small">{agreed.length ? `${formatMoneyCents(total)} agreed` : ""}</span>}
        {list.length > 0 && addButton}
      </div>
      {twice.map((w) => (
        <div key={w} className="callout callout-warning"><Icon name="alert" size={18} /><div className="grow small" style={{ fontWeight: 400 }}>{w}</div></div>
      ))}
      <div className="card">
        {pays.isPending ? (
          <div className="card-row"><Skeleton width="50%" /></div>
        ) : pays.error ? (
          <div className="card-row"><ErrorState compact error={pays.error} onRetry={() => pays.refetch()} /></div>
        ) : list.length === 0 ? (
          <EmptyState compact icon="dollar" title="No sub or crew pay yet" action={addButton}>
            {subsArea ? "What you pay a sub for this job, or what someone on your team earns on it per square, per job or per day." : "What someone on your team earns on this job per square, per job or per day."}
          </EmptyState>
        ) : (
          <>
            {shown.length === 0 && <div className="card-row"><span className="muted small">Nothing in play: it was all cancelled or turned down.</span></div>}
            {shown.map((p) => {
              const chip = offerChip(p, payeeOf(p));
              const warning = p.subcontractor_id && warnsPaperwork(p.status, payees.subActive(p.subcontractor_id)) && payees.paperwork.data
                ? payPaperworkWarning(payees.statusesOf(p.subcontractor_id), lastWorkDay(visits, p.visits.map((v) => v.visit_id)), todayIn(session.company.timezone))
                : null;
              return (
                <button key={p.id} type="button" className="card-row" style={{ width: "100%", textAlign: "left", background: "none", border: 0, cursor: "pointer", flexWrap: "wrap" }} onClick={() => setOpen(p.id)}>
                  <span className="grow" style={{ minWidth: 180 }}>
                    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                      <strong>{payees.nameOf(p)}</strong>
                      <span className="chip">{p.subcontractor_id ? "Sub" : "Team"}</span>
                      {warning && <span className="chip chip-amber"><Icon name="alert" size={12} />Paperwork</span>}
                    </span>
                    <span className="muted small" style={{ display: "block" }}>
                      {(p.subcontractor_id && offerLine(p, session.company.timezone)) || payStatusLine(p, session.company.timezone, finishedOn(visits, p.visits.map((v) => v.visit_id), session.company.timezone))}
                    </span>
                  </span>
                  <span className="tabular strong">{formatMoneyCents(p.status === "paid" ? p.paid_amount : p.total)}</span>
                  <StatusPill label={chip.label} tone={chip.tone} />
                </button>
              );
            })}
            {over.length > 0 && (
              <div className="list-foot">
                <span />
                <Button size="sm" variant="ghost" onClick={() => setShowOver(!showOver)}>
                  {showOver ? "Hide what's over" : over.every((p) => p.status === "cancelled") ? `Show ${over.length} cancelled` : `Show ${over.length} more`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {adding && (
        <AddPayDialog
          job={job}
          visits={visits}
          pays={list}
          payees={payees}
          areas={adding !== "any" ? { subs: true, team: false } : { subs: subsArea, team: teamArea }}
          elsewhere={adding !== "any" ? adding.elsewhere : undefined}
          onClose={() => setAdding(null)}
          onOpen={(id) => {
            setAdding(null);
            setOpen(id);
          }}
        />
      )}
      {openPay && (
        <PayDialog
          pay={openPay}
          job={job}
          visits={visits}
          payees={payees}
          onClose={() => setOpen(null)}
          onOfferElsewhere={() => {
            setOpen(null);
            setAdding({ elsewhere: visitsForElsewhere(openPay.visits.map((v) => v.visit_id), visits) });
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Adding pay
// ---------------------------------------------------------------------------------------------

function AddPayDialog({ job, visits, pays, payees, areas, elsewhere, onClose, onOpen }: {
  job: { id: string };
  visits: readonly JobVisit[];
  pays: readonly JobPay[];
  payees: Payees;
  areas: { subs: boolean; team: boolean };
  /** After an offer ended: new pay for another sub, to send them, for the visits that offer covered. */
  elsewhere?: readonly string[];
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"sub" | "team">(areas.subs ? "sub" : "team");
  const [payeeId, setPayeeId] = useState("");
  // Offering it to someone else, the visits the last offer covered; otherwise theirs (below).
  const startCovered = elsewhere ? [...elsewhere] : null;
  const [covered, setCovered] = useState<string[] | null>(startCovered);
  const [rates, setRates] = useState(false);
  const payee: PayeeRef = kind === "sub" ? { subcontractor_id: payeeId || null } : { user_id: payeeId || null };
  const existing = pays.find((p) => isLivePay(p.status) && (kind === "sub" ? p.subcontractor_id === payeeId : p.user_id === payeeId));
  // Until the office picks, the database covers the visits it says here (theirs, by sign-in or crew),
  // and the boxes show the same ones. The suggestion for the visits picked is asked for apart.
  const defaults = useSuggestion({ job_id: job.id, ...payee, visit_ids: null }, Boolean(payeeId) && !existing);
  const suggestion = useSuggestion({ job_id: job.id, ...payee, visit_ids: covered }, Boolean(payeeId) && !existing);
  const theyreOn = payeeId ? startingVisits(visits, defaults.data?.visit_ids) : [];
  const chosen = covered ?? theyreOn;
  const signIns = kind === "sub" ? defaults.data?.sign_ins : null;
  const peopleSettings = hasRole(session, "admin") && can(session, "team");
  const start = useMutation({
    meta: { inline: true, success: "Pay added as a draft" },
    mutationFn: () => startPay({ job_id: job.id, ...payee, visit_ids: covered }),
    onSuccess: (pay) => {
      refreshPay(queryClient, job.id);
      onOpen(pay.id);
    },
  });
  // Each sub with its paperwork, those in order first: it only warns, but it helps choose.
  const choices = kind === "sub"
    ? subChoices(payees.subs.data ?? [], payees.paperwork.data ? payees.statusesOf : null)
    : (payees.team.data ?? []).filter((m) => m.active).map((m) => ({ id: m.user_id, name: m.profile?.full_name || "Invited user" })).sort((a, b) => a.name.localeCompare(b.name));
  const loadingChoices = kind === "sub" ? payees.subs.isPending : payees.team.isPending;
  const warning = kind === "sub" && payeeId && payees.paperwork.data ? payPaperworkWarning(payees.statusesOf(payeeId), lastWorkDay(visits, chosen), todayIn(session.company.timezone)) : null;
  const shownVisits = visits.filter((v) => v.status !== "cancelled");

  return (
    <Dialog open onClose={onClose} title={elsewhere ? "Offer to someone else" : "Add pay"} size="lg" description={kind === "sub" ? "Filled in from their rates. You can change the lines before you send it or agree it." : "Filled in from their rates. You can change the lines before you agree it."}>
      <div className="dialog-body">
        {areas.subs && areas.team && (
          <div className="segmented" role="group" aria-label="Who it's for" style={{ justifySelf: "start" }}>
            <button type="button" aria-pressed={kind === "sub"} onClick={() => { setKind("sub"); setPayeeId(""); setCovered(startCovered); }}>A sub</button>
            <button type="button" aria-pressed={kind === "team"} onClick={() => { setKind("team"); setPayeeId(""); setCovered(startCovered); }}>Someone on your team</button>
          </div>
        )}
        <Field label={kind === "sub" ? "Sub" : "Team member"} hint={kind === "sub" && elsewhere ? "Subs with their paperwork in order come first. It covers the same visits as the offer that ended." : undefined}>
          {loadingChoices ? <Skeleton height={36} /> : (
            <select className="select" value={payeeId} onChange={(e) => { setPayeeId(e.target.value); setCovered(startCovered); }}>
              <option value="">{kind === "sub" ? "Choose a sub" : "Choose someone"}</option>
              {choices.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </Field>
        {kind === "sub" && !loadingChoices && choices.length === 0 && (
          <p className="muted small" style={{ margin: 0 }}>No subs yet. <Link to="/subs?new=1">Add one under Subcontractors</Link>.</p>
        )}
        {existing ? (
          <div className="callout callout-info">
            <Icon name="info" size={18} />
            <div className="grow" style={{ fontWeight: 400 }}>They already have pay on this job ({payStatusLabel(existing.status).toLowerCase()}, {formatMoneyCents(existing.total)}).</div>
            <Button size="sm" onClick={() => onOpen(existing.id)}>Open it</Button>
          </div>
        ) : payeeId ? (
          <>
            {warning && (
              <div className="callout callout-warning">
                <Icon name="alert" size={18} />
                <div className="grow small" style={{ fontWeight: 400 }}>{warning} <Link to={`/subs/${payeeId}`}>Their paperwork</Link></div>
              </div>
            )}
            <VisitPicker
              visits={shownVisits}
              covered={chosen}
              disabled={covered === null && defaults.isPending}
              onToggle={(id, on) => setCovered(on ? [...chosen, id] : chosen.filter((x) => x !== id))}
              hint={visitsHint(kind, signIns)}
            />
            <div className="stack-sm">
              <div className="row-between">
                <strong>What their rates come to</strong>
                {kind === "sub" ? <Link className="small" to={`/subs/${payeeId}`}>Their rates</Link> : <Button size="sm" variant="ghost" onClick={() => setRates(true)}>Their rates</Button>}
              </div>
              <div className="card">
                {suggestion.isPending ? (
                  <div className="card-row"><Skeleton width="60%" /></div>
                ) : suggestion.error ? (
                  <div className="card-row"><ErrorState compact error={suggestion.error} onRetry={() => suggestion.refetch()} /></div>
                ) : !suggestion.data?.lines.length ? (
                  <div className="card-row">
                    <span className="muted small">
                      No rates for them yet, so it starts with no lines: add them on the next step.{" "}
                      {kind === "sub" ? <Link to={`/subs/${payeeId}`}>Set their rates</Link> : <button type="button" className="link-btn small" onClick={() => setRates(true)}>Set their rates</button>}
                      {kind === "team" && peopleSettings && <> (they're also under <Link to="/settings?tab=team">Settings → People</Link>)</>}
                    </span>
                  </div>
                ) : (
                  <>
                    {suggestion.data.lines.map((l) => (
                      <div key={l.pay_rate_id ?? l.sort} className="card-row" style={{ alignItems: "flex-start" }}>
                        <span className="grow" style={{ minWidth: 0 }}>
                          <strong>{l.description}</strong>
                          {l.note && <span className={`small ${l.check_it ? "" : "muted"}`} style={{ display: "block", color: l.check_it ? "var(--warning)" : undefined }}>{l.check_it && <Icon name="alert" size={12} />} {l.note}</span>}
                        </span>
                        <span className="muted small tabular nowrap">{quantityWords(l.quantity, l.unit)} × {formatRate(l.rate)}</span>
                        <span className="tabular strong" style={{ minWidth: 90, textAlign: "right" }}>{formatMoneyCents(l.amount)}</span>
                      </div>
                    ))}
                    <div className="card-row"><strong className="grow">Total</strong><strong className="tabular">{formatMoneyCents(suggestion.data.total)}</strong></div>
                  </>
                )}
              </div>
            </div>
          </>
        ) : null}
        <FormError error={start.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="plus" disabled={!payeeId || Boolean(existing)} loading={start.isPending} onClick={() => start.mutate()}>Add pay</Button>
        </div>
      </div>
      {rates && kind === "team" && payeeId && <TeamRatesDialog userId={payeeId} name={payees.nameOf({ user_id: payeeId })} onClose={() => setRates(false)} />}
    </Dialog>
  );
}

/**
 * A team member's piece rates, from the pay itself: the office with Job costs sets them here, as it
 * may not reach Settings → People (an admin's). The suggestion is asked for again once they change.
 */
function TeamRatesDialog({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title={`Piece rates for ${name}`} size="lg" description="Pay per square, per job or per day. Pay on a job is filled in from these, and goes into their pay period once the work is done.">
      <div className="dialog-body">
        <RatesCard payee={{ user_id: userId }} bare />
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}

function VisitPicker({ visits, covered, onToggle, disabled, hint }: { visits: readonly JobVisit[]; covered: readonly string[]; onToggle: (id: string, on: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <div className="stack-sm">
      <strong>Visits it covers</strong>
      {visits.length === 0 ? (
        <span className="muted small">This job has no visits yet. Mark the work done yourself when it's finished.</span>
      ) : (
        <div className="card">
          {visits.map((v) => (
            <label key={v.id} className="card-row checkbox" style={{ cursor: disabled ? "default" : "pointer" }}>
              <input type="checkbox" checked={covered.includes(v.id)} disabled={disabled} onChange={(e) => onToggle(v.id, e.target.checked)} />
              <span className="grow">
                {v.title}
                <span className="muted small" style={{ display: "block" }}>{v.scheduled_on ? formatDate(v.scheduled_on) : "Not scheduled"} · {statusText("visit", v.status)}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {hint && visits.length > 0 && <span className="muted small">{hint}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One pay
// ---------------------------------------------------------------------------------------------

function PayDialog({ pay, job, visits, payees, onClose, onOfferElsewhere }: {
  pay: JobPay;
  job: { id: string; number: number | null; title: string };
  visits: readonly JobVisit[];
  payees: Payees;
  onClose: () => void;
  /** Offer the job to another sub (after an offer was turned down or ran out). */
  onOfferElsewhere: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  const today = todayIn(tz);
  const who = payeeOf(pay);
  const name = payees.nameOf(pay);
  const editable = pay.status === "draft" || pay.status === "accepted";
  const covered = pay.visits.map((v) => v.visit_id);
  const [drafts, setDrafts] = useState<Record<string, LineDraft>>({});
  const [notes, setNotes] = useState(pay.notes ?? "");
  // An offer waiting for an answer stays as it went out, its notes too.
  const waiting = pay.status === "offered";
  const [dialog, setDialog] = useState<null | "done" | "paid" | "rates" | "send" | "change">(null);
  useEffect(() => setNotes(pay.notes ?? ""), [pay.notes]);
  const suggestion = useSuggestion({ job_id: job.id, subcontractor_id: pay.subcontractor_id, user_id: pay.user_id, visit_ids: covered }, editable);
  // An offer only goes to a sub with a sign-in, so one waiting for an answer is to someone who has one.
  const signIns = who === "sub" ? (suggestion.data?.sign_ins ?? (pay.status === "offered" ? 1 : undefined)) : null;
  const refresh = () => refreshPay(queryClient, job.id);
  const change = isChangeOffer(pay);

  const updateLine = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<{ description: string; quantity: number; rate: number }> }) => unwrap(await supabase().from("job_pay_lines").update(patch).eq("id", id)),
    // The typed values stay up until the saved ones are back, so nothing flickers.
    onSuccess: async (_r, v) => {
      await refresh();
      setDrafts(({ [v.id]: _done, ...rest }) => rest);
    },
  });
  const addLine = useMutation({
    mutationFn: async () => unwrap(await supabase().from("job_pay_lines").insert({ ...newLine(pay.lines), company_id: session.company.id, job_pay_id: pay.id })),
    onSuccess: refresh,
  });
  const removeLine = useMutation({
    meta: { success: "Line removed" },
    mutationFn: async (id: string) => unwrap(await supabase().from("job_pay_lines").delete().eq("id", id)),
    onSuccess: refresh,
  });
  const toggleVisit = useMutation({
    mutationFn: async ({ id, on }: { id: string; on: boolean }) =>
      on
        ? unwrap(await supabase().from("job_pay_visits").insert({ company_id: session.company.id, job_pay_id: pay.id, visit_id: id }))
        : unwrap(await supabase().from("job_pay_visits").delete().eq("job_pay_id", pay.id).eq("visit_id", id)),
    onSuccess: refresh,
  });
  const saveNotes = useMutation({
    meta: { success: "Notes saved" },
    mutationFn: async (value: string | null) => unwrap(await supabase().from("job_pay").update({ notes: value }).eq("id", pay.id)),
    onSuccess: refresh,
  });
  const act = useMutation({
    meta: {
      inline: true,
      success: (_: unknown, a: OfferAction) =>
        a === "accept" ? (change ? `New price agreed. ${name} has been told.` : agreedToast(who, name, signIns)) : a === "cancel" ? "Pay cancelled" : a === "unpaid" ? "Paid mark taken back" : a === "delete" ? "Pay deleted" : a === "withdraw" ? withdrawnToast(name) : "Saved",
    },
    mutationFn: async (a: OfferAction) => {
      if (a === "accept") return acceptPay(pay.id);
      if (a === "withdraw") return withdrawOffer(pay.id);
      if (a === "cancel") return cancelPay(pay.id);
      if (a === "unpaid") return unmarkPaid([pay.id]);
      if (a === "delete") return deletePay(pay.id);
    },
    onSuccess: (_r, a) => {
      refresh();
      if (a === "delete") onClose();
    },
  });

  const run = async (a: OfferAction) => {
    if (a === "done") return setDialog("done");
    if (a === "paid") return setDialog("paid");
    if (a === "send") return setDialog("send");
    if (a === "change") return setDialog("change");
    if (a === "other") return onOfferElsewhere();
    if (a === "withdraw" && !(await confirm(withdrawConfirm(pay, name)))) return;
    // Agreeing a new price for them sets it without their answer: asked first, and they're told.
    if (a === "accept" && change && !(await confirm(agreeChangeConfirm(pay, name)))) return;
    if (a === "cancel") {
      const body = who === "sub" && ["accepted", "done"].includes(pay.status) ? `${name} comes off the visits it put them on that aren't done yet. It stays on the job as cancelled.` : "It stays on the job as cancelled.";
      if (!(await confirm({ title: "Cancel this pay?", body, confirmLabel: "Cancel pay", cancelLabel: "Keep it", danger: true }))) return;
    }
    if (a === "delete" && !(await confirm({ title: "Delete this pay?", body: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    if (a === "unpaid" && !(await confirm({ title: "Take back the paid mark?", body: "It goes back to owed. Nothing is paid or refunded.", confirmLabel: "Take it back" }))) return;
    act.mutate(a);
  };

  const actions: OfferAction[] = who === "sub" ? offerActions(pay, signIns) : payActions(pay.status, who);
  const label = (a: OfferAction) =>
    a === "send" || a === "withdraw" || a === "change" || a === "other" ? offerActionLabel(a, pay) : a === "accept" && change ? AGREE_CHANGE_LABEL : actionLabel(a, who, signIns);
  // Sent as an offer, agreeing stands for "they said yes on the phone", so it isn't the main button.
  const sends = actions.includes("send") || actions.includes("withdraw");
  const primary = actions.filter((a) => a === "send" || a === "done" || a === "paid" || a === "other" || (a === "accept" && !sends));
  const secondary = actions.filter((a) => a === "change" || (a === "accept" && sends));
  const lastDay = lastWorkDay(visits, covered);
  const insurance = who === "sub" && pay.subcontractor_id ? payees.insuranceOf(pay.subcontractor_id, lastDay) : [];
  const recorded = insuranceWarningItems(pay.insurance_warning);
  const chip = offerChip(pay, who);
  const offerNote = who === "sub" ? offerLine(pay, tz) : null;
  const total = linesTotal(pay.lines, drafts);
  const warning = who === "sub" && pay.subcontractor_id && warnsPaperwork(pay.status, payees.subActive(pay.subcontractor_id)) && payees.paperwork.data
    ? payPaperworkWarning(payees.statusesOf(pay.subcontractor_id), lastDay, today)
    : null;
  const shownVisits = visits.filter((v) => v.status !== "cancelled" || covered.includes(v.id));
  const lastDone = visits.filter((v) => covered.includes(v.id) && v.completed_at).map((v) => dateIn(v.completed_at!, tz)).sort().at(-1) ?? null;

  return (
    <Dialog open onClose={onClose} title={name} size="lg" description={`Job #${job.number} · ${job.title}`}>
      <div className="dialog-body">
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <StatusPill label={chip.label} tone={chip.tone} />
          <span className="chip">{who === "sub" ? "Sub" : "Team"}</span>
          <span className="muted small grow">{offerNote ?? payStatusLine(pay, tz, finishedOn(visits, covered, tz))}</span>
          {who === "sub" && pay.subcontractor_id && <Link className="small" to={`/subs/${pay.subcontractor_id}`}>Their page</Link>}
        </div>
        {warning && (
          <div className="callout callout-warning">
            <Icon name="alert" size={18} />
            <div className="grow small" style={{ fontWeight: 400 }}>{warning}</div>
          </div>
        )}
        {cutShortNote(pay, visits) && (
          <div className="callout callout-info">
            <Icon name="info" size={18} />
            <div className="grow small" style={{ fontWeight: 400 }}>{cutShortNote(pay, visits)}</div>
          </div>
        )}
        {pay.status === "offered" && recorded.length > 0 && (
          <span className="muted small">Noted on the offer when it went out: {recorded.map((i) => insuranceWarningText(i, "office")).join(" ")}</span>
        )}

        <div className="stack-sm">
          <div className="row-between">
            <strong>Lines</strong>
            {who === "team" && editable && pay.user_id && <Button size="sm" variant="ghost" onClick={() => setDialog("rates")}>Their rates</Button>}
          </div>
          <div className="card">
            {pay.lines.length === 0 && <div className="card-row"><span className="muted small">No lines yet.{editable ? " Add what they're paid for." : ""}</span></div>}
            {pay.lines.map((l) => (
              <LineRow
                key={l.id}
                line={l}
                editable={editable}
                draft={drafts[l.id]}
                note={lineNote(l, suggestion.data?.lines)}
                saving={updateLine.isPending && updateLine.variables?.id === l.id}
                onDraft={(d) => setDrafts((all) => ({ ...all, [l.id]: d }))}
                onSave={(patch) => updateLine.mutate({ id: l.id, patch })}
                onRemove={() => removeLine.mutate(l.id)}
              />
            ))}
            <div className="card-row">
              {editable && <Button size="sm" variant="ghost" icon="plus" loading={addLine.isPending} onClick={() => addLine.mutate()}>Add a line</Button>}
              <strong className="grow" style={{ textAlign: "right" }}>Total</strong>
              <strong className="tabular" style={{ minWidth: 90, textAlign: "right" }}>{formatMoneyCents(total)}</strong>
            </div>
          </div>
          {who === "sub" && pay.status === "accepted" && (signIns ?? 0) > 0 && pay.lines.length > 0 && (
            <span className="muted small">Changing these lines here counts as agreed with them, say on the phone. To ask them first, use Change the price.</span>
          )}
          <FormError error={updateLine.error ?? addLine.error ?? removeLine.error} />
        </div>

        <VisitPicker
          visits={shownVisits}
          covered={covered}
          disabled={!editable || toggleVisit.isPending}
          onToggle={(id, on) => toggleVisit.mutate({ id, on })}
          hint={editable ? visitsHint(who, signIns, pay.status === "accepted") : undefined}
        />
        <FormError error={toggleVisit.error} />

        <Field label={who === "sub" ? "Notes for them" : "Notes"} optional hint={who === "sub" ? (waiting ? "They see these with the offer. Withdraw it to change them." : "They see these with the offer and their price.") : undefined}>
          <textarea className="textarea" rows={2} maxLength={2000} value={notes} disabled={waiting} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes.trim() !== (pay.notes ?? "") && saveNotes.mutate(notes.trim() || null)} />
        </Field>

        {who === "sub" && pay.status === "draft" && signIns === 0 && (
          <span className="muted small">They don't sign in, so there's no offer to send them. Agree it with them on the phone and press Agree, or give them a sign-in on <Link to={`/subs/${pay.subcontractor_id}`}>their page</Link>.</span>
        )}
        <FormError error={act.error ?? saveNotes.error} />
        <div className="form-actions" style={{ flexWrap: "wrap" }}>
          {actions.filter((a) => a === "cancel" || a === "delete" || a === "unpaid" || a === "withdraw").map((a) => (
            <Button key={a} variant={a === "unpaid" ? "secondary" : "danger"} loading={act.isPending && act.variables === a} onClick={() => run(a)}>{label(a)}</Button>
          ))}
          <span className="grow" />
          <Button onClick={onClose}>Close</Button>
          {secondary.map((a) => (
            <Button key={a} icon={a === "change" ? "edit" : "check"} loading={act.isPending && act.variables === a} disabled={a === "accept" && pay.lines.length === 0} onClick={() => run(a)}>{label(a)}</Button>
          ))}
          {primary.map((a) => (
            <Button key={a} variant="primary" icon={a === "send" ? "send" : a === "other" ? "users" : a === "paid" ? "dollar" : "check"} loading={act.isPending && act.variables === a} disabled={(a === "accept" || a === "send") && pay.lines.length === 0} onClick={() => run(a)}>{label(a)}</Button>
          ))}
        </div>
      </div>
      {dialog === "done" && <DoneDialog pay={pay} suggested={lastDone ?? today} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "rates" && pay.user_id && <TeamRatesDialog userId={pay.user_id} name={name} onClose={() => setDialog(null)} />}
      {dialog === "send" && (
        <SendOfferDialog
          pay={pay}
          name={name}
          jobTitle={job.title}
          dates={visits.filter((v) => covered.includes(v.id) && v.status !== "cancelled").map((v) => v.scheduled_on)}
          warning={insurance}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "change" && <ChangePriceDialog pay={pay} name={name} warning={insurance} onClose={() => setDialog(null)} />}
      {dialog === "paid" && <MarkPaidDialog pays={[{ id: pay.id, total: pay.total, label: `${name}, job #${job.number}` } satisfies ToPay]} onClose={() => setDialog(null)} />}
    </Dialog>
  );
}

/** One line: description, quantity × rate and the amount. Each field saves when it loses focus. */
function LineRow({ line, editable, draft, note, saving, onDraft, onSave, onRemove }: {
  line: PayLine;
  editable: boolean;
  draft: LineDraft | undefined;
  note: { text: string; check: boolean } | null;
  saving: boolean;
  onDraft: (d: LineDraft) => void;
  onSave: (patch: Partial<{ description: string; quantity: number; rate: number }>) => void;
  onRemove: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const d = draft ?? draftOf(line);
  const commit = () => {
    if (!draft) return;
    const change = lineChange(line, draft);
    setProblem(change.problem);
    if (change.patch && Object.keys(change.patch).length) onSave(change.patch);
  };
  const amount = draft ? draftAmount(draft) : Number(line.amount);
  const unit = line.basis === "per_unit" ? line.unit : line.basis === "per_day" ? "day" : "job";
  const noteLine = note && <span className="small" style={{ display: "block", color: note.check ? "var(--warning)" : "var(--text-3)" }}>{note.check && <Icon name="alert" size={12} />} {note.text}</span>;
  if (!editable) {
    return (
      <div className="card-row" style={{ alignItems: "flex-start" }}>
        <span className="grow" style={{ minWidth: 0 }}><strong>{line.description}</strong>{noteLine}</span>
        <span className="muted small tabular nowrap">{quantityWords(line.quantity, unit)} × {formatRate(line.rate)}</span>
        <span className="tabular strong" style={{ minWidth: 90, textAlign: "right" }}>{formatMoneyCents(Number(line.amount))}</span>
      </div>
    );
  }
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  return (
    <div className="card-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && commit()}>
      <span className="grow stack-sm" style={{ minWidth: 200, gap: 4 }}>
        <input className="input input-sm" value={d.description} maxLength={200} aria-label="Description" onChange={(e) => onDraft({ ...d, description: e.target.value })} onKeyDown={onKey} />
        {noteLine}
        {problem && <span className="field-error" role="alert">{problem}</span>}
      </span>
      {/* On a phone the quantity and rate share a line, and the amount and Remove go on the next. */}
      <span className="row" style={{ gap: 6, flexWrap: "wrap", flex: "1 1 260px", justifyContent: "flex-end", minWidth: 0 }}>
        <input className="input input-sm tabular" style={{ flex: "1 1 64px", maxWidth: 96, minWidth: 0, textAlign: "right" }} inputMode="decimal" value={d.quantity} aria-label={`Quantity for ${line.description}`} aria-invalid={problem?.includes("quantity") || undefined} onChange={(e) => onDraft({ ...d, quantity: e.target.value.replace(/[^0-9.]/g, "") })} onKeyDown={onKey} />
        <span className="muted small">{quantityWords(Number(d.quantity) || 0, unit).replace(/^[\d.,]+ /, "")} ×</span>
        <span className="input-group" style={{ flex: "1 1 88px", maxWidth: 120, minWidth: 0 }}>
          <span className="addon">$</span>
          <input className="input input-sm tabular" style={{ textAlign: "right", paddingLeft: 22 }} inputMode="decimal" value={d.rate} aria-label={`Rate for ${line.description}`} aria-invalid={problem?.includes("rate") || undefined} onChange={(e) => onDraft({ ...d, rate: e.target.value.replace(/[^0-9.]/g, "") })} onKeyDown={onKey} />
        </span>
        <span className="row" style={{ gap: 6, marginLeft: "auto" }}>
          <span className="tabular strong" style={{ minWidth: 80, textAlign: "right" }}>{saving ? <Skeleton width={60} /> : amount === null ? "—" : formatMoneyCents(amount)}</span>
          <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${line.description}`} onClick={onRemove} />
        </span>
      </span>
    </div>
  );
}

/** Mark work done: on the day it finished (the last visit's, or today), never later than today. */
function DoneDialog({ pay, suggested, onClose, onSaved }: { pay: JobPay; suggested: string; onClose: () => void; onSaved: () => void }) {
  const session = useSession();
  const today = todayIn(session.company.timezone);
  const [day, setDay] = useState(suggested > today ? today : suggested);
  const save = useMutation({
    meta: { inline: true, success: "Work marked done" },
    mutationFn: () => markPayDone(pay.id, day),
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  const team = !pay.subcontractor_id;
  return (
    <Dialog open onClose={onClose} title="Mark work done" size="sm" description={team ? "It goes into their pay period for that day." : "It's then owed, until you mark it paid."}>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Work finished on"><input className="input" type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} required /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={save.isPending}>Mark work done</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Whether the person handles any job pay: a sub's (the subs area) or a team member's (job costs). */
export const seesJobPay = (session: Parameters<typeof handlesSubPay>[0]) => handlesSubPay(session) || handlesTeamPay(session);
