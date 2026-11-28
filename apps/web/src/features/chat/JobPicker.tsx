/**
 * Picking a job: one given first (a message's linked job), then the latest ones, or search by
 * title or number. The composer's Link a job and a message's Add to a job both use it.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { SearchField } from "@/components/ui/Toolbar";
import { supabase } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import s from "./chat.module.css";

export interface JobPick {
  id: string;
  number: number | null;
  title: string;
}

type Found = JobPick & { status: string; client: { display_name: string } | null };

export function JobPicker({ open, onClose, onPick, title = t("Link a job"), first = null }: { open: boolean; onClose: () => void; onPick: (job: JobPick) => void; title?: string; first?: string | null }) {
  const { company } = useSession();
  const [q, setQ] = useState("");
  const term = q.trim();
  const jobs = useQuery({
    queryKey: ["chat-job-search", company.id, term, first],
    enabled: open,
    queryFn: async () => {
      let query = supabase().from("jobs").select("id, number, title, status, client:clients(display_name)").eq("company_id", company.id).neq("status", "archived").order("updated_at", { ascending: false }).limit(12);
      if (/^#?\d+$/.test(term)) query = query.eq("number", Number(term.replace("#", "")));
      else if (term) query = query.ilike("title", `%${term.replace(/[%_]/g, "")}%`);
      const [found, linked] = await Promise.all([
        query,
        first && !term ? supabase().from("jobs").select("id, number, title, status, client:clients(display_name)").eq("company_id", company.id).eq("id", first).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ]);
      if (found.error) throw new Error(found.error.message);
      const list = found.data as unknown as Found[];
      const top = linked.data as unknown as Found | null;
      return top ? [top, ...list.filter((j) => j.id !== top.id)] : list;
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <div className={`dialog-body stack-sm ${s.jobPicker}`}>
        <SearchField value={q} onChange={setQ} placeholder={t("Search jobs by title or number")} label={t("Search jobs")} shortcut={false} autoFocus />
        {jobs.isPending && <span className="muted small">{t("Loading jobs…")}</span>}
        {jobs.data?.length === 0 && <span className="muted small">{t("No jobs match.")}</span>}
        {Boolean(jobs.data?.length) && (
          <ul className={s.jobList}>
            {jobs.data?.map((j) => (
              <li key={j.id}>
                <button type="button" className={s.jobRow} onClick={() => onPick(j)}>
                  <strong>{j.number ? `#${j.number} · ` : ""}{j.title}</strong>
                  {(j.id === first && !term) || j.client?.display_name ? (
                    <span>{[j.id === first && !term ? t("Linked to this message") : null, j.client?.display_name].filter(Boolean).join(" · ")}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
