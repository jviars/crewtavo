/**
 * The upload limit on Railway (services/uploads.ts): read from the storage service's variables
 * through Crewtavo's Railway connection, and raised to 200 MB with a restart of storage, with
 * Railway's API and PostgREST stubbed through fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { adminClient } from "../src/lib/supabase";
import { raiseUploadLimit, UPLOAD_LIMIT, uploadLimit } from "../src/services/uploads";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.arringtonpaving.com",
  RAILWAY_PROJECT_ID: "proj-1",
  RAILWAY_ENVIRONMENT_ID: "env-1",
  RAILWAY_SERVICE_ID: "svc-crewtavo",
  CREWTAVO_SINGLE_COMPANY: "1",
};

interface Call { host: string; path: string; body: { query?: string; variables?: Record<string, any> } }

/** Railway and PostgREST: `connected` decides whether Crewtavo holds Railway access; `limit` is storage's FILE_SIZE_LIMIT. */
async function serve({ connected = true, limit = "52428800" as string | null, storage = true } = {}) {
  const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : {};
    calls.push({ host: url.host, path: url.pathname.replace(/^\/rest\/v1\//, ""), body });
    if (url.host === "backboard.railway.com") {
      const q = String(body.query);
      if (q.includes("project(")) return Response.json({ data: { project: { services: { edges: [{ node: { id: "svc-crewtavo", name: "crewtavo" } }, ...(storage ? [{ node: { id: "svc-storage", name: "storage" } }] : [])] } } } });
      if (q.includes("variables(")) return Response.json({ data: { variables: limit ? { FILE_SIZE_LIMIT: limit, TENANT_ID: "crewtavo" } : { TENANT_ID: "crewtavo" } } });
      return Response.json({ data: { ok: true } });
    }
    if (url.pathname.endsWith("/integrations")) return Response.json(connected ? [{ status: "connected" }] : []);
    if (url.pathname.endsWith("/integration_secrets")) return Response.json(connected ? [{ ciphertext: secret }] : []);
    return Response.json([]);
  });
  return calls;
}
const railwayCalls = (calls: Call[]) => calls.filter((c) => c.host === "backboard.railway.com").map((c) => c.body);

afterEach(() => vi.unstubAllGlobals());

describe("the upload limit on Railway", () => {
  it("reads what the storage service takes", async () => {
    await serve();
    expect(await uploadLimit(env, adminClient(env), "co-1")).toEqual({ connected: true, limit: 52_428_800, target: UPLOAD_LIMIT });
  });

  it("raises it to 200 MB on the storage service and restarts storage, nothing else", async () => {
    const calls = await serve();
    expect(await raiseUploadLimit(env, adminClient(env), "co-1")).toEqual({ connected: true, limit: UPLOAD_LIMIT, target: UPLOAD_LIMIT, raised: true });
    const sent = railwayCalls(calls);
    expect(sent.find((b) => b.query!.includes("variableUpsert"))?.variables!.input).toEqual({
      projectId: "proj-1", environmentId: "env-1", serviceId: "svc-storage", name: "FILE_SIZE_LIMIT", value: "209715200", skipDeploys: true,
    });
    expect(sent.filter((b) => b.query!.includes("serviceInstanceRedeploy")).map((b) => b.variables!.serviceId)).toEqual(["svc-storage"]);
  });

  it("leaves a higher limit alone", async () => {
    const calls = await serve({ limit: "524288000" });
    expect(await raiseUploadLimit(env, adminClient(env), "co-1")).toMatchObject({ limit: 524_288_000, raised: false });
    expect(railwayCalls(calls).some((b) => b.query!.includes("variableUpsert") || b.query!.includes("serviceInstanceRedeploy"))).toBe(false);
  });

  it("sets it when storage has none of its own", async () => {
    const calls = await serve({ limit: null });
    expect(await uploadLimit(env, adminClient(env), "co-1")).toMatchObject({ connected: true, limit: null });
    expect(await raiseUploadLimit(env, adminClient(env), "co-1")).toMatchObject({ raised: true });
    expect(railwayCalls(calls).some((b) => b.query!.includes("variableUpsert"))).toBe(true);
  });

  it("without the Railway connection, says to connect it first", async () => {
    const calls = await serve({ connected: false });
    expect(await uploadLimit(env, adminClient(env), "co-1")).toEqual({ connected: false, limit: null, target: UPLOAD_LIMIT });
    await expect(raiseUploadLimit(env, adminClient(env), "co-1")).rejects.toThrow("Connect Crewtavo to Railway first");
    expect(railwayCalls(calls)).toEqual([]);
  });

  it("says so when the project has no storage service to change", async () => {
    await serve({ storage: false });
    await expect(raiseUploadLimit(env, adminClient(env), "co-1")).rejects.toThrow("can't find the storage service");
  });
});
