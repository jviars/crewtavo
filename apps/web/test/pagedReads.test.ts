/**
 * Reads of more rows than the database sends at once, checked in the source itself. The database
 * sends 1,000 rows a request at most, and without a set order may send a row on two pages and leave
 * another out, so pages are read in one place (lib/paging.ts), which always sorts them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
const files = sources(SRC).map((file) => ({ name: relative(SRC, file).replaceAll("\\", "/"), code: readFileSync(file, "utf8") }));

describe("reading a page at a time", () => {
  it("is done by lib/paging.ts alone, so no screen pages without an order", () => {
    const paging = files.filter((f) => /\.range\(/.test(f.code)).map((f) => f.name);
    expect(paging).toEqual(["lib/paging.ts"]);
    // And it's used: the reports, the lists, the imports and the download of everything.
    const readers = files.filter((f) => /\b(everyRow|firstRows)\(/.test(f.code) && f.name !== "lib/paging.ts").map((f) => f.name);
    expect(readers).toEqual(expect.arrayContaining(["features/clients/importClients.ts", "features/finance/FinancePage.tsx", "features/metrics/MetricsPage.tsx", "features/settings/exportData.ts", "features/settings/importJobber.ts", "features/timesheets/weekData.ts"]));
  });
});
