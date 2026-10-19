/**
 * One message: who sent it (with their role's color and badge), the text with @mentions and links,
 * photos, a linked job, the message it replies to, and reactions. Hovering (or tapping, on a phone)
 * shows what you can do with it: react, reply, edit or delete your own, pin if you manage the channel.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { CHAT_REACTIONS, fromEditable, messageParts, toEditable, type Mentionable } from "@crewtavo/core/chat";
import { BrandMark } from "@/components/shell/BrandMark";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { addressLine } from "@/lib/format";
import { useSession } from "@/lib/session";
import { replaceMessage, setReactions, type ChatMessage, type ChatReactionGroup, type JobCard } from "./data";
import { badgeStyle, roleColor, shortTime, timeLabel } from "./ui";
import s from "./chat.module.css";

export const REACTION_ICONS: Record<string, IconName> = { thumbs_up: "thumbsUp", on_it: "onIt", seen: "eye" };

export interface MessageContext {
  me: string;
  myRoleKey: string;
  canManage: boolean;
  canPost: boolean;
  /** Names for <@id> and <@&role> in the text. */
  personName: (id: string) => string;
  role: (key: string) => { label: string; color: string } | null;
  /** Everyone and every role that can be mentioned, to turn names back into tokens after an edit. */
  mentionables: Mentionable[];
  jobs: Map<string, JobCard> | undefined;
  photos: Record<string, string>;
  onReply: (message: ChatMessage) => void;
  onPerson: (id: string) => void;
  onJumpTo: (id: string) => void;
}

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

function Linkified({ text }: { text: string }) {
  const pieces = text.split(URL_RE);
  return (
    <>
      {pieces.map((piece, i) =>
        i % 2 === 1 ? (
          <a key={i} href={piece} target="_blank" rel="noreferrer noopener">{piece}</a>
        ) : (
          <Fragment key={i}>{piece}</Fragment>
        ),
      )}
    </>
  );
}

export function MessageText({ body, ctx }: { body: string; ctx: Pick<MessageContext, "personName" | "role" | "onPerson"> }) {
  return (
    <>
      {messageParts(body).map((part, i) => {
        if (part.kind === "text") return <Linkified key={i} text={part.text} />;
        if (part.kind === "everyone") return <span key={i} className={s.mention} data-role="">@everyone</span>;
        if (part.kind === "role") {
          const role = ctx.role(part.key);
          return <span key={i} className={s.mention} data-role="" style={role ? badgeStyle(role.color) : undefined}>@{role?.label ?? "role"}</span>;
        }
        return <button key={i} type="button" className={s.mention} onClick={() => ctx.onPerson(part.id)}>@{ctx.personName(part.id)}</button>;
      })}
    </>
  );
}

