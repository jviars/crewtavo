import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { runTask } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};

describe("demo", () => {
  it("is off unless CREWTAVO_DEMO is 1", async () => {
    expect((await (await app.request("/api/config", {}, env)).json()).demo).toBe(false);
    expect((await (await app.request("/api/config", {}, { ...env, CREWTAVO_DEMO: "1" })).json()).demo).toBe(true);
    const start = await app.request("/api/demo/start", { method: "POST" }, env);
    expect(start.status).toBe(404);
    const as = await app.request("/api/demo/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as: "crew" }) }, env);
    expect(as.status).toBe(404);
  });

  it("needs a session to switch people", async () => {
    const res = await app.request("/api/demo/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ as: "crew" }) }, { ...env, CREWTAVO_DEMO: "1" });
    expect(res.status).toBe(401);
  });

  it("leaves a normal instance's companies alone", async () => {
    // Without CREWTAVO_DEMO the task returns before touching the database.
    expect(await runTask("demo", env)).toEqual({ removed: 0 });
  });
});
