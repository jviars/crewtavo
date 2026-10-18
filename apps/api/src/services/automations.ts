/**
 * The automation engine. Claims due automation_runs, loads the record each run is about,
 * re-checks the rule's conditions against fresh data and performs its actions.
 *
 * Runs are processed every minute by cron, and right away when the web app or a public page
 * reports an action (POST /api/automations/process), so notifications feel instant.
 * A retried run skips actions that already succeeded, so nobody gets the same email twice.
 */
import {
  addDays,
  evaluateConditions,
  localDate,
  renderTemplate,
  STATUS_ACTION_CHOICES,
  statusChoices,
  type Action,
  type Condition,
  type Facts,
  type SubjectKind,
  type TemplateVars,
} from "@crewtavo/core";
import type { Env } from "../env";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { sendReviewRequest } from "./reviews";

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
}

interface CompanyInfo {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone: string;
  currency: string;
  settings: Record<string, unknown>;
  address: Record<string, string | undefined>;
}

export interface RunContext {
  subject: SubjectKind;
  id: string;
  label: string;
  company: CompanyInfo;
  client: { id: string; display_name: string; email: string | null; phone: string | null; tags: string[]; status: string; lead_source: string | null } | null;
  facts: Facts;
  vars: TemplateVars;
  appPath: string;
  jobId: string | null;
  propertyId: string | null;
}

const SUBJECTS: SubjectKind[] = ["client", "request", "quote", "job", "visit", "invoice"];

export function money(amount: number | string | null | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number(amount ?? 0));
}

export function companyAddress(address: Record<string, string | undefined> | null | undefined): string {
  if (!address) return "";
  return [address.line1, address.line2, [address.city, address.region].filter(Boolean).join(", "), address.postal_code].filter(Boolean).join(", ");
}

