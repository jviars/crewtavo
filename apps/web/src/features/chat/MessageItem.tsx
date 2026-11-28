/**
 * One message: who sent it (in their role's color, the role in quiet words), the text with @mentions, links and
 * its Markdown formatting (bold, italics, lists, quotes, code: core chatBlocks; nothing in it is read as HTML),
 * photos, a linked job, the message it replies to, and reactions. Hovering (or tapping, on a phone)
 * shows what you can do with it: react, reply, edit or delete your own, pin if you manage the channel.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CHAT_REACTIONS, chatBlocks, chatPlainText, fromEditable, toEditable, type ChatBlock, type ChatInline, type Mentionable } from "@crewtavo/core/chat";
import { isAudio } from "@crewtavo/core/chatField";
import { BrandMark } from "@/components/shell/BrandMark";
import { Face } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { addressLine } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { replaceMessage, setReactions, type ChatMessage, type ChatReactionGroup, type JobCard } from "./data";
import { badgeStyle, roleColor, shortTime, timeLabel } from "./ui";
import { VoiceNote } from "./VoiceNote";
import { AddToJob } from "./AddToJob";
import { useRemindMe } from "./Reminders";
import s from "./chat.module.css";
import { browserOrSpanish, t } from "@/lib/i18n";

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

type TextContext = Pick<MessageContext, "personName" | "role" | "onPerson">;

function Inline({ nodes, ctx }: { nodes: ChatInline[]; ctx: TextContext }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.kind) {
          case "text":
            return <Fragment key={i}>{n.text}</Fragment>;
          case "everyone":
            return <span key={i} className={s.mention} data-role="">{t("@everyone")}</span>;
          case "role": {
            const role = ctx.role(n.key);
            return <span key={i} className={s.mention} data-role="" style={role ? badgeStyle(role.color) : undefined}>@{role?.label ?? t("role")}</span>;
          }
          case "user":
            return <button key={i} type="button" className={s.mention} onClick={() => ctx.onPerson(n.id)}>@{ctx.personName(n.id)}</button>;
          case "bold":
            return <strong key={i}><Inline nodes={n.children} ctx={ctx} /></strong>;
          case "italic":
            return <em key={i}><Inline nodes={n.children} ctx={ctx} /></em>;
          case "strike":
            return <s key={i}><Inline nodes={n.children} ctx={ctx} /></s>;
          case "code":
            return <code key={i} className={s.code}>{n.text}</code>;
          case "link":
            return <a key={i} href={n.href} target="_blank" rel="noreferrer noopener"><Inline nodes={n.children} ctx={ctx} /></a>;
        }
      })}
    </>
  );
}

function Lines({ lines, ctx }: { lines: ChatInline[][]; ctx: TextContext }) {
  return <>{lines.map((line, i) => <Fragment key={i}>{i > 0 && <br />}<Inline nodes={line} ctx={ctx} /></Fragment>)}</>;
}

function Block({ block, ctx, after }: { block: ChatBlock; ctx: TextContext; after?: ReactNode }) {
  switch (block.kind) {
    case "paragraph":
      return <p className={s.para}><Lines lines={block.lines} ctx={ctx} />{after}</p>;
    case "heading":
      return <p className={s.heading}><Inline nodes={block.children} ctx={ctx} />{after}</p>;
    case "quote":
      return <blockquote className={s.quote}><Blocks blocks={block.blocks} ctx={ctx} after={after} /></blockquote>;
    case "code":
      return <><pre className={s.pre}><code>{block.text}</code></pre>{after}</>;
    case "list": {
      const items = block.items.map((item, i) => <li key={i}><Inline nodes={item} ctx={ctx} />{i === block.items.length - 1 && after}</li>);
      return block.ordered ? <ol className={s.list} start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul className={s.list}>{items}</ul>;
    }
  }
}

function Blocks({ blocks, ctx, after }: { blocks: ChatBlock[]; ctx: TextContext; after?: ReactNode }) {
  return <>{blocks.map((b, i) => <Block key={i} block={b} ctx={ctx} after={i === blocks.length - 1 ? after : undefined} />)}</>;
}

/** A message's text as it's shown. `after`: what follows its last words on their line ("(edited)"). */
export function MessageText({ body, ctx, after }: { body: string; ctx: TextContext; after?: ReactNode }) {
  const blocks = useMemo(() => chatBlocks(body), [body]);
  return <Blocks blocks={blocks} ctx={ctx} after={after} />;
}

