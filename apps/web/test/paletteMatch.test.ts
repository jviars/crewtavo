/**
 * Search's rows show why they matched (components/shell/paletteMatch.ts): the typed letters in bold,
 * and the keyword words that found a row whose name doesn't hold what was typed.
 */
import { describe, expect, it } from "vitest";
import { keywordHint, marks } from "../src/components/shell/paletteMatch";

describe("the letters that matched", () => {
  it("marks where each typed word first appears, whatever its case", () => {
    expect(marks("Invoices", ["inv"])).toEqual([["Inv", true], ["oices", false]]);
    expect(marks("Remind clients when an invoice is past due", ["inv"])).toEqual([["Remind clients when an ", false], ["inv", true], ["oice is past due", false]]);
  });

  it("joins words that touch and leaves the rest plain", () => {
    expect(marks("New invoice", ["new", "inv"])).toEqual([["New", true], [" ", false], ["inv", true], ["oice", false]]);
    expect(marks("New invoice", ["ne", "ew"])).toEqual([["New", true], [" invoice", false]]);
    expect(marks("Schedule", [])).toEqual([["Schedule", false]]);
    expect(marks("Schedule", ["zz"])).toEqual([["Schedule", false]]);
  });
});

describe("the keyword words that found a row", () => {
  it("are the keyword that matched and the one after it, when the name doesn't hold the word", () => {
    expect(keywordHint("Document style ", "estimate template invoice template letterhead", ["inv"])).toBe("invoice template");
    expect(keywordHint("People ", "team members invite roles", ["inv"])).toBe("invite roles");
    expect(keywordHint("Custom fields ", "jobs quotes invoices", ["inv"])).toBe("invoices");
  });

  it("are nothing when the row's own text holds every word, or nothing hidden matched", () => {
    expect(keywordHint("Invoices ", "billing bills", ["inv"])).toBeUndefined();
    expect(keywordHint("Company ", undefined, ["inv"])).toBeUndefined();
    expect(keywordHint("Company ", "business name", ["inv"])).toBeUndefined();
  });

  it("go by the first word the row doesn't show, and skip addresses", () => {
    expect(keywordHint("Company ", "business name invoice numbering", ["comp", "numb"])).toBe("numbering");
    expect(keywordHint("Agenda ", "Schedule /schedule calendar visits", ["sched"])).toBe("Schedule calendar");
  });

  it("stop at a comma, so a row's own words never run into its section's name", () => {
    expect(keywordHint("Custom fields ", "clients jobs quotes invoices, Quotes and invoices, Settings", ["inv"])).toBe("invoices");
    expect(keywordHint("Price list ", "services prices, Quotes and invoices, Settings", ["inv"])).toBe("invoices");
  });
});
