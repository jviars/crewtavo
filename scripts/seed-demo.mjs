#!/usr/bin/env node
/**
 * Loads a demo company for local development and screenshots: a paving business with clients,
 * requests, quotes, a takeoff, jobs, a week of visits and time, invoices and payments, crews,
 * equipment, SOPs and a marketing campaign, photos on the finished visits, and a striping sub
 * (Ray Lines of Precision Striping) with paperwork, paid work, a job offer waiting and a sign-in.
 * Then Marketing filled in (seedMarketing): months of campaigns with opens, clicks and the work
 * they booked, a mailed postcard, social posts, showcases, promo code uses, review asks, referrals
 * in every state, and website visits, on more clients and finished jobs with before and after photos.
 *
 *   npm run seed:demo            (reads .dev.vars; needs the API running for onboarding)
 *
 * Signs in as demo@crewtavo.test / crewtavo-demo (created if missing). Safe to rerun: it skips
 * if the demo user already has a company (adding the demo sub and the marketing data if they're
 * missing). Never point this at
 * production. The sub signs in without a password, as subs do: the browser tests sign in with a
 * one-time link made with the server's key (e2e/auth.setup.ts).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import jpeg from "jpeg-js";

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

// --- A sub, with paperwork, paid work, an offer waiting, and their own sign-in -----------------
// The sub's id is fixed, so its sign-in's stand-in address (sub-<id>@subs.invalid) is known to the
// browser tests (e2e/support/env.ts).
const SUB_ID = "5ab00000-0000-4000-8000-000000000001";
async function seedSub(company) {
  if (await must(db.from("subcontractors").select("id").eq("id", SUB_ID).maybeSingle(), "demo sub")) return;
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  await must(
    db.from("subcontractors").insert({
      id: SUB_ID, company_id: company, name: "Precision Striping LLC", contact_name: "Ray Lines", phone: "(540) 555-0177", email: "ray@precisionstriping.test",
      trade: "Line striping", tax_classification: "llc_partnership", address: { line1: "41 Depot St", city: "Rocky Mount", region: "VA", postal_code: "24151" },
    }),
    "demo sub",
  );
  const folder = `${company}/subs/${SUB_ID}`;
  await must(
    db.from("sub_documents").insert([
      { company_id: company, subcontractor_id: SUB_ID, kind: "w9", path: `${folder}/w9.pdf`, file_name: "W-9.pdf", content_type: "application/pdf" },
      { company_id: company, subcontractor_id: SUB_ID, kind: "liability", path: `${folder}/gl.pdf`, file_name: "COI liability.pdf", content_type: "application/pdf", carrier: "Blue Ridge Mutual", policy_number: "GL-20418", starts_on: day(-65), expires_on: day(300) },
      { company_id: company, subcontractor_id: SUB_ID, kind: "workers_comp", path: `${folder}/wc.pdf`, file_name: "COI workers comp.pdf", content_type: "application/pdf", carrier: "Blue Ridge Mutual", policy_number: "WC-7731", starts_on: day(-345), expires_on: day(20) },
    ]),
    "demo sub's paperwork",
  );
  await must(db.from("pay_rates").insert({ company_id: company, subcontractor_id: SUB_ID, basis: "per_job", rate: 1200, description: "Line striping" }), "demo sub's rate");
  // Their sign-in, as the office's Give a sign-in makes one (services/subAccess.ts): on the stand-in
  // address, marked as this sub's, with the server's key.
  const account = await must(
    admin.auth.admin.createUser({ email: `sub-${SUB_ID}@subs.invalid`, email_confirm: true, user_metadata: { full_name: "Ray Lines" }, app_metadata: { crewtavo_sub: `${company.toLowerCase()}:${SUB_ID}` } }),
    "demo sub's sign-in",
  );
  await must(admin.from("memberships").insert({ company_id: company, user_id: account.user.id, role: "subcontractor", subcontractor_id: SUB_ID, active: true }), "demo sub's membership");
  // Paid: striping the alleys after the overlay (done already, so agreed and done at once).
  const visitTitled = async (title) => must(db.from("visits").select("id, job_id").eq("company_id", company).eq("title", title).limit(1).single(), `visit ${title}`);
  const alleys = await visitTitled("Overlay, block 4 alleys");
  const paid = await must(db.rpc("job_pay_start", { p_job: alleys.job_id, p_subcontractor: SUB_ID, p_visits: [alleys.id] }), "demo sub's pay");
  await must(db.rpc("job_pay_accept", { p_pay: paid }), "agree demo sub's pay");
  await must(db.rpc("job_pay_mark_paid", { p_pays: [paid], p_method: "check", p_paid_on: day(-1), p_reference: "Check #2215" }), "pay the demo sub");
  // Waiting for their answer: striping Phase 2 after the surface course.
  const surface = await visitTitled("Surface course, Phase 2");
  const offer = await must(db.rpc("job_pay_start", { p_job: surface.job_id, p_subcontractor: SUB_ID, p_visits: [surface.id] }), "demo sub's offer");
  await must(db.rpc("send_sub_offer", { p_pay: offer, p_respond_by: new Date(Date.now() + 2 * 86_400_000).toISOString() }), "send the demo sub's offer");
}

// --- Photos on finished visits, OK to share, so the Client Hub shows them (scripts/demo-photos) ---
// Each finished visit gets the pictures its work calls for. Skipped while the files aren't there.
const PHOTOS_FOR = [[/plow/i, ["plowed"]], [/salt/i, ["salted"]], [/stripe/i, ["sealcoat", "striping"]], [/sweep/i, ["striping"]], [/./, ["sealcoat"]]];
async function seedVisitPhotos(company) {
  const have = await must(admin.from("attachments").select("id").eq("company_id", company).eq("owner_type", "visit").limit(1), "visit photos");
  if (have.length) return;
  const finished = await must(admin.from("visits").select("id, title").eq("company_id", company).eq("status", "completed"), "finished visits");
  for (const visit of finished) {
    for (const name of PHOTOS_FOR.find(([pattern]) => pattern.test(visit.title))[1]) {
      let body;
      try {
        body = readFileSync(new URL(`demo-photos/${name}.jpg`, import.meta.url));
      } catch {
        return;
      }
      await addPhoto(company, visit.id, `${name}.jpg`, body);
    }
  }
}

/** A photo on a visit, marked OK to share, as the crew app saves one. Returns its attachment id. */
async function addPhoto(company, visitId, fileName, body, caption = null) {
  const path = `${company}/visit/${visitId}/${crypto.randomUUID()}.jpg`;
  await must(admin.storage.from("files").upload(path, body, { contentType: "image/jpeg" }), `upload ${fileName}`);
  const [photo] = await must(
    admin.from("attachments").insert({ company_id: company, owner_type: "visit", owner_id: visitId, path, file_name: fileName, content_type: "image/jpeg", size_bytes: body.length, caption, created_by: ownerId }).select("id"),
    "visit photo",
  );
  await must(db.rpc("set_photo_shareable", { p_attachment: photo.id, p_shareable: true }), "photo OK to share");
  return photo.id;
}

/**
 * A pavement photo, drawn, since no photo files ship with the repo: worn gray asphalt with cracks
 * and faded paint before, fresh black sealcoat with crisp paint after. A lot gets stall lines running
 * off toward the far end; a driveway gets a grass edge. The same seed draws the same picture.
 */
