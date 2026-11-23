/**
 * The crew's screens in direction B (Mobile-Work.dc.html My day, Mobile-Sales.dc.html Visit): what
 * the screens promise a person with gloves, a screen reader or no signal, read from their source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const visit = read("features/field/FieldVisitPage.tsx");
const today = read("features/field/FieldTodayPage.tsx");
const css = read("styles/features.css");
const field = css.slice(css.indexOf("/* ---------- Field app ---------- */"), css.indexOf("/* ---------- Report bar lists"));
const shared = read("styles/components.css");

describe("My day", () => {
  it("lays out on the phone kit's grey ground, the visit to do now with the one green button", () => {
    expect(today).toContain('<div className="field-app m-grouped">');
    expect(today).toContain('<Button variant="primary" block loading={going === next.status}');
    // The whole card opens the visit, its buttons sit over that link.
    expect(field).toContain(".day-visit-link::after { content: \"\"; position: absolute; inset: 0;");
    expect(field).toContain(".day-visit-acts { position: relative; z-index: 1;");
  });

  it("shows the crew's equipment as a section of rows, its buttons quiet like the crew clock's", () => {
    const equipment = read("features/equipment/CrewEquipmentCard.tsx");
    expect(equipment).toContain('<Section title={t("Your equipment")} action={<Link to="/equipment">{t("All equipment")}</Link>}>');
    expect(equipment).toContain('<RelatedList className="crew-equipment">');
    expect(equipment).not.toContain('className="card"');
    expect(field).toContain(".field-app :is(.crew-clock, .crew-equipment) .rel-actions .btn { height: 40px;");
    expect(field).not.toContain(".day-main > .stack-sm");
  });

  it("asks about Spanish with two quiet answers: the visit's next step stays the one green button", () => {
    const offer = read("features/field/SpanishOffer.tsx");
    expect(offer).toContain('<Button lang="es"');
    expect(offer).not.toContain('variant="primary"');
  });

  it("leaves a related row's phone chevron to the shared row", () => {
    expect(today).not.toContain('end={<Icon name="chevronRight"');
    expect(read("features/field/MyJobsPage.tsx")).not.toContain('<Icon name="chevronRight" size={16} />');
  });

  it("keeps the count of visits done as a progress bar a screen reader hears once", () => {
    expect(today).toContain('<span aria-hidden="true">{t.plural(visits.length');
    expect(today).toContain('role="progressbar" aria-label={t("Visits done")}');
  });
});

describe("a visit", () => {
  it("says what's still required with Complete visit, and reads it with the button", () => {
    expect(visit).toContain('<div className="visit-left" id="visit-left">');
    expect(visit).toContain('aria-describedby={left > 0 ? "visit-left" : undefined}');
  });

  it("pins its next step above the tab bar on a phone, out of the way while typing and on paper", () => {
    expect(visit).toContain('<div className="visit-bar no-print" role="group" aria-label={t("Actions")} data-rows={rows}>');
    expect(field).toMatch(/@media \(max-width: 900px\) \{[\s\S]*\.visit-bar \{\s*position: fixed;/);
    expect(field).toContain("body:has(.mobile-nav[data-typing]) .visit-bar { display: none; }");
    // The page keeps room under its last section for each height the bar can be.
    for (const rows of ["2", "3", "4", "6", "7"]) expect(field).toContain(`:root:has(.visit-bar[data-rows="${rows}"])`);
  });

  it("opens the photo pickers from its More menu, and a dialog opened from a section is still a sheet", () => {
    expect(visit).toContain('document.getElementById("visit-add-photos")?.click()');
    expect(visit).toContain('ids={{ add: "visit-add-photos", draw: "visit-draw-photo" }}');
    // The grouped card's margin skips a dialog kept in a section, so its phone sheet stays at the foot.
    expect(shared).toContain(".m-grouped .sec:not(.sec-flush) > .sec-body > :not(.facts, .rel, .il, dialog) { margin-block: 14px; }");
  });

  it("gives checklist boxes a 26px glove-sized box and strikes through what's ticked", () => {
    expect(field).toContain('.field-app .check-row input[type="checkbox"] { width: 26px; height: 26px;');
    expect(field).toContain('.field-app .check-row input[type="checkbox"]:checked + .check-text');
  });

  it("shows the property's equipment as a section like the rest, Add equipment its last row", () => {
    // PropertyEquipment draws its own Section; the field keeps no rules of its own for it.
    expect(visit).toContain("<PropertyEquipment propertyId={propertyId} visitId={v.id} />");
    expect(field).not.toContain(".visit-equipment");
  });

  it("lists the job's and property's own fields as hairline facts", () => {
    expect(visit).toContain("<CustomFieldFacts fields={jobFields} values={v.job?.custom_fields} />");
    expect(visit).not.toContain('className="kv visit-kv"');
    expect(field).not.toContain(".visit-kv");
  });
});

describe("a sub's screens", () => {
  const jobs = read("features/field/MyJobsPage.tsx");

  it("names an offer by its job, with the days, town and price as a quiet line under it", () => {
    expect(jobs).toContain('<h3 id={`job-${o.id}-title`} className="offer-title">{o.job_title}</h3>');
    expect(jobs).toContain('<p className="offer-sum">{offerCardLine({ ...o, job_title: "" })}</p>');
  });

  it("keeps white words on a row's green button (Send it): the shared quiet row button leaves a primary alone", () => {
    expect(shared).toContain(".rel-actions .btn:not(.btn-primary, .btn-danger-solid, .btn-dark) { border-color: transparent; color: var(--text-2); }");
    expect(field).not.toContain(".rel-actions .btn-primary {");
  });
});

describe("on a phone", () => {
  it("draws a quiet button in an inset card as the card's own white, as the board does", () => {
    expect(field).toMatch(/\.m-grouped :is\(\.day-visit-acts, \.clock-acts, \.offer-acts[^{]*\{ background: var\(--m-card\); \}/);
  });
});
