/**
 * The public demo's limits (CREWTAVO_DEMO=1; docs/demo.md). Anyone on the internet gets an owner's
 * sign-in to a business of their own there, so in the demo:
 *
 *   - nothing leaves the server: email and texts look sent but go nowhere (lib/notify.ts), and push
 *     messages, postcards, AI, Stripe and every connection to an outside account are off;
 *   - nothing is set up that would reach out later: the routes in BLOCKED refuse, and the
 *     background tasks in SKIPPED_TASKS (calendars, social posts, website checks...) don't run;
 *   - nobody gets an account the demo didn't make: no invites, sub sign-ins or sign-in links, and
 *     no second business;
 *   - each business holds a few photos, not a file store (DEMO_STORAGE_BYTES, lib/storageLimits.ts),
 *     and each visitor's writes are limited (gatewayRefusal), so one can't fill the database.
 *
 * None of it applies anywhere else: isDemo is false unless CREWTAVO_DEMO is "1", and it's never on
 * for an instance that holds one business (CREWTAVO_SINGLE_COMPANY=1, a real business's Crewtavo).
 */
import { FILE_DEFAULTS } from "@crewtavo/core/storage";
import type { Context, Next } from "hono";
import type { AppEnv, Env } from "../env";
import { allow } from "./limit";
import type { SnapshotSource } from "./storageLimits";
import { adminClient } from "./supabase";

export const isDemo = (env: Pick<Env, "CREWTAVO_DEMO" | "CREWTAVO_SINGLE_COMPANY">): boolean => env.CREWTAVO_DEMO === "1" && env.CREWTAVO_SINGLE_COMPANY !== "1";

/** What a visitor is told when they reach for something the demo doesn't do. */
export const DEMO_OFF = "That's turned off in the demo, because it would reach outside it. In your own Crewtavo it works here.";

/** A demo business's files, all together: room for a few dozen photos. */
export const DEMO_STORAGE_BYTES = 50 * 1024 * 1024;
/** One file, at most. */
export const DEMO_FILE_BYTES = 10 * 1024 * 1024;

/** Background tasks that reach outside the server or look after hosting, which the demo has none of. */
export const SKIPPED_TASKS: ReadonlySet<string> = new Set([
  "calendars", "website", "review_sync", "review_tidy", "social", "postcards", "railway", "hosting", "backups", "address", "chatgpt_plans", "pins",
]);

