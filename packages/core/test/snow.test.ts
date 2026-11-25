import { describe, expect, it } from "vitest";
import { notificationTopic } from "../src/notifications";
import { clockText, iceNotices, iceRisk, snowBands, snowNotices, snowPlan, snowTierPrice, standardTiers, type SnowSite } from "../src/snow";
import { weatherSourceOf } from "../src/weather";

describe("snowPlan", () => {
  const lot = { trigger_in: 2, salt_trigger_in: 0.5, repeat_in: 3 };
  it("plows at the trigger, and again for every repeat past it", () => {
    expect(snowPlan(lot, 2)).toEqual({ kind: "plow", pushes: 1 });
    expect(snowPlan(lot, 4.9)).toEqual({ kind: "plow", pushes: 1 });
    expect(snowPlan(lot, 5)).toEqual({ kind: "plow", pushes: 2 });
    expect(snowPlan(lot, 8)).toEqual({ kind: "plow", pushes: 3 });
    expect(snowPlan({ trigger_in: 2 }, 30)).toEqual({ kind: "plow", pushes: 1 });
    expect(snowPlan({ trigger_in: 1, repeat_in: 1 }, 40)?.pushes).toBe(6);
  });
  it("salts under the plow trigger for a salting customer, and does nothing under both", () => {
    expect(snowPlan(lot, 0.6)).toEqual({ kind: "salt", pushes: 1 });
    expect(snowPlan(lot, 0.4)).toBeNull();
    expect(snowPlan({ trigger_in: 2 }, 1.9)).toBeNull();
    expect(snowPlan(lot, null)).toBeNull();
  });
});

describe("snowTierPrice", () => {
  const tiers = [{ up_to_in: null, price: 140 }, { up_to_in: 4, price: 75 }, { up_to_in: 8, price: 110 }];
  it("is the first tier the storm fits under, the open one past the rest", () => {
    expect([1, 4, 4.1, 8, 20].map((d) => snowTierPrice(tiers, d))).toEqual([75, 75, 110, 110, 140]);
    expect(snowTierPrice([{ up_to_in: 4, price: 75 }, { up_to_in: 8, price: 110 }], 12)).toBe(110);
    expect(snowTierPrice([], 5)).toBeNull();
  });
});

const plaza: SnowSite = { name: "Maple Plaza – 1 Maple Way", trigger_in: 2, snow_in: 8.04, plan: { kind: "plow", pushes: 3 }, clear_by: "07:00:00", priority: 1, people: ["lena", "cole"] };
const drive: SnowSite = { name: "Ann Lee – 9 Oak St", trigger_in: 1, snow_in: 9, plan: { kind: "plow", pushes: 1 }, people: ["cole", "sam"] };
const bank: SnowSite = { name: "First Bank", trigger_in: 2, snow_in: 0.6, plan: { kind: "salt", pushes: 1 }, people: ["sam"] };

