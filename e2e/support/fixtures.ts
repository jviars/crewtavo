/**
 * Shared pieces for the browser tests:
 *   - `as(person, options)`: a page signed in as a demo account (states saved by auth.setup.ts)
 *   - `data`: the demo company, reached as its owner through Supabase (RLS applies), for setting
 *     up what a test needs without clicking through unrelated screens
 *   - `expectAccessible(page)`: an axe-core scan of the current screen (WCAG 2.1 A and AA)
 */
import AxeBuilder from "@axe-core/playwright";
import { test as base, devices, expect, type BrowserContextOptions, type Page } from "@playwright/test";
import type { Database } from "@crewtavo/core/database";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authFile, PASSWORD, PEOPLE, SUPABASE_KEY, SUPABASE_URL, TEST_PREFIX, type Person } from "./env";

export { expect };

/** A phone-sized touch screen (Pixel 7: 412 × 839) for crew screens. */
export const PHONE: BrowserContextOptions = (({ defaultBrowserType: _, ...options }) => options)(devices["Pixel 7"]);

type Db = SupabaseClient<Database>;

export interface Company {
  db: Db;
  id: string;
  timezone: string;
  userId: (who: Person) => Promise<string>;
  crew: (name: string) => Promise<string>;
}

async function signIn(who: Person): Promise<{ db: Db; userId: string }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("No Supabase settings: run `npx supabase start` and fill in .dev.vars (see e2e/README.md).");
  const db = createClient<Database>(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signInWithPassword({ email: PEOPLE[who].email, password: PASSWORD });
  if (error) throw new Error(`Couldn't sign in as ${PEOPLE[who].email} (${error.message}). Run npm run seed:demo first.`);
  return { db, userId: data.user.id };
}

let company: Promise<Company> | undefined;
function demoCompany(): Promise<Company> {
  company ??= (async () => {
    const { db, userId } = await signIn("owner");
    const { data, error } = await db.from("memberships").select("company:companies(id, timezone)").eq("user_id", userId).eq("role", "owner").limit(1).single();
    if (error || !data) throw new Error("The demo owner has no company. Run npm run seed:demo.");
    const { id, timezone } = data.company as unknown as { id: string; timezone: string };
    const ids = new Map<string, string>();
    return {
      db,
      id,
      timezone,
      userId: async (who) => {
        if (!ids.has(who)) {
          const profile = await db.from("profiles").select("user_id").eq("email", PEOPLE[who].email).single();
          ids.set(who, must(profile, `profile of ${who}`).user_id);
        }
        return ids.get(who)!;
      },
      crew: async (name) => must(await db.from("crews").select("id").eq("company_id", id).eq("name", name).single(), `crew ${name}`).id,
    };
  })();
  return company;
}

export function must<R extends { data: unknown; error: { message: string } | null }>(result: R, what: string): NonNullable<R["data"]> {
  if (result.error || result.data == null) throw new Error(`${what}: ${result.error?.message ?? "nothing returned"}`);
  return result.data as NonNullable<R["data"]>;
}

/** A name no other test (or earlier run) uses. Teardown removes clients named with TEST_PREFIX. */
export const unique = (what: string) => `${TEST_PREFIX} ${what} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Today's date (YYYY-MM-DD) in a time zone. */
export const dateIn = (timezone: string, offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: timezone });

/** An ISO timestamp for a wall-clock time on a date in a time zone. */
export function zonedIso(date: string, time: string, timezone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const wall = new Date(guess.toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() + (utc.getTime() - wall.getTime())).toISOString();
}

/** A client with a service address, as the office would add one. */
export async function makeClient(co: Company, label: string) {
  const name = unique(label);
  const client = must(await co.db.from("clients").insert({ company_id: co.id, display_name: name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@example.com`, status: "active" }).select("id").single(), "client");
  const property = must(
    await co.db.from("properties").insert({ company_id: co.id, client_id: client.id, line1: "12 Test Lane", city: "Roanoke", region: "VA", postal_code: "24011", lat: 37.27, lng: -79.94 }).select("id").single(),
    "property",
  );
  return { id: client.id as string, name, propertyId: property.id as string };
}

/** An active job with one line item, ready for visits and invoices. */
export async function makeJob(co: Company, label: string, { price = 1250 }: { price?: number } = {}) {
  const client = await makeClient(co, label);
  const crewId = await co.crew("Paving crew");
  const job = must(
    await co.db.from("jobs").insert({ company_id: co.id, client_id: client.id, property_id: client.propertyId, title: `${label} job`, status: "active", default_crew_id: crewId }).select("id, number").single(),
    "job",
  );
  must(await co.db.from("job_line_items").insert({ company_id: co.id, job_id: job.id, name: "Driveway sealcoat", quantity: 1, unit: "job", unit_price: price, taxable: false }).select("id"), "job line");
  return { client, crewId, id: job.id as string, number: job.number as number, title: `${label} job` };
}

type Fixtures = {
  data: Company;
  as: (who: Person, options?: BrowserContextOptions) => Promise<Page>;
};

export const test = base.extend<Fixtures>({
  data: async ({}, use) => use(await demoCompany()),
  as: async ({ browser, contextOptions }, use) => {
    const opened: Array<{ close: () => Promise<void> }> = [];
    await use(async (who, options) => {
      const context = await browser.newContext({ ...contextOptions, ...options, storageState: authFile(who) });
      opened.push(context);
      const page = await context.newPage();
      return page;
    });
    for (const context of opened) await context.close();
  },
});

/** Scan the screen with axe-core and fail on any WCAG 2.1 A or AA violation, listing each one. */
export async function expectAccessible(page: Page, screen: string) {
  // Let entrance animations finish so colors are measured at rest, including a toast that's still
  // fading in or out (endless ones, like skeleton shimmer, never finish and don't count).
  await page.waitForTimeout(400);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getComputedTiming().endTime === Infinity), null, { timeout: 5_000 });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const problems = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
  expect(problems, `Accessibility problems on ${screen}`).toEqual([]);
}