export function MessageItem({ message, head, flash, ctx }: { message: ChatMessage; head: boolean; flash?: boolean; ctx: MessageContext }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const mine = message.author_id === ctx.me;
  const mentioned = message.mention_all || message.mention_users.includes(ctx.me) || message.mention_roles.includes(ctx.myRoleKey);
  const company = session.company.id;
  const author = message.author;

  const react = useMutation({
    meta: { inline: true },
    mutationFn: (v: { kind: string; on: boolean }) => api.post<{ reactions: ChatReactionGroup[] }>(`/chat/messages/${message.id}/reactions`, v),
    onMutate: (v) => {
      const next = CHAT_REACTIONS.map((r) => {
        const users = message.reactions.find((g) => g.kind === r.key)?.users ?? [];
        if (r.key !== v.kind) return { kind: r.key, users };
        return { kind: r.key, users: v.on ? [...new Set([...users, ctx.me])] : users.filter((u) => u !== ctx.me) };
      }).filter((g) => g.users.length);
      setReactions(queryClient, company, message.channel_id, message.id, next);
    },
    onSuccess: (res) => setReactions(queryClient, company, message.channel_id, message.id, res.reactions),
    onError: () => setReactions(queryClient, company, message.channel_id, message.id, message.reactions),
  });
  const edit = useMutation({
    meta: { inline: true },
    mutationFn: (body: string) => api.patch<{ message: ChatMessage }>(`/chat/messages/${message.id}`, { body }),
    onSuccess: (res) => {
      replaceMessage(queryClient, company, res.message);
      setEditing(null);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<{ message: ChatMessage }>(`/chat/messages/${message.id}`),
    onSuccess: (res) => replaceMessage(queryClient, company, res.message),
  });
  const pin = useMutation({
    meta: { success: message.pinned_at ? "Unpinned" : "Pinned to the channel" },
    mutationFn: () => api.post<{ message: ChatMessage }>(`/chat/messages/${message.id}/pin`, { pinned: !message.pinned_at }),
    onSuccess: (res) => replaceMessage(queryClient, company, res.message),
  });

  const nameFor = (p: { kind: "user"; id: string } | { kind: "role"; key: string } | { kind: "everyone" }) =>
    p.kind === "user" ? ctx.personName(p.id) : p.kind === "role" ? ctx.role(p.key)?.label ?? "role" : "everyone";
  const startEdit = () => setEditing(toEditable(message.body, nameFor));
  const saveEdit = () => {
    if (editing === null) return;
    const body = fromEditable(editing.trim(), ctx.mentionables);
    if (!body && !message.attachments.length && !message.job_id) return;
    if (body === message.body) return setEditing(null);
    edit.mutate(body);
  };
  const editKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") setEditing(null);
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      saveEdit();
    }
  };
  const askDelete = async () => {
    if (await confirm({ title: "Delete this message?", body: mine ? "It's removed for everyone." : "It's removed for everyone, and its author isn't told.", confirmLabel: "Delete", danger: true })) remove.mutate();
  };
  // A tap on a phone shows the tools; a tap on a link, button or photo does what it says instead.
  const tap = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button, textarea, input")) return;
    if (window.matchMedia("(hover: none)").matches) setMenu((m) => !m);
  };

  const job = message.job_id ? ctx.jobs?.get(message.job_id) : undefined;
  const nameColor = author ? roleColor(author.color) : undefined;
  const reactionMenu = CHAT_REACTIONS.map((r) => {
    const on = message.reactions.find((g) => g.kind === r.key)?.users.includes(ctx.me) ?? false;
    return { label: on ? `Remove ${r.label}` : r.label, icon: REACTION_ICONS[r.key], onSelect: () => react.mutate({ kind: r.key, on: !on }) };
  });

  return (
    <div
      id={`message-${message.id}`}
      className={s.msg}
      data-head={head || undefined}
      data-mentioned={mentioned || undefined}
      data-flash={flash || undefined}
      data-menu={menu || undefined}
      onClick={tap}
    >
      {head ? (
        author ? (
          <button type="button" className={s.avatar} style={{ background: author.avatar_color || "var(--avatar)" }} onClick={() => ctx.onPerson(author.id)} aria-label={author.name}>
            {initialsOf(author.name)}
          </button>
        ) : (
          <span className={s.avatar} style={{ background: "var(--fill-2)", cursor: "default" }} aria-hidden="true"><BrandMark size={20} /></span>
        )
      ) : (
        <span className={s.stamp} title={new Date(message.created_at).toLocaleString()}>{shortTime(message.created_at)}</span>
      )}

      <div className={s.msgMain}>
        {message.reply && (
          <button type="button" className={s.reply} onClick={() => ctx.onJumpTo(message.reply!.id)}>
            <Icon name="reply" size={13} />
            <strong>{message.reply.author}</strong>
            <span>{message.reply.deleted ? "Deleted message" : toEditable(message.reply.body, nameFor) || "Photo"}</span>
          </button>
        )}
        {head && (
          <div className={s.msgHead}>
            {author ? (
              <button type="button" className={s.name} style={{ color: nameColor }} onClick={() => ctx.onPerson(author.id)}>{author.name}</button>
            ) : (
              <span className={s.name} style={{ cursor: "default" }}>Crewtavo</span>
            )}
            {author ? <span className={s.roleBadge} style={badgeStyle(author.color)}>{author.role_label}</span> : <span className={s.appBadge}>App</span>}
            <time className={s.time} dateTime={message.created_at} title={new Date(message.created_at).toLocaleString()}>{timeLabel(message.created_at)}</time>
            {message.pinned_at && <span className={s.time} title="Pinned"><Icon name="pushpin" size={12} /> Pinned</span>}
          </div>
        )}

        {editing !== null ? (
          <div className={s.editBox}>
            <textarea className="textarea" value={editing} autoFocus onChange={(e) => setEditing(e.target.value)} onKeyDown={editKeys} aria-label="Edit message" maxLength={4000} />
            <div className="row" style={{ marginTop: 6, gap: 6 }}>
              <Button size="sm" variant="primary" loading={edit.isPending} onClick={saveEdit}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <span className={s.editHint}>Enter to save, Esc to cancel</span>
            </div>
            {edit.error && <div className="field-error">{(edit.error as Error).message}</div>}
          </div>
        ) : (
          message.body && (
            <p className={s.body}>
              <MessageText body={message.body} ctx={ctx} />
              {message.edited_at && <span className={s.edited} title={`Edited ${new Date(message.edited_at).toLocaleString()}`}>(edited)</span>}
            </p>
          )
        )}

        {message.attachments.length > 0 && (
          <div className={s.photos}>
            {message.attachments.map((a) =>
              ctx.photos[a.path] ? (
                <a key={a.path} className={s.photo} href={ctx.photos[a.path]} target="_blank" rel="noreferrer">
                  <img src={ctx.photos[a.path]} alt={a.name || "Photo"} loading="lazy" />
                </a>
              ) : (
                <span key={a.path} className={`${s.photo} ${s.photoMissing}`}>Photo</span>
              ),
            )}
          </div>
        )}

        {message.job_id && (
          job ? (
            <Link className={s.jobCard} to={`/jobs/${job.id}`}>
              <span className={s.jobIcon}><Icon name="job" size={17} /></span>
              <span className="grow">
                <strong style={{ display: "block" }}>{job.number ? `Job #${job.number} · ` : ""}{job.title}</strong>
                <span className="muted small">{[job.client?.display_name, job.property ? addressLine(job.property) : null].filter(Boolean).join(" · ")}</span>
              </span>
              <Icon name="chevronRight" size={16} />
            </Link>
          ) : (
            <span className={s.jobCard} style={{ color: "var(--text-3)" }}>
              <span className={s.jobIcon}><Icon name="job" size={17} /></span>
              A job you can't open
            </span>
          )
        )}

        {message.reactions.length > 0 && (
          <div className={s.reactions}>
            {message.reactions.map((g) => {
              const info = CHAT_REACTIONS.find((r) => r.key === g.kind);
              const on = g.users.includes(ctx.me);
              const names = g.users.map((u) => (u === ctx.me ? "You" : ctx.personName(u))).join(", ");
              return (
                <button key={g.kind} type="button" className={s.reaction} aria-pressed={on} title={`${info?.label}: ${names}`} onClick={() => react.mutate({ kind: g.kind, on: !on })}>
                  <Icon name={REACTION_ICONS[g.kind] ?? "thumbsUp"} size={15} />
                  {g.kind === "thumbs_up" ? g.users.length : `${info?.label} · ${g.users.length}`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {editing === null && (
        <div className={s.tools}>
          <Menu label="React" align="end" triggerClassName={`icon-btn ${s.icon}`} trigger={<Icon name="react" size={17} />} items={reactionMenu} />
          {ctx.canPost && (
            <button type="button" className={`icon-btn ${s.icon}`} aria-label="Reply" title="Reply" onClick={() => ctx.onReply(message)}>
              <Icon name="reply" size={17} />
            </button>
          )}
          <Menu
            label="More"
            align="end"
            triggerClassName={`icon-btn ${s.icon}`}
            trigger={<Icon name="more" size={17} />}
            items={[
              { label: "Edit", icon: "edit", onSelect: startEdit, hidden: !mine || !ctx.canPost },
              { label: message.pinned_at ? "Unpin" : "Pin to the channel", icon: message.pinned_at ? "unpin" : "pushpin", onSelect: () => pin.mutate(), hidden: !ctx.canManage },
              { label: "Copy text", icon: "copy", onSelect: () => copyText(toEditable(message.body, nameFor), "Copied"), hidden: !message.body },
              { label: "Delete", icon: "trash", danger: true, onSelect: askDelete, hidden: !(mine || ctx.canManage) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";