const WRITES = ["POST", "PUT", "PATCH", "DELETE"];
const ANY = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Routes the demo refuses, by method and path (the app's own; the gateway's are below). */
const BLOCKED: ReadonlyArray<readonly [readonly string[], RegExp]> = [
  // Connecting outside accounts and saving their keys: Apps (Stripe, Twilio, Lob, Claude, ChatGPT,
  // Google, Meta, QuickBooks, Zoho, ABC Supply...), email, calendars, website form checks, Drive.
  [WRITES, /^\/api\/apps\//],
  [WRITES, /^\/api\/ai\//],
  [WRITES, /^\/api\/kb\/ask$/],
  [WRITES, /^\/api\/email(\/|$)/],
  [WRITES, /^\/api\/calendars(\/|$)/],
  [WRITES, /^\/api\/website-forms\/turnstile$/],
  [WRITES, /^\/api\/drive\/(enabled|import)$/],
  [WRITES, /^\/api\/analytics\/check$/],
  [WRITES, /^\/api\/assistants\//],
  [ANY, /^\/mcp(\/|$)/],
  // Paid services: postcards, reading receipts and finding paving with AI, Google's roof data.
  [WRITES, /^\/api\/postcards(\/|$)/],
  [WRITES, /^\/api\/receipts\/read$/],
  [WRITES, /^\/api\/paving\/detect$/],
  [WRITES, /^\/api\/roof-insights$/],
  // Accounts: the demo makes every one there is.
  [WRITES, /^\/api\/companies$/],
  [WRITES, /^\/api\/team\/invite$/],
  [WRITES, /^\/api\/team\/[^/]+\/(invite-link|password-link)$/],
  [WRITES, /^\/api\/subs\/[^/]+\/(access|sign-in-link|send-upload-link)$/],
  [ANY, /^\/api\/auth\/(email-link|text-code|email-code|recover)(\/|$)/],
  [ANY, /^\/api\/setup(\/|$)/],
];

/** Is this request one the demo refuses? Exported for the tests. */
export function demoBlocks(method: string, path: string): boolean {
  const clean = path.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1").toLowerCase();
  return BLOCKED.some(([methods, pattern]) => methods.includes(method.toUpperCase()) && pattern.test(clean));
}

/** Middleware for the app: in the demo, refuses BLOCKED routes with DEMO_OFF. Everywhere else it does nothing. */
export async function demoGuard(c: Context<AppEnv>, next: Next) {
  if (isDemo(c.env) && demoBlocks(c.req.method, c.req.path)) return c.json({ error: DEMO_OFF, code: "demo" }, 403);
  return next();
}

/** How many changes one visitor's address may make through the gateway in WRITE_WINDOW: clicking around makes a few a minute. */
const WRITE_LIMIT = 1200;
const WRITE_WINDOW_SECONDS = 600;

/**
 * The gateway's part (lib/gateway.ts), for a request to /rest/v1 or /storage/v1 in the demo: a
 * response refusing it, or null to let it through.
 *   - The database's own GraphQL is refused: the app doesn't use it.
 *   - Setting up a business straight through the database is refused once the person has one: the
 *     demo sets up each visitor's (services/demo.ts), and a second would only be theirs to fill.
 *   - A file over DEMO_FILE_BYTES is refused before it's sent.
 *   - Changes are counted by the visitor's address, so a script can't fill the database. The
 *     server's own (setting up a visitor's business) aren't: they come from this machine, or with
 *     the server's key.
 * `who` reads whose a request's token is (checked as the services check it).
 */
export async function gatewayRefusal(env: Env, request: Request, visitor: string, who: (request: Request) => { user: string | null; server: boolean }): Promise<Response | null> {
  if (!isDemo(env)) return null;
  const caller = who(request);
  const fromServer = caller.server || visitor === "127.0.0.1" || visitor === "::1";
  const path = gatewayPath(new URL(request.url).pathname);
  const method = request.method.toUpperCase();
  if (path.startsWith("/rest/v1/rpc/graphql")) return Response.json({ code: "demo", message: DEMO_OFF }, { status: 403 });
  if (path.startsWith("/rest/v1/rpc/create_company") && (await hasBusiness(env, caller.user))) {
    return Response.json({ code: "demo", message: "The demo comes with one business. Start a new demo for another trade." }, { status: 403 });
  }
  if (!WRITES.includes(method)) return null;
  if (path.startsWith("/storage/v1/") && method !== "DELETE" && declaredSize(request.headers) > DEMO_FILE_BYTES + 64 * 1024) {
    return Response.json({ statusCode: "413", error: "Payload too large", message: `Files in the demo can be up to ${DEMO_FILE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
  }
  if (!fromServer && !(await allow(env, `demo-write:${visitor}`, WRITE_LIMIT, WRITE_WINDOW_SECONDS))) {
    return Response.json({ code: "demo", message: "That's a lot of changes at once for the demo. Wait a few minutes and carry on." }, { status: 429, headers: { "Retry-After": "120" } });
  }
  return null;
}

/** What an upload says it is: a resumable upload's whole length, else the request's. */
function declaredSize(headers: Headers): number {
  const size = Number(headers.get("upload-length") ?? headers.get("content-length") ?? 0);
  return Number.isFinite(size) ? size : 0;
}

/** Does this person belong to a business already? Someone unknown counts as yes: nobody else gets to make one. */
async function hasBusiness(env: Env, userId: string | null): Promise<boolean> {
  if (!userId) return true;
  const { count, error } = await adminClient(env).from("memberships").select("user_id", { count: "exact", head: true }).eq("user_id", userId);
  return Boolean(error) || (count ?? 0) > 0;
}

/**
 * The storage limits' numbers in the demo (lib/storageLimits.ts): the business's limit is never
 * more than DEMO_STORAGE_BYTES, whatever its owner set in Settings → Storage, and a video is never
 * more than a file may be.
 */
export function demoSnapshots(source: SnapshotSource): SnapshotSource {
  return async (company, user) => {
    const snapshot = await source(company, user);
    const limit = snapshot.companyLimit == null ? DEMO_STORAGE_BYTES : Math.min(snapshot.companyLimit, DEMO_STORAGE_BYTES);
    const files = snapshot.files ?? FILE_DEFAULTS;
    return { ...snapshot, companyLimit: limit, files: { ...files, videoMaxBytes: Math.min(files.videoMaxBytes, DEMO_FILE_BYTES) } };
  };
}

/** A path as PostgREST and Storage would read it: escapes decoded, doubled and trailing slashes dropped, lower case. */
function gatewayPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // They turn away a path they can't read.
  }
  return path.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1").toLowerCase();
}
