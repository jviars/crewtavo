/**
 * The checklists crews filled in, where the office looks: every one on a job's visits (the job page)
 * or one visit's (the visit dialog, compact). Each says its visit, who filled it in, whether it's done
 * and its answers, worded by core checklistAnswers. A photo item shows the visit's photos, which is
 * where the field app adds them. Nothing shows until a checklist has been started.
 */
import { checklistAnswers, type ChecklistAnswer } from "@crewtavo/core/forms";
import { useQuery } from "@tanstack/react-query";
import { OriginalLink } from "@/components/DrawOnPhoto";
import { MetaLine } from "@/components/ui/InboxList";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { photoPaths, shownPath } from "@/lib/photoMarkup";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./jobs.module.css";

/** A visit's photo: what it shows (its drawing, if it has one: lib/photoMarkup.ts) and the photo as taken. */
interface Photo { id: string; file_name: string; url: string | null; marked: boolean; originalUrl: string | null }

function useFilledChecklists(scope: { jobId: string } | { visitId: string }) {
  const session = useSession();
  return useQuery({
    queryKey: ["filled-checklists", "jobId" in scope ? scope.jobId : scope.visitId],
    queryFn: async () => {
      const db = supabase();
      const query = db
        .from("checklist_responses")
        .select("id, visit_id, answers, completed_at, completed_by, template:checklist_templates(name, items), visit:visits!inner(title, scheduled_on, job_id)")
        .eq("company_id", session.company.id)
        .order("created_at");
      const rows = unwrap(await ("jobId" in scope ? query.eq("visit.job_id", scope.jobId) : query.eq("visit_id", scope.visitId)));
      const filled = rows.map((r) => ({ ...r, list: checklistAnswers(r.template?.items ?? null, r.answers) }));
      // Who filled each in, and the photos of the visits with a photo item.
      const people = [...new Set(filled.map((r) => r.completed_by).filter((id): id is string => Boolean(id)))];
      const photoVisits = [...new Set(filled.filter((r) => r.list.some((a) => a.type === "photo")).map((r) => r.visit_id))];
      const [profiles, attachments] = await Promise.all([
        people.length ? db.from("profiles").select("user_id, full_name").in("user_id", people) : null,
        photoVisits.length ? db.from("attachments").select("id, path, marked_path, file_name, owner_id").eq("owner_type", "visit").in("owner_id", photoVisits).order("created_at") : null,
      ]);
      const names = new Map((profiles ? unwrap(profiles) : []).map((p) => [p.user_id, p.full_name]));
      const files = attachments ? unwrap(attachments) : [];
      const urls = await signedUrls(photoPaths(files)).catch(() => ({}) as Record<string, string>);
      return filled.map((r) => ({
        id: r.id,
        name: r.template?.name ?? "Deleted checklist",
        visit: r.visit,
        done: Boolean(r.completed_at),
        by: r.completed_by ? names.get(r.completed_by) || "Former team member" : null,
        answers: r.list,
        photos: files.filter((f) => f.owner_id === r.visit_id).map((f): Photo => ({ id: f.id, file_name: f.file_name, url: urls[shownPath(f)] ?? urls[f.path] ?? null, marked: Boolean(f.marked_path), originalUrl: urls[f.path] ?? null })),
      }));
    },
  });
}

type Filled = NonNullable<ReturnType<typeof useFilledChecklists>["data"]>[number];

/** The job page's Checklists section: each filled-in checklist from its visits. */
export function JobChecklists({ jobId }: { jobId: string }) {
  const filled = useFilledChecklists({ jobId });
  if (!filled.data?.length) return null;
  return (
    <Section title="Checklists" count={filled.data.length} className={styles.stacked}>
      {filled.data.map((c) => <ChecklistCard key={c.id} checklist={c} withVisit />)}
    </Section>
  );
}

/** A visit's filled-in checklists, compact, for the visit dialog. */
export function VisitChecklists({ visitId }: { visitId: string }) {
  const filled = useFilledChecklists({ visitId });
  if (!filled.data?.length) return null;
  return (
    <div className="field">
      <span>Checklists</span>
      <div className="stack-sm">{filled.data.map((c) => <ChecklistCard key={c.id} checklist={c} />)}</div>
    </div>
  );
}

/** One filled-in checklist: its name and whether it's done, its visit and who filled it in, then its answers as hairline rows. */
function ChecklistCard({ checklist: c, withVisit = false }: { checklist: Filled; withVisit?: boolean }) {
  const visitLine = withVisit && c.visit ? `${c.visit.title}${c.visit.scheduled_on ? ` · ${formatDate(c.visit.scheduled_on)}` : ""}` : null;
  // An item nobody had to answer and nobody did leaves no row; a required one says it's missing.
  const answers = c.answers.filter((a) => a.type === "photo" || a.text !== null || a.missing);
  return (
    <div className={styles.checklist}>
      <div className={styles.checklistHead}>
        <span className={styles.checklistName}>{c.name}</span>
        <StatusPill label={c.done ? "Done" : "Unfinished"} tone={c.done ? "good" : "warning"} />
      </div>
      <MetaLine className={styles.checklistMeta} parts={[visitLine, c.by && `Filled in by ${c.by}`]} />
      {answers.length > 0 && (
        <Facts label={c.name}>
          {answers.map((a) => (
            <Fact key={a.key} label={a.label} wide={a.type === "photo" || Boolean(a.image)}><Answer answer={a} photos={c.photos} /></Fact>
          ))}
        </Facts>
      )}
    </div>
  );
}

function Answer({ answer: a, photos }: { answer: ChecklistAnswer; photos: Photo[] }) {
  if (a.type === "photo") {
    if (!photos.length) return <span className="muted">No photos</span>;
    // Opened the way the Photos card opens them.
    return (
      <div className="thumbs" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))" }}>
        {photos.map((p) => (
          <div key={p.id} className="thumb">
            {p.url ? <a href={p.url} target="_blank" rel="noreferrer" aria-label={`Open ${p.file_name}`}><img src={p.url} alt={p.file_name} loading="lazy" /></a> : <span className="muted small">Unavailable</span>}
            {p.marked && <OriginalLink url={p.originalUrl} label={p.file_name} />}
          </div>
        ))}
      </div>
    );
  }
  if (a.text === null) return <span className="text-danger">Not answered</span>;
  if (a.image) {
    return (
      <span className="stack-xs">
        <img src={a.image} alt={`Signature: ${a.text}`} style={{ maxHeight: 56, maxWidth: 220, background: "#fff", borderRadius: "var(--radius-sm)" }} />
        <span>{a.text}</span>
      </span>
    );
  }
  return <span className="pre-wrap">{a.text}</span>;
}
