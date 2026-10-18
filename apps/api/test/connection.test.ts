/**
 * An answer sent before a large upload has arrived (a 404, 401 or 413) closes the connection, so
 * the next request on it isn't reset. (The reset itself needs the client in another process, where
 * the answer arrives before the upload has been sent: scripts against a running instance show it.)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { closeAfterUnreadBodies } from "../src/lib/connection";

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/**
 * The server the app runs on (@hono/node-server): /upload is refused without reading it, like the
 * size limit or a 404, /read reads its body, anything else just answers.
 */
async function start(hooked: boolean) {
  const app = new Hono();
  app.post("/upload", (c) => c.json({ error: "too large" }, 413));
  app.post("/read", async (c) => c.text(`read ${(await c.req.text()).length}`));
  app.get("*", (c) => c.text("ok"));
  const server = await new Promise<http.Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s as http.Server));
  });
  if (hooked) closeAfterUnreadBodies(server);
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function send(agent: http.Agent, port: number, method: string, path: string, body?: string) {
  return new Promise<{ status?: number; connection?: string; reused: boolean; error?: string }>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, agent, headers: body ? { "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection, reused: req.reusedSocket }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code, reused: req.reusedSocket }));
    if (body) req.write(body);
    req.end();
  });
}

const BIG = "x".repeat(3 * 1024 * 1024);

describe("answers sent before the body arrives", () => {
  it("close the connection, so the next request goes on a fresh one", async () => {
    const port = await start(true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const refused = await send(agent, port, "POST", "/upload", BIG);
    expect(refused).toMatchObject({ status: 413, connection: "close" });
    expect(await send(agent, port, "GET", "/next")).toMatchObject({ status: 200 });
    agent.destroy();
  });

  it("leave connections that read their body, and plain GETs, open", async () => {
    const port = await start(true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await send(agent, port, "POST", "/read", BIG)).toMatchObject({ status: 200, connection: "keep-alive" });
    expect(await send(agent, port, "GET", "/next")).toMatchObject({ status: 200, connection: "keep-alive", reused: true });
    expect(await send(agent, port, "POST", "/read", "{}")).toMatchObject({ status: 200, connection: "keep-alive", reused: true });
    agent.destroy();
  });
});
