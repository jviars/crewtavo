/**
 * The public demo (CREWTAVO_DEMO=1: lib/demoMode.ts, docs/demo.md), behind crewtavo.com's "Try the
 * demo".
 *
 * A visitor says what trade they're in and gets their own sample business in it
 * (services/demoStories.ts): an owner they're signed in as, a crew lead, a crew member and an office
 * manager, with clients, quotes, jobs, this week's schedule, invoices, equipment and guides. Nobody
 * signs up and nobody sees anyone else's. Each business is deleted DEMO_HOURS after it was made, by
 * the "demo" task, with its accounts and files; "Start over" deletes it at once.
 *
 * The accounts are under @demo.crewtavo.com, a domain that takes no mail, with random passwords
 * nobody keeps: the server signs the visitor in as one with a fresh password each time.
 */
import { DEMO_HOURS, getPreset, TERMS_VERSION, type TradePreset } from "@crewtavo/core";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import type { Env } from "../env";
import { isDemo } from "../lib/demoMode";
import { HttpError } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { adminClient, publishableKey, userClient, type Db } from "../lib/supabase";
import { applyPreset } from "../routes/account";
import { DemoSeeder } from "./demoSeed";
import { DEMO_TIME_ZONE, storyFor } from "./demoStories";

/** The demo's accounts: a domain Crewtavo owns that takes no mail. */
export const DEMO_EMAIL_DOMAIN = "demo.crewtavo.com";
const AUTH_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export const demoEnabled = isDemo;
export const isDemoAccount = (email: string | null | undefined) => Boolean(email?.toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`));

/** Who a visitor can be in their business. */
export type DemoPerson = "owner" | "crew";
const ROLE_OF = { owner: "owner", crew: "crew_lead" } as const satisfies Record<DemoPerson, string>;

export interface DemoSession {
  access_token: string;
  refresh_token: string;
}

/** Make a visitor's sample business in `trade` (a trade preset's id) and sign them in as its owner. */
export async function startDemo(env: Env, trade: string): Promise<DemoSession> {
  let preset: TradePreset;
  try {
    preset = getPreset(trade);
  } catch {
    throw new HttpError(400, "Pick a trade from the list.");
  }
  const story = storyFor(preset);
  const admin = adminClient(env);
  const tag = randomBytes(5).toString("hex");
  const made: string[] = [];
  // One after another, so a start that fails knows every account it made.
  const account = async (fullName: string) => {
    const password = randomBytes(24).toString("base64url");
    const first = fullName.split(" ")[0]!.toLowerCase().replace(/[^a-z]/g, "") || "person";
    const { data, error } = await admin.auth.admin.createUser({
      email: `${first}.${tag}@${DEMO_EMAIL_DOMAIN}`,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (error || !data.user) throw new Error(`Demo account for ${fullName}: ${error?.message ?? "not made"}`);
    made.push(data.user.id);
    return { id: data.user.id, email: data.user.email!, password };
  };
  try {
    const owner = await account(story.owner);
    const team: Record<string, string> = {};
    for (const p of story.team) team[p.key] = (await account(p.name)).id;
    const session = await signIn(env, owner.email, owner.password);
    const db = userClient(env, session.access_token);
    const { data: company, error } = await db.rpc("create_company", { p_name: story.business, p_trade_preset: preset.id, p_timezone: DEMO_TIME_ZONE });
    if (error || !company) throw new Error(`Demo business: ${error?.message ?? "not made"}`);
    // Each account knows its business where only the server can write (app_metadata): switching
    // people and starting over go by it, never by memberships the visitor could add themselves.
    for (const id of made) {
      const marked = await admin.auth.admin.updateUserById(id, { app_metadata: { [DEMO_MARK]: { company } } });
      if (marked.error) throw new Error(`Demo account's business: ${marked.error.message}`);
    }
    await applyPreset(db, company as string, preset);
    const agreed = await db.rpc("accept_terms", { p_company: company as string, p_version: TERMS_VERSION });
    if (agreed.error) throw new Error(`Demo license: ${agreed.error.message}`);
    await story.build(new DemoSeeder(db, admin, company as string, owner.id, team, DEMO_TIME_ZONE, story.taxRate));
    return session;
  } catch (error) {
    // Half a business is no use to anyone: take it and its accounts back out.
    await removeBusinessesOf(env, made).catch(() => undefined);
    await Promise.all(made.map((id) => admin.auth.admin.deleteUser(id).catch(() => undefined)));
    throw error;
  }
}

