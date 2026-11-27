/**
 * Messages' list of conversations: one row a client, from their latest message. The list reads the
 * newest 500 messages only, so a conversation that still waits on the office (done.ts) is added when
 * its latest message is older than those, from what the database says waits
 * (waiting_conversation_messages, 20261127100100): whatever the Messages dot counts has a row here,
 * with its Done button.
 */
export interface ListedMessage {
  channel: string;
  direction: string;
  created_at: string;
  client: { id: string; display_name: string } | null;
}

/** The latest message is the client's, and came after the conversation was last marked done. */
export const isWaiting = (latest: { direction: string; created_at: string }, doneAt: string | undefined) =>
  latest.direction === "in" && (!doneAt || Date.parse(doneAt) < Date.parse(latest.created_at));

/** Each waiting conversation's latest message by its client; null for someone who isn't given them (they don't answer messages). */
export const waitingByClient = <M extends ListedMessage>(waiting: readonly M[] | null | undefined): ReadonlyMap<string, M> | null =>
  waiting ? new Map(waiting.flatMap((m) => (m.client ? [[m.client.id, m] as const] : []))) : null;

/**
 * Whether a row's conversation waits on the office. The conversation as a whole decides, by its
 * latest message of any kind (`waiting`), not the row's own: under From clients or a channel's tab
 * the row shows the latest of those only, and a text answered by email since isn't waiting. The
 * row's own message decides only for someone who isn't given what waits.
 */
export function rowWaits(row: ListedMessage, waiting: ReadonlyMap<string, ListedMessage> | null, doneAt: string | undefined): boolean {
  const latest = waiting ? row.client && waiting.get(row.client.id) : row;
  return Boolean(latest && isWaiting(latest, doneAt));
}

/**
 * From messages newest first: each client's latest, with how many of theirs were read. `waiting` is
 * each waiting conversation's latest message; `channels` are the ones the tab shows.
 */
export function conversationsFrom<M extends ListedMessage>(messages: readonly M[], waiting: readonly M[] | null | undefined, channels: readonly string[]): (M & { count: number })[] {
  const seen = new Map<string, M & { count: number }>();
  for (const m of messages) {
    if (!m.client) continue;
    const existing = seen.get(m.client.id);
    if (existing) existing.count++;
    else seen.set(m.client.id, { ...m, count: 1 });
  }
  const read = seen.size;
  for (const m of waiting ?? []) {
    if (m.client && !seen.has(m.client.id) && channels.includes(m.channel)) seen.set(m.client.id, { ...m, count: 1 });
  }
  const rows = [...seen.values()];
  // Those added are nearly always older than everything read, and so already in their place.
  return rows.length > read ? rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)) : rows;
}
