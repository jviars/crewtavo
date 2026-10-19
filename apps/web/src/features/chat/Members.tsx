/**
 * Who's in a channel: roles that show separately get their own group ("Crew lead — 2"), everyone
 * else online is under Online, and the rest under Offline. Opening someone shows their role, crews
 * and phone, with a button to @mention them.
 */
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { supabase } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useLive, type ChatMember } from "./data";
import { Avatar, roleColor } from "./ui";
import s from "./chat.module.css";

const LEVEL_ORDER = ["owner", "admin", "office", "estimator", "crew_lead", "field_crew"];

export function groupMembers(members: ChatMember[], online: Set<string>) {
  const isOn = (m: ChatMember) => m.online || online.has(m.id);
  const groups = new Map<string, { title: string; order: number; people: ChatMember[] }>();
  for (const m of members) {
    const on = isOn(m);
    const key = !on ? "offline" : m.show_separately ? `role:${m.role_key}` : "online";
    const order = !on ? 1000 : m.show_separately ? (LEVEL_ORDER.indexOf(m.role_key) >= 0 ? LEVEL_ORDER.indexOf(m.role_key) : 50) : 900;
    const title = !on ? "Offline" : m.show_separately ? m.role_label : "Online";
    const group = groups.get(key) ?? { title, order, people: [] };
    group.people.push(m);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function MembersPanel({ members, onPerson, onClose }: { members: ChatMember[] | undefined; onPerson: (id: string) => void; onClose: () => void }) {
  const live = useLive();
  return (
    <aside className={s.members} aria-label="Members">
      <div className="row" style={{ justifyContent: "space-between", padding: "10px 8px 0" }}>
        <strong style={{ fontSize: 13 }}>{members ? `${members.length} ${members.length === 1 ? "member" : "members"}` : "Members"}</strong>
        <button type="button" className="icon-btn" aria-label="Close the member list" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      {!members && <p className="muted small" style={{ padding: "8px" }}>Loading…</p>}
      {members &&
        groupMembers(members, live.online).map((g) => (
          <div key={g.title}>
            <h2 className={s.groupTitle}>{g.title} — {g.people.length}</h2>
            {g.people.map((m) => {
              const on = m.online || live.online.has(m.id);
              return (
                <button key={m.id} type="button" className={s.member} onClick={() => onPerson(m.id)}>
                  <span className={s.memberAvatar} data-offline={!on || undefined} style={{ background: m.avatar_color || "var(--avatar)" }} aria-hidden="true">
                    {m.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}
                    {on && <span className={s.presence} />}
                  </span>
                  <span className="grow">
                    <span className={s.memberName} style={{ color: on ? roleColor(m.color) : "var(--text-3)" }}>{m.name}</span>
                    <span className={s.memberRole}>{on ? m.role_label : `${m.role_label} · offline`}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
    </aside>
  );
}

export function PersonDialog({ person, onClose, onMention }: { person: ChatMember | null; onClose: () => void; onMention: ((person: ChatMember) => void) | null }) {
  const { company, userId } = useSession();
  const live = useLive();
  const details = useQuery({
    queryKey: ["chat-person", company.id, person?.id],
    enabled: Boolean(person),
    queryFn: async () => {
      const id = person!.id;
      const [profile, led, on] = await Promise.all([
        supabase().from("profiles").select("phone").eq("user_id", id).maybeSingle(),
        supabase().from("crews").select("id, name").eq("company_id", company.id).eq("lead_user_id", id).eq("active", true),
        supabase().from("crew_members").select("crew:crews(id, name, active)").eq("company_id", company.id).eq("user_id", id),
      ]);
      const crews = new Map<string, string>();
      for (const c of led.data ?? []) crews.set(c.id, `${c.name} (lead)`);
      for (const row of (on.data ?? []) as unknown as Array<{ crew: { id: string; name: string; active: boolean } | null }>) {
        if (row.crew?.active && !crews.has(row.crew.id)) crews.set(row.crew.id, row.crew.name);
      }
      return { phone: profile.data?.phone ?? null, crews: [...crews.values()] };
    },
  });
  if (!person) return null;
  const on = person.online || live.online.has(person.id);
  return (
    <Dialog open onClose={onClose} title={person.name} size="sm">
      <div className="dialog-body">
        <div className={s.profile}>
          <div className={s.profileHead}>
            <Avatar name={person.name} color={person.avatar_color} size={64} className={s.profileAvatar} />
            <div className="stack-sm" style={{ gap: 4 }}>
              <span className={s.roleChip}><span className={s.roleDot} style={{ background: roleColor(person.color) }} />{person.role_label}</span>
              <span className="muted small">{person.id === userId ? "You" : on ? "Online now" : "Offline"}</span>
            </div>
          </div>
          {details.data && details.data.crews.length > 0 && (
            <div className="stack-sm" style={{ gap: 4 }}>
              <strong className="small" style={{ textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-3)" }}>Crews</strong>
              <span>{details.data.crews.join(", ")}</span>
            </div>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            {onMention && person.id !== userId && (
              <Button variant="primary" icon="mention" onClick={() => { onMention(person); onClose(); }}>Mention</Button>
            )}
            {details.data?.phone && (
              <a className="btn" href={`tel:${details.data.phone}`}><Icon name="phone" size={16} />Call</a>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
