/**
 * Team chat rules shared by the web app and the API. Messages keep mentions as tokens in their text
 * (the database reads them out of it, supabase/migrations/20261019001600_team_chat.sql):
 *   <@user id>   a person
 *   <@&role>     a role: an access level (field_crew) or a custom role's id
 *   @everyone    everyone who can see the channel (only its managers can ping with it)
 * People type and read "@Marcus Reyes"; the composer swaps names for tokens as it sends.
 */
import { msg } from "./i18n";
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
  { key: "thumbs_up", label: msg("Thumbs up") },
  { key: "on_it", label: msg("On it") },
  { key: "seen", label: msg("Seen") },
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

// ---------------------------------------------------------------------------------------------
// Formatting: the Markdown people type in chat (or paste from a notes app or an AI chat)
// ---------------------------------------------------------------------------------------------

/** Words in a message, with their formatting. Mentions sit among them as they do in messageParts. */
export type ChatInline =
  | { kind: "text"; text: string }
  | { kind: "user"; id: string }
  | { kind: "role"; key: string }
  | { kind: "everyone" }
  | { kind: "bold" | "italic" | "strike"; children: ChatInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: ChatInline[] };

/** A message's lines: paragraphs keep each line break as it was typed, as a chat does. */
export type ChatBlock =
  | { kind: "paragraph"; lines: ChatInline[][] }
  | { kind: "heading"; children: ChatInline[] }
  | { kind: "quote"; blocks: ChatBlock[] }
  | { kind: "list"; ordered: boolean; start: number; items: ChatInline[][] }
  | { kind: "code"; text: string };

const SAFE_HREF = /^(?:https?:\/\/|mailto:|tel:)/i;
const BARE_URL = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]*_~]/y;
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/y;
const MENTION = new RegExp(TOKEN.source, "y");
const ESCAPABLE = /[\\`*_~[\]()#>+\-.!|]/;
const WORD = /[\p{L}\p{N}_]/u;

/** Where a run marked with `mark` closes, after `from`: not just after a space, nor (for "_") inside a word. */
function closing(src: string, mark: string, from: number): number {
  for (let at = src.indexOf(mark, from); at !== -1; at = src.indexOf(mark, at + 1)) {
    if (at === from || /\s/.test(src[at - 1])) continue;
    if (mark.length === 1 && src[at + 1] === mark) {
      at += 1; // "**" is bold's, not the end of an italic run.
      continue;
    }
    if (mark === "_" && WORD.test(src[at + 1] ?? "")) continue;
    // "***" closes italics inside bold: bold's "**" are the last two.
    while (src[at + mark.length] === mark[0]) at += 1;
    return at;
  }
  return -1;
}

/** Bold (**, __), italics (*, _), strikethrough (~~), `code`, [links](https://…), bare links and mentions in a line. */
export function chatInline(src: string): ChatInline[] {
  const out: ChatInline[] = [];
  let text = "";
  const push = (node: ChatInline) => {
    if (text) out.push({ kind: "text", text });
    text = "";
    out.push(node);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const prev = src[i - 1] ?? "";
    if (c === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        push({ kind: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "<" || c === "@") {
      MENTION.lastIndex = i;
      const m = MENTION.exec(src);
      if (m) {
        push(m[1] ? { kind: "user", id: m[1] } : m[2] ? { kind: "role", key: m[2] } : { kind: "everyone" });
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !WORD.test(prev)) {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(src);
      if (m) {
        push({ kind: "link", href: m[0], children: [{ kind: "text", text: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    if (c === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(src);
      if (m && SAFE_HREF.test(m[2])) {
        // A link's words can't hold another link ("[https://a](https://b)"): those are words here.
        const unlink = (nodes: ChatInline[]): ChatInline[] => nodes.flatMap((n) => (n.kind === "link" ? unlink(n.children) : "children" in n ? [{ ...n, children: unlink(n.children) }] : [n]));
        push({ kind: "link", href: m[2], children: unlink(chatInline(m[1])) });
        i += m[0].length;
        continue;
      }
    }
    const pair = src.slice(i, i + 2);
    if ((pair === "**" || pair === "__" || pair === "~~") && src[i + 2] && !/\s/.test(src[i + 2]) && !(pair === "__" && WORD.test(prev))) {
      const end = closing(src, pair, i + 2);
      if (end > i + 2) {
        push({ kind: pair === "~~" ? "strike" : "bold", children: chatInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && src[i + 1] && !/\s/.test(src[i + 1]) && src[i + 1] !== c && !(c === "_" && WORD.test(prev))) {
      const end = closing(src, c, i + 1);
      if (end > i + 1) {
        push({ kind: "italic", children: chatInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    text += c;
    i += 1;
  }
  if (text) out.push({ kind: "text", text });
  return out;
}

const FENCE = /^\s*```/;
const HEADING = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^\s*(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;

/** A message's text as blocks to show: paragraphs, short headings, quotes, bulleted and numbered lists and code. */
export function chatBlocks(body: string): ChatBlock[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ChatBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", lines: paragraph.map(chatInline) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !FENCE.test(lines[i])) code.push(lines[i]);
      // The first line after the fence may name the language ("```js"): it isn't shown.
      blocks.push({ kind: "code", text: code.join("\n").replace(/^\n+|\n+$/g, "") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", children: chatInline(heading[1]) });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) quoted.push(QUOTE.exec(lines[i])![1]);
      i -= 1;
      blocks.push({ kind: "quote", blocks: chatBlocks(quoted.join("\n")) });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = !item[1];
      const list = { kind: "list" as const, ordered, start: ordered ? Number(item[2]) : 1, items: [] as ChatInline[][] };
      let texts: string[] = [];
      for (; i < lines.length; i++) {
        const next = ITEM.exec(lines[i]);
        if (next && !next[1] === ordered) texts.push(next[3]);
        // A line under an item, indented, carries on that item.
        else if (texts.length && /^\s+\S/.test(lines[i]) && !next) texts[texts.length - 1] += `\n${lines[i].trim()}`;
        else break;
      }
      i -= 1;
      list.items = texts.map(chatInline);
      texts = [];
      blocks.push(list);
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** A message as plain text with its formatting marks taken out, for a one-line preview: "@Marcus Reyes the gate code is 4411". */
export function chatPlainText(body: string, name: (part: Exclude<MessagePart, { kind: "text" }>) => string): string {
  const inline = (nodes: ChatInline[]): string =>
    nodes
      .map((n) => (n.kind === "text" || n.kind === "code" ? n.text : n.kind === "everyone" ? EVERYONE_TOKEN : n.kind === "user" || n.kind === "role" ? `@${name(n)}` : inline(n.children)))
      .join("");
  const block = (b: ChatBlock): string =>
    b.kind === "paragraph" ? b.lines.map(inline).join(" ") : b.kind === "heading" ? inline(b.children) : b.kind === "quote" ? b.blocks.map(block).join(" ") : b.kind === "list" ? b.items.map(inline).join(" ") : b.text;
  return chatBlocks(body).map(block).join(" ").replace(/\s+/g, " ").trim();
}
