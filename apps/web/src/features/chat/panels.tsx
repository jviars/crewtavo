/**
 * What Search and Saved share (SearchPanel.tsx, SavedPanel.tsx): the head of a screen that takes
 * the conversation's place (on a phone, a screen of its own with a back button), the team's people
 * for names, and one message as a row: where it was said, who said it and when, then its words, with
 * a search's matches marked. Tapping a row opens the message in its channel (?message=).
 */
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { chatPlainText, type MessagePart } from "@crewtavo/core/chat";
import { chatDocumentType, chatFileKind, markMatches, searchSnippet } from "@crewtavo/core/chatContent";
import { Icon, type IconName } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useSession } from "@/lib/session";
import { DOCUMENT_ICONS } from "./ChatFiles";
import type { ChatMessage, ChatPerson, ChatState } from "./data";
import { ChannelIcon, channelLabel, dayLabel, roleColor, timeLabel } from "./ui";
import s from "./chat.module.css";
import p from "./panels.module.css";

/** Where a panel goes back to: the channel it was opened from, or the channel list. */
export function usePanelExit() {
  const navigate = useNavigate();
  const { channelId } = useParams();
  return () => navigate(channelId ? `/chat/${channelId}` : "/chat");
}

/** A panel's head: back on a phone, its title, and close on a computer. */
export function PanelHead({ title, icon, onClose, children }: { title: string; icon: IconName; onClose: () => void; children?: ReactNode }) {
  return (
    <header className={s.convHead}>
      <button type="button" className={s.back} aria-label={t("Back")} onClick={onClose}><Icon name="chevronLeft" size={20} /></button>
      <h1 className={p.headTitle}><Icon name={icon} size={15} /><span>{title}</span></h1>
      {children}
      <button type="button" className={`${p.close} hide-mobile`} aria-label={t("Close")} title={t("Close")} onClick={onClose}><Icon name="x" size={16} /></button>
    </header>
  );
}

/** Everyone on the team who can write in chat, by name (GET /api/chat/people). */
export function useChatPeople() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["chat", company.id, "people"],
    queryFn: () => api.get<{ people: ChatPerson[] }>("/chat/people").then((r) => r.people),
    staleTime: 5 * 60_000,
    meta: { silent: true },
  });
}

/** Names for a message's mentions: people from the team list (or the message's author), roles from chat's roles. */
export function useNames(state: ChatState | undefined, people: ChatPerson[] | undefined) {
  return useMemo(() => {
    const byId = new Map((people ?? []).map((x) => [x.id, x.name]));
    return (part: Exclude<MessagePart, { kind: "text" }>) =>
      part.kind === "user" ? byId.get(part.id) ?? t("someone") : part.kind === "role" ? state?.roles.find((r) => r.key === part.key)?.label ?? t("role") : t("everyone");
  }, [state, people]);
}

/** Text with a search's matches in <mark>. */
export function Marked({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return <>{markMatches(text, query).map((piece, i) => (piece.hit ? <mark key={i}>{piece.text}</mark> : <Fragment key={i}>{piece.text}</Fragment>))}</>;
}

/** One message as a row of a list (search results, saved messages). */
export function MessageRow({
  message,
  state,
  names,
  query = "",
  onOpen,
  tool,
}: {
  message: ChatMessage;
  state: ChatState | undefined;
  names: ReturnType<typeof useNames>;
  query?: string;
  onOpen: () => void;
  /** A button beside the row (Remove from saved). */
  tool?: ReactNode;
}) {
  const channel = state?.channels.find((c) => c.id === message.channel_id);
  const plain = chatPlainText(message.body, names);
  const files = message.attachments.map((a) => {
    const kind = chatFileKind(a);
    const words = (a as { words?: unknown }).words;
    return { ...a, kind, words: typeof words === "string" ? words : "" };
  });
  const author = message.author;
  return (
    <li className={p.row}>
      <button type="button" className={p.result} onClick={onOpen}>
        <span className={p.meta}>
          <span className={p.where}>{channel ? <ChannelIcon channel={channel} size={12} /> : <Icon name="hash" size={12} />}<span>{channel ? channelLabel(channel) : t("A channel")}</span></span>
          <span className={p.who} style={author ? { color: roleColor(author.color) } : undefined}>{author?.name ?? "Crewtavo"}</span>
          <time dateTime={message.created_at}>{dayLabel(message.created_at)}, {timeLabel(message.created_at)}</time>
        </span>
        {plain ? (
          <span className={p.text}><Marked text={searchSnippet(plain, query)} query={query} /></span>
        ) : !files.length ? (
          <span className={`${p.text} ${p.quiet}`}>{message.job_id ? t("Linked a job") : t("No words")}</span>
        ) : null}
        {files.length > 0 && (
          <span className={p.files}>
            {files.map((f) => (
              <span key={f.path}>
                <Icon name={f.kind === "photo" ? "image" : f.kind === "audio" ? "voicemail" : DOCUMENT_ICONS[chatDocumentType(f)]} size={12} />
                <span>
                  <Marked text={f.kind === "audio" ? t("Voice note") : f.name || (f.kind === "photo" ? t("Photo") : t("File"))} query={query} />
                  {f.words && query.trim() && markMatches(f.words, query).some((m) => m.hit) && <>: “<Marked text={searchSnippet(f.words, query, 120)} query={query} />”</>}
                </span>
              </span>
            ))}
          </span>
        )}
      </button>
      {tool}
    </li>
  );
}
