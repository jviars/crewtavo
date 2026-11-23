/**
 * Roofing's project list (features/roofing/RoofingPage.tsx, flow/projects.ts): the projects grouped
 * by what needs doing first, the price each row shows, the search, and which ones are open. Also the
 * look the redesign settled on, checked in the CSS: the tabs are one segmented control on a phone,
 * and a row's quiet line leaves its age off there.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TakeoffRow } from "../src/features/paving/data";
import { groupRoofProjects, isOpenProject, matchesProject, projectGroup, projectPrice, projectStage, stageNote, type ProjectQuote, type ProjectRow } from "../src/features/roofing/flow/projects";

const line = { id: "l1", option_id: null, quantity: 1, unit_price: 18000, taxable: true, optional: false, selected: true };
const quote = (patch: Partial<ProjectQuote> = {}): ProjectQuote => ({
  id: "q1",
  number: 13,
  title: "Tear-off and replace",
  status: "draft",
  total: 18304,
  tax_rate: 0,
  discount_amount: 0,
  promo: null,
  range_low: null,
  range_high: null,
  range_sent_at: null,
  range_accepted_at: null,
  priced_on_site_at: null,
  exact_sent_at: null,
  client: { display_name: "Jordan Rivera" },
  property: { line1: "418 Pell Ave", city: "Rocky Mount", region: "VA", postal_code: "24151" },
  package: { name: "Architectural shingle" },
  options: [],
  lines: [line],
  jobs: [],
  measure_on_site_at: null,
  ...patch,
});
const takeoff = { id: "m1", updated_at: "2026-11-20T12:00:00Z" } as unknown as TakeoffRow;
const row = (patch: Partial<ProjectQuote> = {}, measured = true): ProjectRow => ({ quote: quote({ id: `q-${Math.random()}`, ...patch }), takeoff: measured ? takeoff : null });

describe("which group a roofing project is in", () => {
  it("puts each stage where someone acts on it", () => {
    expect(projectGroup(quote({ measure_on_site_at: "2026-11-20T12:00:00Z" }), false)).toBe("onsite");
    expect(projectGroup(quote(), false)).toBe("measure");
    expect(projectGroup(quote({ lines: [] }), true)).toBe("price");
    expect(projectGroup(quote(), true)).toBe("send");
    expect(projectGroup(quote({ status: "sent", range_low: 18300, range_high: 21050 }), true)).toBe("range");
    expect(projectGroup(quote({ status: "sent", range_low: 18300, range_high: 21050, range_accepted_at: "2026-11-21T12:00:00Z" }), true)).toBe("visit");
    expect(projectGroup(quote({ status: "sent", range_low: 18300, priced_on_site_at: "2026-11-21T12:00:00Z" }), true)).toBe("sign");
    expect(projectGroup(quote({ status: "sent" }), true)).toBe("sign");
    expect(projectGroup(quote({ status: "changes_requested" }), true)).toBe("changes");
    expect(projectGroup(quote({ status: "approved" }), true)).toBe("signed");
    expect(projectGroup(quote({ status: "converted", jobs: [{ id: "j", status: "scheduled" }] }), true)).toBe("scheduled");
    expect(projectGroup(quote({ status: "converted", jobs: [{ id: "j", status: "requires_invoicing" }] }), true)).toBe("invoice");
    expect(projectGroup(quote({ status: "converted", jobs: [{ id: "j", status: "completed" }] }), true)).toBe("done");
    expect(projectGroup(quote({ status: "lost" }), true)).toBe("lost");
    expect(projectGroup(quote({ status: "archived" }), true)).toBe("archived");
  });

  it("lists what needs doing first, keeps each group's order, and leaves empty groups out", () => {
    const sent = row({ status: "sent", range_low: 18300, range_high: 21050 });
    const yes = row({ status: "sent", range_low: 18300, range_high: 21050, range_accepted_at: "2026-11-21T12:00:00Z" });
    const onSite = row({ measure_on_site_at: "2026-11-20T12:00:00Z" }, false);
    const signed = row({ status: "approved" });
    const draft = row();
    const groups = groupRoofProjects([sent, draft, onSite, yes, signed]);
    expect(groups.map((g) => g.label)).toEqual(["Wants a visit", "Measure on site", "Signed", "Ready to send", "Range sent"]);
    expect(groups[0]).toMatchObject({ tone: "good", icon: "calendar", rows: [yes] });
    expect(groups[1]).toMatchObject({ tone: "warning", icon: "ruler", rows: [onSite] });
    // A stage that's only a step along the way has no tone or icon.
    expect(groups[4].tone).toBeUndefined();
    expect(groupRoofProjects([])).toEqual([]);
  });

  it("names the stage on the project's page in the list's words", () => {
    // Priced and not sent: the list's "Ready to send", not "Pricing".
    expect(projectStage(quote(), true)).toEqual({ label: "Ready to send", tone: "muted" });
    expect(projectStage(quote({ lines: [] }), true).label).toBe("To price");
    expect(projectStage(quote(), false).label).toBe("To measure");
    expect(projectStage(quote({ status: "sent", range_low: 18300, range_high: 21050, range_accepted_at: "2026-11-21T12:00:00Z" }), true)).toEqual({ label: "Wants a visit", tone: "warning" });
    // Where the group holds several stages, the page says which.
    expect(projectStage(quote({ status: "sent", priced_on_site_at: "2026-11-21T12:00:00Z", range_low: 18300 }), true).label).toBe("Priced on site");
    expect(projectStage(quote({ status: "lost" }), true).tone).toBe("danger");
  });

  it("names the stage in the row only where a group holds several", () => {
    expect(stageNote(row({ status: "sent", priced_on_site_at: "2026-11-21T12:00:00Z", range_low: 18300 }))).toBe("Priced on site");
    expect(stageNote(row({ status: "sent", exact_sent_at: "2026-11-21T12:00:00Z" }))).toBe("Exact price sent");
    expect(stageNote(row({ status: "sent", range_low: 18300, range_high: 21050 }))).toBeNull();
  });
});

describe("a roofing project's row", () => {
  it("shows the range the homeowner was sent, else the cheapest option, else the total, else nothing", () => {
    expect(projectPrice(quote({ status: "sent", range_low: 18300, range_high: 21050 }), null)).toEqual({ kind: "range", low: 18300, high: 21050 });
    expect(projectPrice(quote(), 13180)).toEqual({ kind: "from", amount: 13180 });
    expect(projectPrice(quote(), null)).toEqual({ kind: "total", amount: 18304 });
    expect(projectPrice(quote({ lines: [] }), null)).toBeNull();
  });

  it("is found by its client, street, town, package or number", () => {
    const q = quote();
    for (const term of ["jordan", "pell", "Rocky", "architectural", "#13", "13", "  "]) expect(matchesProject(q, term)).toBe(true);
    expect(matchesProject(q, "Whitaker")).toBe(false);
  });

  it("is open until it's lost, archived or its job is done", () => {
    expect(isOpenProject(quote())).toBe(true);
    expect(isOpenProject(quote({ status: "converted", jobs: [{ id: "j", status: "scheduled" }] }))).toBe(true);
    expect(isOpenProject(quote({ status: "lost" }))).toBe(false);
    expect(isOpenProject(quote({ status: "archived" }))).toBe(false);
    expect(isOpenProject(quote({ status: "converted", jobs: [{ id: "j", status: "completed" }] }))).toBe(false);
  });
});

describe("the roofing list's own look", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/features/roofing/flow/projects.module.css", import.meta.url)), "utf8");
  const page = readFileSync(fileURLToPath(new URL("../src/features/roofing/RoofingPage.tsx", import.meta.url)), "utf8");

  it("is the shared inbox list with its toolbar, not a table", () => {
    expect(page).toContain("<InboxList");
    expect(page).toContain("<Toolbar");
    expect(page).not.toContain("<table");
  });

  it("turns the tabs into one segmented control on a phone, and leaves a row's age off there", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(phone).toMatch(/\.tabs:global\(\.underline-tabs\) \{[^}]*background: var\(--seg-track\)/);
    expect(phone).toMatch(/a\[aria-current="page"\] \{[^}]*background: var\(--raised\)/);
    expect(css).toMatch(/\.age, :global\(\.meta-dot\):has\(\+ \.age\) \{ display: none !important; \}/);
  });

  it("gives each phone tab a 44px tap area: its 38px chip and the track's padding", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px)"));
    expect(phone).toContain('.tabs:global(.underline-tabs) a::before { content: ""; position: absolute; inset: -3px -1px; }');
  });
});

describe("a project's steps (paving's ProjectFlow, shared with roofing)", () => {
  const flow = readFileSync(fileURLToPath(new URL("../src/features/paving/ProjectFlow.tsx", import.meta.url)), "utf8");
  const roofing = readFileSync(fileURLToPath(new URL("../src/features/roofing/RoofingProjectPage.tsx", import.meta.url)), "utf8");

  it("makes Create an invoice the green button when the invoice step is the one it's at", () => {
    expect(flow).toContain('<Link className={cx("btn btn-sm", primary && "btn-primary")} to={`/jobs/${job.id}?invoice=1`}>');
    expect(flow).toContain('primary={step === "invoice"}');
    expect(roofing).toContain('primary={step === "invoice"}');
  });

  it("scrolls the strip sideways to the step it's at, without scrolling the page", () => {
    const strip = flow.slice(flow.indexOf("export function FlowProgress"), flow.indexOf("export function TakeoffEmpty"));
    expect(strip).toContain("ol.scrollLeft += lead.getBoundingClientRect().left - from - 28;");
    expect(strip).not.toContain("scrollIntoView");
  });
});
