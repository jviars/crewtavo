/** Shared queries and types for equipment, its maintenance schedules and history. */
import { dueProgress, type DueState, type IntervalUnit, type Meter } from "@crewtavo/core/equipment";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
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

/** Every active schedule in the company, most urgent first. */
export function useEquipmentDue(companyId: string, options: { enabled?: boolean; equipmentId?: string } = {}) {
  return useQuery({
    queryKey: ["equipment", companyId, "due", options.equipmentId ?? "all"],
    enabled: options.enabled ?? true,
    queryFn: async () => {
      let q = supabase().from("equipment_due").select("*").eq("company_id", companyId).limit(2000);
      if (options.equipmentId) q = q.eq("equipment_id", options.equipmentId);
      return (unwrap(await q) as unknown as DueRow[]).sort(byUrgency);
    },
  });
}

/** After logging work or editing equipment: everything that shows equipment refreshes. */
export function refreshEquipment(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["equipment"] });
  queryClient.invalidateQueries({ queryKey: ["field-equipment"] });
}