describe("snowNotices", () => {
  it("tells each person about their sites, first priority first, and asks the subs whether they can go out", () => {
    const notices = snowNotices([drive, bank, plaza], ["otto"], ["sam"]);
    const of = (id: string) => notices.find((n) => n.user_id === id);
    expect(notices.map((n) => n.user_id).sort()).toEqual(["cole", "lena", "otto", "sam"]);
    expect(of("lena")).toEqual({
      user_id: "lena", office: false, title: "Snow by tomorrow at Maple Plaza – 1 Maple Way: 8 in forecast",
      body: "Maple Plaza – 1 Maple Way: 8 in from 6pm tonight through tomorrow, trigger 2 in, 3 pushes, clear by 7 AM",
    });
    expect(of("cole")!.title).toBe("Snow by tomorrow: 2 properties to service");
    expect(of("cole")!.body.split("\n").map((l) => l.split(":")[0])).toEqual(["Maple Plaza – 1 Maple Way", "Ann Lee – 9 Oak St"]);
    expect(of("sam")!.body).toContain("First Bank: 0.6 in from 6pm tonight through tomorrow, salt only (it plows at 2 in)");
    // Sam is a sub, so he's the one asked; nobody is, when no one's named.
    expect(of("sam")!.body.split("\n").at(-1)).toBe("Can you go out? Say yes or no on My day.");
    expect(snowNotices([drive], []).some((n) => n.body.includes("Can you go out"))).toBe(false);
  });
  it("tells the office about all of them, without asking, and a salt run is called one", () => {
    const office = snowNotices([drive, bank, plaza], ["otto"]).find((n) => n.user_id === "otto")!;
    expect([office.office, office.title, office.body.split("\n").length]).toEqual([true, "Snow by tomorrow: 3 properties to service", 3]);
    expect(snowNotices([bank], [])[0]!.title).toBe("Salt run by tomorrow at First Bank: 0.6 in forecast");
    expect(snowNotices([], ["otto"])).toEqual([]);
  });
  it("words a storm that's here today as today's, counted from the evening before", () => {
    const notices = snowNotices([plaza, bank], ["otto"], ["sam"], "today");
    const of = (id: string) => notices.find((n) => n.user_id === id)!;
    expect([of("lena").title, of("lena").body]).toEqual(["Snow today at Maple Plaza – 1 Maple Way: 8 in", "Maple Plaza – 1 Maple Way: 8 in today, counted from 6pm last night, trigger 2 in, 3 pushes, clear by 7 AM"]);
    expect([of("sam").title, of("sam").body.split("\n").at(-1)]).toEqual(["Salt run today at First Bank: 0.6 in", "Can you go out? Say yes or no on My day."]);
    expect(of("otto").title).toBe("Snow today: 2 properties to service");
  });
  it("keeps a long storm to 30 lines, and goes out as schedule news", () => {
    const many = Array.from({ length: 32 }, (_, i) => ({ ...drive, name: `Site ${i}`, people: [] }));
    const body = snowNotices(many, ["otto"])[0]!.body.split("\n");
    expect([body.length, body[30]]).toEqual([31, "and 2 more"]);
    expect(notificationTopic("snow")).toBe("schedule");
  });
});

describe("ice", () => {
  const hour = (time: string, temp_f: number, sky: "clear" | "rain" | "snow" | "freezing_rain" = "clear", snow_in = 0) => ({ time, temp_f, sky, snow_in });
  const from = "2026-01-15T18:00";
  const to = "2026-01-17T00:00";
  it("is freezing rain in the window", () => {
    expect(iceRisk([hour("2026-01-15T12:00", 30, "freezing_rain"), hour("2026-01-16T03:00", 31, "freezing_rain")], from, to)).toEqual({ kind: "ice", at: "2026-01-16T03:00" });
  });
  it("is wet pavement that then freezes: rain above freezing, or snow that melts as it lands", () => {
    expect(iceRisk([hour("2026-01-15T19:00", 38, "rain"), hour("2026-01-15T23:00", 33), hour("2026-01-16T02:00", 29), hour("2026-01-16T05:00", 24)], from, to)).toEqual({ kind: "refreeze", at: "2026-01-16T02:00", low_f: 24 });
    expect(iceRisk([hour("2026-01-15T20:00", 35, "snow", 0.3), hour("2026-01-16T04:00", 28)], from, to)?.kind).toBe("refreeze");
  });
  it("isn't a cold dry night, rain that stays above freezing, or anything outside the window", () => {
    expect(iceRisk([hour("2026-01-15T19:00", 40), hour("2026-01-16T04:00", 12)], from, to)).toBeNull();
    expect(iceRisk([hour("2026-01-15T19:00", 40, "rain"), hour("2026-01-16T04:00", 34)], from, to)).toBeNull();
    expect(iceRisk([hour("2026-01-15T12:00", 40, "rain"), hour("2026-01-15T16:00", 20)], from, to)).toBeNull();
  });
  it("is told to the salting customers' people and the office", () => {
    const notices = iceNotices([{ name: "First Bank", risk: { kind: "refreeze", at: "2026-01-16T02:00", low_f: 24 }, people: ["sam"] }, { name: "Maple Plaza", risk: { kind: "ice", at: "2026-01-15T22:00" }, people: ["sam"], priority: 1 }], ["otto"], from);
    expect(notices.find((n) => n.user_id === "sam")).toEqual({ user_id: "sam", office: false, title: "Ice by tomorrow: 2 properties to salt", body: "Maple Plaza: freezing rain around 10 PM tonight\nFirst Bank: wet, then 24° by 2 AM tomorrow: it will refreeze" });
    expect(iceNotices([{ name: "First Bank", risk: { kind: "ice", at: "2026-01-16T03:00" }, people: [] }], ["otto"], from)[0]!.title).toBe("Freezing rain by tomorrow at First Bank");
  });
});

