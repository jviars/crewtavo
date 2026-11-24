/**
 * The automation engine. Claims due automation_runs, loads the record each run is about,
 * re-checks the rule's conditions against fresh data and performs its actions.
 *
 * Runs are processed every minute by cron, and right away when the web app or a public page
 * reports an action (POST /api/automations/process), so notifications feel instant.
 * A retried run skips actions that already succeeded, so nobody gets the same email twice. An
 * action that has to wait (an automatic review ask during quiet hours: WaitUntil) puts the run back
 * until then, and one with nothing to do says so (Skip) without failing the run.
 *
 * A rule's text to a client waits the same way between 9pm and 8am in the company's time zone
 * (quietTexts), until 8am. "On my way" goes at any hour, and so does an answer to something the
 * client just did. A visit booked, moved or cancelled that would be old news by 8am (the visit is
 * before then) isn't texted late when an email can tell them: the rule's own, or the text's words
 * by email instead. With no email to carry it, the text goes after all.
 *
 * A rule that's an automated campaign (Marketing → Campaigns, services/automatedCampaigns.ts) sends
 * its email as one, tracked. Re-engage past clients (any rule on client.inactive) and Win back lost
 * quotes are marketing: their runs are skipped while Marketing is off and for clients who opted out
 * of marketing or are archived, whatever actions the rule has.
 */
import {
  actionsForTrigger,
  addDays,
  arrivalWindowMin,
  askedTimeLine,
  autopaySettings,
  etaWords,
  evaluateConditions,
  isAutopayTrigger,
  isVisitNotice,
  localDate,
  memberPermissions,
  renderTemplate,
  slotLabel,
  STATUS_ACTION_CHOICES,
  statusChoices,
  taskVars,
  textsAtAnyHour,
  triggerDef,
  type Action,
  type Condition,
  type Facts,
  type SubjectKind,
  type Role,
  type TemplateVars,
} from "@crewtavo/core";
import { daysSinceVisit, type AutomatedCampaign } from "@crewtavo/core/campaigns";
import { hidesExactPrice } from "@crewtavo/core/estimates";
import { inTextQuietHours, marketingOn, REFERRAL_GAP_DAYS, REVIEW_GAP_DAYS, textQuietHoursEnd, textsOffReason } from "@crewtavo/core/marketing";
import { clientRecipients, type Recipient } from "@crewtavo/core/recipients";
import { countsOn } from "@crewtavo/core/money";
import type { Env } from "../env";
import { companyAddress, companyFooter, firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink, KEPT_LINK } from "../lib/links";
import { peopleOnVisits } from "./visitPeople";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { CAMPAIGN_LINK_DAYS, campaignRuleOf, letStretchGo, sendCampaignEmail } from "./automatedCampaigns";
import { sendAutopayInvite } from "./autopay";
import { logoImage } from "./logo";
import { sendReferralAsk } from "./referrals";
import { addressList, recipientsColumn, recipientsFor, sendToEach, stoppedNumbers, type Delivery } from "./recipients";
import { Busy, sendReviewRequest, WaitUntil } from "./reviews";
import { isRoofWork, roofingOn, workKind, type WorkKind } from "./roofPackages";
import { optionsFrom } from "./sales";
import { textWithStopLine } from "./stopLine";
import { noteRefusedText } from "./textsOff";

export interface ActionResult {
  type: string;
  ok: boolean;
  detail: string;
  /** Nothing to do (Marketing is off, the client opted out): not a failure, and not a success either. */
  skipped?: true;
}

/** What an action returns when it had nothing to do, and why. */
export class Skip {
  constructor(readonly detail: string) {}
}

interface CompanyInfo {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  timezone: string;
  currency: string;
  trade_preset: string | null;
  settings: Record<string, unknown>;
  address: Record<string, string | undefined>;
}

export interface RunContext {
  subject: SubjectKind;
  id: string;
  label: string;
  company: CompanyInfo;
  client: {
    id: string;
    display_name: string;
    email: string | null;
    phone: string | null;
    tags: string[];
    status: string;
    lead_source: string | null;
    review_opt_out: boolean;
    marketing_opt_out: boolean;
    sms_opt_out_at: string | null;
    reviewed_at: string | null;
  } | null;
  facts: Facts;
  vars: TemplateVars;
  appPath: string;
  jobId: string | null;
  propertyId: string | null;
  /** A visit as it is now, for the rules about it being booked, moved or cancelled; `gone` when it was deleted. */
  visit?: { status: string; scheduled_on: string | null; starts_at: string | null; gone?: true };
  /** Where a moved or cancelled visit was, as the client last knew it (the event's own: private.visit_notice). */
  was?: { scheduled_on: string | null; starts_at: string | null };
  /** A request whose client picked a time on a booking form: the office's notice of it says when, and whether it's booked. */
  asked?: { status: string; asked_starts_at: string | null; asked_ends_at: string | null };
  /** What started the rule (its trigger), once it's running: some keep to their own rules (sub_offer.*). */
  trigger?: string;
  /** The automated campaign the rule's email is sent as, once it's running. */
  campaign?: AutomatedCampaign;
  /** The run, for recording its campaign email once, and which of its actions this is (from 0). */
  run?: { id: number; activity_id: number | null; action?: number };
  /** The rule waits before it acts (its delay), so its text isn't an answer to what just happened. */
  delayed?: boolean;
  /** The rule emails the client as well as texting them. */
  emailsToo?: boolean;
}

const SUBJECTS: SubjectKind[] = ["client", "request", "quote", "job", "visit", "invoice"];

export function money(amount: number | string | null | undefined, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(Number(amount ?? 0));
}

/** A visit's time as a client reads it: " at 9:00 AM", or with the business's arrival window " between 9:00 AM and 11:00 AM". */
export function visitTime(startsAt: string, timeZone: string, windowMin = 0) {
  const at = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const start = new Date(startsAt).getTime();
  return windowMin ? ` between ${at(start)} and ${at(start + windowMin * 60_000)}` : ` at ${at(start)}`;
}

/**
 * A visit's day and time as a client reads them: "Tuesday, November 17" and " at 9:00 AM" (or the
 * arrival window). The time is empty for an anytime visit, and both for one with no day.
 */
export function visitWhen(startsAt: string | null | undefined, scheduledOn: string | null | undefined, timeZone: string, windowMin = 0): { date: string; time: string } {
  const at = startsAt ?? (scheduledOn ? `${scheduledOn}T12:00:00Z` : null);
  return {
    date: at ? new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: startsAt ? timeZone : "UTC" }) : "",
    time: startsAt ? visitTime(startsAt, timeZone, windowMin) : "",
  };
}

/** A deleted visit, as its "cancelled" event kept it (private.visit_notice), for the message about it. */
export interface GoneVisit {
  title: string;
  kind: string | null;
  client_id: string | null;
  job_id: string | null;
  property_id: string | null;
}

