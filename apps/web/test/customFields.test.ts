import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldsCard, type CustomFieldRow } from "../src/features/customFields/CustomFields";

vi.mock("../src/lib/session", () => ({
  useSession: () => ({ role: "owner", permissions: ["invoices"], userId: "u-me", company: { id: "c1", name: "Radford Lawn Care", settings: {} } }),
  hasRole: () => true,
  can: () => true,
}));
vi.mock("../src/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/api")>()), supabase: () => ({}) }));

const field = (key: string, label: string, type: string, extra: Partial<CustomFieldRow> = {}): CustomFieldRow => ({
  id: key, record_type: "invoice", key, label, type, choices: [], show_on_pdf: false, show_in_portal: false, sort: 0, archived_at: null, ...extra,
});
const FIELDS = [
  field("permit_number", "Permit number", "text", { sort: 0 }),
  field("work_order", "Work order", "text", { sort: 1 }),
  field("billing_type", "Billing type", "choice", { sort: 2, choices: ["Residential", "Commercial"] }),
  field("lien_waiver_sent", "Lien waiver sent", "yes_no", { sort: 3 }),
  field("old_code", "Old code", "text", { sort: 4, archived_at: "2026-10-01T00:00:00Z" }),
];

function card(values: unknown, editable: boolean, fields: CustomFieldRow[] = FIELDS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["custom-fields", "c1"], fields);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(CustomFieldsCard, { record: "invoice", values, editable, onSave: async () => undefined })));
}

const filled = { permit_number: "BLK-26-0412", billing_type: "Commercial", lien_waiver_sent: false, old_code: "X1" };

describe("the custom fields section on a quote or invoice", () => {
  it("is a section on a hairline, not a card, with Edit as its one quiet action", () => {
    const html = card(filled, true);
    expect(html).toMatch(/^<section class="sec"/);
    expect(html).not.toContain("card");
    expect(html).toContain(">Details</h2>");
    expect(html).toContain('<div class="sec-action"><button type="button" aria-label="Edit details">Edit</button></div>');
  });

  it("lists every field in use as a fact, an empty one as a quiet dash read out as Not set", () => {
    const html = card(filled, true);
    const labels = [...html.matchAll(/<dt class="fact-label">([^<]+)<\/dt>/g)].map((m) => m[1]);
    // In the business's order, and never an archived field.
    expect(labels).toEqual(["Permit number", "Work order", "Billing type", "Lien waiver sent"]);
    expect(html).toContain('<span class="pre-wrap">BLK-26-0412</span>');
    expect(html).toMatch(/<dt class="fact-label">Work order<\/dt><dd class="fact-value"><span class="[^"]*"><span aria-hidden="true">—<\/span><span class="sr-only">Not set<\/span><\/span><\/dd>/);
    expect(html).toContain('<span class="pre-wrap">No</span>');
  });

  it("shows only the filled fields, with no Edit, where it can't be changed", () => {
    const html = card(filled, false);
    expect(html).not.toContain("Edit");
    expect(html).not.toContain("Work order");
    expect(html).not.toContain("—");
    expect(html).toContain("Permit number");
  });

  it("says nothing is filled in yet when it can be edited and no field has a value", () => {
    const html = card({}, true);
    expect(html).toContain('<div class="empty-inline"><span>Nothing filled in yet</span></div>');
    expect(html).not.toContain("fact-label");
  });

  it("isn't there while the business has no field in use, or nothing to show", () => {
    expect(card(filled, true, [FIELDS[4]!])).toBe("");
    expect(card({}, false)).toBe("");
  });
});

describe("the custom fields section's edit look", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/features/customFields/CustomFields.module.css", import.meta.url)), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 900px)"));

  it("keeps each row the height of a fact, so nothing jumps on Edit", () => {
    expect(css).toMatch(/\.row\.row \{[^}]*min-height: 38px; padding: 2px 0;/);
    expect(css).toMatch(/\.control\.control \{[^}]*height: var\(--control-sm\); margin-left: -9px; padding: 0 8px;/);
    expect(phone).toMatch(/\.row\.row \{[^}]*min-height: 48px; padding: 4px 0;/);
  });

  it("gives phones 16px fields (no zoom on focus) and 44px buttons", () => {
    expect(phone).toMatch(/\.control\.control \{[^}]*font-size: var\(--fs-16\)/);
    expect(phone).toMatch(/\.actions > :global\(\.btn\) \{ height: 44px;/);
  });
});