describe("the standard storm prices", () => {
  it("reads the saved bands shallowest first, the open one last, and leaves out what isn't one", () => {
    expect(snowBands([{ up_to_in: null, times: 2 }, { up_to_in: 6, times: 1.5 }, { times: 0 }, "x", null, { up_to_in: 3, times: 1 }])).toEqual([{ up_to_in: 3, times: 1 }, { up_to_in: 6, times: 1.5 }, { up_to_in: null, times: 2 }]);
    expect(snowBands(undefined)).toEqual([]);
  });
  it("prices a customer's storms as multiples of their push price, to the cent", () => {
    const tiers = standardTiers(snowBands([{ up_to_in: 3, times: 1 }, { up_to_in: 6, times: 1.5 }, { up_to_in: null, times: 2 }]), 72.25);
    expect(tiers).toEqual([{ up_to_in: 3, price: 72.25 }, { up_to_in: 6, price: 108.38 }, { up_to_in: null, price: 144.5 }]);
    expect([2, 5, 14].map((depth) => snowTierPrice(tiers, depth))).toEqual([72.25, 108.38, 144.5]);
  });
});

describe("words and sources", () => {
  it("writes a time of day the way people say it", () => {
    expect(["07:00:00", "13:30", "00:00", "12:05:00"].map((time) => clockText(time))).toEqual(["7 AM", "1:30 PM", "12 AM", "12:05 PM"]);
  });
  it("writes it the way the business's country keeps time, a US business's as it always was", () => {
    const times = ["07:00:00", "13:30", "00:00", "12:05:00"];
    expect(times.map((time) => clockText(time, "US"))).toEqual(["7 AM", "1:30 PM", "12 AM", "12:05 PM"]);
    expect(times.map((time) => clockText(time, "CA"))).toEqual(["7 a.m.", "1:30 p.m.", "12 a.m.", "12:05 p.m."]);
    expect(times.map((time) => clockText(time, "AU"))).toEqual(["7 am", "1:30 pm", "12 am", "12:05 pm"]);
    expect(times.map((time) => clockText(time, "GB"))).toEqual(["07:00", "13:30", "00:00", "12:05"]);
    expect(snowNotices([plaza], [], [], "tomorrow", "GB")[0]!.body).toBe("Maple Plaza – 1 Maple Way: 8 in from 6pm tonight through tomorrow, trigger 2 in, 3 pushes, clear by 07:00");
    expect(iceNotices([{ name: "First Bank", risk: { kind: "ice", at: "2026-01-15T22:00" }, people: ["sam"] }], [], "2026-01-15T18:00", "GB")[0]!.body).toBe("First Bank: freezing rain around 22:00 tonight");
  });
  it("starts every business on the National Weather Service", () => {
    expect([weatherSourceOf(null), weatherSourceOf({ weather_source: "open_meteo" }), weatherSourceOf({ weather_source: "made-up" })]).toEqual(["nws", "open_meteo", "nws"]);
  });
});
