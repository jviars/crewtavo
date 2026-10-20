/**
 * Settings → Hosting and the "hosting" task: what Railway charges for this Crewtavo, read through
 * the owner's Railway connection (services/railway.ts), and warnings before Crewtavo stops.
 *
 * Railway reports this project's usage in vCPU-minutes, GB-minutes and GB sent; Crewtavo prices it
 * at Railway's published rates (RATES). Priced that way, a trial project's usage matched Railway's
 * own "$4.39 left" (2026-10-20). The forecast is this month so far plus the last day's rate for the
 * rest of it. The connection reaches the project, not the account's billing (that takes
 * workspace:admin, which Railway shows owners in red), so the trial's days and credit are counted
 * from when the project was made, and plans, credit, the card and the usage limit are Railway's
 * pages. Each part is optional: whatever Railway doesn't share is left out and named in `missing`.
 *
 * The task runs twice a day and tells the owner and admins about each warning once (the bell, plus
 * email and push by the "hosting" notification topic); the keys of those already sent are kept in
 * companies.settings.hosting_alerts.
 */
import { ADMINS, RAILWAY_PLANS, RAILWAY_TRIAL, serviceLabel, type HostingOverview, type HostingService, type HostingWarning, type RailwayPlan } from "@crewtavo/core";
import type { Env } from "../env";
import { platformOf } from "../lib/address";
import { asJson, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { projectDetails, projectIdOf, projectUsage, RailwayError, usageMetrics, volumeSizes, type Billed, type RailwayAccess } from "../integrations/railway";
import { railwayAccess } from "./railway";

const DAY_MS = 24 * 60 * 60_000;
/** The week's charts: a point every three hours. */
const STEP_SECONDS = 3 * 60 * 60;
/** The screen asks again after this long; "Check again" and the task don't wait. */
const CACHE_MS = 5 * 60_000;
/** A rate from less than this much use isn't worth a forecast. */
const MIN_RATE_MS = 60 * 60_000;

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

const planOf = (plan: string | null): RailwayPlan | null => {
  const name = (plan ?? "").toLowerCase();
  return name in RAILWAY_PLANS ? (name as RailwayPlan) : null;
};

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
  const plan = planOf(project.plan);
  const period = monthOf(now);
  const created = project.createdAt ? Date.parse(project.createdAt) : Number.NaN;
  // The last day's rate, or since the project was made when that's sooner.
  const rateFrom = new Date(Math.max(now.getTime() - DAY_MS, Number.isNaN(created) ? 0 : created));
  // The trial's credit is spent from when the project was made, which may be last month.
  const trialFrom = plan === "trial" && !Number.isNaN(created) && created < Date.parse(period.start) ? new Date(created) : null;
  const [usage, recent, sinceMade, metrics, volumes] = await Promise.all([
    optional(projectUsage(env, access, new Date(period.start), now)),
    now.getTime() - rateFrom.getTime() >= MIN_RATE_MS ? optional(projectUsage(env, access, rateFrom, now)) : null,
    trialFrom ? optional(projectUsage(env, access, trialFrom, now)) : null,
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
    // A series without a service (one that's gone) is all zeros.
    if (!series.serviceId) continue;
    for (const { ts, value } of series.values) {
      const at = Math.round(ts / STEP_SECONDS) * STEP_SECONDS;
      const point = points.get(at) ?? { memory: 0, cpu: 0 };
      if (series.measurement === "MEMORY_USAGE_GB") point.memory += value;
      else point.cpu += value;
      points.set(at, point);
    }
  }

  const cost = usage ? priced(usage) : 0;
  const perDay = recent ? priced(recent) / ((now.getTime() - rateFrom.getTime()) / DAY_MS) : null;
  const forecast = usage && perDay !== null ? cost + perDay * ((Date.parse(period.end) - now.getTime()) / DAY_MS) : null;
  const spentOnTrial = trialFrom ? (sinceMade ? priced(sinceMade) : null) : usage ? cost : null;
  const overview: Omit<HostingOverview, "warnings"> = {
    projectName: project.name,
    plan,
    period,
    project: usage
      ? {
          cost: cents(cost),
          perDay: perDay === null ? null : cents(perDay),
          forecast: forecast === null ? null : cents(forecast),
          services: [...services.values()].map((s) => ({ ...s, cost: cents(s.cost) })).filter((s) => s.cost > 0).sort((a, b) => b.cost - a.cost),
        }
      : null,
    trial:
      plan === "trial" && !Number.isNaN(created) && spentOnTrial !== null
        ? { daysLeft: Math.max(0, Math.ceil(RAILWAY_TRIAL.days - (now.getTime() - created) / DAY_MS)), creditLeft: cents(Math.max(0, RAILWAY_TRIAL.credit - spentOnTrial)) }
        : null,
    disks: (volumes ?? []).map((v) => ({ service: names.get(v.serviceId ?? "") ?? "Volume", usedGb: Math.round(v.usedMb / 10) / 100, sizeGb: Math.round(v.sizeMb / 10) / 100 })),
    week: [...points.entries()].sort(([a], [b]) => a - b).map(([at, p]) => ({ at: new Date(at * 1000).toISOString(), memory: Math.round(p.memory * 1000) / 1000, cpu: Math.round(p.cpu * 1000) / 1000 })),
    missing: [...(usage ? [] : ["usage" as const]), ...(metrics ? [] : ["charts" as const])],
    links: {
      usage: "https://railway.com/workspace/usage",
      billing: "https://railway.com/workspace/billing",
      upgrade: "https://railway.com/workspace/upgrade",
      plans: "https://railway.com/workspace/plans",
      project: `https://railway.com/project/${projectIdOf(env)}`,
    },
    checkedAt: now.toISOString(),
  };
  return { ...overview, warnings: hostingWarnings(overview) };
}

/** What needs doing before Railway stops Crewtavo or bills more than the plan includes, most urgent first. */
export function hostingWarnings(o: Omit<HostingOverview, "warnings">): HostingWarning[] {
  const warnings: HostingWarning[] = [];
  const period = o.period.start.slice(0, 7);
  const { plan, trial } = o;
  const perDay = o.project?.perDay ?? null;

  if (trial) {
    const left = trial.daysLeft;
    if (left <= 7) {
      const step = left <= 1 ? 1 : left <= 3 ? 3 : 7;
      warnings.push({
        key: `trial-${step}`,
        level: left <= 3 ? "urgent" : "warning",
        title: left <= 0 ? "Your Railway trial ends today" : `Your Railway trial ends in about ${plural(left, "day")}`,
        body: "Crewtavo stops when it does. To keep it running, choose Railway's Hobby plan: $5 a month, including $5 of usage.",
        action: "upgrade",
      });
    }
    const days = perDay ? Math.floor(trial.creditLeft / perDay) : null;
    if (trial.creditLeft <= 1 || (days !== null && days <= 3 && days < left)) {
      warnings.push({
        key: "trial-credit",
        level: "urgent",
        title: "Your Railway trial credit is almost used up",
        body: `About ${money(trial.creditLeft)} of the $5 is left${days !== null ? `, about ${plural(days, "day")} at this rate` : ""}. Crewtavo stops when it runs out, so choose Railway's Hobby plan before then.`,
        action: "upgrade",
      });
    }
  }

  if (plan === "free") {
    warnings.push({ key: "free", level: "warning", title: "Crewtavo is on Railway's Free plan", body: "Free includes $1 of usage a month, less than Crewtavo needs, so Railway stops it partway through the month. Choose the Hobby plan ($5 a month, including $5 of usage) to keep it running.", action: "upgrade" });
  }

  const forecast = o.project?.forecast ?? null;
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

/** Railway stopped accepting Crewtavo's sign-in: nothing else can be checked until the owner logs in again. */
const LAPSED: HostingWarning = {
  key: "lapsed",
  level: "urgent",
  title: "Crewtavo lost its Railway connection",
  body: "Log in with Railway again in Settings → Hosting, so Crewtavo can warn you before your Railway trial runs out or the bill goes over your plan.",
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
