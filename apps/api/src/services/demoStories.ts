/**
 * The public demo's sample businesses, one for each trade the start screen asks about (DEMO_TRADES)
 * and one made from any other trade's own price list. Each is a week in the life of a small
 * business in Rocky Mount, Virginia: leads and requests coming in, quotes out, crews on today's
 * jobs, invoices paid and overdue, equipment due for service, guides for the crew and a campaign.
 *
 * Every line names an item on the trade preset's price list exactly (test/demoStories.test.ts checks
 * them), and every date is counted from the day the business is made (services/demoSeed.ts).
 */
import { DEMO_CLIENT, DEMO_CREW_LEAD, DEMO_OTHER_OWNER, DEMO_TRADES, demoOtherBusiness, type PresetService } from "@crewtavo/core";
import type { Position } from "@crewtavo/core";
import type { DemoClient, DemoPlace, DemoSeeder, DemoTeammate, Row } from "./demoSeed";

export interface DemoStory {
  preset: string;
  business: string;
  /** The owner, whom the visitor signs in as. */
  owner: string;
  team: DemoTeammate[];
  taxRate: number;
  /** The price list names it quotes from, for the tests (the general story's come from the preset). */
  uses?: string[];
  build(s: DemoSeeder): Promise<void>;
}

/** A featured trade's business name and owner, as the start screen shows them (packages/core/src/demo.ts). */
function named(preset: (typeof DEMO_TRADES)[number]["preset"]) {
  const trade = DEMO_TRADES.find((t) => t.preset === preset)!;
  return { business: trade.business, owner: trade.owner };
}

const TZ = "America/New_York";
export const DEMO_TIME_ZONE = TZ;

// --- Places in and around Rocky Mount, Virginia ------------------------------------------------

const place = (line1: string, lat: number, lng: number, more: Partial<DemoPlace> = {}): DemoPlace => ({ line1, city: "Rocky Mount", region: "VA", postal_code: "24151", lat, lng, ...more });
const PLACES = {
  pell: place("418 Pell Ave", 36.9958, -79.8862),
  hillcrest: place("9 Hillcrest Ct", 37.1154, -79.9536, { city: "Boones Mill", postal_code: "24065" }),
  franklin: place("1360 Old Franklin Tpke", 36.9742, -79.9204),
  // On a real parking lot, so the paving takeoff lines up with the aerial.
  meadowbrook: place("75 Meadowbrook Ln", 36.98544, -79.92777, { label: "Clubhouse lot" }),
  summit: place("2200 Summit Ridge Rd", 37.0121, -79.8714, { label: "Summit Ridge Phase 2" }),
  town: place("Franklin St & Church St", 36.9978, -79.8915, { label: "Alley program, block 4" }),
  chestnut: place("27 Chestnut Hill Rd", 37.0034, -79.8801),
  dental: place("610 N Main St", 37.0071, -79.8885),
  laurel: place("88 Laurel Ln", 37.1102, -79.9481, { city: "Boones Mill", postal_code: "24065" }),
  storage: place("1950 Tanyard Rd", 36.9861, -79.9012),
  // A house whose roof outline is OpenStreetMap's (way 1341439693), so the roof measurement sits on it.
  orchard: place("64 Orchard Ave", 36.99432, -79.8866),
};

/** The people every sample business has in its client list, each with a place of their own. */
function person(name: string, email: string, phone: string, status: "active" | "lead", source: string, tags: string[], at: DemoPlace, more: Partial<DemoClient> = {}): DemoClient {
  return { name, email, phone, status, source, tags, place: at, ...more };
}
const JORDAN = (at: DemoPlace = PLACES.pell, source = "Website form") => person(DEMO_CLIENT, "jordan.rivera@example.com", "(540) 555-0187", "active", source, ["Residential"], at);
const PRIYA = person("Priya Shah", "priya.shah@example.com", "(540) 555-0163", "lead", "Website form", ["Residential"], PLACES.hillcrest);
const CARL = person("Carl Benton", "carl.benton@example.com", "(540) 555-0109", "lead", "Phone", ["Residential"], PLACES.franklin);
const ELENA = person("Elena Marsh", "elena.marsh@example.com", "(540) 555-0134", "active", "Google", ["Residential"], PLACES.chestnut);
const DENTAL = person("Hillside Family Dental", "office@hillsidedental.test", "(540) 555-0158", "active", "Referral", ["Commercial"], PLACES.dental, { company: "Hillside Family Dental PC" });
const BEN = person("Ben Okafor", "ben.okafor@example.com", "(540) 555-0192", "active", "Website form", ["Residential"], PLACES.laurel);
const STORAGE = person("Rocky Mount Self Storage", "manager@rmstorage.test", "(540) 555-0116", "active", "Phone", ["Commercial"], PLACES.storage);
const HOA = (label: string) =>
  person("Meadowbrook HOA", "board@meadowbrookhoa.test", "(540) 555-0122", "active", "Google", ["HOA"], { ...PLACES.meadowbrook, label }, { access: { gate_code: "#2468", instructions: "Gate code at the clubhouse entrance keypad." } });

/** The same three people work for every sample business, under the owner. */
const TEAM: DemoTeammate[] = [
  { key: "lead", name: DEMO_CREW_LEAD, role: "crew_lead", rate: 28 },
  { key: "crew", name: "Luis Ortega", role: "field_crew", rate: 21 },
  { key: "office", name: "Tasha Brooks", role: "office", rate: 23 },
];

const html = (text: string) => text.replace(/\n\s*/g, "");
/** A month of the year where the business is, 1 to 12. */
const monthNow = () => Number(new Date().toLocaleDateString("en-CA", { timeZone: TZ, month: "numeric" }));

// =============================================================================================
// Lawn care
// =============================================================================================

