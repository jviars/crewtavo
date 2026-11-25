/**
 * A client's next visit and the last one finished: what the office needs when the client calls to ask
 * "when are you coming?" or "when were you last out?". On the client's page (Details) and its hover
 * card. A visit belongs to a client through its job, or through their request for an estimate visit.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, dateIn, formatDate, formatDay, formatTime, todayIn } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";

export interface ClientVisit {
  id: string;
  title: string;
  scheduled_on: string | null;
  starts_at: string | null;
  completed_at: string | null;
  job_id: string | null;
  request_id: string | null;
}

const FIELDS = "id, title, scheduled_on, starts_at, completed_at, job_id, request_id";
const OPEN = ["scheduled", "en_route", "in_progress"];

/** Where a visit opens: its job, or the request an estimate visit is for. */
export const visitLink = (v: ClientVisit) => (v.job_id ? `/jobs/${v.job_id}` : v.request_id ? `/requests/${v.request_id}` : "/schedule");

/** The sooner of two visits coming up: by day, then time, an anytime visit after the timed ones. */
const sooner = (a: ClientVisit | undefined, b: ClientVisit | undefined) => {
  if (!a || !b) return a ?? b;
  const key = (v: ClientVisit) => `${v.scheduled_on} ${v.starts_at ?? "~"}`;
  return key(a) <= key(b) ? a : b;
};

/** "Today, 9:00 AM", "Tomorrow", "Thu, Nov 27, 9:00 AM": a visit coming up, as the company's clock has it. */
export function nextWhen(v: Pick<ClientVisit, "scheduled_on" | "starts_at">, timeZone: string, today = todayIn(timeZone)): string {
  const day = v.scheduled_on ?? (v.starts_at ? dateIn(v.starts_at, timeZone) : today);
  const words = day === today ? t("Today") : day === addDaysIso(today, 1) ? t("Tomorrow") : formatDay(`${day}T12:00:00`);
  return v.starts_at ? `${words}, ${formatTime(v.starts_at, timeZone)}` : words;
}

/** "Today", "Yesterday", "Nov 12, 2026": the day a visit was finished, where the company is. */
export function lastWhen(v: Pick<ClientVisit, "completed_at" | "scheduled_on">, timeZone: string, today = todayIn(timeZone)): string {
  const day = v.completed_at ? dateIn(v.completed_at, timeZone) : v.scheduled_on;
  if (!day) return "";
  return day === today ? t("Today") : day === addDaysIso(today, -1) ? t("Yesterday") : formatDate(day);
}

export function useClientVisits(clientId: string | undefined) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["client", clientId, "visits"],
    enabled: Boolean(clientId),
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const db = supabase();
      const today = todayIn(company.timezone);
      const [jobNext, requestNext, last] = await Promise.all([
        db.from("visits").select(`${FIELDS}, job:jobs!inner(client_id)`).eq("company_id", company.id).eq("job.client_id", clientId!).in("status", OPEN).gte("scheduled_on", today).order("scheduled_on").order("starts_at", { nullsFirst: false }).limit(1),
        db.from("visits").select(`${FIELDS}, request:requests!inner(client_id)`).eq("company_id", company.id).eq("request.client_id", clientId!).in("status", OPEN).gte("scheduled_on", today).order("scheduled_on").order("starts_at", { nullsFirst: false }).limit(1),
        db.from("visits").select(`${FIELDS}, job:jobs!inner(client_id)`).eq("company_id", company.id).eq("job.client_id", clientId!).eq("status", "completed").order("completed_at", { ascending: false, nullsFirst: false }).limit(1),
      ]);
      const first = (rows: ClientVisit[]) => rows[0];
      return {
        next: sooner(first(unwrap(jobNext) as ClientVisit[]), first(unwrap(requestNext) as ClientVisit[])) ?? null,
        last: first(unwrap(last) as ClientVisit[]) ?? null,
      };
    },
  });
}
