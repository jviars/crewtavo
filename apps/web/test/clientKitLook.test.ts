/**
 * The pages a business's clients and subs open from a link (booking form, referral, showcase,
 * unsubscribe, a sub's paperwork) wear the business's brand color and logo, and the navy its paper
 * prints in when it has no brand color, as the Client Hub does: never Crewtavo's green.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../src/features/${path}`, import.meta.url), "utf8");
const kit = read("public/ClientKit.tsx");
const css = read("public/client.module.css");

describe("the client kit's colors", () => {
  it("falls back to the paper's navy (documentColor), never green, for a business with no brand color", () => {
    expect(kit).toContain("export const FALLBACK_COLOR = documentColor({ color: null }, null);");
    expect(kit).toContain("const brand = color && HEX.test(color) ? color : FALLBACK_COLOR;");
    // brandStyle always gives the page its colors: nothing left for the stylesheet's own default.
    expect(kit).toMatch(/export function brandStyle\(color: string \| null \| undefined\): CSSProperties \{/);
    const page = css.slice(css.indexOf(".page {"), css.indexOf("}", css.indexOf(".page {")));
    expect(page).not.toMatch(/--brand[\w-]*:\s*var\(--green/);
  });

  it("puts the business's color on every page in the kit, from what the server sends", () => {
    expect(read("booking/BookingFormPage.tsx")).toContain("color={business?.color}");
    expect(read("public/ReferralPage.tsx")).toContain("<ClientPage color={view.data?.company.color}>");
    expect(read("public/UnsubscribePage.tsx")).toContain("<ClientPage color={status.data?.color}>");
    expect(read("public/ShowcasePage.tsx")).toContain("<ClientPage color={d?.company.color}>");
    expect(read("public/PaperworkPage.tsx")).toContain("<ClientPage color={data?.company.color}>");
  });

  it("draws check boxes, the disabled send button and dark-theme words without Crewtavo's green", () => {
    expect(css).toContain(':global(input[type="checkbox"]:not(.switch, [role="switch"]):is(:checked, :indeterminate)) { border-color: var(--brand); background-color: var(--brand); }');
    expect(css).toContain(".page .cta:global(.btn):disabled:not(:global(.is-loading)) { background: var(--fill-2);");
    expect(css).toContain(":global(.dark) .page { --brand-text: color-mix(in srgb, var(--brand) 45%, #fff); }");
  });
});
