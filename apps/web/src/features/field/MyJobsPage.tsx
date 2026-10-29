/**
 * A sub's My jobs, in the field app (/field/jobs, and /field/jobs/<pay id>, where offers' texts and
 * notifications link): job offers waiting for their answer at the top, taken in one tap or turned
 * down with a reason if they like; then the work they've taken that's coming up, what's done and
 * owed, what's been paid with this year's total, and offers that are over. Before they take a job
 * they see only its town, its days, the work and their own price (public.my_sub_offers()); once they
 * have, it's on My day with the address. An answer needs signal: it never waits on the phone.
 */
import type { SubOffer, SubOfferLine } from "@crewtavo/core/subOffers";
import { moneyShort, offerDate, offerDays, offerOutcomeLabel } from "@crewtavo/core/subOffers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { ApiError } from "@/lib/errors";
import { dateIn, formatDate, formatDateTime, formatMoneyCents, formatTime } from "@/lib/format";
import { isSub, useSession, type SubLogin } from "@/lib/session";
import { toast } from "@/lib/toast";
import { formatRate, quantityWords } from "../subs/pay";
import { answeredToast, answerState, missingOfferNote, myJobSections, offerCardLine, paidTotalNote, totalsWords } from "./myJobs";
import { answerOffer, useMyJobs, useMyPayTotals, useOfferCompany } from "./myJobsData";
import { useSignal } from "./OfflineNote";

export function MyJobsPage() {
  const session = useSession();
  useDocumentTitle("My jobs");
  if (!isSub(session) || !session.subcontractor) return <NoAccess title="My jobs" />;
  return <MyJobs sub={session.subcontractor} />;
}

