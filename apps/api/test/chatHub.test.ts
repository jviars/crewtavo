import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetAudiences, onlineUsers, resetHub, subscribe, toChannel, toCompany, toUser, type ChatEvent } from "../src/lib/chatHub";
import type { Db } from "../src/lib/supabase";

// The service-role client, answering "who can see this channel?" the way public.chat_audience does.
function admin(audience: Record<string, string[]>) {
  const rpc = vi.fn(async (_fn: string, args: { p_channel: string }) => ({ data: audience[args.p_channel] ?? [], error: null }));
  return { client: { rpc } as unknown as Db, rpc };
}

const message = (channel: string): ChatEvent => ({ type: "message", channel_id: channel, message: { id: "m1" } });

afterEach(() => resetHub());

describe("live team chat", () => {
  it("sends a channel's messages only to people who can see it, in that company", async () => {
    const got: Record<string, ChatEvent[]> = { tyler: [], ben: [], other: [] };
    subscribe("kilo", "tyler", (e) => got.tyler.push(e));
    subscribe("kilo", "ben", (e) => got.ben.push(e));
    subscribe("lima", "tyler", (e) => got.other.push(e));
    const { client } = admin({ north: ["tyler", "marcus"] });
    await toChannel(client, "kilo", "north", message("north"));
    expect(got.tyler.filter((e) => e.type === "message")).toHaveLength(1);
    expect(got.ben.filter((e) => e.type === "message")).toHaveLength(0);
    expect(got.other.filter((e) => e.type === "message")).toHaveLength(0);
  });

  it("leaves out whoever is typing", async () => {
    const got: ChatEvent[] = [];
    subscribe("kilo", "tyler", (e) => got.push(e));
    const { client } = admin({ north: ["tyler"] });
    await toChannel(client, "kilo", "north", { type: "typing", channel_id: "north", user_id: "tyler", name: "Tyler" }, { except: "tyler" });
    expect(got.filter((e) => e.type === "typing")).toHaveLength(0);
  });

  it("asks the database once for a burst, and again after roles change", async () => {
    subscribe("kilo", "tyler", () => undefined);
    const { client, rpc } = admin({ north: ["tyler"] });
    await toChannel(client, "kilo", "north", message("north"));
    await toChannel(client, "kilo", "north", message("north"));
    expect(rpc).toHaveBeenCalledTimes(1);
    forgetAudiences();
    await toChannel(client, "kilo", "north", message("north"));
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("doesn't ask at all when nobody in the company is connected", async () => {
    const { client, rpc } = admin({ north: ["tyler"] });
    await toChannel(client, "kilo", "north", message("north"));
    expect(rpc).not.toHaveBeenCalled();
  });

  it("tells the company who's online as people come and go, once per person", () => {
    const seen: string[][] = [];
    subscribe("kilo", "dana", (e) => e.type === "presence" && seen.push(e.online));
    const tylerTab1 = subscribe("kilo", "tyler", () => undefined);
    const tylerTab2 = subscribe("kilo", "tyler", () => undefined);
    expect(onlineUsers("kilo").sort()).toEqual(["dana", "tyler"]);
    expect(seen).toEqual([["dana"], ["dana", "tyler"]]);
    tylerTab1();
    expect(seen).toHaveLength(2); // still online in the other tab
    tylerTab2();
    expect(seen).toHaveLength(3);
    expect(seen.at(-1)).toEqual(["dana"]);
    tylerTab2(); // stopping twice is harmless
    expect(onlineUsers("kilo")).toEqual(["dana"]);
  });

  it("sends company-wide and personal events to the right tabs, and survives a broken one", () => {
    const got: string[] = [];
    subscribe("kilo", "dana", () => {
      throw new Error("closed");
    });
    subscribe("kilo", "tyler", (e) => got.push(`tyler:${e.type}`));
    subscribe("kilo", "ben", (e) => got.push(`ben:${e.type}`));
    got.length = 0;
    toCompany("kilo", { type: "chat", enabled: false });
    toUser("kilo", "tyler", { type: "read", channel_id: "north" });
    expect(got).toEqual(["tyler:chat", "ben:chat", "tyler:read"]);
  });
});
