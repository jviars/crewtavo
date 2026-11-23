/**
 * The customer's account in the Client Hub: what's waiting on them first (quotes to approve, bills
 * to pay), then autopay and their next visit, quick actions, and history. Visits, "request work"
 * and autopay are their own views (?view=visits, ?view=request, ?view=autopay) so the back button
 * works.
 */
import { autopayDueText } from "@crewtavo/core/autopay";
import type { ClientChecklist } from "@crewtavo/core/forms";
import { friendOfferLine } from "@crewtavo/core/marketing";
import { slotLabel, slotTime, type OpenSlot } from "@crewtavo/core/slots";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { dateIn, formatDate, formatMoney, formatMoneyCents, formatTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { needsNewCard, waitingInvoices, yoursToPayNote, type HubAutopay, type HubInvoiceAutopay } from "./document";
import { AutopayView, CARD_REQUIRED, ON_HOLD_TEXT } from "./HubAutopay";

export interface PortalVisit {
  id: string;
  title: string;
  scheduled_on: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  completed_at: string | null;
  address: string | null;
  crew: string[];
  /** Reschedule and Cancel work online: not started, and not today. Servers that don't send it have only Ask to change. */
  can_change?: boolean;
  /** A move or cancel they asked for, waiting on the office. */
  change_requested?: ChangeKind | null;
  /** A done visit's checklists the business shows clients. Servers that don't send them have none. */
  checklists?: ClientChecklist[];
  /** A done visit's photos the office marked OK to share, by id (served small by /hub/:token/photos/:id). */
  photos?: string[];
}
type ChangeKind = "reschedule" | "cancel";
export interface ClientView {
  kind: "client";
  company: { name: string; phone: string | null; email: string | null; website: string | null; timezone?: string | null; branding?: { color?: string } | null; privacy_url?: string | null };
  /** Minutes after a visit's start the crew may arrive (0: no window). Servers that don't send it give none. */
  arrival_window_min?: number;
  /** The office's look at the page: it shows, and nothing on it can be done. */
  preview?: boolean;
  /**
   * false: an office copy made by someone who doesn't see the business's money, so the invoices,
   * payments and credit are left out, and the page doesn't say nothing is owed. Servers that don't
   * send it show the money.
   */
  money?: boolean;
  /** Their autopay. Null when the business doesn't take autopay; servers that don't send it have none. */
  autopay?: HubAutopay | null;
  client: { name: string; first_name: string; properties: Array<{ id: string; line1: string; city: string | null }> };
  /**
   * A quote out as a price range has its range and no total: the client hasn't seen the exact price.
   * One that offers options has how many and the lowest price (`options`) and no total, until they choose.
   */
  quotes: Array<{
    id: string; number: number; title: string; status: string; total: number | null;
    /** Recurring work: its total is per visit. */
    per_visit?: boolean;
    range?: { low: number; high: number; accepted_at: string | null } | null;
    options?: { count: number; from: number } | null;
    valid_until: string | null; approved_at: string | null; link: string;
  }>;
  /** `autopay`: what the automatic charge is doing on it. `yours_to_pay`: over the limit for their bank account, so it wasn't taken from it. Servers that don't send them have none. */
  invoices: Array<{ id: string; number: number; subject: string | null; status: string; total: number; balance_due: number; due_on: string | null; issued_on: string; link: string; autopay?: HubInvoiceAutopay["status"] | null; yours_to_pay?: boolean }>;
  visits: PortalVisit[];
  past_visits: PortalVisit[];
  /** `auto`: charged automatically, to `card` ("Visa ending 4242"). Servers that don't send them have none. */
  payments: Array<{ amount: number; tip_amount: number; method: string; received_at: string; invoice: number | null; auto?: boolean; card?: string | null }>;
  requests: Array<{ number: number; title: string; status: string; created_at: string }>;
  services: string[];
  /** What the friend gets (offer), what the client gets (rewards) and credit they've earned that isn't on an invoice yet. */
  refer: { link: string; offer: string | null; rewards?: string | null; credit_left?: number } | null;
}

export type Fetch = <T>(path: string, body?: unknown, method?: "DELETE") => Promise<T>;

/** The company's time zone: times and dates in the Hub read as the company schedules them. */
export const hubZone = (company: { timezone?: string | null }) => company.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
/** The day a visit was finished, or its scheduled day. */
const doneOn = (v: PortalVisit, tz: string) => (v.completed_at ? dateIn(v.completed_at, tz) : v.scheduled_on);

const METHOD: Record<string, string> = { card: "card", ach: "bank transfer", cash: "cash", check: "check", other: "payment" };
/** The business's arrival window when it gives one; a visit's end is how long the work takes, not when they come. */
const when = (v: PortalVisit, tz: string, windowMin = 0) =>
  !v.starts_at
    ? "Time to be confirmed"
    : windowMin
      ? `Arriving between ${formatTime(v.starts_at, tz)} and ${formatTime(new Date(new Date(v.starts_at).getTime() + windowMin * 60_000).toISOString(), tz)}`
      : `Starting at ${formatTime(v.starts_at, tz)}`;
const names = (crew: string[]) => (crew.length <= 1 ? crew[0] ?? "" : `${crew.slice(0, -1).join(", ")} and ${crew.at(-1)}`);

/** The views of the client's account, each its own ?view= so the back button works. */
export type PortalView = "home" | "visits" | "request" | "autopay";

export function ClientPortal({ token, data, hubFetch, onMessage, onChanged }: { token: string; data: ClientView; hubFetch: Fetch; onMessage: (visit?: PortalVisit) => void; onChanged: () => void }) {
  const [params, setParams] = useSearchParams();
  const view = params.get("view");
  const go = (next: PortalView) => {
    setParams(next === "home" ? {} : { view: next });
    window.scrollTo({ top: 0 });
  };
  const [changing, setChanging] = useState<{ visit: PortalVisit; kind: ChangeKind } | null>(null);
  const onChange = (visit: PortalVisit, kind: ChangeKind) => setChanging({ visit, kind });
  const page =
    view === "visits" ? <Visits token={token} data={data} back={() => go("home")} onMessage={onMessage} onChange={onChange} />
    : view === "request" ? <RequestWork token={token} data={data} hubFetch={hubFetch} back={() => go("home")} />
    : view === "autopay" ? <AutopayView token={token} data={data} hubFetch={hubFetch} back={() => go("home")} onChanged={onChanged} />
    : <Home token={token} data={data} go={go} onMessage={onMessage} onChange={onChange} />;
  return (
    <>
      {page}
      {changing && <ChangeVisitDialog token={token} data={data} {...changing} hubFetch={hubFetch} onClose={() => setChanging(null)} onDone={onChanged} />}
    </>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="hub-section">
      <div className="hub-section-head">
        <h2>{title}{count ? ` · ${count}` : null}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** The visit's day in words, where the business is: "Today", "Tomorrow", or "Sunday, Nov 22". */
function dayWords(date: string, tz: string): string {
  const today = dateIn(new Date().toISOString(), tz);
  if (date === today) return "Today";
  if (date === new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) return "Tomorrow";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Where a visit is on its day, as delivery apps show it: a bar for each step, filled up to this one. */
const STEPS = ["Scheduled", "On the way", "Working", "Done"] as const;
const stepOf = (status: string) => (status === "en_route" ? 1 : status === "in_progress" ? 2 : status === "completed" ? 3 : 0);
function Progress({ status }: { status: string }) {
  const at = stepOf(status);
  return (
    <ol className="hub-progress" aria-label={`Your visit: ${STEPS[at]}`}>
      {STEPS.map((s, i) => <li key={s} data-done={i <= at || undefined} aria-current={i === at ? "step" : undefined}>{s}</li>)}
    </ol>
  );
}

function Crew({ crew }: { crew: string[] }) {
  if (!crew.length) return null;
  return (
    <span className="hub-crew">
      <span className="faces" aria-hidden="true">{crew.slice(0, 3).map((n) => <span key={n} className="face">{n.slice(0, 1)}</span>)}</span>
      <span className="who"><strong>{names(crew)}</strong><span>Your crew</span></span>
    </span>
  );
}

/** A finished visit's photos: small squares, each opening the photo in full. */
const photoUrl = (token: string, id: string, full = false) => `/api/hub/${token}/photos/${id}.jpg${full ? "?full" : ""}`;
function Photos({ token, visit, max = 4 }: { token: string; visit: PortalVisit; max?: number }) {
  const photos = visit.photos ?? [];
  if (!photos.length) return null;
  const more = photos.length - max;
  return (
    <span className="hub-photos">
      {photos.slice(0, max).map((id, i) => (
        <a key={id} href={photoUrl(token, id, true)} target="_blank" rel="noopener" className="hub-photo">
          <img src={photoUrl(token, id)} alt={`Photo ${i + 1} from ${visit.title}`} loading="lazy" />
          {more > 0 && i === max - 1 && <span className="hub-photo-more" aria-hidden="true">+{more}</span>}
        </a>
      ))}
    </span>
  );
}

interface VisitActions {
  onMessage: (visit?: PortalVisit) => void;
  onChange: (visit: PortalVisit, kind: ChangeKind) => void;
}

function VisitCard({ token, visit, tz, windowMin, onMessage, onChange }: { token: string; visit: PortalVisit; tz: string; windowMin?: number } & VisitActions) {
  const online = visit.can_change === true;
  // On its day (or once the crew is on the way) the visit shows where it is; before then, just when.
  const onItsDay = visit.scheduled_on === dateIn(new Date().toISOString(), tz) || visit.status === "en_route" || visit.status === "in_progress";
  return (
    <article className="hub-card hub-visit">
      {/* When first, large (Instacart, Angi): the day, then the time or the arrival window. */}
      <div className="hub-visit-when">
        {visit.change_requested && <span className="hub-live">Change requested</span>}
        <strong>{dayWords(visit.scheduled_on, tz)}</strong>
        <span>{when(visit, tz, windowMin)}</span>
      </div>
      {onItsDay && <Progress status={visit.status} />}
      <div className="hub-visit-text">
        <span className="hub-title">{visit.title}</span>
        {visit.address && <span className="hub-sub">{visit.address}</span>}
        {visit.change_requested && <span className="hub-sub">We'll let you know by email.</span>}
      </div>
      <Crew crew={visit.crew} />
      {/* Two buttons (Client-Phone); a message and cancelling, asked for less often, as quiet words under them. */}
      <div className="hub-acts">
        {online && <button type="button" className="hub-btn hub-btn-sm hub-btn-ghost" onClick={() => onChange(visit, "reschedule")}><Icon name="calendar" size={16} />Reschedule</button>}
        <a className="hub-btn hub-btn-sm hub-btn-ghost" href={`/api/hub/${token}/visits/${visit.id}.ics`}><Icon name="calendarCheck" size={16} />Add to calendar</a>
        {!online && <button type="button" className="hub-btn hub-btn-sm hub-btn-ghost" onClick={() => onMessage(visit)}><Icon name="messages" size={16} />Ask to change</button>}
      </div>
      {online && (
        <div className="hub-visit-links">
          <button type="button" className="hub-link" onClick={() => onMessage(visit)}>Message us<span className="sr-only"> about this visit</span></button>
          <button type="button" className="hub-link" onClick={() => onChange(visit, "cancel")}>Cancel visit</button>
        </div>
      )}
    </article>
  );
}

function Home({ token, data, go, onMessage, onChange }: { token: string; data: ClientView; go: (v: PortalView) => void } & VisitActions) {
  // A range they've said yes to waits on the business (to book the visit), not on them.
  const waitingQuotes = data.quotes.filter((q) => (q.status === "sent" || q.status === "changes_requested") && !q.range?.accepted_at);
  // One being charged to their card (or on its way from their bank) waits on the card, not on them.
  const owed = waitingInvoices(data.invoices);
  // A business that needs a card on file: adding it (or agreeing to the one saved) is waiting on them too.
  const cardStep = Boolean(data.autopay?.card_required && data.autopay.available !== false && (data.autopay.status === "off" || data.autopay.status === "agree"));
  const waitingCount = waitingQuotes.length + owed.length + (cardStep ? 1 : 0);
  const next = data.visits[0];
  const tz = hubZone(data.company);
  // `day` is the date where the company is: a payment at 8:30 PM on Oct 16 in New York is Oct 17 in UTC.
  const recent: Array<{ at: string; day: string; icon: IconName; tone: string; title: string; detail: string; link: string | undefined; visit?: PortalVisit }> = [
    ...data.payments.map((p) => ({
      at: p.received_at, day: dateIn(p.received_at, tz), icon: (p.auto ? "card" : "dollar") as IconName, tone: "good", title: p.invoice ? `Payment on invoice #${p.invoice}` : "Payment received",
      detail: p.auto ? `${formatMoneyCents(p.amount)} charged automatically to ${p.card ?? "your card"}` : `${formatMoneyCents(p.amount)} by ${METHOD[p.method] ?? "payment"}`,
      link: p.invoice ? data.invoices.find((i) => i.number === p.invoice)?.link : undefined,
    })),
    ...data.past_visits.map((v) => ({ at: v.completed_at ?? `${v.scheduled_on}T12:00:00Z`, day: doneOn(v, tz), icon: "check" as IconName, tone: "good", title: `${v.title} done`, detail: v.crew.length ? `by ${names(v.crew)}` : "Visit complete", link: undefined, visit: v })),
    ...data.quotes.filter((q) => q.approved_at).map((q) => ({ at: q.approved_at!, day: dateIn(q.approved_at!, tz), icon: "quote" as IconName, tone: "plain", title: `You approved quote #${q.number}`, detail: q.title, link: q.link })),
    ...data.quotes.filter((q) => q.range?.accepted_at).map((q) => ({ at: q.range!.accepted_at!, day: dateIn(q.range!.accepted_at!, tz), icon: "calendar" as IconName, tone: "plain", title: "You asked for a visit", detail: q.title, link: q.link })),
    ...data.requests.map((r) => ({ at: r.created_at, day: dateIn(r.created_at, tz), icon: "requests" as IconName, tone: "plain", title: `Request #${r.number} received`, detail: r.title, link: undefined })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);

  const share = async () => {
    if (!data.refer) return;
    const text = `${data.company.name} did great work for us.${data.refer.offer ? ` ${data.refer.offer}` : ""}`;
    if (navigator.share) {
      await navigator.share({ title: data.company.name, text, url: data.refer.link }).catch(() => undefined);
    } else {
      await navigator.clipboard.writeText(data.refer.link).then(() => toast.success("Link copied. Paste it in a text or email."), () => toast.error("Couldn't copy the link."));
    }
  };

  return (
    <>
      <section className="hub-hello">
        <h1>Hi {data.client.first_name}</h1>
        {data.client.properties[0] && (
          <span className="hub-chip"><Icon name="pin" size={14} />{data.client.properties[0].line1}{data.client.properties.length > 1 ? ` + ${data.client.properties.length - 1} more` : ""}</span>
        )}
      </section>

      <Section title={waitingCount || data.money === false ? "Waiting on you" : "All caught up"} count={waitingCount}>
        {waitingCount === 0 && (
          <p className="hub-card hub-calm"><Icon name="check" size={18} />{data.money === false ? "No quotes are waiting on you." : "Nothing needs your attention right now."}</p>
        )}
        {waitingQuotes.map((q) =>
          q.range ? (
            <article key={q.id} className="hub-card hub-todo">
              <span className="hub-kick">Estimate #{q.number}{q.valid_until ? ` · good until ${formatDate(q.valid_until)}` : ""}</span>
              <strong className="hub-todo-title">{q.title}</strong>
              <span className="hub-range-line">Between {formatMoney(q.range.low)} and {formatMoney(q.range.high)}</span>
              <a className="hub-btn hub-btn-sm" href={q.link}>See your estimate</a>
            </article>
          ) : (
            <article key={q.id} className="hub-card hub-todo">
              <span className="hub-kick">Quote #{q.number}{q.status === "changes_requested" ? " · you asked for changes" : q.valid_until ? ` · valid until ${formatDate(q.valid_until)}` : ""}</span>
              <strong className="hub-todo-title">{q.title}</strong>
              {q.options && <span className="hub-sub">{q.options.count} options, from {formatMoneyCents(q.options.from)}</span>}
              {!q.options && q.total !== null && <span className="hub-todo-amount">{formatMoneyCents(q.total)}{q.per_visit ? <span className="hub-sub"> per visit</span> : null}</span>}
              <a className="hub-btn hub-btn-sm" href={q.link}>{q.options ? "See your options" : "Review and approve"}</a>
            </article>
          ),
        )}
        {owed.map((i) => (
          <article key={i.id} className="hub-card hub-todo">
            <span className="hub-kick">{i.status === "overdue" && <span className="hub-tag" data-tone="danger">Overdue</span>}Invoice #{i.number}{i.due_on ? ` · ${i.status === "overdue" ? "was due" : "due"} ${formatDate(i.due_on)}` : ""}</span>
            <strong className="hub-todo-title">{i.subject ?? "Balance due"}</strong>
            <span className="hub-todo-amount">{formatMoneyCents(i.balance_due)}</span>
            {needsNewCard(i) && <span className="hub-sub">We couldn't charge your card for this one.</span>}
            {yoursToPayNote(i.yours_to_pay, i.balance_due) && <span className="hub-sub">{yoursToPayNote(i.yours_to_pay, i.balance_due)}</span>}
            <a className="hub-btn hub-btn-sm" href={i.link}>Pay now</a>
            {needsNewCard(i) && data.autopay && data.autopay.available !== false && <button type="button" className="hub-link" onClick={() => go("autopay")}>Update your card</button>}
          </article>
        ))}
        {cardStep && <AutopayCard autopay={data.autopay!} timeZone={tz} go={go} />}
      </Section>

      {data.autopay && !cardStep && <AutopayCard autopay={data.autopay} timeZone={tz} go={go} />}

      {next && (
        <Section title="Next visit" action={data.visits.length > 1 || data.past_visits.length ? <button type="button" className="hub-link" onClick={() => go("visits")}>All visits</button> : undefined}>
          <VisitCard token={token} visit={next} tz={tz} windowMin={data.arrival_window_min} onMessage={onMessage} onChange={onChange} />
        </Section>
      )}

      <Section title="Need something?">
        <div className="hub-actions" data-count={data.refer ? 3 : 2}>
          <button type="button" onClick={() => go("request")}><Icon name="plus" size={22} />Request work</button>
          <button type="button" onClick={() => onMessage()}><Icon name="messages" size={22} />Message us</button>
          {data.refer && <button type="button" onClick={share}><Icon name="gift" size={22} />Refer a friend</button>}
        </div>
      </Section>

      {recent.length > 0 && (
        <Section title="Recent" action={!next && data.past_visits.length ? <button type="button" className="hub-link" onClick={() => go("visits")}>All visits</button> : undefined}>
          <div className="hub-card hub-list">
            {recent.map((r, i) => {
              const body = (
                <>
                  <span className="hub-list-icon" data-tone={r.tone}><Icon name={r.icon} size={16} /></span>
                  <span className="hub-list-text">
                    <strong>{r.title}</strong>
                    <span>{formatDate(r.day)} · {r.detail}</span>
                    {r.visit && <Photos token={token} visit={r.visit} max={3} />}
                  </span>
                  {r.link && <Icon name="chevronRight" size={16} />}
                </>
              );
              return r.link ? <a key={i} href={r.link} className="hub-list-row">{body}</a> : <div key={i} className="hub-list-row">{body}</div>;
            })}
          </div>
        </Section>
      )}

      {data.refer && (
        <section className="hub-card hub-refer">
          <h2>Know someone who could use {data.company.name}?</h2>
          {data.refer.offer && <p>{friendOfferLine(data.refer.offer)}</p>}
          {data.refer.rewards && <p>{data.refer.rewards}</p>}
          {Number(data.refer.credit_left ?? 0) > 0 && <p><strong>You have {formatMoneyCents(data.refer.credit_left)} in referral credit.</strong> It goes on your next invoice.</p>}
          <button type="button" className="hub-btn hub-btn-sm" onClick={share}><Icon name="share" size={16} />Share my link</button>
        </section>
      )}
    </>
  );
}

/**
 * Autopay on the client's home, between what's waiting on them and the next visit: on ("Paid
 * automatically · Visa ending 4242", the next charge, Change card and Turn off), a step left or a
 * state to know about, or, when they're not on it, a card that starts it (a step left to do, when the
 * business needs a card on file). All lead to ?view=autopay.
 * On hold while the business can't take autopay: only Turn off.
 */
function AutopayCard({ autopay, timeZone, go }: { autopay: HubAutopay; timeZone: string; go: (v: PortalView) => void }) {
  const open = () => go("autopay");
  const label = autopay.method?.label ?? "your card";
  const onHold = autopay.available === false;
  if (autopay.status === "active" && !onHold && !autopay.reagree) {
    return (
      <article className="hub-card hub-todo hub-autopay" aria-label="Autopay">
        <span className="hub-autopay-head"><Icon name="card" size={18} /><strong className="hub-title">Paid automatically · {label}</strong></span>
        <span className="hub-sub">{autopay.next_charge ? `Next charge ${autopayDueText(autopay.next_charge, timeZone)}` : `Charged ${autopay.timing}`}</span>
        <div className="hub-acts">
          <button type="button" className="hub-btn hub-btn-sm hub-btn-ghost" onClick={open}><Icon name="card" size={16} />Change card</button>
          <button type="button" className="hub-btn hub-btn-sm hub-btn-ghost" onClick={open}><Icon name="x" size={16} />Turn off</button>
        </div>
      </article>
    );
  }
  if (autopay.status === "off") {
    return (
      <article className="hub-card hub-todo" aria-label="Autopay">
        <strong className="hub-todo-title">{autopay.card_required ? "Finish setting up: add your card" : "Pay automatically after each visit"}</strong>
        <span className="hub-sub">{autopay.card_required ? CARD_REQUIRED : `Save a card once, and we charge it ${autopay.timing}.`}</span>
        <button type="button" className="hub-btn hub-btn-sm" onClick={open}>{autopay.card_required ? "Add your card" : "Pay automatically"}</button>
      </article>
    );
  }
  // A step left (agree, or agree to today's terms), or a state to know about: one line, with what to
  // do when there's something. Active gets here only on hold, or to agree again. Amber or red words
  // only where something has gone wrong or waits.
  const state = autopay.reagree && !onHold ? { tone: "brand", title: "Our autopay terms changed", line: "Agree to them to keep paying for your monthly plan automatically.", action: "Review and agree" }
    : onHold || autopay.status === "active" ? { tone: "warning", title: `Autopay is on hold · ${label}`, line: ON_HOLD_TEXT, action: "Turn off" } : {
    agree: { tone: "brand", title: autopay.imported ? `We have your ${label} on file` : `${autopay.method?.label ?? "Your card"} is saved`, line: "Agree to the terms to start paying automatically.", action: "Finish setting up" },
    pending: { tone: "plain", title: "Your bank account is being checked", line: "This takes a few days. Charges start once it's done.", action: null },
    paused: { tone: "warning", title: "Autopay is paused", line: "Contact us to turn it back on.", action: null },
    needs_update: { tone: "danger", title: "Your card needs updating", line: `We couldn't charge ${label}. Until it's updated, invoices come to you to pay.`, action: "Update card" },
  }[autopay.status];
  return (
    <article className="hub-card hub-todo hub-autopay" aria-label="Autopay" data-tone={state.tone}>
      <span className="hub-autopay-head"><Icon name={state.tone === "danger" || state.tone === "warning" ? "alert" : "card"} size={18} /><strong className="hub-title">{state.title}</strong></span>
      <span className="hub-sub">{state.line}</span>
      <button type="button" className={state.action && state.tone === "brand" ? "hub-btn hub-btn-sm" : "hub-btn hub-btn-sm hub-btn-ghost"} onClick={open}>{state.action ?? "See autopay"}</button>
    </article>
  );
}

function Visits({ token, data, back, onMessage, onChange }: { token: string; data: ClientView; back: () => void } & VisitActions) {
  const tz = hubZone(data.company);
  return (
    <>
      <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
      <h1 className="hub-h1">Visits</h1>
      <Section title="Coming up" count={data.visits.length}>
        {data.visits.length === 0 ? <p className="hub-card hub-calm">Nothing scheduled right now.</p> : data.visits.map((v) => <VisitCard key={v.id} token={token} visit={v} tz={tz} windowMin={data.arrival_window_min} onMessage={onMessage} onChange={onChange} />)}
      </Section>
      {data.past_visits.length > 0 && (
        <Section title="Done" count={data.past_visits.length}>
          <div className="hub-card hub-list">
            {data.past_visits.map((v) => (
              <div key={v.id} className="hub-list-row">
                <span className="hub-list-icon" data-tone="good"><Icon name="check" size={16} /></span>
                <span className="hub-list-text">
                  <strong>{v.title}</strong>
                  <span>{formatDate(doneOn(v, tz))}{v.crew.length ? ` · ${names(v.crew)}` : ""}</span>
                  <Photos token={token} visit={v} />
                  {v.checklists?.map((cl, i) => (
                    <details key={i} className="hub-checklist">
                      <summary>{cl.name}</summary>
                      <dl className="hub-facts">
                        {cl.answers.map((a, j) => (
                          <Fragment key={j}>
                            <dt>{a.label}</dt>
                            <dd className="pre-wrap">{a.text}</dd>
                          </Fragment>
                        ))}
                      </dl>
                    </details>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function RequestWork({ token, data, hubFetch, back }: { token: string; data: ClientView; hubFetch: Fetch; back: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const [propertyId, setPropertyId] = useState(data.client.properties[0]?.id ?? "");
  const [details, setDetails] = useState("");
  const [timing, setTiming] = useState<"asap" | "month" | "flexible">("month");
  const [promo, setPromo] = useState("");
  const [tried, setTried] = useState(false);
  const title = [...picked, other.trim()].filter(Boolean).join(", ");
  const send = useMutation({
    mutationFn: () =>
      hubFetch<{ reference: number }>(`${token}/request`, {
        title: title.length >= 3 ? title.slice(0, 200) : details.trim().split("\n")[0].slice(0, 200) || "New request",
        details: details.trim() || undefined,
        property_id: propertyId || undefined,
        timing,
        promo_code: promo.trim() || undefined,
      }),
  });
  const ready = title.length >= 3 || details.trim().length >= 3;

  if (send.isSuccess) {
    return (
      <>
        <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
        <div className="hub-card hub-done" role="status">
          <span className="hub-done-mark"><Icon name="check" size={30} bold /></span>
          <h2>Request sent</h2>
          <p>{data.company.name} will get back to you with a quote or a time to come look. Your reference is #{send.data.reference}.</p>
          <div className="hub-done-actions"><button type="button" className="hub-btn hub-btn-ghost" onClick={back}>Back to your account</button></div>
        </div>
      </>
    );
  }
  return (
    <>
      <button type="button" className="hub-back" onClick={back}><Icon name="chevronLeft" size={16} />Your account</button>
      <h1 className="hub-h1">Request work</h1>
      <form className="hub-form" onSubmit={(e: FormEvent) => { e.preventDefault(); setTried(true); if (ready) send.mutate(); }}>
        <fieldset>
          <legend>What do you need?</legend>
          {data.services.length > 0 && (
            <div className="hub-choices">
              {data.services.map((s) => {
                const on = picked.includes(s);
                return (
                  <label key={s} className="hub-choice" data-on={on || undefined}>
                    <input type="checkbox" checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} />
                    {s}
                  </label>
                );
              })}
            </div>
          )}
          <input className="input" value={other} onChange={(e) => setOther(e.target.value)} placeholder={data.services.length ? "Something else" : "Fall cleanup, a repair, a new estimate…"} maxLength={160} aria-label="Something else" aria-invalid={(tried && !ready) || undefined} />
          {/* The button stays on; trying it with nothing picked says what's missing, here. */}
          {tried && !ready && <span className="field-error" role="alert">Pick what you need, or tell us about it below.</span>}
        </fieldset>
        {data.client.properties.length > 1 && (
          <fieldset>
            <legend>Where?</legend>
            {data.client.properties.map((p) => (
              <label key={p.id} className="hub-radio" data-on={propertyId === p.id || undefined}>
                <input type="radio" name="property" checked={propertyId === p.id} onChange={() => setPropertyId(p.id)} />
                <span><strong>{p.line1}</strong>{p.city && <span className="hub-sub">{p.city}</span>}</span>
              </label>
            ))}
          </fieldset>
        )}
        <label className="field"><span>Tell us about it <span className="optional">(optional)</span></span>
          <textarea className="textarea" rows={4} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} placeholder="What's going on, and anything we should know before we come out." />
        </label>
        <fieldset>
          <legend>When would you like it done?</legend>
          <div className="hub-choices three">
            {([["asap", "As soon as possible"], ["month", "In the next month"], ["flexible", "I'm flexible"]] as const).map(([k, l]) => (
              <label key={k} className="hub-choice" data-on={timing === k || undefined}>
                <input type="radio" name="timing" checked={timing === k} onChange={() => setTiming(k)} />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="field"><span>Promo code <span className="optional">(optional)</span></span>
          <input className="input mono" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={24} autoCapitalize="characters" />
        </label>
        <FormError error={send.error} />
        {/* On a phone, kept in a bar at the bottom of the screen while the form's in view. */}
        <div className="hub-bar" data-pinned="">
          <Button type="submit" variant="primary" size="lg" block icon="send" loading={send.isPending}>Send request</Button>
        </div>
      </form>
    </>
  );
}

/**
 * Reschedule (the open times by day, or "Tell us what suits you", which is all there is when none are
 * open) or Cancel (with a reason, if they like). Either is a request: the visit stays as it is until
 * the office approves, and a new one takes an earlier one's place.
 */
function ChangeVisitDialog({ token, data, visit, kind, hubFetch, onClose, onDone }: { token: string; data: ClientView; visit: PortalVisit; kind: ChangeKind; hubFetch: Fetch; onClose: () => void; onDone: () => void }) {
  const tz = hubZone(data.company);
  const open = useQuery({
    queryKey: ["hub-slots", token, visit.id],
    enabled: kind === "reschedule",
    retry: false,
    queryFn: () => hubFetch<{ slots: OpenSlot[]; window_min: number; anytime: boolean }>(`${token}/visits/${visit.id}/slots`),
  });
  const slots = open.data?.slots ?? [];
  const days = [...new Set(slots.map((s) => s.date))];
  const [day, setDay] = useState<string | null>(null);
  const [picked, setPicked] = useState<OpenSlot | null>(null);
  const [ownWords, setOwnWords] = useState(false);
  const [text, setText] = useState("");
  const shownDay = day ?? days[0] ?? null;
  const writing = kind === "reschedule" && (ownWords || open.isError || (open.isSuccess && !days.length));
  const send = useMutation({
    mutationFn: () =>
      hubFetch(
        `${token}/visits/${visit.id}/change`,
        kind === "cancel" ? { kind, reason: text.trim() || undefined }
        : writing ? { kind, message: text.trim() }
        : { kind, ...(picked?.starts_at ? { starts_at: picked.starts_at } : { scheduled_on: picked?.date }) },
      ),
    onSuccess: () => {
      toast.success("Request sent", { description: `${data.company.name} will let you know by email.` });
      onDone();
      onClose();
    },
  });
  const choice = (key: string, on: boolean, label: string, pick: () => void, className = "hub-choice") => (
    <button key={key} type="button" className={className} data-on={on || undefined} aria-pressed={on} onClick={pick}>{label}</button>
  );
  return (
    <Dialog open onClose={onClose} title={kind === "cancel" ? "Cancel this visit?" : "Reschedule"} description={`${visit.title}, ${formatDate(visit.scheduled_on)}`}>
      <form className="hub-dialog-form" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
        {kind === "cancel" ? (
          <label className="field"><span>Why? <span className="optional">(optional)</span></span>
            <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} autoFocus />
          </label>
        ) : open.isPending ? (
          <Skeleton height={120} radius={12} />
        ) : writing ? (
          <Field label={open.isSuccess && !days.length ? "We don't have an open time online in the next 3 weeks. Tell us what suits you." : "Tell us what suits you"} requiredMessage="Tell us a day or time that works.">
            <textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required autoFocus placeholder="Any weekday morning after the 15th" />
          </Field>
        ) : (
          <>
            <div className="hub-pick">
              <strong>Day</strong>
              <div className="hub-choices hub-days" role="group" aria-label="Day">{days.map((d) => choice(d, d === shownDay && (!open.data!.anytime || picked?.date === d), slotLabel({ date: d, starts_at: null }, tz), () => { setDay(d); setPicked(open.data!.anytime ? slots.find((s) => s.date === d)! : null); }))}</div>
            </div>
            {!open.data!.anytime && (
              <div className="hub-pick">
                <strong>{open.data!.window_min ? "Arrival window" : "Time"}</strong>
                <div className="hub-slots" role="group" aria-label="Time">{slots.filter((s) => s.date === shownDay).map((s) => choice(s.starts_at!, picked?.starts_at === s.starts_at, slotTime(s.starts_at!, tz, open.data!.window_min), () => setPicked(s), "hub-slot"))}</div>
              </div>
            )}
            <button type="button" className="hub-link hub-link-start" onClick={() => setOwnWords(true)}>None of these work? Tell us what suits you</button>
          </>
        )}
        <span className="hub-sub">Nothing changes until {data.company.name} confirms.</span>
        <FormError error={send.error ?? open.error} />
        <div className="form-actions">
          <Button onClick={onClose}>{kind === "cancel" ? "Keep it" : "Back"}</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending} disabled={kind === "reschedule" && !writing && !picked}>
            {kind === "cancel" ? "Ask to cancel" : "Send request"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Message us" and "Ask to change" both land in the office's message center. */
export function MessageDialog({ token, company, visit, hubFetch, onClose }: { token: string; company: string; visit?: PortalVisit; hubFetch: Fetch; onClose: () => void }) {
  const [message, setMessage] = useState(visit ? `Could we move the ${visit.title.toLowerCase()} visit on ${formatDate(visit.scheduled_on)}? ` : "");
  const send = useMutation({
    mutationFn: () => hubFetch(`${token}/message`, { message: message.trim(), visit_id: visit?.id }),
    onSuccess: () => {
      toast.success("Message sent", { description: `${company} will get back to you.` });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={visit ? "Ask to change a visit" : `Message ${company}`} description={visit ? `${visit.title}, ${formatDate(visit.scheduled_on)}` : "They'll reply by email or text."}>
      <form className="hub-dialog-form" onSubmit={(e: FormEvent) => { e.preventDefault(); send.mutate(); }}>
        <Field label={visit ? "What works better for you?" : "Your message"} requiredMessage={visit ? "Tell us a day or time that works better." : "Write your message, and we'll get back to you."}>
          <textarea className="textarea" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} required autoFocus />
        </Field>
        <FormError error={send.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="send" loading={send.isPending}>Send</Button>
        </div>
      </form>
    </Dialog>
  );
}
