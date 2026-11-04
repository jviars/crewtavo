/**
 * Settings → Your data → Coming from Jobber (features/settings/importJobber.ts): which of Jobber's
 * exports each chosen file is, past any title lines above its headers. The reading and matching
 * themselves are core's (packages/core/test/jobberImport.test.ts).
 */
import { describe, expect, it } from "vitest";
import { readFile } from "../src/features/settings/importJobber";

const file = (name: string, text: string) => new File([text], name, { type: "text/csv" });

describe("choosing Jobber's exports", () => {
  it("knows each file, even with a title line above the headers", async () => {
    const quotes = await readFile(file("quotes.csv", "Quotes report\nQuote #,Client name,Status\n101,Mary Smith,Draft\n"));
    expect(quotes).toMatchObject({ kind: "quotes", rows: [["Quote #", "Client name", "Status"], ["101", "Mary Smith", "Draft"]] });
    expect((await readFile(file("visits.csv", "Job #,Date,Visit completed\nJ1,2026-11-03,No\n"))).kind).toBe("visits");
    expect((await readFile(file("clients.csv", "J-ID,Display Name,E-mails\n1,Mary,m@x.test\n"))).kind).toBe("clients");
    expect((await readFile(file("other.csv", "Name,Price\nMowing,45\n"))).kind).toBeNull();
  });
});
