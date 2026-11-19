/**
 * Background tasks, run by server.ts's built-in scheduler (or by hand: GET/POST /api/cron/:task
 * with CRON_SECRET). Each is safe to run twice.
 */
import { addDays, iceNotices, iceRisk, jobWeatherRules, lastDate, localDate, localTime, occurrenceDates, pavingWorkOn, snowNotices, snowPlan, VISIT_HORIZON_DAYS, weatherRisks, zonedTimeToUtc, type DayOutlook, type IceRisk, type SnowDay, type SnowSite } from "@crewtavo/core";
import type { Env } from "./env";
import { OtherBooks, runAccountingJob, SentButUnrecorded } from "./integrations/accounting";
import { pushNewlyUpcomingVisits, runCalendarJob, syncDueCalendars } from "./integrations/calendars";
import { reconcileAutopayProcessing, reconcileBankPayments, syncStripeInvoice } from "./integrations/stripe";
import { isDemo, SKIPPED_TASKS } from "./lib/demoMode";
import { reportError } from "./lib/monitoring";
import { emailConfigured, smsConfigured } from "./lib/notify";
import { adminClient, type Db } from "./lib/supabase";
import { runAddressTask } from "./services/address";
import { rollUpVisits } from "./services/analytics";
import { runBackups } from "./services/backups";
import { runAutopayJob } from "./services/autopay";
import { checkHosting } from "./services/hosting";
import { purgeTrash, tidyApplicantFiles, tidyPlanFiles, tidySubFiles, tidyUnrecordedFiles } from "./services/planFiles";
import { keepRailwayAlive } from "./services/railway";
import { checkJobProfits } from "./services/profitAlerts";
import { checkStorage } from "./services/storageUsage";
import { emitInactiveClients } from "./services/automatedCampaigns";
import { processAutomations } from "./services/automations";
import { processCampaigns } from "./services/campaigns";
import { syncDueReviews, tidyReviews } from "./services/googleReviews";
import { checkMetaAccess, postDueSocial, tidySocialImages } from "./services/social";
import { postcardsTask } from "./services/postcards";
import { tidyShowcaseCopies } from "./services/showcases";
import { sendDueReminders } from "./services/reviews";
import { deliverNotifications } from "./services/delivery";
import { remindSubs } from "./services/subs";
import { placeKey } from "./services/external";
import { dailyOutlook, forecasterFor, placeWeathers, snowFallen, snowToday, type Forecaster } from "./services/forecast";
import { autoRoutes } from "./services/routes";
import { relocatePins } from "./services/properties";
import { runAutopay } from "./services/bankLimit";
import { sendScheduledPayments } from "./services/installments";
import { tidyPlans } from "./integrations/chatgptPlan";
import { removeExpiredDemos } from "./services/demo";

export const TASKS = [
  "automations", "campaigns", "notify", "outbox", "autopay", "calendars", "recurrence", "followups", "weather", "snow", "address",
  "railway", "hosting", "plans", "trash", "storage", "routes", "website", "reviews", "inactive", "review_sync",
  "social", "backups", "profits", "installments", "postcards", "pins", "review_tidy", "demo", "chatgpt_plans",
] as const;
export type TaskName = (typeof TASKS)[number];

/** Cron expressions -> tasks, run by server.ts's scheduler. */
export const CRON_TASKS: Record<string, TaskName[]> = {
  // Social posts whose time has come (services/social.ts), one claim at a time. Postcard campaigns
  // being mailed make their next cards, and Lob is asked once an hour whether any card it accepted
  // in the last week failed (services/postcards.ts).
  "* * * * *": ["automations", "campaigns", "notify", "social", "postcards"],
  "*/2 * * * *": ["address"],
  // Review reminders go at 1:30pm in each company's time zone (services/reviews.ts). Autopay charges
  // what's due (services/autopay.ts) and sends the invoices over a bank account's limit to their
  // clients to pay (services/bankLimit.ts); its receipts and notices go out through the outbox.
  // A quote's scheduled payments the database made, sent when the company sends them by themselves (services/installments.ts).
  "*/5 * * * *": ["outbox", "reviews", "autopay", "installments"],
  "*/15 * * * *": ["calendars"],
  // Google reviews come in every 30 minutes for each company with Google Business Profile connected
  // (services/googleReviews.ts); review_syncs_due says which are due.
  "12,42 * * * *": ["review_sync"],
  "0 * * * *": ["followups"],
  // Clients who haven't had a visit in a while: hourly, so each company's own 10am is met; at most
  // 100 a day for each rule (services/automatedCampaigns.ts). The automations task sends them.
  "5 * * * *": ["inactive"],
  "0 */6 * * *": ["weather"],
  // Snow coming by tomorrow at each snow customer: hourly, as the forecast is, from 10am to 10pm
  // where the business is (snowWatch).
  "40 * * * *": ["snow"],
  "30 * * * *": ["routes"],
  "10 * * * *": ["website"],
  "15 6 * * *": ["recurrence"],
  "40 5 * * *": ["railway"],
  "45 2,14 * * *": ["hosting"],
  "20 4 * * *": ["plans"],
  // Deletes for good what has been in the Trash for 30 days (services/planFiles.ts).
  "35 4 * * *": ["trash"],
  // Warns owners and admins as files near the storage limit, on Railway or not (services/storageUsage.ts).
  "50 */6 * * *": ["storage"],
  // The night's database backup, once it's past 2am where the business is; hourly, so a night that
  // failed is tried again, and the owners hear when backups have stopped (services/backups.ts).
  "25 * * * *": ["backups"],
  // Jobs whose profit fell below the company's line since the last look (services/profitAlerts.ts).
  "45 * * * *": ["profits"],
  // Map spots with no source kept, looked up again a few at a time; only a server with a Google
  // server key has any to do (services/properties.ts).
  "3-59/5 * * * *": ["pins"],
  // Copies of Google reviews the sync has stopped seeing on Google are removed (services/googleReviews.ts).
  "55 4 * * *": ["review_tidy"],
  // ChatGPT plan sign-ins whose person left the team or signed out are signed out at OpenAI and
  // deleted, and sign-ins nobody finished are cleared (integrations/chatgptPlan.ts).
  "7-59/10 * * * *": ["chatgpt_plans"],
  // The public demo's copies past their time, with their accounts and files (services/demo.ts).
  "4-59/10 * * * *": ["demo"],
};

