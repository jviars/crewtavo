/**
 * A sub's My jobs, in the field app (/field/jobs, and /field/jobs/<pay id>, where offers' texts and
 * notifications link): job offers waiting for their answer at the top, taken in one tap or turned
 * down with a reason if they like; then the work they've taken that's coming up, what's done and
 * owed, what's been paid with this year's total, and offers that are over. Before they take a job
 * they see only its town, its days, the work and their own price (public.my_sub_offers()); once they
 * have, it's on My day with the address. An answer needs signal: it never waits on the phone.
 */
import type { SubOffer } from "@crewtavo/core/subOffers";
import { moneyShort, offerDate, offerDays, offerOutcomeLabel } from "@crewtavo/core/subOffers";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { ApiError } from "@/lib/errors";
import { dateIn, formatDate, formatDateTime, formatMoneyCents, formatTime } from "@/lib/format";
import { isSub, useSession, type SubLogin } from "@/lib/session";
import { toast } from "@/lib/toast";
import { quantityWords } from "../subs/pay";
import { answeredToast, answerState, missingOfferNote, myJobSections, offerCardLine, paidTotalNote, totalsWords } from "./myJobs";
import { answerOffer, useMyJobs, useMyPayTotals, useOfferCompany } from "./myJobsData";
import { useSignal } from "./OfflineNote";
import { FieldHeader } from "./fieldUi";
import { PriceLines } from "./YourPrice";
import { translateError } from "@crewtavo/core/i18n/patterns";
import { getLocale, t } from "@/lib/i18n";