type Property = { line1: string; city: string | null; region: string | null } | null;
const addressOf = (p: Property) => (p ? [p.line1, [p.city, p.region].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "");

/** Everything a rule can know about the record it runs on. Null when the record is gone. */
export async function loadContext(admin: Db, companyId: string, subjectType: string, subjectId: string): Promise<RunContext | null> {
  if (!SUBJECTS.includes(subjectType as SubjectKind)) return null;
  const subject = subjectType as SubjectKind;

  const { data: company } = await admin.from("companies").select("id, name, phone, email, website, timezone, currency, settings, address").eq("id", companyId).maybeSingle();
  if (!company) return null;
  const co = company as unknown as CompanyInfo;
  const fmt = (n: number | string | null | undefined) => money(n, co.currency || "USD");

  let clientId: string | null = null;
  let facts: Facts = {};
  let vars: TemplateVars = {};
  let label = "";
  let appPath = "/";
  let jobId: string | null = null;
  let propertyId: string | null = null;

  switch (subject) {
    case "client": {
      clientId = subjectId;
      appPath = `/clients/${subjectId}`;
      break;
    }
    case "request": {
      const { data } = await admin.from("requests").select("number, title, status, source, client_id, property_id, property:properties(line1, city, region)").eq("company_id", companyId).eq("id", subjectId).maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      facts = { status: data.status, source: data.source };
      vars = { number: data.number, title: data.title, address: addressOf(data.property as Property) };
      label = `Request #${data.number}`;
      appPath = `/requests/${subjectId}`;
      break;
    }
    case "quote": {
      const { data } = await admin
        .from("quotes")
        .select("number, title, status, total, client_id, property_id, property:properties(line1, city, region), lines:quote_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      facts = { status: data.status, amount: Number(data.total), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name) };
      vars = { number: data.number, title: data.title, total: fmt(data.total), address: addressOf(data.property as Property) };
      label = `Quote #${data.number}`;
      appPath = `/quotes/${subjectId}`;
      break;
    }
    case "job": {
      const { data } = await admin
        .from("jobs")
        .select("number, title, status, kind, financials:job_financials(contract_total), client_id, property_id, property:properties(line1, city, region), lines:job_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      jobId = subjectId;
      facts = { status: data.status, kind: data.kind, amount: Number(data.financials?.contract_total ?? 0), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name) };
      vars = { number: data.number, title: data.title, total: fmt(data.financials?.contract_total ?? 0), address: addressOf(data.property as Property) };
      label = `Job #${data.number}`;
      appPath = `/jobs/${subjectId}`;
      break;
    }
    case "visit": {
      const { data } = await admin
        .from("visits")
        .select("title, kind, status, scheduled_on, starts_at, job_id, property_id, property:properties(line1, city, region, client_id), job:jobs(client_id), request:requests(client_id)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      const rel = data as unknown as { job: { client_id: string } | null; request: { client_id: string } | null; property: (Property & { client_id: string }) | null };
      clientId = rel.job?.client_id ?? rel.request?.client_id ?? rel.property?.client_id ?? null;
      propertyId = data.property_id;
      jobId = data.job_id;
      facts = { status: data.status, kind: data.kind };
      const tz = co.timezone || "UTC";
      const date = data.starts_at ?? (data.scheduled_on ? `${data.scheduled_on}T12:00:00Z` : null);
      vars = {
        title: data.title,
        address: addressOf(rel.property),
        date: date ? new Date(date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: data.starts_at ? tz : "UTC" }) : "",
        time: data.starts_at ? ` at ${new Date(data.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })}` : "",
      };
      label = data.title;
      appPath = data.job_id ? `/jobs/${data.job_id}` : "/schedule";
      break;
    }
    case "invoice": {
      const { data } = await admin
        .from("invoices")
        .select("number, subject, status, total, balance_due, client_id, job_id, lines:invoice_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      jobId = data.job_id;
      facts = { status: data.status, amount: Number(data.total), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name) };
      vars = { number: data.number, title: data.subject || `Invoice #${data.number}`, total: fmt(data.total), balance: fmt(data.balance_due) };
      label = `Invoice #${data.number}`;
      appPath = `/invoices/${subjectId}`;
      break;
    }
  }

  let client: RunContext["client"] = null;
  if (clientId) {
    const { data } = await admin.from("clients").select("id, display_name, email, phone, tags, status, lead_source").eq("company_id", companyId).eq("id", clientId).maybeSingle();
    client = data ?? null;
    if (subject === "client") {
      if (!client) return null;
      facts = { status: client.status };
      vars = { title: client.display_name };
      label = client.display_name;
    }
  }
  facts.client = client ? { tags: client.tags, status: client.status, lead_source: client.lead_source } : null;

  return {
    subject,
    id: subjectId,
    label: client && subject !== "client" ? `${label} · ${client.display_name}` : label,
    company: co,
    client,
    facts,
    vars: {
      ...vars,
      status: statusChoices(subject).find((s) => s.value === facts.status)?.label ?? facts.status ?? "",
      client: { name: client?.display_name ?? "", first_name: firstName(client?.display_name), email: client?.email ?? "", phone: client?.phone ?? "" },
      company: { name: co.name, phone: co.phone ?? "", email: co.email ?? "", website: co.website ?? "" },
    },
    appPath,
    jobId,
    propertyId,
  };
}

/** Adds the signed client link ({{link}}) for quotes and invoices. */
async function withLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || (ctx.subject !== "quote" && ctx.subject !== "invoice")) return ctx;
  const link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id });
  return { ...ctx, vars: { ...ctx.vars, link } };
}

export async function buildContext(env: Env, admin: Db, companyId: string, subjectType: string, subjectId: string, baseUrl: string | null) {
  const ctx = await loadContext(admin, companyId, subjectType, subjectId);
  return ctx ? withLink(env, ctx, baseUrl) : null;
}

const render = (template: string | undefined, ctx: RunContext) => renderTemplate(template ?? "", ctx.vars).trim();

