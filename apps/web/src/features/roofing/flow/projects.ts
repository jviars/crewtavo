/**
 * Roofing's project list (RoofingPage) and the count on its tab (RoofingTabs): each roof estimate
 * with its newest roof measurement, and the roofs waiting to be measured on site, which have none
 * yet. The list groups them by what needs doing first (groupRoofProjects): a homeowner who said yes
 * and wants a visit, a roof to measure on site, changes asked for, a signed estimate to schedule, a
 * job to bill; then the rest in the order a project moves along; then, under All, what's closed.
 */
import { inRangeMode } from "@crewtavo/core/estimates";
import type { TotalsPromo } from "@crewtavo/core/money";
import { useQuery } from "@tanstack/react-query";
import type { IconName } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { TAKEOFF_FIELDS, type TakeoffRow } from "../../paving/data";
import { isRoof, roofStage, type StageTone } from "../data";

export interface ProjectQuote {
  id: string;
  number: number | null;
  title: string;
  status: string;
  total: number;
  tax_rate: number;
  discount_amount: number;
  promo: TotalsPromo | null;
  range_low: number | null;
  range_high: number | null;
  range_sent_at: string | null;
  range_accepted_at: string | null;
  priced_on_site_at: string | null;
  exact_sent_at: string | null;
  client: { display_name: string } | null;
  property: { line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
  package: { name: string } | null;
  /** Its options, when it offers two or three. */
  options: Array<{ id: string }>;
  /** What each option's price is worked out from. */
  lines: Array<{ id: string; option_id: string | null; quantity: number; unit_price: number; taxable: boolean; optional: boolean; selected: boolean }>;
  jobs: Array<{ id: string; status: string }>;
  /** Couldn't be measured from the air: a salesperson measures it on site. */
  measure_on_site_at: string | null;
}

/** A project: its quote, and its newest roof measurement (none yet while it waits to be measured on site). */
export interface ProjectRow {
  quote: ProjectQuote;
  takeoff: TakeoffRow | null;
}

const QUOTE_FIELDS =
  "id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), range_low, range_high, range_sent_at, range_accepted_at, priced_on_site_at, exact_sent_at, client:clients(display_name), property:properties(line1, city, region, postal_code), package:roof_packages!quotes_roof_package_fkey(name), options:quote_options!quote_options_quote_fkey(id), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected), jobs!jobs_company_id_quote_id_fkey(id, status), measure_on_site_at";

export const projectsKey = (companyId: string) => ["roofing-projects", companyId];

/** Every roofing project, newest first, the ones waiting to be measured on site at the top. */
export function useRoofingProjects({ enabled = true }: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: projectsKey(company.id),
    enabled,
    queryFn: async () => {
      const [measured, onSite] = await Promise.all([
        supabase()
          .from("measurements")
          .select(`${TAKEOFF_FIELDS}, quote:quotes(${QUOTE_FIELDS})`)
          .not("quote_id", "is", null)
          .order("updated_at", { ascending: false })
          .limit(200),
        supabase().from("quotes").select(QUOTE_FIELDS).not("measure_on_site_at", "is", null).order("measure_on_site_at", { ascending: false }).limit(100),
      ]);
      // One row per project: its newest measurement, and only measurements of roofs.
      const seen = new Set<string>();
      const rows = (unwrap(measured) as unknown as Array<TakeoffRow & { quote: ProjectQuote | null }>)
        .filter((r) => r.quote && isRoof(r) && !seen.has(r.quote.id) && seen.add(r.quote.id))
        .map(({ quote, ...takeoff }): ProjectRow => ({ quote: quote!, takeoff }));
      // Then the roofs waiting to be measured on site, first: nothing's drawn for them yet.
      const waiting = (unwrap(onSite) as unknown as ProjectQuote[]).filter((q) => !seen.has(q.id)).map((quote): ProjectRow => ({ quote, takeoff: null }));
      return [...waiting, ...rows];
    },
  });
}

/** Still being worked: not lost or archived, and its job (if any) not finished. */
export const isOpenProject = (q: Pick<ProjectQuote, "status" | "jobs">) => !["lost", "archived"].includes(q.status) && q.jobs[0]?.status !== "completed";

export type ProjectGroupKey =
  | "visit"
  | "onsite"
  | "changes"
  | "signed"
  | "invoice"
  | "measure"
  | "price"
  | "send"
  | "range"
  | "sign"
  | "scheduled"
  | "done"
  | "lost"
  | "archived";

export interface ProjectGroupInfo {
  label: string;
  tone?: "warning" | "danger" | "good";
  icon?: IconName;
}

