/**
 * Who someone is on Timesheets, reports and the schedule, from GET /api/team?with_subs=1: their
 * name, or for a sub, their business (a sub's sign-in isn't on the team list, but their hours and
 * visits still need a name).
 */
export interface NamedMember {
  profile: { full_name?: string | null } | null;
  sub?: { id: string; name: string };
}

export const memberName = (m: NamedMember | undefined, fallback = "Former team member") => (m?.sub ? `${m.sub.name} (sub)` : m?.profile?.full_name || fallback);