/** A price range as a client reads it: "$18,300 to $21,050" (cents only when an end has them). */
export function moneyRange(low: number | string | null | undefined, high: number | string | null | undefined, currency = "USD") {
  const ends = [Number(low ?? 0), Number(high ?? 0)];
  const digits = ends.every((n) => Number.isInteger(n)) ? 0 : 2;
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${format.format(ends[0]!)} to ${format.format(ends[1]!)}`;
}

export { companyAddress, companyFooter };

type Property = { line1: string; city: string | null; region: string | null } | null;
const addressOf = (p: Property) => (p ? [p.line1, [p.city, p.region].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "");

/**
 * Whether a quote is roof work (roofPackages.ts isRoofWork): its own kind of work with both Roofing
 * and Paving, else the business has Roofing installed or its newest measurement is a roof, or the
 * quote went out as a price range (only Roofing sends those).
 */
async function roofWork(admin: Db, company: CompanyInfo, quoteId: string, sentAsRange: boolean, kind: WorkKind | null): Promise<boolean> {
  if (sentAsRange || isRoofWork(roofingOn(company.settings), null, kind)) return true;
  if (kind) return false;
  const { data } = await admin.from("measurements").select("sections, roof_pitch, roofing_squares").eq("company_id", company.id).eq("quote_id", quoteId).order("updated_at", { ascending: false }).limit(1);
  return isRoofWork(roofingOn(company.settings), data?.[0] ?? null);
}

/** When the client's last visit was: their latest completed job visit or assessment, on a job or a request of theirs. */
async function lastVisit(admin: Db, companyId: string, clientId: string): Promise<Date | null> {
  const latest = (rows: Array<{ completed_at: string | null }> | null) => rows?.[0]?.completed_at ?? null;
  const [onJobs, onRequests] = await Promise.all([
    admin.from("visits").select("completed_at, job:jobs!inner(client_id)").eq("company_id", companyId).eq("job.client_id", clientId).eq("status", "completed")
      .in("kind", ["job", "assessment"]).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1),
    admin.from("visits").select("completed_at, request:requests!inner(client_id)").eq("company_id", companyId).eq("request.client_id", clientId).is("job_id", null)
      .eq("status", "completed").in("kind", ["job", "assessment"]).not("completed_at", "is", null).order("completed_at", { ascending: false }).limit(1),
  ]);
  if (onJobs.error || onRequests.error) throw new Error((onJobs.error ?? onRequests.error)!.message);
  const times = [latest(onJobs.data), latest(onRequests.data)].filter((t): t is string => Boolean(t)).map((t) => Date.parse(t));
  return times.length ? new Date(Math.max(...times)) : null;
}

/**
 * For the "On autopay" condition: whether the client is being charged automatically, that is the
 * company has autopay on and the client has an agreement in force that isn't paused (as
 * private.autopay_ready, less the card's state, which the office fixes with the client). Null when
 * it can't be told.
 */
async function clientOnAutopay(admin: Db, company: CompanyInfo, clientId: string): Promise<Facts["autopay"]> {
  if (!autopaySettings(company.settings).enabled) return "no";
  const { data, error } = await admin
    .from("autopay_authorizations")
    .select("id")
    .eq("company_id", company.id)
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .is("paused_at", null)
    .limit(1);
  if (error) return null;
  return (data ?? []).length ? "yes" : "no";
}

/** For the "On autopay" condition: whether the invoice has an autopay charge that wasn't called off. Null when it can't be told. */
async function invoiceOnAutopay(admin: Db, companyId: string, invoiceId: string): Promise<Facts["autopay"]> {
  const { data, error } = await admin.from("autopay_charges").select("id").eq("company_id", companyId).eq("invoice_id", invoiceId).neq("status", "called_off").limit(1);
  if (error) return null;
  return (data ?? []).length ? "yes" : "no";
}

/**
 * Everything a rule can know about the record it runs on. Null when the record is gone, unless it's
 * a deleted visit whose "cancelled" event kept what a message needs (`gone`).
 */
export async function loadContext(admin: Db, companyId: string, subjectType: string, subjectId: string, gone?: GoneVisit | null): Promise<RunContext | null> {
  if (!SUBJECTS.includes(subjectType as SubjectKind)) return null;
  const subject = subjectType as SubjectKind;

  const { data: company } = await admin.from("companies").select("id, name, phone, email, website, timezone, currency, trade_preset, settings, address").eq("id", companyId).maybeSingle();
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
  let visit: RunContext["visit"];
  let asked: RunContext["asked"];

  switch (subject) {
    case "client": {
      clientId = subjectId;
      appPath = `/clients/${subjectId}`;
      break;
    }
    case "request": {
      const { data } = await admin.from("requests").select("number, title, status, source, client_id, property_id, asked_starts_at, asked_ends_at, property:properties(line1, city, region)").eq("company_id", companyId).eq("id", subjectId).maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      asked = { status: data.status, asked_starts_at: data.asked_starts_at, asked_ends_at: data.asked_ends_at };
      facts = { status: data.status, source: data.source };
      vars = { number: data.number, title: data.title, address: addressOf(data.property as Property) };
      label = `Request #${data.number}`;
      appPath = `/requests/${subjectId}`;
      break;
    }
    case "quote": {
      const { data } = await admin
        .from("quotes")
        .select(
          "number, title, status, total, tax_rate, discount_amount, range_low, range_high, priced_on_site_at, exact_sent_at, roof_package_id, work_kind, option_id, client_id, property_id, package:roof_packages!quotes_roof_package_fkey(roof_service_id), property:properties(line1, city, region), promo:promo_codes(kind, value), lines:quote_line_items(name, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)",
        )
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      // Before the client answers, what's offered: the shared lines and the shown option's, add-ons
      // included (not picked isn't turned down yet). Once they've signed, what they're getting: the
      // shared lines and the option they chose, without the add-ons they left off, as the job has them.
      const answered = data.status === "approved" || data.status === "converted";
      const lines = data.lines.filter((l) => (answered ? countsOn(l, data.option_id) : l.option_id === null || l.option_id === data.option_id));
      facts = { status: data.status, amount: Number(data.total), line_items: lines.map((l) => l.name) };
      // Sent as a price range, the client hasn't seen the exact price (lost or archived since included),
      // so an email about it doesn't show it either. With options and no answer yet, the quote's total is
      // only the option shown, so it says how many there are and the lowest, as the quote's email did.
      const offer = optionsFrom(data);
      const total = hidesExactPrice(data)
        ? moneyRange(data.range_low, data.range_high, co.currency || "USD")
        : offer
          ? `${offer.count} options from ${fmt(offer.from)}`
          : fmt(data.total);
      vars = { number: data.number, title: data.title, total, address: addressOf(data.property as Property) };
      label = `Quote #${data.number}`;
      // A roof package's estimate is worked on in Roofing, where the office books the visit. Every
      // trade has packages now, so a package alone doesn't make it a roof.
      const kind = workKind(co.settings, data.work_kind, data.package ? [data.package.roof_service_id] : []);
      appPath = data.roof_package_id && (await roofWork(admin, co, subjectId, data.range_low !== null, kind)) ? `/roofing/${subjectId}` : `/quotes/${subjectId}`;
      break;
    }
    case "job": {
      const { data } = await admin
        .from("jobs")
        .select("number, title, status, kind, autopay, financials:job_financials(contract_total), client_id, property_id, property:properties(line1, city, region), lines:job_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      propertyId = data.property_id;
      jobId = subjectId;
      facts = {
        status: data.status, kind: data.kind, job_kind: data.kind, amount: Number(data.financials?.contract_total ?? 0), line_items: (data.lines as Array<{ name: string }>).map((l) => l.name),
        autopay: autopaySettings(co.settings).enabled && data.autopay === true ? "yes" : "no",
      };
      vars = { number: data.number, title: data.title, total: fmt(data.financials?.contract_total ?? 0), address: addressOf(data.property as Property) };
      label = `Job #${data.number}`;
      appPath = `/jobs/${subjectId}`;
      break;
    }
    case "visit": {
      const { data } = await admin
        .from("visits")
        .select("title, kind, status, scheduled_on, starts_at, eta_at, job_id, property_id, property:properties(line1, city, region, client_id), job:jobs(client_id, kind), request:requests(client_id)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) {
        if (!gone) return null;
        // Deleted: what its event kept, at the property and on the job it was, if they're still there.
        const [place, job] = await Promise.all([
          gone.property_id ? admin.from("properties").select("line1, city, region").eq("company_id", companyId).eq("id", gone.property_id).maybeSingle() : null,
          gone.job_id ? admin.from("jobs").select("id, kind").eq("company_id", companyId).eq("id", gone.job_id).maybeSingle() : null,
        ]);
        clientId = gone.client_id;
        propertyId = place?.data ? gone.property_id : null;
        jobId = job?.data?.id ?? null;
        facts = { status: "cancelled", kind: gone.kind, job_kind: job?.data?.kind ?? null };
        vars = { title: gone.title, address: addressOf(place?.data ?? null), date: "", time: "", eta: "" };
        label = gone.title;
        appPath = jobId ? `/jobs/${jobId}` : "/schedule";
        visit = { status: "cancelled", scheduled_on: null, starts_at: null, gone: true };
        break;
      }
      const rel = data as unknown as { job: { client_id: string; kind: string } | null; request: { client_id: string } | null; property: (Property & { client_id: string }) | null };
      clientId = rel.job?.client_id ?? rel.request?.client_id ?? rel.property?.client_id ?? null;
      propertyId = data.property_id;
      jobId = data.job_id;
      facts = { status: data.status, kind: data.kind, job_kind: rel.job?.kind ?? null };
      vars = {
        title: data.title,
        address: addressOf(rel.property),
        ...visitWhen(data.starts_at, data.scheduled_on, co.timezone || "UTC", arrivalWindowMin(co.settings)),
        eta: etaWords(data.eta_at),
      };
      visit = { status: data.status, scheduled_on: data.scheduled_on, starts_at: data.starts_at };
      label = data.title;
      appPath = data.job_id ? `/jobs/${data.job_id}` : "/schedule";
      break;
    }
    case "invoice": {
      const { data } = await admin
        .from("invoices")
        .select("number, subject, status, kind, total, balance_due, amount_paid, client_id, job_id, job:jobs(kind), lines:invoice_line_items(name)")
        .eq("company_id", companyId)
        .eq("id", subjectId)
        .maybeSingle();
      if (!data) return null;
      clientId = data.client_id;
      jobId = data.job_id;
      facts = {
        status: data.status, invoice_kind: data.kind, job_kind: (data.job as unknown as { kind: string } | null)?.kind ?? null, amount: Number(data.total), amount_paid: Number(data.amount_paid ?? 0),
        line_items: (data.lines as Array<{ name: string }>).map((l) => l.name), autopay: await invoiceOnAutopay(admin, companyId, subjectId),
      };
      vars = { number: data.number, title: data.subject || `Invoice #${data.number}`, total: fmt(data.total), balance: fmt(data.balance_due) };
      label = `Invoice #${data.number}`;
      appPath = `/invoices/${subjectId}`;
      break;
    }
  }

  let client: RunContext["client"] = null;
  if (clientId) {
    const { data } = await admin
      .from("clients")
      .select("id, display_name, email, phone, tags, status, lead_source, review_opt_out, marketing_opt_out, sms_opt_out_at, reviewed_at")
      .eq("company_id", companyId)
      .eq("id", clientId)
      .maybeSingle();
    client = data ?? null;
    if (subject === "client") {
      if (!client) return null;
      // Days since their last visit, in the company's own dates, as client.inactive counts them.
      const tz = co.timezone || "UTC";
      const last = await lastVisit(admin, companyId, client.id);
      facts = { status: client.status, days_since_visit: last ? daysSinceVisit(last, new Date(), tz) : null, autopay: await clientOnAutopay(admin, co, client.id) };
      vars = { title: client.display_name, last_visit: last ? last.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: tz }) : "" };
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
    ...(visit && { visit }),
    ...(asked?.asked_starts_at && { asked }),
  };
}

