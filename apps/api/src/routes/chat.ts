/**
 * Team chat: channels, messages, reactions, pins, who's read what, the live connection
 * (GET /chat/live) and, for owners and admins, Chat settings and the switch on Apps.
 *
 * Every read and write uses the signed-in person's own database client, so row-level security
 * decides what they can see and do (supabase/migrations/20261019001600_team_chat.sql). Writes come
 * through here rather than straight to the database so the people looking at a channel hear about
 * them at once (lib/chatHub.ts).
 */
import type { TablesUpdate } from "@crewtavo/core";
import { ADMINS, channelSlug, CHAT_COLORS, CHAT_REACTIONS, chatRoleKey, isChatColor, isRole, ROLE_LABELS, STAFF, type ChatColor, type Role } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { forgetAudiences, onlineUsers, subscribe, toChannel, toCompany, toUser, type ChatEvent } from "../lib/chatHub";
import { dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { adminClient, type Db } from "../lib/supabase";

export const chat = new Hono<AppEnv>();

/** A live connection lasts this long, then the browser opens a new one (with a fresh sign-in). */
const LIVE_MS = 10 * 60_000;
const PING_MS = 20_000;
const PAGE = 50;

const OFF = "Team chat is turned off. An owner or admin can turn it on in Apps.";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface ChatPerson {
  id: string;
  name: string;
  avatar_color: string | null;
  /** Their photo in the files bucket, or null for initials. */
  avatar_url: string | null;
  role_key: string;
  role_label: string;
  color: ChatColor;
}

interface Attachment {
  path: string;
  name?: string;
  type?: string;
  size?: number;
  width?: number;
  height?: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  attachments: unknown;
  job_id: string | null;
  reply_to: string | null;
  mention_users: string[];
  mention_roles: string[];
  mention_all: boolean;
  pinned_at: string | null;
  pinned_by: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface ChatReactionOut {
  kind: string;
  users: string[];
}

export interface ChatMessageOut extends Omit<MessageRow, "attachments"> {
  attachments: Attachment[];
  author: ChatPerson | null;
  reply: { id: string; author: string; body: string; deleted: boolean } | null;
  reactions: ChatReactionOut[];
}

const MESSAGE_COLUMNS = "id, channel_id, author_id, body, attachments, job_id, reply_to, mention_users, mention_roles, mention_all, pinned_at, pinned_by, edited_at, deleted_at, created_at";

const roleLabel = (key: string, custom: Map<string, string>) => (isRole(key) ? ROLE_LABELS[key] : custom.get(key) ?? "Team");

/** People by id, as chat shows them: name, and their role's label and color. */
async function loadPeople(db: Db, companyId: string, ids: Iterable<string>): Promise<Map<string, ChatPerson>> {
  const wanted = [...new Set([...ids].filter(Boolean))];
  const out = new Map<string, ChatPerson>();
  if (!wanted.length) return out;
  const [members, profiles, roles, settings] = await Promise.all([
    db.from("memberships").select("user_id, role, role_id").eq("company_id", companyId).in("user_id", wanted),
    db.from("profiles").select("user_id, full_name, email, color, avatar_url").in("user_id", wanted),
    db.from("company_roles").select("id, name, base_role").eq("company_id", companyId),
    db.from("chat_role_settings").select("role, role_id, color").eq("company_id", companyId),
  ]);
  for (const r of [members, profiles, roles, settings]) if (r.error) throw dbError(r.error);
  const custom = new Map((roles.data ?? []).map((r) => [r.id, r.name]));
  const colorOf = (role: Role, roleId: string | null): ChatColor => {
    const rows = settings.data ?? [];
    const found = (roleId && rows.find((s) => s.role_id === roleId)) || rows.find((s) => s.role === role);
    return found && isChatColor(found.color) ? found.color : "default";
  };
  const profileOf = new Map((profiles.data ?? []).map((p) => [p.user_id, p]));
  for (const m of members.data ?? []) {
    const p = profileOf.get(m.user_id);
    const key = chatRoleKey(m.role, m.role_id);
    out.set(m.user_id, {
      id: m.user_id,
      name: p?.full_name || p?.email || "Someone",
      avatar_color: p?.color ?? null,
      avatar_url: p?.avatar_url ?? null,
      role_key: key,
      role_label: roleLabel(key, custom),
      color: colorOf(m.role, m.role_id),
    });
  }
  return out;
}

/** Messages with their authors, the message each replies to, and their reactions. */
async function shapeMessages(db: Db, companyId: string, rows: MessageRow[]): Promise<ChatMessageOut[]> {
  if (!rows.length) return [];
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter((id): id is string => Boolean(id)))];
  const [reactions, replies] = await Promise.all([
    db.from("chat_reactions").select("message_id, user_id, kind, created_at").in("message_id", rows.map((r) => r.id)).order("created_at"),
    replyIds.length ? db.from("chat_messages").select("id, author_id, body, deleted_at").in("id", replyIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (reactions.error) throw dbError(reactions.error);
  if (replies.error) throw dbError(replies.error);
  const people = await loadPeople(db, companyId, [...rows.map((r) => r.author_id ?? ""), ...(replies.data ?? []).map((r) => r.author_id ?? "")]);
  const replyOf = new Map((replies.data ?? []).map((r) => [r.id, r]));
  return rows.map((row) => {
    const reply = row.reply_to ? replyOf.get(row.reply_to) : null;
    return {
      ...row,
      attachments: Array.isArray(row.attachments) ? (row.attachments as Attachment[]) : [],
      author: row.author_id ? people.get(row.author_id) ?? null : null,
      reply: reply
        ? { id: reply.id, author: (reply.author_id && people.get(reply.author_id)?.name) || "Crewtavo", body: reply.deleted_at ? "" : reply.body.slice(0, 300), deleted: Boolean(reply.deleted_at) }
        : null,
      reactions: groupReactions((reactions.data ?? []).filter((r) => r.message_id === row.id)),
    };
  });
}

function groupReactions(rows: Array<{ user_id: string; kind: string }>): ChatReactionOut[] {
  return CHAT_REACTIONS.map((r) => ({ kind: r.key, users: rows.filter((x) => x.kind === r.key).map((x) => x.user_id) })).filter((r) => r.users.length);
}

async function chatEnabled(db: Db, companyId: string): Promise<boolean> {
  const { data, error } = await db.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw dbError(error);
  const settings = (data?.settings ?? {}) as { team_chat?: { enabled?: boolean } };
  return settings.team_chat?.enabled === true;
}

async function requireOn(c: Context<AppEnv>) {
  if (!(await chatEnabled(c.var.db, c.var.companyId))) throw new HttpError(409, OFF);
}

async function messageById(db: Db, id: string): Promise<MessageRow> {
  return must(await db.from("chat_messages").select(MESSAGE_COLUMNS).eq("id", id).maybeSingle(), "That message isn't here anymore.") as MessageRow;
}

/** Tell the channel, without holding up the answer to the person who made the change. */
function publish(c: Context<AppEnv>, channelId: string, event: ChatEvent, options: { except?: string } = {}) {
  toChannel(adminClient(c.env), c.var.companyId, channelId, event, options).catch((error) => reportError(error, { feature: "chat-live" }));
}

/** Database refusals in words people understand. */
function chatDbError(error: { message: string; code?: string }): HttpError {
  if (error.code === "42501" && /row-level security/i.test(error.message)) return new HttpError(403, "You can't post in this channel.");
  if (error.code === "42501" || error.code === "23514" || error.code === "22023") return new HttpError(error.code === "42501" ? 403 : 400, error.message);
  return dbError(error);
}

// ---------------------------------------------------------------------------------------------
// Everyone
// ---------------------------------------------------------------------------------------------

/** Chat for this person: on or off, their channels with what's new, and the roles to @mention. */
chat.get("/chat/state", requireUser, requireCompany(), async (c) => {
  const { db, companyId, userId, role } = c.var;
  if (!(await chatEnabled(db, companyId))) return c.json({ enabled: false, channels: [], roles: [], me: null });
  const [overview, me, roles, settings] = await Promise.all([
    db.rpc("chat_overview", { p_company: companyId }),
    db.from("memberships").select("role, role_id").eq("company_id", companyId).eq("user_id", userId).maybeSingle(),
    db.from("company_roles").select("id, name, base_role").eq("company_id", companyId).order("name"),
    db.from("chat_role_settings").select("role, role_id, color, mentionable, show_separately").eq("company_id", companyId),
  ]);
  for (const r of [overview, me, roles, settings]) if (r.error) throw dbError(r.error);
  const rows = settings.data ?? [];
  const settingFor = (level: Role | null, roleId: string | null) =>
    (roleId && rows.find((s) => s.role_id === roleId)) || rows.find((s) => s.role === level) || null;
  const roleList = [
    ...STAFF.map((level) => ({ key: level as string, label: ROLE_LABELS[level], custom: false, setting: settingFor(level, null) })),
    ...(roles.data ?? []).map((r) => ({ key: r.id, label: r.name, custom: true, setting: settingFor(r.base_role, r.id) })),
  ].map(({ setting, ...r }) => ({
    ...r,
    color: setting && isChatColor(setting.color) ? setting.color : "default",
    mentionable: setting?.mentionable ?? true,
    show_separately: setting?.show_separately ?? true,
  }));
  return c.json({
    enabled: true,
    me: { user_id: userId, role_key: chatRoleKey(me.data?.role ?? role, me.data?.role_id ?? null), admin: ADMINS.includes(role) },
    channels: overview.data ?? [],
    roles: roleList,
  });
});

/** A page of messages, oldest first: the newest, those before `before`, or those around `around`. */
chat.get("/chat/channels/:id/messages", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const query = z
    .object({ before: z.iso.datetime({ offset: true }).optional(), around: uuid.optional(), limit: z.coerce.number().int().min(1).max(100).default(PAGE) })
    .parse(c.req.query());
  const { db, companyId } = c.var;
  await requireOn(c);
  let rows: MessageRow[];
  let hasMore = false;
  if (query.around) {
    const target = await messageById(db, query.around);
    if (target.channel_id !== id) throw new HttpError(404, "That message isn't in this channel.");
    const half = Math.floor(query.limit / 2);
    const [older, newer] = await Promise.all([
      db.from("chat_messages").select(MESSAGE_COLUMNS).eq("channel_id", id).lte("created_at", target.created_at).order("created_at", { ascending: false }).limit(half + 1),
      db.from("chat_messages").select(MESSAGE_COLUMNS).eq("channel_id", id).gt("created_at", target.created_at).order("created_at").limit(half),
    ]);
    const before = must(older) as MessageRow[];
    hasMore = before.length > half;
    rows = [...before.slice(0, half).reverse(), ...(must(newer) as MessageRow[])];
  } else {
    let q = db.from("chat_messages").select(MESSAGE_COLUMNS).eq("channel_id", id).order("created_at", { ascending: false }).limit(query.limit + 1);
    if (query.before) q = q.lt("created_at", query.before);
    const page = must(await q) as MessageRow[];
    hasMore = page.length > query.limit;
    rows = page.slice(0, query.limit).reverse();
  }
  return c.json({ messages: await shapeMessages(db, companyId, rows), has_more: hasMore });
});

chat.get("/chat/channels/:id/pins", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.from("chat_messages").select(MESSAGE_COLUMNS).eq("channel_id", id).not("pinned_at", "is", null).order("pinned_at", { ascending: false }).limit(50)) as MessageRow[];
  return c.json({ messages: await shapeMessages(db, companyId, rows) });
});

