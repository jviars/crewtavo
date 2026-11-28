/**
 * Direct messages: private conversations with one person or a small group (up to 8 besides you).
 * "New message" (the pencil in the channel list's head) picks people; "Message" on someone's card or
 * in the member list goes straight to your conversation with them. Messaging the same people again
 * opens the same conversation. The list's "Direct messages" section shows each by its people's
 * faces and names, the latest first; Close takes one out until a new message comes, and a group can
 * be left. Only its people ever see a conversation (routes/chatDirect.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type KeyboardEvent } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { matchMentions } from "@crewtavo/core/chat";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { chatKeys, markRead, type ChatChannel, type ChatPerson, type ChatState } from "./data";
import { directPeople } from "./direct";
import { Avatar, listTime } from "./ui";
import s from "./chat.module.css";
import d from "./direct.module.css";
import n from "./notify.module.css";
import { t } from "@/lib/i18n";

const phone = () => window.matchMedia("(max-width: 900px)").matches;

/** People besides you in one conversation. */
export const MAX_PEOPLE = 8;

/** Start (or open) the conversation with these people, and go to it. */
export function useStartDirect() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (people: string[]) => api.post<{ id: string }>("/chat/direct", { people }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: chatKeys.state(company.id) });
      navigate(`/chat/${id}`);
    },
  });
}

