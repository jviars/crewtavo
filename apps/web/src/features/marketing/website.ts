/**
 * Website analytics in Marketing (and on Home and Metrics): what the web_stats function counted for
 * a date range (supabase/migrations/20261020003000_website_analytics.sql), and the sums made from it.
 * Visitors count once a day, so a period's visitors are its days' visitors added up.
 */
import type { Channel, Device } from "@crewtavo/core/analytics";
import { addDays } from "@crewtavo/core/time";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession, type Session } from "@/lib/session";

export interface WebDay { day: string; visitors: number; pageviews: number; visits: number; requests: number }

export interface WebStats {
  /** Each day with anything in it, from the start of the period before the range to its end. */
  days: WebDay[];
  pages: Array<{ path: string; visitors: number; pageviews: number; entries: number; requests: number }>;
  sources: Array<{ source: string; channel: Channel; visitors: number; visits: number; requests: number }>;
  campaigns: Array<{ campaign: string; visitors: number; visits: number; requests: number }>;
  devices: Array<{ device: Device; visitors: number; pageviews: number }>;
}

/** The visit a booking-form request came from (requests.web_visit). */
export interface WebVisit {
  landing_page: string;
  page: string;
  source: string;
  channel: Channel;
  campaign?: string;
  referrer?: string;
  device: Device;
  visited_at: string;
}

/** Installed in Apps (companies.settings.website_analytics). */
export const analyticsOn = (session: Pick<Session, "company">) =>
  (session.company.settings as { website_analytics?: { enabled?: boolean } } | null)?.website_analytics?.enabled === true;

/** Who sees the numbers: the same people as Marketing. */
export const seesWebsite = (session: Session) => analyticsOn(session) && hasRole(session, "admin", "office") && can(session, "marketing");

export function useWebStats(range: { from: string; to: string }, options: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["web-stats", company.id, range.from, range.to],
    enabled: options.enabled ?? true,
    placeholderData: keepPreviousData,
    // Visits arrive all day; a minute is fresh enough.
    refetchInterval: 60_000,
    queryFn: async () => unwrap(await supabase().rpc("web_stats", { p_company: company.id, p_from: range.from, p_to: range.to })) as unknown as WebStats,
  });
}

export type Figure = "visitors" | "pageviews" | "visits" | "requests";
export type Totals = Record<Figure, number>;

const zero = (): Totals => ({ visitors: 0, pageviews: 0, visits: 0, requests: 0 });

/** The range's totals and the same length of time before it. */
export function periodTotals(days: WebDay[], range: { from: string; to: string; days: number }): { now: Totals; before: Totals } {
  const start = addDays(range.from, -range.days);
  const now = zero();
  const before = zero();
  for (const d of days) {
    const into = d.day >= range.from && d.day <= range.to ? now : d.day >= start && d.day < range.from ? before : null;
    if (!into) continue;
    for (const key of Object.keys(into) as Figure[]) into[key] += d[key];
  }
  return { now, before };
}

/**
 * A client's lead source in Metrics: website-form leads by where their visit came from ("Website
 * form · Google"), when the business counts its website's visits.
 */
export function leadSource(source: string | null | undefined, requests?: Array<{ web_visit: unknown }> | null): string {
  const named = source?.trim() || "Not recorded";
  if (named !== "Website form") return named;
  const visit = requests?.map((r) => r.web_visit as WebVisit | null).find((v) => v?.source);
  return visit ? `Website form · ${visit.source}` : named;
}