export function MessageItem({ message, head, flash, ctx }: { message: ChatMessage; head: boolean; flash?: boolean; ctx: MessageContext }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [toJob, setToJob] = useState(false);
  const remind = useRemindMe(message);
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
    meta: { success: message.pinned_at ? t("Message unpinned") : t("Message pinned") },
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
    if (await confirm({ title: t("Delete this message?"), body: mine ? t("It's removed for everyone.") : t("It's removed for everyone, and its author isn't told."), confirmLabel: t("Delete"), danger: true })) remove.mutate();
  };
  // A tap on a phone shows the tools; a tap on a link, button or photo does what it says instead.
  const tap = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a, button, textarea, input")) return;
    if (window.matchMedia("(hover: none)").matches) setMenu((m) => !m);
  };

  const job = message.job_id ? ctx.jobs?.get(message.job_id) : undefined;
  const nameColor = author ? roleColor(author.color) : undefined;
  // Each reaction a check box: yours are ticked, and the menu stays open to pick another.
  const reactionMenu = CHAT_REACTIONS.map((r) => {
    const on = message.reactions.find((g) => g.kind === r.key)?.users.includes(ctx.me) ?? false;
    return { label: t(r.label), icon: REACTION_ICONS[r.key], checkbox: true, checked: on, onSelect: () => react.mutate({ kind: r.key, on: !on }) };
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
            <Face name={author.name} photo={author.avatar_url} />
          </button>
        ) : (
          <span className={s.avatar} style={{ background: "var(--fill-2)", cursor: "default" }} aria-hidden="true"><BrandMark size={20} /></span>
        )
      ) : (
        <span className={s.stamp} title={new Date(message.created_at).toLocaleString(browserOrSpanish())}>{shortTime(message.created_at)}</span>
      )}

      <div className={s.msgMain}>
        {message.reply && (
          <button type="button" className={s.reply} onClick={() => ctx.onJumpTo(message.reply!.id)}>
            <Icon name="reply" size={14} />
            <strong>{message.reply.author}</strong>
            <span>{message.reply.deleted ? t("Deleted message") : chatPlainText(message.reply.body, nameFor) || t("Photo")}</span>
          </button>
        )}
        {head && (
          <div className={s.msgHead}>
            {author ? (
              <button type="button" className={s.name} style={{ color: nameColor }} onClick={() => ctx.onPerson(author.id)}>{author.name}</button>
            ) : (
              <span className={s.name} style={{ cursor: "default" }}>Crewtavo</span>
            )}
            <span className={s.role}>{author ? author.role_label : t("App")}</span>
            <time className={s.time} dateTime={message.created_at} title={new Date(message.created_at).toLocaleString(browserOrSpanish())}>{timeLabel(message.created_at)}</time>
            {message.pinned_at && <span className={s.time} title={t("Pinned")}><Icon name="pushpin" size={11} />{t("Pinned")}</span>}
          </div>
        )}

        {editing !== null ? (
          <div className={s.editBox}>
            <textarea className="textarea" value={editing} autoFocus onChange={(e) => setEditing(e.target.value)} onKeyDown={editKeys} aria-label={t("Edit message")} maxLength={4000} />
            <div className="row" style={{ marginTop: 6, gap: 6, alignItems: "center" }}>
              <Button size="sm" variant="primary" loading={edit.isPending} onClick={saveEdit}>{t("Save")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>{t("Cancel")}</Button>
              <span className={s.editHint}>{t("Enter to save, Esc to cancel")}</span>
            </div>
            {edit.error && <div className="field-error">{(edit.error as Error).message}</div>}
          </div>
        ) : (
          message.body && (
            <div className={s.body}>
              <MessageText
                body={message.body}
                ctx={ctx}
                after={message.edited_at && <span className={s.edited} title={t("Edited {when}", { when: new Date(message.edited_at).toLocaleString(browserOrSpanish()) })}>{t("(edited)")}</span>}
              />
            </div>
          )
        )}

        {/* Voice notes: VoiceNote (Field builder) */}
        {message.attachments.filter(isAudio).map((a) => <VoiceNote key={a.path} attachment={a} url={ctx.photos[a.path]} />)}
        {message.attachments.some((a) => !isAudio(a)) && (
          <div className={s.photos}>
            {message.attachments.filter((a) => !isAudio(a)).map((a) =>
              ctx.photos[a.path] ? (
                <a key={a.path} className={s.photo} href={ctx.photos[a.path]} target="_blank" rel="noreferrer">
                  <img src={ctx.photos[a.path]} alt={a.name || t("Photo")} loading="lazy" />
                </a>
              ) : (
                <span key={a.path} className={`${s.photo} ${s.photoMissing}`}>{t("Photo")}</span>
              ),
            )}
          </div>
        )}

        {message.job_id && (
          job ? (
            <Link className={s.jobCard} to={`/jobs/${job.id}`}>
              <strong>{job.number ? `${t("Job #{number}", { number: job.number })} · ` : ""}{job.title}</strong>
              {[job.client?.display_name, job.property ? addressLine(job.property) : null].filter(Boolean).join(" · ")}
            </Link>
          ) : (
            <span className={s.jobCard}>{t("A job you can't open")}</span>
          )
        )}

        {message.reactions.length > 0 && (
          <div className={s.reactions}>
            {message.reactions.map((g) => {
              const info = CHAT_REACTIONS.find((r) => r.key === g.kind);
              const on = g.users.includes(ctx.me);
              const names = g.users.map((u) => (u === ctx.me ? t("You") : ctx.personName(u))).join(", ");
              const label = info ? t(info.label) : g.kind;
              return (
                <button key={g.kind} type="button" className={s.reaction} aria-pressed={on} aria-label={`${label}, ${g.users.length}`} title={`${label}: ${names}`} onClick={() => react.mutate({ kind: g.kind, on: !on })}>
                  {g.kind === "thumbs_up" || !info ? <><Icon name={REACTION_ICONS[g.kind] ?? "thumbsUp"} size={13} />{g.users.length}</> : `${label} · ${g.users.length}`}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Dialogs opened from the menu: a tap inside one isn't a tap on the message. */}
      <div style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
        {toJob && <AddToJob message={message} onClose={() => setToJob(false)} />}
        {remind.dialog}
      </div>
      {editing === null && (
        <div className={s.tools}>
          <Menu label={t("React")} title={t("React")} align="end" triggerClassName={`icon-btn ${s.icon}`} trigger={<Icon name="react" size={16} />} items={reactionMenu} />
          {ctx.canPost && (
            <button type="button" className={`icon-btn ${s.icon}`} aria-label={t("Reply")} title={t("Reply")} onClick={() => ctx.onReply(message)}>
              <Icon name="reply" size={16} />
            </button>
          )}
          <Menu
            label={t("More")}
            title={author?.name ?? "Crewtavo"}
            align="end"
            triggerClassName={`icon-btn ${s.icon}`}
            trigger={<Icon name="more" size={16} />}
            items={[
              { label: t("Edit"), icon: "edit", kbd: "E", onSelect: startEdit, hidden: !mine || !ctx.canPost },
              { label: message.pinned_at ? t("Unpin") : t("Pin to the channel"), icon: message.pinned_at ? "unpin" : "pushpin", kbd: "P", onSelect: () => pin.mutate(), hidden: !ctx.canManage },
              { label: t("Copy text"), icon: "copy", kbd: "C", onSelect: () => copyText(toEditable(message.body, nameFor), "Copied"), hidden: !message.body },
              remind.entry,
              // The people who may change jobs (the API and the database decide again).
              { label: t("Add to a job"), icon: "job", kbd: "J", onSelect: () => setToJob(true), hidden: !hasRole(session, "admin", "office", "estimator") },
              { separator: true },
              { label: t("Delete"), icon: "trash", danger: true, onSelect: askDelete, hidden: !(mine || ctx.canManage) },
            ]}
          />
        </div>
      )}
    </div>
  );
}
