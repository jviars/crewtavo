/**
 * The demo's guided tour (features/demo/Tour.tsx): the same for every trade, pointing to Apps for
 * what's a trade's own, and each step at something the app has.
 */
import { describe, expect, it } from "vitest";
import { tourSteps } from "../src/features/demo/Tour";

describe("the demo's tour", () => {
  it("welcomes the visitor by their business, and ends on getting Crewtavo", () => {
    const tour = tourSteps("Greenway Lawn Care");
    expect(tour[0]!.title).toBe("Welcome to Greenway Lawn Care");
    expect(tour.at(-1)!.target).toBe('[data-tour="get"]');
  });

  it("is the same for every trade, and sends a trade's own to Apps", () => {
    const tour = tourSteps("x");
    const apps = tour.find((s) => s.to === "/apps");
    expect(apps?.target).toBe('a[href="/apps"]');
    expect(apps?.body).toMatch(/snow removal, paving takeoffs, roofing/);
    expect(tour.some((s) => s.to === "/snow")).toBe(false);
  });

  it("points at the crew's phone and the client's view in the demo bar", () => {
    const targets = tourSteps("x").map((s) => s.target);
    expect(targets).toContain('[data-tour="crew"]');
    expect(targets).toContain('[data-tour="client"]');
  });
});

describe("the demo in Spanish", () => {
  it("knows every trade the start screen lists, by the server's own words", async () => {
    const { presetSummaries } = await import("@crewtavo/core");
    const { PRESET_TEXT } = await import("../src/features/demo/Demo");
    expect([...PRESET_TEXT].sort()).toEqual(presetSummaries().flatMap((p) => [p.name, p.description]).sort());
  });

  it("shows every featured trade with its own photo and what its sample business has in it", async () => {
    const { DEMO_TRADES } = await import("@crewtavo/core");
    const { INSIDE, PHOTOS } = await import("../src/features/demo/Demo");
    for (const trade of DEMO_TRADES) {
      expect(PHOTOS[trade.preset], trade.preset).toBeDefined();
      expect(INSIDE[trade.preset]?.length, trade.preset).toBeGreaterThan(3);
    }
    expect(INSIDE.general?.length).toBeGreaterThan(3);
  });

  it("speaks Spanish on its start screen, bar and tour", async () => {
    const { installSpanish } = await import("@crewtavo/core/i18n/es");
    const { setLocale, t } = await import("@crewtavo/core/i18n");
    installSpanish();
    setLocale("es");
    try {
      expect(t("Try Crewtavo")).toBe("Prueba Crewtavo");
      expect(t("Lawn care")).toBe("Cuidado de césped");
      expect(t("What kind of work do you do?")).toBe("¿Qué tipo de trabajo haces?");
      expect(t("Something else", { context: "Your trade" })).toBe("Otro oficio");
      expect(t("Setting up your {trade} business", { trade: t("Lawn care").toLowerCase() })).toBe("Preparando tu negocio de cuidado de césped");
      expect(tourSteps("Greenway Lawn Care")[0]!.title).toBe("Bienvenido a Greenway Lawn Care");
    } finally {
      setLocale("en");
    }
  });
});
