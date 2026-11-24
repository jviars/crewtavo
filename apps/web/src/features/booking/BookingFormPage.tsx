/** Public booking / request form: /book/:company/:form (?embed=1 inside an iframe; see embed.ts). No account needed. */
import { addressLabels } from "@crewtavo/core/countries";
import { textDisclosure } from "@crewtavo/core/marketing";
import { slotLabel, slotTime, type OpenSlot } from "@crewtavo/core/slots";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch, useTurnstile } from "@/lib/publicApi";
import { companyCountry, setCountry } from "@/lib/format";
import { formatPhoneTyping } from "@/lib/validate";
import { fileSize, isAbort, PLAN_MAX_BYTES, TooLargeError, uploadToLink } from "../plans/plans";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "../public/ClientKit";
import { postToHost } from "./embed";

/** The most files a request can bring (the API's limit too). */
const MAX_FILES = 10;
const isFileQuestion = (q: Question) => q.type === "files" || q.type === "photos";
/**
 * Where the keyboard goes when the form can't be sent yet: the first thing to fix, in the form's
 * order. A field says so itself (:invalid, aria-invalid); a group of choices, the times and a file
 * question are marked data-invalid on what holds them, and their first button or their file picker
 * takes the focus. What's wrong is said beside each in a role="alert", so it's read out as well.
 */
export const FIRST_PROBLEM = ":invalid:not(form):not(fieldset), [aria-invalid='true'], [data-invalid='true'] button:not(:disabled), [data-invalid='true'] input:not(:disabled)";

