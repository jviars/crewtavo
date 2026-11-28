/**
 * Reactions (src/chatEmoji.ts): the curated emoji, finding them in the picker, the quick reactions
 * first, and the database allowing exactly the same emoji (private.chat_reaction_emoji()).
 */
import { describe, expect, it } from "vitest";
import { sqlFunction } from "../../../scripts/i18n.mjs";
import { CHAT_EMOJI, CHAT_EMOJI_GROUPS, findEmoji, isReactionKind, orderReactions, reactionKind, rememberEmoji } from "../src/chatEmoji";

describe("the emoji people react with", () => {
  it("are a few hundred common ones, each once, in every group", () => {
    expect(CHAT_EMOJI.length).toBeGreaterThanOrEqual(300);
    expect(CHAT_EMOJI.length).toBeLessThanOrEqual(500);
    expect(new Set(CHAT_EMOJI.map((e) => e.emoji)).size).toBe(CHAT_EMOJI.length);
    for (const group of CHAT_EMOJI_GROUPS) expect(CHAT_EMOJI.filter((e) => e.group === group.key).length, group.key).toBeGreaterThan(20);
    for (const e of CHAT_EMOJI) {
      expect(e.emoji, e.words).not.toMatch(/\s|[a-z]/i);
      expect(e.words.trim().length, e.emoji).toBeGreaterThan(1);
    }
  });

  it("are the ones the database allows", () => {
    const sql = sqlFunction("private.chat_reaction_emoji");
    const listed = [...sql.slice(sql.indexOf("array[")).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed).toEqual(CHAT_EMOJI.map((e) => e.emoji));
  });

  it("are found by the start of any of their words", () => {
    expect(findEmoji("thumb").map((e) => e.emoji)).toEqual(["👍", "👎"]);
    expect(findEmoji("TRUCK").map((e) => e.emoji)).toEqual(expect.arrayContaining(["🛻", "🚚", "🚛", "🚒"]));
    expect(findEmoji("fire truck").map((e) => e.emoji)).toEqual(["🚒"]);
    expect(findEmoji("🔥").map((e) => e.emoji)).toEqual(["🔥"]);
    expect(findEmoji("zzzzzz")).toEqual([]);
    expect(findEmoji("  ").length).toBe(CHAT_EMOJI.length);
  });

  it("make thumbs up the quick reaction, and allow only listed ones", () => {
    expect(reactionKind("👍")).toBe("thumbs_up");
    expect(reactionKind("🔥")).toBe("🔥");
    expect(isReactionKind("on_it")).toBe(true);
    expect(isReactionKind("🔥")).toBe(true);
    expect(isReactionKind("👍")).toBe(false);
    expect(isReactionKind("🦄")).toBe(false);
    expect(isReactionKind("hello")).toBe(false);
    expect(isReactionKind(3)).toBe(false);
  });

  it("show the quick reactions first, then the rest as they came", () => {
    const groups = [{ kind: "🔥" }, { kind: "seen" }, { kind: "🎉" }, { kind: "thumbs_up" }];
    expect(orderReactions(groups).map((g) => g.kind)).toEqual(["thumbs_up", "seen", "🔥", "🎉"]);
  });

  it("remember the latest picked first, each once", () => {
    expect(rememberEmoji(["🔥", "🎉"], "🎉")).toEqual(["🎉", "🔥"]);
    expect(rememberEmoji(["🦄", "🔥"], "✅")).toEqual(["✅", "🔥"]);
    expect(rememberEmoji(["🔥", "🎉", "💯", "✨"], "✅", 3)).toEqual(["✅", "🔥", "🎉"]);
    expect(rememberEmoji(["🔥", "🔥", "🎉"], "✅")).toEqual(["✅", "🔥", "🎉"]);
  });
});
