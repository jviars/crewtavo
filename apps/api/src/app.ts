/** The Hono app. server.ts serves it, with the web app and the background-task scheduler. */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./env";
import { bearerToken } from "./lib/auth";
import { safeEqual } from "./lib/crypto";
import { HttpError } from "./lib/http";
import { reportError } from "./lib/monitoring";
import { mcp } from "./mcp";
import { account } from "./routes/account";
import { analytics, pageViews } from "./routes/analytics";
import { address, addressWellKnown } from "./routes/address";
import { apps } from "./routes/apps";
import { automations } from "./routes/automations";
import { calendar } from "./routes/calendar";
import { chat } from "./routes/chat";
import { email } from "./routes/email";
import { jobPay } from "./routes/jobPay";
import { marketing } from "./routes/marketing";
import { materials } from "./routes/materials";
import { messages } from "./routes/messages";
import { pay } from "./routes/pay";
import { paving } from "./routes/paving";
import { publicRoutes } from "./routes/public";
import { push } from "./routes/push";
import { railway } from "./routes/railway";
import { roofing } from "./routes/roofing";
import { sales } from "./routes/sales";
import { schedule } from "./routes/schedule";
import { recovery } from "./routes/recovery";
import { setup } from "./routes/setup";
import { signInCodes } from "./routes/signInCodes";
import { signing } from "./routes/signing";
import { subOffers } from "./routes/subOffers";
import { subs } from "./routes/subs";
import { runTask, TASKS, type TaskName } from "./tasks";

export const app = new Hono<AppEnv>();

app.use(secureHeaders({ crossOriginResourcePolicy: false }));
// Bodies are read into memory, so one huge request could exhaust it. The biggest real one is a
// quote approval with a drawn signature (a few hundred KB); files go straight to Storage. Calendar
// files are the exception: their events are read from them (up to 10 MB of text, sent as JSON).
const tooLarge = (c: Context) => c.json({ error: "That's too large to send." }, 413);
const smallBody = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge });
const calendarFile = bodyLimit({ maxSize: 12 * 1024 * 1024, onError: tooLarge });
const CALENDAR_FILE = /^\/api\/calendars\/(file|[0-9a-f-]{36}\/file)$/i;
app.use((c, next) => (c.req.method === "POST" && CALENDAR_FILE.test(c.req.path) ? calendarFile(c, next) : smallBody(c, next)));
// MCP clients may run in a browser (for example the MCP Inspector).
app.use(
  "/mcp",
  cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version"], exposeHeaders: ["WWW-Authenticate"] }),
);
app.use("/.well-known/*", cors({ origin: "*" }));

app.route("/api", account);
app.route("/api", setup);
app.route("/api", recovery);
app.route("/api", signInCodes);
app.route("/api", schedule);
app.route("/api", sales);
app.route("/api", apps);
app.route("/api", automations);
app.route("/api", marketing);
app.route("/api", messages);
app.route("/api", pay);
app.route("/api", jobPay);
app.route("/api", paving);
app.route("/api", roofing);
app.route("/api", materials);
app.route("/api", signing);
app.route("/api", subs);
app.route("/api", subOffers);
app.route("/api", publicRoutes);
app.route("/api", calendar);
app.route("/api", chat);
app.route("/api", email);
app.route("/api", push);
app.route("/api", address);
app.route("/api", railway);
app.route("/api", analytics);
app.route("/", addressWellKnown);
app.route("/", mcp);
// Website analytics: the script for the business's website, and its page views (routes/analytics.ts).
app.route("/", pageViews);

/** Scheduled tasks over HTTP, for running one by hand (server.ts's scheduler calls runTask directly). */
app.on(["GET", "POST"], "/api/cron/:task", async (c) => {
  const secret = c.env.CRON_SECRET;
  const token = bearerToken(c.req.header("authorization"));
  if (!secret || !token || !safeEqual(token, secret)) throw new HttpError(401, "Unauthorized");
  const task = c.req.param("task") as TaskName;
  if (!TASKS.includes(task)) throw new HttpError(404, "Unknown task");
  return c.json({ task, ...(await runTask(task, c.env)) });
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(error);
  reportError(error, { route: c.req.routePath, method: c.req.method });
  return c.json({ error: "Something went wrong. Try again." }, 500);
});
