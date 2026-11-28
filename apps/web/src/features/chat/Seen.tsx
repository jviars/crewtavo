/**
 * "Seen by". Under each message in an announcement channel, its author and the channel's managers
 * see "Seen by 12 of 15", which opens who has seen it and who hasn't yet. In a direct conversation,
 * your own latest message says "Seen" once the others have read past it ("Seen by Marcus" in a
 * group). From how far each person has read (routes/chatSeen.ts), kept current by `seen` events.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { chatKeys, type ChatChannel, type ChatMessage, type ChatPerson } from "./data";
import { seenText } from "./direct";
import { Avatar, listTime } from "./ui";
import sn from "./seen.module.css";
import { t } from "@/lib/i18n";

interface SeenAnswer {
  counts: Array<{ message_id: string; seen: number; total: number }>;
  marks: Array<{ user_id: string; last_read_at: string | null }>;
}

/**
 * What goes under each message of a channel about who has read it (`line`, for MessageItem's
 * ctx.seen; null where nothing shows: text channels, threads), and the list it opens (`dialog`).
 */
export function useSeenLines({ channel, messages, me, manager, people }: {
  channel: ChatChannel;
  messages: ChatMessage[];
  me: string;
  /** Owners, admins, office and the channel's managers: they see it for every announcement. */
  manager: boolean;
  /** Who's who in a direct conversation. */
  people: Record<string, ChatPerson>;
}): { line: ((message: ChatMessage) => ReactNode) | null; dialog: ReactNode } {
  const { company } = useSession();
  const [open, setOpen] = useState<ChatMessage | null>(null);
  const announcement = channel.kind === "announcement";
  const direct = channel.kind === "direct";
  const ids = useMemo(
    () => (announcement ? messages.filter((m) => manager || m.author_id === me).map((m) => m.id).slice(-100) : []),
    [announcement, messages, manager, me],
  );
  const seen = useQuery({
    queryKey: [...chatKeys.seen(company.id, channel.id), ids],
    enabled: direct || ids.length > 0,
    staleTime: 60_000,
    meta: { silent: true },
    queryFn: () => api.get<SeenAnswer>(`/chat/channels/${channel.id}/seen?messages=${ids.join(",")}`),
  });
  const counts = useMemo(() => new Map((seen.data?.counts ?? []).map((c) => [c.message_id, c])), [seen.data]);
  const latestMine = direct ? [...messages].reverse().find((m) => m.author_id === me)?.id : undefined;

  const dialog = open ? <SeenDialog message={open} onClose={() => setOpen(null)} /> : null;
  if (!announcement && !direct) return { line: null, dialog: null };
  const line = (message: ChatMessage): ReactNode => {
    if (announcement) {
      const count = counts.get(message.id);
      if (!count || !count.total) return null;
      return (
        <button type="button" className={sn.line} onClick={() => setOpen(message)} aria-haspopup="dialog">
          <Icon name="eye" size={13} />
          {t("Seen by {seen} of {total}", { seen: count.seen, total: count.total })}
        </button>
      );
    }
    if (message.id !== latestMine) return null;
    const marks = seen.data?.marks ?? [];
    const readers = marks.filter((m) => m.last_read_at && m.last_read_at >= message.created_at).map((m) => people[m.user_id] ?? { name: t("Someone") });
    const text = seenText(readers, marks.length);
    return text ? <span className={sn.mark}><Icon name="check" size={12} />{text}</span> : null;
  };
  return { line, dialog };
}

/** Who has seen an announcement, the latest first, and who hasn't yet. */
function SeenDialog({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const { company } = useSession();
  const list = useQuery({
    queryKey: [...chatKeys.seen(company.id, message.channel_id), "list", message.id],
    queryFn: () => api.get<{ seen: Array<{ person: ChatPerson; seen_at: string }>; not_yet: Array<{ person: ChatPerson }> }>(`/chat/messages/${message.id}/seen`),
  });
  return (
    <Dialog open onClose={onClose} title={t("Seen by")} size="sm">
      <div className="dialog-body stack-sm">
        {list.isPending && <span className="muted small">{t("Loading…")}</span>}
        {list.error && <span className="field-error">{(list.error as Error).message}</span>}
        {list.data && (
          <>
            <h3 className={sn.groupTitle}>{t("Seen · {count}", { count: list.data.seen.length })}</h3>
            {list.data.seen.length === 0 && <p className="muted small">{t("Nobody has seen it yet.")}</p>}
            <ul className={sn.people}>
              {list.data.seen.map(({ person, seen_at }) => (
                <li key={person.id} className={sn.person}>
                  <Avatar name={person.name} color={person.avatar_color} photo={person.avatar_url} size={28} />
                  <span className={sn.name}>{person.name}</span>
                  <time className={sn.when} dateTime={seen_at}>{listTime(seen_at)}</time>
                </li>
              ))}
            </ul>
            <h3 className={sn.groupTitle}>{t("Not yet · {count}", { count: list.data.not_yet.length })}</h3>
            <ul className={sn.people}>
              {list.data.not_yet.map(({ person }) => (
                <li key={person.id} className={sn.person} data-not-yet="">
                  <Avatar name={person.name} color={person.avatar_color} photo={person.avatar_url} size={28} />
                  <span className={sn.name}>{person.name}</span>
                  <span className={sn.when}>{person.role_label}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Dialog>
  );
}
