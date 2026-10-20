/**
 * Settings → Hosting and the "hosting" task: what Railway charges for this Crewtavo, read through
 * the owner's Railway connection (services/railway.ts), and warnings before Crewtavo stops.
 *
 * Railway reports this project's usage in vCPU-minutes, GB-minutes and GB sent; Crewtavo prices it
 * at Railway's published rates (RATES), so this Crewtavo's dollars are close estimates. The
 * account's figures (usage so far, credit, trial, card) are Railway's own, from its billing, which
 * only a Login with Railway made by a workspace admin can read. Each part is optional: whatever
 * Railway doesn't share is left out and named in `missing`.
 *
 * Railway's API can't change plans or take payments, so the screen links to Railway's pages for
 * those; the usage limit it changes itself (changeLimit).
 *
 * The task runs twice a day and tells the owner and admins about each warning once (the bell, plus
 * email and push by the "hosting" notification topic); the keys of those already sent are kept in
 * companies.settings.hosting_alerts.
 */
import { ADMINS, RAILWAY_PLANS, serviceLabel, type HostingOverview, type HostingService, type HostingWarning, type RailwayPlan } from "@crewtavo/core";
import type { Env } from "../env";
import { platformOf } from "../lib/address";
import { asJson, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import {
  projectDetails, projectIdOf, projectUsage, RailwayError, setUsageLimit, usageForecast, usageMetrics, volumeSizes, workspaceBilling,
  type Billed, type RailwayAccess, type RailwayBilling,
} from "../integrations/railway";
import { railwayAccess } from "./railway";

const DAY_MS = 24 * 60 * 60_000;
/** The week's charts: a point every three hours. */
const STEP_SECONDS = 3 * 60 * 60;
/** The screen asks again after this long; "Check again" and the task don't wait. */
const CACHE_MS = 5 * 60_000;

/** Railway's prices per unit it reports (railway.com/pricing). A 30-day month is 43,200 minutes. */
export const RATES: Record<Billed, number> = {
  CPU_USAGE: 20 / 43_200, // $20 per vCPU a month
  MEMORY_USAGE_GB: 10 / 43_200, // $10 per GB of memory a month
  NETWORK_TX_GB: 0.05, // $0.05 per GB sent out
  DISK_USAGE_GB: 0.15 / 43_200, // $0.15 per GB of volume a month
  BACKUP_USAGE_GB: 0.15 / 43_200,
};

export const priced = (rows: Array<{ measurement: Billed; value: number }>) => rows.reduce((sum, r) => sum + (RATES[r.measurement] ?? 0) * r.value, 0);
const cents = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const PROBLEMS: Record<string, NonNullable<HostingOverview["account"]>["problem"]> = { PAST_DUE: "past_due", UNPAID: "unpaid", CANCELLED: "cancelled" };

/** null: Railway didn't give that part (refused, or didn't answer). Anything else is a bug, and is thrown. */
async function optional<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RailwayError) return null;
    throw error;
  }
}

