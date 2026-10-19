/**
 * Team chat rules shared by the web app and the API. Messages keep mentions as tokens in their text
 * (the database reads them out of it, supabase/migrations/20261019001600_team_chat.sql):
 *   <@user id>   a person
 *   <@&role>     a role: an access level (field_crew) or a custom role's id
 *   @everyone    everyone who can see the channel (only its managers can ping with it)
 * People type and read "@Marcus Reyes"; the composer swaps names for tokens as it sends.
 */
import { ROLE_LABELS, isRole, type Role } from "./roles";

/** Name colors a role can have in chat. The web app maps each to a light and a dark shade. */
export const CHAT_COLORS = [
  { key: "amber", label: "Amber" },
  { key: "orange", label: "Orange" },
  { key: "ruby", label: "Ruby" },
  { key: "purple", label: "Purple" },
  { key: "blue", label: "Blue" },
  { key: "teal", label: "Teal" },
  { key: "green", label: "Green" },
  { key: "default", label: "No color" },
] as const;
export type ChatColor = (typeof CHAT_COLORS)[number]["key"];
export const isChatColor = (value: unknown): value is ChatColor => CHAT_COLORS.some((c) => c.key === value);

/** Reactions: words people tap, not emoji. */
export const CHAT_REACTIONS = [
  { key: "thumbs_up", label: "Thumbs up" },
  { key: "on_it", label: "On it" },
  { key: "seen", label: "Seen" },
] as const;
export type ChatReaction = (typeof CHAT_REACTIONS)[number]["key"];
export const isChatReaction = (value: unknown): value is ChatReaction => CHAT_REACTIONS.some((r) => r.key === value);

/** Who a new channel is for, which sets its starting rules (chat_create_channel). */
export const CHANNEL_PRESETS = [
  { key: "everyone", label: "The whole team", hint: "Everyone can read and post." },
  { key: "announcement", label: "Announcements", hint: "Everyone reads. Owners, admins and the office post." },
  { key: "office", label: "The office", hint: "Owners, admins, office and estimators." },
  { key: "crew", label: "A crew", hint: "The crew's people, its lead and the office." },
] as const;
export type ChannelPreset = (typeof CHANNEL_PRESETS)[number]["key"];

/** The key a role goes by in chat: a custom role's id, else its access level. */
export const chatRoleKey = (role: Role, roleId: string | null | undefined): string => roleId || role;

/** "Crew lead" for an access level's key; custom roles carry their own names. */
export function levelLabel(key: string): string | null {
  return isRole(key) ? ROLE_LABELS[key] : null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN = new RegExp(`<@(${UUID})>|<@&([a-z_]+|${UUID})>|(?<![A-Za-z0-9_<])@everyone(?![A-Za-z0-9_])`, "g");

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "user"; id: string }
  | { kind: "role"; key: string }
  | { kind: "everyone" };

/** A message's text as plain text and mentions, for showing it. */
export function messageParts(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const match of body.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: body.slice(last, at) });
    if (match[1]) parts.push({ kind: "user", id: match[1] });
    else if (match[2]) parts.push({ kind: "role", key: match[2] });
    else parts.push({ kind: "everyone" });
    last = at + match[0].length;
  }
  if (last < body.length) parts.push({ kind: "text", text: body.slice(last) });
  return parts;
}

/** Someone or something that can be @mentioned, as the composer offers it. */
export interface Mentionable {
  /** What people see and type after @: "Marcus Reyes", "Field crew", "everyone". */
  label: string;
  token: string;
}

export const userToken = (id: string) => `<@${id}>`;
export const roleToken = (key: string) => `<@&${key}>`;
export const EVERYONE_TOKEN = "@everyone";

/** Message text with @names put back in, for editing it. */
export function toEditable(body: string, name: (part: Exclude<MessagePart, { kind: "text" }>) => string): string {
  return messageParts(body)
    .map((p) => (p.kind === "text" ? p.text : p.kind === "everyone" ? EVERYONE_TOKEN : `@${name(p)}`))
    .join("");
}

/**
 * Typed text with the @names someone picked turned into tokens. Longer names go first, so "@Sam
 * Ortiz" isn't read as "@Sam" with "Ortiz" after it. A name only counts as a whole word.
 */
export function fromEditable(text: string, picked: readonly Mentionable[]): string {
  let out = text;
  const unique = [...new Map(picked.map((m) => [m.label.toLowerCase(), m])).values()].sort((a, b) => b.label.length - a.label.length);
  for (const m of unique) {
    if (m.token === EVERYONE_TOKEN) continue;
    const escaped = m.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_])@${escaped}(?![A-Za-z0-9_])`, "gi"), (_, before: string) => `${before}${m.token}`);
  }
  return out;
}

/** What a mention search after @ matches: names starting with what was typed, then anywhere in them. */
export function matchMentions<T extends Mentionable>(options: readonly T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice(0, limit);
  const starts = options.filter((o) => o.label.toLowerCase().startsWith(q) || o.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
  const inside = options.filter((o) => !starts.includes(o) && o.label.toLowerCase().includes(q));
  return [...starts, ...inside].slice(0, limit);
}

/** A text channel's name for a title, the way the database makes it: "North Crew!" -> north-crew. */
export function channelSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44)
    .replace(/-+$/g, "");
  return slug || "channel";
}

/** A message as one line of plain text: "@Marcus Reyes can you…". */
export function plainMessage(body: string, name: (part: Exclude<MessagePart, { kind: "text" }>) => string): string {
  return toEditable(body, name).replace(/\s+/g, " ").trim();
}