/** What the field says when it's left empty: why it's needed, in the business's voice. */
const NAME_NEEDED = "Enter your name, so we know who to reply to.";
const ADDRESS_NEEDED = "Enter the address where the work is.";
/** A time picked on the form: booked, or asked for and waiting on the business. `calendar` is an add-to-calendar file's text. */
interface Booked { status: "booked" | "asked"; starts_at: string; ends_at: string; emailed: boolean; texted: boolean; calendar?: string }
interface Sent { reference: number; booking?: Booked; uploads?: Array<{ name: string; path: string; token: string } | null>; files_token?: string }
/** What a form with "Let clients pick a time" on says about its times (the openings come a week at a time). */
interface Booking { timezone: string; timezone_label: string; minutes: number; window_min: number; needs_ok: boolean; needs_postal_code: boolean; first: string; last: string }
interface Week { from: string; to: string; first: string; last: string; slots: OpenSlot[] }
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const visitLength = (minutes: number) => (minutes < 60 ? `${minutes} minutes` : minutes % 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : minutes === 60 ? "an hour" : `${minutes / 60} hours`);
/** A calendar date ("2026-11-27") in words, the same wherever the reader is. */
const dateWords = (date: string, options: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
/** A week's dates as the picker heads them: "Nov 24 – 30", or "Nov 28 – Dec 4" across a month's end. */
export const weekWords = (from: string, to: string) => `${dateWords(from, { month: "short", day: "numeric" })} – ${from.slice(0, 7) === to.slice(0, 7) ? Number(to.slice(8)) : dateWords(to, { month: "short", day: "numeric" })}`;

interface Question {
  key: string;
  label: string;
  type: "address" | "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "photos" | "files";
  required: boolean;
  options?: string[];
}
interface FormView {
  /** `texts`: the business can text, so the phone box says what giving a number agrees to. */
  company: { name: string; phone: string | null; country?: string | null; texts?: boolean; privacy_url?: string | null; logo?: string | null; color?: string | null };
  form: { name: string; kind: string; questions: Question[] };
  booking?: Booking;
}

export function BookingFormPage() {
  const { company = "", form = "" } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get("embed") === "1";
  const page = useFitFrame(embedded);
  const path = `/public/forms/${encodeURIComponent(company)}/${encodeURIComponent(form)}`;
  const view = useQuery({ queryKey: ["booking", company, form], retry: false, queryFn: () => publicFetch<FormView>(path) });
  const [contact, setContact] = useState({ name: "", email: "", phone: "", line1: "", city: "", postal_code: "" });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  // Files picked for "Files" and "Photos" questions; they go up after the request is in.
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [sending, setSending] = useState<{ done: number; total: number; progress: number } | null>(null);
  const fileCount = Object.values(files).reduce((n, list) => n + list.length, 0);
  const [touched, setTouched] = useState(false);
  // Each try at sending with something missing: the keyboard goes to the first thing to fix, once the form says what's wrong.
  const [refused, setRefused] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (refused) formRef.current?.querySelector<HTMLElement>(FIRST_PROBLEM)?.focus();
  }, [refused]);
  // A promo code from the link (?promo=SPRING10) or typed in, checked before sending.
  const [promo, setPromo] = useState({ code: (params.get("promo") ?? "").toUpperCase().slice(0, 24), offer: "" as string, open: Boolean(params.get("promo")) });
  const checkPromo = useMutation({
    mutationFn: (code: string) => publicFetch<{ code: string; offer: string }>(`${path}/promo`, { code }),
    onSuccess: (r) => setPromo((p) => ({ ...p, code: r.code, offer: r.offer })),
  });
  useEffect(() => {
    if (view.data && promo.code && !promo.offer && !checkPromo.isPending && !checkPromo.isError && !checkPromo.isSuccess) checkPromo.mutate(promo.code);
  }, [view.data]);
  const turnstile = useTurnstile(Boolean(view.data));
  const questions = (view.data?.form.questions ?? []).filter((q) => q.type !== "address");
  const unanswered = questions.filter(
    (q) => q.required && (isFileQuestion(q) ? !files[q.key]?.length : q.type === "multi_choice" ? !(answers[q.key] as string[] | undefined)?.length : !String(answers[q.key] ?? "").trim()),
  );
  const noContact = !contact.email.trim() && !contact.phone.trim();
  // The address boxes are called what they are where the business is.
  const words = addressLabels(view.data?.company.country);
  // The time picked, on a form that offers times. With nothing open online it's sent as a plain request.
  const booking = view.data?.booking;
  const [time, setTime] = useState<OpenSlot | null>(null);
  const [noneOpen, setNoneOpen] = useState(false);
  const [turnedAway, setTurnedAway] = useState(0);
  const noTime = Boolean(booking) && !time && !noneOpen;

  useEffect(() => {
    if (view.data) document.title = `${view.data.form.name} · ${view.data.company.name}`;
    // Phone boxes read numbers as the business's country writes them (lib/validate.ts); there's no session here to say it.
    if (view.data) setCountry({ country: view.data.company.country });
  }, [view.data]);

  const submit = useMutation({
    mutationFn: async () => {
      const picked = Object.entries(files).flatMap(([question, list]) => list.map((file) => ({ question, file })));
      const sent = await publicFetch<Sent>(path, {
        name: contact.name.trim(),
        email: contact.email.trim() || undefined,
        phone: contact.phone.trim() || undefined,
        address: { line1: contact.line1.trim(), city: contact.city.trim() || undefined, postal_code: contact.postal_code.trim() || undefined },
        // Which files came with each question, by name.
        answers: { ...answers, ...Object.fromEntries(Object.entries(files).filter(([, list]) => list.length).map(([key, list]) => [key, list.map((f) => f.name)])) },
        files: picked.map(({ question, file }) => ({ question, name: file.name, size: file.size, type: file.type || undefined })),
        promo_code: promo.offer ? promo.code : undefined,
        turnstile_token: turnstile.token || undefined,
        starts_at: (booking && time?.starts_at) || undefined,
      });
      // The request is in. Now the files, one at a time, each on its own one-time link.
      const failed: string[] = [];
      const uploaded: Array<{ path: string; name: string }> = [];
      const links = sent.uploads ?? [];
      for (const [i, { file }] of picked.entries()) {
        const link = links[i]?.name === file.name ? links[i] : undefined;
        if (!link) {
          failed.push(file.name);
          continue;
        }
        setSending({ done: i, total: picked.length, progress: 0 });
        try {
          uploaded.push({ path: await uploadToLink(link, file, (progress) => setSending({ done: i, total: picked.length, progress })).promise, name: file.name });
        } catch (error) {
          if (!isAbort(error)) failed.push(file.name);
        }
      }
      let recorded = 0;
      if (uploaded.length && sent.files_token) {
        recorded = (await publicFetch<{ added: number }>(`${path}/files`, { files_token: sent.files_token, uploaded: uploaded.map((u) => u.path) }).catch(() => ({ added: 0 }))).added;
        // Sent but not recorded: as good as not sent.
        if (!recorded) failed.push(...uploaded.map((u) => u.name));
      }
      return { reference: sent.reference, booking: sent.booking, sentFiles: recorded, failed };
    },
    onSettled: () => setSending(null),
    // The time went to someone else meanwhile (or they have a booking already): they pick again from what's open now.
    onError: (error) => {
      if (!booking || (error as { status?: number }).status !== 409) return;
      setTime(null);
      setTurnedAway((n) => n + 1);
    },
    onSuccess: () => (embedded ? postToHost({ crewtavo: "top" }) : window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })),
  });
  const set = (key: keyof typeof contact) => (e: { target: { value: string } }) => setContact({ ...contact, [key]: e.target.value });

  const business = view.data?.company;
  const first = contact.name.trim().split(" ")[0];
  return (
    // Embedded, the business's own page shows around the card: index.html clears the page's background.
    <ClientPage pageRef={page} embedded={embedded} color={business?.color}>
      {/* On its own the business heads the page; in a frame on its website the site does. */}
      {business && !embedded && <ClientHeader name={business.name} logo={business.logo} phone={business.phone} />}
      <ClientBody>
        {view.isPending && <ClientSkeleton header={!embedded} lines={4} />}
        {view.error && <Broken icon="search" title="This form isn't available">{(view.error as Error).message}</Broken>}
        {view.data && submit.data && (
          <Done className={k.doneCard} title={submit.data.booking?.status === "booked" ? `You're booked, ${first}` : `Thanks, ${first}`}>
            {submit.data.booking && booking ? (
              <BookedNote sent={submit.data.booking} company={view.data.company.name} />
            ) : (
              <p className={k.doneText}>{view.data.company.name} got your request and will be in touch soon.</p>
            )}
            <dl className={k.facts}>
              {submit.data.booking && booking && (
                <div>
                  <dt>{submit.data.booking.status === "booked" ? "When" : "Asked for"}</dt>
                  <dd>{bookedWhen(submit.data.booking, booking)}<small>{booking.timezone_label}</small></dd>
                </div>
              )}
              <div><dt>Where</dt><dd>{[contact.line1.trim(), contact.city.trim()].filter(Boolean).join(", ")}</dd></div>
              {submit.data.sentFiles > 0 && <div><dt>Files</dt><dd>{submit.data.sentFiles === 1 ? "Your file came with it" : `Your ${submit.data.sentFiles} files came with it`}</dd></div>}
              <div><dt>Reference</dt><dd>#{submit.data.reference}</dd></div>
            </dl>
            {submit.data.failed.length > 0 && (
              <div className="callout callout-warning">
                <Icon name="alert" size={16} />
                <div className="grow">
                  <div>{submit.data.failed.length === 1 ? "One file didn't come through:" : `${submit.data.failed.length} files didn't come through:`} {submit.data.failed.join(", ")}</div>
                  Your request is in. Email {submit.data.failed.length === 1 ? "it" : "them"} to {view.data.company.name}{view.data.company.phone ? `, or call ${view.data.company.phone}` : ""}.
                </div>
              </div>
            )}
            {submit.data.booking?.calendar && <CalendarLink text={submit.data.booking.calendar} />}
            {view.data.company.phone && <p className={k.doneText}>Questions? Call <a className={k.link} href={`tel:${view.data.company.phone}`}>{view.data.company.phone}</a></p>}
          </Done>
        )}
        {view.data && !submit.data && (
          <form
            ref={formRef}
            className={cx(k.card, k.formCard, k.form)}
            noValidate
            aria-labelledby="booking-form-title"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setTouched(true);
              const form = e.currentTarget as HTMLFormElement;
              if (!form.checkValidity() || unanswered.length || noContact || noTime) {
                // After this render, when a missing time, choice or file is marked: the effect above moves the focus.
                setRefused((n) => n + 1);
                return;
              }
              submit.mutate();
            }}
          >
            <h1 id="booking-form-title" className={k.title}>{view.data.form.name}</h1>
            <Part title="How to reach you">
              <div className={k.grid2}>
                <Field className={k.full} label="Your name" requiredMessage={NAME_NEEDED} error={touched && contact.name.trim().length < 2 ? NAME_NEEDED : null}><input className="input" value={contact.name} onChange={set("name")} required minLength={2} maxLength={120} autoComplete="name" /></Field>
                <Field label="Email" error={touched && noContact ? "Add an email or a phone number, so we can reach you." : null}><input className="input" type="email" value={contact.email} onChange={set("email")} maxLength={200} autoComplete="email" aria-invalid={touched && noContact} /></Field>
                <Field label="Phone" hint={view.data.company.texts ? textDisclosure(view.data.company.name) : undefined}><input className="input" type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: formatPhoneTyping(e.target.value) })} maxLength={30} autoComplete="tel" aria-invalid={touched && noContact} /></Field>
              </div>
            </Part>
            <Part title="Where the work is">
              <Field label="Service address" requiredMessage={ADDRESS_NEEDED} error={touched && contact.line1.trim().length < 3 ? ADDRESS_NEEDED : null}><input className="input" value={contact.line1} onChange={set("line1")} required minLength={3} maxLength={200} autoComplete="street-address" /></Field>
              <div className={cx(k.grid2, k.pair)}>
                <Field label="City"><input className="input" value={contact.city} onChange={set("city")} maxLength={100} autoComplete="address-level2" /></Field>
                <Field label={words.postalCode}><input className="input" value={contact.postal_code} onChange={set("postal_code")} maxLength={12} autoComplete="postal-code" /></Field>
              </div>
            </Part>
            {questions.length > 0 && (
              <Part title="About the job">
                {questions.map((q) => (
                  isFileQuestion(q) ? (
                    <FileQuestion key={q.key} q={q} files={files[q.key] ?? []} room={MAX_FILES - fileCount} invalid={touched && unanswered.includes(q)} disabled={submit.isPending} onChange={(list) => setFiles((all) => ({ ...all, [q.key]: list }))} />
                  ) : (
                    <QuestionField key={q.key} q={q} value={answers[q.key]} invalid={touched && unanswered.includes(q)} onChange={(v) => setAnswers({ ...answers, [q.key]: v })} />
                  )
                ))}
              </Part>
            )}
            {booking && (
              <div className={k.part}>
                <TimePicker path={path} booking={booking} postalCode={contact.postal_code} postalWord={words.postalCodeInText} picked={time} onPick={setTime} onNoneOpen={setNoneOpen} invalid={touched && noTime} refreshed={turnedAway} />
              </div>
            )}
            {promo.offer ? (
              <div className={k.promo}>
                <Icon name="tag" size={18} />
                <span className="grow"><code>{promo.code}</code>: {promo.offer}. It'll be applied to your quote.</span>
                <button type="button" className={k.link} onClick={() => { setPromo({ code: "", offer: "", open: false }); checkPromo.reset(); }}>Remove</button>
              </div>
            ) : promo.open ? (
              <Field label="Promo code" optional error={checkPromo.error ? (checkPromo.error as Error).message : null}>
                <div className={k.promoEntry}>
                  <input className="input mono grow" value={promo.code} onChange={(e) => { setPromo({ ...promo, code: e.target.value.toUpperCase() }); checkPromo.reset(); }} maxLength={24} autoCapitalize="characters" />
                  <Button className={k.soft} loading={checkPromo.isPending} disabled={!promo.code.trim()} onClick={() => checkPromo.mutate(promo.code.trim())}>Apply</Button>
                </div>
              </Field>
            ) : (
              <button type="button" className={k.link} style={{ justifySelf: "start" }} onClick={() => setPromo({ ...promo, open: true })}><Icon name="tag" size={16} />Have a promo code?</button>
            )}
            <div ref={turnstile.ref} className={k.check} />
            <div className={k.bar}>
              <FormError error={submit.error} />
              {sending && (
                <div className={k.sending} role="status" aria-live="polite">
                  <div className={k.sendingHead}><span>Sending your files: {sending.done + 1} of {sending.total}</span><span>{Math.round(sending.progress * 100)}%</span></div>
                  <div className="progress"><span style={{ width: `${Math.round(((sending.done + sending.progress) / sending.total) * 100)}%` }} /></div>
                  <span className={k.note}>Keep this page open until they're done.</span>
                </div>
              )}
              <FormChecks />
              <Button type="submit" variant="primary" size="lg" className={k.cta} icon={booking && time ? "calendar" : "send"} loading={submit.isPending} disabled={turnstile.required && !turnstile.token}>
                {booking && time ? (booking.needs_ok ? "Request this time" : "Book this time") : "Send request"}
              </Button>
            </div>
          </form>
        )}
        <div className={k.foot}><PrivacyFooter url={view.data?.company.privacy_url} /></div>
      </ClientBody>
    </ClientPage>
  );
}

