/**
 * An answer sent before a large upload has arrived (a 404, 401 or 413) closes the connection, so
 * the next request on it isn't reset, and closes it gently, so the client sending the upload still
 * gets the answer.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import { type AddressInfo, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  app.post("/refuse", (c) => c.json({ error: "Sign in first." }, 401));
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

/** A request written in one go, headers and body, and the headers of the answer. */
function raw(port: number, request: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    let text = "";
    socket.on("data", (d) => {
      text += d;
      if (text.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase());
      }
    });
    socket.on("error", reject);
  });
}

const BIG = "x".repeat(3 * 1024 * 1024);
const client = fileURLToPath(new URL("./fixtures/upload-client.mjs", import.meta.url));

describe("answers sent before the body arrives", () => {
  it("close the connection, so the next request goes on a fresh one", async () => {
    const port = await start(true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const refused = await send(agent, port, "POST", "/upload", BIG);
    expect(refused).toMatchObject({ status: 413, connection: "close" });
    expect(await send(agent, port, "GET", "/next")).toMatchObject({ status: 200 });
    agent.destroy();
  });

  it("still reach a client that's in the middle of sending the upload, and the next request gets through", async () => {
    const port = await start(true);
    const { stdout } = await promisify(execFile)(process.execPath, [client, String(port), String(5_000_000), "12"]);
    expect(JSON.parse(stdout)).toEqual(Array(12).fill([413, 200]));
  }, 60_000);

  it("leave connections that read their body, and plain GETs, open", async () => {
    const port = await start(true);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    expect(await send(agent, port, "POST", "/read", BIG)).toMatchObject({ status: 200, connection: "keep-alive" });
    expect(await send(agent, port, "GET", "/next")).toMatchObject({ status: 200, connection: "keep-alive", reused: true });
    expect(await send(agent, port, "POST", "/read", "{}")).toMatchObject({ status: 200, connection: "keep-alive", reused: true });
    agent.destroy();
  });

  it("leave the connection open when a small body had all arrived, even if it's answered straight away", async () => {
    const port = await start(true);
    const head = await raw(port, 'POST /refuse HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
    expect(head).toMatch(/^http\/1\.1 401/);
    expect(head).toContain("connection: keep-alive");
  });
});
