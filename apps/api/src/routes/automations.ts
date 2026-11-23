/**
 * Automations: rules are edited straight from the browser (row-level security limits that to the
 * office). These routes run the engine, preview a rule against a real record, and retry or cancel runs.
 */
import { evaluateConditions, OFFICE, renderTemplate, taskVars, triggerAllowed, triggerDef, validateRule, type Action, type Condition, type RuleShape } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { firstName } from "../lib/email";
import { appUrl, dbError, HttpError, must, readJson } from "../lib/http";
import { emailReady, smsReady } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { buildContext, keptVars, previewRecipients, processAutomations, withAutopayLink, withEvent } from "../services/automations";
import { autopayAvailable, autopayInviteText } from "../services/autopay";

export const automations = new Hono<AppEnv>();

const lastRun = new Map<string, number>();

/** The web app calls this after actions so rules run right away instead of on the next cron tick. */
automations.post("/automations/process", requireUser, requireCompany(), async (c) => {
  const now = Date.now();
  if (now - (lastRun.get(c.var.companyId) ?? 0) < 1500) return c.json({ claimed: 0, throttled: true });
  lastRun.set(c.var.companyId, now);
  return c.json(await processAutomations(c.env, { companyId: c.var.companyId, limit: 25, baseUrl: appUrl(c) }));
});

const ruleSchema = z.object({
  name: z.string().max(120).default("Untitled rule"),
  trigger: z.string().max(60),
  delay_minutes: z.number().int().min(0).max(525_600).default(0),
  conditions: z.array(z.object({ field: z.string().max(40), op: z.string().max(20), value: z.union([z.string().max(200), z.number(), z.array(z.string().max(100)).max(30)]) })).max(10),
  actions: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
});

