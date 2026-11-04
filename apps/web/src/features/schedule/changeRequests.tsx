/**
 * Clients' requests from the Client Hub to move or cancel a visit, where the office already looks:
 * marked on the schedule and on Home, and answered in the visit dialog. Approve moves the visit to
 * the time asked for, or cancels it (only that visit, for a recurring job); Decline leaves it, with a
 * note for the client if there is one. The client is emailed either way (services/visitChanges.ts).
 */
import { slotLabel } from "@crewtavo/core/slots";
import { arrivalWindowMin } from "@crewtavo/core/time";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

export interface ChangeRequest {
  id: string;
  visit_id: string;
  kind: string;
  starts_at: string | null;
  scheduled_on: string | null;
  message: string | null;
  reason: string | null;
  created_at: string;
  client: { display_name: string } | null;
  visit: { title: string; scheduled_on: string | null } | null;
}

/** The requests waiting for an answer, oldest first: the database shows only the ones this person may answer. */
export function usePendingChanges(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: ["visit-changes", session.company.id],
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("visit_change_requests")
          .select("id, visit_id, kind, starts_at, scheduled_on, message, reason, created_at, client:clients(display_name), visit:visits(title, scheduled_on)")
          .eq("company_id", session.company.id)
          .eq("status", "pending")
          .order("created_at"),
      ) as ChangeRequest[],
  });
}

/** Where a request opens: its visit on the schedule, in its dialog. */
export const changeLink = (r: ChangeRequest) => `/schedule?date=${r.visit?.scheduled_on ?? ""}&visit=${r.visit_id}`;

/** "to move it to Tue, Nov 10, 9:00–11:00 AM", "to move it", or "to cancel it". */
export function askedFor(r: ChangeRequest, timeZone: string, settings: unknown) {
  if (r.kind === "cancel") return "to cancel it";
  return r.scheduled_on ? `to move it to ${slotLabel({ date: r.scheduled_on, starts_at: r.starts_at }, timeZone, arrivalWindowMin(settings))}` : "to move it";
}

/** Answering a request from the office's own screens, then everything that shows the visit is read again. */
export function useAnswerChange(id: string | undefined, onAnswered: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inline: true },
    mutationFn: ({ approve, note }: { approve: boolean; note?: string }) => api.post<{ emailed: boolean }>(`/visit-changes/${id}/${approve ? "approve" : "decline"}`, approve ? {} : { note }),
    onSuccess: (r, { approve }) => {
      // The Jobs list and job pages say Late, Today, Upcoming or Unscheduled from the visits.
      for (const key of ["schedule", "visit-changes", "visit-details", "job", "jobs", "dashboard", "field"]) queryClient.invalidateQueries({ queryKey: [key] });
      toast.success(approve ? "Approved" : "Declined", { description: r.emailed ? "We emailed the client." : "The client wasn't emailed (no email set up, or no address). Let them know." });
      onAnswered();
    },
  });
}

/** The request on a visit, at the top of its dialog: what the client asked, and Approve or Decline. */
export function ChangeRequestPanel({ request, onAnswered }: { request: ChangeRequest; onAnswered: () => void }) {
  const session = useSession();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState("");
  const answer = useAnswerChange(request.id, onAnswered);
  const timed = request.kind === "cancel" || Boolean(request.scheduled_on);
  return (
    <div className="callout callout-info">
      <Icon name="calendar" size={16} />
      <div className="grow stack-sm" style={{ fontWeight: 400 }}>
        <strong>Change requested</strong>
        <span>{request.client?.display_name ?? "The client"} asked {askedFor(request, session.company.timezone, session.company.settings)}.</span>
        {request.message && <span className="pre-wrap">“{request.message}”</span>}
        {request.reason && <span className="pre-wrap">Reason: {request.reason}</span>}
        {!timed && <span className="small">Change the date and time below and save: that approves it and tells them.</span>}
        {declining ? (
          <>
            <textarea className="textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="A note for them (optional)" aria-label="A note for the client" autoFocus />
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" variant="primary" loading={answer.isPending} onClick={() => answer.mutate({ approve: false, note: note.trim() || undefined })}>Decline</Button>
              <Button size="sm" onClick={() => setDeclining(false)}>Back</Button>
            </div>
          </>
        ) : (
          <div className="row" style={{ gap: 8 }}>
            {timed && <Button size="sm" variant="primary" icon="check" loading={answer.isPending} onClick={() => answer.mutate({ approve: true })}>{request.kind === "cancel" ? "Approve and cancel it" : "Approve"}</Button>}
            <Button size="sm" onClick={() => setDeclining(true)}>Decline</Button>
          </div>
        )}
        <FormError error={answer.error} />
      </div>
    </div>
  );
}