/** Where a demo account's business is kept, in its app_metadata. */
const DEMO_MARK = "crewtavo_demo";
const businessOf = (user: { email?: string | null; app_metadata?: Record<string, unknown> } | null | undefined): string | null => {
  if (!isDemoAccount(user?.email)) return null;
  const mark = user?.app_metadata?.[DEMO_MARK] as { company?: unknown } | undefined;
  return typeof mark?.company === "string" ? mark.company : null;
};

/**
 * Sign in as someone else in the caller's business: the crew lead, to see the crew's phone screens,
 * or the owner again. Only one of the demo's own accounts made for that same business.
 */
export async function switchDemoPerson(env: Env, callerId: string, as: DemoPerson): Promise<DemoSession> {
  const admin = adminClient(env);
  const company = await demoBusinessOf(env, callerId);
  const { data: people } = await admin.from("memberships").select("user_id").eq("company_id", company).eq("role", ROLE_OF[as]).eq("active", true).order("created_at");
  for (const { user_id } of people ?? []) {
    const { data: found } = await admin.auth.admin.getUserById(user_id);
    // Someone the visitor added to their business from another demo isn't theirs to sign in as.
    if (businessOf(found?.user) !== company) continue;
    const password = randomBytes(24).toString("base64url");
    const { error } = await admin.auth.admin.updateUserById(user_id, { password });
    if (error) throw new Error(`Demo switch: ${error.message}`);
    return signIn(env, found!.user!.email!, password);
  }
  throw new HttpError(404, as === "crew" ? "There's no crew lead in this business any more. Make Marcus one again in Settings → Team, then try again." : "There's no owner in this business any more.");
}

/** "Start over": delete the caller's sample business and its accounts now. */
export async function endDemo(env: Env, callerId: string): Promise<void> {
  const company = await demoBusinessOf(env, callerId);
  await removeBusiness(env, company);
}

/** The business a demo account was made for, or a 404 when the demo has ended (or it isn't one of the demo's accounts). */
async function demoBusinessOf(env: Env, userId: string): Promise<string> {
  const admin = adminClient(env);
  const { data: user } = await admin.auth.admin.getUserById(userId);
  const company = businessOf(user?.user);
  if (!company) throw new HttpError(403, "That's only for the demo's own sign-ins.");
  const { data: there } = await admin.from("companies").select("id").eq("id", company).maybeSingle();
  if (!there) throw new HttpError(404, "This demo has ended. Start a new one.");
  return company;
}

