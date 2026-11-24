/**
 * Numbers typed with a decimal comma (lib/decimal.ts): "12,50" is 12.50 in a number box (NumberInput,
 * MoneyInput, DecimalInput), while a comma before three digits is still a thousands separator, as
 * in the US, so "1,250" is 1250 wherever it was before.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecimalInput, shownText } from "../src/components/ui/DecimalInput";
import { readAmount } from "../src/components/ui/MoneyInput";
import { heardText } from "../src/components/ui/NumberInput";
import { parsePrice, readQuantity } from "../src/features/roofing/visit/price";
import { decimalPoint, typedAmount } from "../src/lib/decimal";

describe("a decimal comma", () => {
  it("is read as a point with one or two digits after it", () => {
    expect(["12,5", "12,50", "0,07", ",5", "-3,5", " 12,5 "].map(decimalPoint)).toEqual(["12.5", "12.50", "0.07", ".5", "-3.5", " 12.5 "]);
    // With dots between the thousands, as in much of Europe.
    expect(["1.250,50", "12.345.678,9"].map(decimalPoint)).toEqual(["1250.50", "12345678.9"]);
  });

  it("stays a thousands separator before three digits, as in the US, and is left out", () => {
    expect(["1,250", "12,500", "1,000,000", "1,250.50", "1,250.5"].map(decimalPoint)).toEqual(["1250", "12500", "1000000", "1250.50", "1250.5"]);
  });

  it("is left out while it waits for its digits, and text without one is as it was", () => {
    expect(decimalPoint("12,")).toBe("12");
    expect(["", "2.", "0.50", "1250", "-", "8.875"].map(decimalPoint)).toEqual(["", "2.", "0.50", "1250", "-", "8.875"]);
  });

  it("is a point in what a money box saves", () => {
    expect(readAmount("12,50")).toBe(12.5);
    expect(readAmount("1,250")).toBe(1250);
    expect(readAmount("1,250.5")).toBe(1250.5);
    expect(readAmount("8,25", { percent: true })).toBe(8.25);
    // Three digits after the comma are thousands, whatever the box: 8875, more than a tax rate can be.
    expect(readAmount("8,875", { percent: true, max: 99.99 })).toBeNull();
    expect(readAmount("12.5")).toBe(12.5);
  });
});

describe("what a number box says it holds", () => {
  const typed = (value: string) => ({ reason: "input-change", event: { target: { value } } as unknown as Event });

  it("passes on what's typed, with a decimal comma read as a point", () => {
    expect(heardText(2, typed("2,5"))).toBe("2.5");
    expect(heardText(1, typed("1,250"))).toBe("1250");
    // As typed, like a native number box: the point waiting for its digits, the zero after it.
    expect(heardText(2, typed("2."))).toBe("2.");
    expect(heardText(0.5, typed("0.50"))).toBe("0.50");
    expect(heardText(12, typed("12,"))).toBe("12");
  });

  it("reads what's pasted where it goes in the box", () => {
    const pasted = (value: string, from: number, to: number, text: string) => ({
      reason: "input-paste",
      event: { target: { value, selectionStart: from, selectionEnd: to }, clipboardData: { getData: () => text } } as unknown as Event,
    });
    expect(heardText(12, pasted("", 0, 0, "12,50"))).toBe("12.50");
    expect(heardText(12, pasted("12", 2, 2, ",5"))).toBe("12.5");
    expect(heardText(1, pasted("99", 0, 2, "1,250"))).toBe("1250");
    // Words around a number: the number Base UI read, as before.
    expect(heardText(12, pasted("", 0, 0, "12 ft"))).toBe("12");
  });

  it("says the number for the arrows and buttons", () => {
    expect(heardText(3, { reason: "increment-press", event: { target: null } as unknown as Event })).toBe("3");
    expect(heardText(null, { reason: "input-clear", event: { target: null } as unknown as Event })).toBe("");
  });
});

describe("a box for an amount or a percent", () => {
  it("shows what's typed while the form keeps the number read from it", () => {
    expect(shownText({ typed: "12,5", read: "12.5" }, "12.5")).toBe("12,5");
    expect(shownText({ typed: "1,250", read: "1250" }, "1250")).toBe("1,250");
  });

  it("shows the form's value when the form set it some other way, or changed what it heard", () => {
    expect(shownText({ typed: "12,5", read: "12.5" }, "")).toBe("");
    expect(shownText({ typed: "12a", read: "12a" }, "12")).toBe("12");
  });

  it("is a text box with everything else it's given", () => {
    const html = renderToStaticMarkup(h(DecimalInput, { className: "input", inputMode: "decimal", value: "12.5", placeholder: "Off", "aria-label": "Amount", onChange: () => {} }));
    for (const attr of ['class="input"', 'inputMode="decimal"', 'value="12.5"', 'placeholder="Off"', 'aria-label="Amount"']) expect(html).toContain(attr);
  });
});

describe("a decimal comma that can't be a thousands separator", () => {
  it("is a decimal point after a lone 0, before other than three digits, or after dots between thousands", () => {
    expect(["0,125", "0,0125", ",125", "1,2345", "1234,567", "1.250,500", "-0,5"].map(decimalPoint)).toEqual(["0.125", "0.0125", ".125", "1.2345", "1234.567", "1250.500", "-0.5"]);
    // As in the US: a comma between one to three digits and three more.
    expect(["1,250", "12,500", "123,456", "1,000,000"].map(decimalPoint)).toEqual(["1250", "12500", "123456", "1000000"]);
  });

  it("leaves out spaces between thousands, as Québec writes them", () => {
    expect(["1 250,50", "1\u00A0250,50", "1\u202F250,5", "12 345 678", "1 250"].map(decimalPoint)).toEqual(["1250.50", "1250.50", "1250.5", "12345678", "1250"]);
    expect(["12 5", "1 25", "2 x 4"].map(decimalPoint)).toEqual(["12 5", "1 25", "2 x 4"]);
    expect(readAmount("1 250,50")).toBe(1250.5);
  });
});

describe("an amount typed with its currency", () => {
  it("is read without the currency, with a decimal comma", () => {
    expect(["£45", "$19,500.50", "R 1 250,50", "R1250", "45 €", "€12,50", "19,500"].map(typedAmount)).toEqual(["45", "19500.50", "1250.50", "1250", "45", "12.50", "19500"]);
  });

  it("is a roof's price on site, as the homeowner signs it", () => {
    expect(parsePrice("12,50")).toBe(12.5);
    expect(parsePrice("£19,500")).toBe(19500);
    expect(parsePrice("$19,500.50")).toBe(19500.5);
    expect(parsePrice("R 19 500")).toBe(19500);
    expect(parsePrice("Roof")).toBeNull();
    expect(readQuantity("2,5")).toBe(2.5);
    expect(readQuantity("1,200")).toBe(1200);
  });
});
