#!/usr/bin/env node
/**
 * Loads a demo company for local development and screenshots: a paving business with clients,
 * requests, quotes, jobs, a week of visits, invoices, crews, equipment and SOPs.
 *
 *   npm run seed:demo            (reads .dev.vars; needs the API running for onboarding)
 *
 * Signs in as demo@crewtavo.test / crewtavo-demo (created if missing). Safe to rerun: it skips
 * if the demo user already has a company. Never point this at production.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const URL_ = vars.SUPABASE_URL;
const API = process.env.CREWTAVO_API_URL ?? "http://localhost:8787";
if (!/localhost|127\.0\.0\.1/.test(URL_)) {
  console.error("seed-demo only runs against a local Supabase (SUPABASE_URL must be localhost).");
  process.exit(1);
}

const EMAIL = "demo@crewtavo.test";
const PASSWORD = "crewtavo-demo";
const admin = createClient(URL_, vars.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const db = createClient(URL_, vars.SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });

const DEFAULTS = { defaultToNull: false };

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// --- People ---------------------------------------------------------------------------------
async function ensureUser(email, password, fullName) {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((u) => u.email === email);
  if (existing) return existing.id;
  const created = await must(
    admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
    `create ${email}`,
  );
  return created.user.id;
}

const ownerId = await ensureUser(EMAIL, PASSWORD, "Dana Hale");
const crewIds = [
  await ensureUser("marcus@crewtavo.test", PASSWORD, "Marcus Hale"),
  await ensureUser("luis@crewtavo.test", PASSWORD, "Luis Ortega"),
  await ensureUser("tasha@crewtavo.test", PASSWORD, "Tasha Brooks"),
];
await must(db.auth.signInWithPassword({ email: EMAIL, password: PASSWORD }), "sign in");
const { data: sessionData } = await db.auth.getSession();
const token = sessionData.session.access_token;

const existing = await must(db.from("memberships").select("company_id").eq("user_id", ownerId), "memberships");
if (existing.length) {
  console.log(`Demo company already exists. Sign in as ${EMAIL} / ${PASSWORD}`);
  process.exit(0);
}

// --- Company via the real onboarding endpoint (applies the Paving preset) -------------------
// Setting up a business agrees to the Crewtavo License, as the onboarding screen does.
const { termsVersion } = await (await fetch(`${API}/api/config`)).json();
const res = await fetch(`${API}/api/companies`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Acme Paving", trade_preset: "paving", timezone: "America/New_York", terms_version: termsVersion }),
});
if (!res.ok) throw new Error(`onboarding failed: ${res.status} ${await res.text()}`);
const { id: company } = await res.json();
const c = (row) => ({ company_id: company, ...row });

await must(
  db.from("companies").update({
    phone: "(540) 483-0000",
    email: "office@acmepaving.test",
    address: { line1: "100 Industrial Dr", city: "Rocky Mount", region: "VA", postal_code: "24151" },
    settings: {
      job_types: ["Driveway replacement", "Overlay", "Sealcoat and striping", "Parking lot", "Municipal work order", "GC subcontract"],
      payment_terms_days: 30,
      default_tax_rate: 0.053,
      depot: { lat: 36.9976, lng: -79.8920 },
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

// --- Clients and properties -----------------------------------------------------------------
const clientRows = [
  { display_name: "Summit Ridge Builders", company_name: "Summit Ridge Builders LLC", email: "pm@summitridge.test", phone: "(540) 555-0141", status: "active", lead_source: "Referral", tags: ["GC", "Commercial"] },
  { display_name: "Jordan Rivera", email: "jordan.rivera@example.com", phone: "(540) 555-0187", status: "active", lead_source: "Website form", tags: ["Residential"] },
  { display_name: "Town of Rocky Mount", company_name: "Town of Rocky Mount Public Works", email: "publicworks@rockymount.test", phone: "(540) 555-0100", status: "active", lead_source: "Bid", tags: ["Municipal"] },
  { display_name: "Meadowbrook HOA", email: "board@meadowbrookhoa.test", phone: "(540) 555-0122", status: "active", lead_source: "Google", tags: ["HOA"] },
  { display_name: "Priya Shah", email: "priya.shah@example.com", phone: "(540) 555-0163", status: "lead", lead_source: "Website form", tags: ["Residential"] },
  { display_name: "Carl Benton", email: "carl.benton@example.com", phone: "(540) 555-0109", status: "lead", lead_source: "Phone", tags: ["Residential"] },
];
const clients = await must(db.from("clients").insert(clientRows.map(c), DEFAULTS).select("id, display_name"), "clients");
const byName = Object.fromEntries(clients.map((x) => [x.display_name, x.id]));

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
const propOf = Object.fromEntries(properties.map((p) => [p.client_id, p.id]));
await must(db.from("property_access").insert(c({ property_id: propOf[byName["Meadowbrook HOA"]], gate_code: "#2468", instructions: "Gate code at the clubhouse entrance keypad." })), "gate code");

// --- Requests, quotes, jobs ------------------------------------------------------------------
const services = await must(db.from("services").select("id, name, unit, unit_price, formula, formula_target").eq("company_id", company), "services");
const svc = (name) => services.find((s) => s.name === name);
const line = (name, quantity, extra = {}) => {
  const s = svc(name);
  return { service_id: s.id, name: s.name, unit: s.unit, unit_price: s.unit_price, quantity, formula: s.formula, ...extra };
};

await must(
  db.from("requests").insert([
    c({ client_id: byName["Priya Shah"], property_id: propOf[byName["Priya Shah"]], source: "web_form", title: "Driveway estimate request", details: "Gravel drive, about 120 ft long. Would like asphalt before winter.", answers: { surface: "Gravel", size: "120 ft x 12 ft", drainage: "Yes" } }),
    c({ client_id: byName["Carl Benton"], property_id: propOf[byName["Carl Benton"]], source: "phone", title: "Sealcoat and crack repair", details: "Driveway has spider cracking near the garage." }),
    c({ client_id: byName["Meadowbrook HOA"], property_id: propOf[byName["Meadowbrook HOA"]], source: "email", status: "assessment_complete", title: "Clubhouse lot restripe", details: "42 stalls plus two ADA spaces." }),
  ], DEFAULTS),
  "requests",
);

async function quote(client, title, status, lines, extra = {}) {
  // An approved quote's lines are locked, so they go in while it's still sent.
  const approved = status === "approved";
  const q = await must(
    db.from("quotes").insert(c({ client_id: byName[client], property_id: propOf[byName[client]], title, status: approved ? "sent" : status, tax_rate: 0.053, ...(approved ? {} : extra) })).select("id").single(),
    `quote ${title}`,
  );
  await must(db.from("quote_line_items").insert(lines.map((l, i) => c({ ...l, quote_id: q.id, sort: i })), DEFAULTS), `lines ${title}`);
  if (approved) await must(db.from("quotes").update({ status, ...extra }).eq("id", q.id), `approve ${title}`);
  return q.id;
}
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
await quote("Jordan Rivera", "Driveway replacement, 418 Pell Ave", "sent", [
  line("Remove and haul existing asphalt", 1650),
  line("Grade and compact stone base", 24),
  line("Hot-mix asphalt surface", 31),
  line("Sealcoat", 1650, { optional: true, selected: false, description: "Recommended after 6 months" }),
], { sent_at: daysAgo(4), message: "Thanks for having us out. This covers full removal and a new 2.5 inch surface." });
await quote("Meadowbrook HOA", "Clubhouse lot sealcoat and restripe", "draft", [line("Hot-pour crack seal", 600), line("Sealcoat", 18400), line("Line striping", 846)]);
const approvedQuote = await quote("Summit Ridge Builders", "Phase 2 subdivision roads (binder + surface)", "approved", [
  line("Grade and compact stone base", 410),
  line("Hot-mix asphalt surface", 620),
  line("Mobilization and trucking", 24),
], { approved_at: daysAgo(10) });

const jobId = await must(db.rpc("convert_quote_to_job", { p_quote: approvedQuote }), "convert quote");
await must(db.from("jobs").update({ po_number: "SR-2207", retainage_pct: 10, default_crew_id: paveCrew.id, weather_rules: [{ applies_to: "Hot-mix asphalt surface", min_temp_f: 50, max_rain_pct: 40 }] }).eq("id", jobId), "job details");

const [townJob] = await must(
  db.from("jobs").insert(c({ client_id: byName["Town of Rocky Mount"], property_id: propOf[byName["Town of Rocky Mount"]], title: "Alley program, block 4 overlay", status: "requires_invoicing", default_crew_id: paveCrew.id, po_number: "WO-24-118" })).select("id"),
  "town job",
);
const { formula: _formula, ...overlay } = line("Mill and overlay 2 inch", 5200); // job lines don't keep formulas
await must(db.from("job_line_items").insert([c({ job_id: townJob.id, ...overlay })]), "town job lines");

const [hoaJob] = await must(
  db.from("jobs").insert(c({
    client_id: byName["Meadowbrook HOA"], property_id: propOf[byName["Meadowbrook HOA"]], title: "Clubhouse lot sweeping (monthly)", kind: "recurring",
    recurrence_rule: "FREQ=MONTHLY;BYDAY=1MO", starts_on: new Date().toISOString().slice(0, 10), active_months: [3, 4, 5, 6, 7, 8, 9, 10, 11],
    visit_duration_min: 90, default_crew_id: sealCrew.id, billing_mode: "per_visit",
  })).select("id"),
  "recurring job",
);

// --- A week of visits (company time zone: America/New_York) ----------------------------------
const tzDate = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const at = (offsetDays, hhmm) => {
  const day = tzDate(offsetDays);
  // Good enough for demo data: Eastern time is UTC-4 (summer) or UTC-5 (winter).
  const probe = new Date(`${day}T12:00:00Z`);
  const offset = probe.toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT") ? "-04:00" : "-05:00";
  return new Date(`${day}T${hhmm}:00${offset}`).toISOString();
};
const visit = (row) => c(row);
const visits = await must(
  db.from("visits").insert([
    visit({ job_id: jobId, property_id: propOf[byName["Summit Ridge Builders"]], title: "Stone base, Phase 2 north loop", starts_at: at(0, "07:00"), ends_at: at(0, "12:00"), crew_id: paveCrew.id, status: "in_progress" }),
    visit({ job_id: townJob.id, property_id: propOf[byName["Town of Rocky Mount"]], title: "Overlay final walkthrough", starts_at: at(0, "13:30"), ends_at: at(0, "14:30"), crew_id: paveCrew.id }),
    visit({ request_id: null, kind: "assessment", property_id: propOf[byName["Priya Shah"]], title: "Estimate: Shah driveway", starts_at: at(0, "15:30"), ends_at: at(0, "16:15") }),
    visit({ job_id: jobId, property_id: propOf[byName["Summit Ridge Builders"]], title: "Binder course, Phase 2", starts_at: at(1, "07:00"), ends_at: at(1, "15:00"), crew_id: paveCrew.id }),
    visit({ job_id: jobId, property_id: propOf[byName["Summit Ridge Builders"]], title: "Surface course, Phase 2", starts_at: at(3, "07:00"), ends_at: at(3, "15:00"), crew_id: paveCrew.id }),
    visit({ job_id: hoaJob.id, property_id: propOf[byName["Meadowbrook HOA"]], title: "Clubhouse lot sweeping", scheduled_on: tzDate(2), crew_id: sealCrew.id }),
    visit({ job_id: townJob.id, property_id: propOf[byName["Town of Rocky Mount"]], title: "Overlay, block 4 alleys", starts_at: at(-2, "07:00"), ends_at: at(-2, "16:00"), crew_id: paveCrew.id, status: "completed" }),
  ], DEFAULTS).select("id, title"),
  "visits",
);
await must(db.from("visit_assignees").insert([visits[0], visits[1], visits[3]].flatMap((v) => [c({ visit_id: v.id, user_id: crewIds[0] }), c({ visit_id: v.id, user_id: crewIds[1] })])), "assignees");

// --- Invoices ------------------------------------------------------------------------------
const contract = await must(db.from("job_financials").select("contract_total").eq("job_id", jobId).single(), "contract");
const progressInvoice = await must(db.rpc("create_invoice_for_job", { p_job: jobId, p_kind: "progress", p_amount: Math.round(Number(contract.contract_total) * 0.4 * 100) / 100 }), "progress invoice");
await must(db.from("invoices").update({ status: "sent", issued_on: tzDate(-40), due_on: tzDate(-10) }).eq("id", progressInvoice), "overdue invoice");
const townInvoice = await must(db.rpc("create_invoice_for_job", { p_job: townJob.id }), "town invoice");
await must(db.from("invoices").update({ status: "sent" }).eq("id", townInvoice), "send town invoice");
await must(db.from("payments").insert(c({ invoice_id: townInvoice, client_id: byName["Town of Rocky Mount"], amount: 5000, method: "check", notes: "Check #10442" })), "partial payment");

// --- Promo codes ----------------------------------------------------------------------------
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

// --- Equipment ------------------------------------------------------------------------------
const dateAgo = (n) => daysAgo(n).slice(0, 10);
const [dumpTruck, paver, roller, trailer, sealSkid] = await must(
  db.from("equipment").insert([
    c({ name: "Dump truck 1", kind: "truck", meter: "miles", meter_reading: 84210, make: "Ford", model: "F-550", year: 2019, plate: "VA 4471-PV", crew_id: paveCrew.id }),
    c({ name: "Paver", kind: "machine", meter: "hours", meter_reading: 2306, make: "LeeBoy", model: "8520", year: 2017, crew_id: paveCrew.id, notes: "Screed heaters run off the left tank. 15W-40 in the engine." }),
    c({ name: "Roller", kind: "machine", meter: "hours", meter_reading: 1184, make: "Caterpillar", model: "CB2.7", year: 2020, crew_id: paveCrew.id }),
    c({ name: "Lowboy trailer", kind: "trailer", meter: "none", make: "Felling", year: 2018, crew_id: paveCrew.id }),
    c({ name: "Sealcoat skid", kind: "machine", meter: "hours", meter_reading: 412, crew_id: sealCrew.id }),
  ], DEFAULTS).select("id"),
  "equipment",
);
const plan = (equipment, name, every, baseline) => c({ equipment_id: equipment.id, name, ...every, ...baseline });
const [, , , rollerOil] = await must(
  db.from("equipment_plans").insert([
    plan(dumpTruck, "Oil change", { every_meter: 5000, every_count: 6, every_unit: "month" }, { baseline_on: dateAgo(110), baseline_meter: 79600 }),
    plan(dumpTruck, "DOT inspection", { every_count: 1, every_unit: "year" }, { baseline_on: dateAgo(356) }),
    plan(paver, "Engine oil and filter", { every_meter: 250 }, { baseline_on: dateAgo(70), baseline_meter: 2040 }),
    plan(roller, "Engine oil and filter", { every_meter: 250, every_count: 1, every_unit: "year" }, { baseline_on: dateAgo(150), baseline_meter: 800 }),
    plan(roller, "Check water spray nozzles", { every_count: 1, every_unit: "month" }, { baseline_on: dateAgo(18) }),
    plan(trailer, "Check tires, lights and brakes", { every_count: 3, every_unit: "month" }, { baseline_on: dateAgo(100) }),
    plan(sealSkid, "Flush pump and lines", { every_count: 2, every_unit: "week" }, { baseline_on: dateAgo(4) }),
  ], DEFAULTS).select("id"),
  "maintenance schedules",
);
await must(
  db.from("equipment_logs").insert([
    c({ equipment_id: roller.id, kind: "service", plan_id: rollerOil.id, title: "Engine oil and filter", done_on: dateAgo(30), meter_reading: 1050, user_id: crewIds[0] }),
    c({ equipment_id: paver.id, kind: "repair", title: "Replaced hydraulic hose on the hopper", done_on: dateAgo(12), meter_reading: 2280, notes: "Hose was rubbing on the frame. Added a clamp.", user_id: crewIds[0] }),
    c({ equipment_id: paver.id, kind: "reading", done_on: dateAgo(5), meter_reading: 2298, user_id: crewIds[1] }),
  ], DEFAULTS),
  "equipment history",
);
await must(db.from("equipment_financials").insert(c({ equipment_id: paver.id, purchase_price: 148500 })), "equipment price");

// --- SOPs -----------------------------------------------------------------------------------
const cats = await must(db.from("sop_categories").select("id, name").eq("company_id", company), "categories");
const cat = (n) => cats.find((x) => x.name === n)?.id ?? null;
const sop = (category, title, html, required = false, tags = []) =>
  c({ category_id: cat(category), title, body_html: html, body_text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), required, tags });
await must(
  db.from("sop_pages").insert([
    sop("Paving", "Hot-mix laydown temperatures", "<h2>Minimum temperatures</h2><ul><li>Air and base at least <strong>50°F and rising</strong> for surface courses.</li><li>Mat temperature behind the screed: <strong>275–300°F</strong>.</li><li>Stop rolling below 175°F.</li></ul><h2>If a load arrives cold</h2><p>Reject loads below 250°F at the truck and note the ticket number.</p>", true, ["asphalt", "quality"]),
    sop("Safety", "Call 811 before any digging", "<p>Confirm the 811 ticket number and the marking date on the work order <strong>before</strong> any excavation, including sign posts.</p><ol><li>Check the ticket is still valid (Virginia: 15 working days).</li><li>Photograph all paint marks.</li><li>Hand dig within 2 feet of marks.</li></ol>", true, ["safety"]),
    sop("Sealcoating and striping", "Sealcoat cure times", "<p>Keep traffic off for <strong>24 hours</strong>, longer below 60°F or in shade. Don't apply if rain is expected within 24 hours.</p><p>Driveway depth for a residential overlay: 2 inches compacted.</p>", false, ["sealcoat"]),
  ], DEFAULTS),
  "SOPs",
);

console.log(`Demo company "Acme Paving" ready. Sign in as ${EMAIL} / ${PASSWORD}`);
