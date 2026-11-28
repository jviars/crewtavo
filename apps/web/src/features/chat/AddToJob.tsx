/**
 * Add to a job, from a message's menu (people who may change jobs: owners, admins, office and
 * estimators). Pick the job (the message's own linked job first), then add the message as a note
 * (its words, who wrote it and when, under the job's instructions for the crew, where the office
 * and every crew on its visits read them) or a copy of its photos and files (onto the job's photos
 * and its Plans and files). Copies: the message keeps its own. A toast says so, with Open job.
 */
import { isAudio } from "@crewtavo/core/chatField";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import type { ChatMessage } from "./data";
import { JobPicker, type JobPick } from "./JobPicker";
import f from "./field.module.css";

type Added = { job: { id: string; number: number | null; title: string }; added: number; skipped: string[] };

export function AddToJob({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [job, setJob] = useState<JobPick | null>(null);
  // Subcontractors on the job's visits read its instructions and the files the crew sees.
  const subs = useQuery({
    queryKey: ["chat-to-job-subs", job?.id],
    enabled: Boolean(job),
    queryFn: () => api.get<{ subs: number }>(`/chat/to-job/${job!.id}`).then((r) => r.subs),
    meta: { silent: true },
  });
  const words = Boolean(message.body.trim()) || message.attachments.some((a) => isAudio(a) && a.words);
  const files = message.attachments.length;
  const add = useMutation({
    meta: { inline: true },
    mutationFn: (as: "note" | "files") => api.post<Added>(`/chat/messages/${message.id}/to-job`, { job_id: job!.id, as }),
    onSuccess: (r, as) => {
      const name = r.job.number ? t("Job #{number}", { number: r.job.number }) : r.job.title;
      toast.success(as === "note" ? t("Added to {job} as a note", { job: name }) : t.plural(r.added, { one: "{count} file copied to {job}", other: "{count} files copied to {job}" }, { job: name }), {
        description: r.skipped.length ? t("Not copied: {files}", { files: r.skipped.join(", ") }) : undefined,
        action: { label: t("Open job"), onClick: () => navigate(`/jobs/${r.job.id}`) },
      });
      void queryClient.invalidateQueries({ queryKey: ["job", r.job.id] });
      void queryClient.invalidateQueries({ queryKey: ["record-photos"] });
      void queryClient.invalidateQueries({ queryKey: ["plans"] });
      onClose();
    },
  });
  if (!job) return <JobPicker open title={t("Add to a job")} first={message.job_id} onClose={onClose} onPick={setJob} />;
  return (
    <Dialog open onClose={onClose} title={t("Add to {job}", { job: job.number ? t("Job #{number}", { number: job.number }) : job.title })} description={job.number ? job.title : undefined} size="sm">
      <div className="dialog-body stack-sm">
        {Boolean(subs.data) && (
          <p className={f.subsNote} role="note">
            <Icon name="info" size={16} />
            <span>{t("Subcontractors on this job will see it too: they read its instructions for the crew and its files.")}</span>
          </p>
        )}
        <div className={f.choices}>
          <button type="button" className={f.choice} disabled={!words || add.isPending} onClick={() => add.mutate("note")}>
            <Icon name="note" size={20} />
            <span>
              <strong>{t("Add as a note")}</strong>
              <small>{words ? t("Its words, who wrote it and when, under the job's instructions for the crew.") : t("This message has no words to add.")}</small>
            </span>
          </button>
          <button type="button" className={f.choice} disabled={!files || add.isPending} onClick={() => add.mutate("files")}>
            <Icon name="paperclip" size={20} />
            <span>
              <strong>{t("Add its photos and files to the job")}</strong>
              <small>{files ? t("A copy goes on the job. The message keeps its own.") : t("This message has no photos or files.")}</small>
            </span>
          </button>
        </div>
        <FormError error={add.error} />
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setJob(null)}>{t("Pick another job")}</button>
        </div>
      </div>
    </Dialog>
  );
}