/** Who can see a channel, grouped the way the member list shows them, and who's online now. */
chat.get("/chat/channels/:id/members", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.rpc("chat_members", { p_channel: id })) as Array<{
    user_id: string; full_name: string; avatar_color: string | null; role: Role; role_id: string | null; role_key: string; role_name: string; color: string; show_separately: boolean;
  }>;
  const online = new Set(onlineUsers(companyId));
  const photos = rows.length ? must(await db.from("profiles").select("user_id, avatar_url").in("user_id", rows.map((m) => m.user_id)).not("avatar_url", "is", null)) : [];
  const photoOf = new Map(photos.map((p) => [p.user_id, p.avatar_url]));
  return c.json({
    members: rows.map((m) => ({
      id: m.user_id,
      name: m.full_name,
      avatar_color: m.avatar_color,
      avatar_url: photoOf.get(m.user_id) ?? null,
      role: m.role,
      role_key: m.role_key,
      role_label: m.role_name,
      color: isChatColor(m.color) ? m.color : "default",
      show_separately: m.show_separately,
      online: online.has(m.user_id),
    })),
  });
});

const messageBody = z.string().max(4000, "Messages can be up to 4,000 characters.");
const attachment = z.object({
  path: z.string().max(300),
  name: z.string().max(200).optional(),
  type: z.string().max(100).optional(),
  size: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

chat.post("/chat/channels/:id/messages", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(
    c,
    z.object({ body: messageBody.default(""), attachments: z.array(attachment).max(6).default([]), job_id: uuid.nullable().default(null), reply_to: uuid.nullable().default(null) }),
  );
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { data, error } = await db
    .from("chat_messages")
    .insert({ company_id: companyId, channel_id: id, author_id: userId, body: body.body, attachments: body.attachments as never, job_id: body.job_id, reply_to: body.reply_to })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) throw chatDbError(error);
  const [message] = await shapeMessages(db, companyId, [data as MessageRow]);
  publish(c, id, { type: "message", channel_id: id, message });
  return c.json({ message }, 201);
});

