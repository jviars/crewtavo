import { presetSummaries } from "@crewtavo/core/presets";
import { describe, expect, it } from "vitest";
import { searchTrades } from "@/features/auth/OnboardingPage";

describe("searching trades at sign-up", () => {
  const trades = presetSummaries();
  const ids = (query: string) => searchTrades(trades, query).map((t) => t.id);

  it("finds a trade by what people call themselves", () => {
    expect(ids("plumber")).toEqual(["plumbing"]);
    expect(ids("Electrician")).toEqual(["electrical"]);
    expect(ids("hvac")).toEqual(["hvac"]);
    expect(ids("pest")).toEqual(["pest_control"]);
    expect(ids("landscaper")).toEqual(["landscaping"]);
  });

  it("keeps the trades that match the most words", () => {
    expect(ids("pool cleaning")).toEqual(["pool_service"]);
    expect(ids("maid service")).toEqual(["cleaning"]);
    expect(ids("lawn care")).toContain("lawn_exterior");
  });

  it("keeps them all with nothing typed, and none when nothing matches", () => {
    expect(ids("  ")).toEqual(trades.map((t) => t.id));
    expect(ids("xylophone tuning")).toEqual([]);
  });
});
