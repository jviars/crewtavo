/**
 * For a crew lead on My day: the crew's clocks in one place. Clock everyone in (onto a visit, the
 * drive or the shop), switch them (to lunch and back) or clock them out with one tap, or one person
 * at a time. Their time lands on their own
 * timesheets, ready for the office.
 *
 * Its taps work with no signal, like the lead's own clock card: saved on the phone with when they
 * were tapped and sent in order (clockTaps.ts, fieldActions.setClock).
 */
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { initials } from "@/components/ui/Avatar";
import { supabase, unwrap } from "@/lib/api";
import { FIELD_SCOPE } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useMyCrews } from "../schedule/myCrews";
import { useDispatchOptions } from "../schedule/VisitDialog";
import { clockChange, clockSaved, crewAfter, showClockTap, waitingClockTaps, type ClockChange, type ClockTarget, type CrewClockRow } from "./clockTaps";
import { CATEGORY_ICONS } from "./ClockCard";
import { CATEGORY_LABELS, clockPlace, formatDuration, type TimerCategory } from "./fieldData";
import { msg, t } from "@/lib/i18n";

interface VisitTarget { id: string; title: string; job: { id: string } | null; status: string }

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
  ].filter((id) => options.data?.team.some((m) => m.user_id === id));
  const key = ["crew-clock", session.company.id, people.join(",")];
  const nameOf = (id: string) => options.data?.team.find((m) => m.user_id === id)?.profile?.full_name || t("Crew member");

  const running = useQuery({
    queryKey: key,
    enabled: people.length > 1,
    refetchInterval: 60_000,
    queryFn: async (): Promise<CrewClockRow[]> => {
      const rows = unwrap(
        await supabase()
          .from("time_entries")
          .select("id, user_id, category, started_at, visit:visits(id, title)")
          .eq("company_id", session.company.id)
          .in("user_id", people)
          .is("ended_at", null),
      );
      // With the taps still waiting on this phone on top: what the server says is older than those.
      return crewAfter(rows, people, waitingClockTaps(queryClient, session.company.id));
    },
  });

  // Sent by the action registered for it (fieldActions.ts), not a mutationFn here: lib/offline.ts
  // notes when it's on its way, for the count of updates waiting.
  const act = useMutation({
    mutationKey: ["clock"],
    scope: FIELD_SCOPE,
    meta: { success: (result: { lost: string[] }, change: ClockChange) => clockSaved(result, change, { nameOf }) },
    onMutate: (change: ClockChange) => {
      if (!onlineManager.isOnline()) toast.info(t("Saved on this phone"), { description: t("It sends when you have signal.") });
      showClockTap(queryClient, { key: "clock", change });
    },
    onSettled: () => {
      for (const k of ["crew-clock", "running-timer", "time", "field"]) queryClient.invalidateQueries({ queryKey: [k] });
    },
  });
  // Where the lead's phone is comes first (the crew is with them when they clock everyone in or
  // out) and can take a few seconds; the tap is dated before it.
  const [locating, setLocating] = useState<{ who: string[]; target: ClockTarget | null } | null>(null);
  const tap = async (who: string[], target: ClockTarget | null) => {
    const at = new Date().toISOString();
    setLocating({ who, target });
    const place = await clockPlace(session);
    setLocating(null);
    act.mutate(clockChange(session, who, target, place, at));
  };
  // The tap on its way. One waiting for signal isn't: the card is free for the next.
  const going = locating ?? (act.isPending && !act.isPaused && act.variables ? { who: act.variables.who, target: act.variables.target } : null);

  if (!leads.length) return null;
  if (options.isPending || crews.isPending || running.isPending) return <SectionSkeleton rows={2} />;
  if (people.length < 2) return null;

  const entryOf = (id: string) => running.data?.find((r) => r.user_id === id);
  const off = people.filter((p) => !entryOf(p));
  const on = people.filter((p) => entryOf(p));
  const targets: Array<{ label: string; icon: IconName; target: ClockTarget }> = [
    ...visits.filter((v) => !["completed", "cancelled"].includes(v.status)).map((v) => ({ label: v.title, icon: "job" as const, target: { category: "visit" as const, visit: { id: v.id, jobId: v.job?.id ?? null, title: v.title } } })),
    { label: t(CATEGORY_LABELS.drive), icon: CATEGORY_ICONS.drive, target: { category: "drive" } },
    { label: t(CATEGORY_LABELS.shop), icon: CATEGORY_ICONS.shop, target: { category: "shop" } },
    // Lunch for the whole crew; clock them back onto the visit after.
    { label: t(CATEGORY_LABELS.break), icon: CATEGORY_ICONS.break, target: { category: "break" } },
    { label: t(CATEGORY_LABELS.other), icon: CATEGORY_ICONS.other, target: { category: "other" } },
  ];
  const onto = (who: string[]): MenuEntry[] => targets.map((x) => ({ label: x.label, icon: x.icon, disabled: going !== null, onSelect: () => void tap(who, x.target) }));
  const busy = (who: string[]) => going?.target && going.who.join() === who.join();

  // The whole crew at once: clock in whoever's off, switch whoever's on (to lunch and back), clock everyone out.
  const crewWide: MenuEntry[] = [
    ...(off.length ? [{ label: off.length === people.length ? t("Clock everyone in") : t("Clock in {count} more", { count: off.length }), icon: "play" as const, items: onto(off) }] : []),
    ...(on.length ? [{ label: on.length === people.length ? t("Switch everyone") : t("Switch the {count} on the clock", { count: on.length }), icon: "refresh" as const, items: onto(on) }] : []),
    ...(on.length ? [{ separator: true as const }, { label: t("Clock everyone out"), icon: "pause" as const, disabled: going !== null, onSelect: () => void tap(on, null) }] : []),
  ];
  // Everyone off: the menu is where they go, straight away.
  const only = off.length === people.length;
  const working = busy(off) || busy(on) || (going?.target === null && going.who.length > 1);

  return (
    <Section
      title={t("Crew clock")}
      count={t("{on} of {count} on the clock", { on: on.length, count: people.length })}
      className="crew-clock"
      action={
        <Menu
          label={only ? t("Clock everyone in") : t("Everyone")}
          title={only ? t("Clock everyone in") : t("Crew clock")}
          triggerClassName="crew-clock-all"
          trigger={<>{working ? <Spinner size={14} /> : <Icon name={only ? "play" : "users"} size={14} />}{only ? t("Clock everyone in") : t("Everyone")}<Icon name="chevronDown" size={14} /></>}
          items={only ? onto(off) : crewWide}
        />
      }
    >
      <RelatedList label={t("Crew clock")}>
        {people.map((id) => {
          const entry = entryOf(id);
          const visit = entry?.visit;
          const name = nameOf(id);
          return (
            <RelatedRow
              key={id}
              lead={<span className="crew-face" data-on={entry ? true : undefined}>{initials(name)}</span>}
              title={<>{name}{id === session.userId ? t(" (you)") : ""}</>}
              sub={entry ? [visit?.title ?? t(CATEGORY_LABELS[entry.category as TimerCategory] ?? msg("Working")), formatDuration(Date.now() - Date.parse(entry.started_at))] : t("Clock is off")}
              actions={
                entry ? (
                  <Button icon="pause" className="crew-clock-out" aria-label={t("Clock out {name}", { name })} title={t("Clock out {name}", { name })} loading={going?.target === null && going.who.length === 1 && going.who[0] === id} onClick={() => void tap([id], null)} />
                ) : (
                  <Menu
                    label={t("Clock in {name}", { name })}
                    title={t("Clock in {name}", { name })}
                    triggerClassName="btn"
                    trigger={<>{busy([id]) ? <Spinner size={14} /> : <Icon name="play" size={14} />}{t("Clock in")}</>}
                    items={onto([id])}
                  />
                )
              }
            />
          );
        })}
      </RelatedList>
    </Section>
  );
}
