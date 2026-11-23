/** What the Snow screens share: the snow customers as they load them, and how they word things. */
import { visitPrice } from "@crewtavo/core/promos";
import { snowBands, type SnowRules, type SnowTier } from "@crewtavo/core/snow";
import { supabase, unwrap } from "@/lib/api";
import { loadSettings } from "@/lib/companySettings";

export { inchesText as inches } from "@crewtavo/core/snow";

const FIELDS =
  "job_id, trigger_in, salt_trigger_in, repeat_in, clear_by, priority, tiers, tell_client, alerted_on, alerted_pushes, job:jobs!inner(id, number, title, status, paused_at, default_crew_id, instructions, client:clients(display_name), property:properties(line1, city, lat, lng), crew:crews(name, lead_user_id, members:crew_members(user_id))), people:snow_site_people(user_id)";

/** The business's snow customers: its active jobs the Snow page keeps triggers for. */
export const loadSites = async (companyId: string) =>
  unwrap(await supabase().from("snow_sites").select(FIELDS).eq("company_id", companyId).eq("job.status", "active").limit(1000));
export type Site = Awaited<ReturnType<typeof loadSites>>[number];

export const sitesKey = (companyId: string) => ["snow", companyId, "sites"] as const;

/** Which of these jobs are snow customers, for pausing a job to say what that means: Snow doesn't check a paused one. */
export async function snowJobs(jobIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  // As lib/bulk's BULK_CHUNK: ids a request's address has room for.
  for (let i = 0; i < jobIds.length; i += 100) {
    for (const s of unwrap(await supabase().from("snow_sites").select("job_id").in("job_id", jobIds.slice(i, i + 100)))) found.add(s.job_id);
  }
  return found;
}

export const customer = (s: Pick<Site, "job">) => s.job.client?.display_name ?? s.job.title;
/** Its property is on the map, so its forecast can be checked. */
export const located = (s: Site) => s.job.property?.lat != null && s.job.property.lng != null;
export const rulesOf = (s: Pick<Site, "trigger_in" | "salt_trigger_in" | "repeat_in">): SnowRules => ({
  trigger_in: Number(s.trigger_in),
  salt_trigger_in: s.salt_trigger_in == null ? null : Number(s.salt_trigger_in),
  repeat_in: s.repeat_in == null ? null : Number(s.repeat_in),
});
/** The storm price tiers as saved (JSON the office edits), with anything that isn't one left out. */
export const tiersOf = (s: Pick<Site, "tiers">): SnowTier[] =>
  (Array.isArray(s.tiers) ? s.tiers : []).flatMap((t) => {
    const tier = t as { up_to_in?: unknown; price?: unknown } | null;
    return tier && typeof tier.price === "number" ? [{ up_to_in: typeof tier.up_to_in === "number" ? tier.up_to_in : null, price: tier.price }] : [];
  });

/** The business's standard storm prices (core snowBands), which a customer's own are filled from. */
export const bandsKey = (companyId: string) => ["snow", companyId, "standard-prices"] as const;
export const loadBands = async (companyId: string) =>
  snowBands((await loadSettings(companyId)).snow_storm_prices);
/** Whether storms schedule themselves (settings.snow_auto_schedule, set_snow_auto_schedule): off until someone turns it on. */
export const autoKey = (companyId: string) => ["snow", companyId, "auto-schedule"] as const;
export const loadAuto = async (companyId: string) =>
  (await loadSettings(companyId)).snow_auto_schedule === true;
/** What one push bills a job: its own lines, as a visit of it costs (core visitPrice). */
export const loadPushPrice = async (jobId: string) => {
  const job = unwrap(await supabase().from("jobs").select("financials:job_financials(contract_total), lines:job_line_items(quantity, unit_price, discount_billing)").eq("id", jobId).single());
  return visitPrice(job.financials?.contract_total, job.lines);
};

export interface Member { user_id: string; active: boolean; profile: { full_name: string } | null; sub?: { name: string } }
export const nameOf = (m: Member | undefined) => (m ? `${m.profile?.full_name || "Someone"}${m.sub ? ` (${m.sub.name})` : ""}` : "Someone who left");
export const PRIORITIES = [{ value: 1, label: "First" }, { value: 2, label: "Normal" }, { value: 3, label: "After the others" }] as const;