export function MyJobsPage() {
  const session = useSession();
  useDocumentTitle(t("My jobs"));
  if (!isSub(session) || !session.subcontractor) return <NoAccess title={t("My jobs")} />;
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
    <div className="field-app m-grouped field-narrow">
      <FieldHeader kicker={sub.name} title={t("My jobs")} />
      {!online && (
        <div className="callout callout-info" role="status">
          <Icon name="wifiOff" size={16} />
          <div className="grow">
            <div>{t("No signal")}</div>
            {t("This is what you had when you last had signal. Accepting or declining a job needs signal, so it reaches the office right away.")}
          </div>
        </div>
      )}

      {jobs.isPending && <Loading label={t("Loading your jobs")}><SectionSkeleton rows={3} /></Loading>}
      {jobs.error && !jobs.data && <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />}
      {missing && (
        <div className="callout callout-info" role="status">
          <Icon name="info" size={16} />
          <div className="grow">{missing.text}</div>
          {missing.switchTo && <Button onClick={() => session.switchCompany(missing.switchTo!)}>{t("Switch to it")}</Button>}
        </div>
      )}

      {jobs.data && !anything && (
        <EmptyState icon="job" title={t("No jobs yet")}>{t("When {company} offers you a job, it shows here, and you'll get a notification. Accept or decline it in one tap.", { company: company.name })}</EmptyState>
      )}

      {sections.waiting.length > 0 && (
        <Section title={t("Waiting for your answer")} count={sections.waiting.length} flush>
          <div className="offer-list">
            {sections.waiting.map((o) => <OfferCard key={o.id} offer={o} focused={o.id === payId} />)}
          </div>
        </Section>
      )}

      {sections.upcoming.length > 0 && (
        <Section title={t("Coming up")} count={sections.upcoming.length}>
          <RelatedList>
            {sections.upcoming.map((o) => {
              const next = o.visits.find((v) => v.status !== "completed") ?? o.visits[0];
              return (
                <RelatedRow
                  key={o.id}
                  to={next ? `/field/visits/${next.id}` : undefined}
                  current={o.id === payId}
                  title={<span id={`job-${o.id}`} className="job-anchor">{o.job_title}</span>}
                  sub={[visitDays(o), o.city, o.notes && <span key="notes" className="meta-break pre-wrap">{o.notes}</span>]}
                  end={<b>{formatMoneyCents(Number(o.is_change ? o.agreed_total : o.total))}</b>}
                />
              );
            })}
          </RelatedList>
        </Section>
      )}

      {sections.done.length > 0 && (
        <Section title={t("Done, waiting to be paid")} count={words.owed ?? sections.done.length}>
          <RelatedList>
            {sections.done.map((o) => (
              <RelatedRow
                key={o.id}
                current={o.id === payId}
                title={<span id={`job-${o.id}`} className="job-anchor">{o.job_title}</span>}
                sub={o.earned_on ? t("Done {date}", { date: formatDate(o.earned_on) }) : t("Done")}
                end={<b>{formatMoneyCents(Number(o.total))}</b>}
              />
            ))}
          </RelatedList>
        </Section>
      )}

      {(sections.paid.length > 0 || (totals.data?.payments ?? 0) > 0) && (
        <Section title={t("Paid")} count={words.paid ?? (sections.paid.length || undefined)}>
          {sections.paid.length > 0 && (
            <RelatedList>
              {sections.paid.map((o) => (
                <RelatedRow
                  key={o.id}
                  current={o.id === payId}
                  title={<span id={`job-${o.id}`} className="job-anchor">{o.job_title}</span>}
                  sub={o.paid_at ? t("Paid {date}", { date: formatDate(dateIn(o.paid_at, tz)) }) : t("Paid")}
                  end={<b>{formatMoneyCents(Number(o.paid_amount ?? o.total))}</b>}
                />
              ))}
            </RelatedList>
          )}
          <p className="field-hint">{paidTotalNote(totals.data, company.name)}</p>
        </Section>
      )}

      {sections.over.length > 0 && (
        <Section title={t("Offers that are over")} count={sections.over.length}>
          <RelatedList>
            {sections.over.map((o) => (
              <RelatedRow
                key={o.id}
                current={o.id === payId}
                title={<span id={`job-${o.id}`} className="job-anchor">{o.job_title}</span>}
                sub={[<StatusPill key="status" label={o.status === "offered" ? t(offerOutcomeLabel("expired", "sub")) : t(offerOutcomeLabel(o.outcome ?? o.status, "sub")) || t("Over")} tone="muted" />, visitDays(o), o.city, moneyShort(o.total)]}
              />
            ))}
          </RelatedList>
        </Section>
      )}
    </div>
  );
}

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
  const place = [o.city, o.region].filter(Boolean).join(", ");

  return (
    // Named by its job, so its Accept and Decline are told apart from another offer's.
    <article id={`job-${o.id}`} className="offer-card" data-focused={focused || undefined} aria-labelledby={`job-${o.id}-title`}>
      <div className="offer-top">
        <StatusPill label={o.is_change ? t("New price") : t("New job offer")} tone="info" />
        <span className="offer-by">{o.respond_by ? t("Answer by {when}", { when: formatDateTime(o.respond_by, tz) }) : t("No deadline")}</span>
      </div>
      {/* The job, then the glance: its days, the town, how much and the price (the same line without its title). */}
      <div className="offer-head">
        <h3 id={`job-${o.id}-title`} className="offer-title">{o.job_title}</h3>
        <p className="offer-sum">{offerCardLine({ ...o, job_title: "" })}</p>
      </div>
      {o.is_change && o.agreed_total != null && (
        <p className="offer-note">{t("The office changed the price: {price}, was {was}. If you decline it, you keep the job at {was}.", { price: moneyShort(o.total), was: moneyShort(o.agreed_total) })}</p>
      )}

      <Facts>
        <Fact label={t("When")} wide>
          {o.visits.length === 0 ? (
            <span className="offer-quiet">{t("The office will set the days.")}</span>
          ) : (
            o.visits.map((v) => (
              <span key={v.id} className="offer-day">
                {v.scheduled_on ? offerDate(v.scheduled_on) : t("Not scheduled yet")}
                {v.starts_at && <>, {v.ends_at ? t("{start} to {end}", { start: formatTime(v.starts_at, tz), end: formatTime(v.ends_at, tz) }) : formatTime(v.starts_at, tz)}</>}
              </span>
            ))
          )}
          {place ? <span className="offer-quiet">{t("In {place}. You'll see the address once you take it.", { place })}</span> : null}
        </Fact>
        {o.scope.length > 0 && (
          <Fact label={t("The work")} wide>
            {o.scope.map((s, i) => (
              <span key={i} className="offer-day">
                {s.name}
                {Number(s.quantity) > 0 && <span className="offer-quiet"> · {quantityWords(s.quantity, s.unit)}</span>}
              </span>
            ))}
          </Fact>
        )}
        <Fact label={t("Notes from the office")} wide>{o.notes && <span className="pre-wrap">{o.notes}</span>}</Fact>
      </Facts>

      <div className="offer-price">
        <h4 className="offer-price-title">{t("Your price")}</h4>
        <PriceLines lines={o.lines} total={Number(o.total)} />
      </div>

      {o.insurance_warning.length > 0 && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">
            {o.insurance_warning.map((w) => translateError(getLocale(), w)).join(" ")} <Link to="/field/paperwork">{t("My paperwork")}</Link>
          </div>
        </div>
      )}

      {state.note && <p className="offer-wait"><Icon name={online ? "clock" : "wifiOff"} size={14} /> {state.note}</p>}
      {!declining && <FormError error={send.error} />}
      <div className="offer-acts">
        <Button aria-label={t("Decline {job}", { job: o.job_title })} disabled={state.disabled || send.isPending} onClick={() => { send.reset(); setDeclining(true); }}>{t("Decline")}</Button>
        <Button variant="primary" icon="check" aria-label={t("Accept {job}", { job: o.job_title })} disabled={state.disabled} loading={send.isPending && send.variables?.accept === true} onClick={() => send.mutate({ accept: true })}>
          {t("Accept")}
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
      title={o.is_change ? t("Decline the new price?") : t("Decline this job?")}
      description={o.is_change ? t("You keep {job} at {price}, the price you agreed.", { job: o.job_title, price: moneyShort(o.agreed_total) }) : t("{job} goes back to the office, and they can offer it to someone else.", { job: o.job_title })}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) onDecline(reason.trim() || null);
        }}
      >
        <Field label={t("Why")} optional hint={t("The office sees this.")}>
          <textarea className="textarea" rows={2} maxLength={500} value={reason} placeholder={t("Booked that week")} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {note && <span className="small" role="status" style={{ color: "var(--warning)", fontWeight: 600 }}>{note}</span>}
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={sending}>{t("Keep it")}</Button>
          <Button type="submit" variant="danger" icon="x" disabled={disabled} loading={sending}>{t("Decline")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
