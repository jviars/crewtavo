/**
 * Home's setup checklist (features/home/SetupCard.tsx): the price list counts as set up once it's
 * the business's own, and measuring is only offered for work priced by area or length.
 */
import { describe, expect, it } from "vitest";
import { priceListState, sendingSteps } from "../src/features/home/SetupCard";

const made = "2026-11-01T10:00:00.000+00:00";
const item = (unit: string, extra: Partial<{ formula: string | null; created_at: string; updated_at: string }> = {}) => ({
  unit, formula: null, created_at: "2026-11-01T10:00:01.000+00:00", updated_at: "2026-11-01T10:00:01.000+00:00", ...extra,
});

describe("the setup checklist's price list step", () => {
  it("waits while the price list is still the starter one", () => {
    expect(priceListState(made, [item("hr"), item("visit")]).prices).toBe(false);
    expect(priceListState(made, []).prices).toBe(false);
  });

  it("is done once an item is changed, or one is added later", () => {
    expect(priceListState(made, [item("hr", { updated_at: "2026-11-02T09:00:00.000+00:00" })]).prices).toBe(true);
    expect(priceListState(made, [item("ea", { created_at: "2026-11-03T09:00:00.000+00:00", updated_at: "2026-11-03T09:00:00.000+00:00" })]).prices).toBe(true);
  });

  it("offers measuring only when something is priced by area, length or a formula", () => {
    expect(priceListState(made, [item("hr"), item("ea"), item("visit")]).measures).toBe(false);
    for (const unit of ["sq ft", "SqFt", "ft", "square", "ton", "sq yd"]) expect(priceListState(made, [item(unit)]).measures).toBe(true);
    expect(priceListState(made, [item("ea", { formula: "area_sqft * 0.05" })]).measures).toBe(true);
  });

  it("works from the few items Home reads: the one changed last, the one added last, and one priced by measuring", () => {
    const changed = item("hr", { updated_at: "2026-11-02T09:00:00.000+00:00" });
    const added = item("visit");
    expect(priceListState(made, [changed, added, item("sq ft")])).toEqual({ prices: true, measures: true });
    // Nothing priced by measuring: the database finds none, so there's no third.
    expect(priceListState(made, [item("hr"), item("visit")])).toEqual({ prices: false, measures: false });
  });
});

describe("email and texting on the setup checklist", () => {
  const session = (role: string, permissions: string[], features: { email: boolean; sms: boolean }) => ({ role, permissions, config: { features } }) as unknown as Parameters<typeof sendingSteps>[0];
  const steps = (...args: Parameters<typeof session>) => sendingSteps(session(...args)).map((s) => [s.key, s.show, s.done, s.to]);

  it("asks a new owner to connect email and turn on texting, and says where", () => {
    expect(steps("owner", [], { email: false, sms: false })).toEqual([["email", true, false, "/settings?tab=email"], ["texting", true, false, "/apps?cat=Messaging"]]);
  });

  it("ticks each off once the business can send that way, its own account or the server's", () => {
    expect(steps("owner", [], { email: true, sms: false }).map((s) => s[2])).toEqual([true, false]);
    expect(steps("owner", [], { email: true, sms: true }).map((s) => s[2])).toEqual([true, true]);
  });

  it("shows them to the people who can connect them", () => {
    expect(steps("admin", ["apps", "settings"], { email: false, sms: false }).map((s) => s[1])).toEqual([true, true]);
    // An admin who doesn't connect apps can still set up email from Settings.
    expect(steps("admin", ["settings"], { email: false, sms: false }).map((s) => s[1])).toEqual([true, false]);
    expect(steps("office", ["apps", "settings"], { email: false, sms: false }).map((s) => s[1])).toEqual([false, false]);
  });
});
