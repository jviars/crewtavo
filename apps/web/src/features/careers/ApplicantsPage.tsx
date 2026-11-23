/**
 * Applicants (Apps → Crewtavo - Careers): everyone who applied through the website's careers form,
 * or that the office added (a walk-in, a call, a job board), newest first, with where each stands.
 */
import { APPLICANT_STATUSES, FILE_ACCEPT, fileSize, OPEN_STATUSES } from "@crewtavo/core/careers";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button, cx } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot, RowAge, shortAge } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { supabase, textFilter, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession } from "@/lib/session";
import { formatPhoneTyping } from "@/lib/validate";
import { filesJson, isWaiting, refreshApplicants, seesApplicants, uploadApplicantFile, WAITING_DAYS, type Applicant } from "./applicants";
import styles from "./Applicants.module.css";

const FILTERS = [
  { key: "open", label: "Open", statuses: OPEN_STATUSES },
  { key: "new", label: "New", statuses: ["new"] },
  { key: "interview", label: "Interviews", statuses: ["interview", "offer"] },
  { key: "hired", label: "Hired", statuses: ["hired"] },
  { key: "not_hired", label: "Not hired", statuses: ["not_hired"] },
  { key: "all", label: "All", statuses: null },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
/** Filters whose count is worth showing: the ones still being decided. */
const COUNTED: readonly FilterKey[] = ["open", "new", "interview"];

type Row = Pick<Applicant, "id" | "status" | "name" | "email" | "phone" | "position" | "availability" | "files" | "interview_at" | "created_at" | "status_changed_at" | "website_form_id">;

/** The list by where each application stands, in the order they move through: new first. Empty statuses are left out. */
export function groupApplicants<T extends Pick<Row, "status">>(rows: readonly T[]) {
  return APPLICANT_STATUSES.map((s) => ({ key: s.key, label: s.label, rows: rows.filter((r) => r.status === s.key) })).filter((g) => g.rows.length > 0);
}

export function ApplicantsPage() {
  const session = useSession();
  if (!seesApplicants(session)) return <NoAccess title="Applicants" />;
  return <ApplicantList />;
}

function ApplicantList() {
  const session = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<FilterKey>(() => (FILTERS.find((x) => x.key === params.get("status"))?.key as FilterKey | undefined) ?? "open");
  const [position, setPosition] = useState("");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim());
  const adding = params.get("new") === "1";
  const setAdding = (on: boolean) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (on) next.set("new", "1");
      else next.delete("new");
      return next;
    }, { replace: true });
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses;
  const counts = useStatusCounts("job_applicants", session.company.id, Object.fromEntries(FILTERS.map((f) => [f.key, f.statuses])));
  const installed = featureOn(session.company.settings, "careers");
  const setsUpApps = hasRole(session, "admin") && can(session, "apps");
  const tz = session.company.timezone;

  // Every position people have applied for, for the filter.
  const positions = useQuery({
    queryKey: ["applicants", session.company.id, "positions"],
    meta: { silent: true },
    queryFn: async () => {
      const rows = unwrap(await supabase().from("job_applicants").select("position").eq("company_id", session.company.id).not("position", "is", null).order("created_at", { ascending: false }).limit(1000));
      return [...new Set(rows.map((r) => r.position!.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    },
  });
  const applicants = useQuery({
    queryKey: ["applicants", session.company.id, filter, term, position],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase()
        .from("job_applicants")
        .select("id, status, name, email, phone, position, availability, files, interview_at, created_at, status_changed_at, website_form_id")
        .eq("company_id", session.company.id)
        .order("created_at", { ascending: false })
        .limit(300);
      if (statuses) q = q.in("status", [...statuses]);
      if (position) q = q.eq("position", position);
      const match = textFilter(term, ["name", "email", "phone", "position"]);
      if (match) q = q.or(match);
      return unwrap(await q) as unknown as Row[];
    },
  });

  if (applicants.isPending) return <InboxPageSkeleton tabs={6} groups={2} />;
  const rows = applicants.data ?? [];
  const noun = filter === "open" ? (rows.length === 1 ? "open application" : "open applications") : rows.length === 1 ? "application" : "applications";

  return (
    <>
      <PageHeader
        title="Applicants"
        actions={
          <>
            {setsUpApps && <Link to="/apps/careers" className="btn"><Icon name="settings" size={16} />Careers form</Link>}
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add applicant</Button>
          </>
        }
      />
      <Toolbar
        filters={
          <FilterTabs
            label="Filter applicants"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) => ({ value: f.key, label: f.label, count: counts.data && (COUNTED.includes(f.key) || f.key === filter) ? counts.data[f.key] : undefined }))}
          />
        }
        search={<SearchField value={search} onChange={setSearch} placeholder="Name, email, phone or position" label="Search applicants" />}
        tools={
          (positions.data?.length ?? 0) > 1 && (
            <Menu
              align="end"
              label={position ? `Position: ${position}` : "Every position"}
              title="Position"
              triggerClassName={cx("btn btn-sm btn-ghost toolbar-btn", position && "is-on")}
              trigger={<><Icon name="filter" size={15} /><span className="toolbar-btn-text">{position || "Every position"}</span></>}
              items={[
                { label: "Every position", checked: !position, onSelect: () => setPosition("") },
                { separator: true },
                ...positions.data!.map((p) => ({ label: p, checked: position === p, onSelect: () => setPosition(p) })),
              ]}
            />
          )
        }
      />
      {applicants.error && !applicants.data ? (
        <ErrorState error={applicants.error} onRetry={() => applicants.refetch()} />
      ) : rows.length === 0 ? (
        term || position ? (
          <EmptyState icon="search" title="No applicants match" action={<Button onClick={() => { setSearch(""); setPosition(""); }}>Clear search</Button>} />
        ) : !installed && counts.data?.all === 0 ? (
          <EmptyState icon="user" title="Take applications from your website" action={setsUpApps && <Link to="/apps/careers" className="btn">Set up Careers</Link>}>
            {setsUpApps
              ? "Install Careers in Apps and point the Apply form on your website at it. Each application lands here, résumé and all."
              : "An admin can install Careers in Apps so applications from your website land here, résumé and all."}
          </EmptyState>
        ) : (
          <EmptyState icon="user" title={filter === "open" ? "No open applications" : "Nobody here"} action={filter === "open" && <Button icon="plus" onClick={() => setAdding(true)}>Add applicant</Button>}>
            {filter === "open" ? "Applications from your website's careers form land here as they arrive. Add people who apply in person or on a job board too." : "No applicants have this status."}
          </EmptyState>
        )
      ) : (
        <InboxList label="Applicants" stale={applicants.isPlaceholderData} foot={<ListFoot>{rows.length} {noun}</ListFoot>}>
          {groupApplicants(rows).map((g) => (
            <InboxGroup key={g.key} label={g.label} count={g.rows.length}>
              {g.rows.map((a) => {
                const waiting = isWaiting(a);
                const interview = a.status === "interview" && a.interview_at;
                const contact = [a.email, a.phone].filter(Boolean).join(" · ");
                const files = a.files.length === 0 ? "No résumé" : a.files.length === 1 ? "Résumé attached" : `${a.files.length} files`;
                // A phone's second line is what they applied for and whether a résumé came with it (Mobile-Team, Applicants).
                const applied = a.position ? [a.position, a.files.length ? files.toLowerCase() : null].filter(Boolean).join(" · ") : a.files.length ? files : contact;
                return (
                  <InboxRow
                    key={a.id}
                    to={`/applicants/${a.id}`}
                    title={a.name}
                    badge={a.position ? <span className={cx("tag", styles.desk)}>{a.position}</span> : undefined}
                    unread={a.status === "new" ? "New" : undefined}
                    subject={
                      contact || applied ? (
                        <>
                          {contact && <span className={styles.desk}>{contact}</span>}
                          {applied && <span className={styles.phone}>{applied}</span>}
                        </>
                      ) : undefined
                    }
                    meta={[
                      <span key="files" className={styles.desk}><Icon name="file" size={13} />{files}</span>,
                      a.availability,
                      interview && <span key="at" className={cx(styles.interview, "meta-break")}><Icon name="calendar" size={13} />Interview {formatDateTime(a.interview_at!, tz)}</span>,
                    ]}
                    aside={
                      <>
                        {a.status === "offer" ? <span className="il-age" title={formatDateTime(a.status_changed_at, tz)}>{shortAge(a.status_changed_at)}</span> : <RowAge at={a.created_at} tone={waiting ? "warning" : undefined} timeZone={tz} />}
                        {waiting ? (
                          <span className={cx("il-sub", styles.wait)} data-tone="warning">Waiting over {WAITING_DAYS} days</span>
                        ) : a.status === "offer" ? (
                          <span className="il-sub">Waiting on their answer</span>
                        ) : a.status === "new" && a.website_form_id ? (
                          <span className="il-sub">From your website</span>
                        ) : null}
                      </>
                    }
                  />
                );
              })}
            </InboxGroup>
          ))}
        </InboxList>
      )}
      {adding && <AddApplicantDialog onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); navigate(`/applicants/${id}`); }} />}
    </>
  );
}

