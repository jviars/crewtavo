/**
 * What a connected AI assistant (Claude, ChatGPT and other MCP clients) may change. Each
 * connection starts out only reading; the person who connected it can let it change chosen areas,
 * or give it full access, which also lets it delete. It never gets more than the person's own role
 * (row-level security still applies), and some things stay out of reach whatever it's given: sign-in,
 * people and roles, connected apps and keys, and its own access.
 *
 * The web app's access picker, the MCP server (apps/api/src/mcp.ts) and the database
 * (private.assistant_may_change, in the assistant_areas migration) use the same rules.
 */
import type { Permission, Role } from "./roles";

export const ASSISTANT_AREAS = [
  { key: "records", label: "Requests and notes", roles: ["owner", "admin", "office", "estimator"], permission: null },
  { key: "company", label: "Company details", roles: ["owner", "admin"], permission: null },
  { key: "prices", label: "Price list", roles: ["owner", "admin", "office", "estimator"], permission: "settings" },
  { key: "crews", label: "Crews", roles: ["owner", "admin", "office"], permission: "settings" },
  { key: "checklists", label: "Checklists", roles: ["owner", "admin", "office"], permission: "settings" },
  { key: "booking", label: "Online booking forms", roles: ["owner", "admin", "office"], permission: "settings" },
  { key: "guides", label: "Guides", roles: ["owner", "admin", "office"], permission: "kb_edit" },
  { key: "automations", label: "Automations", roles: ["owner", "admin", "office"], permission: "automations" },
] as const satisfies ReadonlyArray<{ key: string; label: string; roles: readonly Role[]; permission: Permission | null }>;

export type AssistantArea = (typeof ASSISTANT_AREAS)[number]["key"];
export type AssistantLevel = "read" | "areas" | "full";
export interface AssistantAccess {
  level: AssistantLevel;
  /** What it may add and change when the level is "areas". */
  areas: AssistantArea[];
}

export const READ_ONLY_ACCESS: AssistantAccess = { level: "read", areas: [] };

export const isAssistantArea = (value: unknown): value is AssistantArea => ASSISTANT_AREAS.some((a) => a.key === value);
export const assistantAreaLabel = (area: AssistantArea) => ASSISTANT_AREAS.find((a) => a.key === area)?.label ?? area;

/** A stored connection (public.assistant_connections), or none: only reading. */
export function toAssistantAccess(row: { level?: string | null; areas?: readonly string[] | null } | null | undefined): AssistantAccess {
  if (row?.level === "full") return { level: "full", areas: [] };
  if (row?.level === "areas") return { level: "areas", areas: (row.areas ?? []).filter(isAssistantArea) };
  return READ_ONLY_ACCESS;
}

/** Full access changes and deletes anything; chosen areas add and change there, but don't delete. */
export function mayChange(access: AssistantAccess, area: AssistantArea, deleting = false): boolean {
  if (access.level === "full") return true;
  return access.level === "areas" && !deleting && access.areas.includes(area);
}

/** The areas this person's own role can change, so they're the only ones worth offering. */
export function areasForRole(role: Role, permissions: readonly Permission[]): AssistantArea[] {
  return ASSISTANT_AREAS.filter((a) => (a.roles as readonly Role[]).includes(role) && (a.permission === null || permissions.includes(a.permission))).map((a) => a.key);
}

/** What an area's refusal calls it: "This assistant can't change the price list." */
const AREA_NOUNS: Record<AssistantArea, string> = {
  records: "requests and notes",
  company: "company details",
  prices: "the price list",
  crews: "crews",
  checklists: "checklists",
  booking: "booking forms",
  guides: "guides",
  automations: "automations",
};

/** Why an assistant can't make a change, and where to allow it. The database says the same (hooks.before_request). */
export function assistantRefusal(area: AssistantArea, deleting = false): string {
  return deleting
    ? "This assistant can't delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants."
    : `This assistant can't change ${AREA_NOUNS[area]}. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.`;
}

/** "Read only", "Can change: Price list, Crews", "Full access". */
export function describeAssistantAccess(access: AssistantAccess): string {
  if (access.level === "full") return "Full access";
  if (access.level === "areas" && access.areas.length) return `Can change: ${access.areas.map(assistantAreaLabel).join(", ")}`;
  return "Read only";
}

/** What each MCP tool did, for Recent assistant activity. A test checks every tool has one. */
export const ASSISTANT_TOOL_LABELS: Record<string, string> = {
  search_clients: "Searched clients",
  get_client: "Looked at a client",
  list_requests: "Listed requests",
  create_request: "Logged a request",
  get_schedule: "Checked the schedule",
  add_note: "Added a note",
  search_sops: "Searched the knowledge base",
  equipment_maintenance: "Checked equipment maintenance",
  get_company_settings: "Looked at company settings",
  update_company_settings: "Changed company settings",
  list_services: "Looked at the price list",
  add_services: "Added to the price list",
  update_service: "Changed a price list item",
  delete_service: "Deleted a price list item",
  list_team: "Looked at the team",
  list_crews: "Looked at crews",
  save_crew: "Saved a crew",
  set_crew_members: "Changed who's on a crew",
  delete_crew: "Deleted a crew",
  list_checklists: "Looked at checklists",
  save_checklist: "Saved a checklist",
  delete_checklist: "Deleted a checklist",
  list_booking_forms: "Looked at booking forms",
  save_booking_form: "Saved a booking form",
  delete_booking_form: "Deleted a booking form",
  list_guide_categories: "Looked at guide categories",
  get_guide: "Read a guide",
  save_guide: "Saved a guide",
  delete_guide: "Deleted a guide",
  list_automations: "Looked at automations",
  automation_options: "Looked at automation options",
  save_automation: "Saved an automation",
  delete_automation: "Deleted an automation",
};
