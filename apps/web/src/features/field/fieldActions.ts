/**
 * Field actions that work without signal: each is a plain function of its variables (no screen
 * state), registered by name, so a queued action can still be sent after the app was closed.
 * See lib/offline.ts.
 */
import type { QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { clockVisit } from "./fieldData";

export interface VisitStatusChange {
  companyId: string;
  userId: string;
  visitId: string;
  jobId: string | null;
  status: string;
  /** When it was tapped. */
  at: string;
}

export async function setVisitStatus(v: VisitStatusChange) {
  await api.patch(`/visits/${v.visitId}`, { status: v.status });
  if (v.status === "in_progress") await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "start", v.at);
  if (v.status === "completed") await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "stop", v.at);
}

export interface ChecklistSave {
  companyId: string;
  visitId: string;
  /** Made on the phone, so saving twice offline updates one row instead of adding two. */
  responseId: string;
  templateId: string | null;
  answers: Record<string, unknown>;
  completedAt: string | null;
}

export async function saveChecklist(v: ChecklistSave) {
  unwrap(
    await supabase()
      .from("checklist_responses")
      .upsert({ id: v.responseId, company_id: v.companyId, visit_id: v.visitId, template_id: v.templateId, answers: v.answers as never, completed_at: v.completedAt }),
  );
}

export async function saveVisitNotes(v: { visitId: string; notes: string | null }) {
  await api.patch(`/visits/${v.visitId}`, { notes: v.notes });
}

export function registerFieldActions(queryClient: QueryClient) {
  queryClient.setMutationDefaults(["visit-status"], { mutationFn: (v: VisitStatusChange) => setVisitStatus(v) });
  queryClient.setMutationDefaults(["checklist-save"], { mutationFn: (v: ChecklistSave) => saveChecklist(v) });
  queryClient.setMutationDefaults(["visit-notes"], { mutationFn: (v: { visitId: string; notes: string | null }) => saveVisitNotes(v) });
}
