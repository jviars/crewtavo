/**
 * One applicant: what they told the business and their résumé, then the office's own side of it:
 * where it stands, a rating, the interview, notes, and the other times they applied. Once they're
 * hired, inviting them to the team is a click away for people who manage it.
 */
import { ADMINS } from "@crewtavo/core/roles";
import { APPLICANT_STATUSES, applicantStatusLabel, DETAIL_LABELS, FILE_ACCEPT, fileLabel, fileSize, isResume, type ApplicantFile, type ApplicantStatus } from "@crewtavo/core/careers";
import { fieldLabel } from "@crewtavo/core/websiteForms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, NoAccess, PageError } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap, unwrapOne } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { can, useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { ContactLine } from "../clients/ContactsCard";
import { WebVisitRows } from "../marketing/WebVisitRows";
import { APPLICANT_FIELDS, APPLICANT_TONES, deleteApplicant, fileLinks, filesJson, isWaiting, otherApplications, refreshApplicants, seesApplicants, uploadApplicantFile, type Applicant } from "./applicants";
import styles from "./Applicants.module.css";

/** The next step from each status, as the page's main button. */
const NEXT: Partial<Record<ApplicantStatus, { label: string; icon: IconName; to: ApplicantStatus }>> = {
  new: { label: "Start reviewing", icon: "eye", to: "reviewing" },
  reviewing: { label: "Set up an interview", icon: "calendar", to: "interview" },
  interview: { label: "Make an offer", icon: "send", to: "offer" },
  offer: { label: "Mark as hired", icon: "check", to: "hired" },
};

type Patch = Partial<Pick<Applicant, "status" | "rating" | "interview_at" | "notes" | "name" | "email" | "phone" | "position" | "location" | "start_date" | "availability" | "desired_pay" | "experience" | "drivers_license" | "heard_from" | "message">> & { files?: ApplicantFile[] };

export function ApplicantPage() {
  const session = useSession();
  if (!seesApplicants(session)) return <NoAccess title="Applicants" />;
  return <ApplicantDetail />;
}

