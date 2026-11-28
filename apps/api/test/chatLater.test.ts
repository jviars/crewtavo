/**
 * Team chat's minute (services/chatLater.ts): what the database sent is published live to the
 * channel and each author's tabs hear their list changed; what it dropped isn't published; due
 * reminders tell their person's tabs. The service-role client is a stand-in: the database's own
 * part (who may send, as whom) is in supabase/tests/chat_field_test.sql.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetHub, subscribe, type ChatEvent } from "../src/lib/chatHub";
import type { Env } from "../src/env";

const db = vi.hoisted(() => ({
  due: [] as Array<Record<string, unknown>>,
  reminders: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
}));

vi.mock("../src/lib/supabase", () => {
  const table = (rows: () => Array<Record<string, unknown>>) => {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const out = () => rows().filter((r) => filters.every((f) => f(r)));
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), builder),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), builder),
      maybeSingle: async () => ({ data: out()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: out(), error: null }).then(resolve),
    };
    return builder;
  };
  const client = {
    rpc: async (fn: string) => {
      if (fn === "chat_send_due") return { data: db.due, error: null };
      if (fn === "chat_send_due_reminders") return { data: db.reminders, error: null };
      if (fn === "chat_audience") return { data: ["dana", "nia"], error: null };
      return { data: null, error: null };
    },
    from: (name: string) => table(() => (name === "chat_messages" ? db.messages : [])),
  };
  return { adminClient: () => client };
});

const { sendDueChat } = await import("../src/services/chatLater");

afterEach(() => resetHub());

describe("the minute that sends Team chat messages later", () => {
  it("publishes what was sent to the channel, and tells each author's tabs their list changed", async () => {
    db.messages = [{ id: "m1", channel_id: "general", author_id: "nia", body: "Truck leaves at 6", attachments: [], job_id: null, reply_to: null, mention_users: [], mention_roles: [], mention_all: false, pinned_at: null, pinned_by: null, edited_at: null, deleted_at: null, created_at: "2026-11-29T12:30:00Z" }];
    db.due = [
      { scheduled_id: "m1", company_id: "fern", channel_id: "general", author_id: "nia", message_id: "m1", problem: null },
      { scheduled_id: "m2", company_id: "fern", channel_id: "general", author_id: "sid", message_id: null, problem: "You can't post in #general any more." },
    ];
    db.reminders = [{ reminder_id: "r1", company_id: "fern", user_id: "dana", told: true }];
    const got: Record<string, ChatEvent[]> = { dana: [], nia: [], sid: [] };
    for (const who of Object.keys(got)) subscribe("fern", who, (e) => got[who]!.push(e));

    expect(await sendDueChat({} as Env)).toEqual({ sent: 1, dropped: 1, reminded: 1 });
    expect(got.dana.filter((e) => e.type === "message")).toMatchObject([{ channel_id: "general", message: { id: "m1", body: "Truck leaves at 6" } }]);
    expect(got.sid.filter((e) => e.type === "message")).toEqual([]);
    expect(got.nia.filter((e) => e.type === "scheduled")).toEqual([{ type: "scheduled", channel_id: "general" }]);
    expect(got.sid.filter((e) => e.type === "scheduled")).toEqual([{ type: "scheduled", channel_id: "general" }]);
    expect(got.dana.filter((e) => e.type === "reminders")).toEqual([{ type: "reminders" }]);
    expect(got.nia.filter((e) => e.type === "reminders")).toEqual([]);
  });
});
