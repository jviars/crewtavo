/**
 * A message's reactions under it: each kind as a pill with its count, yours in green. Tap one to add
 * or take back yours; hover it (or, on a phone, press and hold it) to see who. With the keyboard,
 * "Who reacted" comes after the pills, showing once it has the focus. The quick reactions show their
 * own icon or words, an emoji itself. A last button adds another from the emoji picker.
 */
import { useRef, useState, type PointerEvent } from "react";
import { CHAT_REACTIONS } from "@crewtavo/core/chat";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import type { ChatReactionGroup } from "./data";
import { EmojiPicker, QUICK_ICONS } from "./EmojiPicker";
import s from "./chat.module.css";
import x from "./emoji.module.css";

/** A reaction's name: the quick ones' words, or the emoji itself (which a screen reader names). */
export const reactionLabel = (kind: string) => {
  const quick = CHAT_REACTIONS.find((r) => r.key === kind);
  return quick ? t(quick.label) : kind;
};

/** The groups with yours turned on or off, for showing it at once, before the server answers. */
export function toggledReactions(groups: ChatReactionGroup[], kind: string, me: string, on: boolean): ChatReactionGroup[] {
  const found = groups.some((g) => g.kind === kind);
  const next = groups.map((g) => (g.kind !== kind ? g : { ...g, users: on ? [...new Set([...g.users, me])] : g.users.filter((u) => u !== me) }));
  return (found || !on ? next : [...next, { kind, users: [me] }]).filter((g) => g.users.length);
}

export function ReactionPills({
  reactions,
  me,
  personName,
  onToggle,
}: {
  reactions: ChatReactionGroup[];
  me: string;
  personName: (id: string) => string;
  onToggle: (kind: string, on: boolean) => void;
}) {
  const [who, setWho] = useState(false);
  const held = useRef<{ timer?: ReturnType<typeof setTimeout>; fired: boolean }>({ fired: false });
  const names = (g: ChatReactionGroup) => g.users.map((u) => (u === me ? t("You") : personName(u))).join(", ");
  const mine = reactions.filter((g) => g.users.includes(me)).map((g) => g.kind);

  // Pressing and holding on a phone shows who reacted, instead of changing yours.
  const press = (e: PointerEvent) => {
    if (e.pointerType === "mouse") return;
    held.current.fired = false;
    clearTimeout(held.current.timer);
    held.current.timer = setTimeout(() => {
      held.current.fired = true;
      setWho(true);
    }, 500);
  };
  const release = () => clearTimeout(held.current.timer);

  if (!reactions.length) return null;
  return (
    <div className={s.reactions}>
      {reactions.map((g) => {
        const quick = CHAT_REACTIONS.find((r) => r.key === g.kind);
        const on = g.users.includes(me);
        const label = reactionLabel(g.kind);
        return (
          <button
            key={g.kind}
            type="button"
            className={`${s.reaction} ${x.pill}`}
            aria-pressed={on}
            aria-label={`${label}, ${g.users.length}`}
            title={`${label}: ${names(g)}`}
            onPointerDown={press}
            onPointerUp={release}
            onPointerLeave={release}
            onPointerCancel={release}
            onContextMenu={(e) => {
              if (held.current.fired) e.preventDefault();
            }}
            onClick={() => {
              if (held.current.fired) {
                held.current.fired = false;
                return;
              }
              onToggle(g.kind, !on);
            }}
          >
            {!quick ? (
              <><span className={x.pillEmoji} aria-hidden="true">{g.kind}</span>{g.users.length}</>
            ) : g.kind === "thumbs_up" ? (
              <><Icon name={QUICK_ICONS[g.kind] ?? "thumbsUp"} size={13} />{g.users.length}</>
            ) : (
              `${label} · ${g.users.length}`
            )}
          </button>
        );
      })}
      <EmojiPicker
        label={t("Add a reaction")}
        quick
        mine={mine}
        triggerClassName={`${s.reaction} ${x.addReaction}`}
        trigger={<Icon name="react" size={14} />}
        align="start"
        onPick={(kind) => onToggle(kind, !mine.includes(kind))}
      />
      <button type="button" className={x.whoButton} onClick={() => setWho(true)}>{t("Who reacted")}</button>
      {/* A tap in the sheet isn't a tap on the message under it. */}
      <span style={{ display: "contents" }} onClick={(e) => e.stopPropagation()}>
        <Dialog open={who} onClose={() => setWho(false)} title={t("Reactions")} size="sm">
          <ul className={`dialog-body ${x.who}`}>
            {reactions.map((g) => (
              <li key={g.kind}>
                <span className={x.whoKind} aria-hidden="true">
                  {QUICK_ICONS[g.kind] ? <Icon name={QUICK_ICONS[g.kind]!} size={16} /> : g.kind}
                </span>
                <span>
                  <strong>{reactionLabel(g.kind)}</strong>
                  <span>{names(g)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Dialog>
      </span>
    </div>
  );
}