function companyFooter(company: CompanyInfo) {
  return [company.name, companyAddress(company.address)].filter(Boolean).join(" · ");
}

/** Performs one action. Returns a short description of what happened, or throws with the reason. */
export async function performAction(env: Env, admin: Db, ctx: RunContext, action: Action, ruleName: string, baseUrl: string | null): Promise<string> {
  const client = ctx.client;
  switch (action.type) {
    case "notify": {
      let query = admin.from("memberships").select("user_id, role").eq("company_id", ctx.company.id).eq("active", true);
      if (action.user_ids?.length && !action.roles?.length) query = query.in("user_id", action.user_ids);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      // "The people on the visit": its crew, or for a job, the people on its upcoming visits.
      const onIt = new Set<string>();
      if (action.roles?.includes("assigned") && (ctx.subject === "visit" || ctx.subject === "job")) {
        const visits = ctx.subject === "visit"
          ? [ctx.id]
          : ((await admin.from("visits").select("id").eq("job_id", ctx.id).not("status", "in", "(completed,cancelled)").limit(20)).data ?? []).map((v) => v.id);
        const { data: assigned } = visits.length ? await admin.from("visit_assignees").select("user_id").in("visit_id", visits) : { data: [] };
        for (const a of assigned ?? []) onIt.add(a.user_id);
      }
      const people = (data ?? []).filter((m) => action.roles?.includes(m.role) || action.user_ids?.includes(m.user_id) || onIt.has(m.user_id));
      if (!people.length) throw new Error("No one on the team matches who this rule notifies.");
      const title = render(action.title, ctx) || ruleName;
      const { error: insertError } = await admin.from("notifications").insert(
        people.map((p) => ({ company_id: ctx.company.id, user_id: p.user_id, kind: ctx.subject, title: title.slice(0, 300), body: render(action.body, ctx) || null, link: ctx.appPath })),
      );
      if (insertError) throw new Error(insertError.message);
      return `Notified ${people.length} ${people.length === 1 ? "person" : "people"}`;
    }
    case "send_email": {
      if (!client) throw new Error("There's no client on this record.");
      if (!isEmail(client.email)) throw new Error(`${client.display_name} has no email address.`);
      const subject = render(action.subject, ctx);
      const text = render(action.body, ctx);
      const email = renderEmail({ companyName: ctx.company.name, text, footer: companyFooter(ctx.company) });
      const result = await sendEmail(env, { to: client.email!.trim(), subject, text: email.text, html: email.html, replyTo: ctx.company.email ?? undefined, fromName: ctx.company.name }, ctx.company.id);
      if (!result.sent) throw new Error(result.reason ?? "The email wasn't sent.");
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "email", direction: "out", subject, body: text,
        related_type: ctx.subject, related_id: ctx.id, external_id: result.id ?? null, sent_by: null,
      });
      return `Emailed ${client.email}`;
    }
    case "send_sms": {
      if (!client) throw new Error("There's no client on this record.");
      if (!client.phone) throw new Error(`${client.display_name} has no phone number.`);
      const body = render(action.body, ctx);
      const result = await sendSms(env, { to: client.phone, body });
      if (!result.sent) throw new Error(result.reason ?? "The text wasn't sent.");
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "sms", direction: "out", body,
        related_type: ctx.subject, related_id: ctx.id, external_id: result.id ?? null, sent_by: null,
      });
      return `Texted ${client.phone}`;
    }
    case "add_tag":
    case "remove_tag": {
      if (!client) throw new Error("There's no client on this record.");
      const tag = action.tag.trim();
      const has = client.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
      if (action.type === "add_tag" && has) return `Already tagged “${tag}”`;
      if (action.type === "remove_tag" && !has) return `Didn't have the tag “${tag}”`;
      const tags = action.type === "add_tag" ? [...client.tags, tag] : client.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
      const { error } = await admin.from("clients").update({ tags }).eq("id", client.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      client.tags = tags;
      return action.type === "add_tag" ? `Tagged “${tag}”` : `Removed “${tag}”`;
    }
    case "add_note": {
      if (!client) throw new Error("There's no client on this record.");
      const { error } = await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "note", direction: "internal", body: render(action.body, ctx),
        related_type: ctx.subject, related_id: ctx.id, sent_by: null,
      });
      if (error) throw new Error(error.message);
      return "Added a note";
    }
    case "create_task": {
      const today = localDate(new Date(), ctx.company.timezone || "UTC");
      const due = addDays(today, Math.max(0, Math.min(365, Math.round(Number(action.days_from_now) || 0))));
      const { error } = await admin.from("visits").insert({
        company_id: ctx.company.id, kind: "task", title: (render(action.title, ctx) || ruleName).slice(0, 200), scheduled_on: due, status: "scheduled",
        job_id: ctx.subject === "job" || ctx.subject === "visit" || ctx.subject === "invoice" ? ctx.jobId : null,
        property_id: ctx.propertyId, notes: `Created by the automation “${ruleName}”.`,
      });
      if (error) throw new Error(error.message);
      return `Created a task for ${due}`;
    }
    case "request_review": {
      if (!client) throw new Error("There's no client on this record.");
      const result = await sendReviewRequest(env, admin, {
        companyId: ctx.company.id, client, jobId: ctx.jobId, channel: action.channel === "sms" ? "sms" : "email", baseUrl, skipIfRecentDays: 30, createdBy: null,
      });
      return result.detail;
    }
    case "update_status": {
      const allowed = STATUS_ACTION_CHOICES[ctx.subject]?.some((s) => s.value === action.status);
      if (!allowed || (ctx.subject !== "quote" && ctx.subject !== "request")) throw new Error("That status change isn't available for this record.");
      const table = ctx.subject === "quote" ? "quotes" : "requests";
      const { error } = await admin.from(table).update({ status: action.status }).eq("id", ctx.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      return action.status === "lost" ? "Marked lost" : "Archived";
    }
    default:
      throw new Error("Unknown action.");
  }
}

