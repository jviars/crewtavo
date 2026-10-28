/**
 * Applicants (Apps → Crewtavo - Careers): everyone who applied through the website's careers form,
 * or that the office added (a walk-in, a call, a job board), newest first, with where each stands.
 */
import { applicantStatusLabel, FILE_ACCEPT, OPEN_STATUSES } from "@crewtavo/core/careers";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { useStatusCounts } from "@/lib/listing";
import { can, hasRole, useSession } from "@/lib/session";
import { APPLICANT_TONES, filesJson, isWaiting, refreshApplicants, seesApplicants, uploadApplicantFile, WAITING_DAYS, type Applicant } from "./applicants";

const FILTERS = [
  { key: "open", label: "Open", statuses: OPEN_STATUSES },
  { key: "new", label: "New", statuses: ["new"] },
  { key: "interview", label: "Interviews", statuses: ["interview", "offer"] },
  { key: "hired", label: "Hired", statuses: ["hired"] },
  { key: "not_hired", label: "Not hired", statuses: ["not_hired"] },
  { key: "all", label: "All", statuses: null },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

type Row = Pick<Applicant, "id" | "status" | "name" | "email" | "phone" | "position" | "availability" | "files" | "interview_at" | "created_at">;

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
  const term = useDeferredValue(searchTerm(search));
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
        .select("id, status, name, email, phone, position, availability, files, interview_at, created_at")
        .eq("company_id", session.company.id)
        .order("created_at", { ascending: false })
        .limit(300);
      if (statuses) q = q.in("status", [...statuses]);
      if (position) q = q.eq("position", position);
      if (term) q = q.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,position.ilike.%${term}%`);
      return unwrap(await q) as unknown as Row[];
    },
  });

  if (applicants.isPending) return <ListPageSkeleton columns={5} tabs={6} />;
  const rows = applicants.data ?? [];

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
      <div className="toolbar">
        <div className="input-group">
          <span className="addon"><Icon name="search" size={16} /></span>
          <input className="input" type="search" placeholder="Search by name, email, phone or position" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search applicants" />
        </div>
        <div className="tabs" role="group" aria-label="Filter applicants">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className="tab" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {counts.data && <span className="badge">{counts.data[f.key]}</span>}
            </button>
          ))}
        </div>
        {(positions.data?.length ?? 0) > 1 && (
          <select className="select" style={{ width: "auto" }} value={position} onChange={(e) => setPosition(e.target.value)} aria-label="Position">
            <option value="">Every position</option>
            {positions.data!.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>
      {applicants.error && !applicants.data ? (
        <div className="card"><ErrorState error={applicants.error} onRetry={() => applicants.refetch()} /></div>
      ) : rows.length === 0 ? (
        <div className="card">
          {term || position ? (
            <EmptyState icon="search" title="No applicants match" action={<Button onClick={() => { setSearch(""); setPosition(""); }}>Clear search</Button>} />
          ) : !installed && counts.data?.all === 0 ? (
            <EmptyState icon="user" title="Take applications from your website" action={setsUpApps && <Link to="/apps/careers" className="btn btn-primary">Set up Careers</Link>}>
              {setsUpApps
                ? "Install Careers in Apps and point the Apply form on your website at it. Each application lands here, résumé and all."
                : "An admin can install Careers in Apps so applications from your website land here, résumé and all."}
            </EmptyState>
          ) : (
            <EmptyState icon="user" title={filter === "open" ? "No open applications" : "Nobody here"} action={filter === "open" && <Button icon="plus" onClick={() => setAdding(true)}>Add applicant</Button>}>
              {filter === "open" ? "Applications from your website's careers form land here as they arrive. Add people who apply in person or on a job board too." : "No applicants have this status."}
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={`card${applicants.isPlaceholderData ? " is-stale" : ""}`}>
          <table className="table table-stack">
            <thead><tr><th>Applicant</th><th>Position</th><th>Applied</th><th>Résumé</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="row-link" onClick={() => navigate(`/applicants/${a.id}`)}>
                  <td>
                    <Link className="cell-link" to={`/applicants/${a.id}`} onClick={(e) => e.stopPropagation()}>{a.name}</Link>
                    <div className="muted small ellipsis">{[a.email, a.phone].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td>
                    {a.position ?? <span className="muted">—</span>}
                    {a.availability && <div className="muted small">{a.availability}</div>}
                  </td>
                  <td title={formatDate(a.created_at)}>
                    {timeAgo(a.created_at)}
                    {isWaiting(a) && <div className="small text-danger strong">Waiting over {WAITING_DAYS} days</div>}
                  </td>
                  <td>
                    {a.files.length ? (
                      <span className="row" style={{ gap: 6 }}><Icon name="file" size={15} />{a.files.length === 1 ? "Attached" : `${a.files.length} files`}</span>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td>
                    <StatusPill label={applicantStatusLabel(a.status)} tone={APPLICANT_TONES[a.status]} />
                    {a.interview_at && a.status === "interview" && <div className="muted small">{formatDateTime(a.interview_at, session.company.timezone)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      try {
        unwrap(await supabase().from("job_applicants").insert({
          id, company_id: session.company.id, name: name.trim(), email: email.trim().toLowerCase() || null, phone: phone.trim() || null,
          position: position.trim() || null, heard_from: heardFrom.trim() || null, notes: notes.trim() || null, files: filesJson(files), created_by: session.userId,
        }));
      } catch (error) {
        if (files.length) await supabase().storage.from("files").remove(files.map((f) => f.path));
        throw error;
      }
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
          <Field label="Phone" optional><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} /></Field>
        </div>
        <div className="form-grid">
          <Field label="Position" optional><input className="input" value={position} onChange={(e) => setPosition(e.target.value)} maxLength={200} placeholder="Crew member" /></Field>
          <Field label="Where they applied" optional><input className="input" value={heardFrom} onChange={(e) => setHeardFrom(e.target.value)} maxLength={200} placeholder="Indeed, walked in, a referral" /></Field>
        </div>
        <Field label="Résumé" optional hint="A PDF, a Word document or a photo of it, up to 10 MB.">
          <input className="input" type="file" accept={FILE_ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Notes" optional><textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={10000} rows={3} /></Field>
        <FormError error={add.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!name.trim()}>Add applicant</Button>
        </div>
      </form>
    </Dialog>
  );
}