function monthOf(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function planOf(billing: RailwayBilling | null, projectPlan: string | null): RailwayPlan | null {
  if (billing?.trialing) return "trial";
  const plan = (billing?.plan ?? projectPlan ?? "").toLowerCase();
  return plan in RAILWAY_PLANS ? (plan as RailwayPlan) : null;
}

const cache = new Map<string, { at: number; overview: HostingOverview }>();
export const forgetHosting = () => cache.clear();

/** GET /api/railway/usage. Without Railway access, says to connect it. */
export async function hostingOverview(env: Env, admin: Db, companyId: string, { fresh = false, now = new Date() } = {}): Promise<HostingOverview> {
  const cached = cache.get(companyId);
  if (!fresh && cached && now.getTime() - cached.at < CACHE_MS) return cached.overview;
  const access = await railwayAccess(env, admin, companyId);
  if (!access) throw new HttpError(409, "Connect Railway to see what Crewtavo costs.");
  const overview = await readHosting(env, access, now);
  cache.set(companyId, { at: now.getTime(), overview });
  return overview;
}

/** Everything Railway shares about what this Crewtavo costs, and what needs doing about it. */
export async function readHosting(env: Env, access: RailwayAccess, now = new Date()): Promise<HostingOverview> {
  // The project has to answer: without it the connection itself is broken, and the error says what to do.
  const project = await projectDetails(env, access);
  const workspaceId = access.method === "oauth" ? project.workspaceId : null;
  const billing = workspaceId ? await optional(workspaceBilling(access, workspaceId)) : null;
  const period = billing?.period ? { ...billing.period, billing: true } : { ...monthOf(now), billing: false };
  const [usage, forecast, accountForecast, metrics, volumes] = await Promise.all([
    optional(projectUsage(env, access, new Date(period.start), now)),
    optional(usageForecast(access, { projectId: projectIdOf(env) })),
    billing && workspaceId ? optional(usageForecast(access, { workspaceId })) : null,
    optional(usageMetrics(env, access, new Date(now.getTime() - 7 * DAY_MS), STEP_SECONDS)),
    optional(volumeSizes(env, access)),
  ]);
  const names = new Map(project.services.map((s) => [s.id, s.name]));

  const services = new Map<string, HostingService>();
  for (const row of usage ?? []) {
    const id = row.serviceId ?? "other";
    const service = services.get(id) ?? { id, name: names.get(id) ?? "Other", cost: 0 };
    service.cost += (RATES[row.measurement] ?? 0) * row.value;
    services.set(id, service);
  }

  const points = new Map<number, { memory: number; cpu: number }>();
  for (const series of metrics ?? []) {
    for (const { ts, value } of series.values) {
      const at = Math.round(ts / STEP_SECONDS) * STEP_SECONDS;
      const point = points.get(at) ?? { memory: 0, cpu: 0 };
      if (series.measurement === "MEMORY_USAGE_GB") point.memory += value;
      else point.cpu += value;
      points.set(at, point);
    }
  }

  const credit = billing && (billing.trialing || billing.prepaid || (billing.credit ?? 0) > 0) ? billing.credit : null;
  const overview: Omit<HostingOverview, "warnings"> = {
    projectName: project.name,
    plan: planOf(billing, project.plan),
    period,
    project: usage
      ? {
          cost: cents(priced(usage)),
          forecast: forecast ? cents(priced(forecast)) : null,
          services: [...services.values()].map((s) => ({ ...s, cost: cents(s.cost) })).filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost),
        }
      : null,
    account: billing
      ? {
          usage: cents(billing.usage ?? (usage ? priced(usage) : 0)),
          forecast: accountForecast ? cents(priced(accountForecast)) : null,
          others: (billing.projectCount ?? 1) > 1,
          credit: credit === null ? null : cents(credit),
          prepaid: billing.prepaid,
          trialDaysLeft: billing.trialing ? billing.trialDaysLeft : null,
          limit: billing.limit,
          alertAt: billing.alertAt,
          problem: PROBLEMS[billing.state ?? ""] ?? null,
        }
      : null,
    disks: (volumes ?? []).map((v) => ({ service: names.get(v.serviceId ?? "") ?? "Volume", usedGb: Math.round(v.usedMb / 10) / 100, sizeGb: Math.round(v.sizeMb / 10) / 100 })),
    week: [...points.entries()].sort(([a], [b]) => a - b).map(([at, p]) => ({ at: new Date(at * 1000).toISOString(), memory: Math.round(p.memory * 1000) / 1000, cpu: Math.round(p.cpu * 1000) / 1000 })),
    missing: [...(usage ? [] : ["usage" as const]), ...(billing ? [] : ["billing" as const]), ...(metrics ? [] : ["charts" as const])],
    links: {
      usage: "https://railway.com/workspace/usage",
      billing: "https://railway.com/workspace/billing",
      upgrade: "https://railway.com/workspace/upgrade",
      plans: "https://railway.com/workspace/plans",
      project: `https://railway.com/project/${projectIdOf(env)}`,
    },
    checkedAt: now.toISOString(),
  };
  return { ...overview, warnings: hostingWarnings(overview, now) };
}

