/** Small pieces chat screens share: role colors, avatars, names and time labels. */
import type { CSSProperties } from "react";
import type { ChatColor } from "@crewtavo/core/chat";
import { Icon } from "@/components/ui/Icon";
import { initials } from "@/components/shell/AppShell";
import type { ChatChannel } from "./data";
import s from "./chat.module.css";

/** A role's name color and its tint (tokens.css), for names, badges and @mentions. */
export const roleColor = (color: ChatColor | string | null | undefined) => `var(--chat-${color || "default"})`;
export const roleTint = (color: ChatColor | string | null | undefined) => `var(--chat-${color || "default"}-tint)`;
export const badgeStyle = (color: ChatColor | string | null | undefined): CSSProperties => ({ background: roleTint(color), color: roleColor(color) });

export function Avatar({ name, color, size = 40, className }: { name: string; color?: string | null; size?: number; className?: string }) {
  return (
    <span className={className ?? s.memberAvatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.35), background: color || "var(--avatar)" }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** The channel's icon: # for a text channel, a megaphone for announcements. */
export function ChannelIcon({ channel, size = 18 }: { channel: Pick<ChatChannel, "kind">; size?: number }) {
  return <Icon name={channel.kind === "announcement" ? "megaphone" : "hash"} size={size} />;
}

/** "#north-crew" or "Announcements". */
export const channelLabel = (channel: Pick<ChatChannel, "kind" | "name">) => (channel.kind === "announcement" ? channel.name : `#${channel.name}`);

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", "Monday, October 19" (with the year when it isn't this one). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const shortTime = (iso: string) => timeLabel(iso).replace(/\s?[AP]M$/i, "");

/** When a message shows its sender again: a new person, a new day, or five minutes later. */
export function startsGroup(prev: { author_id: string | null; created_at: string } | undefined, next: { author_id: string | null; created_at: string }): boolean {
  if (!prev) return true;
  if (prev.author_id !== next.author_id) return true;
  if (!sameDay(new Date(prev.created_at), new Date(next.created_at))) return true;
  return Date.parse(next.created_at) - Date.parse(prev.created_at) > 5 * 60_000;
}

export const isNewDay = (prev: { created_at: string } | undefined, next: { created_at: string }) => !prev || !sameDay(new Date(prev.created_at), new Date(next.created_at));
