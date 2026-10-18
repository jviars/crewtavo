/**
 * The addresses this instance answers on. APP_URL is the one it puts in links; the platform's own
 * address (https://$RAILWAY_PUBLIC_DOMAIN) and every address it had before a switch in Settings →
 * Web address keep working, because links, calendar feeds, webhooks and assistant connectors may
 * still use them. Once a switch is done, pages opened on an old address forward to the new one.
 */
import type { AddressPlatform } from "@crewtavo/core";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { instanceFingerprint } from "./crypto";
import { appUrl } from "./http";
import { adminClient } from "./supabase";

export function platformOf(env: Env): AddressPlatform {
  if (env.RAILWAY_PROJECT_ID || env.RAILWAY_PUBLIC_DOMAIN) return "railway";
  return env.CREWTAVO_PLATFORM === "compose" ? "compose" : "server";
}

/** Railway's pages for this service, for doing a step by hand. Null off Railway. */
export function railwayLinks(env: Env) {
  const { RAILWAY_PROJECT_ID: project, RAILWAY_SERVICE_ID: service, RAILWAY_ENVIRONMENT_ID: environment } = env;
  if (!project || !service || !environment) return null;
  const base = `https://railway.com/project/${project}`;
  return {
    settingsUrl: `${base}/service/${service}/settings?environmentId=${environment}`,
    variablesUrl: `${base}/service/${service}/variables?environmentId=${environment}`,
    tokensUrl: `${base}/settings/tokens?environmentId=${environment}`,
  };
}

export const originOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

interface History {
  at: number;
  /** Every address that reaches this instance. */
  origins: Set<string>;
  /** Old addresses whose pages forward to APP_URL (a switch here is done). */
  forward: Set<string>;
}

let history: History | null = null;

/** Call after a change to web_address, so the next request sees it. */
export const forgetAddressHistory = () => {
  history = null;
};

export async function addressHistory(env: Env): Promise<History> {
  if (history && Date.now() - history.at < 60_000) return history;
  const current = originOf(env.APP_URL);
  const origins = new Set<string>();
  const forward = new Set<string>();
  if (current) origins.add(current);
  if (env.RAILWAY_PUBLIC_DOMAIN) origins.add(`https://${env.RAILWAY_PUBLIC_DOMAIN}`);
  try {
    const { data, error } = await adminClient(env).from("web_address").select("domain, status, from_url, previous_urls").abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const before = [row.from_url, ...row.previous_urls].map(originOf).filter((o): o is string => Boolean(o));
      for (const origin of before) origins.add(origin);
      if (row.status === "done" && current === `https://${row.domain}`) for (const origin of before) if (origin !== current) forward.add(origin);
    }
  } catch (error) {
    // Webhooks and pages still work with just APP_URL and the platform's address; try again soon.
    console.error("Couldn't read the instance's earlier addresses", (error as Error).message);
    history = { at: Date.now(), origins, forward };
    return history;
  }
  history = { at: Date.now(), origins, forward };
  return history;
}

/** The address this request came in on, as the visitor sees it (behind Railway's proxy, too). */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The request's own address when it's one of this instance's, else APP_URL: what a client asked about. */
export async function ownOrigin(c: Context<AppEnv>): Promise<string> {
  const origin = requestOrigin(c.req.raw);
  const current = appUrl(c);
  if (origin === current) return current;
  return (await addressHistory(c.env)).origins.has(origin) ? origin : current;
}

/** Does https://domain answer as this instance? */
export async function reachesThisInstance(env: Env, domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}/.well-known/crewtavo-instance`, { redirect: "manual", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { instance?: string };
    return body.instance === (await instanceFingerprint(env));
  } catch {
    return false;
  }
}

/** Client links, webhooks and sign-in pages work on every address; only the app itself moves. */
const STAYS = /^\/(api|auth|rest|storage|mcp|\.well-known|assets|hub|book|u|refer|oauth)(\/|$)/;

/**
 * Where a page opened on an old address should go now, or null to serve it here. Only page loads
 * forward (never API calls), and only ever to APP_URL.
 */
export async function forwardTo(env: Env, request: Request): Promise<string | null> {
  if (request.method !== "GET" || !env.APP_URL || !(request.headers.get("accept") ?? "").includes("text/html")) return null;
  const url = new URL(request.url);
  if (STAYS.test(url.pathname)) return null;
  const origin = requestOrigin(request);
  if (!(await addressHistory(env)).forward.has(origin)) return null;
  return `${env.APP_URL.replace(/\/$/, "")}${url.pathname}${url.search}`;
}
