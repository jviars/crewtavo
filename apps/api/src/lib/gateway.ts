/**
 * Gateway to the instance's Supabase services, in place of Supabase's own API gateway: the browser
 * and supabase-js use this server's address as the Supabase URL (server.ts mounts it in stack mode;
 * see lib/stack.ts).
 */
import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import { guardAssistant } from "./assistants";
import { guardSignIn, isGuessable } from "./signInGuard";
import type { Stack } from "./stack";
import { connectionOf, visitorIp } from "./visitor";

type Gateway = { Bindings: HttpBindings };

export function gateway(env: Env, stack: Stack) {
  const routes = new Hono<Gateway>();
  const visitor = (c: Context<Gateway>) => visitorIp(env, c.req.raw.headers, connectionOf(c.env));
  // An AI assistant's token only reads here unless the person allowed it to change things, and never
  // changes their sign-in (lib/assistants.ts).
  routes.all("/auth/v1/*", (c) => {
    const address = visitor(c);
    const send = (request: Request) => forward(request, stack.auth, "/auth/v1", address);
    return guardAssistant(env, c.req.raw, "/auth/v1", (request) => (isGuessable(request.method, new URL(request.url), "/auth/v1") ? guardSignIn(env, request, send) : send(request)));
  });
  routes.all("/rest/v1/*", (c) => guardAssistant(env, c.req.raw, "/rest/v1", (request) => forward(request, stack.rest, "/rest/v1", visitor(c))));
  routes.all("/storage/v1/*", (c) => guardAssistant(env, c.req.raw, "/storage/v1", (request) => forward(request, stack.storage, "/storage/v1", visitor(c), { "x-forwarded-prefix": "/storage/v1" })));
  return routes;
}

async function forward(request: Request, upstream: string, prefix: string, visitor: string, extra: Record<string, string> = {}): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(upstream);
  target.pathname = target.pathname.replace(/\/$/, "") + (incoming.pathname.slice(prefix.length) || "/");
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  // Hop-by-hop headers describe the browser's connection to this server, not the next one (fetch
  // refuses some of them outright, e.g. a chunked upload's transfer-encoding or expect: 100-continue).
  for (const name of ["host", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "expect", "proxy-authorization", "proxy-connection", "accept-encoding", "content-length"]) headers.delete(name);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", request.headers.get("x-forwarded-proto") ?? incoming.protocol.replace(":", ""));
  // The visitor's address as this deployment's proxy gave it, not whatever the visitor sent: Auth
  // records it with each sign-in (from the first X-Forwarded-For entry), and Storage logs it.
  headers.set("x-forwarded-for", visitor);
  headers.set("x-real-ip", visitor);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const res = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: "manual",
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
    const out = new Headers(res.headers);
    // fetch already decoded the body.
    for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) out.delete(name);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (error) {
    console.error(`Gateway: ${target.host} didn't answer`, (error as Error).message);
    return Response.json({ message: "This part of Crewtavo is still starting. Try again in a moment." }, { status: 503 });
  }
}