/**
 * Adds the signed client link ({{link}}): a quote's or invoice's Client Hub page, or for a client the
 * Hub's home; for a visit that home too, where the client sees their visits and can ask to move one.
 * It's the client's own (own: 1), for the emails and texts that go to their own email and
 * phone. A contact's copy has the office's (officeVars), and everything a rule writes where the team
 * reads it has none (keptVars).
 */
async function withLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl) return ctx;
  if (ctx.subject === "visit") {
    if (!ctx.client) return ctx;
    return { ...ctx, vars: { ...ctx.vars, link: await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, own: 1 }) } };
  }
  if (ctx.subject !== "quote" && ctx.subject !== "invoice" && ctx.subject !== "client") return ctx;
  const link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id, own: 1 });
  return { ...ctx, vars: { ...ctx.vars, link } };
}

/**
 * {{link}} in a re-engage or win-back email is the client's Client Hub home, where they can ask for
 * work (a lost quote can't be approved from its page). It lasts a year, as a review link does: campaign
 * emails are kept and clicked long after a quote's or invoice's would be.
 */
async function withHomeLink(env: Env, ctx: RunContext, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || !ctx.client) return ctx;
  return { ...ctx, vars: { ...ctx.vars, link: await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id }, CAMPAIGN_LINK_DAYS) } };
}

/**
 * Adds what the event itself says, for the triggers that carry it: a sub's offer gives {{sub.name}},
 * {{sub.price}} (the price offered) and, turned down, {{sub.reason}}; a referral credit earned gives
 * {{referral.name}} (the friend's first name), {{referral.credit}} and {{referral.invoice}} (the
 * invoice it went on, if it did). Autopay's give
 * {{autopay.card}} ("Visa ending 4242"), {{autopay.reason}} (why a charge failed) and
 * {{autopay.expires}} ("08/28"), as private.emit wrote them into the activity's data. A client's ask
 * to move or cancel a visit gives {{change.when}} (the time asked for, as the Hub showed it),
 * {{change.message}} and {{change.reason}}, from the request itself: the activity names only which.
 * A visit moved gives {{old.date}} and {{old.time}}, where the client last knew it to be; a visit
 * cancelled has that as its own {{date}} and {{time}}, since by now it has no day or is gone.
 */
