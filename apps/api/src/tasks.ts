/**
 * Background tasks, run by server.ts's built-in scheduler (or by hand: GET/POST /api/cron/:task
 * with CRON_SECRET). Each is safe to run twice.
 */
import { addDays, localDate, occurrenceDates, weatherRisks, zonedTimeToUtc, type WeatherRule } from "@crewtavo/core";
import type { Env } from "./env";
import { runAccountingJob } from "./integrations/accounting";
import { adminClient, type Db } from "./lib/supabase";
import { processAutomations } from "./services/automations";
import { processCampaigns } from "./services/campaigns";
import { deliverNotifications } from "./services/delivery";
import { dailyOutlook } from "./services/external";

export const TASKS = ["automations", "campaigns", "notify", "outbox", "recurrence", "followups", "weather"] as const;
export type TaskName = (typeof TASKS)[number];

/** Cron expressions -> tasks, run by server.ts's scheduler. */
export const CRON_TASKS: Record<string, TaskName[]> = {
  "* * * * *": ["automations", "campaigns", "notify"],
  "*/5 * * * *": ["outbox"],
  "0 * * * *": ["followups"],
  "0 */6 * * *": ["weather"],
  "15 6 * * *": ["recurrence"],
};

export async function runTask(name: TaskName, env: Env): Promise<Record<string, unknown>> {
  switch (name) {
    case "automations":
      return processAutomations(env, { limit: 50 });
    case "campaigns":
      return processCampaigns(env);
    case "notify":
      return deliverNotifications(env);
    case "outbox":
      return drainOutbox(env);
    case "recurrence":
      return materializeRecurringVisits(env);
    case "followups":
      return hourlyUpkeep(env);
    case "weather":
      return weatherHolds(env);
  }
}

/** Push queued accounting changes; failures retry with exponential backoff, up to 8 attempts. */
async function drainOutbox(env: Env) {
  const admin = adminClient(env);
  const { data: rows, error } = await admin.rpc("claim_outbox", { p_limit: 25 });
  if (error) throw new Error(error.message);
  let done = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    try {
      await runAccountingJob(env, admin, { ...row, payload: row.payload as Record<string, string> });
      await admin.from("outbox").update({ done_at: new Date().toISOString(), locked_until: null, last_error: null }).eq("id", row.id);
      done++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const giveUp = row.attempts >= 8;
      await admin
        .from("outbox")
        .update({
          locked_until: null,
          last_error: message.slice(0, 1000),
          run_after: new Date(Date.now() + 2 ** row.attempts * 60_000).toISOString(),
          dead_at: giveUp ? new Date().toISOString() : null,
        })
        .eq("id", row.id);
      if (giveUp) {
        await admin.from("integrations").update({ status: "error", last_error: message.slice(0, 500) }).eq("company_id", row.company_id).in("provider", ["quickbooks", "zoho_books"]);
      }
    }
  }
  return { claimed: rows?.length ?? 0, done, failed };
}

type RecurringJobRow = {
  id: string;
  company_id: string;
  title: string;
  property_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  recurrence_rule: string | null;
  active_months: number[] | null;
  visit_start_time: string | null;
  visit_duration_min: number;
  default_crew_id: string | null;
  company: unknown;
};

const RECURRING_FIELDS =
  "id, company_id, title, property_id, starts_on, ends_on, recurrence_rule, active_months, visit_start_time, visit_duration_min, default_crew_id, company:companies(timezone)";

/**
 * Bring one recurring job's visits in line with its schedule for the next 60 days: add missing
 * visits, and (when `prune`) remove untouched future visits the schedule no longer includes.
 */