/** Everyone on the team I can message. */
function useDirectPeople(enabled: boolean) {
  const { company } = useSession();
  return useQuery({
    queryKey: [...chatKeys.all(company.id), "direct-people"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => api.get<{ people: ChatPerson[] }>("/chat/direct/people").then((r) => r.people),
  });
}

/** One face, or two overlapping for a group. */
export function DirectFaces({ people, size = 20 }: { people: ChatPerson[]; size?: number }) {
  const [first, second] = people;
  if (!first) return <span className={d.faces} style={{ width: size, height: size }} aria-hidden="true"><Icon name="user" size={Math.round(size * 0.6)} /></span>;
  if (!second) return <Avatar name={first.name} color={first.avatar_color} photo={first.avatar_url} size={size} className={d.face} />;
  const small = Math.round(size * 0.72);
  return (
    <span className={d.faces} style={{ width: size, height: size }} aria-hidden="true">
      <Avatar name={first.name} color={first.avatar_color} photo={first.avatar_url} size={small} className={`${d.face} ${d.back}`} />
      <Avatar name={second.name} color={second.avatar_color} photo={second.avatar_url} size={small} className={`${d.face} ${d.front}`} />
    </span>
  );
}

/** The pencil in the channel list's head. */
export function NewMessageButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={s.settings} aria-label={t("New message")} title={t("New message")} onClick={() => setOpen(true)}>
        <Icon name="compose" size={16} />
      </button>
      <NewMessageDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Pick people (search, then chips), then message them. */
export function NewMessageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const people = useDirectPeople(open);
  const start = useStartDirect();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ChatPerson[]>([]);
  const full = picked.length >= MAX_PEOPLE;
  const options = useMemo(() => {
    const left = (people.data ?? []).filter((p) => !picked.some((x) => x.id === p.id)).map((p) => ({ ...p, label: p.name, token: p.id }));
    return query.trim() ? matchMentions(left, query, 50) : left;
  }, [people.data, picked, query]);

  const reset = () => {
    setQuery("");
    setPicked([]);
    start.reset();
  };
  const pick = (person: ChatPerson) => {
    if (full) return;
    setPicked((list) => [...list, person]);
    setQuery("");
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && query.trim() && options[0]) {
      e.preventDefault();
      pick(options[0]);
    } else if (e.key === "Backspace" && !query && picked.length) {
      setPicked((list) => list.slice(0, -1));
    }
  };
  const go = () => {
    if (!picked.length) return;
    start.mutate(picked.map((p) => p.id), { onSuccess: () => onClose() });
  };

  return (
    <Dialog open={open} onClose={onClose} onExited={reset} title={t("New message")} description={t("Message one person, or up to {count} together.", { count: MAX_PEOPLE })} size="sm">
      <form className={`dialog-body stack-sm ${d.picker}`} onSubmit={(e) => { e.preventDefault(); go(); }}>
        <div className={d.to}>
          <span className={d.toLabel} aria-hidden="true">{t("To:")}</span>
          {picked.map((p) => (
            <span key={p.id} className={d.chip}>
              <Avatar name={p.name} color={p.avatar_color} photo={p.avatar_url} size={20} className={d.face} />
              <span>{p.name}</span>
              <button type="button" className="icon-btn" aria-label={t("Remove {name}", { name: p.name })} onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}><Icon name="x" size={12} /></button>
            </span>
          ))}
          <input
            className={d.toInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={keys}
            placeholder={picked.length ? (full ? t("That's everyone a conversation can have") : t("Add someone else")) : t("Search people")}
            aria-label={t("Search people")}
            disabled={full}
            autoFocus
          />
        </div>
        {people.isPending && <span className="muted small">{t("Loading people…")}</span>}
        {people.error && <span className="field-error">{(people.error as Error).message}</span>}
        {people.data && !options.length && !full && <span className="muted small">{query.trim() ? t("Nobody on the team matches “{query}”.", { query: query.trim() }) : t("Nobody else to add.")}</span>}
        {!full && options.length > 0 && (
          <ul className={d.people} aria-label={t("People")}>
            {options.map((p) => (
              <li key={p.id}>
                <button type="button" className={d.person} onClick={() => pick(p)}>
                  <Avatar name={p.name} color={p.avatar_color} photo={p.avatar_url} size={32} className={d.face} />
                  <span className={d.personName}>{p.name}</span>
                  <span className={d.personRole}>{p.role_label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {start.error && <span className="field-error">{(start.error as Error).message}</span>}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" icon="send" disabled={!picked.length} loading={start.isPending}>{t("Message", { context: "verb" })}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The list's "Direct messages" section: each conversation by its people, the latest first. */
export function DirectSection({ channels, state, current, open, onToggle }: { channels: ChatChannel[]; state: ChatState; current: string | undefined; open: boolean; onToggle: () => void }) {
  const close = useCloseDirect();
  // A phone's rows are taller, with a face the size of a channel's icon.
  const face = phone() ? 40 : 20;
  return (
    <div>
      <div className={d.sectionHead}>
        <button type="button" className={s.category} aria-expanded={open} onClick={onToggle}>
          <span>{t("Direct messages")}</span>
          <Icon name="chevronDown" size={12} bold />
        </button>
      </div>
      {channels.length === 0 && open && <p className={d.empty}>{t("Message someone with the pencil above.")}</p>}
      {channels.filter((c) => open || c.id === current || c.mentions > 0).map((c) => {
        const people = directPeople(c, state.people);
        const muted = c.notify === "nothing";
        const unread = c.unread > 0 && c.id !== current && !muted;
        const sub = people.length === 1 ? people[0].role_label : t.plural(people.length + 1, { one: "{count} person", other: "{count} people" });
        return (
          <div key={c.id} className={d.row}>
            <NavLink
              to={`/chat/${c.id}`}
              className={muted ? `${s.channel} ${n.muted}` : s.channel}
              data-unread={unread || undefined}
              aria-label={`${c.name}${c.mentions && c.id !== current ? `, ${t.plural(c.mentions, { one: "{count} new message", other: "{count} new messages" })}` : ""}`}
            >
              <span className={`${s.hash} ${d.lead}`} aria-hidden="true"><DirectFaces people={people} size={face} /></span>
              <span className={s.channelText}>
                <span className={s.channelName}>{c.name}</span>
                <span className={s.channelSub}>{sub}</span>
              </span>
              <span className={s.channelEnd}>
                {c.last_message_at && <time className={s.channelTime} dateTime={c.last_message_at}>{listTime(c.last_message_at)}</time>}
                {muted && <span className={n.mutedIcon}><Icon name="bellOff" size={13} label={t("Notifications off")} /></span>}
                {c.mentions > 0 && c.id !== current && <span className={s.mentions} aria-hidden="true">{c.mentions}</span>}
                {unread && <span className={s.dot} aria-hidden="true" />}
              </span>
            </NavLink>
            <button type="button" className={`icon-btn ${d.close}`} aria-label={t("Close the conversation with {name}", { name: c.name })} title={t("Close")} onClick={() => close.mutate(c)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Close a conversation: read up to now, and out of the list until a new message comes. */
function useCloseDirect() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: async (channel: ChatChannel) => {
      await markRead(queryClient, company.id, channel.id);
      return api.post(`/chat/direct/${channel.id}/close`);
    },
    onSuccess: (_r, channel) => {
      queryClient.setQueryData<ChatState>(chatKeys.state(company.id), (state) =>
        state ? { ...state, channels: state.channels.map((c) => (c.id === channel.id ? { ...c, closed: true } : c)) } : state,
      );
      if (window.location.pathname.startsWith(`/chat/${channel.id}`)) navigate("/chat");
    },
  });
}

/** A conversation's own menu in its head: Close, and Leave for a group. */
export function DirectMenu({ channel }: { channel: ChatChannel }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const close = useCloseDirect();
  const group = (channel.people?.length ?? 0) > 1;
  const leave = useMutation({
    meta: { success: t("You left the conversation") },
    mutationFn: () => api.post(`/chat/direct/${channel.id}/leave`),
    onSuccess: async () => {
      navigate("/chat");
      await queryClient.invalidateQueries({ queryKey: chatKeys.state(company.id) });
    },
  });
  const askLeave = async () => {
    const ok = await confirm({
      title: t("Leave this conversation?"),
      body: t("You won't see its messages any more, and the others carry on without you. Messaging them all again starts a new conversation."),
      confirmLabel: t("Leave"),
      danger: true,
    });
    if (ok) leave.mutate();
  };
  return (
    <Menu
      label={t("Conversation options")}
      title={channel.name}
      align="end"
      triggerClassName="btn btn-sm btn-ghost btn-icon"
      trigger={<Icon name="more" size={15} />}
      items={[
        { label: t("Close"), icon: "x", description: t("Out of your list until a new message comes"), onSelect: () => close.mutate(channel) },
        { separator: true, hidden: !group },
        { label: t("Leave conversation"), icon: "logout", danger: true, onSelect: () => void askLeave(), hidden: !group },
      ]}
    />
  );
}
