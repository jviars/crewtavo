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

/**
 * The status last tapped for a visit on this phone while that tap is still waiting to send (no
 * signal, or queued behind an earlier action). What the server says is older than that, so screens
 * show this instead; otherwise the crew would be offered a step they've already taken, and tapping
 * it would queue a step backwards.
 */
export function pendingVisitStatus(queryClient: QueryClient, visitId: string): string | undefined {
  const waiting = queryClient
    .getMutationCache()
    .findAll({ mutationKey: ["visit-status"], status: "pending" })
    .map((m) => m.state.variables as VisitStatusChange | undefined)
    .filter((v) => v?.visitId === visitId);
  return waiting.at(-1)?.status;
}

/** Show a tapped status at once, on My day and on the visit's own screen alike. */
export function showVisitStatus(queryClient: QueryClient, change: VisitStatusChange) {
  queryClient.setQueriesData<{ today: Array<{ id: string; status: string }> }>({ queryKey: ["field"] }, (old) => old && { ...old, today: old.today.map((v) => (v.id === change.visitId ? { ...v, status: change.status } : v)) });
  queryClient.setQueryData<{ status: string } | null>(["field-visit", change.visitId], (old) => old && { ...old, status: change.status });
}

export async function setVisitStatus(v: VisitStatusChange) {
  // As the company it was tapped in, even if the app has switched company since. Forward only: a
  // tap sent again after later ones went out (the app closed before it heard back) is skipped.
  const result = await api.patch<{ skipped?: boolean }>(`/visits/${v.visitId}`, { status: v.status, forward_only: true }, { companyId: v.companyId });
  if (result.skipped) return; // Already past this step, so there's nothing to clock either.
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

/** `companyId` is where the notes were written; notes queued before it was recorded go to the company on screen. */
export async function saveVisitNotes(v: { visitId: string; notes: string | null; companyId?: string }) {
  await api.patch(`/visits/${v.visitId}`, { notes: v.notes }, { companyId: v.companyId });
}

export function registerFieldActions(queryClient: QueryClient) {
  queryClient.setMutationDefaults(["visit-status"], { mutationFn: (v: VisitStatusChange) => setVisitStatus(v) });
  queryClient.setMutationDefaults(["checklist-save"], { mutationFn: (v: ChecklistSave) => saveChecklist(v) });
  queryClient.setMutationDefaults(["visit-notes"], { mutationFn: (v: { visitId: string; notes: string | null }) => saveVisitNotes(v) });
}