/** One part of the form under its heading: who's asking, where, the questions. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={k.part} aria-labelledby={id}>
      <h2 id={id} className={k.legend}>{title}</h2>
      {children}
    </section>
  );
}

/** When a booked visit is, as the form offered it, in the business's time zone. */
function bookedWhen(sent: Booked, booking: Booking) {
  return slotLabel({ date: new Date(sent.starts_at).toLocaleDateString("en-CA", { timeZone: booking.timezone }), starts_at: sent.starts_at }, booking.timezone, booking.window_min, companyCountry());
}

/** After a time was picked: whether it's booked or waiting on the business, and how they'll hear. */
function BookedNote({ sent, company }: { sent: Booked; company: string }) {
  const told = sent.emailed && sent.texted ? "We've emailed and texted you the details." : sent.emailed ? "We've emailed you the details." : sent.texted ? "We've texted you the details." : null;
  return sent.status === "booked" ? (
    <p className={k.doneText}>{told ?? `${company} will see you then.`}</p>
  ) : (
    <p className={k.doneText}>This time isn't confirmed yet: {company} will confirm it, or get in touch to find another.{told ? ` ${told}` : ""}</p>
  );
}

/** A file for their calendar, made from the booking's own (an object URL, let go when the page is). */
function CalendarLink({ text }: { text: string }) {
  const calendar = useMemo(() => URL.createObjectURL(new Blob([text], { type: "text/calendar" })), [text]);
  useEffect(() => () => URL.revokeObjectURL(calendar), [calendar]);
  return <a className={k.cta} href={calendar} download="visit.ics"><Icon name="calendar" size={18} />Add to calendar</a>;
}

