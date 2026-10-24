/**
 * For a crew lead on My day: the crew's clocks in one place. Clock everyone in (onto a visit, the
 * drive or the shop), switch them (to lunch and back) or clock them out with one tap, or one person
 * at a time. Their time lands on their own
 * timesheets, ready for the office.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { initials } from "@/components/ui/Avatar";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useMyCrews } from "../schedule/myCrews";
import { useDispatchOptions } from "../schedule/VisitDialog";
import { CATEGORY_LABELS, clockPlace, formatDuration, type TimerCategory } from "./fieldData";

interface VisitTarget { id: string; title: string; job: { id: string } | null; status: string }
type Target = { category: TimerCategory; visit?: VisitTarget };

export function CrewClockCard({ visits }: { visits: VisitTarget[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const crews = useMyCrews();
  const options = useDispatchOptions();
  const mine = crews.data ?? [];
  const leads = (options.data?.crews ?? []).filter((c) => c.lead_user_id === session.userId && mine.includes(c.id));
  const crewIds = new Set(leads.map((c) => c.id));
  const people = [
    ...new Set([session.userId, ...(options.data?.crewMembers ?? []).filter((m) => crewIds.has(m.crew_id)).map((m) => m.user_id)]),
  ].filter((id) => options.data?.team.some((t) => t.user_id === id));
  const key = ["crew-clock", session.company.id, people.join(",")];
  const nameOf = (id: string) => options.data?.team.find((t) => t.user_id === id)?.profile?.full_name || "Crew member";

  const running = useQuery({
    queryKey: key,
    enabled: people.length > 1,
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("time_entries")
          .select("id, user_id, category, started_at, visit:visits(title)")
          .eq("company_id", session.company.id)
          .in("user_id", people)
          .is("ended_at", null),
      ),
  });

  const act = useMutation({
    meta: { success: (_: unknown, v: { who: string[]; target: Target | null }) => (v.target ? `Clocked in ${v.who.length === 1 ? nameOf(v.who[0]!) : `${v.who.length} people`}` : `Clocked out ${v.who.length === 1 ? nameOf(v.who[0]!) : `${v.who.length} people`}`) },
    mutationFn: async ({ who, target }: { who: string[]; target: Target | null }) => {
      const now = new Date().toISOString();
      const db = supabase();
      // Where the lead's phone is: the crew is with them when they clock everyone in or out.
      const place = await clockPlace(session.company);
      // Stop whatever they're on, then (when clocking in) start the new one.
      unwrap(await db.from("time_entries").update({ ended_at: now, out_place: place }).eq("company_id", session.company.id).in("user_id", who).is("ended_at", null));
      if (target) {
        unwrap(
          await db.from("time_entries").insert(
            who.map((user_id) => ({
              company_id: session.company.id,
              user_id,
              category: target.category,
              visit_id: target.visit?.id ?? null,
              job_id: target.visit?.job?.id ?? null,
              started_at: now,
              in_place: place,
            })),
          ),
        );
      }
    },
    onSettled: () => {
      for (const k of ["crew-clock", "running-timer", "time", "field"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });

  if (!leads.length) return null;
  if (options.isPending || crews.isPending || running.isPending) return <div className="card card-pad"><Skeleton height={80} /></div>;
  if (people.length < 2) return null;

  const entryOf = (id: string) => running.data?.find((r) => r.user_id === id);
  const off = people.filter((p) => !entryOf(p));
  const on = people.filter((p) => entryOf(p));
  const targets: Array<{ label: string; target: Target }> = [
    ...visits.filter((v) => !["completed", "cancelled"].includes(v.status)).map((v) => ({ label: v.title, target: { category: "visit" as const, visit: v } })),
    { label: CATEGORY_LABELS.drive, target: { category: "drive" } },
    { label: CATEGORY_LABELS.shop, target: { category: "shop" } },
    // Lunch for the whole crew; clock them back onto the visit after.
    { label: CATEGORY_LABELS.break, target: { category: "break" } },
    { label: CATEGORY_LABELS.other, target: { category: "other" } },
  ];
  const clockIn = (who: string[], label: string, text = label) => (
    <Menu
      label={label}
      triggerClassName="btn btn-sm"
      trigger={<>{act.isPending && act.variables?.target && act.variables.who.join() === who.join() ? <Spinner size={14} /> : <Icon name="play" size={14} />}{text}</>}
      items={targets.map((t) => ({ label: t.label, disabled: act.isPending, onSelect: () => act.mutate({ who, target: t.target }) }))}
    />
  );

  return (
    <section className="card">
      <div className="card-head" style={{ flexWrap: "wrap", gap: 8 }}>
        <strong className="grow">Crew clock</strong>
        {off.length > 0 && clockIn(off, off.length === people.length ? "Clock everyone in" : `Clock in ${off.length} more`)}
        {/* Everyone on the clock onto something else at once: lunch, and back onto the visit after. */}
        {on.length > 0 && clockIn(on, on.length === people.length ? "Switch everyone" : `Switch the ${on.length} on the clock`, "Switch")}
        {on.length > 0 && <Button size="sm" variant="dark" icon="pause" loading={act.isPending && act.variables?.target === null && act.variables.who.length > 1} onClick={() => act.mutate({ who: on, target: null })}>Clock everyone out</Button>}
      </div>
      {people.map((id) => {
        const entry = entryOf(id);
        const visit = entry?.visit as { title: string } | null | undefined;
        const name = nameOf(id);
        return (
          <div key={id} className="card-row">
            <span className="avatar" style={{ width: 30, height: 30, fontSize: 11, background: entry ? "var(--green-solid)" : "var(--fill-3)", color: entry ? "#fff" : "var(--text-2)" }}>{initials(name)}</span>
            <span className="grow" style={{ minWidth: 0 }}>
              <strong>{name}{id === session.userId ? " (you)" : ""}</strong>
              <span className="muted small" style={{ display: "block" }}>
                {entry ? `${visit?.title ?? CATEGORY_LABELS[entry.category as TimerCategory] ?? "Working"} · ${formatDuration(Date.now() - Date.parse(entry.started_at))}` : "Clock is off"}
              </span>
            </span>
            {entry ? (
              <Button size="sm" variant="ghost" icon="pause" aria-label={`Clock out ${name}`} loading={act.isPending && act.variables?.who.length === 1 && act.variables.who[0] === id} onClick={() => act.mutate({ who: [id], target: null })} />
            ) : (
              clockIn([id], `Clock in ${name}`, "In")
            )}
          </div>
        );
      })}
    </section>
  );
}