/** Preview what a rule would do on the most recent matching record, without doing it. */
automations.post("/automations/preview", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const rule = (await readJson(c, ruleSchema)) as unknown as RuleShape;
  // Rules about subs' job offers (their prices) are for the office with the Subcontractors area, and
  // rules about autopay (clients' cards) for the office with the invoices area.
  if (!triggerAllowed(rule.trigger, (area) => c.var.permissions.includes(area))) {
    throw new HttpError(
      403,
      triggerDef(rule.trigger)?.area === "invoices"
        ? "Rules about autopay need the Invoices and payments area. Ask an owner or admin."
        : "Rules about subs' job offers need the Subcontractors area. Ask an owner or admin.",
    );
  }
  const problems = validateRule(rule);
  if (problems.length) throw new HttpError(400, problems[0]);
  const trigger = triggerDef(rule.trigger)!;
  const { db, companyId } = c.var;

  // The latest event of this kind, or else the latest record of the subject's type.
  const event = must(await db.from("activity").select("id, subject_type, subject_id").eq("company_id", companyId).eq("verb", rule.trigger).not("subject_id", "is", null).order("created_at", { ascending: false }).limit(1));
  const latestRecord = async () => {
    const table = ({ client: "clients", request: "requests", quote: "quotes", job: "jobs", visit: "visits", invoice: "invoices" } as const)[trigger.subject];
    const latest = must(await db.from(table).select("id").eq("company_id", companyId).order("created_at", { ascending: false }).limit(1));
    return latest[0]?.id ?? null;
  };
  const admin = adminClient(c.env);
  const load = async (id: string | null) => (id ? buildContext(c.env, admin, companyId, trigger.subject, id, appUrl(c)) : null);
  let eventId: number | null = event[0]?.id ?? null;
  let loaded = await load(event[0]?.subject_id ?? null);
  // No event yet, or its record is gone since (a deleted visit's "cancelled"): the latest record, without the event's own words.
  if (!loaded) {
    eventId = null;
    loaded = await load(await latestRecord());
  }
  if (!loaded) return c.json({ record: null, pass: false, failed: null, previews: [] });
  // What the event said (a sub's name and price, the card a charge failed on), as a run would have it.
  // The person previewing sees what stands for any client link in what the team reads (keptVars),
  // not a link that opens the client's page as them.
  const ctx = await withAutopayLink(c.env, await withEvent(admin, loaded, rule.trigger, eventId), rule.trigger, appUrl(c));
  const vars = keptVars(ctx);
  const check = evaluateConditions(rule.conditions as Condition[], ctx.facts, ctx.subject);
  const r = (t?: string) => renderTemplate(t ?? "", vars).trim();
  const warnings: string[] = [];
  const canEmail = await emailReady(c.env, companyId);
  const canText = await smsReady(c.env, companyId);
  const takesAutopay = (rule.actions as Action[]).some((a) => a.type === "invite_autopay") ? await autopayAvailable(c.env, admin, companyId) : true;
  // Who an email or a text would go to: the client, and their contacts ticked for it.
  const uses = (type: Action["type"]) => (rule.actions as Action[]).some((a) => a.type === type);
  const emailTo = uses("send_email") ? await previewRecipients(admin, ctx, rule.trigger, "email") : [];
  const textTo = uses("send_sms") ? await previewRecipients(admin, ctx, rule.trigger, "sms") : [];
  const previews = (rule.actions as Action[]).map((a) => {
    switch (a.type) {
      case "notify":
        return { type: a.type, title: r(a.title), body: r(a.body) };
      case "send_email":
        if (!canEmail) warnings.push("Email isn't connected yet (Settings → Email), so email actions will fail until it is.");
        if (!emailTo.length) warnings.push(`${ctx.client?.display_name ?? "This client"} has no email address.`);
        return { type: a.type, to: emailTo.join(", ") || null, title: r(a.subject), body: r(a.body) };
      case "send_sms":
        if (!canText) warnings.push("Texting isn't set up yet (Apps → Twilio), so text actions will fail until it is.");
        return { type: a.type, to: textTo.join(", ") || null, body: r(a.body) };
      case "add_note":
        return { type: a.type, body: r(a.body) };
      case "create_task":
        // As the crew would see it on the schedule: without the event's office-only values.
        return { type: a.type, title: renderTemplate(a.title ?? "", taskVars(rule.trigger, vars)).trim(), body: `Due in ${a.days_from_now} days` };
      case "add_tag":
      case "remove_tag":
        return { type: a.type, title: a.tag };
      case "invite_autopay": {
        if (!takesAutopay) warnings.push("Autopay isn't on (Settings → Payments, and a Stripe key that can save cards), so invites won't go out until it is.");
        const to = a.channel === "sms" ? (ctx.client?.phone ?? null) : (ctx.client?.email ?? null);
        if (a.channel === "sms" && !canText) warnings.push("Texting isn't set up yet (Apps → Twilio), so text actions will fail until it is.");
        if (a.channel !== "sms" && !canEmail) warnings.push("Email isn't connected yet (Settings → Email), so email actions will fail until it is.");
        if (!to) warnings.push(`${ctx.client?.display_name ?? "This client"} has no ${a.channel === "sms" ? "mobile number" : "email address"}.`);
        // The set-up invite as it goes (a client with a card from Stripe is asked to confirm it instead).
        return { type: a.type, to, body: autopayInviteText(ctx.company, firstName(ctx.client?.display_name), "[autopay link]")[a.channel === "sms" ? "sms" : "email"] };
      }
      default:
        return { type: a.type };
    }
  });
  return c.json({ record: { type: ctx.subject, id: ctx.id, label: ctx.label, path: ctx.appPath }, pass: check.pass, failed: check.failed ?? null, previews, warnings: [...new Set(warnings)] });
});

async function ownRun(c: Parameters<typeof appUrl>[0]) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(404, "We couldn't find that run.");
  return must(await c.var.db.from("automation_runs").select("id, status").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Run not found.");
}

automations.post("/automations/runs/:id/retry", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const run = await ownRun(c);
  if (run.status !== "failed") throw new HttpError(409, "Only failed runs can be retried.");
  const { error } = await adminClient(c.env).from("automation_runs").update({ status: "pending", run_after: new Date().toISOString(), attempts: 0, busy_tries: 0, error: null, finished_at: null }).eq("id", run.id);
  if (error) throw dbError(error);
  const result = await processAutomations(c.env, { companyId: c.var.companyId, limit: 10, baseUrl: appUrl(c) });
  return c.json(result);
});

automations.post("/automations/runs/:id/cancel", requireUser, requireCompany(OFFICE, "automations"), async (c) => {
  const run = await ownRun(c);
  if (run.status !== "pending") throw new HttpError(409, "Only waiting runs can be cancelled.");
  const { error } = await adminClient(c.env).from("automation_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), error: "Cancelled by the office" }).eq("id", run.id).eq("status", "pending");
  if (error) throw dbError(error);
  return c.json({ status: "cancelled" });
});
