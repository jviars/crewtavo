/**
 * The public demo (CREWTAVO_DEMO=1, the demo branch's instance behind crewtavo.com's "Try the demo").
 *
 * Every visitor gets their own copy of a sample paving company: an owner (Dana), a crew lead
 * (Marcus), a crew member (Luis) and an office manager (Tasha), with clients, quotes, jobs, a week
 * of visits, invoices, equipment and SOPs, the same data as scripts/seed-demo.mjs. Nobody signs up
 * and nobody sees anyone else's changes. Copies are deleted after DEMO_HOURS by the "demo" task.
 *
 * The demo's accounts have random passwords nobody knows: sessions come from one-time sign-in
 * links the server makes and redeems itself, so nothing is ever emailed.
 */
import { TERMS_VERSION, getPreset } from "@crewtavo/core";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import type { Env } from "../env";
import { applyPreset } from "../routes/account";
import { HttpError } from "../lib/http";
import { adminClient, publishableKey, userClient, type Db } from "../lib/supabase";

/** How long a visitor's copy lasts. */
export const DEMO_HOURS = 24;
/** The demo's accounts live here: a domain we own that receives no mail. */
const EMAIL_DOMAIN = "demo.crewtavo.com";
const AUTH_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

export const demoEnabled = (env: Env) => env.CREWTAVO_DEMO === "1";

/** Who a visitor can be in their copy. */
export const DEMO_PEOPLE = {
  owner: { name: "Dana Hale", role: "owner" },
  crew: { name: "Marcus Hale", role: "crew_lead" },
} as const;
export type DemoPerson = keyof typeof DEMO_PEOPLE;

export interface DemoSession {
  access_token: string;
  refresh_token: string;
}

/** Make a visitor's copy and sign them in as its owner. */
export async function startDemo(env: Env): Promise<DemoSession> {
  const admin = adminClient(env);
  const tag = randomBytes(5).toString("hex");
  const created: string[] = [];
  const person = async (first: string, fullName: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `${first}.${tag}@${EMAIL_DOMAIN}`,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
      user_metadata: { full_name: fullName, demo: true },
    });
    if (error || !data.user) throw new Error(`Demo account ${first}: ${error?.message ?? "not created"}`);
    created.push(data.user.id);
    return data.user;
  };
  try {
    const owner = await person("dana", "Dana Hale");
    const crew = await Promise.all([person("marcus", "Marcus Hale"), person("luis", "Luis Ortega"), person("tasha", "Tasha Brooks")]);
    const session = await sessionFor(env, owner.email!);
    await seedCompany(env, userClient(env, session.access_token), crew.map((u) => u.id));
    return session;
  } catch (error) {
    // Half a copy is no use to anyone: take the accounts (and with them the company) back out.
    await removeCompaniesOf(env, created).catch(() => undefined);
    await Promise.all(created.map((id) => admin.auth.admin.deleteUser(id).catch(() => undefined)));
    throw error;
  }
}

/**
 * Sign in as someone else in the caller's copy (the crew lead, to see the crew's My day screen, or
 * the owner again). Only people in a company the caller belongs to.
 */
export async function switchDemoPerson(env: Env, callerId: string, as: DemoPerson): Promise<DemoSession> {
  const admin = adminClient(env);
  const { data: mine } = await admin.from("memberships").select("company_id").eq("user_id", callerId).eq("active", true).limit(1).maybeSingle();
  if (!mine) throw new HttpError(404, "This demo has ended. Start a new one.");
  const { data: target } = await admin
    .from("memberships")
    .select("user_id")
    .eq("company_id", mine.company_id)
    .eq("role", DEMO_PEOPLE[as].role)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!target) throw new HttpError(404, `There's no ${as === "crew" ? "crew lead" : "owner"} in this demo company.`);
  const { data: user, error } = await admin.auth.admin.getUserById(target.user_id);
  if (error || !user.user?.email) throw new HttpError(404, "That person isn't in this demo any more.");
  return sessionFor(env, user.user.email);
}