chat.patch("/chat/messages/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ body: messageBody }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const current = await messageById(db, id);
  if (current.author_id !== userId) throw new HttpError(403, "You can only edit your own messages.");
  const { data, error } = await db.from("chat_messages").update({ body: body.body }).eq("id", id).select(MESSAGE_COLUMNS).maybeSingle();
  if (error) throw chatDbError(error);
  if (!data) throw new HttpError(403, "You can only edit your own messages.");
  const [message] = await shapeMessages(db, companyId, [data as MessageRow]);
  publish(c, message.channel_id, { type: "message_updated", channel_id: message.channel_id, message });
  return c.json({ message });
});

chat.delete("/chat/messages/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.from("chat_messages").update({ deleted_at: new Date().toISOString() }).eq("id", id).select(MESSAGE_COLUMNS).maybeSingle();
  if (error) throw chatDbError(error);
  if (!data) throw new HttpError(403, "You can only delete your own messages.");
  const [message] = await shapeMessages(db, companyId, [data as MessageRow]);
  publish(c, message.channel_id, { type: "message_updated", channel_id: message.channel_id, message });
  return c.json({ message });
});

chat.post("/chat/messages/:id/pin", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ pinned: z.boolean() }));
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.from("chat_messages").update({ pinned_at: body.pinned ? new Date().toISOString() : null }).eq("id", id).select(MESSAGE_COLUMNS).maybeSingle();
  if (error) throw chatDbError(error);
  if (!data) throw new HttpError(403, "Only people who manage this channel can pin messages.");
  const [message] = await shapeMessages(db, companyId, [data as MessageRow]);
  publish(c, message.channel_id, { type: "message_updated", channel_id: message.channel_id, message });
  return c.json({ message });
});

