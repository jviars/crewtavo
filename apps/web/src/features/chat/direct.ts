/**
 * Direct conversations as the list and their screen name them: by the other people in them, "Marcus
 * Reyes" for two, "Marcus, Tyler and Sam" for a group. The server sends who's in each (channel.people)
 * and how each looks (state.people); here they become the channel's name, so everything that shows a
 * channel's name shows theirs.
 */
import type { ChatChannel, ChatPerson, ChatState } from "./data";
import { t } from "@/lib/i18n";

/** At most this many names, then "and 2 others". */
const NAMES = 3;

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** "Marcus Reyes"; "Marcus and Tyler"; "Marcus, Tyler and Sam"; "Marcus, Tyler, Sam and 2 others". */
export function directName(people: Array<Pick<ChatPerson, "name">>): string {
  if (!people.length) return t("Only you");
  if (people.length === 1) return people[0].name;
  // First names, unless two of them share one.
  const firsts = people.map((p) => firstName(p.name));
  const names = new Set(firsts).size === firsts.length ? firsts : people.map((p) => p.name);
  if (names.length <= NAMES) {
    return t("{names} and {last}", { names: names.slice(0, -1).join(", "), last: names[names.length - 1] });
  }
  const rest = names.length - NAMES;
  return t.plural(rest, { one: "{names} and {count} other", other: "{names} and {count} others" }, { names: names.slice(0, NAMES).join(", ") });
}

/** The people in a direct conversation besides me, as chat shows them. Someone no longer on the team still has a name. */
export function directPeople(channel: Pick<ChatChannel, "people">, people: Record<string, ChatPerson> | undefined): ChatPerson[] {
  return (channel.people ?? []).map((id) => people?.[id] ?? { id, name: t("Someone"), avatar_color: null, avatar_url: null, role_key: "", role_label: "", color: "default" });
}

/** The state with each direct conversation named by its people (useChatState's select). */
export function withDirectNames(state: ChatState): ChatState {
  if (!state.channels.some((c) => c.kind === "direct")) return state;
  return { ...state, channels: state.channels.map((c) => (c.kind === "direct" ? { ...c, name: directName(directPeople(c, state.people)) } : c)) };
}

/** Direct conversations for the list: closed ones left out (unless open now), the latest first. */
export function directList(channels: ChatChannel[], current: string | undefined): ChatChannel[] {
  const at = (c: ChatChannel) => c.last_message_at ?? c.created_at ?? "";
  return channels.filter((c) => c.kind === "direct" && (!c.closed || c.id === current)).sort((a, b) => at(b).localeCompare(at(a)));
}

/**
 * Under my latest message in a conversation: "Seen" once the other person has read past it, or in a
 * group "Seen by Marcus", "Seen by Marcus and Tyler", "Seen by everyone". Null while nobody has.
 */
export function seenText(readers: Array<Pick<ChatPerson, "name">>, others: number): string | null {
  if (!readers.length) return null;
  if (others <= 1) return t("Seen");
  if (readers.length >= others) return t("Seen by everyone");
  return t("Seen by {names}", { names: directName(readers) });
}