/** Someone who applied another way: in person, by phone, on a job board. Their résumé can come along. */
function AddApplicantDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [position, setPosition] = useState("");
  const [heardFrom, setHeardFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const add = useMutation({
    meta: { inline: true, success: "Applicant added" },
    mutationFn: async () => {
      const id = crypto.randomUUID();
      const files = file ? [await uploadApplicantFile(session.company.id, id, file, "resume")] : [];
      // If the database turns the applicant down, the résumé is left with no row and the server tidies it away after a day.
      unwrap(await supabase().from("job_applicants").insert({
        id, company_id: session.company.id, name: name.trim(), email: email.trim().toLowerCase() || null, phone: phone.trim() || null,
        position: position.trim() || null, heard_from: heardFrom.trim() || null, notes: notes.trim() || null, files: filesJson(files), created_by: session.userId,
      }));
      return id;
    },
    onSuccess: (id) => {
      refreshApplicants(queryClient);
      onAdded(id);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };
  return (
    <Dialog open onClose={onClose} title="Add applicant" description="Someone who applied in person, by phone or on a job board. Applications from your website come in by themselves." size="lg">
      <form onSubmit={submit}>
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus /></Field>
        <div className="form-grid">
          <Field label="Email" optional><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} /></Field>
          <Field label="Phone" optional><input className="input" type="tel" value={phone} onChange={(e) => setPhone(formatPhoneTyping(e.target.value))} maxLength={30} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Position" optional><input className="input" value={position} onChange={(e) => setPosition(e.target.value)} maxLength={200} placeholder="Crew member" /></Field>
          <Field label="Where they applied" optional><input className="input" value={heardFrom} onChange={(e) => setHeardFrom(e.target.value)} maxLength={200} placeholder="Indeed, walked in, a referral" /></Field>
        </div>
        <Field label="Résumé" optional hint="A PDF, a Word document or a photo of it, up to 10 MB.">
          {/* The same picker as a sub's documents: a quiet drop area, then the file's name with a way to take it back. */}
          {file ? (
            <div className={styles.picked}>
              <Icon name={file.type.startsWith("image/") ? "image" : "file"} size={16} />
              <span className="grow">{file.name} <span className="muted small">{fileSize(file.size)}</span></span>
              <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Remove ${file.name}`} onClick={() => setFile(null)}><Icon name="x" size={14} /></button>
            </div>
          ) : (
            <label className="dropzone" style={{ padding: 16 }}>
              <Icon name="upload" size={20} />
              <span className="strong">Choose their résumé</span>
              <input type="file" className="sr-only" accept={FILE_ACCEPT} onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
            </label>
          )}
        </Field>
        <Field label="Notes" optional><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10000} rows={3} /></Field>
        <FormError error={add.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} slowHint={false}>Add applicant</Button>
        </div>
      </form>
    </Dialog>
  );
}