function MyJobs({ sub }: { sub: SubLogin }) {
  const session = useSession();
  const { company } = session;
  const { payId } = useParams();
  const tz = company.timezone;
  const jobs = useMyJobs(session);
  const totals = useMyPayTotals(session);
  const online = useSignal();
  const sections = myJobSections(jobs.data ?? []);
  const words = totalsWords(totals.data);
  const listed = Object.values(sections).flat();
  const linked = payId ? listed.find((o) => o.id === payId) : undefined;
  const anything = listed.length > 0;
  // A link to an offer that isn't here may be from another company they work for.
  const otherCompanies = session.companies.filter((m) => m.role === "subcontractor" && m.company.id !== company.id);
  const where = useOfferCompany(payId, Boolean(jobs.data) && !linked && otherCompanies.length > 0);
  const missing = payId && jobs.data && !linked && !where.isFetching
    ? missingOfferNote(otherCompanies.find((m) => m.company.id === where.data)?.company ?? null, company.id)
    : null;

  // A text or notification opens the offer: scroll to it once it's in (after the new screen has
  // started at the top), at once with Reduce Motion.
  useEffect(() => {
    if (!payId || !linked) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    const t = setTimeout(() => document.getElementById(`job-${payId}`)?.scrollIntoView({ block: "start", behavior }), 50);
    return () => clearTimeout(t);
  }, [payId, Boolean(linked)]);

  return (
    <div className="field-app">
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>{sub.name}</div>
        <h1 className="page-title" style={{ marginTop: 4 }}>My jobs</h1>
      </div>
      {!online && (
        <div className="callout callout-info" role="status">
          <Icon name="wifiOff" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            <div>No signal</div>
            This is what you had when you last had signal. Accepting or declining a job needs signal, so it reaches the office right away.
          </div>
        </div>
      )}

      {jobs.isPending && <Loading label="Loading your jobs"><div className="stack">{[0, 1].map((i) => <CardSkeleton key={i} lines={3} />)}</div></Loading>}
      {jobs.error && !jobs.data && <div className="card"><ErrorState error={jobs.error} onRetry={() => jobs.refetch()} /></div>}
      {missing && (
        <div className="callout callout-info" role="status">
          <Icon name="info" size={20} />
          <div className="grow" style={{ fontWeight: 400 }}>{missing.text}</div>
          {missing.switchTo && <Button onClick={() => session.switchCompany(missing.switchTo!)}>Switch to it</Button>}
        </div>
      )}

      {jobs.data && !anything && (
        <div className="card">
          <EmptyState icon="job" title="No jobs yet">When {company.name} offers you a job, it shows here, and you'll get a notification. Accept or decline it in one tap.</EmptyState>
        </div>
      )}

      {sections.waiting.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Waiting for your answer</h2>
          <div className="stack">
            {sections.waiting.map((o) => <OfferCard key={o.id} offer={o} focused={o.id === payId} />)}
          </div>
        </section>
      )}

      {sections.upcoming.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Coming up</h2>
          <div className="card">
            {sections.upcoming.map((o) => {
              const next = o.visits.find((v) => v.status !== "completed") ?? o.visits[0];
              const row = (
                <>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <strong>{o.job_title}</strong>
                    <span className="muted small" style={{ display: "block" }}>{[visitDays(o), o.city].filter(Boolean).join(" · ")}</span>
                    {o.notes && <span className="small pre-wrap" style={{ display: "block", marginTop: 2 }}>{o.notes}</span>}
                  </span>
                  <span className="tabular strong">{formatMoneyCents(Number(o.is_change ? o.agreed_total : o.total))}</span>
                  {next && <Icon name="chevronRight" size={16} />}
                </>
              );
              return next ? (
                <Link key={o.id} id={`job-${o.id}`} to={`/field/visits/${next.id}`} className="card-row" style={focusStyle(o.id === payId)}>{row}</Link>
              ) : (
                <div key={o.id} id={`job-${o.id}`} className="card-row" style={focusStyle(o.id === payId)}>{row}</div>
              );
            })}
          </div>
        </section>
      )}

      {sections.done.length > 0 && (
        <section className="stack-sm">
          <div className="section-head">
            <h2 className="section-title">Done, waiting to be paid</h2>
            {words.owed && <span className="muted small tabular">{words.owed}</span>}
          </div>
          <div className="card">
            {sections.done.map((o) => (
              <div key={o.id} id={`job-${o.id}`} className="card-row" style={focusStyle(o.id === payId)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{o.job_title}</strong>
                  <span className="muted small" style={{ display: "block" }}>{o.earned_on ? `Done ${formatDate(o.earned_on)}` : "Done"}</span>
                </span>
                <span className="tabular strong">{formatMoneyCents(Number(o.total))}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(sections.paid.length > 0 || (totals.data?.payments ?? 0) > 0) && (
        <section className="stack-sm">
          <div className="section-head">
            <h2 className="section-title">Paid</h2>
            {words.paid && <span className="muted small tabular">{words.paid}</span>}
          </div>
          <div className="card">
            {sections.paid.map((o) => (
              <div key={o.id} id={`job-${o.id}`} className="card-row" style={focusStyle(o.id === payId)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{o.job_title}</strong>
                  <span className="muted small" style={{ display: "block" }}>{o.paid_at ? `Paid ${formatDate(dateIn(o.paid_at, tz))}` : "Paid"}</span>
                </span>
                <span className="tabular strong">{formatMoneyCents(Number(o.paid_amount ?? o.total))}</span>
              </div>
            ))}
          </div>
          <span className="muted small">{paidTotalNote(totals.data, company.name)}</span>
        </section>
      )}

      {sections.over.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">Offers that are over</h2>
          <div className="card">
            {sections.over.map((o) => (
              <div key={o.id} id={`job-${o.id}`} className="card-row" style={focusStyle(o.id === payId)}>
                <span className="grow" style={{ minWidth: 0 }}>
                  <strong>{o.job_title}</strong>
                  <span className="muted small" style={{ display: "block" }}>{[visitDays(o), o.city, moneyShort(o.total)].filter(Boolean).join(" · ")}</span>
                </span>
                <StatusPill label={o.status === "offered" ? offerOutcomeLabel("expired", "sub") : offerOutcomeLabel(o.outcome ?? o.status, "sub") || "Over"} tone="muted" />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const focusStyle = (focused: boolean) => (focused ? { boxShadow: "var(--ring)", scrollMarginTop: 80 } : { scrollMarginTop: 80 });

const visitDays = (o: Pick<SubOffer, "visits">) => offerDays(o.visits.map((v) => v.scheduled_on));

/** An offer waiting for their answer: what it is, where (the town), when, the work, their price, and Accept or Decline. */
function OfferCard({ offer: o, focused }: { offer: SubOffer; focused: boolean }) {
  const { company } = useSession();
  const tz = company.timezone;
  const queryClient = useQueryClient();
  const online = useSignal();
  const [declining, setDeclining] = useState(false);
  const state = answerState(online, o);
  const send = useMutation({
    // An answer goes now or not at all: it isn't kept on the phone for later.
    networkMode: "always",
    meta: { inline: true, success: (_r: unknown, v: { accept: boolean }) => answeredToast(v.accept, o) },
    mutationFn: (v: { accept: boolean; reason?: string | null }) => answerOffer(o.id, { ...v, round: o.offer_round }),
    onSuccess: () => setDeclining(false),
    // Answered already, run out, taken back or changed: the card may go as the list refreshes, so
    // the reason is said where it stays too.
    onError: (error) => error instanceof ApiError && error.status === 409 && toast.info(error.message),
    onSettled: () => {
      // Taken, it's on My day (and the visit); either way the list is fresh, a refused answer included.
      queryClient.invalidateQueries({ queryKey: ["field-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["field"] });
      queryClient.invalidateQueries({ queryKey: ["field-visit"] });
    },
  });

  return (
    // Named by its job, so its Accept and Decline are told apart from another offer's.
    <article id={`job-${o.id}`} className="field-card" style={focusStyle(focused)} aria-labelledby={`job-${o.id}-title`}>
      <div className="row wrap" style={{ gap: 6 }}>
        <StatusPill label={o.is_change ? "New price" : "New job offer"} tone="info" />
        <span className="chip">{o.respond_by ? `Answer by ${formatDateTime(o.respond_by, tz)}` : "No deadline"}</span>
      </div>
      <strong id={`job-${o.id}-title`} style={{ fontSize: 16 }}>{offerCardLine(o)}</strong>
      {o.is_change && o.agreed_total != null && (
        <span className="small">The office changed the price: {moneyShort(o.total)}, was {moneyShort(o.agreed_total)}. If you decline it, you keep the job at {moneyShort(o.agreed_total)}.</span>
      )}

      <div className="stack-sm" style={{ gap: 4 }}>
        <strong className="small">When</strong>
        {o.visits.length === 0 ? (
          <span className="muted small">The office will set the days.</span>
        ) : (
          o.visits.map((v) => (
            <span key={v.id} className="small">
              {v.scheduled_on ? offerDate(v.scheduled_on) : "Not scheduled yet"}
              {v.starts_at && `, ${formatTime(v.starts_at, tz)}${v.ends_at ? ` to ${formatTime(v.ends_at, tz)}` : ""}`}
            </span>
          ))
        )}
        {o.city || o.region ? <span className="muted small">In {[o.city, o.region].filter(Boolean).join(", ")}. You'll see the address once you take it.</span> : null}
      </div>

      {o.scope.length > 0 && (
        <div className="stack-sm" style={{ gap: 4 }}>
          <strong className="small">The work</strong>
          {o.scope.map((s, i) => (
            <span key={i} className="small">
              {s.name}
              {Number(s.quantity) > 0 && <span className="muted"> · {quantityWords(s.quantity, s.unit)}</span>}
            </span>
          ))}
        </div>
      )}

      {o.notes && (
        <div className="stack-sm" style={{ gap: 4 }}>
          <strong className="small">Notes from the office</strong>
          <span className="small pre-wrap">{o.notes}</span>
        </div>
      )}

      <div className="stack-sm" style={{ gap: 4 }}>
        <strong className="small">Your price</strong>
        {o.lines.map((l, i) => <PriceLine key={l.id ?? i} line={l} />)}
        <div className="row-between"><strong>Total</strong><strong className="tabular">{formatMoneyCents(Number(o.total))}</strong></div>
      </div>

      {o.insurance_warning.length > 0 && (
        <div className="callout callout-warning">
          <Icon name="alert" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            {o.insurance_warning.join(" ")} <Link to="/field/paperwork">My paperwork</Link>
          </div>
        </div>
      )}

      {state.note && <span className="small" style={{ color: "var(--warning)", fontWeight: 600 }}><Icon name={online ? "clock" : "wifiOff"} size={14} /> {state.note}</span>}
      {!declining && <FormError error={send.error} />}
      <div className="field-card-more">
        <Button className="big-action" icon="x" aria-label={`Decline ${o.job_title}`} disabled={state.disabled || send.isPending} onClick={() => { send.reset(); setDeclining(true); }}>Decline</Button>
        <Button className="big-action" variant="primary" icon="check" aria-label={`Accept ${o.job_title}`} disabled={state.disabled} loading={send.isPending && send.variables?.accept === true} onClick={() => send.mutate({ accept: true })}>
          Accept
        </Button>
      </div>

      {declining && (
        <DeclineDialog
          offer={o}
          disabled={state.disabled}
          note={state.note}
          sending={send.isPending}
          error={send.error}
          onClose={() => setDeclining(false)}
          onDecline={(reason) => send.mutate({ accept: false, reason })}
        />
      )}
    </article>
  );
}

function PriceLine({ line: l }: { line: SubOfferLine }) {
  return (
    <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
      <span className="grow small">
        {l.description}
        {l.basis !== "per_job" && <span className="muted" style={{ display: "block" }}>{quantityWords(l.quantity, l.basis === "per_day" ? "day" : l.unit)} × {formatRate(l.rate)}</span>}
      </span>
      <span className="tabular small">{formatMoneyCents(Number(l.amount))}</span>
    </div>
  );
}

/** Turning one down: asked once, with a reason if they'd like to give one. */
function DeclineDialog({ offer: o, disabled, note, sending, error, onClose, onDecline }: {
  offer: SubOffer;
  disabled: boolean;
  note: string | null;
  sending: boolean;
  error: unknown;
  onClose: () => void;
  onDecline: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={o.is_change ? "Decline the new price?" : "Decline this job?"}
      description={o.is_change ? `You keep ${o.job_title} at ${moneyShort(o.agreed_total)}, the price you agreed.` : `${o.job_title} goes back to the office, and they can offer it to someone else.`}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) onDecline(reason.trim() || null);
        }}
      >
        <Field label="Why" optional hint="The office sees this.">
          <textarea className="textarea" rows={2} maxLength={500} value={reason} placeholder="Booked that week" onChange={(e) => setReason(e.target.value)} />
        </Field>
        {note && <span className="small" role="status" style={{ color: "var(--warning)", fontWeight: 600 }}>{note}</span>}
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={sending}>Keep it</Button>
          <Button type="submit" variant="danger" icon="x" disabled={disabled} loading={sending}>Decline</Button>
        </div>
      </form>
    </Dialog>
  );
}