export async function runTask(name: TaskName, env: Env): Promise<Record<string, unknown>> {
  // The public demo reaches nothing outside and has no hosting to look after (lib/demoMode.ts).
  if (isDemo(env) && SKIPPED_TASKS.has(name)) return { skipped: "demo" };
  switch (name) {
    case "automations":
      return processAutomations(env, { limit: 50 });
    case "campaigns":
      return processCampaigns(env);
    case "notify":
      return deliverNotifications(env);
    case "outbox":
      return drainOutbox(env);
    case "autopay":
      return runAutopay(env);
    case "calendars":
      return syncDueCalendars(env, adminClient(env));
    case "recurrence":
      return materializeRecurringVisits(env);
    case "followups":
      return hourlyUpkeep(env);
    case "weather":
      return weatherHolds(env);
    case "snow":
      return snowWatch(env);
    case "address":
      return runAddressTask(env, adminClient(env));
    case "railway":
      return keepRailwayAlive(env, adminClient(env));
    case "hosting":
      return checkHosting(env, adminClient(env));
    case "plans": {
      const admin = adminClient(env);
      return {
        ...(await tidyPlanFiles(admin)),
        subs: await tidySubFiles(admin),
        applicants: await tidyApplicantFiles(admin),
        // Guide covers, and quote and visit photos, uploaded for a save that failed.
        photos: await tidyUnrecordedFiles(admin),
        // Social posts' pictures whose links ran out, and each Page's sign-in, read from Meta.
        social: await tidySocialImages(admin),
        // Showcase photos' public copies that are no longer shown (taken down, unpublished or deleted).
        showcases: await tidyShowcaseCopies(admin),
        meta: await checkMetaAccess(env, admin),
      };
    }
    case "trash":
      return purgeTrash(adminClient(env));
    case "storage":
      return checkStorage(env, adminClient(env));
    case "routes":
      return autoRoutes(env);
    case "website":
      return rollUpVisits(adminClient(env));
    case "reviews":
      return sendDueReminders(env);
    case "inactive":
      return emitInactiveClients(env);
    case "review_sync":
      return syncDueReviews(env);
    case "social":
      return postDueSocial(env);
    case "backups":
      return runBackups(env, adminClient(env));
    case "profits":
      return checkJobProfits(adminClient(env));
    case "installments":
      return sendScheduledPayments(env);
    case "postcards":
      return postcardsTask(env);
    case "pins":
      return relocatePins(env, adminClient(env));
    case "review_tidy":
      return tidyReviews(env);
    case "chatgpt_plans":
      return tidyPlans(env, adminClient(env));
    case "demo":
      return removeExpiredDemos(env);
  }
}

/**
 * Push queued accounting changes and visit changes for Google Calendar, keep Stripe invoices in
 * step, and send autopay's receipts, notices and copies of agreements (services/autopay.ts);
 * failures retry with exponential backoff, up to 8 attempts.
 */
