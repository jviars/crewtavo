/**
 * One visit on a phone: where, how to get in, what to do, checklist, photos, receipts and notes. A
 * sub gets the client's name (and phone, if the office allows it) from visit_contact(), their own
 * price for the job once it's agreed, and no clock, receipts or materials: those are the team's.
 *
 * The visit's next step (On my way, Start visit, Complete visit) is the one thing to tap: on a phone
 * it sits in a bar above the tab bar, in thumb reach. The checklist and the notes save as the crew
 * goes, and Complete visit says how many required checklist items are left.
 *
 * The team adds work to the job from the price list, never seeing a price; once the visit is done,
 * the office on site makes its invoice, sends it and records cash or check (FieldBilling.tsx).
 */
import { shownCustomFields } from "@crewtavo/core/customFields";
import { onlineManager, useIsMutating, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { forwardRef, Fragment, useCallback, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore, type ChangeEvent, type RefObject } from "react";
import { Link, useParams } from "react-router-dom";
import { canDrawOn, DrawOnPhoto, OriginalLink } from "@/components/DrawOnPhoto";
import { PhotoEditor, type MarksFor } from "@/components/PhotoEditor";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MetaLine } from "@/components/ui/InboxList";
import { MapsLink } from "@/components/ui/MapsLink";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Note } from "@/components/ui/Note";
import { BackLink, Crumb, useDocumentTitle } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus, type SaveState } from "@/components/ui/SaveStatus";
import { Facts, Section } from "@/components/ui/Section";
import { Select } from "@/components/ui/Select";
import { DetailSkeleton, SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { PageError } from "@/components/ui/States";
import { EntityStatus, StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { errorMessage, isAuthError } from "@/lib/errors";
import { photoLinks } from "@/lib/photoMarkup";
import { addressLine, formatDateTime, formatTime, timeAgo, todayIn } from "@/lib/format";
import { visitPlace } from "@/lib/maps";
import { useListAnimation } from "@/lib/motion";
import { FIELD_SCOPE } from "@/lib/offline";
import { addVisitPhoto, phonePhotos, removePhonePhoto, subscribePhonePhotos, type PhonePhoto } from "@/lib/offlinePhotos";
import { hasRole, isSub, keepsTime, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { IN_TRASH } from "../drive/trash";
import { ShareToggle, shareToggleState } from "../marketing/ShareToggle";
import { galleryOf, usePhotoGallery } from "../files/PhotoGallery";
import { undoable } from "@/lib/undo";
import { CustomFieldFacts, useCustomFields } from "../customFields/CustomFields";
import { ExpenseDialog } from "../jobs/ExpensesCard";
import { MaterialsCard } from "../jobs/JobMaterials";
import { useJobScope } from "../jobs/ScopeOfWork";
import { FieldPlans } from "../plans/FieldPlans";
import { PropertyEquipment } from "../clients/PropertyEquipment";
import { guideQuery } from "../kb/kbData";
import { contactLinks, visitContact, type VisitContact } from "./contact";
import { pendingChecklistSaves, pendingVisitSave, pendingVisitStatus, showVisitStatus, statusSaved, type ChecklistSave, type VisitNotesSave, type VisitStatusChange } from "./fieldActions";
import { formatDuration, useStatusTap } from "./fieldData";
import { GeofenceCard } from "./GeofenceCard";
import { OfflineNote, useSignal } from "./OfflineNote";
import { SignaturePad } from "./SignaturePad";
import { visitChecklists, type VisitChecklist } from "./visitChecklists";
import { AddWork, VisitInvoice } from "./FieldBilling";
import { addsToVisit, addsWork, fieldInvoiceKind, takesMoney, takesWork } from "./fieldMoney";
import { VisitExtraScope, WorkLines } from "./FieldExtras";
import { dayOrder, useMyDay } from "./myDay";
import { YourPrice } from "./YourPrice";
import { LocationNotice } from "./LocationNoticeDialog";
import { msg, t, T } from "@/lib/i18n";

interface ChecklistItem { key: string; label: string; type: "check" | "number" | "text" | "choice" | "photo" | "signature"; required: boolean; options?: string[]; sop_page_id?: string }

/** What's still required on the visit's checklists, for Complete visit. Null when nothing holds it up. */
interface ChecklistProgress { required: number; missing: Array<{ key: string; label: string }> }

interface ChecklistHandle {
  /** With the visit's completion: saves a checklist with nothing required missing as done, any other (completed anyway) as it is. */
  finish: () => void;
  /** Brings the first required item still missing to the middle of the screen, lit up for a moment. */
  showMissing: () => void;
}

const stillMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function FieldVisitPage() {
  const { id = "" } = useParams();
  const session = useSession();
  const queryClient = useQueryClient();
  const [expense, setExpense] = useState(false);
  const sub = isSub(session);
  const clocks = keepsTime(session);
  const checklist = useRef<ChecklistHandle>(null);
  // Undefined while the checklist loads.
  const [progress, setProgress] = useState<ChecklistProgress | null | undefined>(undefined);
  // The required item an early Complete visit last pointed at: tapped again, it offers to go without.
  const pointedAt = useRef<string | null>(null);
  const online = useSignal();
  // Where it is on today's route (Stop 3 of 5), from My day's list, kept on the phone.
  const day = useMyDay();

  const visit = useQuery({
    queryKey: ["field-visit", id],
    queryFn: async () => {
      const row = unwrapOne(
        await supabase()
          .from("visits")
          .select("id, title, kind, status, starts_at, ends_at, scheduled_on, notes, address, hold_reason, completed_at, invoice_id, series_day, series_total, equipment:visit_equipment(equipment:equipment(id, name, kind)), job:jobs(id, number, title, instructions, property_id, custom_fields, kind, status, pricing, client:clients(display_name, phone, social_photos_opt_out)), request:requests(id, title, details, client:clients(display_name, phone, social_photos_opt_out)), property:properties(id, line1, city, region, postal_code, lat, lng, notes, custom_fields)")
          .eq("id", id)
          .maybeSingle(),
        msg("This visit"),
      );
      const notes = pendingVisitSave<VisitNotesSave>(queryClient, "visit-notes", id);
      return { ...row, status: pendingVisitStatus(queryClient, id) ?? row.status, notes: notes ? notes.notes : row.notes };
    },
  });
  const v = visit.data;
  useDocumentTitle(v?.title ?? t("Visit"));
  // The job's and property's own fields, to read (a sub reads none: they're the business's).
  const jobFields = useCustomFields("job");
  const propertyFields = useCustomFields("property");
  const access = useQuery({
    queryKey: ["field-visit", id, "access"],
    enabled: Boolean(v?.property),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("property_access").select("gate_code, lockbox_code, alarm_code, instructions").eq("property_id", v!.property!.id))[0] ?? null,
  });
  // A sub can't read clients: the name, and the phone if they may call, come from visit_contact().
  // Kept on the phone with the visit, for no signal.
  const contact = useQuery({
    queryKey: ["field-visit", id, "contact"],
    enabled: sub,
    meta: { silent: true },
    queryFn: async () => (unwrap(await supabase().rpc("visit_contact", { p_visit: id })) as VisitContact[])[0] ?? null,
  });
  // Whether the job is charged automatically when the visit is done: a yes or no from
  // visit_autopay(), never an amount or a card (crews don't see prices). Kept on the phone with the
  // visit. Not for subs: their price is their own, and the client's billing isn't theirs to see.
  const autopay = useQuery({
    queryKey: ["field-visit", id, "autopay"],
    enabled: !sub && Boolean(v?.job),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("visit_autopay", { p_visit: id })) === true,
  });
  const myTime = useQuery({
    queryKey: ["field-visit", id, "time"],
    enabled: clocks,
    queryFn: async () => unwrap(await supabase().from("time_entries").select("started_at, ended_at").eq("visit_id", id).eq("user_id", session.userId)),
  });
  const refresh = () => {
    // The Jobs list and job pages say Late, Today, Upcoming or Unscheduled from the visits (public.job_state).
    for (const k of [["field-visit", id], ["field"], ["schedule"], ["job"], ["jobs"], ["running-timer"], ["crew-clock"], ["dashboard"], ["checklist", id]]) queryClient.invalidateQueries({ queryKey: k });
  };
  // These work offline: saved on the phone and sent, in order, when there's signal. Each is sent by
  // the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts notes when
  // it's on its way, for the count of updates waiting.
  const statusMutation = useMutation({
    mutationKey: ["visit-status"],
    scope: FIELD_SCOPE,
    meta: { success: statusSaved },
    onMutate: (change: VisitStatusChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showVisitStatus(queryClient, change);
    },
    onSettled: refresh,
  });
  const statusTap = useStatusTap((change) => statusMutation.mutate(change));
  const setStatus = (status: string) => statusTap.tap({ id, jobId: v?.job?.id ?? null }, status);
  // Which step is on its way: finding the phone's place comes first for one that clocks.
  const going = statusTap.locating?.id === id ? statusTap.locating.status : statusMutation.isPending && !statusMutation.isPaused ? (statusMutation.variables?.status ?? null) : null;

  // Notes save a moment after the crew stops typing, and when they leave the box.
  const showing = useShowing();
  const saveNotes = useMutation({
    mutationKey: ["visit-notes"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (change: VisitNotesSave) => {
      queryClient.setQueryData<typeof visit.data>(["field-visit", id], (old) => old && { ...old, notes: change.notes });
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["field-visit", id], exact: true }),
  });
  const notesSave = useAutoSave((text: string) => saveNotes.mutateAsync({ companyId: session.company.id, visitId: id, notes: text.trim() || null }), 1000);
  const notesSending = useIsMutating({ mutationKey: ["visit-notes"], predicate: (m) => (m.state.variables as VisitNotesSave | undefined)?.visitId === id });
  const [notes, setNotes] = useState("");
  const notesIn = useRef(false);
  // What's saved comes in (the first load, the office changing them) unless something typed here is
  // still on its way, or they're typing.
  useEffect(() => {
    if (!visit.data) return;
    if (notesIn.current && (notesSending > 0 || notesSave.waiting() || document.activeElement?.id === "visit-notes")) return;
    notesIn.current = true;
    setNotes(visit.data.notes ?? "");
  }, [visit.data?.notes, visit.isSuccess, notesSending]);

  if (visit.isPending) return <DetailSkeleton />;
  if (visit.error || !v) {
    return (
      <div className="field-app">
        <PageError error={visit.error} onRetry={() => visit.refetch()} back={<BackLink to="/field">{t("My day")}</BackLink>} />
      </div>
    );
  }

  const place = visitPlace(v);
  const propertyId = v.property?.id ?? v.job?.property_id ?? null;
  const client = visitContact((v.job?.client ?? v.request?.client) as { display_name: string; phone: string | null } | null, contact.data);
  const codes = access.data;
  const minutes = (myTime.data ?? []).reduce((s, t) => s + ((t.ended_at ? Date.parse(t.ended_at) : Date.now()) - Date.parse(t.started_at)), 0);
  const left = progress?.missing.length ?? 0;
  const invoiceKind = v.job ? fieldInvoiceKind(v.job) : null;
  const complete = async () => {
    const first = progress?.missing[0];
    if (progress && first) {
      // The first tap shows what's still required; tapped again, it can go without.
      if (pointedAt.current !== first.key) {
        pointedAt.current = first.key;
        return checklist.current?.showMissing();
      }
      const names = progress.missing.map((m) => m.label).join(", ");
      const anyway = await confirm({ title: t("The checklist isn't done"), body: t("Still needed: {names}. The office will see the checklist is unfinished.", { names }), confirmLabel: t("Complete anyway"), cancelLabel: t("Keep working") });
      if (!anyway) return checklist.current?.showMissing();
    }
    checklist.current?.finish();
    setStatus("completed");
  };
  const scheduled = v.status === "scheduled";
  const commit =
    scheduled ? (
      <>
        <Button loading={going === "en_route"} onClick={() => setStatus("en_route")}>{t("On my way")}</Button>
        <Button variant="primary" loading={going === "in_progress"} onClick={() => setStatus("in_progress")}>{t("Start visit")}</Button>
      </>
    ) : v.status === "en_route" ? (
      <Button variant="primary" loading={going !== null} onClick={() => setStatus("in_progress")}>{t("Start visit")}</Button>
    ) : v.status === "in_progress" ? (
      // What's still required is said over it, and read with it.
      <Button variant="primary" loading={going !== null} aria-describedby={left > 0 ? "visit-left" : undefined} onClick={() => void complete()}>{t("Complete visit")}</Button>
    ) : null;
  const contacts = contactLinks(client);
  const quiet = [
    ...contacts.map((link) => <a key={link.label} className="btn" href={link.href}><Icon name={link.label === "Call" ? "phone" : "messages"} size={18} />{link.label === "Call" ? t("Call") : t("Text", { context: "message" })}</a>),
    ...(place ? [<MapsLink key="maps" className="btn" place={place}><Icon name="navigation" size={18} />{t("Directions")}</MapsLink>] : []),
  ];
  const rows = (v.status === "in_progress" && left > 0 ? 1 : 0) + (commit ? 2 : 0) + (quiet.length ? 4 : 0);
  // Stop 3 of 5: where it is on today's route.
  const todays = [...(day.data?.today ?? [])].sort(dayOrder);
  const at = todays.findIndex((d) => d.id === v.id);
  const stopText = at >= 0 && todays.length > 1 ? t("Stop {number} of {count}", { number: todays[at]!.route_order ?? at + 1, count: todays.length }) : null;
  const when = v.starts_at ? (v.scheduled_on === todayIn(session.company.timezone) ? formatTime(v.starts_at, session.company.timezone) : formatDateTime(v.starts_at)) : v.scheduled_on ? t("Anytime today") : t("Not scheduled");
  const more: MenuEntry[] = [
    { label: t("Add photos"), icon: "camera", onSelect: () => document.getElementById("visit-add-photos")?.click() },
    { label: t("Draw on a photo"), icon: "pen", onSelect: () => document.getElementById("visit-draw-photo")?.click() },
    { label: t("Add a receipt"), icon: "receipt", hidden: !(v.job && !sub), onSelect: () => setExpense(true) },
  ];

  return (
    <div className="field-app m-grouped field-narrow visit-page">
      <div className="page-header detail-head visit-head">
        <div className="detail-crumb"><Crumb to="/field">{t("My day")}</Crumb></div>
        {stopText && <span className="visit-stop">{stopText}</span>}
        <h1 className="page-title">{v.title}</h1>
        <div className="page-actions"><Menu items={more} title={v.title} /></div>
        <MetaLine
          className="detail-meta"
          parts={[
            <EntityStatus key="status" kind="visit" status={v.status} />,
            <span key="when" className="tabular">{when}</span>,
            stopText && <span key="stop" className="visit-meta-stop">{stopText}</span>,
            v.series_total && v.series_total > 1 && <span key="series" className="chip">{t("Day {day} of {days}", { day: v.series_day, days: v.series_total })}</span>,
            clocks && minutes > 0 && <span key="you" className="tabular">{t("You: {time}", { time: formatDuration(minutes) })}</span>,
            /* i18n-ignore: test/invoices.test.ts reads this chip as written, so it stays in English */
            <Fragment key="autopay">{!sub && autopay.data && <span className="chip" title={t("The client is charged automatically after the visit")}><Icon name="card" size={12} />Autopay</span>}</Fragment>,
          ]}
        />
      </div>
      <OfflineNote />
      {/* What's saved about where they are, said once before a tap here would save it. */}
      <LocationNotice />
      {/* The clock at the property: Complete visit goes through the checklist check, as the button below does. */}
      <GeofenceCard visitId={v.id} onStatus={(_visit, status) => (status === "completed" ? void complete() : setStatus(status))} />
      {v.status === "completed" && v.completed_at && <div className="callout callout-good"><Icon name="check" size={16} /><div className="grow">{t("Completed {when}.", { when: timeAgo(v.completed_at) })}</div></div>}

      {/* The visit's next step and the ways to reach the client and get there. On a phone, pinned above the tab bar in thumb reach. */}
      {(commit || quiet.length > 0) && (
        <div className="visit-bar no-print" role="group" aria-label={t("Actions")} data-rows={rows}>
          {v.status === "in_progress" && progress && left > 0 && (
            <div className="visit-left" id="visit-left">
              <ProgressRing value={(progress.required - left) / progress.required} />
              <span><T text={left === 1 ? msg("{count} required left", "one") : "{count} required left"} count={<AnimatedNumber value={left} />} /></span>
            </div>
          )}
          {commit && <div className="visit-commit">{commit}</div>}
          {quiet.length > 0 && <div className="visit-quiet" data-count={quiet.length}>{quiet}</div>}
        </div>
      )}

      <div className="visit-body">
        <section className="visit-site" aria-label={t("Site")}>
          <div className="visit-site-name">{client.name ?? t("Site")}</div>
          {place && <MapsLink className="visit-site-address" place={place}>{v.property ? addressLine(v.property) : v.address}</MapsLink>}
          {access.isPending && v.property ? <Skeleton width="40%" height={28} /> : (codes?.gate_code || codes?.lockbox_code || codes?.alarm_code) && (
            <dl className="visit-codes">
              {codes.gate_code && <div><dt>{t("Gate code")}</dt><dd>{codes.gate_code}</dd></div>}
              {codes.lockbox_code && <div><dt>{t("Lockbox")}</dt><dd>{codes.lockbox_code}</dd></div>}
              {codes.alarm_code && <div><dt>{t("Alarm")}</dt><dd>{codes.alarm_code}</dd></div>}
            </dl>
          )}
          {codes?.instructions && <p className="visit-site-note pre-wrap">{codes.instructions}</p>}
          {v.property?.notes && <p className="visit-site-note pre-wrap">{v.property.notes}</p>}
          {v.hold_reason && <div className="visit-warn"><Icon name="cloud" size={15} />{t("Weather: {reason}", { reason: v.hold_reason })}</div>}
        </section>

        {(v.job?.instructions || v.request?.details) && (
          <Section title={t("Instructions")} className="visit-instructions">
            {v.job?.instructions && <Note text={v.job.instructions} />}
            {v.request?.details && <p className="pre-wrap">{v.request.details}</p>}
          </Section>
        )}
        {/* Autopay bills the visit itself; with no signal, whether it does may not be on the phone. */}
        {v.status === "completed" && v.job && invoiceKind && takesMoney(session) && (autopay.isSuccess ? !autopay.data : !online) && <VisitInvoice visitId={v.id} jobId={v.job.id} kind={invoiceKind} />}
        {v.job && (
          <Section title={t("The work")}>
            <ScopeLines jobId={v.job.id} />
            {/* A repeating job's work is the same every visit; this is what's extra on this one. */}
            {addsToVisit(v.job) && <VisitExtraScope visitId={v.id} />}
            {/* Not once a repeating job's visit is on an invoice: the office adds to the invoice then. */}
            {addsWork(session) && takesWork(v.job) && v.status !== "cancelled" && !(addsToVisit(v.job) && v.invoice_id) && <AddWork visitId={v.id} jobId={v.job.id} toVisit={addsToVisit(v.job)} />}
          </Section>
        )}

        <VisitWork visitId={v.id} visitStatus={v.status} checklist={checklist} onProgress={setProgress} jobId={v.job?.id ?? null} materials={!sub}
          clientOptOut={Boolean(v.job?.client?.social_photos_opt_out ?? v.request?.client?.social_photos_opt_out)} />

        <Section title={<label htmlFor="visit-notes">{t("Notes for the office")}</label>} action={<AutoSaveStatus status={notesSave.status} waiting={notesSending > 0} />} className="visit-notes">
          <textarea
            id="visit-notes"
            className="textarea"
            value={notes}
            maxLength={5000}
            onChange={(e) => {
              setNotes(e.target.value);
              notesSave.change(e.target.value);
            }}
            onBlur={notesSave.flush}
            placeholder={t("Extra work they asked about, damage you noticed, materials used…")}
          />
          <FormError error={saveNotes.error} />
          {v.job && !sub && <button type="button" className="field-add" onClick={() => setExpense(true)}><Icon name="receipt" size={18} />{t("Add a receipt")}</button>}
        </Section>

        {(shownCustomFields(jobFields, v.job?.custom_fields).length > 0 || shownCustomFields(propertyFields, v.property?.custom_fields).length > 0) && (
          <Section title={t("Details")}>
            <Facts>
              <CustomFieldFacts fields={jobFields} values={v.job?.custom_fields} />
              <CustomFieldFacts fields={propertyFields} values={v.property?.custom_fields} />
            </Facts>
          </Section>
        )}
        {v.equipment.length > 0 && (
          <Section title={t("Bring")} count={v.equipment.length}>
            <ul className="visit-bring">
              {v.equipment.map((e) => e.equipment && <li key={e.equipment.id}><span className="rel-icon"><Icon name="truck" size={15} /></span>{e.equipment.name}</li>)}
            </ul>
          </Section>
        )}
        {sub && <YourPrice visitId={v.id} />}
        <FieldPlans visitId={v.id} jobId={v.job?.id ?? null} propertyId={propertyId} />
        {/* The client's own equipment here is the team's to see, not a sub's: a section like the rest, Add equipment its last row. */}
        {!sub && propertyId && <PropertyEquipment propertyId={propertyId} visitId={v.id} />}
      </div>

      {expense && v.job && !sub && <ExpenseDialog jobId={v.job.id} expense={null} onClose={() => setExpense(false)} onSaved={() => toast.success(t("Receipt sent to the office"), { tone: "job" })} />}
    </div>
  );
}

/** The job's work as the crew sees it: names, notes and quantities, never prices (job_scope). */
function ScopeLines({ jobId }: { jobId: string }) {
  const scope = useJobScope(jobId);
  if (scope.isPending) return <Skeleton height={44} radius={8} />;
  if (!scope.data?.length) return null;
  return <WorkLines lines={scope.data} />;
}

/** The checklists, photos and materials (not a sub's), sharing the visit's photos (a checklist item can ask for them). */
function VisitWork({ visitId, visitStatus, checklist, onProgress, jobId, materials, clientOptOut }: { visitId: string; visitStatus: string; checklist: RefObject<ChecklistHandle>; onProgress: (p: ChecklistProgress | null | undefined) => void; jobId: string | null; materials: boolean; clientOptOut: boolean }) {
  const photos = useVisitPhotos(visitId);
  return (
    <>
      <Checklists ref={checklist} visitId={visitId} jobId={jobId} visitStatus={visitStatus} photos={photos} onProgress={onProgress} />
      <Photos photos={photos} clientOptOut={clientOptOut} />
      {jobId && materials && <MaterialsCard jobId={jobId} visitId={visitId} compact />}
    </>
  );
}

/**
 * Saving as the crew goes, for the parts of a visit with no Save button (the checklist, the notes):
 * `change` a moment after the last edit, `flush` at once (leaving a box), and before the screen goes
 * or the phone puts the app away. Each save is a field action, so with no signal it's kept on the
 * phone and goes out in order later; `status` is for SaveStatus.
 */
function useAutoSave<V>(send: (variables: V) => Promise<unknown>, delay: number) {
  const { status, edited, track } = useSaveStatus();
  const sendNow = useRef(send);
  sendNow.current = send;
  const next = useRef<{ variables: V } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const waiting = next.current;
    if (!waiting) return;
    next.current = null;
    void track(sendNow.current(waiting.variables));
  }, [track]);
  const change = useCallback(
    (variables: V) => {
      next.current = { variables };
      edited();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [edited, flush, delay],
  );
  useEffect(() => {
    // On the window as it's on its way down, so the save is made before lib/offline.ts (on the
    // document) writes what's waiting to the phone's storage.
    const hidden = () => document.visibilityState === "hidden" && flush();
    window.addEventListener("visibilitychange", hidden, true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("visibilitychange", hidden, true);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
  return { status, change, flush, waiting: () => next.current !== null };
}

/** False once the screen has gone, for saves that come back after it. */
function useShowing() {
  const showing = useRef(false);
  useEffect(() => {
    showing.current = true;
    return () => {
      showing.current = false;
    };
  }, []);
  return showing;
}

/**
 * For a save whose error the screen shows (meta.inline): turned down once the screen has gone (sent
 * as the crew left it, or when the signal came back), a toast says so instead. A lost sign-in is
 * said by lib/queryClient.ts.
 */
const toastIfGone = (showing: RefObject<boolean>) => (error: Error) => {
  if (!showing.current && !isAuthError(error)) toast.error(errorMessage(error));
};

/**
 * How a part that saves as the crew goes stands: SaveStatus, or kept on the phone until there's
 * signal. `waiting` is a save of it not sent yet, from this screen or from before the app was
 * closed (lib/offline.ts keeps them), which with signal is only a moment behind.
 */
function AutoSaveStatus({ status, waiting }: { status: SaveState; waiting: boolean }) {
  const online = useSignal();
  if (waiting && !online) {
    return (
      <span className="save-status" data-state="queued" role="status">
        <Icon name="wifiOff" size={14} />
        {t("Saved on this phone")}
      </span>
    );
  }
  return <SaveStatus status={status} />;
}

/** How much of the checklist's required part is in, as a ring on Complete visit. */
function ProgressRing({ value }: { value: number }) {
  const length = 2 * Math.PI * 8;
  return (
    <svg className="progress-ring" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="progress-ring-track" cx="10" cy="10" r="8" />
      {value > 0 && <circle className="progress-ring-done" cx="10" cy="10" r="8" strokeDasharray={length} strokeDashoffset={length * (1 - value)} />}
    </svg>
  );
}

/** The mark on a required item, said as "required" to a screen reader. */
function Required() {
  return (
    <>
      <span className="text-danger" aria-hidden="true"> *</span>
      <span className="sr-only"> {t("(required)")}</span>
    </>
  );
}

interface ChecklistTemplate { id: string; name: string; items: unknown }
interface ChecklistResponse { id: string; template_id: string | null; answers: unknown; completed_at: string | null; completed_by: string | null }
interface ChecklistData { templates: ChecklistTemplate[]; matched: string[]; responses: ChecklistResponse[] }

// A key of its own: a phone may still keep the one-checklist shape saved under ["checklist", id].
const checklistsKey = (visitId: string) => ["checklist", visitId, "cards"];

/** A save still waiting on this phone, as the response it will be (the saved answers too, when it only marks it done). */
const waitingResponse = (v: ChecklistSave, saved: ChecklistResponse | undefined): ChecklistResponse => ({
  id: v.responseId,
  template_id: v.templateId,
  answers: v.answers ?? saved?.answers ?? {},
  completed_at: v.completedAt,
  completed_by: null,
});

/**
 * The visit's checklists (visitChecklists.ts): each one its job's price list items go with, ready to
 * fill in, and one more to pick from the rest. Complete visit counts what's required on all of them.
 */
const Checklists = forwardRef<ChecklistHandle, { visitId: string; jobId: string | null; visitStatus: string; photos: VisitPhotos; onProgress: (p: ChecklistProgress | null | undefined) => void }>(function Checklists({ visitId, jobId, visitStatus, photos, onProgress }, ref) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const data = useQuery({
    queryKey: checklistsKey(visitId),
    queryFn: async (): Promise<ChecklistData> => {
      const [templates, responses, matched] = await Promise.all([
        supabase().from("checklist_templates").select("id, name, items").eq("company_id", company.id).eq("active", true).order("name"),
        supabase().from("checklist_responses").select("id, template_id, answers, completed_at, completed_by").eq("visit_id", visitId).order("created_at"),
        // The crew can't read the job's lines (they have prices): the database says which checklists they bring up.
        jobId ? supabase().rpc("job_checklists", { p_job: jobId }) : null,
      ]);
      // Saves still waiting on this phone are newer than what the server has.
      const saved: ChecklistResponse[] = unwrap(responses);
      const queued = pendingChecklistSaves(queryClient, visitId);
      const merged = saved.map((r) => (queued.has(r.id) ? waitingResponse(queued.get(r.id)!, r) : r));
      for (const v of queued.values()) if (!saved.some((r) => r.id === v.responseId)) merged.push(waitingResponse(v, undefined));
      return { templates: unwrap(templates), matched: matched ? unwrap(matched) : [], responses: merged };
    },
  });
  // The one to pick saves with this, so saving twice with no signal updates one checklist instead of adding two.
  const [newId] = useState(() => crypto.randomUUID());
  const { cards, others } = data.data?.templates.length ? visitChecklists(data.data.templates, data.data.matched, data.data.responses, newId) : { cards: [], others: [] };
  const handles = useRef(new Map<string, ChecklistHandle>());
  const [progressBy, setProgressBy] = useState<Record<string, ChecklistProgress | null>>({});
  const report = useCallback(
    (key: string, p: ChecklistProgress | null | undefined) =>
      setProgressBy((all) => {
        const next = { ...all };
        if (p === undefined) delete next[key];
        else next[key] = p;
        return next;
      }),
    [],
  );

  // Complete visit says what's left on all of them, and points at the first.
  const each = cards.map((c) => progressBy[c.key]);
  const required = each.reduce((n, p) => n + (p?.required ?? 0), 0);
  const total = data.isPending || cards.some((c) => !(c.key in progressBy)) ? undefined : required ? { required, missing: cards.flatMap((c) => (progressBy[c.key]?.missing ?? []).map((m) => ({ key: `${c.key}:${m.key}`, label: m.label }))) } : null;
  const summary = JSON.stringify(total ?? String(total));
  useEffect(() => onProgress(total), [summary]);
  useEffect(() => () => onProgress(null), [onProgress]);

  useImperativeHandle(ref, () => ({
    finish: () => cards.forEach((c) => handles.current.get(c.key)?.finish()),
    showMissing: () => {
      const first = cards.find((c) => progressBy[c.key]?.missing.length);
      if (first) handles.current.get(first.key)?.showMissing();
    },
  }));

  if (data.isPending) return <SectionSkeleton rows={3} />;
  const another = cards.some((c) => c.fixed);
  return cards.map((card) => (
    <Checklist
      key={card.key}
      ref={(handle) => {
        if (handle) handles.current.set(card.key, handle);
        else handles.current.delete(card.key);
      }}
      card={card}
      templates={data.data?.templates ?? []}
      others={others}
      another={another}
      visitId={visitId}
      visitStatus={visitStatus}
      photos={photos}
      report={report}
    />
  ));
});

/** One checklist on the visit: brought up by the job's items, or picked (`another` when some were brought up). */
const Checklist = forwardRef<
  ChecklistHandle,
  { card: VisitChecklist<ChecklistResponse>; templates: ChecklistTemplate[]; others: ChecklistTemplate[]; another: boolean; visitId: string; visitStatus: string; photos: VisitPhotos; report: (key: string, p: ChecklistProgress | null | undefined) => void }
>(function Checklist({ card, templates, others, another, visitId, visitStatus, photos, report }, ref) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  const flashing = useRef<number | undefined>(undefined);
  const showing = useShowing();
  const response = card.response;
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [templateId, setTemplateId] = useState("");
  const answersNow = useRef(answers);
  answersNow.current = answers;
  // Made here so saving twice with no signal updates one checklist instead of adding two (the one to pick has its card's).
  const [newId] = useState(() => (card.fixed ? crypto.randomUUID() : card.key));
  const responseId = response?.id ?? newId;

  // Sent by the action registered for it, like the visit's own (no mutationFn here).
  const saveMutation = useMutation({
    mutationKey: ["checklist-save"],
    scope: FIELD_SCOPE,
    meta: { inline: true },
    onMutate: (v: ChecklistSave) => {
      queryClient.setQueryData<ChecklistData>(checklistsKey(visitId), (old) => {
        if (!old) return old;
        const saved = old.responses.find((r) => r.id === v.responseId);
        const next = waitingResponse(v, saved);
        return { ...old, responses: saved ? old.responses.map((r) => (r.id === v.responseId ? next : r)) : [...old.responses, next] };
      });
    },
    onError: toastIfGone(showing),
    // Not waited on: the next field action in line goes without waiting for this reload.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: checklistsKey(visitId) }),
  });
  const autosave = useAutoSave((v: ChecklistSave) => saveMutation.mutateAsync(v), 500);
  const sending = useIsMutating({ mutationKey: ["checklist-save"], predicate: (m) => (m.state.variables as ChecklistSave | undefined)?.responseId === responseId });
  const loaded = useRef(false);
  // What's saved comes in (the first load, another phone, the checklist reopened) unless something
  // changed here is still on its way.
  useEffect(() => {
    if (loaded.current && (sending > 0 || autosave.waiting())) return;
    loaded.current = true;
    if (response) {
      setAnswers((response.answers ?? {}) as Record<string, unknown>);
      setTemplateId(response.template_id ?? "");
    } else if (card.templateId) setTemplateId(card.templateId);
  }, [response, sending]);

  const template = templates.find((t) => t.id === templateId);
  const items = (template?.items ?? []) as unknown as ChecklistItem[];
  // The guides its items link to (not for subs, who don't read guides): fetched now, so they open
  // with no signal later (lib/offline.ts keeps them), and linked once there's one to open.
  const guideIds = session.role === "subcontractor" ? [] : [...new Set(items.flatMap((i) => (i.sop_page_id ? [i.sop_page_id] : [])))];
  const guides = useQueries({ queries: guideIds.map((id) => ({ ...guideQuery(company.id, id), staleTime: 60 * 60_000 })) });
  const guideFor = (item: ChecklistItem) => (item.sop_page_id ? guides[guideIds.indexOf(item.sop_page_id)]?.data ?? null : null);
  const answered = (i: ChecklistItem) => {
    const a = answers[i.key];
    if (i.type === "photo") return true;
    // A signature needs the drawing (older checklists stored a typed name).
    if (i.type === "signature" && a && typeof a === "object") return Boolean((a as { image?: string }).image);
    return !(a === undefined || a === null || a === "" || a === false);
  };
  const missing = items.filter((i) => i.required && !answered(i));
  const required = items.filter((i) => i.required && i.type !== "photo").length;
  const doneCount = items.filter((i) => i.type !== "photo" && answered(i)).length;
  const countable = items.filter((i) => i.type !== "photo").length;
  const done = Boolean(response?.completed_at);

  // Complete visit says what's left, and points at it.
  const missingKeys = missing.map((m) => m.key).join("\n");
  useEffect(() => {
    report(card.key, template && !done && required ? { required, missing: missing.map(({ key, label }) => ({ key, label })) } : null);
  }, [template?.id, done, required, missingKeys]);
  useEffect(() => () => report(card.key, undefined), [report, card.key]);

  const variables = (next: Record<string, unknown> | undefined, chosen: string, completedAt: string | null = null): ChecklistSave => ({
    companyId: company.id,
    visitId,
    responseId,
    templateId: chosen || null,
    ...(next && { answers: next }),
    completedAt,
  });
  const set = (key: string, value: unknown) => {
    const next = { ...answersNow.current, [key]: value };
    answersNow.current = next;
    setAnswers(next);
    autosave.change(variables(next, templateId));
  };
  const choose = (id: string) => {
    setTemplateId(id);
    autosave.change(variables(answersNow.current, id));
  };

  // Marked done, the answers go along only while some made here are still to send. Otherwise the
  // saved ones stay: this phone's copy may be older than a crewmate's answers from another phone.
  const markDone = () => {
    autosave.change(variables(sending > 0 || autosave.waiting() ? answersNow.current : undefined, templateId, new Date().toISOString()));
    autosave.flush();
  };

  useImperativeHandle(ref, () => ({
    finish: () => {
      // Nothing required missing: marked done. Completed anyway: what's in goes as it is, unfinished.
      if (template && !done && !missing.length) return markDone();
      autosave.flush();
    },
    showMissing: () => {
      const first = missing[0];
      const row = first && root.current?.querySelector<HTMLElement>(`[data-check="${CSS.escape(first.key)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: stillMotion() ? "auto" : "smooth" });
      // Lit up again even if it already was: a color change, so it shows with Reduce Motion too.
      row.removeAttribute("data-flash");
      void row.offsetWidth;
      row.setAttribute("data-flash", "");
      window.clearTimeout(flashing.current);
      flashing.current = window.setTimeout(() => row.removeAttribute("data-flash"), 1300);
      // A box takes the focus; for anything else the row does. A list or a text field would count as
      // typing (AppShell hides the phone's bars for the keyboard), with no keyboard or picker open.
      (row.querySelector<HTMLElement>('input[type="checkbox"]') ?? row).focus({ preventScroll: true });
    },
  }));

  const reopen = useMutation({
    mutationFn: async () => unwrap(await supabase().from("checklist_responses").update({ completed_at: null }).eq("id", response!.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: checklistsKey(visitId) }),
  });

  return (
    <Section
      title={card.fixed ? (template?.name ?? t("Checklist")) : another ? t("Another checklist") : t("Checklist")}
      count={template && !done ? t("{done} of {count}", { done: doneCount, count: countable }) : undefined}
      action={<><AutoSaveStatus status={autosave.status} waiting={sending > 0} />{done && <StatusPill label={t("Done")} tone="good" />}</>}
      className="visit-checklist"
    >
      {!card.fixed && !done && (others.length > 1 || another) && (
        <Select className="select check-pick" value={templateId} onChange={(e) => choose(e.target.value)} aria-label={t("Choose a checklist")}>
          <option value="">{t("Choose a checklist…")}</option>
          {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )}
      {items.length > 0 && (
        <div ref={root} className="check-list">
          {items.map((item) => (
            <div key={item.key} className="check-row" data-check={item.key} data-type={item.type} tabIndex={-1}>
              {item.type === "check" ? (
                // The whole row is the box's label, so a tap anywhere on it ticks it.
                <label className="checkbox">
                  <input type="checkbox" checked={Boolean(answers[item.key])} disabled={done} onChange={(e) => set(item.key, e.target.checked)} />
                  <span className="check-text">{item.label}{item.required && <Required />}</span>
                </label>
              ) : item.type === "photo" ? (
                <>
                  <span className="check-photo"><span className="check-mark" aria-hidden="true"><Icon name="camera" size={15} /></span><span className="check-text">{item.label}</span></span>
                  {!done && <PhotoPicker photos={photos} compact />}
                </>
              ) : item.type === "choice" ? (
                <label className="field check-field"><span>{item.label}{item.required && <Required />}</span>
                  <Select className="select" value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, e.target.value)}>
                    <option value="">{t("Choose…")}</option>
                    {item.options?.map((o) => <option key={o}>{o}</option>)}
                  </Select>
                </label>
              ) : item.type === "signature" ? (
                <SignatureAnswer label={item.label} required={item.required} value={answers[item.key]} disabled={done} onChange={(next) => set(item.key, next)} />
              ) : (
                <label className="field check-field"><span>{item.label}{item.required && <Required />}</span>
                  <input className="input" inputMode={item.type === "number" ? "decimal" : undefined} value={String(answers[item.key] ?? "")} disabled={done} onChange={(e) => set(item.key, item.type === "number" ? e.target.value.replace(/[^0-9.\-]/g, "") : e.target.value)} onBlur={autosave.flush} />
                </label>
              )}
              {guideFor(item) && <Link to={`/kb/${item.sop_page_id}`} className="check-guide" title={guideFor(item)!.title} aria-label={t("How to: {guide}", { guide: guideFor(item)!.title })}><Icon name="book" size={14} />{t("How to")}</Link>}
            </div>
          ))}
        </div>
      )}
      <FormError error={saveMutation.error} />
      {/* Under way, Complete visit marks it done. Otherwise this does: completed on My day, by the office, or anyway with the rest done after. */}
      {template && !done && !missing.length && visitStatus !== "in_progress" && <button type="button" className="field-add" onClick={markDone}><Icon name="check" size={18} />{t("Mark done")}</button>}
      {done && hasRole(session, "admin", "office", "crew_lead") && <button type="button" className="field-add field-add-quiet" disabled={reopen.isPending} onClick={() => reopen.mutate()}>{reopen.isPending ? <Spinner size={16} /> : <Icon name="undo" size={18} />}{t("Reopen checklist")}</button>}
    </Section>
  );
});

interface Photo {
  id: string; path: string; file_name: string; caption: string | null; content_type: string | null; shareable: boolean; created_at: string; created_by: string | null;
  /** The photo drawn on, shown instead of it (lib/photoMarkup.ts). */
  marked_path: string | null;
  /** What it shows (its drawing, if any), and the photo as taken. */
  url: string | null;
  originalUrl: string | null;
}
type VisitPhotos = ReturnType<typeof useVisitPhotos>;

/**
 * A visit's photos, for its Photos card and the checklist items that ask for them: added from the
 * camera or the phone's photos (in the task island while they go up), and removed with Undo.
 */
function useVisitPhotos(visitId: string) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const key = ["photos", visitId];
  // Being shrunk and written to the phone: a moment, shown as a blank picture.
  const [adding, setAdding] = useState(0);
  // Not uploaded yet, kept on the phone meanwhile (lib/offlinePhotos.ts): shown here as they will be.
  const waiting = useSyncExternalStore(subscribePhonePhotos, phonePhotos).filter((p) => p.userId === session.userId && p.visitId === visitId);
  // Removed and waiting on Undo: kept off the screen even if the list loads again meanwhile.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("attachments").select("id, path, marked_path, file_name, caption, content_type, shareable, created_at, created_by").eq("owner_type", "visit").eq("owner_id", visitId).order("created_at"));
      return photoLinks(rows);
    },
  });
  // `drawn`: one photo drawn on before it's added (the photo editor), kept beside it.
  const add = async (files: File[], drawn?: Blob | null, marks?: MarksFor) => {
    setAdding((n) => n + files.length);
    for (const file of files) {
      try {
        const kept = await addVisitPhoto({ userId: session.userId, companyId: company.id, visitId }, file, files.length === 1 ? drawn : null, marks);
        // Said as it's taken: with no signal and nowhere to keep it, only the open app holds it.
        if (!kept && !onlineManager.isOnline()) toast.warning(t("This phone couldn't save the photo"), { description: t("Keep Crewtavo open until you have signal, or the photo will be lost.") });
      } catch (error) {
        toast.error(`${file.name}: ${errorMessage(error)}`);
      }
      setAdding((n) => n - 1);
    }
  };
  const refreshPhotos = () => queryClient.invalidateQueries({ queryKey: ["photos", visitId] });
  // Once its Undo has passed, the photo goes to the Trash with its row (the database moves it).
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (p: { id: string; path: string }) => {
      const gone = unwrap(await supabase().from("attachments").delete().eq("id", p.id).select("id"));
      if (!gone.length) throw new Error(t("You can only remove photos you added. Ask the office to remove this one."));
    },
    onSettled: () => void refreshPhotos(),
  });
  const without = (id: string) => (h: ReadonlySet<string>) => new Set([...h].filter((x) => x !== id));
  return {
    photos: (list.data ?? []).filter((p) => !hidden.has(p.id)),
    /** OK to share shown at once, as the field action goes (or waits for signal). */
    showShareable: (id: string, shareable: boolean) => queryClient.setQueryData<Photo[]>(key, (rows) => rows?.map((r) => (r.id === id ? { ...r, shareable } : r))),
    loading: list.isPending,
    adding,
    waiting,
    uploading: adding > 0 || waiting.some((p) => p.sending),
    add: (files: File[], drawn?: Blob | null, marks?: MarksFor) => void add(files, drawn, marks),
    /** Reloads them: a drawing saved or taken off. */
    refresh: () => void refreshPhotos(),
    /** One that hasn't uploaded is only on this phone, so removing it has no Undo: asked first. */
    removeWaiting: async (p: PhonePhoto) => {
      if (await confirm({ title: t("Remove this photo?"), body: t("It hasn't uploaded yet, so it will be gone for good."), confirmLabel: t("Remove"), danger: true })) removePhonePhoto(p.id);
    },
    // A sub removes only the photos they added.
    canRemove: (p: Photo) => !isSub(session) || p.created_by === session.userId,
    remove: (p: Photo) =>
      undoable({
        title: t("Photo removed"),
        // A sub has no Trash to take it from later: the office can.
        description: isSub(session) ? undefined : IN_TRASH,
        tone: "job",
        hide: () => {
          void queryClient.cancelQueries({ queryKey: key });
          setHidden((h) => new Set(h).add(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => rows?.filter((r) => r.id !== p.id));
        },
        restore: () => {
          setHidden(without(p.id));
          queryClient.setQueryData<Photo[]>(key, (rows) => (rows && !rows.some((r) => r.id === p.id) ? [...rows, p].sort((a, b) => a.created_at.localeCompare(b.created_at)) : rows));
        },
        commit: () => remove.mutateAsync(p),
      }),
  };
}

/**
 * Take or choose photos for the visit: on the Photos section, and on checklist items that ask for
 * them (`compact`: round buttons whose words are their names). "Draw on a photo" takes or chooses
 * one and opens it to draw on before it's added: the photo and its drawing go through the phone's
 * queue together, so it works with no signal. `ids` lets the visit's More menu open the same pickers.
 */
function PhotoPicker({ photos, compact, ids }: { photos: VisitPhotos; compact?: boolean; ids?: { add: string; draw: string } }) {
  const [drawing, setDrawing] = useState<File | null>(null);
  const words = (text: string) => (compact ? <span className="sr-only">{text}</span> : text);
  return (
    <span className={compact ? "photo-pick photo-pick-compact" : "photo-pick"}>
      <label className={compact ? "btn btn-icon photo-pick-main" : "btn photo-pick-main"} title={compact ? t("Add photos") : undefined}>
        {photos.uploading ? <Spinner size={18} /> : <Icon name="camera" size={compact ? 20 : 18} />}
        {words(photos.uploading ? t("Uploading…") : t("Add photos"))}
        <input
          id={ids?.add}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) photos.add(files);
          }}
        />
      </label>
      <label className={compact ? "btn btn-icon" : "btn"} title={compact ? t("Draw on a photo") : undefined}>
        <Icon name="pen" size={compact ? 20 : 18} />
        {words(t("Draw on a photo"))}
        <input
          id={ids?.draw}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) setDrawing(file);
          }}
        />
      </label>
      {drawing && (
        <PhotoEditor
          picture={drawing}
          saveLabel={t("Add photo")}
          keepsBlank
          onCancel={() => setDrawing(null)}
          onSave={(drawn, marks) => {
            photos.add([drawing], drawn, marks);
            setDrawing(null);
          }}
        />
      )}
    </span>
  );
}

function Photos({ photos, clientOptOut }: { photos: VisitPhotos; clientOptOut: boolean }) {
  const session = useSession();
  const grid = useListAnimation<HTMLDivElement>();
  // Tapping a photo opens it in the gallery with the others; the ones still on the phone aren't links.
  const gallery = usePhotoGallery();
  const inGallery = galleryOf(photos.photos, (p) => p.caption ?? p.file_name);
  const count = photos.photos.length + photos.waiting.length;
  // OK to share is only offered while Marketing is installed, never to subs (ShareToggle).
  const sharing = photos.photos.some((p) => shareToggleState(session, p, clientOptOut) === "ready");
  const unsupported = photos.photos.filter((p) => shareToggleState(session, p, clientOptOut) === "unsupported").length;
  const shown = photos.loading || count > 0 || photos.adding > 0;
  return (
    <Section title={t("Photos")} count={count || undefined} className="visit-photos">
      <div ref={grid} className="thumbs" hidden={!shown}>
        {photos.loading && [0, 1, 2].map((i) => <Skeleton key={i} height={96} radius={10} />)}
        {photos.photos.map((p) => (
          <div key={p.id} className="thumb">
            {p.url ? <a href={p.url} target="_blank" rel="noreferrer" onClick={gallery.opener(inGallery, p.id)}><img src={p.url} alt={p.caption ?? p.file_name} loading="lazy" /></a> : <span className="muted small">{t("Unavailable")}</span>}
            {photos.canRemove(p) && <button type="button" className="thumb-x" aria-label={t("Remove photo")} onClick={() => photos.remove(p)}><Icon name="x" size={12} bold /></button>}
            <ShareToggle photo={p} clientOptOut={clientOptOut} onShown={(shareable) => photos.showShareable(p.id, shareable)} />
            {/* Drawn on: shown with the drawing, the photo as taken a tap away. */}
            {p.marked_path && <OriginalLink url={p.originalUrl} label={p.caption ?? p.file_name} />}
            {canDrawOn(session, p) && <DrawOnPhoto photo={p} label={p.caption ?? p.file_name} onSaved={photos.refresh} />}
          </div>
        ))}
        {photos.waiting.map((p) => <WaitingPhoto key={p.id} photo={p} onRemove={() => void photos.removeWaiting(p)} />)}
        {Array.from({ length: photos.adding }, (_, i) => <div key={`u${i}`} className="thumb thumb-adding"><Spinner size={20} /></div>)}
      </div>
      {sharing && <p className="field-hint">{t("Tap the corner to mark photos OK to share, and the office can post them. Posts never show the client's name or address. Check the photo doesn't show a house number, a car plate or people's faces.")}</p>}
      {unsupported > 0 && !clientOptOut && <p className="field-hint">{unsupported === photos.photos.length
        ? unsupported === 1 ? t("This photo can't be marked OK to share: only JPEG and PNG photos can be posted.") : t("These photos can't be marked OK to share: only JPEG and PNG photos can be posted.")
        : unsupported === 1 ? t("The photo marked Can't share can't be marked OK to share: only JPEG and PNG photos can be posted.") : t("The photos marked Can't share can't be marked OK to share: only JPEG and PNG photos can be posted.")}</p>}
      {count > 0 && clientOptOut && shareToggleState(session, { content_type: "image/jpeg" }) !== "hidden" && <p className="field-hint">{t("This client asked us not to post photos of their property.")}</p>}
      <PhotoPicker photos={photos} ids={{ add: "visit-add-photos", draw: "visit-draw-photo" }} />
      {gallery.dialog}
    </Section>
  );
}

/** A photo that hasn't uploaded yet, shown from the phone, with where it stands. */
function WaitingPhoto({ photo, onRemove }: { photo: PhonePhoto; onRemove: () => void }) {
  const [url, setUrl] = useState<string>();
  // Drawn on as it was added: shown with the drawing, as it will be once it's up.
  const shown = photo.marked?.body ?? photo.body;
  useEffect(() => {
    const made = URL.createObjectURL(shown);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [shown]);
  return (
    <div className="thumb">
      {url && <img src={url} alt={photo.fileName} />}
      {!photo.sending && <button type="button" className="thumb-x" aria-label={t("Remove photo")} onClick={onRemove}><Icon name="x" size={12} bold /></button>}
      <span className="thumb-note">{photo.problem ? t("Didn't upload") : photo.sending ? t("Uploading…") : photo.kept ? t("Waiting to send") : t("Not saved")}</span>
    </div>
  );
}

/** A signature on a checklist: the person signs on the screen and prints their name. */
function SignatureAnswer({ label, required, value, disabled, onChange }: { label: string; required: boolean; value: unknown; disabled: boolean; onChange: (next: { name: string; image: string | null } | null) => void }) {
  // Older checklists stored a typed name.
  const legacy = typeof value === "string" ? value : null;
  const current = value && typeof value === "object" ? (value as { name?: string; image?: string | null }) : null;
  return (
    <div className="field check-field">
      <span>{label}{required && <Required />}</span>
      {legacy ? (
        <span style={{ fontFamily: "'Brush Script MT', cursive", fontSize: 24 }}>{legacy}</span>
      ) : (
        <>
          <SignaturePad value={current?.image ?? null} disabled={disabled} label={t("Sign with your finger")} onChange={(image) => onChange(image || current?.name ? { name: current?.name ?? "", image } : null)} />
          <input className="input" aria-label={t("Printed name")} placeholder={t("Printed name")} value={current?.name ?? ""} disabled={disabled} maxLength={120} onChange={(e) => onChange({ name: e.target.value, image: current?.image ?? null })} />
        </>
      )}
    </div>
  );
}
