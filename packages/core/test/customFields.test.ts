import { describe, expect, it } from "vitest";
import { checkCustomValue, customFieldKey, customValueDraft, customValueText, fieldForHeader, mergeCustomValues, saveCustomDrafts, shownCustomFields, type CustomFieldDef } from "../src/customFields";

const gate: CustomFieldDef = { key: "gate_code", label: "Gate code", type: "text", show_on_pdf: false, show_in_portal: false, sort: 0 };
const volume: CustomFieldDef = { key: "pool_volume", label: "Pool volume", type: "number", show_on_pdf: true, show_in_portal: false, sort: 2 };
const permit: CustomFieldDef = { key: "permit_date", label: "Permit date", type: "date", show_on_pdf: false, show_in_portal: true, sort: 1 };
const unit: CustomFieldDef = { key: "unit", label: "Unit", type: "choice", choices: ["Heat pump", "Furnace"], show_on_pdf: true, show_in_portal: true, sort: 3 };
const pets: CustomFieldDef = { key: "pets", label: "Pets on site", type: "yes_no", sort: 4 };
const old: CustomFieldDef = { key: "old", label: "Old field", type: "text", archived_at: "2026-11-01T00:00:00Z", show_on_pdf: true, show_in_portal: true, sort: 5 };
const fields = [gate, volume, permit, unit, pets, old];

describe("custom field keys", () => {
  it("come from the label, and never repeat one taken or the import's source_id", () => {
    expect(customFieldKey("Gate code", [])).toBe("gate_code");
    expect(customFieldKey("  HVAC unit / model #  ", [])).toBe("hvac_unit_model");
    expect(customFieldKey("Gate code", ["gate_code", "gate_code_2"])).toBe("gate_code_3");
    expect(customFieldKey("Source ID", [])).toBe("source_id_2");
    expect(customFieldKey("2nd gate", [])).toBe("f_2nd_gate");
    expect(customFieldKey("¿?", [])).toBe("field");
  });
});

describe("checking a value against its type", () => {
  it("keeps text trimmed, and clears an empty one", () => {
    expect(checkCustomValue(gate, " 4821# ")).toEqual({ value: "4821#" });
    expect(checkCustomValue(gate, "  ")).toEqual({ value: null });
    expect(checkCustomValue(gate, null)).toEqual({ value: null });
    expect(checkCustomValue(gate, "x".repeat(1001))).toHaveProperty("error");
    expect(checkCustomValue(gate, { a: 1 })).toHaveProperty("error");
  });
  it("reads numbers as people write them", () => {
    expect(checkCustomValue(volume, "12,500")).toEqual({ value: 12500 });
    expect(checkCustomValue(volume, 3.5)).toEqual({ value: 3.5 });
    expect(checkCustomValue(volume, "lots")).toEqual({ error: "Pool volume needs a number." });
  });
  it("takes real days, written either way", () => {
    expect(checkCustomValue(permit, "2026-03-04")).toEqual({ value: "2026-03-04" });
    expect(checkCustomValue(permit, "3/4/2026")).toEqual({ value: "2026-03-04" });
    expect(checkCustomValue(permit, "2026-02-30")).toHaveProperty("error");
  });
  it("takes one of a choice field's choices, in any case", () => {
    expect(checkCustomValue(unit, "heat PUMP")).toEqual({ value: "Heat pump" });
    expect(checkCustomValue(unit, "Boiler")).toEqual({ error: "Unit is one of: Heat pump, Furnace." });
  });
  it("reads yes and no", () => {
    expect(checkCustomValue(pets, true)).toEqual({ value: true });
    expect(checkCustomValue(pets, "Yes")).toEqual({ value: true });
    expect(checkCustomValue(pets, "no")).toEqual({ value: false });
    expect(checkCustomValue(pets, "maybe")).toHaveProperty("error");
  });
});

describe("changing a record's values", () => {
  it("sets and clears only the fields given, keeping source_id and archived fields' values", () => {
    const current = { source_id: "J-12", old: "kept", gate_code: "1234", pets: true };
    expect(mergeCustomValues(fields, current, { gate_code: "", pool_volume: "9000", pets: "no" })).toEqual({
      values: { source_id: "J-12", old: "kept", pool_volume: 9000, pets: false },
      errors: [],
    });
  });
  it("changes nothing when a value doesn't fit, or isn't a field in use", () => {
    const current = { gate_code: "1234" };
    const result = mergeCustomValues(fields, current, { gate_code: "9", pool_volume: "lots", old: "new", source_id: "J-9" });
    expect(result.values).toEqual(current);
    expect(result.errors).toEqual(["Pool volume needs a number.", 'There\'s no custom field "old".', 'There\'s no custom field "source_id".']);
  });
  it("from a form, checks only what it changed", () => {
    const current = { unit: "Boiler", gate_code: "1" };
    expect(saveCustomDrafts(fields, current, { unit: "Boiler", gate_code: "2" })).toEqual({ values: { unit: "Boiler", gate_code: "2" }, errors: [] });
    expect(saveCustomDrafts(fields, current, { pets: "yes" }).values).toEqual({ unit: "Boiler", gate_code: "1", pets: true });
  });
  it("treats anything but an object as no values", () => {
    expect(mergeCustomValues(fields, ["x"], { gate_code: "1" }).values).toEqual({ gate_code: "1" });
  });
});

describe("showing values", () => {
  const values = { gate_code: "4821", pool_volume: 12500, permit_date: "2026-03-04", unit: "Furnace", pets: false, old: "gone", source_id: "J-1" };
  it("reads each type the way people say it", () => {
    expect(customValueText(volume, 12500.25)).toBe("12,500.25");
    expect(customValueText(permit, "2026-03-04")).toBe("Mar 4, 2026");
    expect(customValueText(pets, false)).toBe("No");
    expect(customValueText(volume, "9 gal")).toBe("9 gal");
  });
  it("on the record: every field in use with a value, in order, never source_id or an archived one", () => {
    expect(shownCustomFields(fields, values).map((f) => `${f.label}: ${f.text}`)).toEqual(["Gate code: 4821", "Permit date: Mar 4, 2026", "Pool volume: 12,500", "Unit: Furnace", "Pets on site: No"]);
  });
  it("on the PDF and the Client Hub: only the fields marked for each", () => {
    expect(shownCustomFields(fields, values, "pdf").map((f) => f.key)).toEqual(["pool_volume", "unit"]);
    expect(shownCustomFields(fields, values, "portal").map((f) => f.key)).toEqual(["permit_date", "unit"]);
  });
  it("leaves empty ones out", () => {
    expect(shownCustomFields(fields, { gate_code: "  ", unit: "" })).toEqual([]);
    expect(shownCustomFields(fields, null)).toEqual([]);
  });
  it("edits every type as text", () => {
    expect(customValueDraft(volume, 12500)).toBe("12500");
    expect(customValueDraft(pets, true)).toBe("yes");
    expect(customValueDraft(pets, undefined)).toBe("");
  });
});

describe("spreadsheet columns", () => {
  it("fill the field whose label is the header, in any case, never an archived one", () => {
    expect(fieldForHeader(fields, " gate CODE ")).toBe(gate);
    expect(fieldForHeader(fields, "Old field")).toBeUndefined();
    expect(fieldForHeader(fields, "Lot size")).toBeUndefined();
  });
});