export async function materializeJob(admin: Db, job: RecurringJobRow, prune = false): Promise<{ created: number; removed: number }> {
  if (!job.recurrence_rule || !job.starts_on) return { created: 0, removed: 0 };
  const tz = (job.company as { timezone?: string } | null)?.timezone ?? "UTC";
  const today = localDate(new Date(), tz);
  const horizon = addDays(today, 60);
  const dates = occurrenceDates({ ...job, starts_on: job.starts_on, recurrence_rule: job.recurrence_rule }, today, horizon);
  let removed = 0;
  if (prune) {
    const { data: stale } = await admin
      .from("visits")
      .select("id, recurrence_key")
      .eq("job_id", job.id)
      .eq("status", "scheduled")
      .not("recurrence_key", "is", null)
      .gte("scheduled_on", today);
    const drop = (stale ?? []).filter((v) => !dates.includes(v.recurrence_key!)).map((v) => v.id);
    if (drop.length) {
      await admin.from("visits").delete().in("id", drop);
      removed = drop.length;
    }
  }
  if (!dates.length) return { created: 0, removed };
  const rows = dates.map((date) => {
    const start = job.visit_start_time ? zonedTimeToUtc(date, job.visit_start_time, tz) : null;
    return {
      company_id: job.company_id,
      job_id: job.id,
      property_id: job.property_id,
      title: job.title,
      recurrence_key: date,
      scheduled_on: date,
      starts_at: start?.toISOString() ?? null,
      ends_at: start ? new Date(start.getTime() + job.visit_duration_min * 60_000).toISOString() : null,
      crew_id: job.default_crew_id,
    };
  });
  const { data, error } = await admin.from("visits").upsert(rows, { onConflict: "job_id,recurrence_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(error.message);
  return { created: data?.length ?? 0, removed };
}

export async function recurringJob(admin: Db, jobId: string) {
  const { data } = await admin.from("jobs").select(RECURRING_FIELDS).eq("id", jobId).maybeSingle();
  return data as RecurringJobRow | null;
}

/** Create visits for active recurring jobs, 60 days ahead. recurrence_key prevents duplicates. */
async function materializeRecurringVisits(env: Env) {
  const admin = adminClient(env);
  const { data: jobs, error } = await admin
    .from("jobs")
    .select(RECURRING_FIELDS)
    .eq("kind", "recurring")
    .eq("status", "active")
    .not("recurrence_rule", "is", null)
    .not("starts_on", "is", null);
  if (error) throw new Error(error.message);

  let created = 0;
  const problems: string[] = [];
  for (const job of (jobs ?? []) as RecurringJobRow[]) {
    try {
      created += (await materializeJob(admin, job)).created;
    } catch (err) {
      problems.push(`${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { jobs: jobs?.length ?? 0, created, problems };
}

/**
 * Hourly upkeep: invoices past their due date flip to overdue (which fires "invoice past due"
 * automations), day-before visit reminder events are emitted for companies that use them, and
 * forgotten clocks get a reminder or are stopped.
 */
async function hourlyUpkeep(env: Env) {
  const admin = adminClient(env);
  // Due dates are compared with each company's local date.
  const { data: overdue, error } = await admin.rpc("mark_overdue_invoices");
  if (error) throw new Error(error.message);
  const { data: reminders, error: reminderError } = await admin.rpc("emit_visit_reminders");
  if (reminderError) throw new Error(reminderError.message);
  // Maintenance coming due or overdue: one notification per change, to the people who look after it.
  const { data: equipment, error: equipmentError } = await admin.rpc("emit_equipment_alerts");
  if (equipmentError) throw new Error(equipmentError.message);
  // Clocks left running: remind after 10 hours, stop after 16 (per-company limits in settings.clock).
  const { data: clocks, error: clockError } = await admin.rpc("clock_upkeep");
  if (clockError) throw new Error(clockError.message);
  return { overdue: overdue ?? 0, reminders: reminders ?? 0, equipment: equipment ?? 0, clocks };
}

/** Flag tomorrow's visits whose job weather rules fail (rain, cold for asphalt, sealcoat dry time). */
async function weatherHolds(env: Env) {
  const admin = adminClient(env);
  const from = new Date().toISOString().slice(0, 10);
  const { data: visits, error } = await admin
    .from("visits")
    .select("id, scheduled_on, hold_reason, job:jobs(weather_rules), property:properties(lat, lng)")
    .eq("status", "scheduled")
    .gte("scheduled_on", from)
    .lte("scheduled_on", addDays(from, 2));
  if (error) throw new Error(error.message);

  // null: the forecast couldn't be fetched (an outage or rate limit), which isn't a clear sky.
  const outlooks = new Map<string, Awaited<ReturnType<typeof dailyOutlook>> | null>();
  let flagged = 0;
  let unknown = 0;
  for (const v of visits ?? []) {
    const rules = ((v.job as { weather_rules?: WeatherRule[] } | null)?.weather_rules ?? []) as WeatherRule[];
    const p = v.property as { lat: number | null; lng: number | null } | null;
    if (!rules.length || !v.scheduled_on || p?.lat == null || p?.lng == null) continue;
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (!outlooks.has(key)) outlooks.set(key, await dailyOutlook(p.lat, p.lng, 4).catch(() => null));
    const outlook = outlooks.get(key);
    // Without a forecast, leave the visit's hold as it is; the next run checks again.
    if (!outlook) {
      unknown++;
      continue;
    }
    const reasons = weatherRisks(rules, v.scheduled_on, outlook);
    const holdReason = reasons.length ? reasons.join("; ") : null;
    if (holdReason !== v.hold_reason) {
      await admin.from("visits").update({ hold_reason: holdReason }).eq("id", v.id);
      if (holdReason) flagged++;
    }
  }
  return { checked: visits?.length ?? 0, flagged, unknown };
}
