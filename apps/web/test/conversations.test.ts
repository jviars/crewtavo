/** Messages' list of conversations, and which of them wait on the office (features/messages/conversations.ts). */
import { describe, expect, it } from "vitest";
import { conversationsFrom } from "../src/features/messages/conversations";

const msg = (id: string, client: string, direction: string, created_at: string, channel = "sms") => ({ id, channel, direction, created_at, body: id, client: { id: client, display_name: client } });
const ALL = ["sms", "email", "note", "call"];
// As the database sends them: newest first.
const newest = [
  msg("m5", "pat", "out", "2026-11-27T15:00:00Z"),
  msg("m4", "sam", "in", "2026-11-27T14:00:00Z"),
  msg("m3", "pat", "in", "2026-11-27T13:00:00Z"),
  msg("m2", "pat", "in", "2026-11-26T09:00:00Z", "email"),
];

describe("Messages' conversations", () => {
  it("are one row a client, from their latest message, with how many they have", () => {
    expect(conversationsFrom(newest, null, ALL).map((c) => [c.client!.id, c.id, c.count])).toEqual([["pat", "m5", 3], ["sam", "m4", 1]]);
    expect(conversationsFrom([], null, ALL)).toEqual([]);
  });

  it("include a conversation that still waits when its latest message is older than the messages read", () => {
    // Ada wrote three weeks ago and nobody answered; hundreds of messages have come and gone since.
    const waiting = [msg("m4", "sam", "in", "2026-11-27T14:00:00Z"), msg("m1", "ada", "in", "2026-11-06T10:00:00Z")];
    expect(conversationsFrom(newest, waiting, ALL).map((c) => [c.client!.id, c.id, c.count])).toEqual([["pat", "m5", 3], ["sam", "m4", 1], ["ada", "m1", 1]]);
  });

  it("put one in its place by its time, should it be newer than what was read", () => {
    const waiting = [msg("m6", "bo", "in", "2026-11-27T14:30:00Z")];
    expect(conversationsFrom(newest, waiting, ALL).map((c) => c.client!.id)).toEqual(["pat", "bo", "sam"]);
  });

  it("add it under a channel's tab only when its latest message is that channel's", () => {
    const waiting = [msg("m1", "ada", "in", "2026-11-06T10:00:00Z"), msg("m0", "cy", "in", "2026-11-05T10:00:00Z", "email")];
    const emails = newest.filter((m) => m.channel === "email");
    expect(conversationsFrom(emails, waiting, ["email"]).map((c) => c.client!.id)).toEqual(["pat", "cy"]);
  });
});