const lawn: DemoStory = {
  preset: "lawn_exterior",
  ...named("lawn_exterior"),
  team: TEAM,
  taxRate: 0.053,
  uses: [
    "Weekly mow", "Bi-weekly mow", "Fertilizer application", "Core aeration", "Overseeding", "Mulch install", "Hedge and shrub trimming", "Spring cleanup",
    "Fall cleanup", "Leaf cleanup", "Gutter cleaning", "Snow plowing", "Salt application", "Holiday light install and takedown",
  ],
  async build(s) {
    await s.details({
      phone: "(540) 483-0110",
      email: "office@greenwaylawn.test",
      address: { line1: "212 Tanyard Rd", city: "Rocky Mount", region: "VA", postal_code: "24151" },
      depot: { lat: 36.9902, lng: -79.8975 },
      settings: { job_types: ["Weekly mowing", "Fertilizer program", "Cleanup", "Mulch and beds", "Snow and salt"] },
    });
    await s.teamMembers(TEAM);
    await s.addCrews([
      { name: "Mow crew", color: "#2f7d4f", lead: "lead", members: ["lead", "crew"] },
      { name: "Enhancements crew", color: "#b4691f" },
    ]);
    await s.addClients([JORDAN(), ELENA, HOA("Clubhouse and common areas"), DENTAL, BEN, PRIYA, CARL, STORAGE]);

    // --- Requests and quotes ---------------------------------------------------------------
    const requests = await s.requests([
      { client: "Priya Shah", source: "web_form", title: "Weekly mowing quote", details: "About a third of an acre, front and back. Would like weekly mowing starting this spring.", answers: { property_type: "Home", services: ["Mowing", "Leaf cleanup"] } },
      { client: "Carl Benton", source: "phone", title: "Leaf cleanup and gutters", details: "Big oaks out front. Wants leaves hauled away and the gutters done before Thanksgiving." },
    ]);
    await s.quote(
      "Jordan Rivera",
      "Fertilizer and weed control program",
      "sent",
      [
        await s.line("Fertilizer application", 5, { description: "Five rounds, early spring to late fall" }),
        await s.line("Core aeration", 1, { optional: true, selected: false, description: "Best in early fall" }),
        await s.line("Overseeding", 1, { optional: true, selected: false }),
      ],
      { sent_at: s.ago(3), message: "Here's the five-round program we talked about. Aeration and overseeding are optional; most yards on Pell Ave do well with both in September." },
    );
    await s.quote("Meadowbrook HOA", "Common area beds and hedges", "draft", [await s.line("Mulch install", 18), await s.line("Hedge and shrub trimming", 12), await s.line("Spring cleanup", 1)]);
    const bedsQuote = await s.quote("Hillside Family Dental", "Mulch beds and shrub trimming", "approved", [await s.line("Mulch install", 12), await s.line("Hedge and shrub trimming", 6)], { approved_at: s.ago(6) });
    const bedsJob = await s.convert(bedsQuote, { default_crew_id: s.crew("Enhancements crew") });

    // --- The mowing route: recurring jobs, March to November ------------------------------
    const season = [3, 4, 5, 6, 7, 8, 9, 10, 11];
    const mow = { months: season, minutes: 45, crew: "Mow crew", startsOn: s.day(-60) };
    await s.recurring("Jordan Rivera", "Weekly mowing", [await s.jobLine("Weekly mow", 1)], { ...mow, rule: "FREQ=WEEKLY;BYDAY=MO" });
    await s.recurring("Elena Marsh", "Bi-weekly mowing", [await s.jobLine("Bi-weekly mow", 1)], { ...mow, rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE" });
    await s.recurring("Meadowbrook HOA", "Common areas, weekly mowing", [{ ...(await s.jobLine("Weekly mow", 1)), unit_price: 420, description: "Clubhouse, entrance and common areas" }], { ...mow, minutes: 180, rule: "FREQ=WEEKLY;BYDAY=TU" });
    await s.recurring("Hillside Family Dental", "Weekly mowing", [{ ...(await s.jobLine("Weekly mow", 1)), unit_price: 95 }], { ...mow, minutes: 40, rule: "FREQ=WEEKLY;BYDAY=TH" });

    // --- Snow removal: Crewtavo - Snow installed, four snow customers, last storm in the log ----
    const month = monthNow();
    await snowSeason(s, month);

    // --- This week's other work, by the season ----------------------------------------------
    const extra: Array<[client: string, title: string, service: string, quantity: number]> =
      month <= 2 || month === 12
        ? [["Hillside Family Dental", "Holiday lights takedown", "Holiday light install and takedown", 1], ["Elena Marsh", "Gutter cleaning", "Gutter cleaning", 1]]
        : month <= 5
          ? [["Elena Marsh", "Spring cleanup", "Spring cleanup", 1], ["Jordan Rivera", "Core aeration", "Core aeration", 1]]
          : month <= 8
            ? [["Elena Marsh", "Hedge and shrub trimming", "Hedge and shrub trimming", 4], ["Rocky Mount Self Storage", "Gutter cleaning, office", "Gutter cleaning", 1]]
            : [["Meadowbrook HOA", "Leaf cleanup, common areas", "Leaf cleanup", 2], ["Elena Marsh", "Gutter cleaning", "Gutter cleaning", 1]];
    const extraJobs: string[] = [];
    for (const [client, title, service, quantity] of extra) extraJobs.push(await s.job(client, title, [await s.jobLine(service, quantity)], { default_crew_id: s.crew("Enhancements crew") }));
    const visits = await s.visits([
      { job_id: bedsJob, property_id: s.property("Hillside Family Dental"), title: "Mulch beds and shrub trimming", starts_at: s.at(1, "08:00"), ends_at: s.at(1, "12:30"), crew_id: s.crew("Enhancements crew") },
      { job_id: extraJobs[0], property_id: s.property(extra[0]![0]), title: extra[0]![1], starts_at: s.at(0, "13:00"), ends_at: s.at(0, "16:00"), crew_id: s.crew("Enhancements crew"), status: "in_progress" },
      { job_id: extraJobs[1], property_id: s.property(extra[1]![0]), title: extra[1]![1], starts_at: s.at(2, "09:00"), ends_at: s.at(2, "11:00"), crew_id: s.crew("Enhancements crew") },
      { kind: "assessment", request_id: requests.get("Weekly mowing quote"), property_id: s.property("Priya Shah"), title: "Estimate: Shah lawn", starts_at: s.at(0, "15:30"), ends_at: s.at(0, "16:00") },
    ]);
    await s.assign([visits.get(extra[0]![1])!], ["lead", "crew"]);

    // --- Money ------------------------------------------------------------------------------
    const fallCleanup = await s.job("Meadowbrook HOA", "Fall cleanup, common areas", [await s.jobLine("Fall cleanup", 3)], { status: "requires_invoicing", default_crew_id: s.crew("Enhancements crew") });
    await s.visits([{ job_id: fallCleanup, property_id: s.property("Meadowbrook HOA"), title: "Fall cleanup, common areas", starts_at: s.at(-42, "08:00"), ends_at: s.at(-42, "15:00"), crew_id: s.crew("Enhancements crew"), status: "completed" }]);
    await s.invoice(fallCleanup, { issued: -40 }); // due 10 days ago: overdue
    const storageCleanup = await s.job("Rocky Mount Self Storage", "Lot edges and beds", [await s.jobLine("Spring cleanup", 1), await s.jobLine("Hedge and shrub trimming", 3)], { status: "requires_invoicing", default_crew_id: s.crew("Enhancements crew") });
    const storageInvoice = await s.invoice(storageCleanup, { issued: -12 });
    await s.payment(storageInvoice, "Rocky Mount Self Storage", 200, "check", { daysAgo: 4, notes: "Check #2207" });
    const paid = [
      await s.paidJob("Ben Okafor", "Core aeration and overseeding", [await s.jobLine("Core aeration", 1), await s.jobLine("Overseeding", 1)], 50, "card", "Enhancements crew"),
      await s.paidJob("Elena Marsh", "Gutter cleaning", [await s.jobLine("Gutter cleaning", 1)], 21, "check", "Enhancements crew", "Check #1184"),
      await s.paidJob("Hillside Family Dental", "Leaf cleanup", [await s.jobLine("Leaf cleanup", 1)], 9, "ach", "Enhancements crew"),
    ];
    await s.promoCodes([
      { code: "AERATE15", description: "Fall aeration special", kind: "percent", value: 15, min_subtotal: 100 },
      { code: "WELCOME25", description: "For new customers", kind: "amount", value: 25, new_clients_only: true },
    ]);

    // --- Equipment --------------------------------------------------------------------------
    const gear = await s.equipment([
      { name: "Zero-turn mower 1", kind: "mower", meter: "hours", meter_reading: 612, make: "Scag", model: "Turf Tiger II", year: 2022, crew: "Mow crew" },
      { name: "Zero-turn mower 2", kind: "mower", meter: "hours", meter_reading: 1048, make: "Exmark", model: "Lazer Z", year: 2020, crew: "Mow crew" },
      { name: "Crew truck", kind: "truck", meter: "miles", meter_reading: 61240, make: "Ford", model: "F-250", year: 2021, plate: "VA 2291-GL", crew: "Mow crew" },
      { name: "Enclosed trailer", kind: "trailer", meter: "none", make: "Haulmark", year: 2019, crew: "Mow crew" },
      { name: "Aerator", kind: "machine", meter: "hours", meter_reading: 210, make: "Ryan", model: "Lawnaire 28", year: 2018, crew: "Enhancements crew" },
    ]);
    const [blades] = await s.maintenance([
      { equipment_id: gear.get("Zero-turn mower 1"), name: "Sharpen blades", every_meter: 25, baseline_on: s.day(-12), baseline_meter: 590 },
      { equipment_id: gear.get("Zero-turn mower 2"), name: "Engine oil and filter", every_meter: 100, baseline_on: s.day(-40), baseline_meter: 960 },
      { equipment_id: gear.get("Crew truck"), name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month", baseline_on: s.day(-120), baseline_meter: 56800 },
      { equipment_id: gear.get("Enclosed trailer"), name: "Check tires, lights and brakes", every_count: 3, every_unit: "month", baseline_on: s.day(-85) },
      { equipment_id: gear.get("Aerator"), name: "Clean tines and grease", every_count: 1, every_unit: "month", baseline_on: s.day(-26) },
    ]);
    await s.equipmentHistory([
      { equipment_id: gear.get("Zero-turn mower 1"), kind: "service", plan_id: blades, title: "Sharpen blades", done_on: s.day(-12), meter_reading: 590, by: "lead" },
      { equipment_id: gear.get("Zero-turn mower 2"), kind: "repair", title: "Replaced the deck belt", done_on: s.day(-6), meter_reading: 1031, notes: "Old belt was glazed and slipping on hills.", by: "lead" },
    ]);

    // --- Guides, time, marketing ---------------------------------------------------------------
    await s.guides([
      {
        category: "Mowing and trimming",
        title: "Our mowing standard",
        required: true,
        tags: ["mowing", "quality"],
        html: html(`<h2>Every yard, every visit</h2><ul><li>Mow at <strong>3.5 inches</strong> unless the client's notes say otherwise.</li>
          <li>Alternate the stripe direction each week.</li><li>Edge walks and drives, string-trim around beds and fences.</li>
          <li>Blow off every hard surface before leaving. No clippings in the street or storm drains.</li></ul>
          <h2>Before you leave</h2><p>Close the gate, take a photo of the front, and mark the visit done.</p>`),
      },
      {
        category: "Safety",
        title: "Mowing slopes safely",
        required: true,
        tags: ["safety"],
        html: html(`<p>Zero-turns go <strong>up and down</strong> slopes, never across. Anything steeper than 15 degrees is string-trimmed or push-mowed.</p>
          <ol><li>Walk the slope first and look for holes and wet spots.</li><li>Keep the rollover bar up and the seat belt on.</li><li>Ask the crew lead when in doubt.</li></ol>`),
      },
      {
        category: "Seasonal services",
        title: "What a leaf cleanup includes",
        tags: ["fall"],
        html: html(`<p>Beds, lawn, and the area behind shrubs. Leaves are mulched on the lawn where there's a light layer and hauled away where it's heavy. Gutters are a separate service.</p>`),
      },
    ]);
    await s.time([
      { who: "lead", day: -1, from: "07:00", to: "15:30", rate: 28, notes: "Tuesday route" },
      { who: "crew", day: -1, from: "07:00", to: "15:25", rate: 21 },
      { who: "lead", day: 0, from: "07:05", to: null, rate: 28 },
      { who: "crew", day: 0, from: "07:00", to: null, rate: 21 },
    ]);
    await s.sentCampaign({
      name: "Fall aeration special",
      subject: "Aeration and overseeding: book your spot",
      body: "Hi {{client.first_name}},\n\nFall is the best time to aerate and overseed. Book this month and take 15% off with code AERATE15.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}",
      daysAgo: 6,
      to: ["Jordan Rivera", "Elena Marsh", "Ben Okafor", "Hillside Family Dental", "Meadowbrook HOA"],
    });
    await s.reviewAsks([{ client: "Ben Okafor", job: paid[0]!, sent: 45, clicked: 44 }, { client: "Elena Marsh", job: paid[1]!, sent: 18 }]);
    await s.referral("Jordan Rivera", "Priya Shah", requests.get("Weekly mowing quote") ?? null);
  },
};

/**
 * Greenway's snow removal (Crewtavo - Snow, installed as Apps installs it): the season's contracts
 * for four customers, each a snow customer with its triggers, salting and storm prices, and the
 * last storm in the log with its pushes done and priced. In winter, a storm on the way is scheduled.
 */
async function snowSeason(s: DemoSeeder, month: number) {
  await s.installApp("snow");
  const year = Number(s.day(0).slice(0, 4));
  // A contract that carries over from one winter to the next, so last winter's storm is on it too.
  const season = "Snow and ice contract";
  // As the Snow page expects a snow customer: a job that runs all season, billed a visit at a time.
  const contract = async (client: string, lines: Row[]) =>
    s.job(client, season, lines, { default_crew_id: s.crew("Mow crew"), kind: "recurring", recurrence_rule: "FREQ=YEARLY", billing_mode: "per_visit" });
  const storage = await contract("Rocky Mount Self Storage", [await s.jobLine("Snow plowing", 1), await s.jobLine("Salt application", 1)]);
  const dental = await contract("Hillside Family Dental", [await s.jobLine("Snow plowing", 1), await s.jobLine("Salt application", 1)]);
  const hoa = await contract("Meadowbrook HOA", [{ ...(await s.jobLine("Snow plowing", 1)), unit_price: 180, description: "Entrance, clubhouse drive and lot" }]);
  const jordan = await contract("Jordan Rivera", [await s.jobLine("Snow plowing", 1)]);
  await s.snowSites([
    { job: storage, trigger: 2, salt: 0.5, repeat: 4, clearBy: "06:00", priority: 1, tellClient: true, tiers: [{ up_to_in: 4, price: 120 }, { up_to_in: 8, price: 210 }, { up_to_in: null, price: 300 }] },
    { job: dental, trigger: 1.5, salt: 0.5, repeat: 4, clearBy: "07:00", priority: 1, tellClient: true, tiers: [{ up_to_in: 4, price: 95 }, { up_to_in: 8, price: 165 }, { up_to_in: null, price: 240 }] },
    { job: hoa, trigger: 2, repeat: 3, clearBy: "07:00", priority: 2, tellClient: true, tiers: [{ up_to_in: 4, price: 180 }, { up_to_in: 8, price: 300 }, { up_to_in: null, price: 420 }] },
    // A driveway: plowed once the storm's done, and each push billed at the price list's rate.
    { job: jordan, trigger: 3, priority: 3, tiers: [] },
  ]);
  // The last storm: nine days ago in winter, else the January before.
  const winter = month <= 2 || month === 12;
  const lastStorm = winter ? 9 : Math.round((Date.now() - Date.UTC(month >= 2 ? year : year - 1, 0, 22)) / 86_400_000);
  const stormed: Array<[job: string, client: string, pushes: number]> = [[storage, "Rocky Mount Self Storage", 2], [dental, "Hillside Family Dental", 2], [hoa, "Meadowbrook HOA", 2], [jordan, "Jordan Rivera", 1]];
  await s.pastStorm(lastStorm, 5, 6.5, stormed.map(([job, client, pushes]) => ({ job, client, title: season, pushes, crew: "Mow crew" })));
  // Each storm billed a couple of days after, at its price by depth (the driveway at the price list's), and paid once it's been a while.
  for (const [job, client] of stormed) {
    const invoice = await s.invoice(job, { visits: true, issued: 2 - lastStorm });
    if (lastStorm < 30) continue;
    const { total } = (await s.must(s.db.from("invoices").select("total").eq("id", invoice).single(), "storm invoice")) as { total: number };
    if (Number(total) > 0) await s.payment(invoice, client, Number(total), client === "Jordan Rivera" ? "card" : "check", { daysAgo: lastStorm - 15 });
  }
  if (winter) {
    await s.scheduleStorm(1, [
      { job: storage, inches: 5, pushes: 2 },
      { job: dental, inches: 5, pushes: 2 },
      { job: hoa, inches: 5, pushes: 2 },
    ]);
  }
}

// =============================================================================================
// Roofing
// =============================================================================================

/** 64 Orchard Ave's roof as OpenStreetMap outlines it, with its eaves, rakes and ridge. */
const ROOF: Position[] = [
  [-79.8866248, 36.9942445], [-79.8866261, 36.9942742], [-79.8866788, 36.9942727], [-79.8866827, 36.9943605], [-79.8865986, 36.9943629],
  [-79.8866002, 36.9943965], [-79.88654, 36.9943982], [-79.8865387, 36.9943686], [-79.8865119, 36.9943694], [-79.8865065, 36.9942479], [-79.8866248, 36.9942445],
];
const roofLine = (id: string, edge: string, coordinates: Position[], label: string) => ({ type: "Feature" as const, id, geometry: { type: "LineString" as const, coordinates }, properties: { edge, label } });

const roofing: DemoStory = {
  preset: "roofing_exteriors",
  ...named("roofing_exteriors"),
  team: TEAM,
  taxRate: 0.053,
  uses: [
    "Architectural shingle roof", "Tear-off and disposal", "Drip edge", "Ridge cap", "Ridge vent", "Ice and water shield", "Pipe boot", "Step flashing", "Dumpster",
    "Building permit", "Seamless gutters", "Gutter guards", "Roof repair", "Low-slope section", "Wall flashing", "Reflash a skylight",
  ],
  async build(s) {
    await s.details({
      phone: "(540) 483-0220",
      email: "office@ridgelineroofing.test",
      address: { line1: "48 Industrial Dr", city: "Rocky Mount", region: "VA", postal_code: "24151" },
      depot: { lat: 36.9971, lng: -79.8933 },
      settings: { job_types: ["Roof replacement", "Roof repair", "Insurance claim", "Gutters", "New construction"] },
    });
    await s.teamMembers(TEAM);
    await s.addCrews([
      { name: "Install crew", color: "#2f7d4f", lead: "lead", members: ["lead", "crew"] },
      { name: "Repair and gutter crew", color: "#b4691f" },
    ]);
    await s.addClients([
      JORDAN(PLACES.orchard),
      person("Summit Ridge Builders", "pm@summitridge.test", "(540) 555-0141", "active", "Referral", ["GC", "New construction"], { ...PLACES.summit, label: "Lot 14, Summit Ridge" }, { company: "Summit Ridge Builders LLC" }),
      HOA("Clubhouse"),
      PRIYA,
      CARL,
      ELENA,
      DENTAL,
      BEN,
      STORAGE,
    ]);

    // --- A storm claim: inspected, measured on the aerial, quoted -----------------------------
    const requests = await s.requests([
      { client: "Jordan Rivera", source: "web_form", status: "assessment_complete", title: "Leak over the kitchen after the storm", details: "Water stain on the kitchen ceiling since the hail last week. Insurance says to get an estimate.", answers: { issue: "Storm or hail damage", roof_age: 18, insurance: true } },
      { client: "Priya Shah", source: "web_form", title: "Free roof inspection", details: "Buying this house. Want to know how many years the roof has left.", answers: { issue: "Old roof, want options", roof_age: 22, insurance: false } },
      { client: "Carl Benton", source: "phone", title: "Shingles blown off", details: "Lost a few shingles on the back slope in the wind on Sunday." },
    ]);
    const claim = await s.quote(
      "Jordan Rivera",
      "Roof replacement, 64 Orchard Ave (insurance claim)",
      "sent",
      [
        await s.line("Tear-off and disposal", 25),
        await s.line("Architectural shingle roof", 27),
        await s.line("Ice and water shield", 62),
        await s.line("Drip edge", 196),
        await s.line("Ridge vent", 44),
        await s.line("Pipe boot", 3),
        await s.line("Dumpster", 1),
        await s.line("Building permit", 1),
        await s.line("Seamless gutters", 140, { optional: true, selected: false, description: "6-inch, color-matched to the trim" }),
      ],
      { sent_at: s.ago(2), message: "Thanks for having us out after the storm. This replaces the roof down to the deck. Your adjuster's estimate should cover most of it; we'll meet them on site if you'd like." },
    );
    await s.measurement({
      title: "64 Orchard Ave roof",
      client: "Jordan Rivera",
      quote: claim,
      center: [-79.88659, 36.99432],
      zoom: 20.5,
      pitch: "6/12",
      wastePct: 10,
      features: [
        { type: "Feature", id: "roof", geometry: { type: "Polygon", coordinates: [ROOF] }, properties: { label: "Main roof" } },
        roofLine("eave-west", "eave", [ROOF[2]!, ROOF[3]!], "West eave"),
        roofLine("eave-east", "eave", [ROOF[8]!, ROOF[9]!], "East eave"),
        roofLine("rake-south", "rake", [ROOF[9]!, ROOF[0]!], "South gable"),
        roofLine("rake-north", "rake", [ROOF[5]!, ROOF[6]!], "North gable"),
        roofLine("ridge", "ridge", [[-79.8865927, 36.9942462], [-79.8865958, 36.9943973]], "Ridge"),
      ],
    });
    await s.quote("Meadowbrook HOA", "Clubhouse gutter guards and repairs", "draft", [await s.line("Gutter guards", 180), await s.line("Roof repair", 1), await s.line("Pipe boot", 2)]);

    // --- New construction for a builder: approved, on today's schedule ------------------------
    const lot14 = await s.quote(
      "Summit Ridge Builders",
      "Lot 14 new roof",
      "approved",
      [await s.line("Architectural shingle roof", 34), await s.line("Ice and water shield", 80), await s.line("Drip edge", 230), await s.line("Ridge vent", 52), await s.line("Step flashing", 40), await s.line("Pipe boot", 4)],
      { approved_at: s.ago(12) },
    );
    const lot14Job = await s.convert(lot14, { po_number: "SR-L14", retainage_pct: 10, default_crew_id: s.crew("Install crew"), weather_rules: [{ applies_to: "Architectural shingle roof", min_temp_f: 40, max_rain_pct: 30 }] });
    const storageJob = await s.job("Rocky Mount Self Storage", "Low-slope roof over the office", [await s.jobLine("Low-slope section", 6), await s.jobLine("Wall flashing", 40)], { default_crew_id: s.crew("Repair and gutter crew") });
    const visits = await s.visits([
      { job_id: lot14Job, property_id: s.property("Summit Ridge Builders"), title: "Tear-off and dry-in, Lot 14", starts_at: s.at(0, "07:00"), ends_at: s.at(0, "16:00"), crew_id: s.crew("Install crew"), status: "in_progress" },
      { job_id: lot14Job, property_id: s.property("Summit Ridge Builders"), title: "Shingles and ridge, Lot 14", starts_at: s.at(1, "07:00"), ends_at: s.at(1, "16:00"), crew_id: s.crew("Install crew") },
      { job_id: storageJob, property_id: s.property("Rocky Mount Self Storage"), title: "Low-slope roof, office", starts_at: s.at(3, "07:30"), ends_at: s.at(3, "15:00"), crew_id: s.crew("Repair and gutter crew") },
      { kind: "assessment", request_id: requests.get("Shingles blown off"), property_id: s.property("Carl Benton"), title: "Inspection: Benton roof", starts_at: s.at(0, "15:30"), ends_at: s.at(0, "16:15") },
      { kind: "assessment", request_id: requests.get("Free roof inspection"), property_id: s.property("Priya Shah"), title: "Inspection: Shah roof", starts_at: s.at(2, "10:00"), ends_at: s.at(2, "11:00") },
    ]);
    await s.assign([visits.get("Tear-off and dry-in, Lot 14")!, visits.get("Shingles and ridge, Lot 14")!], ["lead", "crew"]);

    // --- Money ------------------------------------------------------------------------------
    const { contract_total } = (await s.must(s.db.from("job_financials").select("contract_total").eq("job_id", lot14Job).single(), "contract")) as { contract_total: number };
    await s.invoice(lot14Job, { amount: Math.round(Number(contract_total) * 0.3 * 100) / 100, issued: -20, dueIn: 15 }); // the deposit, overdue
    const paid = [
      await s.paidJob("Elena Marsh", "Roof repair and pipe boots", [await s.jobLine("Roof repair", 1), await s.jobLine("Pipe boot", 2)], 30, "card", "Repair and gutter crew"),
      await s.paidJob("Hillside Family Dental", "Seamless gutters and guards", [await s.jobLine("Seamless gutters", 160), await s.jobLine("Gutter guards", 160)], 18, "ach", "Repair and gutter crew"),
      await s.paidJob("Ben Okafor", "Reflash the skylight", [await s.jobLine("Reflash a skylight", 1)], 8, "check", "Repair and gutter crew", "Check #3381"),
    ];
    await s.promoCodes([
      { code: "STORM250", description: "Storm season replacement", kind: "amount", value: 250, min_subtotal: 5000 },
      { code: "WELCOME100", description: "For new customers", kind: "amount", value: 100, new_clients_only: true },
    ]);

    // --- Equipment --------------------------------------------------------------------------
    const gear = await s.equipment([
      { name: "Crew truck 1", kind: "truck", meter: "miles", meter_reading: 73410, make: "Ford", model: "F-350", year: 2021, plate: "VA 7714-RR", crew: "Install crew" },
      { name: "Dump trailer", kind: "trailer", meter: "none", make: "Big Tex", model: "14LP", year: 2020, crew: "Install crew" },
      { name: "Ladder hoist", kind: "machine", meter: "hours", meter_reading: 380, make: "Safety Hoist", year: 2019, crew: "Install crew" },
      { name: "Harness kits (4)", kind: "tool", meter: "none", crew: "Install crew", notes: "Kept in the truck's left box. Tag any with frayed webbing and take it out of service." },
      { name: "Gutter machine", kind: "machine", meter: "none", make: "New Tech", model: "5/6 combo", year: 2017, crew: "Repair and gutter crew" },
    ]);
    const [harness] = await s.maintenance([
      { equipment_id: gear.get("Harness kits (4)"), name: "Inspect harnesses and lanyards", every_count: 1, every_unit: "month", baseline_on: s.day(-27) },
      { equipment_id: gear.get("Crew truck 1"), name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month", baseline_on: s.day(-100), baseline_meter: 69200 },
      { equipment_id: gear.get("Dump trailer"), name: "Check tires, lights and brakes", every_count: 3, every_unit: "month", baseline_on: s.day(-95) },
      { equipment_id: gear.get("Ladder hoist"), name: "Inspect cable and brake", every_meter: 100, baseline_on: s.day(-30), baseline_meter: 310 },
    ]);
    await s.equipmentHistory([
      { equipment_id: gear.get("Harness kits (4)"), kind: "service", plan_id: harness, title: "Inspect harnesses and lanyards", done_on: s.day(-27), by: "lead", notes: "All four passed." },
      { equipment_id: gear.get("Ladder hoist"), kind: "repair", title: "New platform rollers", done_on: s.day(-9), meter_reading: 372, by: "lead" },
    ]);

    // --- Guides, time, marketing ---------------------------------------------------------------
    await s.guides([
      {
        category: "Safety and fall protection",
        title: "Before anyone steps on a roof",
        required: true,
        tags: ["safety"],
        html: html(`<ol><li>Ladder tied off at the top, three feet above the eave.</li><li>Anchors set at the ridge before tear-off starts.</li>
          <li>Everyone on the roof clipped in. No exceptions on anything over 4/12.</li><li>Check the forecast: no work on wet or frosted decking.</li></ol>`),
      },
      {
        category: "Roofing",
        title: "Nailing architectural shingles",
        tags: ["install", "quality"],
        html: html(`<p><strong>Six nails</strong> per shingle in the nail strip, never above it. Four is the manufacturer's minimum but voids the high-wind warranty.</p><p>Nails flush, not overdriven. Check every third course.</p>`),
      },
      {
        category: "Insurance claims",
        title: "Photos to take for an insurance claim",
        required: true,
        tags: ["insurance"],
        html: html(`<ul><li>All four sides of the house from the ground.</li><li>Each slope, with a chalk square around hail hits.</li>
          <li>Gutters, downspouts and window screens (hail shows there too).</li><li>The attic, if there's a leak.</li></ul>`),
      },
    ]);
    await s.time([
      { who: "lead", day: -1, from: "07:00", to: "16:10", rate: 28, job: storageJob, category: "shop", notes: "Loaded the trailer and staged Lot 14" },
      { who: "lead", day: 0, from: "06:55", to: null, rate: 28, job: lot14Job, visit: visits.get("Tear-off and dry-in, Lot 14") },
      { who: "crew", day: 0, from: "07:00", to: null, rate: 21, job: lot14Job, visit: visits.get("Tear-off and dry-in, Lot 14") },
    ]);
    await s.sentCampaign({
      name: "Free storm damage checks",
      subject: "Hail last week? We'll check your roof for free",
      body: "Hi {{client.first_name}},\n\nLast week's hail hit a lot of roofs in Franklin County. We're doing free storm checks this month, and we work with every insurance company.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}",
      daysAgo: 6,
      to: ["Jordan Rivera", "Elena Marsh", "Ben Okafor", "Hillside Family Dental", "Meadowbrook HOA"],
    });
    await s.reviewAsks([{ client: "Hillside Family Dental", job: paid[1]!, sent: 15, clicked: 14 }, { client: "Ben Okafor", job: paid[2]!, sent: 5 }]);
    await s.referral("Elena Marsh", "Priya Shah", requests.get("Free roof inspection") ?? null);
  },
};

// =============================================================================================
// Paving: Acme Paving, as scripts/seed-demo.mjs makes it
// =============================================================================================

const shape = (id: string, item: string, type: "Polygon" | "LineString" | "Point", coordinates: unknown, label?: string) => ({ type: "Feature" as const, id, geometry: { type, coordinates } as never, properties: { item, ...(label ? { label } : {}) } });

const paving: DemoStory = {
  preset: "paving",
  ...named("paving"),
  team: TEAM,
  taxRate: 0.053,
  uses: [
    "Remove and haul existing asphalt", "Grade and compact stone base", "Hot-mix asphalt surface", "Sealcoat", "Hot-pour crack seal", "Line striping", "ADA stall package",
    "Mobilization and trucking", "Mill and overlay 2 inch", "Asphalt patch", "Crosswalks and stop bars",
  ],
  async build(s) {
    await s.details({
      phone: "(540) 483-0000",
      email: "office@acmepaving.test",
      address: { line1: "100 Industrial Dr", city: "Rocky Mount", region: "VA", postal_code: "24151" },
      depot: { lat: 36.9976, lng: -79.892 },
    });
    await s.teamMembers(TEAM);
    await s.addCrews([
      { name: "Paving crew", color: "#2f7d4f", lead: "lead", members: ["lead", "crew"] },
      { name: "Sealcoat crew", color: "#b4691f" },
    ]);
    await s.addClients([
      person("Summit Ridge Builders", "pm@summitridge.test", "(540) 555-0141", "active", "Referral", ["GC", "Commercial"], PLACES.summit, { company: "Summit Ridge Builders LLC" }),
      JORDAN(),
      person("Town of Rocky Mount", "publicworks@rockymount.test", "(540) 555-0100", "active", "Bid", ["Municipal"], PLACES.town, { company: "Town of Rocky Mount Public Works" }),
      HOA("Clubhouse lot"),
      PRIYA,
      CARL,
      ELENA,
      DENTAL,
      BEN,
      STORAGE,
    ]);

    // --- Requests, quotes, jobs ---------------------------------------------------------------
    const requests = await s.requests([
      { client: "Priya Shah", source: "web_form", title: "Driveway estimate request", details: "Gravel drive, about 120 ft long. Would like asphalt before winter.", answers: { surface: "Gravel", size: "120 ft x 12 ft", drainage: "Yes" } },
      { client: "Carl Benton", source: "phone", title: "Sealcoat and crack repair", details: "Driveway has spider cracking near the garage." },
      { client: "Meadowbrook HOA", source: "email", status: "assessment_complete", title: "Clubhouse lot restripe", details: "About 45 stalls plus two ADA spaces." },
    ]);
    await s.quote(
      "Jordan Rivera",
      "Driveway replacement, 418 Pell Ave",
      "sent",
      [
        await s.line("Remove and haul existing asphalt", 1650),
        await s.line("Grade and compact stone base", 24),
        await s.line("Hot-mix asphalt surface", 31),
        await s.line("Sealcoat", 1650, { optional: true, selected: false, description: "Recommended after 6 months" }),
      ],
      { sent_at: s.ago(4), message: "Thanks for having us out. This covers full removal and a new 2.5 inch surface." },
    );
    // Quantities as the takeoff below measures them.
    const hoaQuote = await s.quote("Meadowbrook HOA", "Clubhouse lot sealcoat and restripe", "draft", [await s.line("Sealcoat", 26380), await s.line("Hot-pour crack seal", 126), await s.line("Line striping", 882), await s.line("ADA stall package", 2)]);
    const approved = await s.quote(
      "Summit Ridge Builders",
      "Phase 2 subdivision roads (binder + surface)",
      "approved",
      [await s.line("Grade and compact stone base", 410), await s.line("Hot-mix asphalt surface", 620), await s.line("Mobilization and trucking", 7)],
      { approved_at: s.ago(10) },
    );
    const summitJob = await s.convert(approved, { po_number: "SR-2207", retainage_pct: 10, default_crew_id: s.crew("Paving crew"), weather_rules: [{ applies_to: "Hot-mix asphalt surface", min_temp_f: 50, max_rain_pct: 40 }] });
    const townJob = await s.job("Town of Rocky Mount", "Alley program, block 4 overlay", [await s.jobLine("Mill and overlay 2 inch", 5200)], { status: "requires_invoicing", default_crew_id: s.crew("Paving crew"), po_number: "WO-24-118" });
    await s.recurring("Meadowbrook HOA", "Clubhouse lot sweeping (monthly)", [], { rule: "FREQ=MONTHLY;BYDAY=1MO", months: [3, 4, 5, 6, 7, 8, 9, 10, 11], minutes: 90, crew: "Sealcoat crew" });

    // --- A week of visits ----------------------------------------------------------------------
    const summit = s.property("Summit Ridge Builders");
    const town = s.property("Town of Rocky Mount");
    const visits = await s.visits([
      { job_id: summitJob, property_id: summit, title: "Stone base, Phase 2 north loop", starts_at: s.at(0, "07:00"), ends_at: s.at(0, "12:00"), crew_id: s.crew("Paving crew"), status: "in_progress" },
      { job_id: townJob, property_id: town, title: "Overlay final walkthrough", starts_at: s.at(0, "13:30"), ends_at: s.at(0, "14:30"), crew_id: s.crew("Paving crew") },
      { kind: "assessment", request_id: requests.get("Driveway estimate request"), property_id: s.property("Priya Shah"), title: "Estimate: Shah driveway", starts_at: s.at(0, "15:30"), ends_at: s.at(0, "16:15") },
      { job_id: summitJob, property_id: summit, title: "Binder course, Phase 2", starts_at: s.at(1, "07:00"), ends_at: s.at(1, "15:00"), crew_id: s.crew("Paving crew") },
      { job_id: summitJob, property_id: summit, title: "Surface course, Phase 2", starts_at: s.at(3, "07:00"), ends_at: s.at(3, "15:00"), crew_id: s.crew("Paving crew") },
      { job_id: townJob, property_id: town, title: "Overlay, block 4 alleys", starts_at: s.at(-2, "07:00"), ends_at: s.at(-2, "16:00"), crew_id: s.crew("Paving crew"), status: "completed" },
    ]);
    await s.assign(["Stone base, Phase 2 north loop", "Overlay final walkthrough", "Binder course, Phase 2"].map((t) => visits.get(t)!), ["lead", "crew"]);

    // --- Invoices -------------------------------------------------------------------------------
    const { contract_total } = (await s.must(s.db.from("job_financials").select("contract_total").eq("job_id", summitJob).single(), "contract")) as { contract_total: number };
    await s.invoice(summitJob, { amount: Math.round(Number(contract_total) * 0.4 * 100) / 100, issued: -40 }); // overdue
    const townInvoice = await s.invoice(townJob, { issued: -1 });
    await s.payment(townInvoice, "Town of Rocky Mount", 5000, "check", { notes: "Check #10442" });
    await s.promoCodes([
      { code: "SPRING10", description: "Spring sealcoating special", kind: "percent", value: 10, min_subtotal: 500 },
      { code: "WELCOME50", description: "For new customers", kind: "amount", value: 50, new_clients_only: true },
    ]);

    // --- Equipment -------------------------------------------------------------------------------
    const gear = await s.equipment([
      { name: "Dump truck 1", kind: "truck", meter: "miles", meter_reading: 84210, make: "Ford", model: "F-550", year: 2019, plate: "VA 4471-PV", crew: "Paving crew" },
      { name: "Paver", kind: "machine", meter: "hours", meter_reading: 2306, make: "LeeBoy", model: "8520", year: 2017, crew: "Paving crew", notes: "Screed heaters run off the left tank. 15W-40 in the engine." },
      { name: "Roller", kind: "machine", meter: "hours", meter_reading: 1184, make: "Caterpillar", model: "CB2.7", year: 2020, crew: "Paving crew" },
      { name: "Lowboy trailer", kind: "trailer", meter: "none", make: "Felling", year: 2018, crew: "Paving crew" },
      { name: "Sealcoat skid", kind: "machine", meter: "hours", meter_reading: 412, crew: "Sealcoat crew" },
    ]);
    const [, , rollerOil] = await s.maintenance([
      { equipment_id: gear.get("Dump truck 1"), name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month", baseline_on: s.day(-110), baseline_meter: 79600 },
      { equipment_id: gear.get("Paver"), name: "Engine oil and filter", every_meter: 250, baseline_on: s.day(-70), baseline_meter: 2040 },
      { equipment_id: gear.get("Roller"), name: "Engine oil and filter", every_meter: 250, every_count: 1, every_unit: "year", baseline_on: s.day(-150), baseline_meter: 800 },
      { equipment_id: gear.get("Roller"), name: "Check water spray nozzles", every_count: 1, every_unit: "month", baseline_on: s.day(-18) },
      { equipment_id: gear.get("Lowboy trailer"), name: "Check tires, lights and brakes", every_count: 3, every_unit: "month", baseline_on: s.day(-100) },
      { equipment_id: gear.get("Sealcoat skid"), name: "Flush pump and lines", every_count: 2, every_unit: "week", baseline_on: s.day(-4) },
    ]);
    await s.equipmentHistory([
      { equipment_id: gear.get("Roller"), kind: "service", plan_id: rollerOil, title: "Engine oil and filter", done_on: s.day(-30), meter_reading: 1050, by: "lead" },
      { equipment_id: gear.get("Paver"), kind: "repair", title: "Replaced hydraulic hose on the hopper", done_on: s.day(-12), meter_reading: 2280, notes: "Hose was rubbing on the frame. Added a clamp.", by: "lead" },
      { equipment_id: gear.get("Paver"), kind: "reading", done_on: s.day(-5), meter_reading: 2298, by: "crew" },
    ]);

    // --- Guides ----------------------------------------------------------------------------------
    await s.guides([
      {
        category: "Paving",
        title: "Hot-mix laydown temperatures",
        required: true,
        tags: ["asphalt", "quality"],
        html: html(`<h2>Minimum temperatures</h2><ul><li>Air and base at least <strong>50°F and rising</strong> for surface courses.</li><li>Mat temperature behind the screed: <strong>275–300°F</strong>.</li>
          <li>Stop rolling below 175°F.</li></ul><h2>If a load arrives cold</h2><p>Reject loads below 250°F at the truck and note the ticket number.</p>`),
      },
      {
        category: "Safety",
        title: "Call 811 before any digging",
        required: true,
        tags: ["safety"],
        html: html(`<p>Confirm the 811 ticket number and the marking date on the work order <strong>before</strong> any excavation, including sign posts.</p>
          <ol><li>Check the ticket is still valid (Virginia: 15 working days).</li><li>Photograph all paint marks.</li><li>Hand dig within 2 feet of marks.</li></ol>`),
      },
      {
        category: "Sealcoating and striping",
        title: "Sealcoat cure times",
        tags: ["sealcoat"],
        html: html(`<p>Keep traffic off for <strong>24 hours</strong>, longer below 60°F or in shade. Don't apply if rain is expected within 24 hours.</p>`),
      },
    ]);

    // --- Paid work from the last two months, and a job coming up ---------------------------------
    const paid = [
      await s.paidJob("Elena Marsh", "Driveway sealcoat and crack fill", [await s.jobLine("Sealcoat", 1800), await s.jobLine("Hot-pour crack seal", 120)], 52, "card", "Sealcoat crew"),
      await s.paidJob("Hillside Family Dental", "Parking lot sealcoat and restripe", [await s.jobLine("Sealcoat", 14200), await s.jobLine("Line striping", 620), await s.jobLine("ADA stall package", 1)], 24, "ach", "Sealcoat crew"),
      await s.paidJob("Ben Okafor", "Driveway patch and sealcoat", [await s.jobLine("Asphalt patch", 64), await s.jobLine("Sealcoat", 1450)], 9, "check", "Sealcoat crew", "Check #3381"),
    ];
    const storageJob = await s.job("Rocky Mount Self Storage", "Lot patch and sealcoat", [await s.jobLine("Asphalt patch", 220), await s.jobLine("Sealcoat", 21500)], { default_crew_id: s.crew("Sealcoat crew"), po_number: "RMSS-1102" });
    await s.visits([{ job_id: storageJob, property_id: s.property("Rocky Mount Self Storage"), title: "Patch and sealcoat, storage lot", starts_at: s.at(1, "08:00"), ends_at: s.at(1, "14:00"), crew_id: s.crew("Sealcoat crew") }]);
    await s.job("Town of Rocky Mount", "Crosswalks and stop bars, Franklin St", [await s.jobLine("Crosswalks and stop bars", 340)], { default_crew_id: s.crew("Sealcoat crew"), po_number: "WO-24-131" });

    // --- A takeoff: the clubhouse lot outlined on the aerial (OpenStreetMap's way 334609878) --------
    await s.measurement({
      title: "Clubhouse lot",
      client: "Meadowbrook HOA",
      quote: hoaQuote,
      center: [-79.927766, 36.985444],
      zoom: 19.3,
      features: [
        shape("lot", "asphalt", "Polygon", [[[-79.928213, 36.985474], [-79.928061, 36.985191], [-79.92734, 36.985402], [-79.927449, 36.985709], [-79.928213, 36.985474]]], "Clubhouse lot"),
        shape("row-south", "stall_row", "LineString", [[-79.92805, 36.985247], [-79.927393, 36.985439]], "South row"),
        shape("row-north", "stall_row", "LineString", [[-79.927458, 36.985653], [-79.928159, 36.985437]], "North row"),
        shape("ada-1", "ada_stall", "Point", [-79.928159, 36.985465]),
        shape("ada-2", "ada_stall", "Point", [-79.928128, 36.985475]),
        shape("crack-1", "crack", "LineString", [[-79.928052, 36.985357], [-79.928019, 36.985366], [-79.92782, 36.985425]], "Crack seal 1"),
        shape("crack-2", "crack", "LineString", [[-79.927698, 36.985435], [-79.927608, 36.985453], [-79.927518, 36.985439]], "Crack seal 2"),
      ],
    });

    // --- Time this week, marketing ----------------------------------------------------------------
    await s.time([
      { who: "lead", day: -2, from: "06:45", to: "16:20", rate: 28, job: townJob, visit: visits.get("Overlay, block 4 alleys") },
      { who: "crew", day: -2, from: "06:50", to: "16:15", rate: 21, job: townJob, visit: visits.get("Overlay, block 4 alleys") },
      { who: "lead", day: -1, from: "07:00", to: "09:30", rate: 28, category: "shop", notes: "Paver screed and roller service" },
      { who: "lead", day: -1, from: "09:30", to: "15:30", rate: 28, job: summitJob, notes: "Proof-rolled the north loop with the GC" },
      { who: "lead", day: 0, from: "06:55", to: null, rate: 28, job: summitJob, visit: visits.get("Stone base, Phase 2 north loop") },
      { who: "crew", day: 0, from: "07:00", to: null, rate: 21, job: summitJob, visit: visits.get("Stone base, Phase 2 north loop") },
    ]);
    await s.sentCampaign({
      name: "Fall sealcoat special",
      subject: "Seal your driveway before winter",
      body: "Hi {{client.first_name}},\n\nSealcoat goes down best before the cold sets in. Book this month and take 10% off with code SPRING10.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}",
      daysAgo: 6,
      to: ["Summit Ridge Builders", "Jordan Rivera", "Town of Rocky Mount", "Meadowbrook HOA", "Elena Marsh", "Hillside Family Dental", "Ben Okafor"],
    });
    await s.reviewAsks([{ client: "Hillside Family Dental", job: paid[1]!, sent: 18, clicked: 17 }, { client: "Ben Okafor", job: paid[2]!, sent: 3, clicked: 3 }, { client: "Town of Rocky Mount", job: townJob, sent: 1 }]);
    await s.referral("Jordan Rivera", "Priya Shah", requests.get("Driveway estimate request") ?? null);
  },
};

// =============================================================================================
// Any other trade: a business made from the trade's own price list
// =============================================================================================


/** A sensible amount of an item, by its unit: an hour or two of labor, a driveway's square feet. */
export function quantityFor(unit: string, size: "small" | "big" = "small"): number {
  const u = unit.toLowerCase();
  const big = size === "big";
  if (/sq ?ft|square f/.test(u)) return big ? 1800 : 420;
  if (/^(ft|lf|linear)/.test(u)) return big ? 220 : 60;
  if (/hr|hour/.test(u)) return big ? 6 : 2;
  if (/sq ?yd/.test(u)) return big ? 400 : 90;
  if (/square/.test(u)) return big ? 30 : 12;
  if (/cu ?yd|yard/.test(u)) return big ? 12 : 4;
  if (/gal/.test(u)) return big ? 20 : 5;
  if (/pane|window|ea|each|unit|item|panel|room|fixture|outlet|stop|trap/.test(u)) return big ? 6 : 2;
  return 1;
}

/** The price list items a general business's story quotes from: the ones that read as work, not fees. */
export function storyItems(list: ReadonlyArray<Pick<PresetService, "name" | "unit">>) {
  const fee = (s: Pick<PresetService, "name">) => /trip|service call|minimum|after-hours|permit|fee|diagnostic/i.test(s.name);
  const labor = list.find((s) => /hr|hour/i.test(s.unit)) ?? list[0]!;
  const call = list.find(fee) ?? list[0]!;
  const work = list.filter((s) => !fee(s) && s !== labor);
  const pick = (i: number) => work[i % Math.max(work.length, 1)] ?? labor;
  const plan = list.find((s) => /month|plan/i.test(s.unit) || /plan\b/i.test(s.name)) ?? null;
  return { labor, call, a: pick(0), b: pick(1), c: pick(2), d: pick(3), plan };
}

function general(preset: { id: string; name: string; sop_categories: string[] }): DemoStory {
  return {
    preset: preset.id,
    business: demoOtherBusiness(preset),
    owner: DEMO_OTHER_OWNER,
    team: TEAM,
    taxRate: 0.053,
    async build(s) {
      await s.details({
        phone: "(540) 483-0330",
        email: "office@demo-business.test",
        address: { line1: "300 Franklin St", city: "Rocky Mount", region: "VA", postal_code: "24151" },
        depot: { lat: 36.9975, lng: -79.8919 },
      });
      await s.teamMembers(TEAM);
      await s.addCrews([
        { name: "Crew 1", color: "#2f7d4f", lead: "lead", members: ["lead", "crew"] },
        { name: "Crew 2", color: "#b4691f" },
      ]);
      await s.addClients([JORDAN(), ELENA, HOA("Clubhouse"), DENTAL, BEN, PRIYA, CARL, STORAGE]);
      const items = storyItems(await s.priceList());
      const line = (item: { name: string; unit: string }, size: "small" | "big" = "small", extra: Row = {}) => s.line(item.name, quantityFor(item.unit, size), extra);
      const jobLine = (item: { name: string; unit: string }, size: "small" | "big" = "small") => s.jobLine(item.name, quantityFor(item.unit, size));

      const requests = await s.requests([
        { client: "Priya Shah", source: "web_form", title: "Estimate request", details: `Looking for a price on ${items.a.name.toLowerCase()}. Weekday mornings are best.` },
        { client: "Carl Benton", source: "phone", title: `Question about ${items.b.name.toLowerCase()}`, details: "Called the office. Wants someone to take a look this week." },
      ]);
      await s.quote(
        "Jordan Rivera",
        `${items.a.name} and ${items.b.name.toLowerCase()}`,
        "sent",
        [await line(items.a, "big"), await line(items.b), await line(items.labor), await line(items.c, "small", { optional: true, selected: false })],
        { sent_at: s.ago(3), message: "Thanks for having us out. Here's what we talked about; the last line is optional." },
      );
      await s.quote("Meadowbrook HOA", `Clubhouse ${items.c.name.toLowerCase()}`, "draft", [await line(items.c, "big"), await line(items.d)]);
      const approved = await s.quote("Hillside Family Dental", `${items.d.name} for the office`, "approved", [await line(items.d, "big"), await line(items.labor, "big")], { approved_at: s.ago(5) });
      const dentalJob = await s.convert(approved, { default_crew_id: s.crew("Crew 1") });
      const elenaJob = await s.job("Elena Marsh", items.a.name, [await jobLine(items.call), await jobLine(items.a)], { default_crew_id: s.crew("Crew 1") });
      const storageJob = await s.job("Rocky Mount Self Storage", items.b.name, [await jobLine(items.b, "big")], { default_crew_id: s.crew("Crew 2") });
      // Something on a schedule: the trade's plan when it has one (pest control, pools), else a monthly visit.
      const regular = items.plan ?? items.call;
      await s.recurring("Meadowbrook HOA", items.plan ? items.plan.name : "Monthly service visit", [await s.jobLine(regular.name, 1)], {
        rule: items.plan && /week/i.test(items.plan.name) ? "FREQ=WEEKLY;BYDAY=TU" : "FREQ=MONTHLY;BYDAY=1TU",
        minutes: 60,
        crew: "Crew 2",
      });
      const visits = await s.visits([
        { job_id: elenaJob, property_id: s.property("Elena Marsh"), title: `${items.a.name}: Marsh`, starts_at: s.at(0, "08:00"), ends_at: s.at(0, "11:00"), crew_id: s.crew("Crew 1"), status: "in_progress" },
        { kind: "assessment", request_id: requests.get("Estimate request"), property_id: s.property("Priya Shah"), title: "Estimate: Shah", starts_at: s.at(0, "15:30"), ends_at: s.at(0, "16:15") },
        { job_id: dentalJob, property_id: s.property("Hillside Family Dental"), title: `${items.d.name}: Hillside Family Dental`, starts_at: s.at(1, "08:00"), ends_at: s.at(1, "14:00"), crew_id: s.crew("Crew 1") },
        { job_id: storageJob, property_id: s.property("Rocky Mount Self Storage"), title: `${items.b.name}: storage office`, starts_at: s.at(2, "09:00"), ends_at: s.at(2, "12:00"), crew_id: s.crew("Crew 2") },
      ]);
      await s.assign([visits.get(`${items.a.name}: Marsh`)!], ["lead", "crew"]);

      const oldJob = await s.job("Meadowbrook HOA", `${items.c.name}, clubhouse`, [await jobLine(items.c, "big")], { status: "requires_invoicing", default_crew_id: s.crew("Crew 2") });
      await s.visits([{ job_id: oldJob, property_id: s.property("Meadowbrook HOA"), title: `${items.c.name}, clubhouse`, starts_at: s.at(-41, "08:00"), ends_at: s.at(-41, "13:00"), crew_id: s.crew("Crew 2"), status: "completed" }]);
      await s.invoice(oldJob, { issued: -40 }); // overdue
      const benJob = await s.job("Ben Okafor", items.b.name, [await jobLine(items.b), await jobLine(items.labor)], { status: "requires_invoicing", default_crew_id: s.crew("Crew 1") });
      const benInvoice = await s.invoice(benJob, { issued: -12 });
      await s.payment(benInvoice, "Ben Okafor", 100, "check", { daysAgo: 3, notes: "Check #2207" });
      const paid = [
        await s.paidJob("Hillside Family Dental", items.a.name, [await jobLine(items.a, "big")], 48, "ach", "Crew 1"),
        await s.paidJob("Jordan Rivera", items.call.name, [await jobLine(items.call), await jobLine(items.labor)], 20, "card", "Crew 1"),
        await s.paidJob("Elena Marsh", items.c.name, [await jobLine(items.c)], 7, "check", "Crew 2", "Check #1184"),
      ];
      await s.promoCodes([{ code: "WELCOME25", description: "For new customers", kind: "amount", value: 25, new_clients_only: true }]);

      const gear = await s.equipment([
        { name: "Service van 1", kind: "truck", meter: "miles", meter_reading: 48210, make: "Ford", model: "Transit 250", year: 2022, plate: "VA 5530-HS", crew: "Crew 1" },
        { name: "Service van 2", kind: "truck", meter: "miles", meter_reading: 96480, make: "Ram", model: "ProMaster", year: 2019, crew: "Crew 2" },
        { name: "Utility trailer", kind: "trailer", meter: "none", make: "Carry-On", year: 2020, crew: "Crew 2" },
      ]);
      const [oil] = await s.maintenance([
        { equipment_id: gear.get("Service van 1"), name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month", baseline_on: s.day(-90), baseline_meter: 44100 },
        { equipment_id: gear.get("Service van 2"), name: "Oil change", every_meter: 5000, every_count: 6, every_unit: "month", baseline_on: s.day(-150), baseline_meter: 91800 },
        { equipment_id: gear.get("Utility trailer"), name: "Check tires, lights and brakes", every_count: 3, every_unit: "month", baseline_on: s.day(-80) },
      ]);
      await s.equipmentHistory([{ equipment_id: gear.get("Service van 1"), kind: "service", plan_id: oil, title: "Oil change", done_on: s.day(-90), meter_reading: 44100, by: "lead" }]);

      const [first = "", second = first] = preset.sop_categories;
      await s.guides([
        {
          category: first,
          title: "Arriving at a client's home or business",
          required: true,
          html: html(`<ol><li>Park so you don't block the drive or the neighbors.</li><li>Knock, introduce yourself, and confirm what we're there to do.</li>
            <li>Shoe covers on inside a home.</li><li>Before starting, take a photo of the work area.</li></ol>`),
        },
        {
          category: second,
          title: "Leaving the site clean",
          html: html(`<p>Pick up every scrap, wipe down what you touched, and take a photo of the finished work. Walk the client through it if they're home.</p>`),
        },
      ]);
      await s.time([
        { who: "lead", day: -1, from: "07:30", to: "16:00", rate: 28 },
        { who: "crew", day: -1, from: "07:30", to: "15:45", rate: 21 },
        { who: "lead", day: 0, from: "07:35", to: null, rate: 28, job: elenaJob },
      ]);
      await s.sentCampaign({
        name: "Check-up special",
        subject: "Time for a check-up?",
        body: "Hi {{client.first_name}},\n\nWe have openings this month. Reply or book online and we'll take care of it.\n\n{{link}}\n\nThanks,\n{{company.name}}\n{{company.phone}}",
        daysAgo: 6,
        to: ["Jordan Rivera", "Elena Marsh", "Ben Okafor", "Hillside Family Dental", "Meadowbrook HOA"],
      });
      await s.reviewAsks([{ client: "Hillside Family Dental", job: paid[0]!, sent: 44, clicked: 43 }, { client: "Elena Marsh", job: paid[2]!, sent: 5 }]);
    },
  };
}

export const FEATURED_STORIES: Record<string, DemoStory> = { lawn_exterior: lawn, roofing_exteriors: roofing, paving };

/** The story for a trade preset: written for it, or made from its price list. */
export function storyFor(preset: { id: string; name: string; sop_categories: string[] }): DemoStory {
  return FEATURED_STORIES[preset.id] ?? general(preset);
}
