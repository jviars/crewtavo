/**
 * Lob's client (integrations/lob.ts): which keys are test and which live, the key checked with a
 * free read before it's kept, and each postcard sent once with what Lob needs (the key as Basic
 * auth, the recipient's own idempotency key, both sides, the size and marketing mail), with Lob's
 * refusals turned into words that say what to do. Lob answers what each test gives it.
 */
import { describe, expect, it, vi } from "vitest";
import { checkLobKey, createPostcard, failureWords, listCards, LobProblem, lobAddress, lobMode, postcardBody, type PostcardRequest } from "../src/integrations/lob";

const TEST_KEY = "test_0123456789abcdef0123";
const LIVE_KEY = "live_0123456789abcdef0123";

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const address = { line1: "12 Oak St", line2: null, city: "Springfield", region: "IL", postal_code: "62701", country: "US" as const };
const request = (): PostcardRequest => ({
  to: lobAddress("Ann Oak", address),
  from: lobAddress("Sketchy Gutters", { ...address, line1: "1 Main St", line2: "Suite 4" }),
  size: "6x9",
  front: "<html>front</html>",
  back: "<html>back</html>",
  description: "Spring postcards",
  metadata: { campaign: "c1", recipient: "42" },
  idempotencyKey: "7a1c2d3e-0000-4000-8000-000000000042",
});

