/**
 * Who's in a channel: roles that show separately get their own group ("Crew lead · 2"), everyone
 * else online is under Online, and the rest under Offline. Opening someone shows their role, crews
 * and phone, with buttons to message them directly (DirectMessages.tsx) and to @mention them.
 */
import { STAFF } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { Face } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Fact, Facts } from "@/components/ui/Section";
import { supabase } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useLive, type ChatMember } from "./data";
import { StatusChip, StatusOnCard, useStatuses } from "./Status";
import { Avatar, roleColor } from "./ui";
import s from "./chat.module.css";
import d from "./direct.module.css";
import { t } from "@/lib/i18n";

// The team's levels, top down (a sub is never in chat).
const LEVEL_ORDER: readonly string[] = STAFF;

export function groupMembers(members: ChatMember[], online: Set<string>) {
  const isOn = (m: ChatMember) => m.online || online.has(m.id);
  const groups = new Map<string, { title: string; order: number; people: ChatMember[] }>();
  for (const m of members) {
    const on = isOn(m);
    const key = !on ? "offline" : m.show_separately ? `role:${m.role_key}` : "online";
    const order = !on ? 1000 : m.show_separately ? (LEVEL_ORDER.indexOf(m.role_key) >= 0 ? LEVEL_ORDER.indexOf(m.role_key) : 50) : 900;
    const title = !on ? t("Offline", { context: "member" }) : m.show_separately ? m.role_label : t("Online", { context: "member" });
    const group = groups.get(key) ?? { title, order, people: [] };
    group.people.push(m);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function MembersPanel({ members, onPerson, onClose, onMessage }: {
  members: ChatMember[] | undefined; onPerson: (id: string) => void; onClose: () => void;
  /** Message someone directly, while direct messages are on (never yourself). */
  onMessage?: ((person: ChatMember) => void) | null;
}) {
  const live = useLive();
  const { userId } = useSession();
  const statuses = useStatuses();
  return (
    <aside className={s.members} aria-label={t("Members")}>
      <div className={s.membersHead}>
        <span>{members ? t.plural(members.length, { one: "{count} member", other: "{count} members" }) : t("Members")}</span>
        <button type="button" className={`icon-btn ${s.membersClose}`} aria-label={t("Close the member list")} onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      {!members && <p className="muted small" style={{ margin: "8px 0" }}>{t("Loading…")}</p>}
      {members &&
        groupMembers(members, live.online).map((g) => (
          <div key={g.title}>
            <h2 className={s.groupTitle}>{g.title} · {g.people.length}</h2>
            {g.people.map((m) => {
              const on = m.online || live.online.has(m.id);
              const row = (
                <button key={m.id} type="button" className={s.member} data-offline={!on || undefined} onClick={() => onPerson(m.id)} aria-label={on ? `${m.name}, ${m.role_label}` : `${m.name}, ${t("{role} · offline", { role: m.role_label })}`}>
                  <span className={s.memberAvatar} style={{ background: m.avatar_color || "var(--avatar)" }} aria-hidden="true">
                    <Face name={m.name} photo={m.avatar_url} />
                    {on && <span className={s.presence} />}
                  </span>
                  <span className={s.memberName}>{m.name}</span>
                  {/* A status takes the role's place: the row has room for one, and the group and the card say the role. */}
                  {statuses.get(m.id) ? <StatusChip status={statuses.get(m.id)} className={s.memberRole} /> : <span className={s.memberRole}>{m.role_label}</span>}
                </button>
              );
              if (!onMessage || m.id === userId) return row;
              return (
                <div key={m.id} className={d.memberRow}>
                  {row}
                  <button type="button" className={`icon-btn ${d.memberMessage}`} aria-label={t("Message {name}", { name: m.name })} title={t("Message {name}", { name: m.name })} onClick={() => onMessage(m)}>
                    <Icon name="messages" size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
    </aside>
  );
}

export function PersonDialog({ person, onClose, onMention, onMessage }: {
  person: ChatMember | null; onClose: () => void; onMention: ((person: ChatMember) => void) | null;
  /** Message them directly, while direct messages are on. */
  onMessage?: ((person: ChatMember) => void) | null;
}) {
  const { company, userId } = useSession();
  const live = useLive();
  const statuses = useStatuses();
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
            <Avatar name={person.name} color={person.avatar_color} photo={person.avatar_url} size={56} className={s.profileAvatar} />
            <div className="stack-sm" style={{ gap: 2 }}>
              <span className={s.roleLine}><span className={s.roleDot} style={{ background: roleColor(person.color) }} />{person.role_label}</span>
              <span className="muted small">{person.id === userId ? t("You") : on ? t("Online now") : t("Offline")}</span>
            </div>
          </div>
          <StatusOnCard personId={person.id} status={statuses.get(person.id)} />
          {details.data && details.data.crews.length > 0 && (
            <Facts>
              <Fact label={t("Crews")}>{details.data.crews.join(", ")}</Fact>
            </Facts>
          )}
          <div className="row wrap" style={{ gap: 8 }}>
            {onMessage && person.id !== userId && (
              <Button variant="primary" icon="messages" onClick={() => { onMessage(person); onClose(); }}>{t("Message", { context: "verb" })}</Button>
            )}
            {onMention && person.id !== userId && (
              <Button variant={onMessage ? undefined : "primary"} icon="mention" onClick={() => { onMention(person); onClose(); }}>{t("Mention")}</Button>
            )}
            {details.data?.phone && (
              <a className="btn" href={`tel:${details.data.phone}`}><Icon name="phone" size={16} />{t("Call")}</a>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
