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
 *     and each visitor's changes, their size and their uploads are limited (demoGuard,
 *     gatewayRefusal), so one can't fill the database or the disk.
 *
 * None of it applies anywhere else. It takes two settings, CREWTAVO_DEMO=1 and
 * CREWTAVO_SINGLE_COMPANY=0: an instance holds one business unless told otherwise, so CREWTAVO_DEMO
 * set by mistake on a real business's Crewtavo does nothing.
 */
import { FILE_DEFAULTS } from "@crewtavo/core/storage";
import type { Context, Next } from "hono";
import type { AppEnv, Env } from "../env";
import { allow } from "./limit";
import type { SnapshotSource } from "./storageLimits";
import { adminClient } from "./supabase";
import { clientIp } from "./visitor";

export const isDemo = (env: Pick<Env, "CREWTAVO_DEMO" | "CREWTAVO_SINGLE_COMPANY">): boolean => env.CREWTAVO_DEMO === "1" && env.CREWTAVO_SINGLE_COMPANY === "0";

/** What a visitor is told when they reach for something the demo doesn't do. */
export const DEMO_OFF = "That's turned off in the demo, because it would reach outside it. In your own Crewtavo it works here.";

/** A demo business's files, all together: room for a few dozen photos (the app shrinks them first). */
export const DEMO_STORAGE_BYTES = 25 * 1024 * 1024;
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
  // Push messages go to whatever address a browser gives, so the demo sends none.
  [WRITES, /^\/api\/push\//],
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

/** The most one request may carry in the demo, to the database or a website form: a big quote with its photos' details is a few hundred KB. */
export const DEMO_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Middleware for the app: in the demo, refuses BLOCKED routes with DEMO_OFF, and counts the
 * visitor's changes with the ones they make through the gateway. A website form's post (which can
 * carry an applicant's files, stored by the server) is held to DEMO_BODY_BYTES. Everywhere else it
 * does nothing.
 */
export async function demoGuard(c: Context<AppEnv>, next: Next) {
  if (!isDemo(c.env)) return next();
  const method = c.req.method.toUpperCase();
  if (demoBlocks(method, c.req.path)) return c.json({ error: DEMO_OFF, code: "demo" }, 403);
  if (WRITES.includes(method)) {
    if (/^\/f\//.test(c.req.path) && Number(c.req.header("content-length") ?? 0) > DEMO_BODY_BYTES) {
      return c.json({ error: `That's more than the demo takes at once (${DEMO_BODY_BYTES / 1024 / 1024} MB).` }, 413);
    }
    // Starting a demo has limits of its own (routes/demo.ts).
    if (c.req.path !== "/api/demo/start" && !(await allow(c.env, `demo-write:${clientIp(c)}`, WRITE_LIMIT, WRITE_WINDOW_SECONDS))) {
      return c.json({ error: TOO_MANY, code: "demo" }, 429, { "Retry-After": "120" });
    }
  }
  return next();
}

/** How many changes one visitor's address may make in WRITE_WINDOW, in the app and through the gateway: clicking around makes a few a minute. */
const WRITE_LIMIT = 1200;
const WRITE_WINDOW_SECONDS = 600;
/** How many files one visitor's address may upload in an hour: a few dozen photos is a lot for a demo. */
const UPLOAD_LIMIT = 60;
const TOO_MANY = "That's a lot of changes at once for the demo. Wait a few minutes and carry on.";

/**
 * The gateway's part (lib/gateway.ts), for a request to /rest/v1 or /storage/v1 in the demo: a
 * response refusing it, or null to let it through.
 *   - The database's own GraphQL is refused: the app doesn't use it.
 *   - Setting up a business straight through the database is refused once the person has one: the
 *     demo sets up each visitor's (services/demo.ts), and a second would only be theirs to fill.
 *   - A change to the database is at most DEMO_BODY_BYTES and says how big it is, and a file is at
 *     most DEMO_FILE_BYTES.
 *   - Changes and uploads are counted by the visitor's address, so a script can't fill the database
 *     or the disk. The server's own (setting up a visitor's business) aren't: they come in on this
 *     machine's own connection, or with the server's key. Never by an address a header gave.
 * `who` reads whose a request's token is (checked as the services check it); `connection` is the
 * address the request's connection itself comes from.
 */
export async function gatewayRefusal(
  env: Env,
  request: Request,
  visitor: string,
  who: (request: Request) => { user: string | null; server: boolean },
  connection: string | undefined,
): Promise<Response | null> {
  if (!isDemo(env)) return null;
  const caller = who(request);
  const fromServer = caller.server || isLoopback(connection);
  const path = gatewayPath(new URL(request.url).pathname);
  const method = request.method.toUpperCase();
  if (path.startsWith("/rest/v1/rpc/graphql")) return Response.json({ code: "demo", message: DEMO_OFF }, { status: 403 });
  if (path.startsWith("/rest/v1/rpc/create_company") && (await hasBusiness(env, caller.user))) {
    return Response.json({ code: "demo", message: "The demo comes with one business. Start a new demo for another trade." }, { status: 403 });
  }
  if (!WRITES.includes(method) || fromServer) return null;
  const storage = path.startsWith("/storage/v1/");
  if (!storage) {
    const length = request.headers.get("content-length");
    if (length === null && method !== "DELETE") return Response.json({ code: "demo", message: "Send the change's size (Content-Length)." }, { status: 411 });
    if (Number(length ?? 0) > DEMO_BODY_BYTES) return Response.json({ code: "demo", message: `That's more than the demo takes at once (${DEMO_BODY_BYTES / 1024 / 1024} MB).` }, { status: 413 });
  } else if (method !== "DELETE") {
    if (declaredSize(request.headers) > DEMO_FILE_BYTES + 64 * 1024) {
      return Response.json({ statusCode: "413", error: "Payload too large", message: `Files in the demo can be up to ${DEMO_FILE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    }
    // A new file (a resumable upload's pieces after its first request are the same file).
    if (method === "POST" && !(await allow(env, `demo-upload:${visitor}`, UPLOAD_LIMIT, 3600))) {
      return Response.json({ statusCode: "429", error: "Too many uploads", message: "That's a lot of files for the demo. Try again in an hour." }, { status: 429, headers: { "Retry-After": "600" } });
    }
  }
  if (!(await allow(env, `demo-write:${visitor}`, WRITE_LIMIT, WRITE_WINDOW_SECONDS))) {
    return Response.json({ code: "demo", message: TOO_MANY }, { status: 429, headers: { "Retry-After": "120" } });
  }
  return null;
}

/** This machine itself: the server asking its own gateway (lib/stack.ts points it there). */
function isLoopback(address: string | undefined): boolean {
  const a = (address ?? "").toLowerCase().replace(/^::ffff:/, "");
  return a === "::1" || /^127\./.test(a);
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