/**
 * The times the business has open, a week at a time: a day, then a time on it. Shown once the
 * postal code is in when the form has a service area, so nobody outside it is offered a time.
 * `refreshed` changes when a send was turned away, and brings the openings as they are now.
 */
function TimePicker({ path, booking, postalCode, postalWord, picked, onPick, onNoneOpen, invalid, refreshed }: { path: string; booking: Booking; postalCode: string; postalWord: string; picked: OpenSlot | null; onPick: (slot: OpenSlot | null) => void; onNoneOpen: (none: boolean) => void; invalid: boolean; refreshed: number }) {
  // Asked for once they stop typing, not at every letter.
  const [postal, setPostal] = useState(postalCode.trim());
  useEffect(() => {
    const timer = setTimeout(() => setPostal(postalCode.trim()), 600);
    return () => clearTimeout(timer);
  }, [postalCode]);
  const waiting = booking.needs_postal_code && postal.length < 3;
  // No `from`: the first week that has a time.
  const [from, setFrom] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const week = useQuery({
    queryKey: ["booking-openings", path, from, booking.needs_postal_code ? postal : "", refreshed],
    enabled: !waiting,
    retry: false,
    placeholderData: keepPreviousData,
    queryFn: () => {
      const query = new URLSearchParams({ ...(from && { from }), ...(booking.needs_postal_code && { postal_code: postal }) }).toString();
      return publicFetch<Week>(`${path}/openings${query ? `?${query}` : ""}`);
    },
  });
  const w = week.data;
  const slots = w?.slots ?? [];
  const days = [...new Set(slots.map((s) => s.date))];
  const shownDay = day && days.includes(day) ? day : (days[0] ?? null);
  // Nothing open in the whole stretch the form books: the request goes without a time.
  const none = week.isSuccess && !slots.length && week.data.from <= week.data.first && week.data.to >= week.data.last;
  // Outside the service area (400) nothing is sent; when the times just can't be read, the request still can be.
  const outside = week.isError && (week.error as { status?: number }).status === 400;
  const unread = week.isError && !outside;
  useEffect(() => onNoneOpen(none || unread), [none, unread]);
  // A time that's no longer offered isn't kept picked.
  useEffect(() => {
    if (picked && week.isSuccess && !week.isPlaceholderData && week.data.from <= picked.date && picked.date <= week.data.to && !slots.some((s) => s.starts_at === picked.starts_at)) onPick(null);
  }, [week.data]);
  const dayName = (date: string) => slotLabel({ date, starts_at: null }, booking.timezone, 0, companyCountry());
  return (
    <fieldset className="field" data-invalid={invalid || undefined} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 10 }}>
      <legend className={k.legend}>{booking.needs_ok ? "Pick a time you'd like" : "Pick a time"}</legend>
      <p className={k.note}>{booking.window_min ? "We arrive within the window you pick." : `Set aside about ${visitLength(booking.minutes)}.`} Times are in {booking.timezone_label}.</p>
      {waiting ? (
        <p className={k.note}>Enter your {postalWord} above to see the times we have open.</p>
      ) : week.isPending ? (
        <Skeleton height={140} radius={14} />
      ) : outside ? (
        <span className="field-error">{(week.error as Error).message}</span>
      ) : unread ? (
        <p className={k.note}>We couldn't show our open times just now. Send your request and we'll be in touch to set one.</p>
      ) : none || !w ? (
        <p className={k.note}>We don't have a time open online right now. Send your request and we'll be in touch to set one.</p>
      ) : (
        <>
          <div className={k.week}>
            <button type="button" className={k.round} aria-label="Earlier" disabled={w.from <= w.first || week.isFetching} onClick={() => { setDay(null); setFrom(addDays(w.from, -7) <= w.first ? w.first : addDays(w.from, -7)); }}><Icon name="chevronLeft" size={20} /></button>
            <span aria-live="polite"><span className="sr-only">{dayName(w.from)} to {dayName(w.to)}</span><span aria-hidden="true">{weekWords(w.from, w.to)}</span></span>
            <button type="button" className={k.round} aria-label="Later" disabled={w.to >= w.last || week.isFetching} onClick={() => { setDay(null); setFrom(addDays(w.to, 1)); }}><Icon name="chevronRight" size={20} /></button>
          </div>
          {days.length === 0 ? (
            <p className={k.note}>Nothing open these days. Try {w.to >= w.last ? "earlier" : "later"}.</p>
          ) : (
            <>
              <div className={k.days} role="group" aria-label="Day" style={{ ["--cols" as string]: Math.min(Math.max(days.length, 5), 7) }}>
                {days.map((d) => (
                  <button key={d} type="button" className={k.day} aria-pressed={d === shownDay} onClick={() => setDay(d)}>
                    {dateWords(d, { weekday: "short" })} <b>{Number(d.slice(8))}</b><span className="sr-only">, {dateWords(d, { month: "long" })}</span>
                  </button>
                ))}
              </div>
              <div className={k.slots} role="group" aria-label={booking.window_min ? "Arrival window" : "Time"}>
                {slots.filter((s) => s.date === shownDay).map((s) => (
                  <button key={s.starts_at!} type="button" className={k.slot} aria-pressed={picked?.starts_at === s.starts_at} onClick={() => onPick(picked?.starts_at === s.starts_at ? null : s)}>
                    {slotTime(s.starts_at!, booking.timezone, booking.window_min, companyCountry())}
                  </button>
                ))}
              </div>
            </>
          )}
          {picked && <p className={k.picked} role="status">{booking.needs_ok ? "You're asking for" : "You picked"} <b>{slotLabel(picked, booking.timezone, booking.window_min, companyCountry())}</b>.</p>}
        </>
      )}
      {invalid && !waiting && !week.isError && <span className="field-error" role="alert">Pick a time for your visit.</span>}
      {invalid && waiting && <span className="field-error" role="alert">Enter your {postalWord}, then pick a time.</span>}
    </fieldset>
  );
}