chat.post("/chat/messages/:id/reactions", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ kind: z.enum(CHAT_REACTIONS.map((r) => r.key) as [string, ...string[]]), on: z.boolean() }));
  const { db, userId } = c.var;
  await requireOn(c);
  const message = await messageById(db, id);
  if (body.on) {
    const { error } = await db.from("chat_reactions").upsert({ company_id: c.var.companyId, channel_id: message.channel_id, message_id: id, user_id: userId, kind: body.kind }, { onConflict: "message_id,user_id,kind", ignoreDuplicates: true });
    if (error) throw chatDbError(error);
  } else {
    const { error } = await db.from("chat_reactions").delete().match({ message_id: id, user_id: userId, kind: body.kind });
    if (error) throw chatDbError(error);
  }
  const rows = must(await db.from("chat_reactions").select("user_id, kind, created_at").eq("message_id", id).order("created_at"));
  const reactions = groupReactions(rows);
  publish(c, message.channel_id, { type: "reactions", channel_id: message.channel_id, message_id: id, reactions });
  return c.json({ reactions });
});

chat.post("/chat/channels/:id/read", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  const { error } = await db.rpc("chat_mark_read", { p_channel: id });
  if (error) throw chatDbError(error);
  toUser(companyId, userId, { type: "read", channel_id: id });
  return c.json({ ok: true });
});