/** A session for an account, from a one-time sign-in link the server redeems itself. */
async function sessionFor(env: Env, email: string): Promise<DemoSession> {
  const { data, error } = await adminClient(env).auth.admin.generateLink({ type: "magiclink", email });
  if (error || !data.properties?.hashed_token) throw new Error(`Demo sign-in link: ${error?.message ?? "none"}`);
  const anon = createClient(env.SUPABASE_URL, publishableKey(env), { auth: AUTH_OPTIONS });
  const verified = await anon.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: "magiclink" });
  if (verified.error || !verified.data.session) throw new Error(`Demo sign-in: ${verified.error?.message ?? "no session"}`);
  return { access_token: verified.data.session.access_token, refresh_token: verified.data.session.refresh_token };
}

/** The "demo" task: delete copies older than DEMO_HOURS, with their accounts and files. */
export async function removeExpiredDemos(env: Env): Promise<{ removed: number }> {
  if (!demoEnabled(env)) return { removed: 0 };
  const admin = adminClient(env);
  const cutoff = new Date(Date.now() - DEMO_HOURS * 3_600_000).toISOString();
  const { data: companies, error } = await admin.from("companies").select("id").lt("created_at", cutoff).limit(100);
  if (error) throw new Error(error.message);
  const ids = (companies ?? []).map((row) => row.id);
  if (!ids.length) return { removed: 0 };
  // Only copies startDemo made (their owner is a demo account), even if CREWTAVO_DEMO is set by mistake.
  const owners = await admin.from("memberships").select("company_id, user_id").in("company_id", ids).eq("role", "owner");
  const userIds = (owners.data ?? []).map((m) => m.user_id);
  const profiles = userIds.length ? await admin.from("profiles").select("user_id, email").in("user_id", userIds) : { data: [] };
  const demoOwners = new Set((profiles.data ?? []).filter((p) => p.email?.endsWith(`@${EMAIL_DOMAIN}`)).map((p) => p.user_id));
  const expired = new Set((owners.data ?? []).filter((m) => demoOwners.has(m.user_id)).map((m) => m.company_id));
  for (const id of expired) await removeCompany(env, id);
  return { removed: expired.size };
}

async function removeCompaniesOf(env: Env, userIds: string[]) {
  if (!userIds.length) return;
  const { data } = await adminClient(env).from("memberships").select("company_id").in("user_id", userIds);
  for (const id of new Set((data ?? []).map((m) => m.company_id))) await removeCompany(env, id);
}

async function removeCompany(env: Env, companyId: string) {
  const admin = adminClient(env);
  const { data: members } = await admin.from("memberships").select("user_id").eq("company_id", companyId);
  await removeFiles(admin, companyId);
  const { error } = await admin.from("companies").delete().eq("id", companyId);
  if (error) throw new Error(`Removing demo company ${companyId}: ${error.message}`);
  // Everyone in it, unless they're also in a copy that's still running.
  for (const { user_id } of members ?? []) {
    const { count } = await admin.from("memberships").select("user_id", { count: "exact", head: true }).eq("user_id", user_id);
    if (!count) await admin.auth.admin.deleteUser(user_id).catch(() => undefined);
  }
}

/** Uploaded photos and documents live under <company id>/ in the files bucket. */
async function removeFiles(admin: Db, companyId: string) {
  const bucket = admin.storage.from("files");
  const paths: string[] = [];
  const walk = async (folder: string, depth: number) => {
    const { data } = await bucket.list(folder, { limit: 1000 });
    for (const entry of data ?? []) {
      const path = `${folder}/${entry.name}`;
      // Folders come back without an id.
      if (entry.id) paths.push(path);
      else if (depth < 4) await walk(path, depth + 1);
    }
  };
  await walk(companyId, 0);
  for (let i = 0; i < paths.length; i += 100) await bucket.remove(paths.slice(i, i + 100));
}

