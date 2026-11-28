/**
 * Who a message went to and who a text came from, in words, for the client's timeline and Messages.
 * A send to the client and their contacts is one message (messages.recipients lists who got it), so
 * it reads as one line, "to Ana Smith, Bo Lee and 2 others", with every address behind it.
 */
import { recipientNames } from "@crewtavo/core/recipients";

interface Person {
  to: string;
  name?: string | null;
  failed?: boolean;
  /** Why it didn't reach them, when the text provider said afterwards. */
  reason?: unknown;
}

const people = (value: unknown): Person[] =>
  Array.isArray(value) ? value.filter((p): p is Person => Boolean(p) && typeof p === "object" && typeof (p as Person).to === "string" && (p as Person).to.trim() !== "") : [];

/** A name with its address when they differ: "Bo Lee (bo@example.com)". */
const full = (p: Person) => (p.name?.trim() && p.name.trim() !== p.to ? `${p.name.trim()} (${p.to})` : p.to);

export interface MessagePeople {
  /** "Ana Smith and Bo Lee": who it reached. Null when that wasn't recorded (older messages, notes). */
  to: string | null;
  /** Everyone it reached with their addresses, one to a line, for a tooltip. */
  toFull: string | null;
  /** "bo@example.com": who it didn't reach, when it reached someone else. */
  missed: string | null;
  /** "Their phone is off or out of reach (Twilio error 30003).": why it didn't arrive, when the text provider said. */
  why: string | null;
}

export function messagePeople(message: { direction: string; recipients?: unknown }): MessagePeople {
  const all = message.direction === "out" ? people(message.recipients) : [];
  const went = all.filter((p) => !p.failed);
  const failed = all.filter((p) => p.failed);
  return {
    to: went.length ? recipientNames(went) : null,
    toFull: went.length ? went.map(full).join("\n") : null,
    // A send that reached nobody shows as not delivered already.
    missed: went.length && failed.length ? failed.map((p) => p.to).join(", ") : null,
    why: [...new Set(failed.map((p) => p.reason).filter((reason): reason is string => typeof reason === "string" && reason.trim() !== ""))].join(" ") || null,
  };
}

/** "Bo Lee" for a text that came in from a contact's phone rather than the client's own. */
export const messageFrom = (message: { direction: string; from_name?: string | null }) => (message.direction === "in" ? message.from_name?.trim() || null : null);
