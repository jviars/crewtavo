/** Shared queries and types for equipment, its maintenance schedules, paperwork and history. */
import { documentLabel, dueProgress, dueSummary, expirySummary, type DueState, type IntervalUnit, type Meter } from "@crewtavo/core/equipment";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/api";
import { everyRow } from "@/lib/paging";
import { can, hasRole, type Session } from "@/lib/session";

export interface Equipment {
  id: string;
  name: string;
  kind: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serial: string | null;
  plate: string | null;
  meter: Meter;
  meter_reading: number | null;
  meter_read_on: string | null;
  status: "active" | "in_shop" | "retired";
  crew_id: string | null;
  purchased_on: string | null;
  photo_path: string | null;
  notes: string | null;
  created_at: string;
  crew: { name: string; color: string | null } | null;
}

export const EQUIPMENT_FIELDS =
  "id, name, kind, make, model, year, serial, plate, meter, meter_reading, meter_read_on, status, crew_id, purchased_on, photo_path, notes, created_at, crew:crews(name, color)";

/** A maintenance schedule with when it's next due (public.equipment_due). */
export interface DueRow {
  plan_id: string;
  equipment_id: string;
  equipment_name: string;
  kind: string;
  crew_id: string | null;
  equipment_status: string;
  name: string;
  notes: string | null;
  every_count: number | null;
  every_unit: IntervalUnit | null;
  every_meter: number | null;
  last_done_on: string | null;
  last_done_meter: number | null;
  next_due_on: string | null;
  next_due_meter: number | null;
  days_left: number | null;
  meter_left: number | null;
  meter: Meter;
  meter_reading: number | null;
  state: DueState;
}

export interface EquipmentLog {
  id: string;
  kind: "service" | "repair" | "reading" | "note";
  plan_id: string | null;
  title: string | null;
  done_on: string;
  meter_reading: number | null;
  notes: string | null;
  user_id: string | null;
  created_at: string;
  expense: { amount: number; vendor: string | null } | null;
}

export const STATUS_LABELS: Record<Equipment["status"], string> = { active: "In service", in_shop: "In the shop", retired: "Retired" };
export const STATUS_TONES = { active: "good", in_shop: "warning", retired: "muted" } as const;

/** People who add, change and retire equipment and its schedules. Everyone can log work. */
export const managesEquipment = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "equipment");
/** People who see what equipment costs. */
export const seesEquipmentCosts = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "job_costs");

const STATE_ORDER: Record<string, number> = { overdue: 0, due_soon: 1, ok: 2 };
/** Overdue first, then due soon, then by how much of the interval is left. */
export const byUrgency = (a: DueRow, b: DueRow) =>
  STATE_ORDER[a.state] - STATE_ORDER[b.state] || (dueProgress(a) ?? 9) - (dueProgress(b) ?? 9) || a.name.localeCompare(b.name);

/** Every active schedule in the company (or one machine's), most urgent first. The view has no id: its rows are told apart by the schedule's. */
export async function loadEquipmentDue(companyId: string, equipmentId?: string) {
  const rows = await everyRow(
    () => {
      const q = supabase().from("equipment_due").select("*").eq("company_id", companyId);
      return equipmentId ? q.eq("equipment_id", equipmentId) : q;
    },
    { key: "plan_id" },
  );
  return (rows as unknown as DueRow[]).sort(byUrgency);
}

export function useEquipmentDue(companyId: string, options: { enabled?: boolean; equipmentId?: string } = {}) {
  return useQuery({
    queryKey: ["equipment", companyId, "due", options.equipmentId ?? "all"],
    enabled: options.enabled ?? true,
    queryFn: () => loadEquipmentDue(companyId, options.equipmentId),
  });
}

/** Tags, an inspection sticker or other paperwork, with how long it has left (public.equipment_paperwork). */
export interface PaperRow {
  id: string;
  company_id: string;
  equipment_id: string;
  equipment_name: string;
  equipment_kind: string;
  crew_id: string | null;
  equipment_status: string;
  kind: string;
  name: string | null;
  expires_on: string | null;
  notes: string | null;
  days_left: number | null;
  state: DueState;
}

/** Paperwork on equipment in use (or one machine's), soonest to run out first. */
export async function loadPaperwork(companyId: string, equipmentId?: string) {
  const rows = await everyRow(
    () => {
      const q = supabase().from("equipment_paperwork").select("*").eq("company_id", companyId);
      return equipmentId ? q.eq("equipment_id", equipmentId) : q;
    },
    { order: { column: "expires_on", nullsFirst: false } },
  );
  return rows as unknown as PaperRow[];
}

export function usePaperwork(companyId: string, options: { enabled?: boolean; equipmentId?: string } = {}) {
  return useQuery({
    queryKey: ["equipment", companyId, "paperwork", options.equipmentId ?? "all"],
    enabled: options.enabled ?? true,
    queryFn: () => loadPaperwork(companyId, options.equipmentId),
  });
}

/** What a machine needs next, maintenance or paperwork, in a few words. */
export interface NextUp {
  name: string;
  summary: string;
  state: DueState;
  plan?: DueRow;
  paper?: PaperRow;
}

/**
 * The most urgent of a machine's schedules (most urgent first, as useEquipmentDue sorts them) and
 * paperwork: the worse state wins; at the same state, overdue or coming due, whichever date is
 * sooner (paperwork on a tie, or against hours and miles: it's what keeps a truck off the road);
 * when nothing's due, the next maintenance.
 */
export function nextUp(plans: DueRow[], papers: PaperRow[]): NextUp | null {
  const plan = plans[0];
  const paper = papers.filter((p) => p.expires_on).sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0))[0];
  const usePaper =
    paper &&
    (!plan ||
      STATE_ORDER[paper.state] < STATE_ORDER[plan.state] ||
      (paper.state === plan.state && paper.state !== "ok" && (plan.days_left == null || (paper.days_left ?? 0) <= plan.days_left)));
  if (usePaper) return { name: documentLabel(paper.kind, paper.name), summary: expirySummary(paper.days_left, paper.expires_on), state: paper.state, paper };
  return plan ? { name: plan.name, summary: dueSummary(plan), state: plan.state, plan } : null;
}

/** By machine: its schedules and paperwork, for nextUp. */
export function groupByEquipment<T extends { equipment_id: string }>(rows: T[] | undefined) {
  const map = new Map<string, T[]>();
  for (const row of rows ?? []) map.set(row.equipment_id, [...(map.get(row.equipment_id) ?? []), row]);
  return map;
}

/** After logging work or editing equipment: everything that shows equipment refreshes. */
export function refreshEquipment(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["equipment"] });
  queryClient.invalidateQueries({ queryKey: ["field-equipment"] });
}