/** What needs doing before Railway stops Crewtavo or bills more than the plan includes, most urgent first. */
export function hostingWarnings(o: Omit<HostingOverview, "warnings">, now = new Date()): HostingWarning[] {
  const warnings: HostingWarning[] = [];
  const period = o.period.start.slice(0, 10);
  const { account, plan } = o;
  // Dollars a day so far this period, for "runs out in about N days".
  const spent = account?.usage ?? o.project?.cost ?? 0;
  const perDay = spent / Math.max(1, (now.getTime() - Date.parse(o.period.start)) / DAY_MS);
  const daysOf = (dollars: number) => (perDay > 0 ? Math.floor(dollars / perDay) : null);

  if (account?.problem === "past_due" || account?.problem === "unpaid") {
    warnings.push({ key: `card:${period}`, level: "urgent", title: "Railway couldn't charge your card", body: "Update your card in Railway's billing settings. If Railway can't charge it, it stops Crewtavo and your team can't use it.", action: "billing" });
  } else if (account?.problem === "cancelled") {
    warnings.push({ key: `stopped:${period}`, level: "urgent", title: "Your Railway plan isn't active", body: "Railway stops Crewtavo without an active plan. Choose one in Railway's billing settings to keep Crewtavo running.", action: "plans" });
  }

  if (plan === "trial") {
    const left = account?.trialDaysLeft;
    if (left != null && left <= 7) {
      const step = left <= 1 ? 1 : left <= 3 ? 3 : 7;
      warnings.push({
        key: `trial-${step}`,
        level: left <= 3 ? "urgent" : "warning",
        title: left <= 0 ? "Your Railway trial ends today" : `Your Railway trial ends in ${plural(left, "day")}`,
        body: "Crewtavo stops when it does. To keep it running, choose Railway's Hobby plan: $5 a month, including $5 of usage.",
        action: "upgrade",
      });
    }
    const days = account?.credit != null ? daysOf(account.credit) : null;
    if (account?.credit != null && (account.credit <= 1 || (days !== null && days <= 3))) {
      warnings.push({
        key: "trial-credit",
        level: "urgent",
        title: "Your Railway trial credit is almost used up",
        body: `${money(account.credit)} is left${days !== null ? `, about ${plural(days, "day")} at this rate` : ""}. Crewtavo stops when it runs out, so choose Railway's Hobby plan before then.`,
        action: "upgrade",
      });
    }
  } else if (account?.prepaid && account.credit != null) {
    const days = daysOf(account.credit);
    if (days !== null && days <= 7) {
      warnings.push({
        key: `credit:${period}:${days <= 1 ? 1 : days <= 3 ? 3 : 7}`,
        level: days <= 3 ? "urgent" : "warning",
        title: days <= 0 ? "Your Railway credit runs out today" : `Your Railway credit runs out in about ${plural(days, "day")}`,
        body: "When it does, Railway cancels the plan and stops Crewtavo. Add credit, or a card, in Railway's billing settings.",
        action: "billing",
      });
    }
  }

  if (plan === "free") {
    warnings.push({ key: "free", level: "warning", title: "Crewtavo is on Railway's Free plan", body: "Free includes $1 of usage a month, less than Crewtavo needs, so Railway stops it partway through the month. Choose the Hobby plan ($5 a month, including $5 of usage) to keep it running.", action: "upgrade" });
  }

  const forecast = account?.forecast ?? o.project?.forecast ?? null;
  if (account?.limit && forecast !== null && forecast >= account.limit) {
    const days = daysOf(account.limit - spent);
    const when = days !== null ? new Date(Math.min(now.getTime() + days * DAY_MS, Date.parse(o.period.end))) : null;
    const date = when ? when.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
    warnings.push({
      key: `limit:${period}`,
      level: "urgent",
      title: date ? `Railway will stop Crewtavo around ${date}` : "Railway is set to stop Crewtavo this month",
      body: `Your Railway account stops its projects at ${money(account.limit)} of usage a month, and it's on track for about ${money(forecast)}. Raise the limit in Settings → Hosting to keep Crewtavo running.`,
      action: "limit",
    });
  }

  if ((plan === "hobby" || plan === "pro") && forecast !== null) {
    const { name, price, included } = RAILWAY_PLANS[plan];
    const over = forecast - included;
    if (over >= 0.5) {
      warnings.push({
        key: `over:${period}`,
        level: "warning",
        title: `About ${money(forecast)} of Railway usage this month`,
        body: `That's ${money(over)} more than the ${money(included)} ${name} includes, so Railway adds about ${money(over)} to the ${money(price)} plan. Settings → Hosting in Crewtavo shows what's using it.`,
        action: null,
      });
    }
  }

  for (const disk of o.disks) {
    const full = disk.sizeGb > 0 ? disk.usedGb / disk.sizeGb : 0;
    if (full < 0.85) continue;
    const label = serviceLabel(disk.service);
    warnings.push({
      key: `disk:${disk.service}:${full >= 0.95 ? 95 : 85}`,
      level: full >= 0.95 ? "urgent" : "warning",
      title: `${label} storage is ${Math.floor(full * 100)}% full`,
      body: `${disk.usedGb} of ${disk.sizeGb} GB is used. When it's full, Crewtavo can't save anything new there. Make the volume on the ${disk.service} service bigger in Railway; Hobby volumes go up to 5 GB, and Pro goes much higher.`,
      action: "project",
    });
  }

  return warnings.sort((a, b) => (a.level === b.level ? 0 : a.level === "urgent" ? -1 : 1));
}

/**
 * POST /api/railway/limit: Railway stops the account's projects at `stopAt` dollars of usage a month
 * (null removes the limit). Railway also wants a level to email at: the one already set if it's
 * still below, or else three quarters of the way.
 */
