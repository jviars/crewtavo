/**
 * An access token that expired while the phone was offline (lib/api.ts): the sign-in is refreshed
 * before anyone is treated as signed out, and a refresh that can't get through is a network
 * failure, so queued field actions wait instead of being refused.
 */
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, loadConfig, supabase, unwrap } from "../src/lib/api";
import { SESSION_EXPIRED } from "../src/lib/errors";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
let answer: (url: string, init: RequestInit) => Response = () => new Response("{}");
const sent: Array<{ url: string; bearer: string | null }> = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    sent.push({ url, bearer: new Headers(init.headers).get("Authorization") });
    return answer(url, init);
  }),
);

beforeAll(async () => {
  answer = () => new Response(JSON.stringify({ supabaseUrl: "https://crewtavo.test", supabaseKey: "public-key", sentry: null, features: {} }));
  await loadConfig();
  sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  sent.length = 0;
  store.clear();
});

/** A sign-in whose access token the API turns away until it's refreshed; `refresh` decides how that goes. */
function signedIn(refresh: () => { session: object | null; error: Error | null }) {
  let token: string | null = "expired-token";
  vi.spyOn(supabase().auth, "getSession").mockImplementation(async () => ({ data: { session: token ? { access_token: token } : null }, error: null }) as never);
  const refreshSession = vi.spyOn(supabase().auth, "refreshSession").mockImplementation(async () => {
    const { session, error } = refresh();
    if (session) token = "fresh-token";
    else if (!(error instanceof AuthRetryableFetchError)) token = null;
    return { data: { session, user: null }, error } as never;
  });
  answer = (_url, init) =>
    new Headers(init.headers).get("Authorization") === "Bearer fresh-token" ? new Response('{"ok":true}') : new Response('{"error":"Your session has expired. Sign in again."}', { status: 401 });
  return refreshSession;
}

describe("a 401 from the API", () => {
  it("refreshes the sign-in once and sends the request again", async () => {
    const refreshSession = signedIn(() => ({ session: { access_token: "fresh-token" }, error: null }));
    await expect(api.patch("/visits/v1", { status: "completed" })).resolves.toEqual({ ok: true });
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.bearer)).toEqual(["Bearer expired-token", "Bearer fresh-token"]);
  });

  it("is a network failure, not a sign-out, when the refresh can't get through", async () => {
    signedIn(() => ({ session: null, error: new AuthRetryableFetchError("Failed to fetch", 0) }));
    await expect(api.patch("/visits/v1", { status: "completed" })).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("means signed out when the sign-in can't be refreshed", async () => {
    signedIn(() => ({ session: null, error: new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found") }));
    await expect(api.patch("/visits/v1", { status: "completed" })).rejects.toMatchObject({ status: 401, code: SESSION_EXPIRED });
  });
});

describe("a sign-in that needs refreshing with no signal to do it", () => {
  it("doesn't send API requests that could only be turned away", async () => {
    vi.spyOn(supabase().auth, "getSession").mockResolvedValue({ data: { session: null }, error: new AuthRetryableFetchError("Failed to fetch", 0) } as never);
    await expect(api.get("/me")).rejects.toMatchObject({ status: 0, code: "network" });
    expect(sent).toHaveLength(0);
  });

  it("doesn't send database requests as nobody (empty lists, refused saves): they fail like no signal", async () => {
    answer = () => new Response(null, { status: 201 });
    const save = async () => unwrap(await supabase().from("checklist_responses").upsert({ id: "r1" } as never));
    store.set("sb-crewtavo-auth-token", JSON.stringify({ access_token: "expired-token" }));
    await expect(save()).rejects.toMatchObject({ status: 0, code: "network" });
    expect(sent).toHaveLength(0);

    // Nobody signed in on this phone (a public page): the public key is what it should use.
    store.clear();
    await expect(save()).resolves.toBeNull();
    expect(sent).toMatchObject([{ url: "https://crewtavo.test/rest/v1/checklist_responses", bearer: "Bearer public-key" }]);
  });
});