async function drainOutbox(env: Env) {
  const admin = adminClient(env);
  // A rain day can move dozens of visits at once; they should reach Google in one run.
  const { data: rows, error } = await admin.rpc("claim_outbox", { p_limit: 100 });
  if (error) throw new Error(error.message);
  let done = 0;
  let failed = 0;
  for (const row of rows ?? []) {
    const calendar = row.topic.startsWith("calendar.");
    const stripe = row.topic.startsWith("stripe.");
    const autopay = row.topic.startsWith("autopay.");
    try {
      const job = { ...row, payload: row.payload as Record<string, string> };
      if (stripe) await syncStripeInvoice(env, admin, row.company_id, job.payload.invoice_id!);
      else if (autopay) await runAutopayJob(env, admin, { company_id: row.company_id, topic: row.topic, payload: job.payload });
      else await (calendar ? runCalendarJob(env, admin, job) : runAccountingJob(env, admin, job));
      await admin.from("outbox").update({ done_at: new Date().toISOString(), locked_until: null, last_error: null }).eq("id", row.id);
      done++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      // Queued for other books than the ones connected now: it isn't sent to these, however often it's tried.
      const elsewhere = err instanceof OtherBooks;
      // Sent but not recorded: another try would put a second copy in the books.
      const giveUp = row.attempts >= 8 || err instanceof SentButUnrecorded || elsewhere;
      await admin
        .from("outbox")
        .update({
          locked_until: null,
          last_error: message.slice(0, 1000),
          run_after: new Date(Date.now() + 2 ** row.attempts * 60_000).toISOString(),
          dead_at: giveUp ? new Date().toISOString() : null,
        })
        .eq("id", row.id);
      // One record that never goes through shows on the Apps page, but the app stays connected so
      // everything else keeps syncing (a refused sign-in marks it in integrations/tokens.ts). A change
      // left behind with other books isn't a problem with the ones connected, so it doesn't show.
      if (giveUp && !elsewhere) {
        const providers = calendar ? ["google_calendar"] : stripe || autopay ? ["stripe"] : ["quickbooks", "zoho_books"];
        await admin.from("integrations").update({ last_error: message.slice(0, 500) }).eq("company_id", row.company_id).in("provider", providers).eq("status", "connected");
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
  visit_time_fixed?: boolean;
  default_crew_id: string | null;
  paused_at?: string | null;
  resume_on?: string | null;
  /** The stretches it was paused before (20261106000500_pause_keeps_visit_count.sql). */
  pauses?: Array<{ from: string; until: string }> | null;
  company: unknown;
};

const RECURRING_FIELDS =
  "id, company_id, title, property_id, starts_on, ends_on, recurrence_rule, active_months, visit_start_time, visit_duration_min, visit_time_fixed, default_crew_id, paused_at, resume_on, pauses, company:companies(timezone)";

/**
 * How many visits one request reads, removes or adds. A year of a daily job's visits named in one
 * address is longer than the API takes, and a few hundred rows a time keeps each write short.
 */
const VISIT_CHUNK = 100;
const chunks = <T>(items: T[]): T[][] => Array.from({ length: Math.ceil(items.length / VISIT_CHUNK) }, (_, i) => items.slice(i * VISIT_CHUNK, (i + 1) * VISIT_CHUNK));

/**
 * Bring one recurring job's visits in line with its schedule for the next year (VISIT_HORIZON_DAYS):
 * add missing visits, (when `prune`) remove untouched future visits the schedule no longer includes,
 * and (when `refresh`) give the upcoming visits already made the job's title, crew and time. A paused
 * job gets none, and its waiting ones come off as with `prune`; on its resume date it resumes, from
 * that day. One that ends after a number of visits keeps its last visit's day as its ends_on,
 * the days it was paused not counting toward them.
 */
export async function materializeJob(admin: Db, job: RecurringJobRow, prune = false, refresh = false): Promise<{ created: number; removed: number; updated: number }> {
  if (!job.recurrence_rule || !job.starts_on) return { created: 0, removed: 0, updated: 0 };
  const tz = (job.company as { timezone?: string } | null)?.timezone ?? "UTC";
  const today = localDate(new Date(), tz);
  const horizon = addDays(today, VISIT_HORIZON_DAYS);
  const resumes = Boolean(job.paused_at && job.resume_on && job.resume_on <= today);
  const paused = Boolean(job.paused_at) && !resumes;
  let pauses = job.pauses ?? [];
  if (resumes) {
    // Resumed first: the database adds the stretch it was paused to its pauses, which the count goes by.
    const { data, error } = await admin.from("jobs").update({ paused_at: null }).eq("id", job.id).select("pauses").single();
    if (error) throw new Error(error.message);
    pauses = (data.pauses ?? []) as typeof pauses;
  }
  const schedule = {
    starts_on: job.starts_on, ends_on: job.ends_on, recurrence_rule: job.recurrence_rule, active_months: job.active_months,
    // Still paused: as if back on its resume date, or today when it has none (as resuming now would be).
    // shortcut: a visit kept on the day it was paused counts only once it resumes (the database's stretch); ends_on is a visit late till then.
    paused: paused ? [...pauses, { from: localDate(new Date(job.paused_at!), tz), until: [job.resume_on ?? today, today].sort()[1]! }] : pauses,
  };
  // What reads ends_on (monthly invoices, exports) learns when "ends after 12 visits" ends.
  const last = lastDate(schedule);
  if (last && last !== job.ends_on) {
    const { error } = await admin.from("jobs").update({ ends_on: last }).eq("id", job.id);
    if (error) throw new Error(error.message);
  }
  const dates = paused ? [] : occurrenceDates({ ...schedule, ends_on: last ?? job.ends_on }, today, horizon);
  const times = (date: string) => {
    const start = job.visit_start_time ? zonedTimeToUtc(date, job.visit_start_time, tz) : null;
    return {
      starts_at: start?.toISOString() ?? null,
      ends_at: start ? new Date(start.getTime() + job.visit_duration_min * 60_000).toISOString() : null,
      time_fixed: Boolean(start && job.visit_time_fixed),
    };
  };
  let removed = 0;
  if (prune || paused) {
    // A year of a daily job's visits is under the 1,000 rows one read returns.
    const { data: stale, error: staleError } = await admin
      .from("visits")
      .select("id, recurrence_key")
      .eq("job_id", job.id)
      .eq("status", "scheduled")
      .not("recurrence_key", "is", null)
      .gte("scheduled_on", today)
      .order("id")
      .limit(1000);
    if (staleError) throw new Error(staleError.message);
    const wanted = new Set(dates);
    let drop = (stale ?? []).filter((v) => !wanted.has(v.recurrence_key!)).map((v) => v.id);
    // A visit that job pay whose work is done (or paid) covers stays: that pay's visits are kept as
    // they were (20261025003001_job_pay.sql), so deleting it would be refused, and the rest with it.
    // So does one with work logged on it (time, materials, a checklist), which deleting would lose,
    // and one with extra work asked for on it (visit_extras), which is billed with that visit.
    const keep = new Set<string>();
    for (const ids of chunks(drop)) {
      const kept = await Promise.all([
        admin.from("job_pay_visits").select("visit_id, pay:job_pay!inner(status)").in("visit_id", ids).in("pay.status", ["done", "paid"]),
        admin.from("time_entries").select("visit_id").in("visit_id", ids),
        admin.from("job_materials").select("visit_id").in("visit_id", ids),
        admin.from("checklist_responses").select("visit_id").in("visit_id", ids),
        admin.from("visit_extras").select("visit_id").in("visit_id", ids),
      ]);
      const keptError = kept.find((r) => r.error)?.error;
      if (keptError) throw new Error(keptError.message);
      for (const r of kept) for (const k of r.data ?? []) if (k.visit_id) keep.add(k.visit_id);
    }
    drop = drop.filter((id) => !keep.has(id));
    if (drop.length) {
      // In one go, by the database: the people who were on them (their crew's members, mostly) hear
      // once that the job's visits changed, not once for every visit (remove_recurring_visits).
      const { data: gone, error: dropError } = await admin.rpc("remove_recurring_visits", { p_job: job.id, p_visits: drop });
      if (dropError) throw new Error(dropError.message);
      removed = gone ?? 0;
    }
  }
  let updated = 0;
  if (refresh) {
    // Only visits still waiting: done or started ones stay as they were, and one moved to another
    // day keeps that day (its time comes from the job, worked out as times() does). One update,
    // and one line to each person on them when a time or the crew changed.
    const { data, error } = await admin.rpc("refresh_upcoming_visits", { p_job: job.id });
    if (error) throw new Error(error.message);
    updated = data ?? 0;
  }
  if (!dates.length) return { created: 0, removed, updated };
  // A date whose visit someone deleted stays deleted (the database remembers it in recurrence_skips).
  // (At most a year of days, so one read has them all.)
  const { data: skips, error: skipError } = await admin.from("recurrence_skips").select("recurrence_key").eq("job_id", job.id).gte("recurrence_key", today).limit(1000);
  if (skipError) throw new Error(skipError.message);
  const skipped = new Set((skips ?? []).map((s) => s.recurrence_key));
  const missing = dates.filter((date) => !skipped.has(date));
  if (!missing.length) return { created: 0, removed, updated };
  const rows = missing.map((date) => ({
    company_id: job.company_id,
    job_id: job.id,
    property_id: job.property_id,
    title: job.title,
    recurrence_key: date,
    scheduled_on: date,
    ...times(date),
    crew_id: job.default_crew_id,
  }));
  // The dates it already has are left alone, so on most nights this adds the one new day at the
  // far end. The first run after the reach grew (or a new job) adds the rest of the year, a hundred
  // at a time: each is a short write of its own, and one that fails leaves the ones before it made
  // for the next run to carry on from.
  let created = 0;
  for (const batch of chunks(rows)) {
    const { data, error } = await admin.from("visits").upsert(batch, { onConflict: "job_id,recurrence_key", ignoreDuplicates: true }).select("id");
    if (error) throw new Error(error.message);
    created += data?.length ?? 0;
  }
  return { created, removed, updated };
}

export async function recurringJob(admin: Db, jobId: string) {
  const { data } = await admin.from("jobs").select(RECURRING_FIELDS).eq("id", jobId).maybeSingle();
  return data as RecurringJobRow | null;
}

/**
 * Create visits for active recurring jobs, a year ahead. recurrence_key prevents duplicates. A paused
 * one has its waiting visits taken off instead, and resumes on its resume date. One job after
 * another, each in short writes of its own: the first run after the reach grew from 60 days to a
 * year adds ten months of visits for every job, and a job that fails is reported and tried again
 * the next night.
 */
async function materializeRecurringVisits(env: Env) {
  const admin = adminClient(env);
  // Supabase returns at most 1,000 rows per request, so read a page at a time.
  const jobs: RecurringJobRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("jobs")
      .select(RECURRING_FIELDS)
      .eq("kind", "recurring")
      .eq("status", "active")
      .not("recurrence_rule", "is", null)
      .not("starts_on", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    jobs.push(...(data as RecurringJobRow[]));
    if (data.length < 1000) break;
  }

  let created = 0;
  const problems: string[] = [];
  for (const job of jobs) {
    try {
      created += (await materializeJob(admin, job)).created;
    } catch (err) {
      problems.push(`${job.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Recurring visits that have come within the six months the Google visits calendar covers go to
  // it now (integrations/calendars.ts); the ones further out wait their turn.
  let google = 0;
  try {
    const pushed = await pushNewlyUpcomingVisits(env, admin);
    google = pushed.queued;
    problems.push(...pushed.problems);
  } catch (err) {
    problems.push(`google calendar: ${err instanceof Error ? err.message : err}`);
  }
  return { jobs: jobs.length, created, google, problems };
}

/**
 * Hourly upkeep: invoices past their due date flip to overdue (which fires "invoice past due"
 * automations; one paid and then owed again fires them from the day after) and get their late fee once past the grace days (when the business charges one), the
 * office hears about a deposit a client approved with and left unpaid online, monthly
 * jobs get their month's invoice reminder on their invoice day (a monthly plan on autopay its charge),
 * day-before visit reminder events are emitted for companies that use them, job offers
 * to subs past their time to answer by run out, subs' certificates running out are flagged, saved
 * cards expiring next month are flagged and autopay's bank payments on their way are read back from
 * Stripe, forgotten clocks get a reminder or are stopped, and old sign-in codes are cleared.
 */
async function hourlyUpkeep(env: Env) {
  const admin = adminClient(env);
  // Each step runs on its own: one that fails is reported, and the others still run.
  const problems: string[] = [];
  const step = async <T>(name: string, run: PromiseLike<{ data: T | null; error: { message: string } | null }>) => {
    const { data, error } = await run;
    if (!error) return data;
    problems.push(`${name}: ${error.message}`);
    console.error(`Upkeep step ${name} failed`, error.message);
    reportError(new Error(`${name} failed: ${error.message}`), { task: "followups", step: name });
    return null;
  };
  // Due dates are compared with each company's local date.
  const overdue = await step("mark_overdue_invoices", admin.rpc("mark_overdue_invoices"));
  // A paid invoice the office made owed again (a payment removed, a refund) raised no past-due event
  // that day: from the next day this raises it, once, so reminders carry on from then.
  const owedAgain = await step("raise_past_due_notices", admin.rpc("raise_past_due_notices"));
  // Once each: the database marks every invoice it adds a fee to, so a second run adds none.
  const lateFees = await step("add_late_fees", admin.rpc("add_late_fees"));
  // A deposit a client was sent on to pay online as they approved, still unpaid an hour later: the
  // office is told on the bell, once (the database marks each one it has looked at).
  const deposits = await step("tell_unpaid_deposits", admin.rpc("tell_unpaid_deposits"));
  // A quote's scheduled payments whose date has come where the company is (or whose work has
  // started): each is made once, as a draft (the database keeps it to once).
  const installments = await step("make_due_installments", admin.rpc("make_due_installments"));
  // On a monthly job's invoice day, from 8 in the morning where the company is: one reminder a job a
  // month (the database keeps it to one, so a second run makes none) and one note to the office, or
  // a monthly plan on autopay queued to be charged by the autopay task.
  const invoiceReminders = await step("emit_invoice_reminders", admin.rpc("emit_invoice_reminders"));
  const reminders = await step("emit_visit_reminders", admin.rpc("emit_visit_reminders"));
  // Maintenance coming due or overdue: one notification per change, to the people who look after it.
  const equipment = await step("emit_equipment_alerts", admin.rpc("emit_equipment_alerts"));
  // Tags, inspection stickers and other paperwork: 30 days before, 7 days before and on the day it runs out.
  const paperwork = await step("emit_equipment_document_alerts", admin.rpc("emit_equipment_document_alerts"));
  // Guides due for review: their reviewer hears once, then weekly while it stays due.
  const guideReviews = await step("emit_guide_reviews", admin.rpc("emit_guide_reviews"));
  // Offers to subs left unanswered past their time to answer by: they run out (a new price leaves the
  // agreed one), and the office hears.
  const offers = await step("expire_sub_offers", admin.rpc("expire_sub_offers"));
  // Subs' insurance running out: the office hears 30 days before, 7 days before and on the day, and
  // so does the sub (by email or text, with their link), each once, from 8 in the morning.
  // The sub is only promised a link when there's a way to send it (the company's own mailbox counts too).
  const links = Boolean(env.APP_URL);
  const subAlerts = await step(
    "emit_sub_document_alerts",
    admin.rpc("emit_sub_document_alerts", { p_can_text: links && smsConfigured(env), p_can_email: links && emailConfigured(env) }),
  );
  let reminded = null;
  try {
    reminded = await remindSubs(env, admin, subAlerts ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`remind_subs: ${message}`);
    reportError(err, { task: "followups", step: "remind_subs" });
  }
  // Autopay cards expiring next month: one payment_method.expiring event each, once per expiry, from
  // 8 in the morning where the company is (for the "A saved card expires next month" automations).
  const cards = await step("emit_card_expiry_alerts", admin.rpc("emit_card_expiry_alerts"));
  // Autopay bank payments on their way for over a day: what Stripe says now is applied (paid, or a
  // bounce the webhook never brought). Stripe is asked, so it's caught like the steps above.
  let autopayProcessing = 0;
  try {
    autopayProcessing = await reconcileAutopayProcessing(env, admin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`reconcile_autopay_processing: ${message}`);
    console.error("Upkeep step reconcile_autopay_processing failed", message);
    reportError(err, { task: "followups", step: "reconcile_autopay_processing" });
  }
  // A client's own bank payment on its way for over a week: the same, in case its webhook never
  // came, so the invoice isn't left unpayable online for good.
  let bankPayments = 0;
  try {
    bankPayments = await reconcileBankPayments(env, admin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    problems.push(`reconcile_bank_payments: ${message}`);
    console.error("Upkeep step reconcile_bank_payments failed", message);
    reportError(err, { task: "followups", step: "reconcile_bank_payments" });
  }
  // Clocks left running: remind after 10 hours, stop after 16 (per-company limits in settings.clock).
  const clocks = await step("clock_upkeep", admin.rpc("clock_upkeep"));
  // Sign-in codes texted to subs over a day ago (services/signInCodes.ts): long run out, kept until now
  // for looking into a run of requests.
  const codes = await step("tidy_sign_in_codes", admin.rpc("tidy_sign_in_codes"));
  return {
    overdue: overdue ?? 0, owed_again: owedAgain ?? 0, late_fees: lateFees ?? 0, deposits: deposits ?? 0, installments: installments ?? 0, invoice_reminders: invoiceReminders ?? 0, reminders: reminders ?? 0, equipment: equipment ?? 0, paperwork: paperwork ?? 0, guide_reviews: guideReviews ?? 0, offers: offers ?? 0, subs: { alerts: subAlerts?.length ?? 0, reminded },
    cards: cards ?? 0, autopay_processing: autopayProcessing, bank_payments: bankPayments, clocks, codes: codes ?? 0, problems,
  };
}

const WEATHER_FIELDS =
  "id, scheduled_on, hold_reason, job:jobs(weather_rules, lines:job_line_items(name, service_id, parts, service:services(name))), company_id, company:companies(weather_rules:settings->weather_rules, weather_source:settings->weather_source), property:properties(lat, lng)";

/**
 * Flag tomorrow's visits whose weather rules fail (rain, cold for asphalt, sealcoat dry time): the
 * job's own rules, or else the company's rules for the services on the job.
 */
async function weatherHolds(env: Env) {
  const admin = adminClient(env);
  const from = new Date().toISOString().slice(0, 10);
  // A page at a time, in a fixed order: PostgREST answers with at most 1000 rows.
  const visits = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await admin
      .from("visits")
      .select(WEATHER_FIELDS)
      .eq("status", "scheduled")
      .gte("scheduled_on", from)
      .lte("scheduled_on", addDays(from, 2))
      .order("id")
      .range(start, start + 999);
    if (error) throw new Error(error.message);
    visits.push(...data);
    if (data.length < 1000) break;
  }

  // null: the forecast couldn't be fetched (an outage or rate limit), which isn't a clear sky.
  const outlooks = new Map<string, DayOutlook[] | null>();
  // Each business's own forecast source (Settings → Weather rules), looked up once.
  const forecasters = new Map<string, Forecaster>();
  let flagged = 0;
  let unknown = 0;
  for (const v of visits) {
    const services = (v.job?.lines ?? []).flatMap((l) => [l.name, l.service?.name ?? ""]);
    // The job's price list items by id, as they're called now: a rule follows its item when it's renamed.
    const ids = new Map((v.job?.lines ?? []).flatMap((l) => (l.service_id ? [[l.service_id, l.service?.name ?? l.name] as const] : [])));
    // A line priced with the paving calculator has no item: its kinds of work stand in (rules for "Hot-mix asphalt (paving calculator)").
    const rules = v.job ? jobWeatherRules(v.job.weather_rules, v.company?.weather_rules, services, ids, pavingWorkOn(v.job.lines ?? [])) : [];
    const p = v.property as { lat: number | null; lng: number | null } | null;
    if (!rules.length || !v.scheduled_on || p?.lat == null || p?.lng == null) continue;
    if (!forecasters.has(v.company_id)) forecasters.set(v.company_id, await forecasterFor(env, admin, v.company_id, v.company));
    const forecaster = forecasters.get(v.company_id)!;
    const key = `${forecaster.source}:${placeKey(p.lat, p.lng)}`;
    if (!outlooks.has(key)) outlooks.set(key, await dailyOutlook(p.lat, p.lng, 4, forecaster).catch(() => null));
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
  return { checked: visits.length, flagged, unknown };
}

const SNOW_SITE_FIELDS =
  "job_id, trigger_in, salt_trigger_in, repeat_in, clear_by, priority, alerted_on, alerted_pushes, ice_alerted_on, job:jobs!inner(title, status, paused_at, client:clients(display_name), property:properties(line1, lat, lng))";

/**
 * Snow (Apps → Crewtavo - Snow), hourly, for each business with it installed, by its own forecast
 * source:
 *
 *   - Between 10am and 10pm where the business is, the day before: when the snow forecast from 6pm
 *     today through tomorrow (an overnight storm whole) calls for a snow customer's plow or its salt
 *     (core snowPlan), tell the job's crew and the people listed on it, and the people who schedule
 *     the team (public.snow_recipients). Once a customer for each snow day (snow_sites.alerted_on),
 *     and again if the forecast grows into more pushes. The storm goes in the log (snow_events), and
 *     the subcontractors who'd go out are asked whether they can (snow_availability, answered on
 *     My day); the business's own people are told, not asked.
 *   - In the same hours, warn a salting customer's people of freezing rain or a refreeze (core
 *     iceRisk), once a day, unless they're already being told about snow there.
 *   - Between 4am and 10pm, on the day: when today's own storm (6pm last night to 6pm tonight, what
 *     has fallen and what's still coming) calls for a customer's plow or salt and its people weren't
 *     told that much the day before, because it came up overnight or grew, tell them now, the same
 *     people the same way. The storm's row in the log is the record of what they were told.
 *   - At any hour, write what fell yesterday into the log, as the forecast's own estimate, where the
 *     office hasn't written its own.
 *
 * A paused job isn't checked. Nothing is scheduled, which the office does from the Snow page, unless
 * the business turned on scheduling storms by themselves there (settings.snow_auto_schedule):
 * then a customer's visits are made as its people are told, the ones the office's button would make
 * (public.snow_schedule_auto).
 */
async function snowWatch(env: Env) {
  const admin = adminClient(env);
  const now = new Date();
  const { data: companies, error } = await admin.from("companies").select("id, timezone, weather_source:settings->weather_source, auto:settings->snow_auto_schedule").eq("settings->snow_app->>enabled", "true");
  if (error) throw new Error(error.message);
  const tally = { companies: 0, alerted: 0, today: 0, iced: 0, logged: 0, unknown: 0 };
  for (const company of companies) {
    const today = localDate(now, company.timezone);
    const hour = Number(localTime(now, company.timezone).slice(0, 2));
    const forecaster = await forecasterFor(env, admin, company.id, company);
    tally.logged += await logSnowFallen(admin, company.id, addDays(today, -1), forecaster);
    if (hour < 4 || hour >= 22) continue;
    tally.companies++;
    const tomorrow = addDays(today, 1);
    const { data: rows, error: sitesError } = await admin.from("snow_sites").select(SNOW_SITE_FIELDS).eq("company_id", company.id).eq("job.status", "active").is("job.paused_at", null).limit(1000);
    if (sitesError) throw new Error(sitesError.message);
    // A customer with no map location can't be checked (the Snow page says so); one whose forecast
    // couldn't be had is checked again next hour.
    const located = rows.flatMap((site) => (site.job.property?.lat != null && site.job.property.lng != null ? [{ site, lat: site.job.property.lat, lng: site.job.property.lng }] : []));
    const weather = await placeWeathers(located, forecaster, 3);
    const named = (site: (typeof rows)[number]) => [site.job.client?.display_name, site.job.property?.line1].filter(Boolean).join(" – ") || site.job.title;

    type Called = { site: (typeof rows)[number]; snow: number; pushes: number; kind: "plow" | "salt" };
    const rulesOf = (site: (typeof rows)[number]) => ({ trigger_in: Number(site.trigger_in), salt_trigger_in: site.salt_trigger_in == null ? null : Number(site.salt_trigger_in), repeat_in: site.repeat_in == null ? null : Number(site.repeat_in) });
    /**
     * Tells these customers' people and the schedulers about a storm, and asks the subcontractors
     * among them whether they can go out: they work for themselves, and the business's own people
     * are told. A lookup of who's a sub that fails asks nobody, and still tells everyone.
     *
     * With the business's switch on they're scheduled first, and the schedulers are told so. It's
     * only ever what's being told about, so a visit the office cancelled isn't made again next hour.
     * A storm that can't be scheduled is still told about, and stays To schedule on the Snow page.
     */
    const tell = async (mine: Called[], date: string, day: SnowDay) => {
      let made = 0;
      if (company.auto === true) {
        const scheduled = await admin.rpc("snow_schedule_auto", {
          p_company: company.id, p_date: date, p_plan: mine.map(({ site, snow, pushes, kind }) => ({ job_id: site.job_id, inches: snow, pushes: Math.max(1, pushes), kind })),
        });
        if (scheduled.error) reportError(new Error(scheduled.error.message), { task: "snow", company: company.id });
        else made = scheduled.data ?? 0;
      }
      const onSchedule = made ? `\n${made === 1 ? "Its visit is" : `${made} visits are`} on ${day === "today" ? "today's" : "tomorrow's"} schedule already.` : "";
      const recipients = await admin.rpc("snow_recipients", { p_jobs: mine.map((x) => x.site.job_id) });
      if (recipients.error) throw new Error(recipients.error.message);
      const people = (jobId: string) => recipients.data.filter((r) => r.job_id === jobId && !r.office).map((r) => r.user_id);
      const office = [...new Set(recipients.data.filter((r) => r.office).map((r) => r.user_id))];
      const sites: SnowSite[] = mine.map(({ site, snow, pushes, kind }) => ({
        name: named(site), trigger_in: Number(site.trigger_in), snow_in: snow, plan: { kind, pushes: Math.max(1, pushes) }, clear_by: site.clear_by, priority: site.priority, people: people(site.job_id),
      }));
      const going = [...new Set(sites.flatMap((s) => s.people))].filter((user) => !office.includes(user));
      const subs = going.length ? await admin.from("memberships").select("user_id").eq("company_id", company.id).eq("role", "subcontractor").in("user_id", going) : null;
      const asking = (subs?.data ?? []).map((m) => m.user_id);
      const sent = await admin.from("notifications").insert(
        snowNotices(sites, office, asking, day).map((n) => ({ company_id: company.id, user_id: n.user_id, kind: "snow", title: n.title, body: n.office ? n.body + onSchedule : n.body, link: n.office ? "/snow" : "/field" })),
      );
      if (sent.error) throw new Error(sent.error.message);
      // The question isn't worth untelling everyone for: the Snow page asks nobody twice.
      const asked = asking.length
        ? await admin.from("snow_availability").upsert(asking.map((user_id) => ({ company_id: company.id, snow_date: date, user_id })), { onConflict: "company_id,snow_date,user_id", ignoreDuplicates: true })
        : null;
      for (const problem of [subs?.error, asked?.error]) if (problem) reportError(new Error(problem.message), { task: "snow", company: company.id });
    };

    // Today's own storm: a customer it calls for whose people weren't told that much the day before
    // hears now. The storm's row in the log is what they were told, so it's claimed first, a new row
    // for a storm nobody knew of and more pushes on one they did, and only what this run claimed is
    // told about: two servers checking at the same minute tell everyone once.
    const fallen = await snowToday(located, weather, today, forecaster);
    const known = await admin.from("snow_events").select("job_id, kind, pushes").eq("company_id", company.id).eq("snow_date", today).limit(1000);
    if (known.error) throw new Error(known.error.message);
    const told = new Map(known.data.map((e) => [e.job_id, e]));
    const late = located.flatMap(({ site, lat, lng }): Array<Called & { fresh: boolean }> => {
      const snow = fallen.get(placeKey(lat, lng));
      const plan = snow == null ? null : snowPlan(rulesOf(site), snow);
      const was = told.get(site.job_id);
      return plan && (!was || (plan.kind === "plow" && (was.kind === "salt" || plan.pushes > was.pushes))) ? [{ site, snow: snow!, pushes: plan.pushes, kind: plan.kind, fresh: !was }] : [];
    });
    if (late.length) {
      const fresh = late.filter((x) => x.fresh);
      const made = fresh.length
        ? await admin.from("snow_events").upsert(
            fresh.map(({ site, snow, pushes, kind }) => ({ company_id: company.id, job_id: site.job_id, snow_date: today, kind, forecast_in: snow, pushes })),
            { onConflict: "job_id,snow_date", ignoreDuplicates: true },
          ).select("job_id")
        : null;
      if (made?.error) throw new Error(made.error.message);
      const claimed = (made?.data ?? []).map((r) => r.job_id);
      const grown = late.filter((x) => !x.fresh);
      for (const pushes of new Set(grown.map((x) => x.pushes))) {
        const more = await admin.from("snow_events").update({ kind: "plow", pushes }).eq("company_id", company.id).eq("snow_date", today)
          .in("job_id", grown.filter((x) => x.pushes === pushes).map((x) => x.site.job_id)).or(`pushes.lt.${pushes},kind.eq.salt`).select("job_id");
        if (more.error) throw new Error(more.error.message);
        claimed.push(...more.data.map((r) => r.job_id));
      }
      const mine = late.filter((x) => claimed.includes(x.site.job_id));
      if (mine.length) {
        try {
          await tell(mine, today, "today");
        } catch (err) {
          // Nobody told: the new rows go, so the next hour tries again. A storm that grew keeps its count, as its people knew of it.
          await admin.from("snow_events").delete().eq("company_id", company.id).eq("snow_date", today).in("job_id", (made?.data ?? []).map((r) => r.job_id));
          throw err;
        }
        tally.today += mine.length;
      }
    }
    // Tomorrow's is told about from 10am, not before anyone's up.
    if (hour < 10) continue;

    const snowy: Called[] = [];
    const icy: Array<{ site: (typeof rows)[number]; risk: IceRisk }> = [];
    for (const { site, lat, lng } of located) {
      const here = weather.get(placeKey(lat, lng));
      const snow = here?.snow_by_day[tomorrow];
      if (!here || snow == null) {
        tally.unknown++;
        continue;
      }
      const plan = snowPlan(rulesOf(site), snow);
      // Told about tomorrow already: more pushes than they were told (or the plow, after salt only) is news.
      const told = site.alerted_on === tomorrow ? site.alerted_pushes ?? 0 : -1;
      const pushes = plan?.kind === "plow" ? plan.pushes : 0;
      if (plan && pushes > told) snowy.push({ site, snow, pushes, kind: plan.kind });
      const risk = !plan && site.salt_trigger_in != null && site.ice_alerted_on !== tomorrow ? iceRisk(here.hours, `${today}T18:00`, `${addDays(tomorrow, 1)}T00:00`) : null;
      if (risk) icy.push({ site, risk });
    }

    // Marked first, and only the customers this run marked are told about: two servers checking at
    // the same minute tell everyone once. Nobody told (the database was busy): unmarked, for next hour.
    if (snowy.length) {
      const marked: string[] = [];
      for (const pushes of new Set(snowy.map((x) => x.pushes))) {
        const claim = await admin.from("snow_sites").update({ alerted_on: tomorrow, alerted_pushes: pushes })
          .in("job_id", snowy.filter((x) => x.pushes === pushes).map((x) => x.site.job_id))
          .or(`alerted_on.is.null,alerted_on.neq.${tomorrow},alerted_pushes.lt.${pushes}`).select("job_id");
        if (claim.error) throw new Error(claim.error.message);
        marked.push(...claim.data.map((r) => r.job_id));
      }
      const mine = snowy.filter((x) => marked.includes(x.site.job_id));
      if (mine.length) {
        try {
          await tell(mine, tomorrow, "tomorrow");
        } catch (err) {
          await admin.from("snow_sites").update({ alerted_on: null, alerted_pushes: null }).in("job_id", marked);
          throw err;
        }
        // The storm in the log. Not worth untelling everyone for: scheduling the storm logs it too.
        const logged = await admin.from("snow_events").upsert(
          mine.map(({ site, snow, pushes, kind }) => ({ company_id: company.id, job_id: site.job_id, snow_date: tomorrow, kind, forecast_in: snow, pushes: Math.max(1, pushes) })),
          { onConflict: "job_id,snow_date" },
        );
        if (logged.error) reportError(new Error(logged.error.message), { task: "snow", company: company.id });
        tally.alerted += mine.length;
      }
    }

    if (icy.length) {
      const claim = await admin.from("snow_sites").update({ ice_alerted_on: tomorrow }).in("job_id", icy.map((x) => x.site.job_id)).or(`ice_alerted_on.is.null,ice_alerted_on.neq.${tomorrow}`).select("job_id");
      if (claim.error) throw new Error(claim.error.message);
      const marked = claim.data.map((r) => r.job_id);
      const mine = icy.filter((x) => marked.includes(x.site.job_id));
      if (mine.length) {
        const recipients = await admin.rpc("snow_recipients", { p_jobs: marked });
        const office = [...new Set((recipients.data ?? []).filter((r) => r.office).map((r) => r.user_id))];
        const notices = iceNotices(
          mine.map(({ site, risk }) => ({ name: named(site), risk, priority: site.priority, people: (recipients.data ?? []).filter((r) => r.job_id === site.job_id && !r.office).map((r) => r.user_id) })),
          office,
          `${today}T18:00`,
        );
        const sent = recipients.error ? recipients : await admin.from("notifications").insert(notices.map((n) => ({ company_id: company.id, user_id: n.user_id, kind: "snow", title: n.title, body: n.body, link: n.office ? "/snow" : "/field" })));
        if (sent.error) {
          await admin.from("snow_sites").update({ ice_alerted_on: null }).in("job_id", marked);
          throw new Error(sent.error.message);
        }
        tally.iced += mine.length;
      }
    }
  }
  return tally;
}

/**
 * What fell on `date` at each of the business's logged storms that nobody has an amount for yet:
 * the forecast's own estimate afterwards (Open-Meteo's, which keeps the last days; the Weather
 * Service only looks ahead). The office's own figure, once written, is never overwritten.
 */
async function logSnowFallen(admin: Db, companyId: string, date: string, forecaster: Forecaster): Promise<number> {
  const { data: events, error } = await admin.from("snow_events").select("job_id, job:jobs(property:properties(lat, lng))").eq("company_id", companyId).eq("snow_date", date).is("actual_in", null).limit(1000);
  if (error) throw new Error(error.message);
  const located = events.flatMap((e) => (e.job?.property?.lat != null && e.job.property.lng != null ? [{ job_id: e.job_id, lat: e.job.property.lat, lng: e.job.property.lng }] : []));
  if (!located.length) return 0;
  const fallen = await snowFallen(located, forecaster);
  let logged = 0;
  for (const e of located) {
    const inches = fallen.get(placeKey(e.lat, e.lng))?.[date];
    if (inches == null) continue;
    const saved = await admin.from("snow_events").update({ actual_in: inches }).eq("job_id", e.job_id).eq("snow_date", date).is("actual_in", null);
    if (!saved.error) logged++;
  }
  return logged;
}
