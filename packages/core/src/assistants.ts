/**
 * What a connected AI assistant (Claude, ChatGPT and other MCP clients) may change. Each
 * connection starts out only reading; the person who connected it can let it change chosen areas,
 * give it full access, which also lets it delete, or full access without money (quotes, invoices,
 * payments and pay). It never gets more than the person's own role (row-level security and the
 * database's own rules still apply), and some things stay out of reach whatever it's given: sign-in,
 * passwords and spare keys, connected apps and keys, and its own access.
 *
 * The web app's access picker, the MCP server (apps/api/src/mcp.ts) and the database
 * (private.assistant_may_change, in the assistant_areas migrations) use the same rules.
 */
import type { Permission, Role } from "./roles";

const SALES_ROLES = ["owner", "admin", "office", "estimator"] as const;
const OFFICE_ROLES = ["owner", "admin", "office"] as const;

export const ASSISTANT_AREA_GROUPS = ["Customers and work", "Schedule and time", "Money", "Setup", "Team"] as const;
export type AssistantAreaGroup = (typeof ASSISTANT_AREA_GROUPS)[number];

export const ASSISTANT_AREAS = [
  { key: "clients", label: "Clients and properties", group: "Customers and work", money: false, roles: SALES_ROLES, permission: null },
  { key: "records", label: "Requests and notes", group: "Customers and work", money: false, roles: SALES_ROLES, permission: null },
  { key: "jobs", label: "Jobs and recurring services", group: "Customers and work", money: false, roles: SALES_ROLES, permission: null },
  // Crew leads schedule their own crew; the database holds them to it.
  { key: "schedule", label: "Schedule", group: "Schedule and time", money: false, roles: ["owner", "admin", "office", "estimator", "crew_lead"], permission: null },
  // Everyone has their own clock; the database decides whose time they can change.
  { key: "time", label: "Clocks and timesheets", group: "Schedule and time", money: false, roles: ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"], permission: null },
  { key: "quotes", label: "Quotes", group: "Money", money: true, roles: SALES_ROLES, permission: "sales" },
  { key: "invoices", label: "Invoices and payments", group: "Money", money: true, roles: OFFICE_ROLES, permission: "invoices" },
  { key: "pay", label: "Pay and pay rates", group: "Money", money: true, roles: OFFICE_ROLES, permission: "job_costs" },
  { key: "company", label: "Company details", group: "Setup", money: false, roles: ["owner", "admin"], permission: null },
  { key: "prices", label: "Price list", group: "Setup", money: false, roles: SALES_ROLES, permission: "settings" },
  { key: "crews", label: "Crews", group: "Setup", money: false, roles: OFFICE_ROLES, permission: "settings" },
  { key: "checklists", label: "Checklists", group: "Setup", money: false, roles: OFFICE_ROLES, permission: "settings" },
  { key: "booking", label: "Online booking forms", group: "Setup", money: false, roles: OFFICE_ROLES, permission: "settings" },
  { key: "guides", label: "Guides", group: "Setup", money: false, roles: OFFICE_ROLES, permission: "kb_edit" },
  { key: "automations", label: "Automations", group: "Setup", money: false, roles: OFFICE_ROLES, permission: "automations" },
  { key: "team", label: "People and roles", group: "Team", money: false, roles: ["owner", "admin"], permission: "team" },
] as const satisfies ReadonlyArray<{ key: string; label: string; group: AssistantAreaGroup; money: boolean; roles: readonly Role[]; permission: Permission | null }>;

export type AssistantArea = (typeof ASSISTANT_AREAS)[number]["key"];
export type AssistantLevel = "read" | "areas" | "full" | "full_no_money";
export interface AssistantAccess {
  level: AssistantLevel;
  /** What it may add and change when the level is "areas". */
  areas: AssistantArea[];
}

export const READ_ONLY_ACCESS: AssistantAccess = { level: "read", areas: [] };

export const isAssistantArea = (value: unknown): value is AssistantArea => ASSISTANT_AREAS.some((a) => a.key === value);
export const assistantAreaLabel = (area: AssistantArea) => ASSISTANT_AREAS.find((a) => a.key === area)?.label ?? area;
/** Quotes, invoices and payments, and pay: what "Full access, no money" leaves out. */
export const isMoneyArea = (area: AssistantArea) => ASSISTANT_AREAS.some((a) => a.key === area && a.money);
export const MONEY_AREAS: AssistantArea[] = ASSISTANT_AREAS.filter((a) => a.money).map((a) => a.key);

/** A stored connection (public.assistant_connections), or none: only reading. */
export function toAssistantAccess(row: { level?: string | null; areas?: readonly string[] | null } | null | undefined): AssistantAccess {
  if (row?.level === "full" || row?.level === "full_no_money") return { level: row.level, areas: [] };
  if (row?.level === "areas") return { level: "areas", areas: (row.areas ?? []).filter(isAssistantArea) };
  return READ_ONLY_ACCESS;
}

/**
 * Full access changes and deletes anything; full access without money the same, except quotes,
 * invoices, payments and pay; chosen areas add and change there, but don't delete.
 */
export function mayChange(access: AssistantAccess, area: AssistantArea, deleting = false): boolean {
  if (access.level === "full") return true;
  if (access.level === "full_no_money") return !isMoneyArea(area);
  return access.level === "areas" && !deleting && access.areas.includes(area);
}

/** The areas this person's own role can change, so they're the only ones worth offering. */
export function areasForRole(role: Role, permissions: readonly Permission[]): AssistantArea[] {
  return ASSISTANT_AREAS.filter((a) => (a.roles as readonly Role[]).includes(role) && (a.permission === null || permissions.includes(a.permission))).map((a) => a.key);
}

/** What an area's refusal calls it: "This assistant can't change the price list." */
const AREA_NOUNS: Record<AssistantArea, string> = {
  clients: "clients and properties",
  records: "requests and notes",
  jobs: "jobs",
  schedule: "the schedule",
  time: "clocks and timesheets",
  quotes: "quotes",
  invoices: "invoices and payments",
  pay: "pay",
  company: "company details",
  prices: "the price list",
  crews: "crews",
  checklists: "checklists",
  booking: "booking forms",
  guides: "guides",
  automations: "automations",
  team: "people and roles",
};

/** Why an assistant can't make a change, and where to allow it. The database says the same (hooks.before_request). */
export function assistantRefusal(area: AssistantArea, deleting = false, access: AssistantAccess = READ_ONLY_ACCESS): string {
  if (access.level === "full_no_money" && isMoneyArea(area)) {
    return "This assistant can't change money: quotes, invoices, payments or pay. To let it, give it Full access in Crewtavo, under Settings → AI assistants.";
  }
  return deleting && access.level === "areas"
    ? "This assistant can't delete things. Only an assistant with full access can, in Crewtavo, under Settings → AI assistants."
    : `This assistant can't change ${AREA_NOUNS[area]}. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.`;
}

/** "Read only", "Can change: Price list, Crews", "Full access", "Full access, no money". */
export function describeAssistantAccess(access: AssistantAccess): string {
  if (access.level === "full") return "Full access";
  if (access.level === "full_no_money") return "Full access, no money";
  if (access.level === "areas" && access.areas.length) return `Can change: ${access.areas.map(assistantAreaLabel).join(", ")}`;
  return "Read only";
}

/** What each MCP tool did, for Recent assistant activity. A test checks every tool has one. */
export const ASSISTANT_TOOL_LABELS: Record<string, string> = {
  // Clients and requests
  search_clients: "Searched clients",
  list_clients: "Listed clients",
  get_client: "Looked at a client",
  create_client: "Added a client",
  update_client: "Changed a client",
  set_client_status: "Archived or restored clients",
  delete_client: "Deleted a client",
  save_property: "Saved a property",
  delete_property: "Deleted a property",
  save_contact: "Saved a contact",
  delete_contact: "Deleted a contact",
  import_clients: "Imported clients",
  list_requests: "Listed requests",
  create_request: "Logged a request",
  add_note: "Added a note",
  // Jobs and the schedule
  list_jobs: "Listed jobs",
  get_job: "Looked at a job",
  create_job: "Created a job",
  update_job: "Changed a job",
  delete_job: "Deleted a job",
  import_schedule: "Imported a schedule",
  get_schedule: "Checked the schedule",
  create_visit: "Scheduled a visit",
  update_visit: "Changed a visit",
  delete_visit: "Deleted a visit",
  rain_day: "Moved a day's visits",
  organize_route: "Organized a route",
  find_time: "Looked for open time",
  bulk_visits: "Scheduled visits for several jobs",
  // Money
  business_summary: "Looked at the business summary",
  money_report: "Looked at money figures",
  sales_report: "Looked at sales figures",
  job_profit: "Looked at job profit",
  team_hours_report: "Looked at team hours",
  list_quotes: "Listed quotes",
  get_quote: "Looked at a quote",
  create_quote: "Created a quote",
  update_quote: "Changed a quote",
  send_quote: "Sent a quote",
  convert_quote_to_job: "Turned a quote into a job",
  mark_quote: "Marked a quote lost or archived",
  list_invoices: "Listed invoices",
  get_invoice: "Looked at an invoice",
  invoice_job: "Invoiced a job",
  invoice_jobs: "Invoiced several jobs",
  send_invoice: "Sent an invoice",
  send_reminders: "Sent payment reminders",
  record_payment: "Recorded a payment",
  void_invoice: "Voided an invoice",
  // Team, time and pay
  list_team: "Looked at the team",
  invite_person: "Invited someone",
  change_role: "Changed someone's role",
  deactivate_person: "Removed someone's access",
  restore_person: "Gave someone access back",
  save_role: "Saved a role",
  delete_role: "Deleted a role",
  list_time: "Looked at time",
  clock_in: "Clocked someone in",
  clock_out: "Clocked someone out",
  save_time_entry: "Saved a time entry",
  delete_time_entry: "Deleted a time entry",
  approve_time: "Approved time",
  unapprove_time: "Took back a time approval",
  pay_summary: "Looked at a pay period",
  set_pay_rate: "Changed a pay rate",
  mark_paid: "Marked people paid",
  unmark_paid: "Took back a paid mark",
  pay_history: "Looked at pay history",
  // Setup
  search_sops: "Searched the knowledge base",
  equipment_maintenance: "Checked equipment maintenance",
  get_company_settings: "Looked at company settings",
  update_company_settings: "Changed company settings",
  list_services: "Looked at the price list",
  add_services: "Added to the price list",
  update_service: "Changed a price list item",
  delete_service: "Deleted a price list item",
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
