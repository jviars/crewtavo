/**
 * QuickBooks Online and Zoho Books are marked Beta in Apps: the sync works but hasn't been proven
 * against every kind of account, and their pages say to check the first few invoices in the books.
 */
import { describe, expect, it } from "vitest";
import { APP_INFO } from "../src/features/apps/catalog";

describe("apps marked Beta", () => {
  it("are the two accounting apps, and no others", () => {
    expect(Object.keys(APP_INFO).filter((id) => APP_INFO[id]!.beta).sort()).toEqual(["quickbooks", "zoho_books"]);
  });

  it.each([
    ["quickbooks", "QuickBooks"],
    ["zoho_books", "Zoho Books"],
  ])("%s says in one sentence what isn't proven and what to check", (id, books) => {
    const said = APP_INFO[id]!.beta!;
    expect(said).toContain("hasn't been proven against every kind of");
    expect(said).toContain(`check the first few invoices in ${books}`);
    // One sentence: its only full stop is the last character.
    expect(said.indexOf(".")).toBe(said.length - 1);
  });
});
