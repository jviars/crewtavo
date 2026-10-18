import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

// The browser reads time entries as the signed-in person, who can't read the pay rate on them
// (supabase/migrations/20261018000700_time_entry_pay_privacy.sql): asking for it, or for every
// column, fails with "permission denied". Screens get rates from the API (POST /api/time/rates).
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));

describe("time entries", () => {
  it("are read without their pay rate", () => {
    const reads = sources(SRC).flatMap((file) => {
      const code = readFileSync(file, "utf8");
      return [...code.matchAll(/from\("time_entries"\)\s*\.select\(\s*"([^"]*)"/g), ...code.matchAll(/time_entries\(([^)]*)\)/g)].map((m) => ({ file, columns: m[1]! }));
    });
    expect(reads.length).toBeGreaterThanOrEqual(8);
    for (const { file, columns } of reads) expect(columns, file).not.toMatch(/labor_rate|(^|,)\s*\*/);
  });
});