/** In an iframe on the business's website: keeps the frame as tall as the form (embed.ts). */
function useFitFrame(embedded: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const page = ref.current;
    if (!embedded || !page) return;
    const observer = new ResizeObserver(() => postToHost({ crewtavo: "height", height: page.getBoundingClientRect().height }));
    observer.observe(page);
    return () => observer.disconnect();
  }, [embedded]);
  return ref;
}

/**
 * A "Files" or "Photos" question: pick or drop files; they're sent once the request is in. The
 * picker is a real file input kept in the page (only hidden from sight), so Tab reaches it, Enter
 * and Space open it, and a screen reader says what it's for; its label shows the focus.
 */
export function FileQuestion({ q, files, room, invalid, disabled, onChange }: { q: Question; files: File[]; room: number; invalid: boolean; disabled: boolean; onChange: (files: File[]) => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const photos = q.type === "photos";
  const add = (picked: File[]) => {
    const fitting = picked.filter((f) => f.size > 0 && f.size <= PLAN_MAX_BYTES && (!photos || f.type.startsWith("image/")));
    const tooBig = picked.filter((f) => f.size > PLAN_MAX_BYTES);
    const taken = fitting.slice(0, Math.max(0, room));
    setProblem(
      tooBig.length ? new TooLargeError(`${tooBig[0]!.name} is larger than ${fileSize(PLAN_MAX_BYTES)}. Split it into smaller files, or send it another way.`).message
        : fitting.length > taken.length ? `You can send up to ${MAX_FILES} files with a request.`
          : picked.length > fitting.length ? (photos ? "Only pictures here." : "Some of those files are empty.") : null,
    );
    if (taken.length) onChange([...files, ...taken]);
  };
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  const errorId = useId();
  const error = problem ?? (invalid ? "Add a file to send with your request." : null);
  return (
    <div
      className={cx("field", over && k.drop)}
      data-invalid={invalid || undefined}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add([...e.dataTransfer.files]); }}
    >
      <span className="field-label">{label}</span>
      {files.length > 0 && (
        <ul className={k.files}>
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Icon name={f.type.startsWith("image/") ? "image" : "file"} size={18} />
              <span className={k.fileName}>{f.name}<small>{fileSize(f.size)}</small></span>
              <button type="button" className={k.iconBtn} aria-label={`Remove ${f.name}`} disabled={disabled} onClick={() => onChange(files.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className={cx("btn", k.soft)} style={{ justifySelf: "start" }} aria-disabled={disabled || room <= 0}>
        <Icon name={photos ? "camera" : "upload"} size={18} />{photos ? "Add photos" : "Add files"}
        <input
          type="file"
          multiple
          className="sr-only"
          // Its name starts with the words on the button, then says which question it answers.
          aria-label={`${photos ? "Add photos" : "Add files"}: ${q.label}${q.required ? "" : " (optional)"}`}
          aria-required={q.required || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? errorId : undefined}
          accept={photos ? "image/*" : undefined}
          disabled={disabled || room <= 0}
          onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; add(picked); }}
        />
      </label>
      <span className="hint">{photos ? "Pictures" : "Plans, PDFs or pictures"}, up to {fileSize(PLAN_MAX_BYTES)} each. You can also drop them here.</span>
      {error && <span id={errorId} className="field-error" role="alert">{error}</span>}
    </div>
  );
}

export function QuestionField({ q, value, invalid, onChange }: { q: Question; value: unknown; invalid: boolean; onChange: (v: unknown) => void }) {
  const label = <>{q.label}{!q.required && <span className="optional"> (optional)</span>}</>;
  const error = invalid ? "Answer this one to send your request." : null;
  switch (q.type) {
    case "long_text":
      return <Field label={label} error={error}><textarea className="textarea" value={String(value ?? "")} maxLength={4000} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
    case "number":
      return <Field label={label} error={error}><DecimalInput className="input" inputMode="decimal" value={String(value ?? "")} onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={invalid} /></Field>;
    case "yes_no":
    case "choice":
    case "multi_choice": {
      const options = q.type === "yes_no" ? ["Yes", "No"] : q.options ?? [];
      const list = Array.isArray(value) ? (value as string[]) : [];
      return (
        <fieldset className="field" data-invalid={invalid || undefined} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ marginBottom: 8 }}>{label}</legend>
          <div className={k.choices}>
            {options.map((o) => {
              const on = q.type === "multi_choice" ? list.includes(o) : value === o;
              return (
                <button key={o} type="button" className={k.choice} aria-pressed={on} onClick={() => onChange(q.type === "multi_choice" ? (on ? list.filter((x) => x !== o) : [...list, o]) : o)}>
                  {on && <Icon name="check" size={16} bold />}{o}
                </button>
              );
            })}
          </div>
          {error && <span className="field-error" role="alert">{error}</span>}
        </fieldset>
      );
    }
    default:
      return <Field label={label} error={error}><input className="input" value={String(value ?? "")} maxLength={500} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid} /></Field>;
  }
}
