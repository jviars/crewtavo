/**
 * Plans on a crew's visit: the current files for the job and the property that are marked for the
 * crew (the database only returns those), to open in the viewer on the phone or save to it before
 * heading out to a site with no signal. Crews only look; crew leads add files and new versions
 * from the job, and the office can mark up a PDF here too.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { FileViewer } from "@/features/files/FileViewer";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { previewCopies, previewLink } from "./PlanPreview";
import { PLAN_FIELDS, planEntries, planMeta, usePlanLinks, type PlanFile } from "./plans";
import { PlanIcon } from "./PlansCard";
import styles from "./plans.module.css";
import { t } from "@/lib/i18n";

export function FieldPlans({ visitId, jobId, propertyId }: { visitId: string; jobId: string | null; propertyId: string | null }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<PlanFile | null>(null);
  const isOffice = hasRole(session, "admin", "office", "estimator");
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
  // Links to open and save each file, and to show their preview copies.
  const links = usePlanLinks([...(files.data ?? []), ...previewCopies(files.data ?? [])]);
  if (!entries.length) return null;
  return (
    <Section title={t("Plans")} count={entries.length} action={jobId && hasRole(session, "admin", "office", "estimator", "crew_lead") ? <Link to={`/jobs/${jobId}`}>{t("Add or update")}</Link> : undefined}>
      <div className={styles.fieldList}>
        {entries.map((entry) => {
          const f = entry.file;
          const save = links.data?.save[f.path];
          return (
            <div key={f.id} className={styles.fieldRow}>
              <PlanIcon file={f} preview={previewLink(f, links.data?.open, false)} onOpen={() => setViewing(f)} />
              <div className={styles.body}>
                <button type="button" className={styles.title} onClick={() => setViewing(f)}>{f.title}</button>
                <span className={styles.meta}>{planMeta(entry)}</span>
                {f.notes && <p className={styles.notes}>{f.notes}</p>}
              </div>
              <div className={styles.fieldButtons}>
                <button type="button" className="btn" onClick={() => setViewing(f)}><Icon name="eye" size={16} />{t("Open")}</button>
                {save && <a className="btn btn-icon" href={save} aria-label={t("Save {file} to this phone", { file: f.title })} title={t("Save to this phone")}><Icon name="download" size={16} /></a>}
              </div>
            </div>
          );
        })}
      </div>
      {!navigator.onLine && <p className={styles.offline}>{t("No signal: plans you saved to this phone are in its Files or Downloads.")}</p>}
      {viewing && (
        <FileViewer
          file={viewing}
          canEdit={isOffice && !viewing.archived}
          onClose={() => setViewing(null)}
          onSaved={(next) => {
            setViewing(next);
            // A new version is a new stored file: it counts toward storage too.
            for (const key of ["field-visit", "plans", "drive", "storage"]) void queryClient.invalidateQueries({ queryKey: [key] });
          }}
        />
      )}
    </Section>
  );
}
