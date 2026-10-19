/**
 * Uploads through the gateway (lib/gateway.ts): Storage checks a file sent as the bare body against
 * FILE_SIZE_LIMIT by its Content-Length, so the gateway passes that on, and refuses a bare upload
 * that doesn't say how big it is. Forms (what supabase-js and the plans uploader send) Storage checks
 * as they arrive.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { gateway, unsizedUpload } from "../src/lib/gateway";

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_SECRET_KEY: "sb_secret_test" };
const from = { incoming: { socket: { remoteAddress: "127.0.0.1" } } } as unknown as HttpBindings;

// A stand-in for Auth and Storage: answers with what it was sent.
let upstream: http.Server;
let base = "";
beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let bytes = 0;
    let text = "";
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (text.length < 500) text += chunk.toString("utf8");
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url, length: req.headers["content-length"] ?? null, chunked: req.headers["transfer-encoding"] === "chunked", bytes, text }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const routes = () => gateway(env, { auth: base, rest: base, storage: base });
const stream = (bytes: number) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });

describe("uploads through the gateway", () => {
  it("tells Storage how big a file sent as the body is", async () => {
    const res = await routes().request("/storage/v1/object/files/co/plans/a.pdf", {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "Content-Length": "4096" },
      body: stream(4096),
      duplex: "half",
    } as RequestInit, from);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "/object/files/co/plans/a.pdf", length: "4096", chunked: false, bytes: 4096 });
  });

  it("refuses a file sent as the body without its size, so it can't get past the limit", async () => {
    const res = await routes().request("/storage/v1/object/files/co/plans/a.pdf", { method: "POST", headers: { "Content-Type": "application/pdf" }, body: stream(4096), duplex: "half" } as RequestInit, from);
    expect(res.status).toBe(411);
    expect((await res.json()).message).toMatch(/size/);
  });

  it("passes a form on without its size: Storage checks the file in it as it arrives", async () => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", new Blob([new Uint8Array(2048)], { type: "application/pdf" }), "plan.pdf");
    const body = new Request("http://x", { method: "POST", body: form });
    const res = await routes().request("/storage/v1/object/files/co/plans/b.pdf", {
      method: "POST",
      headers: { "Content-Type": body.headers.get("content-type")! },
      body: body.body,
      duplex: "half",
    } as RequestInit, from);
    expect(res.status).toBe(200);
    expect((await res.json()).bytes).toBeGreaterThan(2048);
  });

  it("still forwards a sign-in the guard rewrote, with its own length", async () => {
    const res = await routes().request("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999" },
      body: JSON.stringify({ email: "ana@example.com", password: "right", extra: "x".repeat(40) }),
    }, from);
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(JSON.parse(got.text)).toEqual({ email: "ana@example.com", password: "right" });
  });

  it("knows which requests are unsized uploads", () => {
    const req = (method: string, headers: Record<string, string>, body: BodyInit | null = "x") => new Request("http://x/storage/v1/object/a", { method, headers, body, duplex: "half" } as RequestInit);
    expect(unsizedUpload(req("POST", { "content-type": "image/jpeg" }, stream(1) as unknown as BodyInit))).toBe(true);
    expect(unsizedUpload(req("PUT", { "content-type": "application/octet-stream", "content-length": "1" }))).toBe(false);
    expect(unsizedUpload(req("POST", { "content-type": "multipart/form-data; boundary=x" }, stream(1) as unknown as BodyInit))).toBe(false);
    expect(unsizedUpload(new Request("http://x/storage/v1/object/a"))).toBe(false);
    expect(unsizedUpload(req("DELETE", {}, null))).toBe(false);
  });
});
