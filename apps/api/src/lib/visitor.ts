/**
 * The visitor's address, for rate limits, quote approval records and what the gateway tells Auth
 * and Storage (lib/gateway.ts). Only what this deployment's own proxy says counts: anyone can send
 * X-Real-IP or X-Forwarded-For, and a proxy passes on (or adds to) whatever it was sent.
 *
 *   On Railway   X-Real-IP, which Railway's edge sets on every request in place of the visitor's.
 *                Nothing reaches a Railway service from the internet without going through it.
 *   Elsewhere    the last X-Forwarded-For entry, which the web server in front adds (Caddy does by
 *                itself), but only on connections from this machine or a private network, where
 *                that web server connects from. A connection from anywhere else came straight to
 *                the port, so its own address counts. With Docker, the web server's connections
 *                and some outside ones (over IPv6, or all of them on Docker Desktop) arrive from
 *                Docker's own network address, so docker-compose.yml publishes the port on this
 *                machine only (CREWTAVO_BIND).
 *
 * CREWTAVO_VISITOR_IP says what else is in front (docs/deploy.md). Set, it's believed on every
 * connection:
 *   x-forwarded-for:2   two proxies add to X-Forwarded-For (say Cloudflare, then Caddy): the visitor
 *                       is the second entry from the end
 *   cf-connecting-ip    the header a proxy sets to the visitor's address (any name, such as x-real-ip
 *                       behind nginx; a list counts from the end too)
 *   connection          nothing in front: the connection's own address
 */
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { platformOf } from "./address";

interface Rule {
  /** The header the proxy sets, or null for the connection's own address. */
  header: string | null;
  /** Which entry is the visitor's, counting from the end (the proxy nearest this server adds last). */
  fromEnd: number;
  /** Believe the header only on connections from this machine or a private network. */
  privateOnly: boolean;
}

let warnedAbout: string | undefined;

function visitorRule(env: Env): Rule {
  const setting = env.CREWTAVO_VISITOR_IP?.trim().toLowerCase();
  if (setting === "connection") return { header: null, fromEnd: 1, privateOnly: false };
  const named = setting ? /^([a-z0-9-]+)(?::(\d{1,2}))?$/.exec(setting) : null;
  if (named && Number(named[2] ?? 1) >= 1) return { header: named[1]!, fromEnd: Number(named[2] ?? 1), privateOnly: false };
  if (setting && warnedAbout !== setting) {
    warnedAbout = setting;
    console.warn(`CREWTAVO_VISITOR_IP=${setting} isn't something Crewtavo understands (see docs/deploy.md), so it goes by the default.`);
  }
  return platformOf(env) === "railway"
    ? { header: "x-real-ip", fromEnd: 1, privateOnly: false }
    : { header: "x-forwarded-for", fromEnd: 1, privateOnly: true };
}

/** The visitor's address, from the request's headers and the address its connection comes from. */
export function visitorIp(env: Env, headers: Headers, connection: string | undefined): string {
  const rule = visitorRule(env);
  const own = normalized(connection);
  if (rule.header && (!rule.privateOnly || (own && isPrivate(own)))) {
    const entries = (headers.get(rule.header) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    // Fewer entries than proxies: a request that skipped the outer one, so the first is the visitor.
    const ip = normalized(entries[Math.max(entries.length - rule.fromEnd, 0)]);
    if (ip) return ip;
  }
  return own ?? "unknown";
}

/** The address a request's connection comes from (server.ts passes the connection along). */
export const connectionOf = (bindings: { incoming?: IncomingMessage }) => bindings.incoming?.socket?.remoteAddress;

/** The visitor's address for a request to the app. */
export function clientIp(c: Context<AppEnv>): string {
  return visitorIp(c.env, c.req.raw.headers, connectionOf(c.env));
}

/** An address as one spelling (no port, brackets or IPv4-in-IPv6 prefix), or null when it isn't one. */
function normalized(value: string | undefined): string | null {
  if (!value) return null;
  let ip = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) ip = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (/^::ffff:[\d.]+$/i.test(ip)) ip = ip.slice(7);
  return isIP(ip) ? ip.toLowerCase() : null;
}

/** Loopback, private networks (Docker's included), carrier-grade NAT and link-local addresses. */
const PRIVATE = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["100.64.0.0", 10], ["169.254.0.0", 16]] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [["::1", 128], ["fc00::", 7], ["fe80::", 10]] as const) PRIVATE.addSubnet(network, prefix, "ipv6");

const isPrivate = (ip: string) => PRIVATE.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