/** The groups, in the order they're shown: what someone must act on first, then the rest of the way along, then what's closed. */
export const PROJECT_GROUPS: ReadonlyArray<[ProjectGroupKey, ProjectGroupInfo]> = [
  ["visit", { label: "Wants a visit", tone: "good", icon: "calendar" }],
  ["onsite", { label: "Measure on site", tone: "warning", icon: "ruler" }],
  ["changes", { label: "Changes requested", tone: "warning", icon: "alert" }],
  ["signed", { label: "Signed", tone: "good", icon: "signature" }],
  ["invoice", { label: "To invoice", tone: "good", icon: "invoice" }],
  ["measure", { label: "To measure" }],
  ["price", { label: "To price" }],
  ["send", { label: "Ready to send" }],
  ["range", { label: "Range sent" }],
  ["sign", { label: "Waiting to sign" }],
  ["scheduled", { label: "Scheduled" }],
  ["done", { label: "Done" }],
  ["lost", { label: "Lost" }],
  ["archived", { label: "Archived" }],
];

/** What a project's group is worked out from: the list's quote, or the project page's (with its jobs). */
export type GroupQuote = Pick<ProjectQuote, "status" | "range_low" | "range_accepted_at" | "priced_on_site_at" | "exact_sent_at" | "measure_on_site_at"> & {
  lines: unknown[];
  jobs: Array<{ status: string }>;
};

/** Which group a project goes in (roofStage's stages, a few of them together). */
export function projectGroup(q: GroupQuote, hasTakeoff: boolean): ProjectGroupKey {
  if (q.status === "lost") return "lost";
  if (q.status === "archived") return "archived";
  if (q.status === "converted") {
    const job = q.jobs[0];
    if (job?.status === "completed" || job?.status === "archived") return "done";
    return job?.status === "requires_invoicing" ? "invoice" : "scheduled";
  }
  if (q.status === "approved") return "signed";
  if (!hasTakeoff) return q.measure_on_site_at ? "onsite" : "measure";
  if (!q.lines.length) return "price";
  if (q.status === "changes_requested") return "changes";
  const ranged = q.range_low !== null && q.range_low !== undefined;
  if (ranged && !q.priced_on_site_at && !q.exact_sent_at && q.range_accepted_at) return "visit";
  if (q.priced_on_site_at || q.exact_sent_at) return "sign";
  if (q.status === "sent") return ranged ? "range" : "sign";
  return "send";
}

/** The projects in their groups, in PROJECT_GROUPS order, each keeping the list's order; empty groups left out. */
export function groupRoofProjects(rows: readonly ProjectRow[]): Array<ProjectGroupInfo & { key: ProjectGroupKey; rows: ProjectRow[] }> {
  const by = new Map<ProjectGroupKey, ProjectRow[]>();
  for (const row of rows) {
    const key = projectGroup(row.quote, Boolean(row.takeoff));
    by.set(key, [...(by.get(key) ?? []), row]);
  }
  return PROJECT_GROUPS.flatMap(([key, info]) => (by.get(key)?.length ? [{ key, ...info, rows: by.get(key)! }] : []));
}

/**
 * A project's stage on its own page, as a dot and words: its group's words, so the page says what
 * the list does ("Ready to send", not "Pricing"), with roofStage's tone; where the group holds
 * several stages ("Waiting to sign"), or it's lost or archived, roofStage's own words.
 */
export function projectStage(q: GroupQuote, hasTakeoff: boolean): { label: string; tone: StageTone } {
  const stage = roofStage(q, hasTakeoff);
  const key = projectGroup(q, hasTakeoff);
  if (key === "sign" || key === "lost" || key === "archived") return stage;
  const group = PROJECT_GROUPS.find(([k]) => k === key);
  return { label: group ? group[1].label : stage.label, tone: stage.tone };
}

/** Where a project in a group of several stages is ("Priced on site", "Exact price sent"), for its quiet line; null where the group says it. */
export function stageNote(row: ProjectRow): string | null {
  const key = projectGroup(row.quote, Boolean(row.takeoff));
  return key === "sign" ? roofStage(row.quote, Boolean(row.takeoff)).label : null;
}

/** What the project's row says about its price: the range the homeowner was sent, the cheapest option, the total, or nothing yet. */
export function projectPrice(q: ProjectQuote, lowest: number | null): { kind: "range"; low: number; high: number } | { kind: "from"; amount: number } | { kind: "total"; amount: number } | null {
  if (inRangeMode(q) && q.range_low !== null && q.range_high !== null) return { kind: "range", low: Number(q.range_low), high: Number(q.range_high) };
  if (lowest !== null) return { kind: "from", amount: lowest };
  return q.lines.length ? { kind: "total", amount: Number(q.total) } : null;
}

/** Whether a project matches what's typed: its title, client, street, town or number. */
export function matchesProject(q: ProjectQuote, term: string): boolean {
  const t = term.trim().toLowerCase().replace(/^#/, "");
  if (!t) return true;
  return [q.title, q.client?.display_name, q.property?.line1, q.property?.city, q.package?.name, q.number !== null ? String(q.number) : null].some((v) => v?.toLowerCase().includes(t));
}