interface RunRow {
  id: number;
  company_id: string;
  rule_id: string;
  subject_type: string | null;
  subject_id: string | null;
  result: unknown;
  /** The batch's claim (claim_automation_runs): this worker holds the run while it still matches. */
  claim_token: string | null;
}

/** The claim couldn't be checked, so the run is left as it is; it's retried once the claim runs out. */
class ClaimUnchecked extends Error {}

/** Records how the run went if this worker still holds it; "lost" when another worker has it now. */
async function finish(admin: Db, run: RunRow, status: "done" | "skipped" | "failed", result: ActionResult[], error: string | null) {
  const { data: held, error: finishError } = await admin.rpc("finish_automation_run", {
    p_id: run.id, p_token: run.claim_token!, p_status: status, p_result: result as unknown as never, p_error: error ?? undefined,
  });
  return !finishError && !held ? "lost" : status;
}

/** Five more minutes on this worker's claim, keeping the actions done so far; false once it's another's. */
async function renew(admin: Db, run: RunRow, results: ActionResult[]) {
  const { data, error } = await admin.rpc("renew_automation_run", { p_id: run.id, p_token: run.claim_token!, p_result: results as unknown as never });
  if (error) throw new ClaimUnchecked(error.message);
  return data === true;
}

export async function executeRun(env: Env, admin: Db, run: RunRow, baseUrl: string | null): Promise<"done" | "skipped" | "failed" | "lost"> {
  try {
    const { data: rule } = await admin.from("automation_rules").select("id, name, enabled, conditions, actions, run_count").eq("id", run.rule_id).maybeSingle();
    if (!rule || !rule.enabled) return finish(admin, run, "skipped", [], "The rule was turned off or deleted.");
    if (!run.subject_type || !run.subject_id) return finish(admin, run, "skipped", [], "There was nothing to act on.");
    const ctx = await buildContext(env, admin, run.company_id, run.subject_type, run.subject_id, baseUrl);
    if (!ctx) return finish(admin, run, "skipped", [], "The record was deleted.");

    const check = evaluateConditions((rule.conditions ?? []) as unknown as Condition[], ctx.facts, ctx.subject);
    if (!check.pass) return finish(admin, run, "skipped", [], `Conditions not met: ${(check.failed ?? "").charAt(0).toLowerCase()}${(check.failed ?? "").slice(1)}.`);

    const prior = Array.isArray(run.result) ? (run.result as ActionResult[]) : [];
    const results: ActionResult[] = [];
    const actions = (rule.actions ?? []) as unknown as Action[];
    let acted = false;
    for (const [i, action] of actions.entries()) {
      if (prior[i]?.ok && prior[i].type === action.type) {
        results.push(prior[i]);
        continue;
      }
      // An email can take a few minutes (lib/smtp.ts), so the claim is renewed before each action
      // after the first, with what's done so far. If another worker has the run by then, this one
      // stops there: that worker does the rest, skipping what this one did.
      if (acted && !(await renew(admin, run, results))) return "lost";
      acted = true;
      try {
        results.push({ type: action.type, ok: true, detail: await performAction(env, admin, ctx, action, rule.name, baseUrl) });
      } catch (error) {
        results.push({ type: action.type, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const failure = results.find((r) => !r.ok);
    const outcome = await finish(admin, run, failure ? "failed" : "done", results, failure ? failure.detail : null);
    // Counted by the worker that finished the run, not by one whose claim had gone.
    if (outcome !== "lost") await admin.from("automation_rules").update({ run_count: (rule.run_count ?? 0) + 1, last_run_at: new Date().toISOString() }).eq("id", rule.id);
    return outcome;
  } catch (error) {
    if (error instanceof ClaimUnchecked) throw error;
    console.error("Automation run failed", run.id, error);
    return finish(admin, run, "failed", [], error instanceof Error ? error.message : String(error));
  }
}

/** Runs this worker claimed but never started go back to waiting, without using an attempt. */
async function release(admin: Db, runs: RunRow[]) {
  if (runs.length) await admin.rpc("release_automation_runs", { p_token: runs[0]!.claim_token!, p_ids: runs.map((r) => r.id) });
}

export async function processAutomations(env: Env, options: { companyId?: string; limit?: number; baseUrl?: string | null } = {}) {
  const admin = adminClient(env);
  const baseUrl = options.baseUrl ?? env.APP_URL ?? null;
  const { data: runs, error } = await admin.rpc("claim_automation_runs", { p_limit: options.limit ?? 25, ...(options.companyId ? { p_company: options.companyId } : {}) });
  if (error) throw new Error(error.message);
  const claimed = runs ?? [];
  const tally = { claimed: claimed.length, done: 0, skipped: 0, failed: 0, lost: 0 };
  let next = 0; // the first run not started yet
  try {
    for (const [index, run] of claimed.entries()) {
      next = index;
      // A batch is claimed for five minutes and a slow one can outlast that, so confirm (and extend)
      // this run's claim right before doing it, which is also when the attempt counts. If that fails,
      // another worker has claimed the run since.
      const { data: held, error: startError } = await admin.rpc("start_automation_run", { p_id: run.id, p_token: run.claim_token! });
      if (startError) throw new Error(startError.message);
      next = index + 1;
      if (!held) {
        tally.lost++;
        continue;
      }
      tally[await executeRun(env, admin, run, baseUrl)]++;
    }
  } finally {
    // A batch that stops early (the database didn't answer) leaves the runs it didn't get to for the
    // next one right away, instead of until the claim runs out.
    await release(admin, claimed.slice(next));
  }
  return tally;
}
