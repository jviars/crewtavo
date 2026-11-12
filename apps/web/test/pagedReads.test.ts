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

  it("sorts each table by a column it has: its id, or the key the read names", () => {
    // The tables' columns, from the types made from the migrations.
    const types = readFileSync(fileURLToPath(new URL("../../../packages/core/src/database.types.ts", import.meta.url)), "utf8");
    const columns = (table: string) => new RegExp(`"${table}": \\{\\n\\s+Row: \\{\\n(.*)\\n`).exec(types)?.[1] ?? null;
    const reads = files.flatMap((f) =>
      [...f.code.matchAll(/\b(?:everyRow|firstRows)\(/g)].flatMap((call) => {
        // This read's own text, its query and options: up to the bracket that closes it.
        let [end, open] = [call.index + call[0].length, 1];
        for (; open > 0 && end < f.code.length; end++) open += f.code[end] === "(" ? 1 : f.code[end] === ")" ? -1 : 0;
        const text = f.code.slice(call.index, end);
        const table = /\.from\("([a-z_]+)"\)/.exec(text)?.[1];
        return table ? [{ where: `${f.name}: ${table}`, table, keyed: /\bkey:/.test(text) }] : [];
      }),
    );
    expect(reads.length).toBeGreaterThanOrEqual(60);
    for (const read of reads) {
      const row = columns(read.table);
      expect(row, read.where).not.toBeNull();
      if (!read.keyed) expect(row, `${read.where} has no id: name its key`).toContain('"id": ');
    }
    // The ones without an id that are read today, each by the columns that tell its rows apart.
    expect(reads.filter((r) => r.keyed).map((r) => r.table).sort()).toEqual(["crew_members", "equipment_due", "sub_paperwork", "visit_assets", "visit_assignees"]);
  });
});

describe("asking for more than 1,000 rows in one request", () => {
  // Reads that still ask for more than the database sends, and so stop at 1,000 without saying:
  // each wants lib/paging.ts. The list is here so that it only gets shorter.
  const KNOWN: string[] = [];

  it("isn't written anywhere new", () => {
    const asking = files.filter((f) => [...f.code.matchAll(/\.limit\(([\d_]+)/g)].some((m) => Number(m[1]!.replaceAll("_", "")) > 1000)).map((f) => f.name);
    expect(asking.filter((name) => !KNOWN.includes(name))).toEqual([]);
  });
});