export async function withEvent(admin: Db, ctx: RunContext, trigger: string, activityId: number | null | undefined): Promise<RunContext> {
  if ((!triggerDef(trigger)?.variables?.length && trigger !== "visit.cancelled") || activityId == null) return ctx;
  const { data } = await admin.from("activity").select("data").eq("company_id", ctx.company.id).eq("id", activityId).maybeSingle();
  const event = (data?.data ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (v == null ? "" : String(v));
  const amount = (v: unknown) => (v == null ? "" : money(v as number, ctx.company.currency || "USD"));
  if (trigger === "referral.earned") {
    const invoice = event.invoice_number == null ? "" : `#${event.invoice_number}`;
    return { ...ctx, vars: { ...ctx.vars, referral: { name: event.friend_name ? firstName(text(event.friend_name)) : "", credit: amount(event.credit), invoice } } };
  }
  if (isAutopayTrigger(trigger)) {
    return { ...ctx, vars: { ...ctx.vars, autopay: { ...autopayVars(ctx.vars), card: text(event.card), reason: text(event.reason), expires: text(event.expires) } } };
  }
  if (trigger === "visit.reschedule_requested" || trigger === "visit.cancel_requested") {
    const { data: ask } = await admin.from("visit_change_requests").select("starts_at, scheduled_on, message, reason").eq("company_id", ctx.company.id).eq("id", text(event.request_id)).maybeSingle();
    const when = ask?.scheduled_on ? slotLabel({ date: ask.scheduled_on, starts_at: ask.starts_at }, ctx.company.timezone || "UTC", arrivalWindowMin(ctx.company.settings)) : "";
    return { ...ctx, vars: { ...ctx.vars, change: { when, message: text(ask?.message), reason: text(ask?.reason) } } };
  }
  if (trigger === "visit.rescheduled" || trigger === "visit.cancelled") {
    const was = { scheduled_on: event.was_scheduled_on ? text(event.was_scheduled_on) : null, starts_at: event.was_starts_at ? text(event.was_starts_at) : null };
    const when = visitWhen(was.starts_at, was.scheduled_on, ctx.company.timezone || "UTC", arrivalWindowMin(ctx.company.settings));
    return { ...ctx, was, vars: trigger === "visit.cancelled" ? { ...ctx.vars, ...when } : { ...ctx.vars, old: when } };
  }
  return {
    ...ctx,
    vars: { ...ctx.vars, sub: { name: text(event.sub_name), price: amount(event.total), reason: text(event.reason) } },
  };
}

/**
 * Why a rule about a visit being booked, moved or cancelled has nothing to tell the client by the
 * time it runs, ten minutes after the change; null when it goes ahead. The database folds the
 * changes made to the visit meanwhile (private.visit_notice). This is for the rest: a client
 * archived since, a visit that started or whose day passed, and one that's back where it was.
 */
export function visitNoticeSkip(ctx: Pick<RunContext, "client" | "company" | "visit" | "was">, trigger: string, now = new Date()): string | null {
  if (!isVisitNotice(trigger) || !ctx.visit) return null;
  if (ctx.client?.status === "archived") return `${ctx.client.display_name} is archived`;
  const { status, scheduled_on, starts_at } = ctx.visit;
  const onSchedule = status === "scheduled" && Boolean(scheduled_on);
  if (trigger === "visit.cancelled") return onSchedule ? "The visit is back on the schedule" : null;
  if (!onSchedule) return "The visit has started or is off the schedule";
  if (scheduled_on! < localDate(now, ctx.company.timezone || "UTC")) return "The visit's day has passed";
  const sameStart = (a: string | null, b: string | null) => (a && b ? Date.parse(a) === Date.parse(b) : a === b);
  if (trigger === "visit.rescheduled" && ctx.was && ctx.was.scheduled_on === scheduled_on && sameStart(ctx.was.starts_at, starts_at)) return "The visit is back where it was";
  return null;
}

/**
 * Why a day-before reminder isn't sent after all; null when it goes. `day` is the day the reminder
 * was for (its event's own). A visit that has left that day since is reminded the day before its
 * new one (public.emit_visit_reminders goes by the day), and one that came off the schedule isn't
 * reminded at all.
 */
export function reminderSkip(ctx: Pick<RunContext, "visit">, day: string | null): string | null {
  if (!ctx.visit) return null;
  if (ctx.visit.status !== "scheduled") return "The visit has started or is off the schedule";
  if (day && ctx.visit.scheduled_on !== day) return "The visit moved to another day, and is reminded the day before that one";
  return null;
}

/** The day a reminder run's event was for; null when it doesn't say. */
async function reminderDay(admin: Db, companyId: string, activityId: number | null | undefined): Promise<string | null> {
  if (activityId == null) return null;
  const { data } = await admin.from("activity").select("data").eq("company_id", companyId).eq("id", activityId).eq("verb", "visit.reminder").maybeSingle();
  const day = (data?.data as Record<string, unknown> | null | undefined)?.scheduled_on;
  return typeof day === "string" && day ? day : null;
}

/** The deleted visit a "cancelled" run is about, from the event that queued it; null when the event doesn't say. */
async function goneVisit(admin: Db, companyId: string, activityId: number | null | undefined): Promise<GoneVisit | null> {
  if (activityId == null) return null;
  const { data } = await admin.from("activity").select("data").eq("company_id", companyId).eq("id", activityId).eq("verb", "visit.cancelled").maybeSingle();
  const event = (data?.data ?? {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (typeof event.title !== "string") return null;
  return { title: event.title, kind: id(event.kind), client_id: id(event.client_id), job_id: id(event.job_id), property_id: id(event.property_id) };
}

/** The {{autopay.*}} values so far, as an object (none yet is an empty one). */
function autopayVars(vars: TemplateVars): Record<string, string | number | null | undefined> {
  const group = vars.autopay;
  return group && typeof group === "object" ? group : {};
}

/**
 * Adds {{autopay.link}} to rules about autopay: the client's own Hub link to their autopay page
 * (own: 1, and fresh, so it works for the full 120 days), for their emails and texts. Without the
 * app's address, or a client, it stays empty.
 */
export async function withAutopayLink(env: Env, ctx: RunContext, trigger: string, baseUrl: string | null): Promise<RunContext> {
  if (!baseUrl || !ctx.client || !isAutopayTrigger(trigger)) return ctx;
  const link = `${await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, own: 1 })}?view=autopay`;
  return { ...ctx, vars: { ...ctx.vars, autopay: { ...autopayVars(ctx.vars), link } } };
}

/**
 * The values for a client's email or text that goes to one of their contacts: the client links in it
 * are the office's copies (via "office", as Copy Client Hub link makes them), so none can be used to
 * confirm a card for the client or add a tip to their saved card. Everything else is as the client's
 * emails have it.
 */
export async function officeVars(env: Env, ctx: RunContext, baseUrl: string | null): Promise<TemplateVars> {
  if (!baseUrl) return ctx.vars;
  const vars: TemplateVars = { ...ctx.vars };
  if (vars.link && (ctx.subject === "quote" || ctx.subject === "invoice" || ctx.subject === "client")) {
    vars.link = await clientLink(env, baseUrl, { c: ctx.company.id, t: ctx.subject, id: ctx.id, via: "office" });
  }
  if (vars.link && ctx.subject === "visit" && ctx.client) {
    vars.link = await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, via: "office" });
  }
  const group = autopayVars(vars);
  if (group.link && ctx.client) {
    vars.autopay = { ...group, link: `${await clientLink(env, baseUrl, { c: ctx.company.id, t: "client", id: ctx.client.id, via: "office" })}?view=autopay` };
  }
  return vars;
}

/**
 * The values for what the team reads: the office's notices, the notes and tasks a rule adds, the copy
 * of a client's email or text kept on their timeline, and the rule screen's preview. A client link
 * there is no link (lib/links KEPT_LINK): crews read a visit's notes and messages, an AI assistant
 * connected as someone reads what they do, and a link opens the client's page as the client.
 */
export function keptVars(ctx: RunContext): TemplateVars {
  const vars: TemplateVars = { ...ctx.vars };
  if (vars.link) vars.link = KEPT_LINK;
  const group = autopayVars(vars);
  if (group.link) vars.autopay = { ...group, link: KEPT_LINK };
  return vars;
}

export async function buildContext(env: Env, admin: Db, companyId: string, subjectType: string, subjectId: string, baseUrl: string | null, gone?: GoneVisit | null) {
  const ctx = await loadContext(admin, companyId, subjectType, subjectId, gone);
  return ctx ? withLink(env, ctx, baseUrl) : null;
}

const render = (template: string | undefined, ctx: RunContext) => renderTemplate(template ?? "", ctx.vars).trim();

/**
 * Whoever of these the trigger lets hear about it: for a sub's offer (its price), only the office with
 * the Subcontractors area (private.subs_office); for autopay (a client's card, why a charge failed),
 * only the office with the invoices area (private.money_office). That holds whatever levels or people
 * the rule names, so neither a rule saved before someone lost the area nor one written straight to the
 * database tells anyone else.
 */
async function mayHear(admin: Db, ctx: RunContext, people: Array<{ user_id: string; role: string; role_id?: string | null }>) {
  const trigger = ctx.trigger ? triggerDef(ctx.trigger) : undefined;
  if (!trigger?.area && !trigger?.notifyRoles) return people;
  const roleIds = [...new Set(people.map((p) => p.role_id).filter((id): id is string => Boolean(id)))];
  const { data: roles, error } = roleIds.length ? await admin.from("company_roles").select("id, permissions").eq("company_id", ctx.company.id).in("id", roleIds) : { data: [], error: null };
  if (error) throw new Error(error.message);
  const custom = new Map((roles ?? []).map((r) => [r.id, r.permissions as string[]]));
  return people.filter((p) => {
    if (trigger.notifyRoles && !trigger.notifyRoles.includes(p.role)) return false;
    if (!trigger.area) return true;
    // A custom role whose row can't be read counts as having no areas.
    const areas = memberPermissions(p.role as Role, p.role_id ? (custom.get(p.role_id) ?? []) : null);
    return areas.includes(trigger.area);
  });
}

/**
 * What a message a rule sends is about. Rules about autopay carry a client's card and their own link,
 * so their emails and texts are kept as "autopay" messages, which only the office with the invoices
 * area reads (messages_read), not as the record's, which crews who see the client can read.
 */
const messageAbout = (ctx: RunContext, clientId: string) =>
  isAutopayTrigger(ctx.trigger) ? { related_type: "autopay", related_id: clientId } : { related_type: ctx.subject, related_id: ctx.id };

/**
 * A rule whose emails and texts go to the client alone, never their contacts: marketing (re-engage,
 * win-back), a referral credit (theirs), and anything about autopay (their card).
 */
const clientAlone = (ctx: RunContext) => Boolean(ctx.campaign?.marketing) || isAutopayTrigger(ctx.trigger) || ctx.trigger === "referral.earned";

/**
 * Who a rule's email or text goes to: the client and their contacts ticked for it
 * (services/recipients.ts), or the client alone for the rules above. Never a number that texted STOP.
 */
async function peopleFor(admin: Db, ctx: RunContext, client: NonNullable<RunContext["client"]>, channel: "email" | "sms"): Promise<Recipient[]> {
  if (!clientAlone(ctx)) return recipientsFor(admin, ctx.company.id, client, channel, ctx.company.settings);
  const stopped = channel === "sms" ? await stoppedNumbers(admin, ctx.company.id, [client.phone]) : [];
  return clientRecipients(channel, client, [], { contactsOn: false, stopped });
}

/**
 * Who a rule's email or text would reach on this record now, for the rule screen's preview: the
 * addresses or numbers a run would send to (peopleFor), the client's first.
 */
export async function previewRecipients(admin: Db, ctx: RunContext, trigger: string, channel: "email" | "sms"): Promise<string[]> {
  if (!ctx.client) return [];
  return (await peopleFor(admin, { ...ctx, trigger, campaign: campaignRuleOf({ trigger }) ?? undefined }, ctx.client, channel)).map((person) => person.to);
}

/** What a visit notice's email is called when it goes in place of a text that would arrive too late. */
const NOTICE_SUBJECTS: Record<string, string> = {
  "visit.scheduled": "Your visit with {{company.name}} is booked",
  "visit.rescheduled": "Your visit with {{company.name}} has moved",
  "visit.cancelled": "Your visit with {{company.name}} is cancelled",
};

/**
 * Whether the visit a notice is about comes before `morning`, when a text held for quiet hours
 * would go: by then it would be old news. A cancelled visit goes by when it was to be. An anytime
 * visit counts by its day.
 */
export function staleByMorning(ctx: Pick<RunContext, "visit" | "was" | "company">, trigger: string, morning: Date): boolean {
  const at = trigger === "visit.cancelled" ? ctx.was : ctx.visit;
  if (!at) return false;
  if (at.starts_at) return Date.parse(at.starts_at) <= morning.getTime();
  return Boolean(at.scheduled_on) && at.scheduled_on! < localDate(morning, ctx.company.timezone || "UTC");
}

/**
 * Quiet hours for a rule's text to a client (9pm to 8am in the company's time zone): throws
 * WaitUntil so the run waits for 8am, unless the text goes at any hour (core textsAtAnyHour).
 * Returns "stale" for a visit notice that would be old news by then: it goes by email when it can.
 */
export function quietTexts(ctx: Pick<RunContext, "trigger" | "delayed" | "visit" | "was" | "company">, now = new Date()): "stale" | null {
  const timeZone = ctx.company.timezone || "UTC";
  if (textsAtAnyHour(ctx.trigger, ctx.delayed === true) || !inTextQuietHours(now, timeZone)) return null;
  const morning = textQuietHoursEnd(now, timeZone);
  if (ctx.trigger && isVisitNotice(ctx.trigger) && staleByMorning(ctx, ctx.trigger, morning)) return "stale";
  throw new WaitUntil(morning, "Quiet hours: texts to clients wait until 8am");
}

/** For an action's result when it reached some but not all: "; didn't reach bo@example.com (why)". */
const missed = (delivery: Delivery) => (delivery.failed.length ? `; didn't reach ${addressList(delivery.failed)} (${delivery.failed[0]!.reason.replace(/\.$/, "")})` : "");

/**
 * Performs one action. Returns a short description of what happened (a Skip when there was nothing
 * to do), throws with the reason, or throws WaitUntil when it can't happen yet.
 */
export async function performAction(env: Env, admin: Db, ctx: RunContext, action: Action, ruleName: string, baseUrl: string | null): Promise<string | Skip> {
  const client = ctx.client;
  switch (action.type) {
    case "notify": {
      // The team only: a sub isn't sent the office's notices, even on their own visit.
      let query = admin.from("memberships").select("user_id, role, role_id").eq("company_id", ctx.company.id).eq("active", true).neq("role", "subcontractor");
      if (action.user_ids?.length && !action.roles?.length) query = query.in("user_id", action.user_ids);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      // "The people on the visit": the people listed on it, or with nobody listed its crew's members
      // (services/visitPeople.ts); for a job, the people on its next visits (a recurring job has a
      // year of them, so the soonest twenty).
      const onIt = new Set<string>();
      if (action.roles?.includes("assigned") && (ctx.subject === "visit" || ctx.subject === "job")) {
        const visits = ctx.subject === "visit"
          ? [ctx.id]
          : ((await admin.from("visits").select("id").eq("job_id", ctx.id).not("status", "in", "(completed,cancelled)").order("scheduled_on", { nullsFirst: false }).order("id").limit(20)).data ?? []).map((v) => v.id);
        for (const people of (await peopleOnVisits(admin, ctx.company.id, visits)).values()) for (const id of people) onIt.add(id);
      }
      const named = (data ?? []).filter((m) => action.roles?.includes(m.role) || action.user_ids?.includes(m.user_id) || onIt.has(m.user_id));
      if (!named.length) throw new Error("No one on the team matches who this rule notifies.");
      const people = await mayHear(admin, ctx, named);
      if (!people.length) {
        throw new Error(
          ctx.trigger && triggerDef(ctx.trigger)?.area === "invoices"
            ? "Only the office with the Invoices and payments area hears about autopay, and nobody this rule notifies has it."
            : "Only the office with the Subcontractors area hears about subs' offers, and nobody this rule notifies has it.",
        );
      }
      const office = { ...ctx, vars: keptVars(ctx) };
      const title = render(action.title, office) || ruleName;
      // A new request whose client picked a time online says so, whatever the rule's own words are:
      // "Booked online for Tue, Jan 14, 10:00 to 11:00 AM." or "Asked for ... It waits for your OK."
      const picked = ctx.trigger === "request.created" && ctx.asked ? askedTimeLine(ctx.asked, ctx.company.timezone || "UTC") : null;
      const body = [render(action.body, office), picked].filter(Boolean).join("\n") || null;
      const { error: insertError } = await admin.from("notifications").insert(
        people.map((p) => ({ company_id: ctx.company.id, user_id: p.user_id, kind: ctx.subject, title: title.slice(0, 300), body, link: ctx.appPath })),
      );
      if (insertError) throw new Error(insertError.message);
      return `Notified ${people.length} ${people.length === 1 ? "person" : "people"}`;
    }
    case "send_email": {
      // An automated campaign's email goes as one, tracked (Close pending quotes as it always has without APP_URL).
      // A quote's follow-up for a client with no address of their own goes the plain way below, to
      // their contacts ticked for emails.
      if (ctx.campaign && (ctx.campaign.marketing || (baseUrl && (!client || isEmail(client.email))))) return sendCampaignEmail(env, admin, ctx, action, baseUrl);
      if (!client) throw new Error("There's no client on this record.");
      // A quote's follow-up isn't sent for a client who unsubscribed from marketing, whichever way it goes.
      if (ctx.campaign && client.marketing_opt_out) return new Skip(`${client.display_name} unsubscribed from marketing`);
      const people = await peopleFor(admin, ctx, client, "email");
      if (!people.length) throw new Error(`${client.display_name} has no email address.`);
      // The client's own address gets their own links; a contact's the office's copies (officeVars),
      // which can't agree to autopay or tip on the client's card; and the timeline's copy none (keptVars).
      const forContacts = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      const kept = { ...ctx, vars: keptVars(ctx) };
      const delivery = await sendToEach(people, (person) => {
        const from = person.contact_id ? forContacts : ctx;
        const email = renderEmail({ companyName: ctx.company.name, logo: baseUrl ? logoImage(baseUrl, ctx.company.id, ctx.company.settings) : null, text: render(action.body, from), footer: companyFooter(ctx.company) });
        return sendEmail(env, { to: person.to, subject: render(action.subject, from), text: email.text, html: email.html, replyTo: ctx.company.email ?? undefined, fromName: ctx.company.name }, ctx.company.id);
      }, "The email wasn't sent.");
      if (!delivery.went.length) throw new Error(delivery.failed[0]!.reason);
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "email", direction: "out", subject: render(action.subject, kept), body: render(action.body, kept),
        ...messageAbout(ctx, client.id), external_id: delivery.id, sent_by: null, recipients: recipientsColumn(delivery),
      });
      return `Emailed ${addressList(delivery.went)}${missed(delivery)}`;
    }
    case "send_sms": {
      if (!client) throw new Error("There's no client on this record.");
      // Between 9pm and 8am it waits for 8am (the run is put back). A visit notice that would be
      // old news by then goes by email: the rule's own, or the text's words. With no email to
      // carry it, it's texted after all: news of their own early visit, and the only way to tell them.
      let late = "";
      if (quietTexts(ctx) === "stale") {
        const why = "it's quiet hours (9pm to 8am) and the visit is before 8am";
        if (ctx.emailsToo) {
          if ((await peopleFor(admin, ctx, client, "email")).length) return new Skip(`Not texted: ${why}. This rule's email tells them`);
        } else {
          try {
            const emailed = await performAction(env, admin, ctx, { type: "send_email", subject: NOTICE_SUBJECTS[ctx.trigger ?? ""] ?? "About your visit with {{company.name}}", body: action.body }, ruleName, baseUrl);
            if (!(emailed instanceof Skip)) return `${emailed} instead of texting: ${why}`;
          } catch {
            // No address, or email isn't set up: the text is the only way left.
          }
        }
        late = `, in quiet hours: the visit is before 8am and there was no email to tell them by`;
      }
      const people = await peopleFor(admin, ctx, client, "sms");
      if (!people.length) {
        if (!client.phone) throw new Error(`${client.display_name} has no phone number.`);
        // Their phone texted STOP, and there's nobody else to text.
        return new Skip(textsOffReason(client.display_name).replace(/\.$/, ""));
      }
      // As with emails: their own links to the client's own phone, the office's copies to a
      // contact's, and none in the timeline's copy.
      const forContacts = { ...ctx, vars: await officeVars(env, ctx, baseUrl) };
      const kept = { ...ctx, vars: keptVars(ctx) };
      const delivery = await sendToEach(people, async (person) => {
        // The first text a number gets says how to stop them, and a promotional one always does (services/stopLine.ts).
        const result = await textWithStopLine(
          admin, ctx.company.id, person.to, render(action.body, person.contact_id ? forContacts : ctx),
          (body) => sendSms(env, { to: person.to, body }, ctx.company.id),
          { promotional: Boolean(ctx.campaign?.marketing) },
        );
        await noteRefusedText(admin, client, person.to, result, ctx.company.id);
        return result;
      }, "The text wasn't sent.");
      if (!delivery.went.length) throw new Error(delivery.failed[0]!.reason);
      await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "sms", direction: "out", body: render(action.body, kept),
        ...messageAbout(ctx, client.id), external_id: delivery.id, sent_by: null, recipients: recipientsColumn(delivery),
      });
      return `Texted ${addressList(delivery.went)}${late}${missed(delivery)}`;
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
      // Crews who see the client read its notes: nothing about autopay goes there (the database refuses the rule too).
      if (isAutopayTrigger(ctx.trigger)) throw new Error("A rule about autopay can't add a client note (crews can read them).");
      // The team reads notes, so a link in one is no link (keptVars), as the preview shows it.
      const kept = { ...ctx, vars: keptVars(ctx) };
      const { error } = await admin.from("messages").insert({
        company_id: ctx.company.id, client_id: client.id, channel: "note", direction: "internal", body: render(action.body, kept),
        related_type: ctx.subject, related_id: ctx.id, sent_by: null,
      });
      if (error) throw new Error(error.message);
      return "Added a note";
    }
    case "create_task": {
      const today = localDate(new Date(), ctx.company.timezone || "UTC");
      const due = addDays(today, Math.max(0, Math.min(365, Math.round(Number(action.days_from_now) || 0))));
      // A task is on the schedule, where the crew sees it: never a sub's price or reason in it, and
      // a link in it is no link (keptVars), as the preview shows it.
      const office = keptVars(ctx);
      const title = renderTemplate(action.title ?? "", ctx.trigger ? taskVars(ctx.trigger, office) : office).trim();
      const { error } = await admin.from("visits").insert({
        company_id: ctx.company.id, kind: "task", title: (title || ruleName).slice(0, 200), scheduled_on: due, status: "scheduled",
        job_id: ctx.subject === "job" || ctx.subject === "visit" || ctx.subject === "invoice" ? ctx.jobId : null,
        property_id: ctx.propertyId, notes: `Created by the automation “${ruleName}”.`,
      });
      if (error) throw new Error(error.message);
      return `Created a task for ${due}`;
    }
    case "request_review": {
      if (!client) throw new Error("There's no client on this record.");
      const channel = action.channel === "sms" || action.channel === "both" ? action.channel : "email";
      const result = await sendReviewRequest(env, admin, {
        companyId: ctx.company.id, client, jobId: ctx.jobId, channel, baseUrl, automatic: true, skipIfRecentDays: REVIEW_GAP_DAYS, createdBy: null,
      });
      return result.skipped ? new Skip(result.detail) : result.detail;
    }
    case "request_referral": {
      if (!client) throw new Error("There's no client on this record.");
      const result = await sendReferralAsk(env, admin, {
        companyId: ctx.company.id, client, baseUrl, automatic: true, skipIfRecentDays: REFERRAL_GAP_DAYS, createdBy: null,
      });
      return result.skipped ? new Skip(result.detail) : result.detail;
    }
    case "update_status": {
      const allowed = STATUS_ACTION_CHOICES[ctx.subject]?.some((s) => s.value === action.status);
      if (!allowed || (ctx.subject !== "quote" && ctx.subject !== "request")) throw new Error("That status change isn't available for this record.");
      const table = ctx.subject === "quote" ? "quotes" : "requests";
      const { error } = await admin.from(table).update({ status: action.status }).eq("id", ctx.id).eq("company_id", ctx.company.id);
      if (error) throw new Error(error.message);
      return action.status === "lost" ? "Marked lost" : "Archived";
    }
    case "invite_autopay": {
      if (!client) throw new Error("There's no client on this record.");
      // An invite by text keeps quiet hours as any rule's text does.
      if (action.channel === "sms") quietTexts({ ...ctx, trigger: undefined });
      // Skips (already on autopay, invited in the last week) are fine; a reason it can't go out fails the action.
      const result = await sendAutopayInvite(env, admin, {
        companyId: ctx.company.id, clientId: client.id, channel: action.channel === "sms" ? "sms" : "email", baseUrl, createdBy: null, skipIfRecentDays: 7,
      });
      return result.detail;
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
  /** The event that queued it (public.activity). */
  activity_id?: number | null;
  result: unknown;
  /** The batch's claim (claim_automation_runs): this worker holds the run while it still matches. */
  claim_token: string | null;
  /** Times it waited for a busy email service (Busy). */
  busy_tries?: number | null;
}

