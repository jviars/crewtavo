/**
 * Field actions that work without signal: each is a plain function of its variables (no screen
 * state), registered by name, so a queued action can still be sent after the app was closed.
 * See lib/offline.ts.
 */
import type { QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { clockVisit, type ClockPlace } from "./fieldData";

export interface VisitStatusChange {
  companyId: string;
  userId: string;
  visitId: string;
  jobId: string | null;
  status: string;
  /** When it was tapped. */
  at: string;
  /** Where the phone was, when the tap starts or stops the clock (useStatusTap). */
  place?: ClockPlace;
  /**
   * Whether Start and Complete clock this person in and out, decided at the tap (useStatusTap): the
   * queued send only has what was saved with it. False for a sub the office doesn't keep hours for.
   * A tap saved before this was recorded clocks, as it always did.
   */
  clock?: boolean;
  /** Tapped by a sub: if the office has since taken them off the clock, the visit still moves on. */
  sub?: boolean;
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
  const result = await api.patch<{ skipped?: boolean; status?: string }>(`/visits/${v.visitId}`, { status: v.status, forward_only: true }, { companyId: v.companyId });
  // The visit's status is shared, but each person's clock is their own: when the visit has moved on
  // (a crewmate finished it first), this person still clocks in and out as they tapped. Only a
  // cancelled visit doesn't start a clock, and someone without a clock (a sub, mostly) has none.
  const clocks = v.clock !== false;
  let clockOff = false;
  try {
    if (clocks && v.status === "in_progress" && !(result.skipped && result.status === "cancelled")) await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "start", v.at, v.place);
    if (clocks && v.status === "completed") await clockVisit(v.companyId, v.userId, { id: v.visitId, job_id: v.jobId }, "stop", v.at, v.place);
  } catch (error) {
    // A sub whose clock the office turned off after this phone last heard (the database refuses
    // their time now): the visit moved on, and there's simply no clock.
    if (!(v.sub && clockRefused(error))) throw error;
    clockOff = true;
  }
  return { skipped: Boolean(result.skipped), visitStatus: result.status, ...(clockOff && { clockOff }) };
}

/** The database turning a clock down: row-level security on time entries. */
export const clockRefused = (error: unknown) => /row-level security|permission/i.test(error instanceof Error ? error.message : String(error));

/** What a status tap's confirmation says, once the server has it. */
export function statusSaved(result: { skipped: boolean; visitStatus?: string; clockOff?: boolean } | undefined, change: VisitStatusChange): string {
  const clocks = change.clock !== false && !result?.clockOff;
  if (result?.skipped) return result.visitStatus === "cancelled" ? "The office cancelled this visit." : clocks ? "Your crew already moved this visit on. Your time is saved." : "This visit had already moved on.";
  return change.status === "en_route" ? "On your way" : change.status === "in_progress" ? (clocks ? "Visit started. Your clock is running." : "Visit started.") : "Visit complete. Nice work!";
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
  queryClient.setMutationDefaults(["visit-status"], {
    mutationFn: async (v: VisitStatusChange) => {
      const result = await setVisitStatus(v);
      // Their clock was turned off: what this phone knows about them (GET /me) is out of date.
      if (result.clockOff) void queryClient.invalidateQueries({ queryKey: ["me"] });
      return result;
    },
  });
  queryClient.setMutationDefaults(["checklist-save"], { mutationFn: (v: ChecklistSave) => saveChecklist(v) });
  queryClient.setMutationDefaults(["visit-notes"], { mutationFn: (v: { visitId: string; notes: string | null }) => saveVisitNotes(v) });
}
