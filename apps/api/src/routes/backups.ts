/**
 * Database backups (Settings → Your data; services/backups.ts). A backup holds everything in the
 * database (every client, the team's pay, sign-ins), so all of it is the owner's alone, and the
 * list, a download and "Back up now" ask for their password as changing the Stripe key does: a
 * session left open on a phone can't take the business's data with it.
 *   GET  /api/backups               whether backups are made here, when the last good one was, how the last run went
 *   POST /api/backups/list          the backups there are (password)
 *   POST /api/backups               make one now (password); it carries on after the answer
 *   POST /api/backups/:id/download  one backup as a file, streamed (password)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { confirmPassword, requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { HttpError, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { backupStatus, listBackups, openBackup, startBackup } from "../services/backups";
import { tellOwners } from "./apps";

export const backups = new Hono<AppEnv>();

const owner = [requireUser, requireCompany(["owner"])] as const;
const PASSWORD = z.object({ password: z.string().min(1).max(200) });
/** Tries an hour for each sign-in: a visit to the page is a list, maybe a new backup, and a download or two. */
const TRIES = 20;

backups.get("/backups", ...owner, async (c) => c.json(await backupStatus(c.env, adminClient(c.env))));

backups.post("/backups/list", ...owner, async (c) => {
  await confirmPassword(c, (await readJson(c, PASSWORD)).password, "backups", TRIES);
  return c.json({ backups: await listBackups(adminClient(c.env)) });
});

backups.post("/backups", ...owner, async (c) => {
  await confirmPassword(c, (await readJson(c, PASSWORD)).password, "backups", TRIES);
  const { id, finished } = await startBackup(c.env, adminClient(c.env));
  runInBackground(c, finished);
  return c.json({ id }, 202);
});

backups.post("/backups/:id/download", ...owner, async (c) => {
  const id = c.req.param("id");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "That backup isn't there any more. Refresh the list.");
  const who = await confirmPassword(c, (await readJson(c, PASSWORD)).password, "backups", TRIES);
  const file = await openBackup(c.env, adminClient(c.env), id);
  // The whole database left the building: on record, and on every owner's bell.
  const name = who.full_name || who.email;
  runInBackground(
    c,
    tellOwners(c, {
      verb: "backup.downloaded",
      summary: `${name} downloaded a database backup`,
      title: "A database backup was downloaded",
      body: `${name} downloaded a backup of the whole database (${file.name}). If this wasn't you, sign in and change your password.`,
      link: "/settings?tab=data",
    }),
  );
  return new Response(file.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file.name}"`,
      "Content-Length": String(file.bytes),
      "Cache-Control": "no-store",
    },
  });
});
