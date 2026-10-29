import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, useJustDone } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { SaveStatus, useSaveStatus } from "@/components/ui/SaveStatus";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { roleName, useCompanyRoles } from "./roles";
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
  const cards = useListAnimation<HTMLDivElement>();
  return (
    <div className="stack">
      <form className="toolbar" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
        <input className="input" placeholder="New crew name, e.g. Mowing crew 2" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="New crew name" />
        <Button type="submit" icon="plus" loading={add.isPending} done={added} doneLabel="Added" disabled={!name.trim() && !added}>Add crew</Button>
        <SaveStatus status={saving.status} />
      </form>
      {data.isPending ? <Loading><div className="grid-cards">{[0, 1].map((i) => <CardSkeleton key={i} lines={4} />)}</div></Loading> : data.error ? <div className="card"><ErrorState error={data.error} onRetry={() => data.refetch()} /></div> : !data.data?.crews.length ? (
        <div className="card"><EmptyState inline title="No crews yet" /></div>
      ) : (
        <div className="grid-cards" ref={cards}>
          {data.data.crews.map((c) => (
            <div key={c.id} className="card card-pad stack-sm" style={{ borderTop: `4px solid ${c.color ?? "var(--border)"}`, opacity: c.active ? 1 : 0.6 }}>
              <div className="row">
                <input className="input input-sm grow" defaultValue={c.name} maxLength={60} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && void saving.track(update.mutateAsync({ id: c.id, patch: { name: e.target.value.trim() } }))} aria-label="Crew name" style={{ fontWeight: 700 }} />
                <input type="color" value={c.color ?? "#3b7d23"} onChange={(e) => void saving.track(update.mutateAsync({ id: c.id, patch: { color: e.target.value } }))} aria-label={`${c.name} color`} style={{ width: 32, height: 32, border: 0, padding: 0, background: "none" }} />
                <Menu
                  triggerClassName="btn btn-sm btn-ghost btn-icon"
                  items={[
                    { label: c.active ? "Hide from the schedule" : "Show on the schedule", icon: c.active ? "archive" : "undo", onSelect: () => void saving.track(update.mutateAsync({ id: c.id, patch: { active: !c.active } })) },
                    { label: "Delete crew", icon: "trash", danger: true, onSelect: () => deleteCrew(c) },
                  ]}
                />
              </div>
              {!data.data.team.length && <span className="muted small">Invite your team in the Team tab to add them to crews.</span>}
              {data.data.team.map((m) => (
                <label key={m.user_id} className="checkbox" style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={c.crew_members.some((cm) => cm.user_id === m.user_id)} onChange={(e) => void saving.track(toggleMember.mutateAsync({ crewId: c.id, userId: m.user_id, on: e.target.checked }))} />
                  <span>{m.profile?.full_name || "Team member"} <span className="muted">· {roleName(m, roles.data)}</span></span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
