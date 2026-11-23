import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { roleName, useCompanyRoles } from "./roles";
import styles from "./settings.module.css";
import type { Member } from "./TeamSettings";

const PALETTE = ["#3b7d23", "#3474d4", "#c9852a", "#d2445c", "#8b5cf6", "#0e7490", "#57534e", "#b45309"];

export function CrewSettings() {
  const session = useSession();
  const roles = useCompanyRoles();
  const queryClient = useQueryClient();
  const key = ["crews-settings", session.company.id];
  const data = useQuery({
    queryKey: key,
    queryFn: async () => {
      const [crews, team] = await Promise.all([
        supabase().from("crews").select("id, name, color, active, crew_members(user_id)").eq("company_id", session.company.id).order("name"),
        api.get<Member[]>("/team"),
      ]);
      return { crews: unwrap(crews), team: team.filter((m) => m.active) };
    },
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["crews-settings", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["dispatch-options", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["crews", session.company.id] });
    queryClient.invalidateQueries({ queryKey: ["schedule"] });
  };
  const [name, setName] = useState("");
  // The new crew's card appearing says it worked, and the button says so too.
  const add = useMutation({
    mutationFn: async () => unwrap(await supabase().from("crews").insert({ company_id: session.company.id, name: name.trim(), color: PALETTE[(data.data?.crews.length ?? 0) % PALETTE.length] })),
    onSuccess: () => { setName(""); refresh(); },
  });
  // Names, colors and who's on each crew save as they change, and say so beside Add crew.
  const saving = useSaveStatus();
  const update = useMutation({
    meta: { inline: true },
    mutationFn: async ({ id, patch }: { id: string; patch: { name?: string; color?: string; active?: boolean } }) => unwrap(await supabase().from("crews").update(patch).eq("id", id)),
    onSuccess: refresh,
  });
  const toggleMember = useMutation({
    meta: { inline: true },
    mutationFn: async ({ crewId, userId, on }: { crewId: string; userId: string; on: boolean }) =>
      on
        ? unwrap(await supabase().from("crew_members").insert({ company_id: session.company.id, crew_id: crewId, user_id: userId }))
        : unwrap(await supabase().from("crew_members").delete().eq("crew_id", crewId).eq("user_id", userId)),
    onSuccess: refresh,
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("crews").delete().eq("id", id)),
    onSettled: refresh,
  });
  type Crew = NonNullable<typeof data.data>["crews"][number];
  // Gone at once, with Undo. Once it's deleted for real, its visits keep their people but lose the crew.
  const deleteCrew = (crew: Crew) =>
    undoable({
      title: "Crew deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<typeof data.data>(key, (old) => old && { ...old, crews: old.crews.filter((c) => c.id !== crew.id) });
      },
      restore: () =>
        queryClient.setQueryData<typeof data.data>(key, (old) => (old && !old.crews.some((c) => c.id === crew.id) ? { ...old, crews: [...old.crews, crew].sort((a, b) => a.name.localeCompare(b.name)) } : old)),
      commit: () => remove.mutateAsync(crew.id),
    });

  const added = useJustDone(add);
  const cards = useListAnimation<HTMLUListElement>();
  const crews = data.data?.crews ?? [];
  return (
    <Section level={3} title="Crews" count={data.data ? crews.length : undefined} action={<SaveStatus status={saving.status} />}>
      {data.isPending ? <SectionSkeleton rows={3} /> : data.error ? <ErrorState compact error={data.error} onRetry={() => data.refetch()} /> : (
        <>
          {!crews.length && <EmptyState inline title="No crews yet" />}
          <ul className={styles.crews} role="list" ref={cards}>
            {crews.map((c) => {
              const on = data.data.team.filter((m) => c.crew_members.some((cm) => cm.user_id === m.user_id)).length;
              return (
                <li key={c.id} className={styles.crew} data-hidden={c.active ? undefined : true}>
                  <div className={styles.crewHead}>
                    <input type="color" className={`set-swatch ${styles.crewColor}`} value={c.color ?? "#3b7d23"} onChange={(e) => void saving.track(update.mutateAsync({ id: c.id, patch: { color: e.target.value } }))} aria-label={`${c.name} color`} style={{ background: c.color ?? "#3b7d23" }} />
                    <input className={styles.crewName} defaultValue={c.name} maxLength={60} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && void saving.track(update.mutateAsync({ id: c.id, patch: { name: e.target.value.trim() } }))} aria-label="Crew name" />
                    <span className={styles.crewCount}>{c.active ? `${on} ${on === 1 ? "person" : "people"}` : "Hidden from the schedule"}</span>
                    <Menu
                      label={`More for ${c.name}`}
                      title={c.name}
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      items={[
                        { label: c.active ? "Hide from the schedule" : "Show on the schedule", icon: c.active ? "archive" : "undo", onSelect: () => void saving.track(update.mutateAsync({ id: c.id, patch: { active: !c.active } })) },
                        { separator: true },
                        { label: "Delete crew", icon: "trash", danger: true, onSelect: () => deleteCrew(c) },
                      ]}
                    />
                  </div>
                  {data.data.team.length ? (
                    <div className={styles.crewPeople} role="group" aria-label={`People on ${c.name}`}>
                      {data.data.team.map((m) => (
                        <label key={m.user_id} className="checkbox">
                          <input type="checkbox" checked={c.crew_members.some((cm) => cm.user_id === m.user_id)} onChange={(e) => void saving.track(toggleMember.mutateAsync({ crewId: c.id, userId: m.user_id, on: e.target.checked }))} />
                          <span>{m.profile?.full_name || "Team member"} <span className="muted">· {roleName(m, roles.data)}</span></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="set-note">Invite your team under People to add them to crews.</p>
                  )}
                </li>
              );
            })}
          </ul>
          <form className={styles.addRow} onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
            <input className="input" placeholder="New crew name, e.g. Mowing crew 2" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="New crew name" />
            <Button type="submit" icon="plus" loading={add.isPending} done={added} doneLabel="Added" disabled={!name.trim() && !added}>Add crew</Button>
          </form>
        </>
      )}
    </Section>
  );
}