// ---------------------------------------------------------------------------------------------
// The sample company (kept in step with scripts/seed-demo.mjs)
// ---------------------------------------------------------------------------------------------

type Rows = Record<string, unknown>;

async function must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
  const { data, error } = await promise;
  if (error) throw new Error(`Demo ${what}: ${error.message}`);
  return data as NonNullable<T>;
}

async function seedCompany(env: Env, typed: Db, crewIds: string[]) {
  // The rows below are plain objects, as in the seed script; the database checks them.
  const db = typed as unknown as SupabaseClient;
  const preset = getPreset("paving");
  const company = (await must(typed.rpc("create_company", { p_name: "Acme Paving", p_trade_preset: preset.id, p_timezone: "America/New_York" }), "company")) as string;
  await applyPreset(typed, company, preset);
  await must(typed.rpc("accept_terms", { p_company: company, p_version: TERMS_VERSION }), "license");
  const c = (row: Rows) => ({ company_id: company, ...row });
  const DEFAULTS = { defaultToNull: false };

  await must(
    db.from("companies").update({
      phone: "(540) 483-0000",
      email: "office@acmepaving.test",
      address: { line1: "100 Industrial Dr", city: "Rocky Mount", region: "VA", postal_code: "24151" },
      settings: {
        job_types: ["Driveway replacement", "Overlay", "Sealcoat and striping", "Parking lot", "Municipal work order", "GC subcontract"],
        payment_terms_days: 30,
        default_tax_rate: 0.053,
        depot: { lat: 36.9976, lng: -79.892 },
        working_hours: { start: "07:00", end: "17:30" },
      },
    }).eq("id", company),
    "company details",
  );

  await must(
    db.from("memberships").insert([
      c({ user_id: crewIds[0], role: "crew_lead", labor_rate: 32 }),
      c({ user_id: crewIds[1], role: "field_crew", labor_rate: 24 }),
      c({ user_id: crewIds[2], role: "office", labor_rate: 26 }),
    ]),
    "team",
  );
  const [paveCrew, sealCrew] = await must(
    db.from("crews").insert([c({ name: "Paving crew", color: "#2f7d4f", lead_user_id: crewIds[0] }), c({ name: "Sealcoat crew", color: "#b4691f" })], DEFAULTS).select("id"),
    "crews",
  );
  await must(db.from("crew_members").insert([c({ crew_id: paveCrew.id, user_id: crewIds[0] }), c({ crew_id: paveCrew.id, user_id: crewIds[1] })]), "crew members");

  // --- Clients and properties ---------------------------------------------------------------
  const clientRows = [
    { display_name: "Summit Ridge Builders", company_name: "Summit Ridge Builders LLC", email: "pm@summitridge.test", phone: "(540) 555-0141", status: "active", lead_source: "Referral", tags: ["GC", "Commercial"] },
    { display_name: "Jordan Rivera", email: "jordan.rivera@example.com", phone: "(540) 555-0187", status: "active", lead_source: "Website form", tags: ["Residential"] },
    { display_name: "Town of Rocky Mount", company_name: "Town of Rocky Mount Public Works", email: "publicworks@rockymount.test", phone: "(540) 555-0100", status: "active", lead_source: "Bid", tags: ["Municipal"] },
    { display_name: "Meadowbrook HOA", email: "board@meadowbrookhoa.test", phone: "(540) 555-0122", status: "active", lead_source: "Google", tags: ["HOA"] },
    { display_name: "Priya Shah", email: "priya.shah@example.com", phone: "(540) 555-0163", status: "lead", lead_source: "Website form", tags: ["Residential"] },
    { display_name: "Carl Benton", email: "carl.benton@example.com", phone: "(540) 555-0109", status: "lead", lead_source: "Phone", tags: ["Residential"] },
  ];
  const clients = await must(db.from("clients").insert(clientRows.map(c), DEFAULTS).select("id, display_name"), "clients");
  const byName: Record<string, string> = Object.fromEntries(clients.map((x: { id: string; display_name: string }) => [x.display_name, x.id]));

  const propertyRows = [
    { client: "Summit Ridge Builders", label: "Summit Ridge Phase 2", line1: "2200 Summit Ridge Rd", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 37.0121, lng: -79.8714 },
    { client: "Jordan Rivera", line1: "418 Pell Ave", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9958, lng: -79.8862 },
    { client: "Town of Rocky Mount", label: "Alley program, block 4", line1: "Franklin St & Church St", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9978, lng: -79.8915 },
    { client: "Meadowbrook HOA", label: "Clubhouse lot", line1: "75 Meadowbrook Ln", city: "Wirtz", region: "VA", postal_code: "24184", lat: 37.0942, lng: -79.7731 },
    { client: "Priya Shah", line1: "9 Hillcrest Ct", city: "Boones Mill", region: "VA", postal_code: "24065", lat: 37.1154, lng: -79.9536 },
    { client: "Carl Benton", line1: "1360 Old Franklin Tpke", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9742, lng: -79.9204 },
  ];
  const properties = await must(
    db.from("properties").insert(propertyRows.map(({ client, ...p }) => c({ ...p, client_id: byName[client] })), DEFAULTS).select("id, client_id"),
    "properties",
  );
  const propOf: Record<string, string> = Object.fromEntries(properties.map((p: { id: string; client_id: string }) => [p.client_id, p.id]));
  const at = (client: string) => ({ client_id: byName[client], property_id: propOf[byName[client]!] });
  await must(db.from("property_access").insert(c({ property_id: propOf[byName["Meadowbrook HOA"]!], gate_code: "#2468", instructions: "Gate code at the clubhouse entrance keypad." })), "gate code");

  // --- Requests, quotes, jobs ----------------------------------------------------------------
  type Service = { id: string; name: string; unit: string; unit_price: number; formula: string | null };
  const services = await must(db.from("services").select("id, name, unit, unit_price, formula, formula_target").eq("company_id", company), "services");
  const line = (name: string, quantity: number, extra: Rows = {}) => {
    const s = (services as Service[]).find((x) => x.name === name);
    if (!s) throw new Error(`Demo: the paving preset has no "${name}"`);
    return { service_id: s.id, name: s.name, unit: s.unit, unit_price: s.unit_price, quantity, formula: s.formula, ...extra };
  };

  await must(
    db.from("requests").insert(
      [
        c({ ...at("Priya Shah"), source: "web_form", title: "Driveway estimate request", details: "Gravel drive, about 120 ft long. Would like asphalt before winter.", answers: { surface: "Gravel", size: "120 ft x 12 ft", drainage: "Yes" } }),
        c({ ...at("Carl Benton"), source: "phone", title: "Sealcoat and crack repair", details: "Driveway has spider cracking near the garage." }),
        c({ ...at("Meadowbrook HOA"), source: "email", status: "assessment_complete", title: "Clubhouse lot restripe", details: "42 stalls plus two ADA spaces." }),
      ],
      DEFAULTS,
    ),
    "requests",
  );

  const quote = async (client: string, title: string, status: string, lines: Rows[], extra: Rows = {}) => {
    // An approved quote's lines are locked, so they go in while it's still sent.
    const approved = status === "approved";
    const q = await must(db.from("quotes").insert(c({ ...at(client), title, status: approved ? "sent" : status, tax_rate: 0.053, ...(approved ? {} : extra) })).select("id").single(), `quote ${title}`);
    await must(db.from("quote_line_items").insert(lines.map((l, i) => c({ ...l, quote_id: q.id, sort: i })), DEFAULTS), `lines ${title}`);
    if (approved) await must(db.from("quotes").update({ status, ...extra }).eq("id", q.id), `approve ${title}`);
    return q.id as string;
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  await quote(
    "Jordan Rivera",
    "Driveway replacement, 418 Pell Ave",
    "sent",
    [line("Remove and haul existing asphalt", 1650), line("Grade and compact stone base", 24), line("Hot-mix asphalt surface", 31), line("Sealcoat", 1650, { optional: true, selected: false, description: "Recommended after 6 months" })],
    { sent_at: daysAgo(4), message: "Thanks for having us out. This covers full removal and a new 2.5 inch surface." },
  );
  await quote("Meadowbrook HOA", "Clubhouse lot sealcoat and restripe", "draft", [line("Crack seal", 600), line("Sealcoat", 18400), line("Line striping", 44)]);
  const approvedQuote = await quote(
    "Summit Ridge Builders",
    "Phase 2 subdivision roads (binder + surface)",
    "approved",
    [line("Grade and compact stone base", 410), line("Hot-mix asphalt surface", 620), line("Mobilization and trucking", 24)],
    { approved_at: daysAgo(10) },
  );

  const jobId = (await must(db.rpc("convert_quote_to_job", { p_quote: approvedQuote }), "convert quote")) as string;
  await must(db.from("jobs").update({ po_number: "SR-2207", retainage_pct: 10, default_crew_id: paveCrew.id, weather_rules: [{ applies_to: "Hot-mix asphalt surface", min_temp_f: 50, max_rain_pct: 40 }] }).eq("id", jobId), "job details");

  const [townJob] = await must(
    db.from("jobs").insert(c({ ...at("Town of Rocky Mount"), title: "Alley program, block 4 overlay", status: "requires_invoicing", default_crew_id: paveCrew.id, po_number: "WO-24-118" })).select("id"),
    "town job",
  );
  const { formula: _formula, ...overlay } = line("Asphalt overlay 2 inch", 5200); // job lines don't keep formulas
  await must(db.from("job_line_items").insert([c({ job_id: townJob.id, ...overlay })]), "town job lines");

  const [hoaJob] = await must(
    db
      .from("jobs")
      .insert(
        c({
          ...at("Meadowbrook HOA"),
          title: "Clubhouse lot sweeping (monthly)",
          kind: "recurring",
          recurrence_rule: "FREQ=MONTHLY;BYDAY=1MO",
          starts_on: new Date().toISOString().slice(0, 10),
          active_months: [3, 4, 5, 6, 7, 8, 9, 10, 11],
          visit_duration_min: 90,
          default_crew_id: sealCrew.id,
          billing_mode: "per_visit",
        }),
      )
      .select("id"),
    "recurring job",
  );

  // --- A week of visits (company time zone: America/New_York) --------------------------------
  const tzDate = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const when = (offsetDays: number, hhmm: string) => {
    const day = tzDate(offsetDays);
    // Good enough for demo data: Eastern time is UTC-4 (summer) or UTC-5 (winter).
    const probe = new Date(`${day}T12:00:00Z`);
    const offset = probe.toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT") ? "-04:00" : "-05:00";
    return new Date(`${day}T${hhmm}:00${offset}`).toISOString();
  };
  const summit = propOf[byName["Summit Ridge Builders"]!];
  const town = propOf[byName["Town of Rocky Mount"]!];
  const visits = await must(
    db
      .from("visits")
      .insert(
        [
          c({ job_id: jobId, property_id: summit, title: "Stone base, Phase 2 north loop", starts_at: when(0, "07:00"), ends_at: when(0, "12:00"), crew_id: paveCrew.id, status: "in_progress" }),
          c({ job_id: townJob.id, property_id: town, title: "Overlay final walkthrough", starts_at: when(0, "13:30"), ends_at: when(0, "14:30"), crew_id: paveCrew.id }),
          c({ request_id: null, kind: "assessment", property_id: propOf[byName["Priya Shah"]!], title: "Estimate: Shah driveway", starts_at: when(0, "15:30"), ends_at: when(0, "16:15") }),
          c({ job_id: jobId, property_id: summit, title: "Binder course, Phase 2", starts_at: when(1, "07:00"), ends_at: when(1, "15:00"), crew_id: paveCrew.id }),
          c({ job_id: jobId, property_id: summit, title: "Surface course, Phase 2", starts_at: when(3, "07:00"), ends_at: when(3, "15:00"), crew_id: paveCrew.id }),
          c({ job_id: hoaJob.id, property_id: propOf[byName["Meadowbrook HOA"]!], title: "Clubhouse lot sweeping", scheduled_on: tzDate(2), crew_id: sealCrew.id }),
          c({ job_id: townJob.id, property_id: town, title: "Overlay, block 4 alleys", starts_at: when(-2, "07:00"), ends_at: when(-2, "16:00"), crew_id: paveCrew.id, status: "completed" }),
        ],
        DEFAULTS,
      )
      .select("id, title"),
    "visits",
  );
  await must(
    db.from("visit_assignees").insert([visits[0], visits[1], visits[3]].flatMap((v: { id: string }) => [c({ visit_id: v.id, user_id: crewIds[0] }), c({ visit_id: v.id, user_id: crewIds[1] })])),
    "assignees",
  );

  // --- Invoices ----------------------------------------------------------------------------
  const contract = await must(db.from("job_financials").select("contract_total").eq("job_id", jobId).single(), "contract");
  const progressInvoice = await must(db.rpc("create_invoice_for_job", { p_job: jobId, p_kind: "progress", p_amount: Math.round(Number(contract.contract_total) * 0.4 * 100) / 100 }), "progress invoice");
  await must(db.from("invoices").update({ status: "sent", issued_on: tzDate(-40), due_on: tzDate(-10) }).eq("id", progressInvoice), "overdue invoice");
  const townInvoice = await must(db.rpc("create_invoice_for_job", { p_job: townJob.id }), "town invoice");
  await must(db.from("invoices").update({ status: "sent" }).eq("id", townInvoice), "send town invoice");
  await must(db.from("payments").insert(c({ invoice_id: townInvoice, client_id: byName["Town of Rocky Mount"], amount: 5000, method: "check", notes: "Check #10442" })), "partial payment");

  // --- Promo codes -------------------------------------------------------------------------
  await must(
    db.from("promo_codes").upsert(
      [
        c({ code: "SPRING10", description: "Spring sealcoating special", kind: "percent", value: 10, min_subtotal: 500 }),
        c({ code: "WELCOME50", description: "For new customers", kind: "amount", value: 50, new_clients_only: true }),
      ],
      { onConflict: "company_id,code", ignoreDuplicates: true, defaultToNull: false },
    ),
    "promo codes",
  );

  // --- Equipment ---------------------------------------------------------------------------
  const dateAgo = (n: number) => daysAgo(n).slice(0, 10);
  const [dumpTruck, paver, roller, trailer, sealSkid] = await must(
    db
      .from("equipment")
      .insert(
        [
          c({ name: "Dump truck 1", kind: "truck", meter: "miles", meter_reading: 84210, make: "Ford", model: "F-550", year: 2019, plate: "VA 4471-PV", crew_id: paveCrew.id }),
          c({ name: "Paver", kind: "machine", meter: "hours", meter_reading: 2306, make: "LeeBoy", model: "8520", year: 2017, crew_id: paveCrew.id, notes: "Screed heaters run off the left tank. 15W-40 in the engine." }),
          c({ name: "Roller", kind: "machine", meter: "hours", meter_reading: 1184, make: "Caterpillar", model: "CB2.7", year: 2020, crew_id: paveCrew.id }),
          c({ name: "Lowboy trailer", kind: "trailer", meter: "none", make: "Felling", year: 2018, crew_id: paveCrew.id }),
          c({ name: "Sealcoat skid", kind: "machine", meter: "hours", meter_reading: 412, crew_id: sealCrew.id }),
        ],
        DEFAULTS,
      )
      .select("id"),
    "equipment",
  );
  const plan = (equipment: { id: string }, name: string, every: Rows, baseline: Rows) => c({ equipment_id: equipment.id, name, ...every, ...baseline });
  const [, , , rollerOil] = await must(
    db
      .from("equipment_plans")
      .insert(
        [
          plan(dumpTruck, "Oil change", { every_meter: 5000, every_count: 6, every_unit: "month" }, { baseline_on: dateAgo(110), baseline_meter: 79600 }),
          plan(dumpTruck, "DOT inspection", { every_count: 1, every_unit: "year" }, { baseline_on: dateAgo(356) }),
          plan(paver, "Engine oil and filter", { every_meter: 250 }, { baseline_on: dateAgo(70), baseline_meter: 2040 }),
          plan(roller, "Engine oil and filter", { every_meter: 250, every_count: 1, every_unit: "year" }, { baseline_on: dateAgo(150), baseline_meter: 800 }),
          plan(roller, "Check water spray nozzles", { every_count: 1, every_unit: "month" }, { baseline_on: dateAgo(18) }),
          plan(trailer, "Check tires, lights and brakes", { every_count: 3, every_unit: "month" }, { baseline_on: dateAgo(100) }),
          plan(sealSkid, "Flush pump and lines", { every_count: 2, every_unit: "week" }, { baseline_on: dateAgo(4) }),
        ],
        DEFAULTS,
      )
      .select("id"),
    "maintenance schedules",
  );
  await must(
    db.from("equipment_logs").insert(
      [
        c({ equipment_id: roller.id, kind: "service", plan_id: rollerOil.id, title: "Engine oil and filter", done_on: dateAgo(30), meter_reading: 1050, user_id: crewIds[0] }),
        c({ equipment_id: paver.id, kind: "repair", title: "Replaced hydraulic hose on the hopper", done_on: dateAgo(12), meter_reading: 2280, notes: "Hose was rubbing on the frame. Added a clamp.", user_id: crewIds[0] }),
        c({ equipment_id: paver.id, kind: "reading", done_on: dateAgo(5), meter_reading: 2298, user_id: crewIds[1] }),
      ],
      DEFAULTS,
    ),
    "equipment history",
  );
  await must(db.from("equipment_financials").insert(c({ equipment_id: paver.id, purchase_price: 148500 })), "equipment price");

  // --- SOPs --------------------------------------------------------------------------------
  const cats = (await must(db.from("sop_categories").select("id, name").eq("company_id", company), "categories")) as Array<{ id: string; name: string }>;
  const cat = (n: string) => cats.find((x) => x.name === n)?.id ?? null;
  const sop = (category: string, title: string, html: string, required = false, tags: string[] = []) =>
    c({ category_id: cat(category), title, body_html: html, body_text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), required, tags });
  await must(
    db.from("sop_pages").insert(
      [
        sop("Paving", "Hot-mix laydown temperatures", "<h2>Minimum temperatures</h2><ul><li>Air and base at least <strong>50°F and rising</strong> for surface courses.</li><li>Mat temperature behind the screed: <strong>275–300°F</strong>.</li><li>Stop rolling below 175°F.</li></ul><h2>If a load arrives cold</h2><p>Reject loads below 250°F at the truck and note the ticket number.</p>", true, ["asphalt", "quality"]),
        sop("Safety", "Call 811 before any digging", "<p>Confirm the 811 ticket number and the marking date on the work order <strong>before</strong> any excavation, including sign posts.</p><ol><li>Check the ticket is still valid (Virginia: 15 working days).</li><li>Photograph all paint marks.</li><li>Hand dig within 2 feet of marks.</li></ol>", true, ["safety"]),
        sop("Sealcoating and striping", "Sealcoat cure times", "<p>Keep traffic off for <strong>24 hours</strong>, longer below 60°F or in shade. Don't apply if rain is expected within 24 hours.</p><p>Driveway depth for a residential overlay: 2 inches compacted.</p>", false, ["sealcoat"]),
      ],
      DEFAULTS,
    ),
    "SOPs",
  );
  return company;
}