function pavementPhoto({ fresh, lot, seed }) {
  const W = 1024;
  const H = 768;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const px = new Uint8ClampedArray(W * H * 4);
  // Blotches from a coarse grid of shades, blended, so the surface isn't one flat gray.
  const G = 12;
  const grid = Array.from({ length: (G + 1) * (G + 1) }, rand);
  const blotch = (x, y) => {
    const gx = (x / W) * G, gy = (y / H) * G, ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const at = (i, j) => grid[Math.min(j, G) * (G + 1) + Math.min(i, G)];
    return at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) + at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
  };
  const base = fresh ? [29, 30, 33] : [116, 111, 104];
  const edge = (y) => (lot ? -1 : 150 + 40 * Math.sin(y / 110) - y * 0.12);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Light falls off toward the corners, as a phone photo's does.
      const light = 1 - 0.55 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2);
      if (x < edge(y)) {
        const g = (rand() - 0.5) * 50 + (blotch(x, y) - 0.5) * 40;
        px[i] = (72 + g * 0.6) * light; px[i + 1] = (104 + g) * light; px[i + 2] = (48 + g * 0.4) * light;
      } else {
        const shade = (blotch(x, y) - 0.5) * (fresh ? 12 : 36) + (rand() - 0.5) * (fresh ? 14 : 30) + (!fresh && rand() < 0.03 ? 45 : 0);
        for (let k = 0; k < 3; k++) px[i + k] = (base[k] + shade) * light;
      }
      px[i + 3] = 255;
    }
  }
  const dot = (x, y, r, color, alpha) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = Math.round(x + dx), Y = Math.round(y + dy);
      if (dx * dx + dy * dy > r * r || X < 0 || Y < 0 || X >= W || Y >= H || X < edge(Y)) continue;
      const i = (Y * W + X) * 4;
      for (let k = 0; k < 3; k++) px[i + k] = px[i + k] * (1 - alpha) + color[k] * alpha;
    }
  };
  const stroke = (x0, y0, x1, y1, r0, r1, color, alpha) => {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 2);
    for (let t = 0; t <= n; t++) dot(x0 + ((x1 - x0) * t) / n, y0 + ((y1 - y0) * t) / n, Math.max(1, Math.round(r0 + ((r1 - r0) * t) / n)), color, alpha);
  };
  if (lot) {
    // Stall lines toward the far end: wide near the camera, thin far off. Worn ones barely show.
    const paint = fresh ? [238, 238, 230] : [168, 164, 150];
    const alpha = fresh ? 0.95 : 0.4;
    for (let k = -3; k <= 4; k++) stroke(W / 2 + k * 290, H + 20, W / 2 + k * 64, H * 0.2, 9, 2, paint, alpha);
    stroke(0, H * 0.2, W, H * 0.2, 2, 2, paint, alpha);
  }
  if (!fresh) {
    // Cracks wander, and now and then split.
    const crack = (x, y, angle, steps, depth) => {
      for (let n = 0; n < steps; n++) {
        const nx = x + Math.cos(angle) * 6, ny = y + Math.sin(angle) * 6;
        stroke(x, y, nx, ny, 2, 2, [34, 32, 30], 0.85);
        x = nx; y = ny; angle += (rand() - 0.5) * 0.5;
        if (depth < 2 && rand() < 0.03) crack(x, y, angle + (rand() < 0.5 ? 1 : -1) * (0.6 + rand()), 8 + rand() * 16, depth + 1);
      }
    };
    for (let n = 0; n < 5; n++) crack(rand() * W, rand() * H, rand() * Math.PI * 2, 30 + rand() * 50, 0);
  }
  return Buffer.from(jpeg.encode({ data: px, width: W, height: H }, 80).data);
}

// --- Marketing, filled in: what months of using it leave behind --------------------------------
// Everything here is history: nothing is scheduled, queued or switched on, so a server running its
// scheduler against this database has nothing to send. The draft campaign, added last, says it ran.
const MARKETING_DONE = "Early-bird spring booking";
const MARKETING_CLIENTS = [
  // name, lead source, days since they came in, tags, street, town, ZIP, lat, lng, email, status, referred by
  ["Smith Mountain Marina", "Google", 120, ["Commercial"], "16 Marina Point Rd", "Moneta", "24121", 37.0431, -79.6802, "office@smmarina.test", "active"],
  ["Grace Whitaker", "Google", 110, ["Residential"], "512 Sycamore Dr", "Rocky Mount", "24151", 37.0089, -79.8792, "grace.whitaker@example.com", "active"],
  ["Walt Hensley", "Yard sign", 95, ["Residential"], "2290 Six Mile Post Rd", "Rocky Mount", "24151", 36.9672, -79.9108, "walt.hensley@example.com", "active"],
  ["Cornerstone Church", "Phone", 85, ["Commercial"], "301 Grove St", "Rocky Mount", "24151", 37.0012, -79.8951, "admin@cornerstonerm.test", "active"],
  ["Tom & Lisa Garner", "Referral", 75, ["Residential"], "77 Quail Run", "Wirtz", "24184", 37.0957, -79.7765, "garners@example.com", "active", "Ben Okafor"],
  ["Lakeside Villas HOA", "Referral", 70, ["HOA"], "1 Lakeside Villas Dr", "Moneta", "24121", 37.0702, -79.7011, "board@lakesidevillas.test", "lead", "Meadowbrook HOA"],
  ["Marcus Whitfield", "Referral", 60, ["Residential"], "140 Brookside Ln", "Rocky Mount", "24151", 36.9902, -79.8689, "m.whitfield@example.com", "active", "Jordan Rivera"],
  ["Nora Patel", "Facebook", 50, ["Residential"], "35 Dogwood Ct", "Boones Mill", "24065", 37.1167, -79.9401, "nora.patel@example.com", "active"],
  ["Blue Ridge Pediatrics", "Referral", 40, ["Commercial"], "450 Old Hollow Rd", "Rocky Mount", "24151", 37.0128, -79.9022, "frontdesk@brpeds.test", "active", "Hillside Family Dental"],
  ["Daniel Ortiz", "Referral", 35, ["Residential"], "9 Chestnut Hill Rd", "Rocky Mount", "24151", 37.0041, -79.8813, "daniel.ortiz@example.com", "active", "Elena Marsh"],
  ["Megan Doyle", "Postcard", 25, ["Residential"], "61 Chestnut Hill Rd", "Rocky Mount", "24151", 37.0029, -79.8795, "megan.doyle@example.com", "active"],
  ["Franklin Commons Apartments", "Referral", 20, ["Commercial"], "800 Franklin St", "Rocky Mount", "24151", 36.9969, -79.8873, "leasing@franklincommons.test", "lead", "Summit Ridge Builders"],
  ["Rachel Kim", "Referral", 8, ["Residential"], "23 Laurel Ln", "Boones Mill", "24065", 37.1099, -79.9467, "rachel.kim@example.com", "lead", "Elena Marsh"],
  ["Sam Castillo", "Website form", 3, ["Residential"], "1205 Wirtz Rd", "Rocky Mount", "24151", 37.0198, -79.8412, "sam.castillo@example.com", "lead"],
];

