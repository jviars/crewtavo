/**
 * What a sample business in the public demo is made with (services/demoStories.ts writes one for
 * each trade). The rows go in as the business's owner, so the database checks them as it checks
 * anyone's; only what a person can't write for someone else (the crew's own time, a sent campaign,
 * review asks) goes in with the server's key, as scripts/seed-demo.mjs does.
 *
 * Every date is counted from today in the business's time zone, so a business made on any day has
 * a schedule for this week, an invoice gone overdue and payments from the last two months.
 */
import { drawingSquares, normalizePitch, summarizeFeatureCollection, zonedTimeToUtc, type FeatureCollection } from "@crewtavo/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { materializeJob, recurringJob } from "../tasks";
import type { Db } from "../lib/supabase";

/** A plain row: the database checks it, as it checks what the app sends. */
export type Row = Record<string, unknown>;

export interface DemoPlace {
  label?: string;
  line1: string;
  city: string;
  region: string;
  postal_code: string;
  lat: number;
  lng: number;
}

export interface DemoClient {
  name: string;
  company?: string;
  email: string;
  phone: string;
  status: "active" | "lead";
  source: string;
  tags: string[];
  place: DemoPlace;
  /** A gate code or a note for the crew, on the property. */
  access?: { gate_code?: string; instructions: string };
}

/** Someone on the sample business's team besides the owner. Each gets an account nobody signs in to (but the visitor, as them). */
export interface DemoTeammate {
  /** How the story names them. */
  key: string;
  name: string;
  role: "crew_lead" | "field_crew" | "office";
  rate: number;
}

const DEFAULTS = { defaultToNull: false };

export class DemoSeeder {
  /** Untyped on purpose: the rows below are plain objects, as in the seed script, and the database checks them. */
  readonly db: SupabaseClient;
  readonly admin: SupabaseClient;
  readonly clients = new Map<string, string>();
  readonly properties = new Map<string, string>();
  readonly crews = new Map<string, string>();
  private services: Array<{ id: string; name: string; unit: string; unit_price: number; formula: string | null }> = [];

  constructor(
    db: Db,
    admin: Db,
    readonly company: string,
    readonly ownerId: string,
    /** The team's accounts, by the story's key for each. */
    readonly team: Record<string, string>,
    readonly tz: string,
    readonly taxRate: number,
  ) {
    this.db = db as unknown as SupabaseClient;
    this.admin = admin as unknown as SupabaseClient;
  }

  c = (row: Row): Row => ({ company_id: this.company, ...row });