/** A run waits this many times for a busy email service, then fails. */
export const BUSY_TRIES = 4;
/** How long a run waits for a busy email service after `tries` waits already: 1, 2, 4, then 8 minutes. */
export const busyWait = (tries: number) => 60_000 * 2 ** Math.max(0, Math.min(tries, BUSY_TRIES - 1));

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

/**
 * Skips a run called off by its rule being turned off or Marketing uninstalled after this worker
 * claimed it, when the database's own calling off (only of runs still waiting) missed it. A
 * client.inactive run lets the client's stretch go then too, so they're emailed once it's back on.
 */
async function calledOff(admin: Db, run: RunRow, inactive: boolean, why: string) {
  const outcome = await finish(admin, run, "skipped", [], why);
  if (inactive && outcome !== "lost") await letStretchGo(admin, run.id);
  return outcome;
}

/** What a run said along the way: it's waiting because the email service was busy, so its batch stops there. */
interface RunNotes {
  busy: boolean;
}

export async function executeRun(env: Env, admin: Db, run: RunRow, baseUrl: string | null, notes: RunNotes = { busy: false }): Promise<"done" | "skipped" | "failed" | "waiting" | "lost"> {
  try {
    const { data: rule } = await admin.from("automation_rules").select("id, name, trigger, enabled, delay_minutes, conditions, actions, run_count, template_key").eq("id", run.rule_id).maybeSingle();
    if (!rule || !rule.enabled) return calledOff(admin, run, rule?.trigger === "client.inactive", "The rule was turned off or deleted.");
    if (!run.subject_type || !run.subject_id) return finish(admin, run, "skipped", [], "There was nothing to act on.");
    let loaded = await buildContext(env, admin, run.company_id, run.subject_type, run.subject_id, baseUrl);
    // A visit that was deleted is still told as cancelled, from what its event kept.
    if (!loaded && rule.trigger === "visit.cancelled") {
      const gone = await goneVisit(admin, run.company_id, run.activity_id);
      if (gone) loaded = await buildContext(env, admin, run.company_id, run.subject_type, run.subject_id, baseUrl, gone);
    }
    if (!loaded) return finish(admin, run, "skipped", [], "The record was deleted.");
    const campaign = campaignRuleOf(rule) ?? undefined;
    let ctx: RunContext = await withAutopayLink(
      env,
      { ...(await withEvent(admin, loaded, rule.trigger, run.activity_id)), trigger: rule.trigger, campaign, run: { id: run.id, activity_id: run.activity_id ?? null } },
      rule.trigger,
      baseUrl,
    );
    // A marketing campaign's run does nothing at all (an action a business added, a text, included)
    // while Marketing is off, or for a client who unsubscribed from marketing or is archived.
    if (campaign?.marketing) {
      const who = ctx.client;
      if (!marketingOn(ctx.company.settings)) return calledOff(admin, run, campaign.key === "reengage", "Marketing is off");
      if (who?.marketing_opt_out) return finish(admin, run, "skipped", [], `${who.display_name} unsubscribed from marketing`);
      if (who?.status === "archived") return finish(admin, run, "skipped", [], `${who.display_name} is archived`);
    }
    if (campaign?.marketing) ctx = await withHomeLink(env, ctx, baseUrl);
    // A visit booked, moved or cancelled: nothing to say if it changed back, started or passed while
    // this waited, and multi-day work is one message, sent by its first day's run.
    if (isVisitNotice(rule.trigger)) {
      const why = visitNoticeSkip(ctx, rule.trigger);
      if (why) return finish(admin, run, "skipped", [], why);
      const { data: repeat, error: repeatError } = await admin.rpc("visit_notice_is_repeat", { p_run: run.id });
      if (repeatError) throw new Error(repeatError.message);
      if (repeat) return finish(admin, run, "skipped", [], "Another day of the same multi-day work says it");
    }
    // A reminder for a day the visit has left since, or for a visit that came off the schedule, isn't sent.
    if (rule.trigger === "visit.reminder") {
      const why = reminderSkip(ctx, await reminderDay(admin, run.company_id, run.activity_id));
      if (why) return finish(admin, run, "skipped", [], why);
    }
    // The actions this trigger takes (a sub's offer: notices to the office and tasks), whatever the
    // rule says: a rule written straight to the database doesn't get to text the client a sub's price.
    // A status change is checked by the action itself, as the rule screen checks it.
    const def = triggerDef(rule.trigger);
    const fits = new Set<string>(actionsForTrigger(rule.trigger).map((a) => a.type));
    const fitsTrigger = (action: Action) => (action.type === "update_status" ? !def?.actions || def.actions.includes("update_status") : fits.has(action.type));

    const check = evaluateConditions((rule.conditions ?? []) as unknown as Condition[], ctx.facts, ctx.subject);
    if (!check.pass) {
      const outcome = await finish(admin, run, "skipped", [], `Conditions not met: ${(check.failed ?? "").charAt(0).toLowerCase()}${(check.failed ?? "").slice(1)}.`);
      // A client.inactive run's client changed since it was queued (a tag taken off): their stretch is
      // let go, so they're emailed if they meet the rule again before their next visit.
      if (rule.trigger === "client.inactive" && outcome !== "lost") await letStretchGo(admin, run.id);
      return outcome;
    }

    const prior = Array.isArray(run.result) ? (run.result as ActionResult[]) : [];
    const results: ActionResult[] = [];
    const actions = (rule.actions ?? []) as unknown as Action[];
    // For a text's quiet hours: whether the rule answers something that just happened, and whether it emails too.
    ctx = { ...ctx, delayed: Number(rule.delay_minutes ?? 0) > 0, emailsToo: actions.some((a) => a.type === "send_email") };
    let acted = false;
    for (const [i, action] of actions.entries()) {
      if (prior[i]?.ok && prior[i].type === action.type) {
        results.push(prior[i]);
        continue;
      }
      // An email can take a few minutes (lib/smtp.ts), so the claim is renewed before each action
      // after the first, with what's done so far. If another worker has the run by then, this one
      // stops there: that worker does the rest, skipping what this one did.
      if (!fitsTrigger(action)) {
        results.push({ type: action.type, ok: false, detail: "This action doesn't fit what starts this rule." });
        continue;
      }
      if (acted && !(await renew(admin, run, results))) return "lost";
      acted = true;
      try {
        const done = await performAction(env, admin, { ...ctx, run: { ...ctx.run!, action: i } }, action, rule.name, baseUrl);
        results.push(done instanceof Skip ? { type: action.type, ok: true, skipped: true, detail: done.detail } : { type: action.type, ok: true, detail: done });
      } catch (error) {
        // The email service is busy (Resend's 429 or 5xx): the run waits longer each time, and the
        // batch stops so the rest don't pile in after it. After a few tries it fails, saying why.
        if (error instanceof Busy && (run.busy_tries ?? 0) < BUSY_TRIES) {
          notes.busy = true;
          const wait = busyWait(run.busy_tries ?? 0);
          const minutes = Math.round(wait / 60_000);
          const note = `${error.message.replace(/ Try again in [^.]*\.$/, "")} It's tried again by itself in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
          return postpone(admin, run, new WaitUntil(new Date(Date.now() + wait), note), results, true);
        }
        // Not yet: the run waits with what's done so far, and this action and the ones after it go
        // then. The reason is the run's note, not a result, so the action isn't counted as done.
        if (error instanceof WaitUntil && !(error instanceof Busy)) return postpone(admin, run, error, results);
        results.push({ type: action.type, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    const failure = results.find((r) => !r.ok);
    // A run whose every action had nothing to do is skipped, not done.
    const status = failure ? "failed" : results.length && results.every((r) => r.skipped) ? "skipped" : "done";
    const outcome = await finish(admin, run, status, results, failure ? failure.detail : null);
    // Counted by the worker that finished the run, not by one whose claim had gone.
    if (outcome !== "lost" && outcome !== "skipped") await admin.from("automation_rules").update({ run_count: (rule.run_count ?? 0) + 1, last_run_at: new Date().toISOString() }).eq("id", rule.id);
    return outcome;
  } catch (error) {
    if (error instanceof ClaimUnchecked) throw error;
    console.error("Automation run failed", run.id, error);
    return finish(admin, run, "failed", [], error instanceof Error ? error.message : String(error));
  }
}

/** Puts the run back to wait until the action can happen (`busy`: for a busy email service, counted); "lost" when another worker has it now. */
async function postpone(admin: Db, run: RunRow, wait: WaitUntil, results: ActionResult[], busy = false) {
  const { data: held, error } = await admin.rpc("postpone_automation_run", {
    p_id: run.id, p_token: run.claim_token!, p_until: wait.until.toISOString(), p_result: results as unknown as never, p_note: wait.message, ...(busy ? { p_busy: true } : {}),
  });
  if (error) throw new ClaimUnchecked(error.message);
  return held ? "waiting" : "lost";
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
  const tally = { claimed: claimed.length, done: 0, skipped: 0, failed: 0, waiting: 0, lost: 0 };
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
      const notes: RunNotes = { busy: false };
      tally[await executeRun(env, admin, run, baseUrl, notes)]++;
      // The email service is turning emails away: the rest of the batch goes back for the next pass
      // (finally, below) instead of meeting the same answer.
      if (notes.busy) break;
    }
  } finally {
    // A batch that stops early (the database didn't answer) leaves the runs it didn't get to for the
    // next one right away, instead of until the claim runs out.
    await release(admin, claimed.slice(next));
  }
  return tally;
}
