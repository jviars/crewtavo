/** Member roles, mirroring the public.member_role enum in Postgres. */
export const ROLES = ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"] as const;
export type Role = (typeof ROLES)[number];

/** Role groups used by API route guards. RLS in Postgres enforces the same rules. */
export const ADMINS: readonly Role[] = ["owner", "admin"];
export const OFFICE: readonly Role[] = ["owner", "admin", "office"];
export const SALES: readonly Role[] = ["owner", "admin", "office", "estimator"];
export const DISPATCH: readonly Role[] = ["owner", "admin", "office", "estimator", "crew_lead"];
export const EVERYONE: readonly Role[] = ROLES;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  office: "Office",
  estimator: "Estimator",
  crew_lead: "Crew lead",
  field_crew: "Field crew",
};

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

/**
 * Areas a role can be given. A member's access level (above) decides which records they can reach;
 * a custom role can switch areas off within that level. Mirrors private.level_permissions() in
 * supabase/migrations, which enforces the same rules in the database.
 */
export const PERMISSIONS = [
  { key: "sales", label: "Quotes and sales" },
  { key: "invoices", label: "Invoices and payments" },
  { key: "job_costs", label: "Job costs and profit" },
  { key: "reports", label: "Reports" },
  { key: "marketing", label: "Marketing" },
  { key: "automations", label: "Automations" },
  { key: "schedule", label: "Schedule the whole team" },
  { key: "timesheets", label: "Approve timesheets (crew leads: their crew's)" },
  { key: "settings", label: "Price list, checklists, crews and booking forms" },
  { key: "kb_edit", label: "Write and edit guides" },
  { key: "team", label: "Manage people and roles" },
  { key: "apps", label: "Connect apps" },
  { key: "equipment", label: "Manage equipment and maintenance" },
] as const;
export type Permission = (typeof PERMISSIONS)[number]["key"];

const ALL: Permission[] = PERMISSIONS.map((p) => p.key);
export const LEVEL_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  admin: ALL,
  office: ALL.filter((p) => p !== "team" && p !== "apps"),
  estimator: ["sales", "schedule", "equipment"],
  // A crew lead always runs their own crew; "schedule" extends that to every crew.
  crew_lead: ["schedule", "timesheets", "equipment"],
  field_crew: [],
};

/** What each access level can reach, in a few words, for picking a level. */
export const LEVEL_SUMMARY: Record<Role, string> = {
  owner: "Everything, including billing and ownership",
  admin: "Everything",
  office: "All clients, jobs and money",
  estimator: "Clients, requests, quotes and the schedule. No invoices",
  crew_lead: "Schedules and staffs their own crew, sees its time. Sees the whole schedule. No prices",
  field_crew: "Only their own visits and time. No prices",
};

export const isPermission = (value: unknown): value is Permission => typeof value === "string" && (ALL as string[]).includes(value);

/** Effective areas for a member: their custom role's list, or everything their level allows. */
export function memberPermissions(role: Role, customPermissions?: readonly string[] | null): Permission[] {
  const allowed = LEVEL_PERMISSIONS[role];
  return customPermissions ? allowed.filter((p) => customPermissions.includes(p)) : [...allowed];
}

/**
 * Who may make a password reset link for whom (Settings → People): only for someone strictly below
 * them, so nobody can take over an account with as much access as their own. The owner: everyone
 * but other owners. An admin: people below admin. The API enforces it (apps/api/src/routes/recovery.ts).
 */
export function canMakeResetLink(requester: Role, target: Role): boolean {
  if (requester === "owner") return target !== "owner";
  if (requester === "admin") return target !== "owner" && target !== "admin";
  return false;
}