async function seedMarketing(company) {
  const seeded = await must(admin.from("campaigns").select("id").eq("company_id", company).eq("name", MARKETING_DONE).limit(1), "marketing seeded");
  if (seeded.length) return;
  const since = new Date().toISOString();
  const c = (row) => ({ company_id: company, ...row });
  // `n` days ago, in the morning in Virginia (or at `hour` UTC), and that day's date.
  const ago = (n, hour = 14) => {
    const d = new Date(Date.now() - n * 86_400_000);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const dateOf = (n) => ago(n).slice(0, 10);
  const hex = () => crypto.randomUUID().replaceAll("-", "");

  // --- Set up: a review link, a referral credit and offer, and Website Analytics on -------------
  const { settings } = await must(admin.from("companies").select("settings").eq("id", company).single(), "settings");
  await must(
    admin.from("companies").update({
      settings: {
        ...settings,
        review_url: "https://g.page/r/CacmePavingDemo/review",
        referrals: { ...(settings?.referrals ?? {}), reward: { kind: "amount", value: 50 }, offer: "$25 off your first job" },
        website_analytics: { ...(settings?.website_analytics ?? {}), enabled: true, site: "https://acmepaving.test", host: "acmepaving.test" },
      },
    }).eq("id", company),
    "marketing settings",
  );
  await must(
    db.from("promo_codes").upsert(
      [
        c({ code: "FALL15", description: "Fall sealcoat special", kind: "percent", value: 15, min_subtotal: 300, starts_on: dateOf(60) }),
        c({ code: "HOA100", description: "$100 off HOA lots over $2,500", kind: "amount", value: 100, min_subtotal: 2500, starts_on: dateOf(200), ends_on: dateOf(120) }),
      ],
      { onConflict: "company_id,code", ignoreDuplicates: true, defaultToNull: false },
    ),
    "more promo codes",
  );
  const promo = Object.fromEntries((await must(db.from("promo_codes").select("id, code").eq("company_id", company), "promo codes")).map((p) => [p.code, p.id]));

  // --- More clients, who came in over the last four months from all over ------------------------
  const before = await must(admin.from("clients").select("id, display_name, email").eq("company_id", company), "clients");
  const byName = Object.fromEntries(before.map((x) => [x.display_name, x.id]));
  const added = await must(
    admin.from("clients").insert(
      MARKETING_CLIENTS.map(([name, source, n, tags, , , , , , email, status, referrer], i) =>
        c({ display_name: name, email, phone: `(540) 555-02${String(10 + i).padStart(2, "0")}`, status, lead_source: source, tags, created_at: ago(n), referred_by: referrer ? byName[referrer] : null }),
      ),
      DEFAULTS,
    ).select("id, display_name, email"),
    "marketing clients",
  );
  for (const x of added) byName[x.display_name] = x.id;
  await must(
    admin.from("properties").insert(MARKETING_CLIENTS.map(([name, , , , line1, city, postal_code, lat, lng]) => c({ client_id: byName[name], line1, city, region: "VA", postal_code, lat, lng })), DEFAULTS),
    "marketing properties",
  );
  const places = await must(admin.from("properties").select("id, client_id, line1, city, region, postal_code").eq("company_id", company), "properties");
  const placeOf = Object.fromEntries(places.map((p) => [p.client_id, p]));
  const emailOf = Object.fromEntries([...before, ...added].map((x) => [x.display_name, x.email]));
  // Unsubscribed from marketing emails: the campaigns' footer link, used.
  await must(admin.from("clients").update({ marketing_opt_out: true }).eq("company_id", company).in("display_name", ["Walt Hensley", "Carl Benton"]), "opted out");

  // --- Referrals, before their friends' first jobs, so paying earns the credit ------------------
  const referral = (referrer, friend, n, row = {}) => c({ referrer_client_id: byName[referrer], referred_client_id: byName[friend], referred_name: friend, reward_kind: "amount", reward_value: 50, created_at: ago(n), ...row });
  const referrals = Object.fromEntries(
    (await must(
      admin.from("referrals").insert([
        referral("Ben Okafor", "Tom & Lisa Garner", 80),
        referral("Jordan Rivera", "Marcus Whitfield", 65),
        referral("Hillside Family Dental", "Blue Ridge Pediatrics", 45),
        referral("Elena Marsh", "Daniel Ortiz", 38),
        referral("Summit Ridge Builders", "Franklin Commons Apartments", 21, { status: "quoted" }),
        referral("Meadowbrook HOA", "Lakeside Villas HOA", 72, { status: "lost", reward_status: "none", no_reward_reason: "lost", lost_at: ago(55) }),
        referral("Elena Marsh", "Rachel Kim", 8),
      ], DEFAULTS).select("id, referred_name"),
      "referrals",
    )).map((r) => [r.referred_name, r.id]),
  );

  // --- Finished jobs, each with before and after photos, billed and paid -------------------------
  const crews = await must(admin.from("crews").select("id, name").eq("company_id", company), "crews");
  const crew = crews.find((x) => x.name === "Sealcoat crew")?.id ?? null;
  const services = await must(admin.from("services").select("id, name, unit, unit_price").eq("company_id", company), "services");
  const line = (name, quantity) => {
    const s = services.find((x) => x.name === name);
    return { service_id: s.id, name: s.name, unit: s.unit, unit_price: s.unit_price, quantity };
  };
  const photos = {};
  const photoOf = (lot, fresh, n) => (photos[`${lot}${fresh}${n % 3}`] ??= pavementPhoto({ lot, fresh, seed: (lot ? 40 : 10) + (fresh ? 5 : 0) + (n % 3) }));
  async function newJob(client, title, lines, status) {
    const job = await must(db.from("jobs").insert(c({ client_id: byName[client], property_id: placeOf[byName[client]]?.id, title, status, default_crew_id: crew })).select("id").single(), `job ${title}`);
    await must(db.from("job_line_items").insert(lines.map((l) => c({ job_id: job.id, ...l })), DEFAULTS), `lines ${title}`);
    return job.id;
  }
  // Done `n` days ago, billed the next day and paid within the week.
  async function finished(client, title, lines, n, { lot = false, code = null, method = "card" } = {}) {
    const job = await newJob(client, title, lines, "requires_invoicing");
    const visit = await must(
      db.from("visits").insert(c({ job_id: job, property_id: placeOf[byName[client]]?.id, title, starts_at: ago(n, 12), ends_at: ago(n, 18), crew_id: crew, status: "completed" })).select("id").single(),
      `visit ${title}`,
    );
    await must(admin.rpc("call_off_visit_notice", { p_visit: visit.id }), "no booked message");
    const shots = [await addPhoto(company, visit.id, "before.jpg", photoOf(lot, false, n), "Before"), await addPhoto(company, visit.id, "after.jpg", photoOf(lot, true, n), "After")];
    const invoice = await must(db.rpc("create_invoice_for_job", { p_job: job }), `invoice ${title}`);
    // Sent due in the future and paid, then given its real due date: sent already past due, it would
    // be marked overdue and the client reminded.
    await must(db.from("invoices").update({ status: "sent", issued_on: dateOf(n - 1), due_on: dateOf(-30), ...(code && { promo_code_id: promo[code] }) }).eq("id", invoice), `send ${title}`);
    const bill = await must(db.from("invoices").select("total, tax_amount, retainage_amount").eq("id", invoice).single(), `total ${title}`);
    await must(db.from("payments").insert(c({ invoice_id: invoice, client_id: byName[client], amount: bill.total, method, received_at: ago(Math.max(n - 6, 1)) })), `pay ${title}`);
    await must(db.from("invoices").update({ due_on: dateOf(n - 31) }).eq("id", invoice), `due date ${title}`);
    return { job, visit: visit.id, invoice, photos: shots, revenue: Math.max(Number(bill.total) - Number(bill.tax_amount) - Number(bill.retainage_amount ?? 0), 0) };
  }
  // Hillside's next job is billed but not sent, so the credit their friend earns has somewhere to go.
  const springRestripe = await newJob("Hillside Family Dental", "Spring restripe, front lot", [line("Stall striping, per stall", 42), line("ADA stall package", 2)], "active");
  await must(db.rpc("create_invoice_for_job", { p_job: springRestripe }), "Hillside's next invoice");
  const done = {
    meadowPool: await finished("Meadowbrook HOA", "Pool lot crack seal and sealcoat", [line("Hot-pour crack seal", 180), line("Sealcoat", 9800)], 195, { lot: true, code: "SPRING10", method: "ach" }),
    hillsideBack: await finished("Hillside Family Dental", "Back lot crack seal", [line("Hot-pour crack seal", 240)], 105, { lot: true, method: "ach" }),
    grace: await finished("Grace Whitaker", "Driveway crack fill and sealcoat", [line("Hot-pour crack seal", 60), line("Sealcoat", 1250)], 100, { code: "WELCOME50" }),
    marina: await finished("Smith Mountain Marina", "Boat ramp lot patch and restripe", [line("Asphalt patch", 90), line("Line striping", 540), line("Arrows and stencils", 6)], 90, { lot: true, method: "check" }),
    walt: await finished("Walt Hensley", "Gravel to asphalt driveway", [line("Grade and compact stone base", 18), line("Hot-mix asphalt surface", 24)], 80, { code: "WELCOME50", method: "check" }),
    church: await finished("Cornerstone Church", "Church lot sealcoat and restripe", [line("Sealcoat", 18600), line("Stall striping, per stall", 64), line("ADA stall package", 2)], 70, { lot: true, method: "check" }),
    garners: await finished("Tom & Lisa Garner", "Driveway patch and sealcoat", [line("Asphalt patch", 40), line("Sealcoat", 1600)], 60),
    marcus: await finished("Marcus Whitfield", "Driveway sealcoat", [line("Sealcoat", 1400)], 45),
    nora: await finished("Nora Patel", "Driveway sealcoat and edging", [line("Sealcoat", 1100)], 40, { code: "WELCOME50" }),
    blueRidge: await finished("Blue Ridge Pediatrics", "Parking lot sealcoat and restripe", [line("Sealcoat", 12800), line("Stall striping, per stall", 38), line("ADA stall package", 1)], 30, { lot: true, method: "ach" }),
    daniel: await finished("Daniel Ortiz", "Driveway resurface", [line("Mill and overlay 2 inch", 140)], 25),
    storage: await finished("Rocky Mount Self Storage", "Front lot restripe", [line("Stall striping, per stall", 48), line("Arrows and stencils", 4)], 25, { lot: true, code: "FALL15", method: "ach" }),
    megan: await finished("Megan Doyle", "Driveway sealcoat", [line("Sealcoat", 950)], 15, { code: "WELCOME50" }),
  };
  // Ben took his credit as a gift card at the shop, not on an invoice.
  await must(db.rpc("referral_set_given", { p_referral: referrals["Tom & Lisa Garner"] }), "credit given outside Crewtavo");

  // --- Requests and quotes the marketing brought in ----------------------------------------------
  const request = (client, title, n, row = {}) => c({ client_id: byName[client], property_id: placeOf[byName[client]]?.id, source: "web_form", status: "converted", title, created_at: ago(n), ...row });
  const asked = Object.fromEntries(
    (await must(
      admin.from("requests").insert([
        request("Meadowbrook HOA", "Pool lot sealcoat", 212),
        request("Hillside Family Dental", "Back lot cracks", 117),
        request("Smith Mountain Marina", "Boat ramp lot repairs", 118),
        request("Rocky Mount Self Storage", "Front lot restripe", 43),
        request("Elena Marsh", "Back patio pad sealcoat", 3, { status: "new", details: "Saw the fall special. The pad behind the garage is about 20 x 30." }),
        request("Rachel Kim", "Driveway sealcoat estimate", 8, { source: "referral", status: "new", details: "Elena Marsh sent me your way." }),
        request("Sam Castillo", "New driveway quote", 3, {
          status: "new",
          details: "Gravel drive, about 90 ft. Thinking asphalt in the spring.",
          web_visit: { landing_page: "/services/paving", page: "/request", source: "Google", channel: "search" },
        }),
      ], DEFAULTS).select("id, title"),
      "marketing requests",
    )).map((r) => [r.title, r.id]),
  );
  await must(admin.from("referrals").update({ request_id: asked["Driveway sealcoat estimate"] }).eq("id", referrals["Rachel Kim"]), "Rachel's request");
  const quoteFor = async (client, title, status, lines, n) => {
    // Saved as sent, not moved there, so no "quote sent" follow-up is started.
    const q = await must(db.from("quotes").insert(c({ client_id: byName[client], property_id: placeOf[byName[client]]?.id, title, status: "sent", sent_at: ago(n), tax_rate: 0.053 })).select("id").single(), `quote ${title}`);
    await must(db.from("quote_line_items").insert(lines.map((l, i) => c({ ...l, quote_id: q.id, sort: i })), DEFAULTS), `lines ${title}`);
    if (status !== "sent") await must(db.from("quotes").update({ status }).eq("id", q.id), `${status} ${title}`);
    return q.id;
  };
  await quoteFor("Franklin Commons Apartments", "Resident lot sealcoat and restripe", "sent", [line("Sealcoat", 22400), line("Stall striping, per stall", 120)], 13);
  await quoteFor("Lakeside Villas HOA", "Villas lot mill and overlay", "lost", [line("Mill and overlay 2 inch", 2600)], 63);

  // --- Campaigns: who opened, who clicked, and what they booked ----------------------------------
  const BASE = ["Summit Ridge Builders", "Jordan Rivera", "Town of Rocky Mount", "Meadowbrook HOA", "Elena Marsh", "Hillside Family Dental", "Ben Okafor", "Rocky Mount Self Storage"];
  const campaigns = [
    {
      name: "Spring sealcoat special", subject: "10% off sealcoating this spring", n: 215, audience: { statuses: ["active"] }, to: BASE,
      opened: ["Meadowbrook HOA", "Jordan Rivera", "Rocky Mount Self Storage", "Elena Marsh", "Ben Okafor"], clicked: ["Meadowbrook HOA", "Jordan Rivera"],
      failed: { "Town of Rocky Mount": "The address doesn't take mail (it bounced)." },
      booked: [["Meadowbrook HOA", "Pool lot sealcoat", "meadowPool"]],
      body: "Hi {{client.first_name}},\n\nSpring is the best time to sealcoat: warm days, cool nights, and a whole season of sun ahead. Book by May 15 and take 10% off with code SPRING10.\n\n{{link}}\n\nThanks,\n{{company.name}}",
    },
    {
      name: "Midsummer crack check", subject: "Cracks let water in. Let's seal them before fall", n: 120, audience: { statuses: ["active"] },
      to: [...BASE, "Smith Mountain Marina"], opened: ["Hillside Family Dental", "Smith Mountain Marina", "Ben Okafor", "Summit Ridge Builders", "Elena Marsh", "Meadowbrook HOA"],
      clicked: ["Hillside Family Dental", "Smith Mountain Marina", "Ben Okafor"],
      booked: [["Hillside Family Dental", "Back lot cracks", "hillsideBack"], ["Smith Mountain Marina", "Boat ramp lot repairs", "marina"]],
      body: "Hi {{client.first_name}},\n\nSummer heat opens up small cracks, and fall rain gets into them. A crack seal now keeps your pavement from breaking up over the winter.\n\n{{link}}\n\nThanks,\n{{company.name}}",
    },
    {
      name: "Restripe before the holiday rush", subject: "Fresh lines before your busiest season", n: 45, audience: { tags: ["Commercial"] },
      to: ["Summit Ridge Builders", "Hillside Family Dental", "Rocky Mount Self Storage", "Smith Mountain Marina", "Cornerstone Church"],
      opened: ["Rocky Mount Self Storage", "Cornerstone Church", "Hillside Family Dental", "Smith Mountain Marina"], clicked: ["Rocky Mount Self Storage", "Cornerstone Church"],
      booked: [["Rocky Mount Self Storage", "Front lot restripe", "storage"]],
      body: "Hi {{client.first_name}},\n\nCustomers notice a sharp, freshly striped lot. We have openings for restriping before Thanksgiving.\n\n{{link}}\n\nThanks,\n{{company.name}}",
    },
  ];
  const recipientRow = (campaign, name, n, { opened, clicked, failed }) =>
    c({
      campaign_id: campaign, client_id: byName[name], email: emailOf[name], name, sent_at: ago(n),
      ...(failed ? { status: "failed", error: failed } : { status: "sent" }),
      ...(opened && { opened_at: ago(n, 16), open_count: clicked ? 2 : 1 }),
      ...(clicked && { clicked_at: ago(n, 17), last_clicked_at: ago(n, 17), click_count: 1 }),
    });
  const bookings = [];
  for (const k of campaigns) {
    const failed = Object.keys(k.failed ?? {}).length;
    const [row] = await must(
      admin.from("campaigns").insert(c({
        name: k.name, subject: k.subject, body: k.body, audience: k.audience, status: "sent", started_at: ago(k.n), finished_at: ago(k.n, 15),
        recipients_count: k.to.length, sent_count: k.to.length - failed, failed_count: failed, created_by: ownerId, created_at: ago(k.n + 2),
      })).select("id"),
      `campaign ${k.name}`,
    );
    const sent = await must(
      admin.from("campaign_recipients").insert(k.to.map((name) => recipientRow(row.id, name, k.n, { opened: k.opened.includes(name), clicked: k.clicked.includes(name), failed: k.failed?.[name] })), DEFAULTS).select("id, name"),
      `recipients of ${k.name}`,
    );
    for (const [name, title, work] of k.booked) {
      const recipient = sent.find((r) => r.name === name).id;
      bookings.push(c({ campaign_id: row.id, recipient_id: recipient, client_id: byName[name], kind: "request", record_id: asked[title], chain_id: asked[title], booked_at: ago(k.n - 2) }));
      bookings.push(c({ campaign_id: row.id, recipient_id: recipient, client_id: byName[name], kind: "invoice", record_id: done[work].invoice, chain_id: asked[title], amount: done[work].revenue, booked_at: ago(k.n - 20) }));
    }
  }
  // Last week's fall special: opened and clicked too, and Elena asked for more work from it.
  const [fall] = await must(admin.from("campaigns").select("id").eq("company_id", company).eq("name", "Fall sealcoat special").limit(1), "fall campaign");
  if (fall) {
    const fallSent = await must(admin.from("campaign_recipients").select("id, name, sent_at").eq("campaign_id", fall.id), "fall recipients");
    for (const r of fallSent) {
      const opened = ["Elena Marsh", "Ben Okafor", "Jordan Rivera", "Meadowbrook HOA"].includes(r.name);
      const clicked = ["Elena Marsh", "Ben Okafor"].includes(r.name);
      if (!opened) continue;
      const at = (h) => new Date(Date.parse(r.sent_at) + h * 3_600_000).toISOString();
      await must(admin.from("campaign_recipients").update({ opened_at: at(2), open_count: 1, ...(clicked && { clicked_at: at(3), last_clicked_at: at(3), click_count: 1 }) }).eq("id", r.id), "fall opens");
      if (r.name === "Elena Marsh") bookings.push(c({ campaign_id: fall.id, recipient_id: r.id, client_id: byName["Elena Marsh"], kind: "request", record_id: asked["Back patio pad sealcoat"], chain_id: asked["Back patio pad sealcoat"], booked_at: ago(3) }));
    }
  }
  await must(admin.from("campaign_bookings").upsert(bookings, { onConflict: "company_id,kind,record_id", ignoreDuplicates: true, defaultToNull: false }), "campaign bookings");
  // Close pending quotes has been on all along: its sends, without switching anything.
  const followUp = await must(admin.rpc("ensure_automated_campaign", { p_company: company, p_key: "quote_followup" }), "close pending quotes");
  await must(
    admin.from("campaign_recipients").upsert([
      recipientRow(followUp, "Jordan Rivera", 1, { opened: true }),
      recipientRow(followUp, "Franklin Commons Apartments", 10, { opened: true, clicked: true }),
      recipientRow(followUp, "Lakeside Villas HOA", 60, { opened: true }),
      recipientRow(followUp, "Cornerstone Church", 82, { opened: true, clicked: true }),
      recipientRow(followUp, "Grace Whitaker", 104, {}),
    ], { onConflict: "campaign_id,email,send_key", ignoreDuplicates: true, defaultToNull: false }),
    "close pending quotes sends",
  );

  // --- A postcard mailed to clients last month, and the next one drafted ------------------------
  // Not to the two who unsubscribed. The last card couldn't be made.
  const mailedTo = ["Jordan Rivera", "Elena Marsh", "Ben Okafor", "Grace Whitaker", "Marcus Whitfield", "Nora Patel", "Tom & Lisa Garner", "Daniel Ortiz", "Meadowbrook HOA", "Hillside Family Dental", "Priya Shah"];
  const [card] = await must(
    admin.from("postcard_campaigns").insert(c({
      name: "Neighbors of this fall's driveways", size: "6x9", front_attachment_id: done.marcus.photos[1], audience: { statuses: ["active", "lead"] },
      message: "Your neighbors just had their driveways sealed. Ours is the crew in the green trucks. Call (540) 483-0000 or book at acmepaving.test for $50 off your first job.",
      status: "sent", mode: "live", image_token: hex(), started_at: ago(35), finished_at: ago(35, 15), recipients_count: mailedTo.length, made_count: mailedTo.length - 1, failed_count: 1,
      created_by: ownerId, created_at: ago(37), lob_checked_at: ago(1),
    })).select("id"),
    "postcard campaign",
  );
  await must(
    admin.from("postcard_recipients").insert(mailedTo.map((name, i) => {
      const p = placeOf[byName[name]];
      const row = c({ campaign_id: card.id, client_id: byName[name], name, address: { line1: p.line1, city: p.city, region: p.region, postal_code: p.postal_code }, created_at: ago(35) });
      return i === mailedTo.length - 1
        ? { ...row, status: "failed", error: "Lob couldn't confirm this address is deliverable." }
        : { ...row, status: "made", lob_id: `psc_${hex().slice(0, 24)}`, expected_delivery: dateOf(29), made_at: ago(35, 15) };
    }), DEFAULTS),
    "postcard recipients",
  );
  await must(
    admin.from("postcard_campaigns").insert(c({ name: "Spring 2027 mailer", size: "4x6", status: "draft", audience: { statuses: ["active"] }, message: "Book your spring sealcoat early and lock in last year's price.", created_by: ownerId, created_at: ago(2) })),
    "postcard draft",
  );

  // --- Showcases: one live, one being written. The other finished jobs are waiting for one ------
  async function showcase(work, n, title, description) {
    const row = await must(db.from("showcases").insert(c({ job_id: done[work].job, visit_id: done[work].visit, title, description, show_town: true, created_by: ownerId, created_at: ago(n) })).select("id").single(), `showcase ${title}`);
    await must(db.from("showcase_photos").insert(done[work].photos.map((id, i) => c({ showcase_id: row.id, attachment_id: id, role: i ? "after" : "before", sort: i })), DEFAULTS), `photos of ${title}`);
    return row.id;
  }
  const live = await showcase("church", 66, "Parking lot sealed and restriped", "The lot had gone gray, with faded lines and cracks along the entrance. We crack-sealed, put down two coats of sealcoat and restriped all 64 stalls and both accessible spaces.");
  await showcase("marina", 85, "Boat ramp lot patched and restriped", "Trailer traffic had broken up the asphalt near the ramp. We cut out and patched the worst of it, then laid out new lines and arrows for the busy season.");
  // Publishing makes the page's copies of the photos, which the server does.
  const published = await fetch(`${API}/api/showcases/${live}/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-company-id": company, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm_unshared: true }),
  }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
  if (!published.ok) console.warn(`The showcase stays a draft (publish: ${published.status} ${await published.text()}).`);

  // --- Social posts that went out (nothing scheduled) -------------------------------------------
  async function post(n, caption, networks, attachment_ids = []) {
    const row = await must(
      admin.from("social_posts").insert(c({ source: attachment_ids.length ? "photos" : "text", attachment_ids, caption, caption_by: "person", networks, status: "posted", started_at: ago(n), finished_at: ago(n, 15), created_by: ownerId, created_at: ago(n + 1) })).select("id").single(),
      "social post",
    );
    await must(admin.from("social_post_networks").insert(networks.map((network) => ({ post_id: row.id, company_id: company, network, status: "posted", attempts: 1, posted_at: ago(n, 15) })), DEFAULTS), "social post networks");
  }
  await post(62, "Two coats of sealcoat and all-new lines on a church lot this week. Before and after 👇", ["facebook", "instagram"], done.church.photos);
  await post(28, "A medical office lot, sealed and restriped over the weekend so patients never had to park around us.", ["facebook", "instagram", "google"], done.blueRidge.photos);
  await post(20, "We're booking fall sealcoating now. Sealcoat needs a few warm, dry days, so the last spots go fast. Call (540) 483-0000.", ["facebook", "google"]);
  await post(22, "This driveway was milled and overlaid in a day. Smooth as new.", ["facebook", "instagram"], done.daniel.photos);

  // --- Review asks: opened, reminded, reviewed, and one that couldn't go -----------------------------
  // Every row names every column, with its link token made here: the column's default is the
  // database's own, and keeping defaults (DEFAULTS) would ask to run it.
  const ask =(client, work, n, channel, { clicked, reviewed, reminders = 0, failed } = {}) =>
    c({
      client_id: byName[client], job_id: done[work].job, channel, status: failed ? "failed" : clicked != null ? "clicked" : "sent", error: failed ?? null, sent_at: ago(n),
      clicked_at: clicked != null ? ago(clicked, 19) : null, reviewed_at: reviewed != null ? ago(reviewed, 20) : null,
      reminders_sent: reminders, last_reminder_at: reminders ? ago(n - 2 - 2 * reminders) : null, created_by: ownerId, link_token: hex().slice(0, 12),
    });
  await must(
    admin.from("review_requests").insert([
      ask("Meadowbrook HOA", "meadowPool", 193, "email", { reminders: 2 }),
      ask("Hillside Family Dental", "hillsideBack", 103, "email", { clicked: 102, reviewed: 101 }),
      ask("Grace Whitaker", "grace", 98, "sms", { clicked: 98, reviewed: 97 }),
      ask("Smith Mountain Marina", "marina", 88, "email", { clicked: 86 }),
      ask("Walt Hensley", "walt", 78, "sms", { failed: "This number can't get texts." }),
      ask("Cornerstone Church", "church", 68, "email", { clicked: 67, reviewed: 66 }),
      ask("Tom & Lisa Garner", "garners", 58, "both", { reminders: 2 }),
      ask("Marcus Whitfield", "marcus", 43, "email", { clicked: 40, reminders: 1 }),
      ask("Nora Patel", "nora", 38, "sms", { clicked: 38, reviewed: 37 }),
      ask("Blue Ridge Pediatrics", "blueRidge", 28, "email", { clicked: 27 }),
      ask("Daniel Ortiz", "daniel", 23, "email", { reminders: 1 }),
      ask("Rocky Mount Self Storage", "storage", 23, "link", { clicked: 21 }),
      ask("Megan Doyle", "megan", 13, "email", { clicked: 12, reviewed: 12 }),
    ]),
    "review asks",
  );

  // --- Referral asks that went out ---------------------------------------------------------------
  await must(
    admin.from("referral_asks").insert([
      c({ client_id: byName["Grace Whitaker"], status: "sent", sent_at: ago(92), created_by: ownerId }),
      c({ client_id: byName["Cornerstone Church"], automatic: true, status: "sent", sent_at: ago(63) }),
      c({ client_id: byName["Marcus Whitfield"], status: "sent", sent_at: ago(38), created_by: ownerId }),
      c({ client_id: byName["Nora Patel"], automatic: true, status: "sent", sent_at: ago(33) }),
      c({ client_id: byName["Megan Doyle"], automatic: true, status: "sent", sent_at: ago(8) }),
    ], DEFAULTS),
    "referral asks",
  );

  // --- Website visits, counted by day as the nightly roll-up keeps them -----------------------------
  const PAGES = [["/", 0.42], ["/services/sealcoating", 0.2], ["/services/paving", 0.14], ["/gallery", 0.1], ["/request", 0.08], ["/about", 0.06]];
  const SOURCES = [["Google", "search", 0.44], ["Direct", "direct", 0.22], ["Facebook", "social", 0.12], ["Bing", "search", 0.05], ["Yelp", "directory", 0.05], ["Nextdoor", "social", 0.04], ["ChatGPT", "ai", 0.03], ["Campaign", "campaign", 0.05]];
  const DEVICES = [["phone", 0.62], ["computer", 0.32], ["tablet", 0.06]];
  let wave = 7;
  const days = [];
  for (let n = 89; n >= 0; n--) {
    const date = new Date(Date.parse(ago(n)));
    const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
    wave = (wave * 31 + 17) % 97;
    // Busier through the season, quieter on weekends, with a bump after each campaign or post.
    const bump = [45, 28, 22, 20, 6].some((d) => n <= d && n > d - 3) ? 14 : 0;
    const visitors = Math.round((weekend ? 11 : 19) + (89 - n) * 0.08 + (wave % 9) - 4 + bump);
    const visits = Math.round(visitors * 1.15);
    const day = dateOf(n);
    const split = (share) => Math.max(1, Math.round(share * visitors));
    days.push(c({ day, kind: "total", key: "", sub: "", visitors, pageviews: Math.round(visitors * 2.4), visits }));
    for (const [path, share] of PAGES) days.push(c({ day, kind: "page", key: path, sub: "", visitors: split(share), pageviews: Math.round(split(share) * 1.3), visits: Math.round(share * visits) }));
    for (const [source, channel, share] of SOURCES) days.push(c({ day, kind: "source", key: source, sub: channel, visitors: split(share), pageviews: 0, visits: split(share) }));
    for (const [device, share] of DEVICES) days.push(c({ day, kind: "device", key: device, sub: "", visitors: split(share), pageviews: Math.round(split(share) * 2.4), visits: split(share) }));
    if (bump) days.push(c({ day, kind: "campaign", key: n > 30 ? "restripe-holiday" : "fall-sealcoat", sub: "", visitors: 6, pageviews: 0, visits: 6 }));
  }
  await must(admin.from("web_daily").upsert(days, { onConflict: "company_id,day,kind,key,sub", ignoreDuplicates: true, defaultToNull: false }), "website visits");

  // Anything the seed itself set off for automations (office notices of paid invoices, booked
  // visits) is history too: called off, so no one is told about a demo.
  await must(admin.from("automation_runs").update({ status: "cancelled", finished_at: new Date().toISOString(), error: "Demo data" }).eq("company_id", company).eq("status", "pending").gte("created_at", since), "demo automations");

  await must(
    admin.from("campaigns").insert(c({
      name: MARKETING_DONE, subject: "Lock in spring sealcoating at this year's price", audience: { statuses: ["active"] }, status: "draft", created_by: ownerId, created_at: ago(1),
      body: "Hi {{client.first_name}},\n\nSpring books up fast. Reply or use the link below to hold a spot, and we'll keep this year's price.\n\n{{link}}\n\nThanks,\n{{company.name}}",
    })),
    "draft campaign",
  );
}

const existing = await must(db.from("memberships").select("company_id").eq("user_id", ownerId), "memberships");
if (existing.length) {
  await seedSub(existing[0].company_id);
  await seedVisitPhotos(existing[0].company_id);
  await seedMarketing(existing[0].company_id);
  console.log(`Demo company already exists. Sign in as ${EMAIL} / ${PASSWORD}`);
  process.exit(0);
}

// --- Company via the real onboarding endpoint (applies the Paving preset) -------------------
// Setting up a business agrees to the Crewtavo Terms, as the onboarding screen does.
const { termsVersion } = await (await fetch(`${API}/api/config`)).json();
const res = await fetch(`${API}/api/companies`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Acme Paving", trade_preset: "paving", timezone: "America/New_York", terms_version: termsVersion }),
});
if (!res.ok) throw new Error(`onboarding failed: ${res.status} ${await res.text()}`);
const { id: company } = await res.json();
const c = (row) => ({ company_id: company, ...row });

// Merged into what sign-up saved (the Paving app, the preset's formulas and weather rules), not replacing it.
// The browser's role reads settings through company_settings() (all of them, for an owner).
const { data: signedUp } = await db.rpc("company_settings", { p_company: company });
await must(
  db.from("companies").update({
    phone: "(540) 483-0000",
    email: "office@acmepaving.test",
    address: { line1: "100 Industrial Dr", city: "Rocky Mount", region: "VA", postal_code: "24151" },
    settings: {
      ...(signedUp ?? {}),
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
const clients = await must(db.from("clients").insert(clientRows.map(c), DEFAULTS).select("id, display_name, email"), "clients");
const byName = Object.fromEntries(clients.map((x) => [x.display_name, x.id]));

const propertyRows = [
  { client: "Summit Ridge Builders", label: "Summit Ridge Phase 2", line1: "2200 Summit Ridge Rd", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 37.0121, lng: -79.8714 },
  { client: "Jordan Rivera", line1: "418 Pell Ave", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9958, lng: -79.8862 },
  { client: "Town of Rocky Mount", label: "Alley program, block 4", line1: "Franklin St & Church St", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9978, lng: -79.8915 },
  // On a real parking lot, so the takeoff below lines up with the aerial.
  { client: "Meadowbrook HOA", label: "Clubhouse lot", line1: "75 Meadowbrook Ln", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.98544, lng: -79.92777 },
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

const requests = await must(
  db.from("requests").insert([
    c({ client_id: byName["Priya Shah"], property_id: propOf[byName["Priya Shah"]], source: "web_form", title: "Driveway estimate request", details: "Gravel drive, about 120 ft long. Would like asphalt before winter.", answers: { surface: "Gravel", size: "120 ft x 12 ft", drainage: "Yes" } }),
    c({ client_id: byName["Carl Benton"], property_id: propOf[byName["Carl Benton"]], source: "phone", title: "Sealcoat and crack repair", details: "Driveway has spider cracking near the garage." }),
    c({ client_id: byName["Meadowbrook HOA"], property_id: propOf[byName["Meadowbrook HOA"]], source: "email", status: "assessment_complete", title: "Clubhouse lot restripe", details: "About 45 stalls plus two ADA spaces." }),
  ], DEFAULTS).select("id, client_id"),
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
// Quantities as the takeoff below measures them.
const hoaQuote = await quote("Meadowbrook HOA", "Clubhouse lot sealcoat and restripe", "draft", [line("Sealcoat", 26380), line("Hot-pour crack seal", 126), line("Line striping", 882), line("ADA stall package", 2)]);
const approvedQuote = await quote("Summit Ridge Builders", "Phase 2 subdivision roads (binder + surface)", "approved", [
  line("Grade and compact stone base", 410),
  line("Hot-mix asphalt surface", 620),
  line("Mobilization and trucking", 7),
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
// Demo clients aren't told their demo visits are booked (a new company's "visit booked" rule is on).
for (const v of visits) await must(admin.rpc("call_off_visit_notice", { p_visit: v.id }), "no booked message");

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
const [, , rollerOil] = await must(
  db.from("equipment_plans").insert([
    plan(dumpTruck, "Oil change", { every_meter: 5000, every_count: 6, every_unit: "month" }, { baseline_on: dateAgo(110), baseline_meter: 79600 }),
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
// Tags and inspection: the truck's tags run out at the end of this month, the trailer's sticker ran
// out at the end of last month, and the trailer has a permanent plate.
const monthEnd = (months) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months + 1, 0)).toISOString().slice(0, 10);
};
await must(
  db.from("equipment_documents").insert([
    c({ equipment_id: dumpTruck.id, kind: "registration", expires_on: monthEnd(0), notes: "Virginia plate VA 4471-PV, 2-year registration" }),
    c({ equipment_id: dumpTruck.id, kind: "inspection", expires_on: monthEnd(7) }),
    c({ equipment_id: dumpTruck.id, kind: "insurance", expires_on: daysAgo(-140).slice(0, 10), notes: "Commercial auto policy CA-88213. Card in the glovebox." }),
    c({ equipment_id: trailer.id, kind: "registration", expires_on: null, notes: "Permanent trailer plate" }),
    c({ equipment_id: trailer.id, kind: "inspection", expires_on: monthEnd(-1) }),
  ], DEFAULTS),
  "tags and inspection",
);

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

// --- More clients: paid work from the last two months, and jobs coming up ------------------------
const more = await must(
  db.from("clients").insert([
    c({ display_name: "Elena Marsh", email: "elena.marsh@example.com", phone: "(540) 555-0134", status: "active", lead_source: "Google", tags: ["Residential"] }),
    c({ display_name: "Hillside Family Dental", company_name: "Hillside Family Dental PC", email: "office@hillsidedental.test", phone: "(540) 555-0158", status: "active", lead_source: "Referral", tags: ["Commercial"] }),
    c({ display_name: "Ben Okafor", email: "ben.okafor@example.com", phone: "(540) 555-0192", status: "active", lead_source: "Website form", tags: ["Residential"] }),
    c({ display_name: "Rocky Mount Self Storage", email: "manager@rmstorage.test", phone: "(540) 555-0116", status: "active", lead_source: "Phone", tags: ["Commercial"] }),
  ], DEFAULTS).select("id, display_name, email"),
  "more clients",
);
Object.assign(byName, Object.fromEntries(more.map((x) => [x.display_name, x.id])));
const moreProperties = await must(
  db.from("properties").insert([
    c({ client_id: byName["Elena Marsh"], line1: "27 Chestnut Hill Rd", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 37.0034, lng: -79.8801 }),
    c({ client_id: byName["Hillside Family Dental"], line1: "610 N Main St", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 37.0071, lng: -79.8885 }),
    c({ client_id: byName["Ben Okafor"], line1: "88 Laurel Ln", city: "Boones Mill", region: "VA", postal_code: "24065", lat: 37.1102, lng: -79.9481 }),
    c({ client_id: byName["Rocky Mount Self Storage"], line1: "1950 Tanyard Rd", city: "Rocky Mount", region: "VA", postal_code: "24151", lat: 36.9861, lng: -79.9012 }),
  ], DEFAULTS).select("id, client_id"),
  "more properties",
);
Object.assign(propOf, Object.fromEntries(moreProperties.map((p) => [p.client_id, p.id])));

const jobLine = (name, quantity) => {
  const { formula: _f, ...l } = line(name, quantity); // job lines don't keep formulas
  return l;
};
async function job(client, title, lines, extra) {
  const [row] = await must(db.from("jobs").insert(c({ client_id: byName[client], property_id: propOf[byName[client]], title, ...extra })).select("id"), `job ${title}`);
  await must(db.from("job_line_items").insert(lines.map((l) => c({ job_id: row.id, ...l }))), `lines ${title}`);
  return row.id;
}
// Done, billed and paid `ago` days back, as the town job above was billed.
async function paidJob(client, title, lines, ago, method, notes) {
  const id = await job(client, title, lines, { status: "requires_invoicing", default_crew_id: sealCrew.id });
  await must(db.from("visits").insert(visit({ job_id: id, property_id: propOf[byName[client]], title, starts_at: at(-ago, "08:00"), ends_at: at(-ago, "13:00"), crew_id: sealCrew.id, status: "completed" })), `visit ${title}`);
  const invoice = await must(db.rpc("create_invoice_for_job", { p_job: id }), `invoice ${title}`);
  await must(db.from("invoices").update({ status: "sent", issued_on: tzDate(1 - ago), due_on: tzDate(31 - ago) }).eq("id", invoice), `send ${title}`);
  const { total } = await must(db.from("invoices").select("total").eq("id", invoice).single(), `total ${title}`);
  await must(db.from("payments").insert(c({ invoice_id: invoice, client_id: byName[client], amount: total, method, received_at: daysAgo(ago - 5), notes })), `pay ${title}`);
  return id;
}
const pastJobs = [
  await paidJob("Elena Marsh", "Driveway sealcoat and crack fill", [jobLine("Sealcoat", 1800), jobLine("Hot-pour crack seal", 120)], 52, "card"),
  await paidJob("Hillside Family Dental", "Parking lot sealcoat and restripe", [jobLine("Sealcoat", 14200), jobLine("Line striping", 620), jobLine("ADA stall package", 1)], 24, "ach"),
  await paidJob("Ben Okafor", "Driveway patch and sealcoat", [jobLine("Asphalt patch", 64), jobLine("Sealcoat", 1450)], 9, "check", "Check #3381"),
];
const storageJob = await job("Rocky Mount Self Storage", "Lot patch and sealcoat", [jobLine("Asphalt patch", 220), jobLine("Sealcoat", 21500)], { default_crew_id: sealCrew.id, po_number: "RMSS-1102" });
const storageVisit = await must(
  db.from("visits").insert(visit({ job_id: storageJob, property_id: propOf[byName["Rocky Mount Self Storage"]], title: "Patch and sealcoat, storage lot", starts_at: at(1, "08:00"), ends_at: at(1, "14:00"), crew_id: sealCrew.id })).select("id").single(),
  "storage visit",
);
await must(admin.rpc("call_off_visit_notice", { p_visit: storageVisit.id }), "no booked message");
await job("Town of Rocky Mount", "Crosswalks and stop bars, Franklin St", [jobLine("Crosswalks and stop bars", 340)], { default_crew_id: sealCrew.id, po_number: "WO-24-131" });

// --- A paving takeoff: the clubhouse lot outlined on the aerial, saved as Measure saves it -------
// The lot's outline is OpenStreetMap's (way 334609878), so it sits on real asphalt in the imagery.
const shape = (id, item, type, coordinates, label) => ({ type: "Feature", id, geometry: { type, coordinates }, properties: { item, ...(label ? { label } : {}) } });
const takeoff = await fetch(`${API}/api/measurements`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "x-company-id": company, "Content-Type": "application/json" },
  body: JSON.stringify({
    title: "Clubhouse lot",
    quote_id: hoaQuote,
    property_id: propOf[byName["Meadowbrook HOA"]],
    view: { center: [-79.927766, 36.985444], zoom: 19.3, mode: "auto" },
    geojson: {
      type: "FeatureCollection",
      features: [
        shape("lot", "asphalt", "Polygon", [[[-79.928213, 36.985474], [-79.928061, 36.985191], [-79.92734, 36.985402], [-79.927449, 36.985709], [-79.928213, 36.985474]]], "Clubhouse lot"),
        shape("row-south", "stall_row", "LineString", [[-79.92805, 36.985247], [-79.927393, 36.985439]], "South row"),
        shape("row-north", "stall_row", "LineString", [[-79.927458, 36.985653], [-79.928159, 36.985437]], "North row"),
        shape("ada-1", "ada_stall", "Point", [-79.928159, 36.985465]),
        shape("ada-2", "ada_stall", "Point", [-79.928128, 36.985475]),
        shape("crack-1", "crack", "LineString", [[-79.928052, 36.985357], [-79.928019, 36.985366], [-79.92782, 36.985425]], "Crack seal 1"),
        shape("crack-2", "crack", "LineString", [[-79.927698, 36.985435], [-79.927608, 36.985453], [-79.927518, 36.985439]], "Crack seal 2"),
      ],
    },
  }),
});
if (!takeoff.ok) throw new Error(`takeoff: ${takeoff.status} ${await takeoff.text()}`);

// --- Time on the clock this week (the crew's own, so written with the service key) ---------------
const visitId = (title) => visits.find((v) => v.title === title).id;
const shift = (user, offset, from, to, row) => ({ company_id: company, user_id: user, started_at: at(offset, from), ended_at: to && at(offset, to), ...row });
const done = (rate) => ({ approved_by: ownerId, approved_at: daysAgo(1), labor_rate: rate });
const [marcus, luis] = crewIds;
await must(
  admin.from("time_entries").insert([
    shift(marcus, -2, "06:45", "16:20", { job_id: townJob.id, visit_id: visitId("Overlay, block 4 alleys"), ...done(32) }),
    shift(luis, -2, "06:50", "16:15", { job_id: townJob.id, visit_id: visitId("Overlay, block 4 alleys"), ...done(24) }),
    shift(marcus, -1, "07:00", "09:30", { category: "shop", notes: "Paver screed and roller service", ...done(32) }),
    shift(marcus, -1, "09:30", "10:15", { category: "drive", job_id: jobId }),
    shift(marcus, -1, "10:15", "15:30", { job_id: jobId, notes: "Proof-rolled the north loop with the GC" }),
    shift(luis, -1, "07:00", "11:00", { category: "shop" }),
    shift(marcus, 0, "06:55", "12:10", { job_id: jobId, visit_id: visitId("Stone base, Phase 2 north loop") }),
    shift(luis, 0, "07:00", "12:05", { job_id: jobId, visit_id: visitId("Stone base, Phase 2 north loop") }),
  ], DEFAULTS),
  "time entries",
);

// --- Marketing: a sent campaign, review asks and a referral (the server records these) -----------
const [campaign] = await must(
  admin.from("campaigns").insert({
    company_id: company, name: "Fall sealcoat special", subject: "Seal your driveway before winter", audience: { statuses: ["active"] }, status: "sent",
    body: "Hi {{client.first_name}},\n\nSealcoat goes down best before the cold sets in. Book this month and take 10% off with code SPRING10.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}",
    started_at: daysAgo(6), finished_at: daysAgo(6), recipients_count: 7, sent_count: 7, created_by: ownerId,
  }).select("id"),
  "campaign",
);
const audience = ["Summit Ridge Builders", "Jordan Rivera", "Town of Rocky Mount", "Meadowbrook HOA", "Elena Marsh", "Hillside Family Dental", "Ben Okafor"];
const emails = Object.fromEntries([...clients, ...more].map((x) => [x.display_name, x.email]));
await must(
  admin.from("campaign_recipients").insert(audience.map((name) => ({ company_id: company, campaign_id: campaign.id, client_id: byName[name], email: emails[name], name, status: "sent", sent_at: daysAgo(6) }))),
  "campaign recipients",
);
// Each ask's short link token is made here: the column's default is for the database's own use.
const ask = (client, job, sent, clicked) => ({ company_id: company, client_id: byName[client], job_id: job, status: clicked == null ? "sent" : "clicked", sent_at: daysAgo(sent), clicked_at: clicked == null ? null : daysAgo(clicked), created_by: ownerId, link_token: crypto.randomUUID().replaceAll("-", "").slice(0, 12) });
await must(
  admin.from("review_requests").insert([ask("Hillside Family Dental", pastJobs[1], 18, 17), ask("Ben Okafor", pastJobs[2], 3, 3), ask("Town of Rocky Mount", townJob.id, 1)]),
  "review requests",
);
const priyaRequest = requests.find((r) => r.client_id === byName["Priya Shah"]).id;
await must(admin.from("referrals").insert({ company_id: company, referrer_client_id: byName["Jordan Rivera"], referred_client_id: byName["Priya Shah"], request_id: priyaRequest, referred_name: "Priya Shah" }), "referral");

await seedSub(company);
await seedVisitPhotos(company);
await seedMarketing(company);

console.log(`Demo company "Acme Paving" ready. Sign in as ${EMAIL} / ${PASSWORD}`);