describe("Lob keys", () => {
  it("tells a test key from a live one, and turns down anything else", () => {
    expect(lobMode(TEST_KEY)).toBe("test");
    expect(lobMode(` ${LIVE_KEY} `)).toBe("live");
    expect(lobMode("pk_test_0123456789abcdef")).toBeNull();
    expect(lobMode("test_pub_short")).toBeNull();
    expect(lobMode("sk_live_0123456789abcdef")).toBeNull();
  });

  it("takes Lookalyke's lk_ key as a test key only while LOOKALYKE_URL is set", () => {
    expect(lobMode("lk_secret_0123456789ab")).toBeNull();
    expect(lobMode("lk_secret_0123456789ab", { LOOKALYKE_URL: "http://127.0.0.1:4100" })).toBe("test");
  });

  it("checks a key with a free read of the account's addresses, as Basic auth with no password", async () => {
    const fetcher = vi.fn(async () => answer(200, { data: [], object: "list" }));
    await expect(checkLobKey({}, LIVE_KEY, fetcher as typeof fetch)).resolves.toEqual({ mode: "live" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.lob.com/v1/addresses?limit=1");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa(`${LIVE_KEY}:`)}`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("says what to fix when Lob refuses the key, or it isn't a secret key at all", async () => {
    await expect(checkLobKey({}, TEST_KEY, (async () => answer(401, { error: { message: "Unauthorized" } })) as typeof fetch)).rejects.toThrow(/didn't accept that key/);
    const never = vi.fn();
    await expect(checkLobKey({}, "pk_live_abcdefghijklmnop", never as typeof fetch)).rejects.toThrow(/starts with test_ or live_/);
    expect(never).not.toHaveBeenCalled();
    await expect(checkLobKey({}, TEST_KEY, (async () => null as unknown as Response) as unknown as typeof fetch)).rejects.toThrow(/Couldn't reach Lob/);
  });
});

describe("making a postcard", () => {
  it("sends both sides, the size, both addresses and marketing mail, with the recipient's idempotency key", async () => {
    const fetcher = vi.fn(async () => answer(200, { id: "psc_208e2a4b8e2a8a7a", expected_delivery_date: "2026-11-20", url: "https://lob-assets.com/postcards/psc.pdf" }));
    const made = await createPostcard({}, TEST_KEY, request(), fetcher as typeof fetch);
    expect(made).toEqual({ id: "psc_208e2a4b8e2a8a7a", expected_delivery_date: "2026-11-20", url: "https://lob-assets.com/postcards/psc.pdf" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.lob.com/v1/postcards");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("7a1c2d3e-0000-4000-8000-000000000042");
    expect(headers.Authorization).toBe(`Basic ${btoa(`${TEST_KEY}:`)}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      size: "6x9",
      front: "<html>front</html>",
      back: "<html>back</html>",
      use_type: "marketing",
      mail_type: "usps_first_class",
      description: "Spring postcards",
      metadata: { campaign: "c1", recipient: "42" },
      to: { name: "Ann Oak", address_line1: "12 Oak St", address_city: "Springfield", address_state: "IL", address_zip: "62701", address_country: "US" },
      from: { name: "Sketchy Gutters", address_line1: "1 Main St", address_line2: "Suite 4" },
    });
    expect(body.to).not.toHaveProperty("address_line2");
  });

  it("sends the same idempotency key on a second try, so Lob gives back the card it made", async () => {
    const keys: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]!);
      return keys.length === 1 ? answer(503, { error: { message: "unavailable" } }) : answer(200, { id: "psc_same" });
    });
    const first = await createPostcard({}, LIVE_KEY, request(), fetcher as unknown as typeof fetch).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(LobProblem);
    expect((first as LobProblem).retry).toBe(true);
    await expect(createPostcard({}, LIVE_KEY, request(), fetcher as unknown as typeof fetch)).resolves.toMatchObject({ id: "psc_same", expected_delivery_date: null });
    expect(keys).toEqual([keys[0], keys[0]]);
  });

  it("keeps a key's mode to the key: test postcards go with the test key, live with the live one", async () => {
    const used: string[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      used.push(atob(String((init.headers as Record<string, string>).Authorization).replace("Basic ", "")));
      return answer(200, { id: "psc_x" });
    });
    await createPostcard({}, TEST_KEY, request(), fetcher as unknown as typeof fetch);
    await createPostcard({}, LIVE_KEY, request(), fetcher as unknown as typeof fetch);
    expect(used).toEqual([`${TEST_KEY}:`, `${LIVE_KEY}:`]);
  });

  it("turns Lob's refusals into what to do: the key, slowing down, the address, and an answer with no card", async () => {
    const once = (status: number, body: unknown) => (async () => answer(status, body)) as typeof fetch;
    const refused = (await createPostcard({}, LIVE_KEY, request(), once(401, { error: { message: "Your API key is not valid. Please sign up on lob.com to get a valid api key.", status_code: 401, code: "invalid_api_key" } })).catch((e: unknown) => e)) as LobProblem;
    expect(refused).toMatchObject({ key: true, account: false, retry: false });
    expect(refused.message).toMatch(/Lob says this API key isn't valid/);
    const slow = (await createPostcard({}, LIVE_KEY, request(), once(429, {})).catch((e: unknown) => e)) as LobProblem;
    expect(slow.retry).toBe(true);
    const bad = (await createPostcard({}, LIVE_KEY, request(), once(422, { error: { message: "address_zip must be a valid US zip code", status_code: 422 } })).catch((e: unknown) => e)) as LobProblem;
    expect(bad.message).toBe("Lob refused this card: address_zip must be a valid US zip code");
    expect(bad.retry).toBe(false);
    const empty = (await createPostcard({}, LIVE_KEY, request(), once(200, {})).catch((e: unknown) => e)) as LobProblem;
    expect(empty.retry).toBe(true);
    const gone = (await createPostcard({}, LIVE_KEY, request(), (async () => { throw new Error("socket hang up"); }) as typeof fetch).catch((e: unknown) => e)) as LobProblem;
    expect(gone.retry).toBe(true);
  });

  it("says Lob's own reason when it refuses the account, and doesn't call a good key bad", async () => {
    const once = (status: number, body: unknown) => (async () => answer(status, body)) as typeof fetch;
    // Lob's error reference: these come back 401 and 403, like a bad key, and aren't one.
    const unpaid = (await createPostcard({}, LIVE_KEY, request(), once(401, { error: { message: "You must have a verified bank account or credit card to submit live requests.", status_code: 401, code: "payment_method_unverified" } })).catch((e: unknown) => e)) as LobProblem;
    expect(unpaid).toMatchObject({ key: false, account: true, retry: false });
    expect(unpaid.message).toBe("Lob needs a verified payment method on your account before it mails cards. Add a card or bank account in your Lob dashboard. Lob says: You must have a verified bank account or credit card to submit live requests.");
    const limit = (await createPostcard({}, LIVE_KEY, request(), once(403, { error: { message: "You have reached the maximum number of postcards for your plan.", status_code: 403, code: "feature_limit_reached" } })).catch((e: unknown) => e)) as LobProblem;
    expect(limit).toMatchObject({ key: false, account: true });
    expect(limit.message).toMatch(/Your Lob plan has reached its limit\..* Lob says: You have reached the maximum number of postcards for your plan\./);
    const email = (await createPostcard({}, LIVE_KEY, request(), once(401, { error: { message: "Please verify your email.", code: "EMAIL_REQUIRED" } })).catch((e: unknown) => e)) as LobProblem;
    expect(email).toMatchObject({ key: false, account: true });
    // A refusal Lob gives no reason for isn't put down to the key either.
    const bare = (await createPostcard({}, LIVE_KEY, request(), once(403, {})).catch((e: unknown) => e)) as LobProblem;
    expect(bare).toMatchObject({ key: false, account: true });
    expect(bare.message).toMatch(/Lob says: error 403/);
    // No code, but Lob's words say it's the key.
    const worded = (await createPostcard({}, LIVE_KEY, request(), once(401, { error: { message: "Your API key is not valid." } })).catch((e: unknown) => e)) as LobProblem;
    expect(worded).toMatchObject({ key: true, account: false });
  });

  it("has words for a card that was tried for the last time, which don't promise another try", async () => {
    const once = (status: number, body: unknown) => (async () => answer(status, body)) as typeof fetch;
    const busy = (await createPostcard({}, LIVE_KEY, request(), once(503, {})).catch((e: unknown) => e)) as LobProblem;
    expect(busy.message).toMatch(/tried again shortly/);
    expect(busy.final).toBe("Lob had a problem on its end each time this card was tried, so it wasn't made.");
    const slow = (await createPostcard({}, LIVE_KEY, request(), once(429, {})).catch((e: unknown) => e)) as LobProblem;
    expect(slow.final).not.toMatch(/again|minute/);
    const gone = (await createPostcard({}, LIVE_KEY, request(), (async () => { throw new Error("socket hang up"); }) as typeof fetch).catch((e: unknown) => e)) as LobProblem;
    expect(gone.final).not.toMatch(/again shortly/);
  });

  it("tells a new account its payment method is missing when the key is checked, not that the key is wrong", async () => {
    await expect(checkLobKey({}, LIVE_KEY, (async () => answer(401, { error: { message: "You must have a verified bank account or credit card to submit live requests.", code: "payment_method_unverified" } })) as typeof fetch)).rejects.toThrow(/verified payment method/);
    await expect(checkLobKey({}, LIVE_KEY, (async () => answer(401, { error: { message: "Your API key is not valid.", code: "invalid_api_key" } })) as typeof fetch)).rejects.toThrow(/didn't accept that key/);
  });

  it("keeps names, lines and metadata within Lob's limits", () => {
    expect(lobAddress("Ann", address).address_state).toBe("IL");
  });

  it("finds the cards Lob failed after accepting them: its list, by campaign and status, a page at a time", async () => {
    const asked: URL[] = [];
    const fetcher = vi.fn(async (url: string) => {
      asked.push(new URL(url));
      return asked.length === 1
        ? answer(200, { object: "list", next_url: "https://api.lob.com/v1/postcards?limit=100&after=tok_2", data: [{ id: "psc_1", status: "failed", failure_reason: { code: "INVALID_FILE_URL", message: "The file URL when creating this resource is invalid." }, metadata: { crewtavo_campaign: "c1", crewtavo_recipient: "7" } }] })
        : answer(200, { object: "list", next_url: null, data: [{ id: "psc_2", status: "failed", failure_reason: "Asset could not be fetched", metadata: { crewtavo_campaign: "c1", crewtavo_recipient: "8" } }, { nonsense: true }] });
    });
    const found = await listCards({}, TEST_KEY, { campaign: "c1", failed: true }, fetcher as unknown as typeof fetch);
    expect(found.complete).toBe(true);
    expect(found.cards).toEqual([
      { id: "psc_1", status: "failed", failure: "The file URL when creating this resource is invalid.", metadata: { crewtavo_campaign: "c1", crewtavo_recipient: "7" }, url: null },
      { id: "psc_2", status: "failed", failure: "Asset could not be fetched", metadata: { crewtavo_campaign: "c1", crewtavo_recipient: "8" }, url: null },
    ]);
    expect(asked[0]!.pathname).toBe("/v1/postcards");
    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({ limit: "100", status: "failed", "metadata[crewtavo_campaign]": "c1" });
    expect(asked[1]!.searchParams.get("after")).toBe("tok_2");
  });

  it("lists without the campaign filter when Lob won't take it, and says when a listing was cut short", async () => {
    const asked: URL[] = [];
    const fetcher = vi.fn(async (url: string) => {
      asked.push(new URL(url));
      return asked.length === 1 ? answer(422, { error: { message: "metadata is invalid" } }) : answer(200, { data: [{ id: "psc_9", status: "failed", metadata: { crewtavo_campaign: "other" } }], next_url: null });
    });
    const found = await listCards({}, TEST_KEY, { campaign: "c1", failed: true }, fetcher as unknown as typeof fetch);
    expect(asked[1]!.searchParams.has("metadata[crewtavo_campaign]")).toBe(false);
    // Another campaign's card comes back too: it's the caller that matches cards, by id or metadata.
    expect(found).toMatchObject({ complete: true, cards: [{ id: "psc_9", metadata: { crewtavo_campaign: "other" } }] });
    const cut = await listCards({}, TEST_KEY, { campaign: "c1" }, (async () => { throw new Error("socket hang up"); }) as typeof fetch);
    expect(cut).toEqual({ cards: [], complete: false });
    expect(failureWords({ code: "X" })).toBe("X");
    expect(failureWords(null)).toBeNull();
  });

  it("keeps long names and lines to what Lob takes", () => {
    const long = lobAddress("A".repeat(60), { ...address, line1: "B".repeat(80) });
    expect(long.name).toHaveLength(40);
    expect(long.address_line1).toHaveLength(64);
    const body = postcardBody({ ...request(), description: "D".repeat(300), metadata: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "v".repeat(600)])) });
    expect(String(body.description)).toHaveLength(255);
    const metadata = body.metadata as Record<string, string>;
    expect(Object.keys(metadata)).toHaveLength(20);
    expect(metadata.k0).toHaveLength(500);
  });
});
