/**
 * Online booking: public request forms, their questions and service area, links to share or embed,
 * and for an estimate or booking form, letting clients pick a time from the schedule's openings.
 */
import { businessCountry } from "@crewtavo/core/countries";
import { formSlug as slugify, isPostalCode, normalizeIntakeForm } from "@crewtavo/core/forms";
import { privacyUrl } from "@crewtavo/core/privacyPolicy";
import { slotLabel, type OpenSlot } from "@crewtavo/core/slots";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { InboxSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { companyCountry } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { areaWords } from "../settings/salesAreas";
import { EmbedDialog } from "./EmbedDialog";
import ui from "./BookingAdmin.module.css";
import { Select } from "@/components/ui/Select";

const KIND: Record<string, string> = { request: "Request form", assessment: "Book an estimate", booking: "Book a service" };
/** What each kind of form looks like in the list: a request, or a time on the calendar. */
const KIND_ICON: Record<string, IconName> = { request: "requests", assessment: "calendarCheck", booking: "calendar" };
type QType = "text" | "long_text" | "number" | "yes_no" | "choice" | "multi_choice" | "files" | "photos";
interface Question { key: string; label: string; type: QType | "address"; required: boolean; options?: string[] }
interface FormRow {
  id: string; slug: string; name: string; kind: string; active: boolean; questions: Question[]; service_area_zips: string[];
  // Picking a time: whether clients can, how long a visit is, how soon and how many a day, whose time it books, and whether the office confirms first.
  pick_time: boolean; slot_minutes: number | null; lead_time_days: number; max_per_day: number | null; crew_id: string | null; requires_approval: boolean;
}
/** How long a visit booked online can be, as the form offers them. */
const LENGTHS: Array<[number, string]> = [[30, "30 minutes"], [45, "45 minutes"], [60, "1 hour"], [90, "1 hour 30 minutes"], [120, "2 hours"], [180, "3 hours"], [240, "4 hours"]];
// Files and Photos: what people send go in Plans and files on the request (and on to its quote and job).
const QTYPES: Array<[QType, string]> = [["text", "Short answer"], ["long_text", "Paragraph"], ["number", "Number"], ["yes_no", "Yes / no"], ["choice", "Pick one"], ["multi_choice", "Pick any"], ["files", "Files (plans, PDFs)"], ["photos", "Photos"]];

export function BookingAdminPage() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  // The form open in its dialog, kept in the address (?form=<id>, or "new"), so each row is a link and Back closes it.
  const [params, setParams] = useSearchParams();
  const opened = params.get("form");
  const openForm = (id: string) => setParams((p) => { p.set("form", id); return p; });
  const closeForm = () => setParams((p) => { p.delete("form"); return p; }, { replace: true });
  const [embedding, setEmbedding] = useState<FormRow | null>(null);
  const canEdit = hasRole(session, "admin", "office") && can(session, "settings");
  const forms = useQuery({
    queryKey: ["intake-forms", company.id],
    queryFn: async () => unwrap(await supabase().from("intake_forms").select("id, slug, name, kind, active, questions, service_area_zips, pick_time, slot_minutes, lead_time_days, max_per_day, crew_id, requires_approval").eq("company_id", company.id).order("name")) as unknown as FormRow[],
  });
  const counts = useQuery({
    queryKey: ["intake-forms", company.id, "counts"],
    meta: { silent: true },
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const rows = unwrap(await supabase().from("requests").select("intake_form_id").eq("company_id", company.id).not("intake_form_id", "is", null).gte("created_at", since));
      return rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.intake_form_id!]: (m[r.intake_form_id!] ?? 0) + 1 }), {});
    },
  });
  const toggle = useMutation({
    meta: { success: (_: unknown, v: { active: boolean }) => (v.active ? "Form is live" : "Form turned off") },
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => unwrap(await supabase().from("intake_forms").update({ active }).eq("id", id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] }),
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("intake_forms").delete().eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] }),
  });
  // Gone at once, with Undo; its link keeps working until it's deleted for real. Requests it brought in are kept.
  const deleteForm = (form: FormRow) => {
    const key = ["intake-forms", company.id];
    undoable({
      title: "Form deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key, exact: true });
        queryClient.setQueryData<FormRow[]>(key, (old) => old?.filter((f) => f.id !== form.id));
      },
      restore: () => queryClient.setQueryData<FormRow[]>(key, (old) => (old && !old.some((f) => f.id === form.id) ? [...old, form].sort((a, b) => a.name.localeCompare(b.name)) : old)),
      commit: () => remove.mutateAsync(form.id),
    });
  };
  const link = (slug: string) => `${window.location.origin}/book/${company.slug}/${slug}`;
  const rows = forms.data ?? [];
  const open = opened && opened !== "new" ? rows.find((f) => f.id === opened) ?? null : null;
  const total = rows.reduce((n, f) => n + (counts.data?.[f.id] ?? 0), 0);

  /** A form's links: copy, open, or the code for a website. Grouped under Share in its More menu. */
  const share = (f: FormRow): MenuEntry[] => [
    { label: "Copy link", icon: "copy", kbd: "C", onSelect: () => copyText(link(f.slug), "Link copied") },
    { label: "Open the form", icon: "external", kbd: "O", onSelect: () => window.open(link(f.slug), "_blank", "noopener,noreferrer") },
    { label: "Put it on your website", icon: "code", kbd: "W", onSelect: () => setEmbedding(f) },
  ];
  const more = (f: FormRow): MenuEntry[] =>
    canEdit
      ? [
          { label: "Edit form", icon: "edit", kbd: "E", onSelect: () => openForm(f.id) },
          { label: "Share", icon: "share", items: share(f) },
          { label: f.active ? "Turn off" : "Turn on", icon: f.active ? "pause" : "play", onSelect: () => toggle.mutate({ id: f.id, active: !f.active }) },
          { separator: true },
          { label: "Delete form", icon: "trash", danger: true, onSelect: () => deleteForm(f) },
        ]
      : share(f);

  return (
    <>
      <BackLink to="/settings">Settings</BackLink>
      <PageHeader
        title="Online booking"
        lede="Forms clients use to ask for work or book a time. Share a form's link, or put the form on your website."
        actions={canEdit && <Button variant="primary" icon="plus" onClick={() => openForm("new")}>New form</Button>}
      />
      {/* For the people who can add it (Settings → Company is the owners' and admins'), while there's none. */}
      {hasRole(session, "admin") && !privacyUrl(company.settings) && (
        <div className="callout callout-info">
          <Icon name="info" size={16} />
          <div className="grow" style={{ fontWeight: 400 }}>
            Forms that collect personal details should link your privacy policy. <Link to="/settings?tab=company">Add the link in Settings → Company</Link> and it shows under every form.
          </div>
        </div>
      )}
      {forms.isPending ? (
        <InboxSkeleton rows={3} />
      ) : forms.error ? (
        <ErrorState error={forms.error} onRetry={() => forms.refetch()} />
      ) : !rows.length ? (
        <EmptyState icon="globe" title="No booking forms yet" action={canEdit && <Button icon="plus" onClick={() => openForm("new")}>Create a form</Button>}>
          A form gets its own link to share, and code to put it on your website. What people send comes in under Requests.
        </EmptyState>
      ) : (
        <InboxList
          label="Booking forms"
          className={ui.list}
          foot={<ListFoot end={counts.data ? <><b>{total}</b> {total === 1 ? "request" : "requests"} in the last 30 days</> : undefined}>{rows.length === 1 ? "1 form" : `${rows.length} forms`}</ListFoot>}
        >
          <InboxGroup>
            {rows.map((f) => {
              const asked = f.questions.filter((q) => q.type !== "address").length;
              const count = counts.data ? counts.data[f.id] ?? 0 : undefined;
              return (
                <InboxRow
                  key={f.id}
                  // Editing for the people who can; for the rest, the form's links and code to share.
                  to={`?form=${f.id}`}
                  title={f.name}
                  avatar={<Icon name={KIND_ICON[f.kind] ?? "globe"} size={16} />}
                  square
                  subject={<span className={ui.link}>{link(f.slug).replace(/^https?:\/\//, "")}</span>}
                  meta={[
                    <StatusPill key="status" label={f.active ? "Live" : "Off"} tone={f.active ? "good" : "muted"} />,
                    KIND[f.kind] ?? f.kind,
                    asked === 1 ? "1 question" : `${asked} questions`,
                    // Where it takes requests from and how times are set: a line of its own on a phone.
                    <span key="where" className="meta-break">
                      {f.service_area_zips.length ? `${f.service_area_zips.length} service area${f.service_area_zips.length === 1 ? "" : "s"}` : "Any area"}
                      {f.pick_time && f.kind !== "request" && <><span className="meta-dot" aria-hidden="true"> · </span>{f.requires_approval ? "Clients ask for a time" : "Clients book a time"}</>}
                    </span>,
                  ]}
                  aside={count !== undefined && <><span className="il-money">{count}</span><span className="il-sub">{count === 1 ? "request" : "requests"}<span className="hide-mobile"> · 30 days</span></span></>}
                  actions={
                    <>
                      <Button size="sm" icon="copy" onClick={() => copyText(link(f.slug), "Link copied")}>Copy link</Button>
                      <Menu label={`More actions for ${f.name}`} title={f.name} triggerClassName="btn btn-sm btn-icon" items={more(f)} />
                    </>
                  }
                />
              );
            })}
          </InboxGroup>
        </InboxList>
      )}
      {embedding && <EmbedDialog name={embedding.name} url={link(embedding.slug)} onClose={() => setEmbedding(null)} />}
      {/* Someone who can't edit gets the form's links and code: what they came here to share. */}
      {open && !canEdit && <EmbedDialog name={open.name} url={link(open.slug)} onClose={closeForm} />}
      {canEdit && (opened === "new" || open) && (
        <FormEditor
          key={opened}
          form={open}
          taken={rows.map((f) => f.slug)}
          link={open ? link(open.slug) : null}
          onEmbed={open ? () => { closeForm(); setEmbedding(open); } : undefined}
          onDelete={open ? () => { closeForm(); deleteForm(open); } : undefined}
          onClose={closeForm}
        />
      )}
    </>
  );
}

function FormEditor({ form, taken, link, onEmbed, onDelete, onClose }: { form: FormRow | null; taken: string[]; link: string | null; onEmbed?: () => void; onDelete?: () => void; onClose: () => void }) {
  const { company } = useSession();
  const words = areaWords(businessCountry(company));
  const queryClient = useQueryClient();
  const [name, setName] = useState(form?.name ?? "Request a quote");
  const [slug, setSlug] = useState(form?.slug ?? "");
  const [kind, setKind] = useState(form?.kind ?? "request");
  const [zips, setZips] = useState((form?.service_area_zips ?? []).join(", "));
  const [active, setActive] = useState(form?.active ?? true);
  // Picking a time. A new form starts with it off, as every form made before it existed is.
  const [pickTime, setPickTime] = useState(form?.pick_time ?? false);
  const [minutes, setMinutes] = useState(form?.slot_minutes ?? 60);
  const [leadDays, setLeadDays] = useState(String(form?.lead_time_days ?? 1));
  const [mostADay, setMostADay] = useState(form?.max_per_day ? String(form.max_per_day) : "");
  const [crewId, setCrewId] = useState(form?.crew_id ?? "");
  const [needsOk, setNeedsOk] = useState(form?.requires_approval ?? false);
  const books = kind !== "request";
  const lead = Math.min(Math.max(Math.round(Number(leadDays)) || 0, 0), 30);
  const most = mostADay.trim() ? Math.min(Math.max(Math.round(Number(mostADay)) || 1, 1), 50) : null;
  const crews = useQuery({
    queryKey: ["crews", company.id, "booking"],
    enabled: books,
    queryFn: async () => unwrap(await supabase().from("crews").select("id, name").eq("company_id", company.id).eq("active", true).order("name").limit(200)),
  });
  const [questions, setQuestions] = useState<Question[]>(form?.questions.filter((q) => q.type !== "address") ?? [{ key: "details", label: "What do you need done?", type: "long_text", required: true }]);
  const finalSlug = slug.trim() ? slugify(slug) : slugify(name);
  const clash = taken.filter((s) => s !== form?.slug).includes(finalSlug);
  // Not split on spaces, which postal codes like "SW1A 1AA" have.
  const zipList = zips.split(/[,;\n]+/).map((z) => z.trim()).filter(Boolean);
  const badZips = zipList.filter((z) => !isPostalCode(z));
  const setQ = (i: number, patch: Partial<Question>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...questions];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    setQuestions(next);
  };

  const save = useMutation({
    meta: { inline: true, success: form ? "Form saved" : "Form created" },
    mutationFn: async () => {
      // Checked and tidied the way an AI assistant's are too (packages/core/src/forms.ts).
      const clean = normalizeIntakeForm({ name, slug, zips: zipList, questions }, taken.filter((s) => s !== form?.slug));
      // A request form never offers times; its other booking settings are left as they were.
      const timing = books ? { pick_time: pickTime, slot_minutes: minutes, lead_time_days: lead, max_per_day: most, crew_id: crewId || null, requires_approval: needsOk } : { pick_time: false };
      const row = { ...clean, kind, questions: clean.questions as never, ...timing };
      if (form) unwrap(await supabase().from("intake_forms").update({ ...row, active }).eq("id", form.id));
      else unwrap(await supabase().from("intake_forms").insert({ ...row, company_id: company.id }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intake-forms", company.id] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={form ? "Edit booking form" : "New booking form"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="form-grid">
          <Field label="Form name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
          <Field label="Type">
            <Select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Link" error={clash ? "Another form uses this link" : null} hint={`${window.location.origin}/book/${company.slug}/${finalSlug}`}>
          <input className="input" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name)} maxLength={50} />
        </Field>
        <Field label={words.serviceLabel} optional error={badZips.length ? `Not a ${words.code}: ${badZips.slice(0, 3).join(", ")}` : null} hint={`Separate them with commas. A code covers every one that starts with it, ${words.serviceExample}. Leave empty to accept any area.`}>
          <textarea className="textarea" style={{ minHeight: 60 }} value={zips} onChange={(e) => setZips(e.target.value)} placeholder={words.servicePlaceholder} />
        </Field>
        {form && (
          <label className={ui.switchRow}>
            <input type="checkbox" className="switch" checked={active} onChange={(e) => setActive(e.target.checked)} />
            <span className="grow">
              <strong>Live</strong>
              <span>{active ? "Its link and the form on your website take requests." : "Off, its link and the form on your website say it isn't available."}</span>
            </span>
          </label>
        )}
        {books && (
          <Section level={3} title="Booking a time">
            <div className={ui.stack}>
              <label className={ui.switchRow}>
                <input type="checkbox" className="switch" checked={pickTime} onChange={(e) => setPickTime(e.target.checked)} />
                <span className="grow">
                  <strong>Let clients pick a time</strong>
                  <span>After the questions they choose a day and a time your schedule has open. Off, the form sends a request and you set the time.</span>
                </span>
              </label>
              {pickTime && (
                <>
                  <div className={ui.grid2}>
                    <Field label="Visit length" hint="How much time each booking takes on the schedule.">
                      <Select className="select" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                        {(LENGTHS.some(([m]) => m === minutes) ? LENGTHS : [...LENGTHS, [minutes, `${minutes} minutes`] as [number, string]]).map(([m, l]) => <option key={m} value={m}>{l}</option>)}
                      </Select>
                    </Field>
                    <Field label="Earliest booking, in days" hint="How many days ahead the first time offered is. 0 lets people book today.">
                      <input className="input" inputMode="numeric" value={leadDays} onChange={(e) => setLeadDays(e.target.value.replace(/\D/g, "").slice(0, 2))} />
                    </Field>
                    <Field label="Most a day" optional hint="The most bookings this form takes for one day. Empty is no limit.">
                      <input className="input" inputMode="numeric" value={mostADay} onChange={(e) => setMostADay(e.target.value.replace(/\D/g, "").slice(0, 2))} />
                    </Field>
                    <Field label="Who it books" hint={crewId ? "Times are offered when this crew is free." : "A time is offered only when nothing else on the schedule has it, so nobody is double-booked."}>
                      <Select className="select" value={crewId} onChange={(e) => setCrewId(e.target.value)}>
                        <option value="">No crew: the whole schedule</option>
                        {(crews.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <label className={ui.switchRow}>
                    <input type="checkbox" className="switch" checked={needsOk} onChange={(e) => setNeedsOk(e.target.checked)} />
                    <span className="grow">
                      <strong>Needs our OK before it's booked</strong>
                      <span>{needsOk ? "The time is held and shows on the request, where you book it with one press. The client is told it isn't confirmed yet." : "The visit goes straight onto the schedule, and the client is told it's booked."}</span>
                    </span>
                  </label>
                  <NextOpenings formId={form?.id} minutes={minutes} leadDays={lead} mostADay={most} crewId={crewId || null} />
                </>
              )}
            </div>
          </Section>
        )}
        <Section
          level={3}
          title="Questions"
          count={questions.length}
          action={<button type="button" disabled={questions.length >= 30} onClick={() => setQuestions([...questions, { key: "", label: "", type: "text", required: false }])}><Icon name="plus" size={14} />Add question</button>}
        >
          <p className={ui.note}>Name, email, phone and address are always asked. Files people send (plans, photos) show on the request under Plans and files.</p>
          {questions.length > 0 && (
            <ol className={ui.questions}>
              {questions.map((q, i) => (
                <li key={i} className={ui.question}>
                  <span className={ui.num} aria-hidden="true">{i + 1}</span>
                  <input className="input" value={q.label} onChange={(e) => setQ(i, { label: e.target.value })} placeholder="Question" maxLength={200} aria-label={`Question ${i + 1}`} />
                  <Select className={`select ${ui.qType}`} value={q.type} onChange={(e) => setQ(i, { type: e.target.value as QType, options: ["choice", "multi_choice"].includes(e.target.value) ? q.options ?? ["Option 1"] : undefined })} aria-label={`Answer type for question ${i + 1}`}>
                    {QTYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                  <span className={ui.qMore}>
                    <Menu
                      label={`More actions for question ${i + 1}`}
                      title={q.label.trim() || `Question ${i + 1}`}
                      triggerClassName="btn btn-icon btn-ghost"
                      items={[
                        { label: "Move up", icon: "chevronUp", disabled: i === 0, onSelect: () => move(i, -1) },
                        { label: "Move down", icon: "chevronDown", disabled: i === questions.length - 1, onSelect: () => move(i, 1) },
                        { separator: true },
                        { label: "Remove question", icon: "trash", danger: true, onSelect: () => setQuestions(questions.filter((_, j) => j !== i)) },
                      ]}
                    />
                  </span>
                  <div className={ui.qSub}>
                    <label className="checkbox small"><input type="checkbox" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} />Required</label>
                    {(q.type === "choice" || q.type === "multi_choice") && <input className="input input-sm grow" value={(q.options ?? []).join(", ")} onChange={(e) => setQ(i, { options: e.target.value.split(",") })} placeholder="Options, separated by commas" aria-label={`Options for question ${i + 1}`} />}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Section>
        {form && link && (
          <Section level={3} title="Share">
            <div className={ui.share}>
              <code className="code-pill grow">{link}</code>
              <Button size="sm" icon="copy" onClick={() => copyText(link, "Link copied")}>Copy link</Button>
              <a className="btn btn-sm" href={link} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>
              {onEmbed && <Button size="sm" icon="code" onClick={onEmbed}>Put it on your website</Button>}
            </div>
          </Section>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          {onDelete && <Button variant="danger" icon="trash" className={`btn-ghost ${ui.delete}`} onClick={onDelete}>Delete form</Button>}
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={clash || badZips.length > 0}>{form ? "Save form" : "Create form"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The next few times a client would be offered with these settings, as a check before saving. */
function NextOpenings({ formId, minutes, leadDays, mostADay, crewId }: { formId?: string; minutes: number; leadDays: number; mostADay: number | null; crewId: string | null }) {
  const { company } = useSession();
  const typed = { form_id: formId, slot_minutes: minutes, lead_time_days: leadDays, max_per_day: mostADay, crew_id: crewId };
  // Asked for once the typing stops.
  const [asked, setAsked] = useState(typed);
  const key = JSON.stringify(typed);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(JSON.parse(key)), 500);
    return () => clearTimeout(timer);
  }, [key]);
  const next = useQuery({
    queryKey: ["booking-next-openings", company.id, asked],
    meta: { silent: true },
    placeholderData: keepPreviousData,
    queryFn: () => api.post<{ timezone: string; timezone_label: string; window_min: number; slots: OpenSlot[] }>("/booking-forms/openings", asked),
  });
  return (
    <div className={ui.openings} aria-live="polite">
      <strong>The next times a client would see</strong>
      {next.isPending ? (
        <span className="muted small">Looking at your schedule…</span>
      ) : next.error || !next.data ? (
        <span className="muted small">The open times couldn't be read just now. They'll show here once they can.</span>
      ) : next.data.slots.length === 0 ? (
        <span className="muted small">Nothing is open in the next 60 days with these settings. Check your working days and hours in Settings → Company, and what's on the schedule.</span>
      ) : (
        <>
          <div className={ui.chips}>{next.data.slots.map((slot) => <span key={slot.starts_at} className="chip">{slotLabel(slot, next.data.timezone, next.data.window_min, companyCountry())}</span>)}</div>
          <span className="muted small">In {next.data.timezone_label}, from your working hours and what's already on the schedule.</span>
        </>
      )}
    </div>
  );
}
