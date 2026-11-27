/** Messages' list of conversations, and which of them wait on the office (features/messages/conversations.ts). */
import { describe, expect, it } from "vitest";
import { conversationsFrom, rowWaits, waitingByClient } from "../src/features/messages/conversations";

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

describe("whether a row's conversation waits on the office", () => {
  // Sam's text is unanswered. Pat's text and email were answered by the 3pm text. Flo was emailed a quote, then texted back.
  const waiting = waitingByClient([msg("m7", "flo", "in", "2026-11-27T16:00:00Z"), msg("m4", "sam", "in", "2026-11-27T14:00:00Z")]);
  const floEmail = msg("m6", "flo", "out", "2026-11-27T12:00:00Z", "email");

  it("is decided by the whole conversation under From clients: one answered since doesn't wait", () => {
    const fromClients = conversationsFrom(newest.filter((m) => m.direction === "in"), null, ALL);
    expect(fromClients.map((c) => [c.client!.id, c.id, rowWaits(c, waiting, undefined)])).toEqual([["sam", "m4", true], ["pat", "m3", false]]);
  });

  it("and under a channel's tab: an email answered by text doesn't wait, and an email we sent does once they text back", () => {
    const emails = conversationsFrom([floEmail, ...newest].filter((m) => m.channel === "email"), null, ["email"]);
    expect(emails.map((c) => [c.client!.id, c.id, rowWaits(c, waiting, undefined)])).toEqual([["flo", "m6", true], ["pat", "m2", false]]);
  });

  it("stops the moment it's marked done, and starts again when the mark comes off", () => {
    const sam = conversationsFrom(newest, null, ALL)[1]!;
    expect(rowWaits(sam, waiting, "2026-11-27T14:05:00Z")).toBe(false);
    expect(rowWaits(sam, waiting, "2026-11-27T13:00:00Z")).toBe(true);
    expect(rowWaits(sam, waiting, undefined)).toBe(true);
  });

  it("goes by the row's own message for someone who isn't given what waits", () => {
    const [pat, sam] = conversationsFrom(newest, null, ALL);
    expect(waitingByClient(null)).toBeNull();
    expect([rowWaits(pat!, null, undefined), rowWaits(sam!, null, undefined)]).toEqual([false, true]);
  });
});
