import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { COUNTRY_CODES } from "@crewtavo/core/countries";
import { describe, expect, it } from "vitest";

/** The database's list of countries (companies_country_code) and core's are the same, in the same order. */
describe("a business's country", () => {
  it("is one of the codes the database takes, the same list as core COUNTRY_CODES", () => {
    const sql = readFileSync(fileURLToPath(new URL("../../../supabase/migrations/20261124100100_business_country.sql", import.meta.url)), "utf8");
    const from = sql.indexOf("companies_country_code");
    const check = sql.slice(from, sql.indexOf("));", from));
    expect([...check.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1])).toEqual([...COUNTRY_CODES]);
  });
});
