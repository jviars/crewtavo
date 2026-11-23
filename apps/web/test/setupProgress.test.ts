import { describe, expect, it } from "vitest";
import { setupSteps } from "../src/features/setup/SetupProgress";

describe("setting Crewtavo up, counted as one", () => {
  it("starts a new instance with its owner's account and key file", () => {
    expect(setupSteps({ singleCompany: true, platform: "compose" })).toEqual(["owner", "keys", "name", "trade", "terms"]);
  });

  it("ends on Railway with connecting it and a web address", () => {
    expect(setupSteps({ singleCompany: true, platform: "railway" })).toEqual(["owner", "keys", "name", "trade", "terms", "railway", "address"]);
  });

  it("is only the business where there's no first owner to set up", () => {
    expect(setupSteps({ singleCompany: false, platform: "server" })).toEqual(["name", "trade", "terms"]);
    expect(setupSteps(undefined)).toEqual(["name", "trade", "terms"]);
  });
});