const lastTyping = new Map<string, number>();
chat.post("/chat/channels/:id/typing", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  const key = `${userId}:${id}`;
  const now = Date.now();
  if (now - (lastTyping.get(key) ?? 0) < 2_500) return c.json({ ok: true });
  lastTyping.set(key, now);
  if (lastTyping.size > 5_000) lastTyping.clear();
  const visible = await db.from("chat_channels").select("id").eq("id", id).maybeSingle();
  if (visible.error) throw dbError(visible.error);
  if (!visible.data) return c.json({ ok: true });
  const person = (await loadPeople(db, companyId, [userId])).get(userId);
  publish(c, id, { type: "typing", channel_id: id, user_id: userId, name: person?.name ?? "Someone" }, { except: userId });
  return c.json({ ok: true });
});

/** A channel's topic: owners, admins and the channel's managers. */
chat.patch("/chat/channels/:id", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ topic: z.string().trim().max(300, "Keep the topic under 300 characters.") }));
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.from("chat_channels").update({ topic: body.topic || null }).eq("id", id).select("id").maybeSingle();
  if (error) throw chatDbError(error);
  if (!data) throw new HttpError(403, "Only people who manage this channel can change its topic.");
  forgetAudiences();
  toCompany(companyId, { type: "channels" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// The live connection
// ---------------------------------------------------------------------------------------------

/**
 * Server-sent events over a plain request (Railway passes them straight through; no extra
 * service). The browser reads it with fetch, so it can send the sign-in as a header, and opens a
 * new one when this one ends (every LIVE_MS, or when the network drops).
 */
chat.get("/chat/live", requireUser, requireCompany(), async (c) => {
  const { companyId, userId } = c.var;
  await requireOn(c);
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let open = true;
    const send = (event: ChatEvent) => {
      if (!open) return;
      stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {
        open = false;
      });
    };
    const stop = subscribe(companyId, userId, send);
    stream.onAbort(() => {
      open = false;
      stop();
    });
    try {
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ type: "hello", online: onlineUsers(companyId) }), retry: 3000 });
      const until = Date.now() + LIVE_MS;
      while (open && Date.now() < until) {
        await stream.sleep(PING_MS);
        if (open) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    } finally {
      open = false;
      stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Owners and admins: Chat settings, and the switch on Apps
// ---------------------------------------------------------------------------------------------

chat.post("/chat/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { db, companyId } = c.var;
  const { data, error } = await db.rpc("chat_set_enabled", { p_company: companyId, p_enabled: body.enabled });
  if (error) throw chatDbError(error);
  forgetAudiences();
  toCompany(companyId, { type: "chat", enabled: Boolean(data) });
  return c.json({ enabled: Boolean(data) });
});

chat.get("/chat/settings", requireUser, requireCompany(ADMINS), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const [channels, rules, settings, roles, members, crews] = await Promise.all([
    db.from("chat_channels").select("id, kind, name, category, topic, crew_id, position, archived_at").eq("company_id", companyId).order("position").order("name"),
    db.from("chat_role_rules").select("channel_id, role, role_id, can_see, can_post, can_manage").eq("company_id", companyId),
    db.from("chat_role_settings").select("role, role_id, color, show_separately, mentionable, own_crew_only").eq("company_id", companyId),
    db.from("company_roles").select("id, name, description, base_role").eq("company_id", companyId).order("name"),
    db.from("memberships").select("user_id, role, role_id").eq("company_id", companyId).eq("active", true).neq("role", "subcontractor"),
    db.from("crews").select("id, name").eq("company_id", companyId).eq("active", true).order("name"),
  ]);
  for (const r of [channels, rules, settings, roles, members, crews]) if (r.error) throw dbError(r.error);
  const people = members.data ?? [];
  const ids = people.map((m) => m.user_id);
  const profiles = ids.length ? must(await db.from("profiles").select("user_id, full_name, email, color, avatar_url").in("user_id", ids)) : [];
  const nameOf = new Map(profiles.map((p) => [p.user_id, { name: p.full_name || p.email || "Someone", color: p.color, photo: p.avatar_url }]));
  const peopleFor = (key: string) =>
    people.filter((m) => chatRoleKey(m.role, m.role_id) === key).map((m) => ({ id: m.user_id, ...(nameOf.get(m.user_id) ?? { name: "Someone", color: null, photo: null }) }));
  return c.json({
    channels: (channels.data ?? []).map((ch) => ({ ...ch, archived: Boolean(ch.archived_at) })),
    rules: rules.data ?? [],
    settings: settings.data ?? [],
    roles: [
      ...STAFF.map((level) => ({ key: level as string, label: ROLE_LABELS[level], custom: false, base_role: level, description: null as string | null, people: peopleFor(level) })),
      ...(roles.data ?? []).map((r) => ({ key: r.id, label: r.name, custom: true, base_role: r.base_role, description: r.description, people: peopleFor(r.id) })),
    ],
    crews: crews.data ?? [],
    colors: CHAT_COLORS,
  });
});