  async must<T>(promise: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<NonNullable<T>> {
    const { data, error } = await promise;
    if (error) throw new Error(`Demo ${what}: ${error.message}`);
    return data as NonNullable<T>;
  }

  // --- Dates, from today where the business is -----------------------------------------------

  /** The date `offset` days from today, where the business is (YYYY-MM-DD). */
  day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: this.tz });
  /** That day at `hhmm` where the business is, as a timestamp. */
  at = (offset: number, hhmm: string): string => zonedTimeToUtc(this.day(offset), hhmm, this.tz).toISOString();
  /** `n` days ago, as a timestamp. */
  ago = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  /** Who a story names: the owner, or a teammate by key. */
  person = (key: string): string => {
    if (key === "owner") return this.ownerId;
    const id = this.team[key];
    if (!id) throw new Error(`Demo: nobody on the team is "${key}"`);
    return id;
  };
  client = (name: string): string => {
    const id = this.clients.get(name);
    if (!id) throw new Error(`Demo: no client "${name}"`);
    return id;
  };
  property = (name: string): string => {
    const id = this.properties.get(name);
    if (!id) throw new Error(`Demo: no property for "${name}"`);
    return id;
  };
  crew = (name: string): string => {
    const id = this.crews.get(name);
    if (!id) throw new Error(`Demo: no crew "${name}"`);
    return id;
  };
  /** The client and their property, for a row about work there. */
  where = (client: string): Row => ({ client_id: this.client(client), property_id: this.property(client) });

  // --- The business ---------------------------------------------------------------------------

  /** Phone, email and address, and settings merged into what setting up the business saved (the preset's). */
  async details(fields: { phone: string; email: string; address: Omit<DemoPlace, "lat" | "lng" | "label">; depot: { lat: number; lng: number }; settings?: Row }) {
    const { data: current } = await this.db.from("companies").select("settings").eq("id", this.company).single();
    await this.must(
      this.db
        .from("companies")
        .update({
          phone: fields.phone,
          email: fields.email,
          address: fields.address,
          settings: {
            ...((current?.settings as Row | null) ?? {}),
            payment_terms_days: 30,
            default_tax_rate: this.taxRate,
            depot: fields.depot,
            working_hours: { start: "07:00", end: "17:30" },
            ...fields.settings,
          },
        })
        .eq("id", this.company),
      "company details",
    );
  }

  async teamMembers(people: DemoTeammate[]) {
    if (!people.length) return;
    await this.must(this.db.from("memberships").insert(people.map((p) => this.c({ user_id: this.person(p.key), role: p.role, labor_rate: p.rate }))), "team");
  }

  async addCrews(crews: Array<{ name: string; color: string; lead?: string; members?: string[] }>) {
    const rows = await this.must(
      this.db.from("crews").insert(crews.map((cr) => this.c({ name: cr.name, color: cr.color, lead_user_id: cr.lead ? this.person(cr.lead) : null })), DEFAULTS).select("id, name"),
      "crews",
    );
    for (const row of rows as Array<{ id: string; name: string }>) this.crews.set(row.name, row.id);
    const members = crews.flatMap((cr) => (cr.members ?? []).map((key) => this.c({ crew_id: this.crew(cr.name), user_id: this.person(key) })));
    if (members.length) await this.must(this.db.from("crew_members").insert(members), "crew members");
  }

  async addClients(clients: DemoClient[]) {
    const rows = await this.must(
      this.db
        .from("clients")
        .insert(
          clients.map((cl) => this.c({ display_name: cl.name, company_name: cl.company ?? null, email: cl.email, phone: cl.phone, status: cl.status, lead_source: cl.source, tags: cl.tags })),
          DEFAULTS,
        )
        .select("id, display_name"),
      "clients",
    );
    for (const row of rows as Array<{ id: string; display_name: string }>) this.clients.set(row.display_name, row.id);
    const places = await this.must(
      this.db
        .from("properties")
        .insert(clients.map((cl) => this.c({ ...cl.place, label: cl.place.label ?? null, client_id: this.client(cl.name) })), DEFAULTS)
        .select("id, client_id"),
      "properties",
    );
    const byClient = new Map((places as Array<{ id: string; client_id: string }>).map((p) => [p.client_id, p.id]));
    for (const cl of clients) this.properties.set(cl.name, byClient.get(this.client(cl.name))!);
    const access = clients.filter((cl) => cl.access);
    if (access.length) {
      await this.must(this.db.from("property_access").insert(access.map((cl) => this.c({ property_id: this.property(cl.name), gate_code: cl.access!.gate_code ?? null, instructions: cl.access!.instructions }))), "gate codes");
    }
  }

  // --- Price list lines ------------------------------------------------------------------------

  private async loadServices() {
    if (!this.services.length) {
      this.services = (await this.must(this.db.from("services").select("id, name, unit, unit_price, formula").eq("company_id", this.company).order("sort"), "services")) as typeof this.services;
    }
    return this.services;
  }

  /** The business's price list, in order (a business made from a trade preset starts with the preset's). */
  async priceList() {
    return this.loadServices();
  }

  /** A quote line for one of the price list's items, by its exact name. */
  async line(name: string, quantity: number, extra: Row = {}): Promise<Row> {
    const s = (await this.loadServices()).find((x) => x.name === name);
    if (!s) throw new Error(`Demo: the price list has no "${name}"`);
    return { service_id: s.id, name: s.name, unit: s.unit, unit_price: s.unit_price, quantity, formula: s.formula, ...extra };
  }

  /** The same, for a job (job lines don't keep formulas). */
  async jobLine(name: string, quantity: number): Promise<Row> {
    const { formula: _formula, ...line } = await this.line(name, quantity);
    return line;
  }

  // --- Requests, quotes and jobs ---------------------------------------------------------------

  async requests(rows: Array<{ client: string; source: string; title: string; details: string; answers?: Row; status?: string }>) {
    const made = await this.must(
      this.db.from("requests").insert(rows.map(({ client, ...r }) => this.c({ ...this.where(client), ...r })), DEFAULTS).select("id, title"),
      "requests",
    );
    return new Map((made as Array<{ id: string; title: string }>).map((r) => [r.title, r.id]));
  }

  async quote(client: string, title: string, status: "draft" | "sent" | "approved", lines: Row[], extra: Row = {}): Promise<string> {
    // An approved quote's lines are locked, so they go in while it's still sent.
    const approved = status === "approved";
    const q = (await this.must(
      this.db.from("quotes").insert(this.c({ ...this.where(client), title, status: approved ? "sent" : status, tax_rate: this.taxRate, ...(approved ? {} : extra) })).select("id").single(),
      `quote ${title}`,
    )) as { id: string };
    await this.must(this.db.from("quote_line_items").insert(lines.map((l, i) => this.c({ ...l, quote_id: q.id, sort: i })), DEFAULTS), `lines ${title}`);
    if (approved) await this.must(this.db.from("quotes").update({ status, ...extra }).eq("id", q.id), `approve ${title}`);
    return q.id;
  }

  /** An approved quote made into its job, as Convert to job does. */
  async convert(quoteId: string, details: Row = {}): Promise<string> {
    const jobId = (await this.must(this.db.rpc("convert_quote_to_job", { p_quote: quoteId }), "convert quote")) as string;
    if (Object.keys(details).length) await this.must(this.db.from("jobs").update(details).eq("id", jobId), "job details");
    return jobId;
  }

  async job(client: string, title: string, lines: Row[], extra: Row = {}): Promise<string> {
    const [row] = (await this.must(this.db.from("jobs").insert(this.c({ ...this.where(client), title, ...extra })).select("id"), `job ${title}`)) as Array<{ id: string }>;
    if (lines.length) await this.must(this.db.from("job_line_items").insert(lines.map((l) => this.c({ job_id: row!.id, ...l }))), `lines ${title}`);
    return row!.id;
  }

  /**
   * A recurring job, with its visits for the year made as the nightly task makes them (only those;
   * the business hears nothing about them, as for any recurring job's run of visits).
   */
  async recurring(client: string, title: string, lines: Row[], schedule: { rule: string; startsOn?: string; months?: number[]; minutes: number; start?: string; crew: string; billing?: string }): Promise<string> {
    const id = await this.job(client, title, lines, {
      kind: "recurring",
      recurrence_rule: schedule.rule,
      starts_on: schedule.startsOn ?? this.day(0),
      active_months: schedule.months ?? null,
      visit_duration_min: schedule.minutes,
      visit_start_time: schedule.start ?? null,
      default_crew_id: this.crew(schedule.crew),
      billing_mode: schedule.billing ?? "per_visit",
    });
    const row = await recurringJob(this.admin as unknown as Db, id);
    if (row) await materializeJob(this.admin as unknown as Db, row);
    return id;
  }

  /** Visits on the schedule; clients aren't told about them (they're made up), as in the seed script. */
  async visits(rows: Array<Row & { title: string }>) {
    // Under way only once it has started: a visitor at 5am sees today's first job still to come.
    const now = Date.now();
    const started = (r: Row) => r.status !== "in_progress" || Date.parse(String(r.starts_at)) <= now;
    const made = (await this.must(
      this.db.from("visits").insert(rows.map((r) => this.c(started(r) ? r : { ...r, status: "scheduled" })), DEFAULTS).select("id, title"),
      "visits",
    )) as Array<{ id: string; title: string }>;
    for (const v of made) await this.must(this.admin.rpc("call_off_visit_notice", { p_visit: v.id }), "no booked message");
    return new Map(made.map((v) => [v.title, v.id]));
  }

  async assign(visitIds: string[], people: string[]) {
    await this.must(this.db.from("visit_assignees").insert(visitIds.flatMap((visit_id) => people.map((key) => this.c({ visit_id, user_id: this.person(key) })))), "assignees");
  }

  // --- Money -----------------------------------------------------------------------------------

  /**
   * A job's invoice, sent on `issued` days from today: all of it, a progress bill (`amount`), or its
   * finished visits not billed yet (`visits`: a storm's pushes at their price by depth).
   */
  async invoice(jobId: string, fields: { amount?: number; visits?: boolean; issued?: number; dueIn?: number; status?: string } = {}): Promise<string> {
    const args = fields.visits ? { p_job: jobId, p_kind: "visits" } : fields.amount == null ? { p_job: jobId } : { p_job: jobId, p_kind: "progress", p_amount: fields.amount };
    const id = (await this.must(this.db.rpc("create_invoice_for_job", args), "invoice")) as string;
    const issued = fields.issued ?? 0;
    await this.must(this.db.from("invoices").update({ status: fields.status ?? "sent", issued_on: this.day(issued), due_on: this.day(issued + (fields.dueIn ?? 30)) }).eq("id", id), "send invoice");
    return id;
  }

  async payment(invoiceId: string, client: string, amount: number, method: string, fields: { daysAgo?: number; notes?: string } = {}) {
    await this.must(
      this.db.from("payments").insert(this.c({ invoice_id: invoiceId, client_id: this.client(client), amount, method, ...(fields.daysAgo == null ? {} : { received_at: this.ago(fields.daysAgo) }), notes: fields.notes ?? null })),
      "payment",
    );
  }

  /** Done, billed and paid in full `ago` days back. */
  async paidJob(client: string, title: string, lines: Row[], ago: number, method: string, crew: string, notes?: string): Promise<string> {
    const id = await this.job(client, title, lines, { status: "requires_invoicing", default_crew_id: this.crew(crew) });
    await this.visits([{ job_id: id, property_id: this.property(client), title, starts_at: this.at(-ago, "08:00"), ends_at: this.at(-ago, "12:00"), crew_id: this.crew(crew), status: "completed" }]);
    const invoice = await this.invoice(id, { issued: 1 - ago });
    const { total } = (await this.must(this.db.from("invoices").select("total").eq("id", invoice).single(), `total ${title}`)) as { total: number };
    await this.payment(invoice, client, Number(total), method, { daysAgo: Math.max(ago - 5, 0), notes });
    return id;
  }

  async promoCodes(rows: Row[]) {
    await this.must(this.db.from("promo_codes").upsert(rows.map(this.c), { onConflict: "company_id,code", ignoreDuplicates: true, defaultToNull: false }), "promo codes");
  }

  // --- Equipment -------------------------------------------------------------------------------

  async equipment(rows: Array<Row & { name: string; crew?: string }>) {
    const made = (await this.must(
      this.db.from("equipment").insert(rows.map(({ crew, ...r }) => this.c({ ...r, crew_id: crew ? this.crew(crew) : null })), DEFAULTS).select("id, name"),
      "equipment",
    )) as Array<{ id: string; name: string }>;
    return new Map(made.map((e) => [e.name, e.id]));
  }

  /** Maintenance schedules; returns their ids in order. */
  async maintenance(rows: Row[]) {
    return ((await this.must(this.db.from("equipment_plans").insert(rows.map(this.c), DEFAULTS).select("id"), "maintenance schedules")) as Array<{ id: string }>).map((r) => r.id);
  }

  async equipmentHistory(rows: Array<Row & { by?: string }>) {
    await this.must(this.db.from("equipment_logs").insert(rows.map(({ by, ...r }) => this.c({ ...r, user_id: by ? this.person(by) : null })), DEFAULTS), "equipment history");
  }

  // --- Guides, time, marketing -----------------------------------------------------------------

  /** Guides (SOPs) under the preset's categories, by name; one not there goes under none. */
  async guides(rows: Array<{ category: string; title: string; html: string; required?: boolean; tags?: string[] }>) {
    const cats = (await this.must(this.db.from("sop_categories").select("id, name").eq("company_id", this.company), "categories")) as Array<{ id: string; name: string }>;
    await this.must(
      this.db.from("sop_pages").insert(
        rows.map((g) =>
          this.c({
            category_id: cats.find((x) => x.name === g.category)?.id ?? null,
            title: g.title,
            body_html: g.html,
            body_text: g.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
            required: g.required ?? false,
            tags: g.tags ?? [],
          }),
        ),
        DEFAULTS,
      ),
      "guides",
    );
  }

  /** Time on the clock: the crew's own, so written with the server's key. Approved unless it's today's. */
  async time(rows: Array<{ who: string; day: number; from: string; to: string | null; rate: number; job?: string; visit?: string; category?: string; notes?: string }>) {
    // Someone still on the clock today only once their day has started.
    const now = Date.now();
    const kept = rows.filter((t) => Date.parse(this.at(t.day, t.from)) <= now && (!t.to || Date.parse(this.at(t.day, t.to)) <= now));
    if (!kept.length) return;
    await this.must(
      this.admin.from("time_entries").insert(
        kept.map((t) => ({
          company_id: this.company,
          user_id: this.person(t.who),
          started_at: this.at(t.day, t.from),
          ended_at: t.to && this.at(t.day, t.to),
          job_id: t.job ?? null,
          visit_id: t.visit ?? null,
          category: t.category ?? undefined,
          notes: t.notes ?? null,
          ...(t.day < 0 ? { approved_by: this.ownerId, approved_at: this.ago(1), labor_rate: t.rate } : {}),
        })),
        DEFAULTS,
      ),
      "time entries",
    );
  }

  /** A campaign sent `daysAgo` to these clients (recorded as the server records one). */
  async sentCampaign(fields: { name: string; subject: string; body: string; daysAgo: number; to: string[] }) {
    const [campaign] = (await this.must(
      this.admin
        .from("campaigns")
        .insert({
          company_id: this.company,
          name: fields.name,
          subject: fields.subject,
          audience: { statuses: ["active"] },
          status: "sent",
          body: fields.body,
          started_at: this.ago(fields.daysAgo),
          finished_at: this.ago(fields.daysAgo),
          recipients_count: fields.to.length,
          sent_count: fields.to.length,
          created_by: this.ownerId,
        })
        .select("id"),
      "campaign",
    )) as Array<{ id: string }>;
    const emails = (await this.must(this.db.from("clients").select("id, display_name, email").eq("company_id", this.company), "client emails")) as Array<{ id: string; display_name: string; email: string | null }>;
    await this.must(
      this.admin.from("campaign_recipients").insert(
        fields.to.map((name) => {
          const cl = emails.find((e) => e.display_name === name)!;
          return { company_id: this.company, campaign_id: campaign!.id, client_id: cl.id, email: cl.email, name, status: "sent", sent_at: this.ago(fields.daysAgo) };
        }),
      ),
      "campaign recipients",
    );
  }

  /** Review asks after finished jobs (`clicked` days ago, or not yet). */
  async reviewAsks(rows: Array<{ client: string; job: string; sent: number; clicked?: number }>) {
    await this.must(
      this.admin.from("review_requests").insert(
        rows.map((r) => ({
          company_id: this.company,
          client_id: this.client(r.client),
          job_id: r.job,
          status: r.clicked == null ? "sent" : "clicked",
          sent_at: this.ago(r.sent),
          clicked_at: r.clicked == null ? null : this.ago(r.clicked),
          created_by: this.ownerId,
          // Each ask's short link token is made here: the column's default is for the database's own use.
          link_token: crypto.randomUUID().replaceAll("-", "").slice(0, 12),
        })),
      ),
      "review requests",
    );
  }

  async referral(referrer: string, referred: string, requestId: string | null) {
    await this.must(
      this.admin.from("referrals").insert({ company_id: this.company, referrer_client_id: this.client(referrer), referred_client_id: this.client(referred), request_id: requestId, referred_name: referred }),
      "referral",
    );
  }

  /** Installs one of the built-in trade apps, as Apps does (its client messages come with it). */
  async installApp(app: "snow" | "paving" | "roofing") {
    await this.must(this.db.rpc("trade_app_set_enabled", { p_company: this.company, p_app: app, p_enabled: true }), `install ${app}`);
  }

  /**
   * Snow customers, as the Snow page makes them: each one of the business's jobs (the season's
   * contract), with the snow that sends the plow out, salting, extra pushes, how early it's
   * cleared, its priority and a storm's price by depth (empty: each push bills the job's lines).
   */
  async snowSites(rows: Array<{ job: string; trigger: number; salt?: number; repeat?: number; clearBy?: string; priority: 1 | 2 | 3; tiers: Array<{ up_to_in: number | null; price: number }>; tellClient?: boolean }>) {
    await this.must(
      this.db.from("snow_sites").insert(
        rows.map((r) => this.c({
          job_id: r.job,
          trigger_in: r.trigger,
          salt_trigger_in: r.salt ?? null,
          repeat_in: r.repeat ?? null,
          clear_by: r.clearBy ?? null,
          priority: r.priority,
          tiers: r.tiers,
          tell_client: r.tellClient ?? false,
        })),
      ),
      "snow customers",
    );
  }

  /**
   * A storm `daysAgo` that's been and gone: in the storm log with what was forecast and what fell,
   * and its pushes done, priced by depth as the Snow page prices them (setting what fell does it).
   */
  async pastStorm(daysAgo: number, forecast: number, fell: number, sites: Array<{ job: string; client: string; title: string; pushes: number; crew: string }>) {
    const date = this.day(-daysAgo);
    await this.must(
      this.db.from("snow_events").insert(sites.map((site) => this.c({ job_id: site.job, snow_date: date, kind: "plow", forecast_in: forecast, pushes: site.pushes }))),
      "storm log",
    );
    for (const site of sites) {
      const pushes = Array.from({ length: site.pushes }, (_, i) => this.c({
        job_id: site.job,
        property_id: this.property(site.client),
        title: site.pushes > 1 ? `${site.title} (push ${i + 1} of ${site.pushes})` : site.title,
        scheduled_on: date,
        crew_id: this.crew(site.crew),
        status: "completed",
      }));
      const made = (await this.must(this.db.from("visits").insert(pushes, DEFAULTS).select("id"), "storm visits")) as Array<{ id: string }>;
      await this.must(this.db.from("snow_visits").insert(made.map((v) => this.c({ visit_id: v.id, job_id: site.job, snow_date: date }))), "storm's visits");
      await this.must(this.db.from("snow_events").update({ actual_in: fell }).eq("job_id", site.job).eq("snow_date", date), "what fell");
    }
  }

  /** A storm coming `inDays` (the forecast's inches), scheduled from the Snow page as the office would. */
  async scheduleStorm(inDays: number, plan: Array<{ job: string; inches: number; pushes: number }>) {
    await this.must(
      this.db.rpc("snow_schedule", { p_company: this.company, p_date: this.day(inDays), p_plan: plan.map((p) => ({ job_id: p.job, inches: p.inches, pushes: p.pushes, kind: "plow" })) }),
      "storm scheduled",
    );
  }

  /**
   * A drawing on the measuring map, saved as Measure saves it (routes/sales.ts): the totals come
   * from the shapes. A roof's `pitch` gives its squares.
   */
  async measurement(fields: { title: string; client: string; quote?: string; center: [number, number]; zoom: number; features: FeatureCollection["features"]; pitch?: string; wastePct?: number }) {
    const geojson: FeatureCollection = { type: "FeatureCollection", features: fields.features };
    const summary = summarizeFeatureCollection(geojson, { pitch: fields.pitch });
    const squares = drawingSquares(summary, fields.pitch, fields.wastePct ?? 0);
    await this.must(
      this.db.from("measurements").insert(
        this.c({
          title: fields.title,
          quote_id: fields.quote ?? null,
          property_id: this.property(fields.client),
          provider: "naip",
          geojson,
          view: { center: fields.center, zoom: fields.zoom, mode: "auto" },
          roof_pitch: fields.pitch ? normalizePitch(fields.pitch) : null,
          waste_pct: fields.wastePct ?? 0,
          sections: summary.sections,
          total_area_sqft: summary.total_area_sqft,
          total_area_sqyd: summary.total_area_sqyd,
          total_length_ft: summary.total_length_ft,
          roofing_squares: squares === null ? null : Math.round(squares * 100) / 100,
        }),
      ),
      "measurement",
    );
  }
}
