import { taxPercent, taxRateFromPercent } from "@crewtavo/core/money";
import { describe, expect, it } from "vitest";
import { readAmount } from "../src/components/ui/MoneyInput";
import { formatTaxRate } from "../src/lib/format";

// The Tax rate field on quotes and invoices: what's typed is read, saved as a fraction, and shown
// back in the field and next to the tax once the quote or invoice is sent.
describe("tax rates on quotes and invoices", () => {
  const field = (typed: string) => readAmount(typed, { percent: true, max: 99.99 });

  it("accepts New York City's 8.875% and shows it back as 8.875%", () => {
    expect(field("8.875")).toBe(8.875); // was rounded to 8.88
    expect(taxRateFromPercent(field("8.875"))).toBe(0.08875);
    // PostgREST sends numeric(8, 6) as 0.088750.
    expect(String(taxPercent(0.08875))).toBe("8.875");
    expect(formatTaxRate(0.08875)).toBe("8.875%");
    expect(formatTaxRate("0.088750")).toBe("8.875%");
  });

  it("keeps a rate to 0.0001%", () => {
    expect(field("7.375")).toBe(7.375);
    expect(field("8.8755")).toBe(8.8755);
    expect(field("8.87555")).toBe(8.8756);
    expect(formatTaxRate(0.088755)).toBe("8.8755%");
    expect(formatTaxRate(0.0825)).toBe("8.25%");
    expect(formatTaxRate(0.1)).toBe("10.00%");
    expect(formatTaxRate(0)).toBe("0.00%");
  });

  it("still turns away what isn't a rate", () => {
    expect(field("")).toBeNull();
    expect(field(".")).toBeNull();
    expect(field("1.2.3")).toBeNull();
    expect(field("100")).toBeNull();
  });

  it("reads dollars to the cent as written", () => {
    expect(readAmount("12.5")).toBe(12.5);
    expect(readAmount("1.005")).toBe(1.01); // floats make it 1.00
    expect(readAmount("8.875")).toBe(8.88);
    expect(readAmount("60", { max: 50 })).toBeNull();
  });
});