// The team's levels: team chat has no place for subs (the database refuses rules for them).
const roleRef = { role: z.enum(STAFF as [Role, ...Role[]]).nullable().optional(), role_id: uuid.nullable().optional() };
chat.put("/chat/settings/roles", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(
    c,
    z.object({
      settings: z.array(z.object({ ...roleRef, color: z.enum(CHAT_COLORS.map((x) => x.key) as [string, ...string[]]), show_separately: z.boolean(), mentionable: z.boolean(), own_crew_only: z.boolean() })).max(200),
      rules: z.array(z.object({ ...roleRef, channel_id: uuid, can_see: z.boolean(), can_post: z.boolean(), can_manage: z.boolean() })).max(20_000),
    }),
  );
  const refOk = (r: { role?: string | null; role_id?: string | null }) => Boolean(r.role) !== Boolean(r.role_id);
  if (!body.settings.every(refOk) || !body.rules.every(refOk)) throw new HttpError(400, "Each rule needs one role.");
  const { db, companyId } = c.var;
  const { error } = await db.rpc("chat_save_roles", { p_company: companyId, p_settings: body.settings as never, p_rules: body.rules.filter((r) => r.role !== "owner") as never });
  if (error) throw chatDbError(error);
  forgetAudiences();
  toCompany(companyId, { type: "channels" });
  return c.json({ ok: true });
});

chat.post("/chat/settings/channels", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1, "Give the channel a name.").max(50, "Keep the name under 50 characters."),
      preset: z.enum(["everyone", "announcement", "office", "crew"]),
      category: z.string().trim().max(40).optional(),
      topic: z.string().trim().max(300).optional(),
      crew_id: uuid.nullable().optional(),
    }),
  );
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.rpc("chat_create_channel", {
    p_company: companyId,
    p_name: body.name,
    p_preset: body.preset,
    p_category: body.category ?? undefined,
    p_topic: body.topic ?? undefined,
    p_crew: body.crew_id ?? undefined,
  });
  if (error) throw error.code === "23505" ? new HttpError(409, "There's already a channel with that name.") : chatDbError(error);
  forgetAudiences();
  toCompany(companyId, { type: "channels" });
  return c.json({ id: data }, 201);
});

chat.patch("/chat/settings/channels/:id", requireUser, requireCompany(ADMINS), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(50).optional(),
      category: z.string().trim().min(1).max(40).optional(),
      topic: z.string().trim().max(300).nullable().optional(),
      position: z.number().int().min(0).max(100_000).optional(),
      archived: z.boolean().optional(),
    }),
  );
  const { db, companyId } = c.var;
  await requireOn(c);
  const current = must(await db.from("chat_channels").select("kind").eq("id", id).eq("company_id", companyId).maybeSingle(), "That channel isn't here anymore.");
  const patch: TablesUpdate<"chat_channels"> = {};
  if (body.name !== undefined) patch.name = current.kind === "announcement" ? body.name : channelSlug(body.name);
  if (body.category !== undefined) patch.category = body.category;
  if (body.topic !== undefined) patch.topic = body.topic || null;
  if (body.position !== undefined) patch.position = body.position;
  if (body.archived !== undefined) patch.archived_at = body.archived ? new Date().toISOString() : null;
  if (!Object.keys(patch).length) return c.json({ ok: true });
  const { error } = await db.from("chat_channels").update(patch).eq("id", id);
  if (error) throw error.code === "23505" ? new HttpError(409, "There's already a channel with that name.") : chatDbError(error);
  forgetAudiences();
  toCompany(companyId, { type: "channels" });
  return c.json({ ok: true });
});
