/**
 * Storage limits before anything is stored (lib/storageLimits.ts): which requests are uploads and
 * where they go, read as Storage (storage-api v1.82.1) routes and reads them; whose they are, from
 * tokens checked the way Storage checks them; and the decision against the company's and the
 * person's numbers, read once in a while, added to as uploads go through, and always read again
 * before a refusal. The gateway's part, end to end, is in gateway.test.ts; Google imports' in
 * drive.test.ts; the numbers themselves in supabase/tests/storage_limits_test.sql.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/lib/supabase";
import {
  CACHE_MS,
  forgetStorageUsage,
  guardStorage,
  linkOwner,
  reserveStorage,
  routedPath,
  signedInUser,
  snapshotsFrom,
  tusMetadata,
  uploadOf,
  verifiedClaims,
  type StorageSnapshot,
} from "../src/lib/storageLimits";

const CO = "0b0a0000-0000-4000-8000-000000000001";
const ANA = "00000000-0000-4000-8000-0000000000aa";
const BEN = "00000000-0000-4000-8000-0000000000bb";
const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const LATER = Math.floor(Date.now() / 1000) + 3600;
/** A token signed as the instance's services sign them (HS256 with JWT_SECRET). */
const sign = (claims: object, { secret = SECRET, header = { alg: "HS256", typ: "JWT" } }: { secret?: string; header?: object } = {}) => {
  const unsigned = `${part(header)}.${part(claims)}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
};
/** The same claims, not signed by anyone who knows the secret. */
const forged = (claims: object) => `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.c2ln`;
const ana = sign({ sub: ANA, role: "authenticated", exp: LATER });
/** A signed upload link's token, as Storage's signUploadObjectUrl makes it. */
const link = (claims: object) => sign({ url: `files/${CO}/plans/a.pdf`, upsert: false, scope: "upload", exp: LATER, ...claims });
const b64 = (text: string) => Buffer.from(text).toString("base64");
const MB = 1_000_000;

const request = (method: string, path: string, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { method, headers });
const meta = (objectName: string) => `bucketName ${b64("files")},objectName ${b64(objectName)},contentType ${b64("application/pdf")}`;
const tus = (objectName: string, extra: Record<string, string> = {}, path = "/storage/v1/upload/resumable", method = "POST") =>
  request(method, path, { "Upload-Length": "5000", "Upload-Metadata": meta(objectName), Authorization: `Bearer ${ana}`, ...extra });
const upload = (r: Request) => uploadOf(r, SECRET);

beforeEach(() => forgetStorageUsage());
afterEach(() => vi.useRealTimers());

describe("which requests are uploads, and where to", () => {
  it("reads a resumable upload as it's made: its size, and the stored name from its metadata", () => {
    expect(upload(tus(`${CO}/plans/a.pdf`))).toEqual({ company: CO, user: ANA, folder: "plans", bytes: 5000, resumable: true });
    expect(upload(tus(`${CO}/kb/a.jpg`, {}, "/storage/v1/upload/resumable/"))).toMatchObject({ folder: "kb", user: ANA });
  });

  it("takes every POST under upload/resumable as one being made, as Storage does, whatever follows", () => {
    for (const path of ["/storage/v1/upload/resumable/x", "/storage/v1/upload/resumable/abc/def", "/storage/v1/upload/resum%61ble", "/storage/v1/upload/%72esumable/x"]) {
      expect(upload(tus(`${CO}/plans/a.pdf`, {}, path)), path).toMatchObject({ folder: "plans", user: ANA, bytes: 5000 });
    }
    // Neither Storage nor tus honours X-HTTP-Method-Override: a POST is a POST.
    expect(upload(tus(`${CO}/plans/a.pdf`, { "X-HTTP-Method-Override": "PATCH" }))).toMatchObject({ folder: "plans", user: ANA });
  });

  it("doesn't check a resumable upload's pieces, its progress or stopping it, whatever they say they are", () => {
    for (const method of ["PATCH", "HEAD", "DELETE", "PUT"]) expect(upload(tus(`${CO}/plans/a.pdf`, {}, "/storage/v1/upload/resumable/abc", method)), method).toBeNull();
    expect(upload(tus(`${CO}/plans/a.pdf`, { "X-HTTP-Method-Override": "POST" }, "/storage/v1/upload/resumable/abc", "PATCH"))).toBeNull();
  });

  it("isn't fooled by another route that only looks like upload/resumable", () => {
    // Storage's router leaves an encoded "/" alone, so these aren't resumable uploads there either.
    expect(upload(tus(`${CO}/plans/a.pdf`, {}, "/storage/v1/upload%2Fresumable"))).toBeNull();
    expect(upload(tus(`${CO}/plans/a.pdf`, {}, "/storage/v1/upload/resumablex"))).toBeNull();
    // Nor one Storage can't read at all (it answers 400).
    expect(upload(tus(`${CO}/plans/a.pdf`, {}, "/storage/v1/upload/resumable/%E0%A4%A"))).toBeNull();
  });

  it("has no size for a resumable upload that doesn't say it", () => {
    const deferred = tus(`${CO}/plans/a.pdf`, { "Upload-Length": "", "Upload-Defer-Length": "1" });
    expect(upload(deferred)).toMatchObject({ folder: "plans", bytes: null });
  });

  it("reads a file sent in one request by its address and length", () => {
    expect(upload(request("POST", `/storage/v1/object/files/${CO}/kb/a.jpg`, { "Content-Length": "4096", Authorization: `Bearer ${ana}` }))).toEqual({ company: CO, user: ANA, folder: "kb", bytes: 4096 });
    expect(upload(request("PUT", `/storage/v1/object/files/${CO}/chat/c1/a.jpg`, { "Content-Length": "10" }))).toEqual({ company: CO, user: null, folder: "chat", bytes: 10 });
    expect(upload(request("POST", `/storage/v1/object/files/${CO}/plans/a.pdf`))).toMatchObject({ bytes: null });
    // Storage's router decodes the address before it matches it.
    expect(upload(request("POST", `/storage/v1/%6Fbject/f%69les/${CO}/plans/a.pdf`, { "Content-Length": "1", Authorization: `Bearer ${ana}` }))).toMatchObject({ folder: "plans", user: ANA });
  });

  it("isn't fooled by reads, making an upload link, copies, or another bucket", () => {
    for (const [method, path] of [
      ["POST", `/storage/v1/object/upload/sign/files/${CO}/plans/a.pdf`],
      ["POST", `/storage/v1/object/sign/files/${CO}/plans/a.pdf`],
      ["POST", "/storage/v1/object/list/files"],
      ["POST", "/storage/v1/object/copy"],
      ["POST", "/storage/v1/object/move"],
      ["GET", `/storage/v1/object/files/${CO}/plans/a.pdf`],
      ["DELETE", `/storage/v1/object/files/${CO}/plans/a.pdf`],
      ["POST", `/storage/v1/object/other/${CO}/plans/a.pdf`],
    ]) {
      expect(upload(request(method!, path!, { Authorization: `Bearer ${ana}` })), `${method} ${path}`).toBeNull();
    }
    expect(upload(tus(`${CO}/plans/a.pdf`, { "Upload-Metadata": `bucketName ${b64("other")},objectName ${b64(`${CO}/plans/a.pdf`)}` }))).toBeNull();
  });

  it("only looks inside a company's folder (Storage lets nothing in anywhere else)", () => {
    expect(upload(tus("crewtavo-storage-check/volume.txt"))).toBeNull();
    expect(upload(tus(`${CO.toUpperCase()}/plans/a.pdf`))).toBeNull();
    expect(upload(request("POST", "/storage/v1/object/files/plans/a.pdf", { "Content-Length": "1" }))).toBeNull();
  });

  it("can't be talked into a lighter rule by an encoded name", () => {
    // Read decoded, it's a visit photo; read as it is, a folder named "visit%2Fx": the stricter wins.
    expect(upload(request("POST", `/storage/v1/object/files/${CO}/visit%2Fx/a.pdf`, { "Content-Length": "1" }))?.folder).toBe("visit%2Fx");
    expect(upload(request("POST", `/storage/v1/object/files/${CO}/%6B%62/a.jpg`, { "Content-Length": "1" }))?.folder).toBe("kb");
    expect(upload(request("POST", `/storage/v1/object/files/${CO}%2Fplans/a.pdf`, { "Content-Length": "1" }))).toMatchObject({ company: CO, folder: "plans" });
  });
});

describe("a resumable upload's metadata, read as tus reads it", () => {
  it("can't be talked into another bucket or folder by a key tus reads as a different one", () => {
    // A tab is part of a key to tus, so "\tbucketName" isn't bucketName: the file still goes to plans/.
    const sneaky = (extra: string) => upload(tus(`${CO}/plans/a.pdf`, { "Upload-Metadata": `${meta(`${CO}/plans/a.pdf`)},${extra}` }));
    expect(sneaky(`\tbucketName ${b64("x")}`)).toMatchObject({ company: CO, folder: "plans", user: ANA });
    expect(sneaky(`\tobjectName ${b64(`${CO}/visit/v1/a.jpg`)}`)).toMatchObject({ folder: "plans" });
    expect(sneaky(`objectName\t${b64(`${CO}/visit/v1/a.jpg`)}`)).toMatchObject({ folder: "plans" });
  });

  it("is nothing when tus would turn it down, so Storage refuses the upload itself", () => {
    expect(tusMetadata(`${meta(`${CO}/plans/a.pdf`)},bucketName ${b64("x")}`)).toBeNull();
    expect(tusMetadata(`bucketName ${b64("files")}, objectName ${b64("x")}`)).toBeNull();
    expect(tusMetadata(`bucketName  ${b64("files")}`)).toBeNull();
    expect(tusMetadata("bucketName Zm9v!")).toBeNull();
    expect(tusMetadata("bucketName Zm9")).toBeNull();
    expect(tusMetadata("constructor eA==")).toBeNull();
    expect(tusMetadata("bucketNamé eA==")).toBeNull();
    expect(tusMetadata("  ")).toBeNull();
    expect(tusMetadata(null)).toBeNull();
  });

  it("reads what tus reads", () => {
    expect(tusMetadata(`bucketName ${b64("files")},flag,objectName ${b64("a/b c.pdf")},empty `)).toEqual({ bucketName: "files", flag: null, objectName: "a/b c.pdf", empty: null });
  });
});

describe("addresses, as Storage's router reads them", () => {
  it("decodes what doesn't mean anything in an address, and leaves the rest", () => {
    expect(routedPath("/storage/v1/upload/resumable")).toBe("/storage/v1/upload/resumable");
    expect(routedPath("/storage/v1/upload/resum%61ble")).toBe("/storage/v1/upload/resumable");
    expect(routedPath("/storage/v1/upload%2Fresumable")).toBe("/storage/v1/upload%2Fresumable");
    expect(routedPath("/a/%25/b%2561")).toBe("/a/%25/b%2561");
    expect(routedPath("/a/%E0%A4%A")).toBeNull();
  });
});

describe("whose upload it is", () => {
  const withHeader = (value: string) => request("POST", "/x", { Authorization: value });
  const withToken = (value: string) => withHeader(`Bearer ${value}`);

  it("is a signed-in person's (an AI assistant working for them counts as them)", () => {
    expect(signedInUser(withToken(ana), SECRET)).toBe(ANA);
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", client_id: "claude", exp: LATER })), SECRET)).toBe(ANA);
  });

  it("reads the token the way Storage does: with or without \"Bearer \"", () => {
    expect(signedInUser(withHeader(ana), SECRET)).toBe(ANA);
    expect(signedInUser(withHeader(`bearer    ${ana}`), SECRET)).toBe(ANA);
    expect(signedInUser(withHeader(`Token ${ana}`), SECRET)).toBeNull();
  });

  it("is nobody's when the token isn't genuine: not signed with the secret, run out, or not yet good", () => {
    expect(signedInUser(withToken(forged({ sub: ANA, role: "authenticated", exp: LATER })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", exp: LATER }, { secret: "another-secret-another-secret-another" })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", exp: Math.floor(Date.now() / 1000) - 1 })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", exp: LATER, nbf: LATER })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", exp: "later" })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ sub: ANA, role: "authenticated", exp: LATER }, { header: { alg: "HS512" } })), SECRET)).toBeNull();
    expect(signedInUser(withToken(`${part({ alg: "none" })}.${part({ sub: ANA, role: "authenticated", exp: LATER })}.`), SECRET)).toBeNull();
    // With no secret to check against, nobody is.
    expect(signedInUser(withToken(ana), undefined)).toBeNull();
  });

  it("is nobody's for the server's keys, anonymous visitors and anything that isn't a token", () => {
    expect(signedInUser(withToken(sign({ role: "anon", iss: "supabase", exp: LATER })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ role: "service_role", iss: "supabase", exp: LATER })), SECRET)).toBeNull();
    expect(signedInUser(withToken(sign({ role: "authenticated", exp: LATER })), SECRET)).toBeNull();
    expect(signedInUser(withToken("sb_secret_test"), SECRET)).toBeNull();
    expect(signedInUser(withToken("a.not-json.b"), SECRET)).toBeNull();
    expect(signedInUser(request("POST", "/x"), SECRET)).toBeNull();
  });

  it("checks claims the way Storage does: a token with no time on it is as good as Storage finds it", () => {
    expect(verifiedClaims(sign({ sub: ANA, role: "authenticated" }), SECRET)).toEqual({ sub: ANA, role: "authenticated" });
    expect(verifiedClaims(sign({ sub: ANA, iat: "now" }), SECRET)).toBeNull();
    expect(verifiedClaims(sign(["not", "an", "object"] as unknown as object), SECRET)).toBeNull();
  });

  it("is, for an upload link, whoever the link was made for", () => {
    expect(linkOwner(link({ owner: ANA }), SECRET)).toBe(ANA);
    // Links from before tokens said what they're for.
    expect(linkOwner(sign({ owner: ANA, url: "files/x", upsert: true, exp: LATER }), SECRET)).toBe(ANA);
    // Made by the server (a booking form, a sub's paperwork): nobody's.
    expect(linkOwner(link({}), SECRET)).toBeNull();
    expect(linkOwner(sign({ owner: ANA, url: "files/x", scope: "download", exp: LATER }), SECRET)).toBeNull();
    expect(linkOwner(forged({ owner: ANA, url: "files/x", upsert: false, scope: "upload", exp: LATER }), SECRET)).toBeNull();
    expect(linkOwner(link({ owner: ANA, exp: Math.floor(Date.now() / 1000) - 1 }), SECRET)).toBeNull();
  });

  it("takes an upload to a link as the link's, whatever Authorization says (Storage doesn't read it there)", () => {
    const put = (token: string, headers: Record<string, string> = {}) => upload(request("PUT", `/storage/v1/object/upload/sign/files/${CO}/plans/a.pdf?token=${token}`, { "Content-Length": "7", ...headers }));
    expect(put(link({ owner: ANA }))).toEqual({ company: CO, user: ANA, folder: "plans", bytes: 7 });
    expect(put(link({}), { Authorization: `Bearer ${ana}` })).toMatchObject({ user: null });
    expect(put(link({ owner: ANA }), { Authorization: `Bearer ${sign({ sub: BEN, role: "authenticated", exp: LATER })}` })).toMatchObject({ user: ANA });
    expect(put("t")).toMatchObject({ user: null, folder: "plans" });
  });

  it("takes a resumable upload to a link as the link's (x-signature)", () => {
    const signedTus = (headers: Record<string, string>) => upload(tus(`${CO}/plans/a.pdf`, headers, "/storage/v1/upload/resumable/sign"));
    expect(signedTus({ "x-signature": link({ owner: ANA }), Authorization: "" })).toMatchObject({ user: ANA, folder: "plans", bytes: 5000 });
    expect(signedTus({ "x-signature": link({}) })).toMatchObject({ user: null });
    expect(signedTus({})).toMatchObject({ user: null });
    expect(upload(tus(`${CO}/plans/a.pdf`, { "x-signature": link({ owner: BEN }) }, "/storage/v1/upload/resumable/sign/x"))).toMatchObject({ user: BEN });
  });
});

describe("deciding", () => {
  let numbers: Record<string, StorageSnapshot>;
  let reads: string[];
  const source = async (company: string, user: string) => {
    reads.push(user);
    return { ...numbers[user]! };
  };
  const room = (over: Partial<StorageSnapshot> = {}): StorageSnapshot => ({ companyUsed: 0, companyLimit: 10 * MB, userUsed: 0, userLimit: null, owner: false, member: true, ...over });
  const try_ = (folder: string, bytes: number | null, user: string | null = ANA) => reserveStorage(source, { company: CO, user, folder, bytes });

  beforeEach(() => {
    reads = [];
    numbers = { [ANA]: room(), [BEN]: room() };
  });

  it("refuses what would go over the company's limit, and says the file doesn't fit and how full it is", async () => {
    numbers[ANA] = room({ companyUsed: 9 * MB });
    expect(await try_("plans", 2 * MB)).toEqual({
      ok: false,
      message: "This 2 MB file doesn't fit: 9 MB of the 10 MB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.",
    });
    expect(await try_("plans", 1 * MB)).toMatchObject({ ok: true });
  });

  it("counts a file that doesn't say its size as a byte, so a full company still refuses it", async () => {
    numbers[ANA] = room({ companyUsed: 10 * MB });
    expect(await try_("plans", null)).toEqual({ ok: false, message: "10 MB of the 10 MB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash." });
    numbers[BEN] = room({ companyUsed: 10 * MB - 1, userLimit: null });
    forgetStorageUsage();
    expect(await try_("plans", null, BEN)).toMatchObject({ ok: true });
  });

  it("has no company limit when there's none", async () => {
    numbers[ANA] = room({ companyUsed: 900 * MB, companyLimit: null });
    expect(await try_("plans", 100 * MB)).toMatchObject({ ok: true });
  });

  it("never refuses, or reads anything for, what crews need to finish a job", async () => {
    numbers[ANA] = room({ companyUsed: 50 * MB, userUsed: 50 * MB, userLimit: 1 });
    for (const folder of ["visit", "quote", "subs", "tickets", "receipts", "measurements", "avatars"]) expect(await try_(folder, 5 * MB), folder).toMatchObject({ ok: true });
    expect(reads).toEqual([]);
  });

  it("holds a person to their own limit for Drive files and guides only", async () => {
    numbers[ANA] = room({ companyLimit: null, userUsed: 3 * MB, userLimit: 4 * MB });
    expect(await try_("plans", 2 * MB)).toEqual({
      ok: false,
      message: "This 2 MB file doesn't fit in your storage: you've used 3 MB of your 4 MB. Ask an owner to raise it, or move old files to the Trash.",
    });
    expect(await try_("kb", 2 * MB)).toMatchObject({ ok: false });
    expect(await try_("chat", 2 * MB)).toMatchObject({ ok: true });
    expect(await try_("equipment", 2 * MB)).toMatchObject({ ok: true });
  });

  it("says the company is full before a person's own limit", async () => {
    numbers[ANA] = room({ companyUsed: 10 * MB, userUsed: 4 * MB, userLimit: 4 * MB });
    expect(await try_("plans", MB)).toMatchObject({ message: expect.stringContaining("of the 10 MB storage limit is used") });
  });

  it("never holds an owner to a personal limit, but does to the company's", async () => {
    numbers[ANA] = room({ companyLimit: null, userUsed: 9 * MB, userLimit: 1 * MB, owner: true });
    expect(await try_("plans", 5 * MB)).toMatchObject({ ok: true });
    numbers[BEN] = room({ companyUsed: 10 * MB, owner: true });
    expect(await reserveStorage(source, { company: CO, user: BEN, folder: "plans", bytes: 1 })).toMatchObject({ ok: false });
  });

  it("doesn't check uploads with no signed-in person", async () => {
    numbers[ANA] = room({ companyUsed: 10 * MB });
    expect(await try_("plans", 5 * MB, null)).toMatchObject({ ok: true });
    expect(reads).toEqual([]);
  });

  it("never checks, or tells the numbers to, someone not on the company's team", async () => {
    numbers[ANA] = { companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: false, member: false };
    expect(await try_("plans", 5 * MB)).toMatchObject({ ok: true });
    expect(await try_("plans", 5 * MB)).toMatchObject({ ok: true });
    // Asked once, then kept like any other answer.
    expect(reads).toEqual([ANA]);
    // Nothing of theirs is counted toward the company: Storage won't keep it.
    numbers[BEN] = room({ companyUsed: 9 * MB });
    expect(await try_("plans", MB, BEN)).toMatchObject({ ok: true });
  });

  it("reads the numbers once every half minute, and counts what it lets through meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    // A burst of 3 MB files against 10 MB: three go, the fourth doesn't, even read again.
    const verdicts = [];
    for (let i = 0; i < 4; i++) verdicts.push((await try_("plans", 3 * MB)).ok);
    expect(verdicts).toEqual([true, true, true, false]);
    expect(reads).toEqual([ANA, ANA]);
    // Under the limit, the numbers kept are used.
    expect(await try_("plans", 1 * MB)).toMatchObject({ ok: true });
    expect(reads).toEqual([ANA, ANA]);
    // Half a minute on, they're read again, and uploads the database never heard of are forgotten.
    vi.setSystemTime(Date.now() + CACHE_MS);
    expect(await try_("plans", 9 * MB)).toMatchObject({ ok: true });
    expect(reads).toEqual([ANA, ANA, ANA]);
  });

  it("never refuses from numbers kept from before: a raised limit or an emptied Trash counts at once", async () => {
    numbers[ANA] = room({ companyUsed: 9 * MB });
    expect(await try_("plans", 2 * MB)).toMatchObject({ ok: false });
    // An owner raises the limit; the very next try fits.
    numbers[ANA] = room({ companyUsed: 9 * MB, companyLimit: 20 * MB });
    expect(await try_("plans", 2 * MB)).toMatchObject({ ok: true });

    numbers[BEN] = room({ companyLimit: null, userUsed: 4 * MB, userLimit: 4 * MB });
    expect(await try_("plans", MB, BEN)).toMatchObject({ ok: false });
    // They move old files to the Trash, and try again straight away.
    numbers[BEN] = room({ companyLimit: null, userUsed: 1 * MB, userLimit: 4 * MB });
    expect(await try_("plans", MB, BEN)).toMatchObject({ ok: true });
  });

  it("refuses from what it just read, without reading twice", async () => {
    numbers[ANA] = room({ companyUsed: 10 * MB });
    expect(await try_("plans", MB)).toMatchObject({ ok: false });
    expect(reads).toEqual([ANA]);
  });

  it("asks once for uploads that arrive together", async () => {
    const all = await Promise.all([try_("plans", MB), try_("plans", MB), try_("kb", MB)]);
    expect(all.every((v) => v.ok)).toBe(true);
    expect(reads).toEqual([ANA]);
  });

  it("counts one person's uploads toward the company for everyone", async () => {
    numbers[ANA] = room({ companyUsed: 2 * MB });
    expect(await try_("plans", 6 * MB)).toMatchObject({ ok: true });
    // Ben's numbers, read a moment later, don't have Ana's upload yet: it still counts.
    numbers[BEN] = room({ companyUsed: 2 * MB });
    expect(await try_("plans", 3 * MB, BEN)).toEqual({ ok: false, message: expect.stringContaining("8 MB of the 10 MB storage limit is used") });
    expect(reads).toEqual([ANA, BEN]);
  });

  it("counts what crews upload, though it's never refused", async () => {
    expect(await try_("plans", MB)).toMatchObject({ ok: true });
    expect(await try_("visit", 8 * MB)).toMatchObject({ ok: true });
    expect(await try_("plans", 2 * MB)).toMatchObject({ ok: false });
  });

  it("takes an upload off again when it isn't stored, once", async () => {
    const first = await try_("plans", 8 * MB);
    if (!first.ok) throw new Error("expected room");
    expect(await try_("plans", 8 * MB)).toMatchObject({ ok: false });
    first.release();
    first.release();
    const second = await try_("plans", 8 * MB);
    expect(second).toMatchObject({ ok: true });
    expect(await try_("plans", 3 * MB)).toMatchObject({ ok: false });
  });

  it("counts a stored upload once: until the database has it, then as the database says", async () => {
    const first = await try_("plans", 6 * MB);
    if (!first.ok) throw new Error("expected room");
    first.stored();
    // Storage kept it, and the database says so from now on.
    numbers[ANA] = room({ companyUsed: 6 * MB });
    const refused = await try_("plans", 6 * MB);
    expect(refused).toEqual({ ok: false, message: expect.stringContaining("6 MB of the 10 MB storage limit is used") });
    expect(await try_("plans", 4 * MB)).toMatchObject({ ok: true });
  });

  it("lets uploads go when the numbers can't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failing = async () => {
        throw new Error("database down");
      };
      expect(await reserveStorage(failing, { company: CO, user: ANA, folder: "plans", bytes: MB })).toMatchObject({ ok: true });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the database's numbers", () => {
  /** A service-role client: the membership asked about, and storage_snapshot's row. */
  function admin(role: string | null, row: object = { company_used: 1200, company_limit: 45e9, user_used: 300, user_limit: null, user_is_owner: false }) {
    const calls: unknown[] = [];
    const chain = (filters: unknown[]): unknown => ({
      select: () => chain(filters),
      eq: (column: string, value: unknown) => chain([...filters, [column, value]]),
      maybeSingle: async () => {
        calls.push(["memberships", filters]);
        return { data: role ? { role } : null, error: null };
      },
    });
    const db = {
      from: (table: string) => {
        expect(table).toBe("memberships");
        return chain([]);
      },
      rpc: async (name: string, args: unknown) => {
        calls.push([name, args]);
        return { data: [row], error: null };
      },
    } as unknown as Db;
    return { db, calls };
  }

  it("come from storage_snapshot, as the server, for someone on the company's team", async () => {
    const { db, calls } = admin("office");
    expect(await snapshotsFrom(() => db)(CO, ANA)).toEqual({ companyUsed: 1200, companyLimit: 45e9, userUsed: 300, userLimit: null, owner: false, member: true });
    expect(calls).toEqual([
      ["memberships", [["company_id", CO], ["user_id", ANA], ["active", true]]],
      ["storage_snapshot", { p_company: CO, p_user: ANA }],
    ]);
  });

  it("aren't added up at all for anyone else: not a member, or a sub", async () => {
    for (const role of [null, "subcontractor"]) {
      const { db, calls } = admin(role);
      expect(await snapshotsFrom(() => db)(CO, ANA)).toMatchObject({ member: false, companyLimit: null, userLimit: null });
      expect(calls.map((c) => (c as unknown[])[0])).toEqual(["memberships"]);
    }
  });

  it("say why when the database refuses", async () => {
    const db = {
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "owner" }, error: null }) }) }) }) }) }),
      rpc: async () => ({ data: null, error: { message: "permission denied for function storage_snapshot" } }),
    } as unknown as Db;
    await expect(snapshotsFrom(() => db)(CO, ANA)).rejects.toThrow("permission denied");
  });

  it("don't hold an upload up when the database is slow", async () => {
    vi.useFakeTimers();
    const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => new Promise(() => undefined) }) }) }) }) }) } as unknown as Db;
    const reading = snapshotsFrom(() => db)(CO, ANA);
    const caught = expect(reading).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(5_000);
    await caught;
  });
});

describe("refusing at the gateway", () => {
  const full = async (): Promise<StorageSnapshot> => ({ companyUsed: 45e9, companyLimit: 45e9, userUsed: 0, userLimit: null, owner: false, member: true });

  it("answers 507 the way Storage answers its own errors, and never sends the upload on", async () => {
    const send = vi.fn(async () => new Response("stored"));
    const res = await guardStorage(full, SECRET, tus(`${CO}/plans/a.pdf`, { "Upload-Length": "20000000" }), send);
    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({
      statusCode: "507",
      error: "Storage full",
      message: "This 20 MB file doesn't fit: 45 GB of the 45 GB storage limit is used. An owner or admin can raise it in Settings → Storage, or empty the Trash.",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("reads nothing, and says nothing, for a token that isn't genuine: Storage turns it down itself", async () => {
    const source = vi.fn(full);
    const send = vi.fn(async () => new Response("refused by Storage", { status: 403 }));
    const res = await guardStorage(source, SECRET, tus(`${CO}/plans/a.pdf`, { Authorization: `Bearer ${forged({ sub: BEN, role: "authenticated", exp: LATER })}` }), send);
    expect(res.status).toBe(403);
    expect(source).not.toHaveBeenCalled();
  });

  it("sends everything else on as it is", async () => {
    const source = vi.fn();
    const send = vi.fn(async (r: Request) => new Response(r.method));
    const read = request("POST", `/storage/v1/object/sign/files/${CO}/plans/a.pdf`, { Authorization: `Bearer ${ana}` });
    expect(await (await guardStorage(source, SECRET, read, send)).text()).toBe("POST");
    expect(source).not.toHaveBeenCalled();
  });
});
