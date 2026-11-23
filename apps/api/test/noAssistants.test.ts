/**
 * Links that open Crewtavo by themselves (a client's Hub link, a quote's or invoice's link, a
 * referral link, a calendar feed's address, a sub's paperwork and sign-in links) are never handed to
 * an AI assistant's token, which may read everything else (lib/noAssistants.ts); and the copy of the
 * client's Hub home made for someone who doesn't see the money leaves their invoices and payments out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { readClientLink } from "../src/lib/links";
import { NO_LINKS_FOR_ASSISTANTS } from "../src/lib/noAssistants";

const env: Env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
  ENCRYPTION_KEY: btoa("k".repeat(32)),
};
const CO = "0b0a0000-0000-4000-8000-000000000001";
const CLIENT = "0c0c0000-0000-4000-8000-000000000001";

// Tokens Supabase Auth vouches for (getClaims asks /auth/v1/user about HS256 ones); an assistant's
// carries the OAuth client it was issued to.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: object = {}) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.c2ln`;
const person = token();
const assistant = token({ client_id: "client-reads" });

/** Supabase in memory: the person's membership (and custom role's areas), and what each route reads. */
function supabase(member: { role: string; role_id?: string | null; areas?: string[] } = { role: "owner" }) {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    paths.push(url.pathname);
    switch (url.pathname) {
      case "/auth/v1/user":
        return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      case "/rest/v1/rpc/assistant_switch":
        return Response.json({ state: "on" });
      case "/rest/v1/memberships":
        return Response.json([{ role: member.role, role_id: member.role_id ?? null, subcontractor_id: null }]);
      case "/rest/v1/company_roles":
        return Response.json([{ permissions: member.areas ?? [] }]);
      case "/rest/v1/clients":
      case "/rest/v1/quotes":
      case "/rest/v1/invoices":
        return Response.json([{ id: CLIENT, client_id: CLIENT }]);
      case "/rest/v1/rpc/rate_limit_hit":
        return Response.json(true);
    }
    return Response.json([]);
  });
  return paths;
}
afterEach(() => vi.unstubAllGlobals());

const get = (path: string, bearer: string) => app.request(`/api${path}`, { headers: { Authorization: `Bearer ${bearer}`, "X-Company-Id": CO } }, env);

describe("links that open Crewtavo by themselves", () => {
  const routes = [`/clients/${CLIENT}/hub-link`, `/referrals/link/${CLIENT}`, `/quotes/${CLIENT}/link`, `/invoices/${CLIENT}/link`, "/calendar-feed"];

  it("are never an AI assistant's, even one that may read everything else", async () => {
    for (const path of routes) {
      const paths = supabase();
      const res = await get(path, assistant);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: NO_LINKS_FOR_ASSISTANTS });
      // Refused before anything of the business's is read.
      expect(paths.some((p) => p.startsWith("/rest/v1/") && !p.startsWith("/rest/v1/rpc/")), path).toBe(false);
    }
  });

  it("are a person's own sign-in's, as before", async () => {
    for (const path of routes) {
      supabase();
      expect((await get(path, person)).status, path).toBe(200);
    }
  });
});

describe("copying a client's Hub link", () => {
  it("made by someone who sees the business's money (the Invoices area) leads to it all", async () => {
    supabase({ role: "office" });
    const res = await get(`/clients/${CLIENT}/hub-link`, person);
    expect(res.status).toBe(200);
    const link = await readClientLink(env, ((await res.json()) as { link: string }).link.split("/hub/")[1]!);
    expect(link).toMatchObject({ c: CO, t: "client", id: CLIENT, via: "office" });
    expect(link).not.toHaveProperty("nm");
  });

  it("leaves the money out of an estimator's copy, and anyone's whose role leaves invoices out (lib/links `nm`)", async () => {
    for (const member of [{ role: "estimator" }, { role: "office", role_id: "role-1", areas: ["sales", "schedule"] }]) {
      supabase(member);
      const res = await get(`/clients/${CLIENT}/hub-link`, person);
      expect(res.status, JSON.stringify(member)).toBe(200);
      const link = await readClientLink(env, ((await res.json()) as { link: string }).link.split("/hub/")[1]!);
      expect(link, JSON.stringify(member)).toMatchObject({ c: CO, t: "client", id: CLIENT, via: "office", nm: 1 });
    }
    // A role with the area copies it with the money.
    supabase({ role: "office", role_id: "role-1", areas: ["sales", "invoices"] });
    const res = await get(`/clients/${CLIENT}/hub-link`, person);
    expect(res.status).toBe(200);
    expect(await readClientLink(env, ((await res.json()) as { link: string }).link.split("/hub/")[1]!)).not.toHaveProperty("nm");
  });
});
