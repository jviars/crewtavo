/**
 * Who can change which part of the schedule. With "Schedule the whole team" (the schedule area):
 * every crew. A crew lead without it runs their own crews: the ones they lead or are on. The
 * database enforces the same rules (private.schedules_crew).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";

/** Crews the signed-in person leads or is on. */
export function useMyCrews(enabled = true) {
  const session = useSession();
  return useQuery({
    queryKey: ["my-crews", session.company.id, session.userId],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().rpc("my_crew_ids", { p_company: session.company.id })) as string[],
  });
}

export function useSchedulingRights() {
  const session = useSession();
  const wholeTeam = hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "schedule");
  const ownCrew = session.role === "crew_lead" && !wholeTeam;
  const myCrews = useMyCrews(ownCrew);
  const crews = myCrews.data ?? [];
  return {
    /** Can schedule something (every crew, or their own). */
    canDispatch: wholeTeam || ownCrew,
    wholeTeam,
    /** A crew lead limited to their own crews. */
    ownCrew,
    myCrews: crews,
    /** May this visit (or a visit on this crew) be moved, edited or reassigned? */
    canChange: (crewId: string | null | undefined) => wholeTeam || (ownCrew && Boolean(crewId) && crews.includes(crewId!)),
  };
}