export async function changeLimit(env: Env, admin: Db, companyId: string, stopAt: number | null): Promise<HostingOverview> {
  const access = await railwayAccess(env, admin, companyId);
  if (!access) throw new HttpError(409, "Connect Railway first.");
  const project = await projectDetails(env, access);
  const billing = access.method === "oauth" && project.workspaceId ? await optional(workspaceBilling(access, project.workspaceId)) : null;
  if (!billing?.customerId) throw new HttpError(400, "Railway doesn't let Crewtavo change the limit with this connection. Change it in Railway's usage settings instead.");
  const alertAt = billing.alertAt && stopAt && billing.alertAt < stopAt ? billing.alertAt : stopAt ? Math.max(1, Math.floor(stopAt * 0.75)) : 0;
  await setUsageLimit(access, billing.customerId, stopAt ? { stopAt, alertAt } : null);
  return hostingOverview(env, admin, companyId, { fresh: true });
}

/** Railway stopped accepting Crewtavo's sign-in: nothing else can be checked until the owner logs in again. */
const LAPSED: HostingWarning = {
  key: "lapsed",
  level: "urgent",
  title: "Crewtavo lost its Railway connection",
  body: "Log in with Railway again in Settings → Hosting, so Crewtavo can warn you before your Railway trial, credit or card runs out.",
  action: null,
};

/** Sent warnings are forgotten after this long, so one that comes back later is sent again. */
const REMEMBER_MS = 90 * DAY_MS;

/** The "hosting" task, twice a day: tells the owner and admins about each new warning, once. */
export async function checkHosting(env: Env, admin: Db, now = new Date()): Promise<Record<string, unknown>> {
  if (env.CREWTAVO_SINGLE_COMPANY !== "1" || platformOf(env) !== "railway") return { skipped: "not on Railway" };
  const { data: companies, error } = await admin.from("companies").select("id, settings");
  if (error) throw new Error(error.message);
  let sent = 0;
  let unreadable = 0;
  for (const company of companies ?? []) {
    let warnings: HostingWarning[] = [];
    let connected = false;
    const access = await railwayAccess(env, admin, company.id).catch(() => null);
    if (access) {
      const overview = await hostingOverview(env, admin, company.id, { fresh: true, now }).catch((e: unknown) => {
        console.warn("Couldn't read Railway usage", e instanceof Error ? e.message : e);
        return null;
      });
      if (!overview) unreadable++;
      warnings = overview?.warnings ?? [];
      connected = Boolean(overview);
    } else {
      // Never connected: the owner is asked at sign-in. Connected once and then refused: say so.
      const { data: row } = await admin.from("integrations").select("status").match({ company_id: company.id, provider: "railway" }).maybeSingle();
      if (row?.status === "error") warnings = [LAPSED];
    }
    const before = ((company.settings as { hosting_alerts?: Record<string, string> } | null)?.hosting_alerts ?? {}) as Record<string, string>;
    const fresh = warnings.filter((w) => !before[w.key]);
    if (fresh.length) sent += await tellAdmins(admin, company.id, fresh);
    const kept = Object.fromEntries(
      Object.entries(before).filter(([key, at]) => now.getTime() - Date.parse(at) < REMEMBER_MS && !(connected && key === LAPSED.key)),
    );
    const after = { ...kept, ...Object.fromEntries(fresh.map((w) => [w.key, now.toISOString()])) };
    if (JSON.stringify(after) !== JSON.stringify(before)) await rememberAlerts(admin, company.id, after);
  }
  return { companies: companies?.length ?? 0, sent, unreadable };
}

async function tellAdmins(admin: Db, companyId: string, warnings: HostingWarning[]): Promise<number> {
  const { data: people } = await admin.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).in("role", [...ADMINS]);
  if (!people?.length) return 0;
  const rows = people.flatMap((p) => warnings.map((w) => ({ company_id: companyId, user_id: p.user_id, kind: "hosting", title: w.title, body: w.body, link: "/settings?tab=hosting" })));
  const { error } = await admin.from("notifications").insert(rows);
  if (error) throw new Error(error.message);
  return warnings.length;
}

/** Read fresh, so a setting changed meanwhile isn't undone. */
async function rememberAlerts(admin: Db, companyId: string, alerts: Record<string, string>) {
  const { data } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  const settings = (data?.settings ?? {}) as Record<string, unknown>;
  const { error } = await admin.from("companies").update({ settings: asJson({ ...settings, hosting_alerts: alerts }) }).eq("id", companyId);
  if (error) throw new Error(error.message);
}
