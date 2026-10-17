/** Phone and browser push: the public key to subscribe with, saving and removing a device, and a test. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { appUrl, dbError, HttpError, must, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { sendPush, vapidKeys } from "../lib/webpush";

export const push = new Hono<AppEnv>();

push.get("/push/key", requireUser, async (c) => c.json({ publicKey: (await vapidKeys(c.env)).publicKey }));

const subscription = z.object({
  endpoint: z.url().startsWith("https://").max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
  device: z.string().trim().max(200).optional(),
});

push.post("/push/subscriptions", requireUser, async (c) => {
  const body = await readJson(c, subscription);
  // The same phone signed in as someone else before: it's this person's now.
  await adminClient(c.env).from("push_subscriptions").delete().eq("endpoint", body.endpoint).neq("user_id", c.var.userId);
  const { error } = await c.var.db
    .from("push_subscriptions")
    .upsert({ user_id: c.var.userId, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, device: body.device ?? null }, { onConflict: "endpoint" });
  if (error) throw dbError(error);
  return c.json({ subscribed: true }, 201);
});

push.post("/push/unsubscribe", requireUser, async (c) => {
  const body = await readJson(c, z.object({ endpoint: z.string().max(1000) }));
  const { error } = await c.var.db.from("push_subscriptions").delete().eq("endpoint", body.endpoint);
  if (error) throw dbError(error);
  return c.json({ subscribed: false });
});

push.post("/push/test", requireUser, requireCompany(), async (c) => {
  const devices = must(await c.var.db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", c.var.userId));
  if (!devices.length) throw new HttpError(400, "Turn on notifications on this phone first.");
  const company = must(await c.var.db.from("companies").select("name, email").eq("id", c.var.companyId).maybeSingle());
  const base = appUrl(c);
  let sent = 0;
  for (const device of devices) {
    const result = await sendPush(c.env, device, { title: "Notifications are on", body: `You'll get ${company.name} updates here.`, link: "/", tag: "test" }, base.startsWith("https://") ? base : `mailto:${company.email || "notifications@crewtavo.invalid"}`);
    if (result.gone) await adminClient(c.env).from("push_subscriptions").delete().eq("id", device.id);
    if (result.ok) sent++;
  }
  if (!sent) throw new HttpError(502, "The phone's push service didn't take it. Turn notifications off and on again.");
  return c.json({ sent });
});
