/**
 * The checklists crews filled in, where the office looks: every one on a job's visits (the job page)
 * or one visit's (the visit dialog, compact). Each says its visit, who filled it in, whether it's done
 * and its answers, worded by core checklistAnswers. A photo item shows the visit's photos, which is
 * where the field app adds them. Nothing shows until a checklist has been started.
 */
import { checklistAnswers, type ChecklistAnswer } from "@crewtavo/core/forms";
import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { formatDate } from "@/lib/format";
import { useSession } from "@/lib/session";

interface Photo { id: string; file_name: string; url: string | null }

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
        photoVisits.length ? db.from("attachments").select("id, path, file_name, owner_id").eq("owner_type", "visit").in("owner_id", photoVisits).order("created_at") : null,
      ]);
      const names = new Map((profiles ? unwrap(profiles) : []).map((p) => [p.user_id, p.full_name]));
      const files = attachments ? unwrap(attachments) : [];
      const urls = await signedUrls(files.map((f) => f.path)).catch(() => ({}) as Record<string, string>);
      return filled.map((r) => ({
        id: r.id,
        name: r.template?.name ?? "Deleted checklist",
        visit: r.visit,
        done: Boolean(r.completed_at),
        by: r.completed_by ? names.get(r.completed_by) || "Former team member" : null,
        answers: r.list,
        photos: files.filter((f) => f.owner_id === r.visit_id).map((f): Photo => ({ id: f.id, file_name: f.file_name, url: urls[f.path] ?? null })),
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
    <section className="stack">
      <h2 className="section-title">Checklists</h2>
      <div className="card">
        {filled.data.map((c) => (
          <div key={c.id} className="card-row" style={{ alignItems: "flex-start" }}>
            <ChecklistCard checklist={c} withVisit />
          </div>
        ))}
      </div>
    </section>
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

function ChecklistCard({ checklist: c, withVisit = false }: { checklist: Filled; withVisit?: boolean }) {
  const visitLine = withVisit && c.visit ? `${c.visit.title}${c.visit.scheduled_on ? ` · ${formatDate(c.visit.scheduled_on)}` : ""}` : null;
  const meta = [visitLine, c.by && `Filled in by ${c.by}`].filter(Boolean).join(" · ");
  return (
    <div className="grow stack-sm" style={{ minWidth: 0 }}>
      <div className="row-between">
        <strong>{c.name}</strong>
        <StatusPill label={c.done ? "Done" : "Unfinished"} tone={c.done ? "good" : "warning"} />
      </div>
      {meta && <span className="muted small">{meta}</span>}
      <dl className="kv">
        {c.answers.map((a) => (
          <Fragment key={a.key}>
            <dt>{a.label}</dt>
            <dd><Answer answer={a} photos={c.photos} /></dd>
          </Fragment>
        ))}
      </dl>
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
          </div>
        ))}
      </div>
    );
  }
  if (a.text === null) return a.missing ? <span className="text-danger">Not answered</span> : <span className="muted">—</span>;
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