function ApplicantDetail() {
  const { id = "" } = useParams();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<null | "edit" | "interview">(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const companyId = session.company.id;
  const tz = session.company.timezone;

  const item = useQuery({
    queryKey: ["applicants", companyId, "item", id],
    // The file links last an hour; fetch new ones well before then.
    refetchInterval: 45 * 60_000,
    queryFn: async () => {
      // The form's name only shows for people who see forms (owners and admins who connect apps).
      const row = unwrapOne(await supabase().from("job_applicants").select(`${APPLICANT_FIELDS}, form:website_forms(name)`).eq("company_id", companyId).eq("id", id).maybeSingle(), "This applicant") as unknown as Applicant & { form: { name: string } | null };
      const links = await fileLinks(row.files).catch(() => ({}) as Awaited<ReturnType<typeof fileLinks>>);
      return { ...row, links };
    },
  });
  const a = item.data;
  const others = useQuery({
    queryKey: ["applicants", companyId, "others", id, a?.email ?? null, a?.phone ?? null],
    enabled: Boolean(a),
    meta: { silent: true },
    queryFn: () => otherApplications(companyId, a!),
  });

  const save = useMutation({
    meta: {
      success: (_: unknown, p: Patch) =>
        // Notes and the rating save where they're changed, and say so there.
        p.status ? `Moved to ${applicantStatusLabel(p.status)}` : "notes" in p || "rating" in p ? null : "interview_at" in p ? (p.interview_at ? "Interview set" : "Interview cleared") : "Details saved",
    },
    mutationFn: async (patch: Patch) => unwrap(await supabase().from("job_applicants").update({ ...patch, files: patch.files && filesJson(patch.files) }).eq("id", id)),
    onSuccess: () => refreshApplicants(queryClient),
  });
  // The file appearing in the list, or leaving it, says it worked.
  const addFile = useMutation({
    mutationFn: async (file: File) => {
      const added = await uploadApplicantFile(companyId, id, file, a!.files.some((f) => isResume(f, a!.files)) ? "attachment" : "resume");
      const { error } = await supabase().from("job_applicants").update({ files: filesJson([...a!.files, added]) }).eq("id", id);
      if (error) {
        await supabase().storage.from("files").remove([added.path]);
        throw new Error(/check constraint/i.test(error.message) ? "An applicant can have up to 5 files. Remove one first." : error.message);
      }
    },
    onSuccess: () => refreshApplicants(queryClient),
  });
  const removeFile = useMutation({
    mutationFn: async (file: ApplicantFile) => {
      unwrap(await supabase().from("job_applicants").update({ files: filesJson(a!.files.filter((f) => f.path !== file.path)) }).eq("id", id));
      await supabase().storage.from("files").remove([file.path]);
    },
    onSuccess: () => refreshApplicants(queryClient),
  });
  const remove = useMutation({
    meta: { success: "Applicant deleted" },
    mutationFn: () => deleteApplicant(a!),
    onSuccess: () => {
      refreshApplicants(queryClient);
      navigate("/applicants", { replace: true });
    },
  });

  const notesSaved = useJustDone(save) && Boolean(save.variables && "notes" in save.variables);
  if (item.isPending) return <DetailSkeleton />;
  if (item.error || !a) return <PageError error={item.error} onRetry={() => item.refetch()} back={<BackLink to="/applicants">Applicants</BackLink>} />;

  const first = a.name.split(/\s+/)[0] || a.name;
  const next = NEXT[a.status];
  const details = (Object.keys(DETAIL_LABELS) as Array<keyof typeof DETAIL_LABELS>).filter((k) => a[k]);
  const answers = Object.entries(a.answers ?? {}).filter(([, v]) => v !== "" && v != null && !(Array.isArray(v) && !v.length));
  const managesTeam = ADMINS.includes(session.role) && can(session, "team");
  const step = () => (next?.to === "interview" ? setDialog("interview") : next && save.mutate({ status: next.to }));
  const askDelete = async () => {
    const ok = await confirm({
      title: `Delete ${a.name}'s application?`,
      body: a.files.length ? "Their résumé and other files are deleted too. This can't be undone." : "This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) remove.mutate();
  };

  return (
    <>
      <BackLink to="/applicants">Applicants</BackLink>
      <PageHeader
        title={a.name}
        actions={
          <>
            {next && <Button variant="primary" icon={next.icon} loading={save.isPending && save.variables?.status === next.to} onClick={step}>{next.label}</Button>}
            <Menu
              items={[
                { label: "Edit details", icon: "edit", onSelect: () => setDialog("edit") },
                { label: a.files.length ? "Add a file" : "Add their résumé", icon: "upload", onSelect: () => fileInput.current?.click() },
                { label: a.interview_at ? "Change the interview" : "Set an interview time", icon: "calendar", onSelect: () => setDialog("interview") },
                { separator: true },
                { label: "Not hired", icon: "x", hidden: a.status === "not_hired" || a.status === "hired", onSelect: () => save.mutate({ status: "not_hired" }) },
                { label: "Reopen", icon: "undo", hidden: a.status !== "not_hired", onSelect: () => save.mutate({ status: "reviewing" }) },
                { label: "Delete applicant", icon: "trash", danger: true, onSelect: askDelete },
              ]}
            />
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept={FILE_ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) addFile.mutate(file);
        }}
      />
      <div className="page-meta">
        <StatusPill label={applicantStatusLabel(a.status)} tone={APPLICANT_TONES[a.status]} />
        {a.position && <span className="chip">{a.position}</span>}
        <span className="muted" title={formatDateTime(a.created_at, tz)}>Applied {timeAgo(a.created_at)}</span>
      </div>

      {isWaiting(a) && (
        <div className="callout callout-warning"><Icon name="clock" size={20} /><div className="grow">{first} applied {timeAgo(a.created_at)} and hasn't heard back yet.</div></div>
      )}
      {a.status === "interview" && a.interview_at && (
        <div className="callout callout-info"><Icon name="calendar" size={20} /><div className="grow">Interview {formatDateTime(a.interview_at, tz)}.</div></div>
      )}
      {a.status === "hired" && (
        <div className="callout callout-good" role="status">
          <Icon name="check" size={20} />
          <div className="grow">
            {managesTeam ? `Hired. Invite ${first} to your team so they can sign in and see their visits.` : `Hired. An admin can invite ${first} to your team in Settings → People.`}
          </div>
          {managesTeam && <Button size="sm" icon="users" onClick={() => navigate("/settings?tab=team", { state: { invite: { name: a.name, email: a.email ?? "" } } })}>Invite to your team</Button>}
        </div>
      )}

      <div className="two-col">
        <div className="wide stack-lg">
          <section className="card card-pad stack-sm">
            <strong>About {first}</strong>
            {details.length || answers.length ? (
              <dl className="kv" style={{ marginTop: 4 }}>
                {details.map((k) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt>{DETAIL_LABELS[k]}</dt>
                    <dd className="pre-wrap">{a[k]}</dd>
                  </div>
                ))}
                {answers.map(([key, value]) => (
                  <div key={key} style={{ display: "contents" }}>
                    {/* The form's other questions, under its own field names. */}
                    <dt>{fieldLabel(key)}</dt>
                    <dd className="pre-wrap">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <span className="muted">Nothing else was sent with the application.</span>
            )}
            {a.message && (
              <>
                <strong style={{ marginTop: 10 }}>In {first === a.name ? "their" : `${first}'s`} words</strong>
                <p className="pre-wrap" style={{ margin: 0 }}>{a.message}</p>
              </>
            )}
          </section>

          <section className="stack">
            <div className="section-head">
              <h2 className="section-title">Résumé and files</h2>
              {a.files.length > 0 && a.files.length < 5 && <Button size="sm" icon="upload" loading={addFile.isPending} slowHint={false} onClick={() => fileInput.current?.click()}>Add a file</Button>}
            </div>
            <div className="card">
              {a.files.length === 0 && (
                <EmptyState inline title="No résumé yet" action={<Button loading={addFile.isPending} slowHint={false} onClick={() => fileInput.current?.click()}>Add their résumé</Button>} />
              )}
              {a.files.map((f) => {
                const link = a.links[f.path];
                return (
                  <div key={f.path} className="card-row">
                    <Icon name="file" size={20} />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <strong style={{ display: "block" }}>{isResume(f, a.files) ? "Résumé" : fileLabel(f.field)}</strong>
                      <span className="muted small" style={{ overflowWrap: "anywhere" }}>{f.name} · {fileSize(f.size)}</span>
                    </span>
                    {link && <a className="btn btn-sm" href={link.open} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open</a>}
                    {link && <a className="btn btn-sm btn-icon" href={link.save} aria-label={`Download ${f.name}`} title="Download"><Icon name="download" size={14} /></a>}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Remove ${f.name}`}
                      onClick={async () => (await confirm({ title: `Remove ${f.name}?`, body: "The file is deleted. This can't be undone.", confirmLabel: "Remove", danger: true })) && removeFile.mutate(f)}
                    />
                  </div>
                );
              })}
            </div>
          </section>

          <NotesCard key={a.notes ?? ""} notes={a.notes} saving={save.isPending && save.variables && "notes" in save.variables} saved={notesSaved} onSave={(notes) => save.mutate({ notes })} />
        </div>

        <aside className="narrow stack">
          <div className="card card-pad stack-sm">
            <strong style={{ fontSize: 16 }}>{a.name}</strong>
            {a.email && <ContactLine icon="mail" href={`mailto:${a.email}`}>{a.email}</ContactLine>}
            {a.phone && <ContactLine icon="phone" href={`tel:${a.phone}`}>{a.phone}</ContactLine>}
            {a.phone && <a href={`sms:${a.phone}`} className="row small" style={{ gap: 8 }}><Icon name="messages" size={14} />Text them</a>}
            {a.location && <span className="row muted small" style={{ gap: 8 }}><Icon name="pin" size={14} />{a.location}</span>}
          </div>

          <div className="card card-pad stack-sm">
            <strong>Where it stands</strong>
            <Field label="Status">
              <select className="select" value={a.status} onChange={(e) => save.mutate({ status: e.target.value as ApplicantStatus })}>
                {APPLICANT_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </Field>
            <span className="muted small">Since {formatDate(a.status_changed_at)} ({timeAgo(a.status_changed_at)})</span>
            <div className="stack-sm" style={{ gap: 4, marginTop: 6 }}>
              <span className="small strong">Your rating</span>
              <Stars value={a.rating} onChange={(rating) => save.mutate({ rating })} />
            </div>
            <div className="row-between" style={{ gap: 8, marginTop: 6 }}>
              <span className="small">
                <span className="strong">Interview</span>
                <span className="muted" style={{ display: "block" }}>{a.interview_at ? formatDateTime(a.interview_at, tz) : "Not set"}</span>
              </span>
              <Button size="sm" onClick={() => setDialog("interview")}>{a.interview_at ? "Change" : "Set a time"}</Button>
            </div>
          </div>

          <div className="card card-pad stack-sm">
            <strong>Application</strong>
            <dl className="kv">
              <dt>Applied</dt><dd>{formatDateTime(a.created_at, tz)}</dd>
              <dt>Through</dt><dd>{a.website_form_id ? (a.form ? `Your website's ${a.form.name}` : "Your website") : "Added by the office"}</dd>
              {a.web_visit && <WebVisitRows visit={a.web_visit} did="applied" />}
            </dl>
            {(others.data?.length ?? 0) > 0 && (
              <div className="stack-sm" style={{ gap: 6, marginTop: 8 }}>
                <span className="small strong">Applied before</span>
                {others.data!.map((o) => (
                  <Link key={o.id} to={`/applicants/${o.id}`} className="small">
                    {o.position ?? "An application"}, {formatDate(o.created_at)} · {applicantStatusLabel(o.status)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {dialog === "edit" && <EditApplicantDialog applicant={a} onClose={() => setDialog(null)} onSave={(patch) => save.mutateAsync(patch).then(() => setDialog(null))} />}
      {dialog === "interview" && (
        <InterviewDialog
          name={first}
          value={a.interview_at}
          onClose={() => setDialog(null)}
          onSave={(interview_at) => save.mutateAsync({ interview_at, ...(interview_at && (a.status === "new" || a.status === "reviewing") ? { status: "interview" as const } : {}) }).then(() => setDialog(null))}
        />
      )}
    </>
  );
}

/** One to five stars; the star that's set clears it. */
function Stars({ value, onChange }: { value: number | null; onChange: (value: number | null) => void }) {
  return (
    <div className={styles.stars} role="group" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className={value !== null && n <= value ? styles.on : undefined} aria-pressed={value === n} aria-label={`${n} ${n === 1 ? "star" : "stars"}`} onClick={() => onChange(value === n ? null : n)}>
          <Icon name="star" size={20} />
        </button>
      ))}
    </div>
  );
}

function NotesCard({ notes, saving, saved, onSave }: { notes: string | null; saving: boolean | undefined; saved: boolean; onSave: (notes: string | null) => void }) {
  const [text, setText] = useState(notes ?? "");
  const dirty = text.trim() !== (notes ?? "");
  return (
    <section className="card card-pad stack-sm">
      <strong>Notes</strong>
      <span className="muted small">For the office: how the call went, references, what to ask in the interview. The applicant never sees them.</span>
      <textarea className="textarea" rows={5} maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Notes" />
      <Button style={{ justifySelf: "start" }} loading={saving} done={saved} disabled={!dirty && !saved} onClick={() => onSave(text.trim() || null)}>Save notes</Button>
    </section>
  );
}

/** A datetime-local value in this browser's time, for a stored time. */
const localInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function InterviewDialog({ name, value, onClose, onSave }: { name: string; value: string | null; onClose: () => void; onSave: (at: string | null) => Promise<unknown> }) {
  const [at, setAt] = useState(localInput(value));
  const [error, setError] = useState<unknown>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (at) onSave(new Date(at).toISOString()).catch(setError);
  };
  return (
    <Dialog open onClose={onClose} title={value ? "Change the interview" : `Interview ${name}`} description="When you're meeting. It shows on their application and in the list.">
      <form onSubmit={submit}>
        <Field label="Date and time"><input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required autoFocus /></Field>
        <FormError error={error} />
        <div className="form-actions">
          {value && <Button variant="ghost" onClick={() => onSave(null).catch(setError)}>Clear it</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditApplicantDialog({ applicant: a, onClose, onSave }: { applicant: Applicant; onClose: () => void; onSave: (patch: Patch) => Promise<unknown> }) {
  const [form, setForm] = useState({
    name: a.name, email: a.email ?? "", phone: a.phone ?? "", position: a.position ?? "", location: a.location ?? "", start_date: a.start_date ?? "",
    availability: a.availability ?? "", desired_pay: a.desired_pay ?? "", experience: a.experience ?? "", drivers_license: a.drivers_license ?? "",
    heard_from: a.heard_from ?? "", message: a.message ?? "",
  });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const blank = (v: string) => v.trim() || null;
    setSaving(true);
    onSave({
      name: form.name.trim(), email: blank(form.email.toLowerCase()), phone: blank(form.phone), position: blank(form.position), location: blank(form.location),
      start_date: blank(form.start_date), availability: blank(form.availability), desired_pay: blank(form.desired_pay), experience: blank(form.experience),
      drivers_license: blank(form.drivers_license), heard_from: blank(form.heard_from), message: blank(form.message),
    }).catch(setError).finally(() => setSaving(false));
  };
  return (
    <Dialog open onClose={onClose} title="Edit details" size="lg">
      <form onSubmit={submit}>
        <Field label="Name"><input className="input" value={form.name} onChange={set("name")} required maxLength={200} /></Field>
        <div className="form-grid">
          <Field label="Email" optional><input className="input" type="email" value={form.email} onChange={set("email")} maxLength={254} /></Field>
          <Field label="Phone" optional><input className="input" type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: formatPhoneTyping(e.target.value) }))} maxLength={30} /></Field>
          <Field label={DETAIL_LABELS.position} optional><input className="input" value={form.position} onChange={set("position")} maxLength={200} /></Field>
          <Field label={DETAIL_LABELS.location} optional><input className="input" value={form.location} onChange={set("location")} maxLength={300} /></Field>
          <Field label={DETAIL_LABELS.start_date} optional><input className="input" value={form.start_date} onChange={set("start_date")} maxLength={100} /></Field>
          <Field label={DETAIL_LABELS.availability} optional><input className="input" value={form.availability} onChange={set("availability")} maxLength={300} /></Field>
          <Field label={DETAIL_LABELS.desired_pay} optional><input className="input" value={form.desired_pay} onChange={set("desired_pay")} maxLength={100} /></Field>
          <Field label={DETAIL_LABELS.drivers_license} optional><input className="input" value={form.drivers_license} onChange={set("drivers_license")} maxLength={100} /></Field>
        </div>
        <Field label={DETAIL_LABELS.experience} optional><textarea className="textarea" rows={2} value={form.experience} onChange={set("experience")} maxLength={5000} /></Field>
        <Field label={DETAIL_LABELS.heard_from} optional><input className="input" value={form.heard_from} onChange={set("heard_from")} maxLength={200} /></Field>
        <Field label="In their words" optional><textarea className="textarea" rows={4} value={form.message} onChange={set("message")} maxLength={5000} /></Field>
        <FormError error={error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