/** A session for an account, signed in with its password through the gateway, as the app signs in. */
async function signIn(env: Env, email: string, password: string): Promise<DemoSession> {
  const anon = createClient(env.SUPABASE_URL, publishableKey(env), { auth: AUTH_OPTIONS });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Demo sign-in: ${error?.message ?? "no session"}`);
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

// ---------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------

/** How many businesses one run deletes, so a run stays short; the next carries on. */
const PER_RUN = 100;

/**
 * The "demo" task: delete every sample business whose accounts are older than DEMO_HOURS, with
 * the accounts and files. It goes by the accounts, which a visitor can't change: their address
 * (only the demo's own), the business the server noted on them, and when Auth made them. Then any
 * demo account left with no business, and any business left with nobody in it (a start that failed
 * halfway). One that can't be deleted is reported and left for the next run; the rest go ahead.
 */
export async function removeExpiredDemos(env: Env, now = Date.now()): Promise<{ removed: number; accounts: number; failed: number }> {
  if (!isDemo(env)) return { removed: 0, accounts: 0, failed: 0 };
  const admin = adminClient(env);
  const cutoff = now - DEMO_HOURS * 3_600_000;
  const expired: Array<{ id: string; company: string | null; made: number }> = [];
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Listing the demo's accounts: ${error.message}`);
    const users = data?.users ?? [];
    for (const u of users) {
      if (isDemoAccount(u.email) && Date.parse(u.created_at) < cutoff) expired.push({ id: u.id, company: businessOf(u), made: Date.parse(u.created_at) });
    }
    if (users.length < 1000 || expired.length >= PER_RUN * 5) break;
  }
  // Oldest first, so one that keeps failing doesn't hold up the rest for long.
  expired.sort((a, b) => a.made - b.made);
  const companies = new Set<string>(expired.flatMap((u) => (u.company ? [u.company] : [])));
  const ids = expired.map((u) => u.id);
  for (let i = 0; i < ids.length && companies.size < PER_RUN * 2; i += 200) {
    const { data, error } = await admin.from("memberships").select("company_id").in("user_id", ids.slice(i, i + 200));
    if (error) throw new Error(`The demo's businesses: ${error.message}`);
    for (const m of data ?? []) companies.add(m.company_id);
  }
  let removed = 0;
  let failed = 0;
  const remove = async (id: string) => {
    try {
      await removeBusiness(env, id);
      removed++;
    } catch (error) {
      failed++;
      reportError(error, { task: "demo", company: id });
    }
  };
  for (const id of [...companies].slice(0, PER_RUN)) await remove(id);
  // Accounts whose business is gone (or never was).
  let accounts = 0;
  for (const { id } of expired) {
    const { count } = await admin.from("memberships").select("user_id", { count: "exact", head: true }).eq("user_id", id);
    if (count) continue;
    if (!(await admin.auth.admin.deleteUser(id)).error) accounts++;
  }
  // Businesses nobody is in, from a start that failed before it could clean up after itself.
  const { data: old } = await admin
    .from("companies")
    .select("id, memberships(count)")
    .lt("created_at", new Date(cutoff).toISOString())
    .order("created_at")
    .limit(PER_RUN * 5);
  const empty = ((old ?? []) as Array<{ id: string; memberships: Array<{ count: number }> }>).filter((c) => !c.memberships?.[0]?.count);
  for (const { id } of empty.slice(0, PER_RUN)) await remove(id);
  return { removed, accounts, failed };
}

async function removeBusinessesOf(env: Env, userIds: string[]) {
  if (!userIds.length) return;
  const { data } = await adminClient(env).from("memberships").select("company_id").in("user_id", userIds);
  for (const id of new Set((data ?? []).map((m) => m.company_id))) await removeBusiness(env, id);
}

/**
 * Delete a sample business: its files, then the business (every row of it goes with it), then its
 * people's accounts, the demo's own only. The business goes before its owner, as the database asks.
 */
export async function removeBusiness(env: Env, companyId: string) {
  const admin = adminClient(env);
  const { data: members } = await admin.from("memberships").select("user_id").eq("company_id", companyId);
  await removeFiles(admin, companyId);
  const { error } = await admin.from("companies").delete().eq("id", companyId);
  if (error) throw new Error(`Removing demo business ${companyId}: ${error.message}`);
  for (const { user_id } of members ?? []) {
    const { count } = await admin.from("memberships").select("user_id", { count: "exact", head: true }).eq("user_id", user_id);
    if (count) continue;
    const { data: user } = await admin.auth.admin.getUserById(user_id);
    if (isDemoAccount(user?.user?.email)) await admin.auth.admin.deleteUser(user_id).catch(() => undefined);
  }
}

/** Uploaded photos and documents live under <company id>/ in the files bucket; nothing else is theirs. */
async function removeFiles(admin: Db, companyId: string) {
  const bucket = admin.storage.from("files");
  const paths: string[] = [];
  const walk = async (folder: string, depth: number) => {
    for (let offset = 0; ; offset += 1000) {
      const { data } = await bucket.list(folder, { limit: 1000, offset });
      for (const entry of data ?? []) {
        const path = `${folder}/${entry.name}`;
        // Folders come back without an id.
        if (entry.id) paths.push(path);
        else if (depth < 6) await walk(path, depth + 1);
      }
      if ((data?.length ?? 0) < 1000) break;
    }
  };
  await walk(companyId, 0);
  for (let i = 0; i < paths.length; i += 100) await bucket.remove(paths.slice(i, i + 100));
}
