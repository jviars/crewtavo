/**
 * Plans on a crew's visit: the current files for the job and the property that are marked for the
 * crew (the database only returns those), to open on the phone or save to it before heading out to
 * a site with no signal. Crew leads can add files and new versions from the job.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { PLAN_FIELDS, planEntries, planMeta, usePlanLinks, type PlanFile } from "./plans";
import { PlanIcon } from "./PlansCard";
import styles from "./plans.module.css";

export function FieldPlans({ visitId, jobId, propertyId }: { visitId: string; jobId: string | null; propertyId: string | null }) {
  const session = useSession();
  const files = useQuery({
    // Under the visit's key, so the list is still there with no signal.
    queryKey: ["field-visit", visitId, "plans", jobId, propertyId],
    enabled: Boolean(jobId || propertyId),
    meta: { silent: true },
    queryFn: async () => {
      const filter = [jobId && `job_id.eq.${jobId}`, propertyId && `property_id.eq.${propertyId}`].filter(Boolean).join(",");
      return unwrap(await supabase().from("plan_files").select(PLAN_FIELDS).or(filter).is("superseded_at", null).eq("archived", false).order("created_at", { ascending: false }).limit(60)) as PlanFile[];
    },
  });
  const entries = planEntries(files.data ?? []);
  const links = usePlanLinks(files.data ?? []);
  if (!entries.length) return null;
  return (
    <section className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Plans</strong>
        {jobId && hasRole(session, "admin", "office", "estimator", "crew_lead") && <Link className="small strong" to={`/jobs/${jobId}`}>Add or update</Link>}
      </div>
      <div>
        {entries.map((entry) => {
          const f = entry.file;
          const open = links.data?.open[f.path];
          const save = links.data?.save[f.path];
          return (
            <div key={f.id} className={styles.fieldRow}>
              <PlanIcon file={f} />
              <div className={styles.body}>
                {open ? <a className={styles.title} href={open} target="_blank" rel="noreferrer">{f.title}</a> : <span className={styles.title}>{f.title}</span>}
                <span className={styles.meta}>{planMeta(entry)}</span>
                {f.notes && <p className={styles.notes}>{f.notes}</p>}
              </div>
              <div className={styles.fieldButtons}>
                {open && <a className="btn" href={open} target="_blank" rel="noreferrer"><Icon name="eye" size={16} />Open</a>}
                {save && <a className="btn btn-icon" href={save} aria-label={`Save ${f.title} to this phone`} title="Save to this phone"><Icon name="download" size={16} /></a>}
              </div>
            </div>
          );
        })}
      </div>
      {!navigator.onLine && <span className="muted small">No signal: plans you saved to this phone are in its Files or Downloads.</span>}
    </section>
  );
}
