/**
 * The time a client picked on a booking form that needs the office's OK (Settings → Online
 * booking): "Asked for Tue, Jan 14, 10:00 to 11:00 AM", with one press to book it then. A time
 * something else has taken since asks before it books. Shown while the request is new: once it's
 * scheduled, its assessment says when.
 */
import { bookingSpan } from "@crewtavo/core/slots";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { api } from "@/lib/api";
import { companyCountry } from "@/lib/format";
import { useSession } from "@/lib/session";

export interface AskedRequest { id: string; status: string; asked_starts_at?: string | null; asked_ends_at?: string | null }
type Booked = { booked: true; visit_id: string; emailed: boolean; texted: boolean } | { booked: false; taken: true };

/** The time asked for that still waits for an answer, as the office reads it; null when there's none. */
export function askedFor(request: AskedRequest, timeZone: string): string | null {
  return request.status === "new" && request.asked_starts_at ? bookingSpan(request.asked_starts_at, request.asked_ends_at ?? null, timeZone, companyCountry()) : null;
}

export function BookAskedTime({ request, size, className, onBooked }: { request: AskedRequest; size?: "sm"; className?: string; onBooked?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const when = askedFor(request, session.company.timezone);
  const book = useMutation({
    meta: { tone: "request", success: (r: Booked | null) => (r?.booked ? (r.emailed || r.texted ? "Booked, and the client was told" : "Booked") : undefined) },
    mutationFn: async () => {
      const first = await api.post<Booked>(`/requests/${request.id}/book-asked-time`, {});
      if (first.booked) return first;
      const anyway = await confirm({
        title: "That time has been taken since",
        body: `Something else is on the schedule ${when} now. Book this one then too, or schedule the assessment for another time.`,
        confirmLabel: "Book it anyway",
      });
      return anyway ? api.post<Booked>(`/requests/${request.id}/book-asked-time`, { force: true }) : null;
    },
    onSuccess: (r) => {
      if (!r?.booked) return;
      for (const key of ["request", "requests", "schedule", "dashboard"]) queryClient.invalidateQueries({ queryKey: [key] });
      onBooked?.();
    },
  });
  if (!when) return null;
  const passed = Date.parse(request.asked_starts_at!) <= Date.now();
  return (
    <Button size={size} className={className} variant="primary" icon="calendar" loading={book.isPending} disabled={passed} title={passed ? "That time has passed" : undefined} onClick={(e) => { e.stopPropagation(); book.mutate(); }}>
      Book it
    </Button>
  );
}
