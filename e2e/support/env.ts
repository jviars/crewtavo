/** Settings for the browser tests: .dev.vars (what the local API uses), overridden by the environment. */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../../.dev.vars", import.meta.url));
const vars: Record<string, string> = existsSync(file)
  ? Object.fromEntries(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
    )
  : {};

const read = (name: string) => process.env[name] || vars[name] || "";

export const SUPABASE_URL = read("SUPABASE_URL");
export const SUPABASE_KEY = read("SUPABASE_PUBLISHABLE_KEY") || read("SUPABASE_ANON_KEY");
export const SUPABASE_SECRET = read("SUPABASE_SECRET_KEY") || read("SUPABASE_SERVICE_ROLE_KEY");

/** The demo accounts from scripts/seed-demo.mjs. */
export const PASSWORD = process.env.CREWTAVO_DEMO_PASSWORD ?? "crewtavo-demo";
export const PEOPLE = {
  owner: { email: "demo@crewtavo.test", name: "Dana Hale" },
  foreman: { email: "marcus@crewtavo.test", name: "Marcus Hale" },
  employee: { email: "luis@crewtavo.test", name: "Luis Ortega" },
} as const;
export type Person = keyof typeof PEOPLE;

/** Signed-in browser state for each person, written by auth.setup.ts. */
export const authFile = (who: Person) => fileURLToPath(new URL(`../.auth/${who}.json`, import.meta.url));

/** Every client the tests create is named like this, so teardown can find and remove them. */
export const TEST_PREFIX = "PW Test";
