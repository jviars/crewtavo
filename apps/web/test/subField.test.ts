/**
 * A subcontractor's sign-in in the field app (docs/subcontractors-plan.md, phases B and D): they see
 * My day, My jobs, My paperwork and their profile and nothing else, on the sidebar, the phone's tab bar, Create and
 * Settings; any other screen opened by its address sends them to My day; the client's phone shows
 * only when the office allows it; and their paperwork reads as needed, waiting or OK.
 */
import { ROLES, STAFF } from "@crewtavo/core/roles";
import { describe, expect, it } from "vitest";
import { createItems, MOBILE_TABS, mobileTabs, NAV_GROUPS, navVisible, OTHER_SCREENS, SETTINGS_ITEM, settingsItem, subCanOpen, SUB_TABS } from "../src/components/shell/nav";
import { chatOn } from "../src/features/chat/data";
import { contactLinks, visitContact } from "../src/features/field/contact";
import { roleChoices } from "../src/features/settings/roles";
import { settingsGroups } from "../src/features/settings/sections";
import { myPaperwork, myPaperworkSummary, myUploadProblem, type PaperworkRow } from "../src/features/subs/paperwork";
import { keepsTime, type Session } from "../src/lib/session";

const MB = 1024 * 1024;
const sub = (settings: Record<string, unknown> = {}) => ({ role: "subcontractor", permissions: [] as string[], company: { settings } });
const staff = (role: string, permissions: string[] = []) => ({ role, permissions, company: { settings: { team_chat: { enabled: true } } } });
const EVERY_SCREEN = [...NAV_GROUPS.flat(), ...OTHER_SCREENS, SETTINGS_ITEM];

describe("a sub's navigation", () => {
  it("shows only My day, My jobs and My paperwork, whatever the business has turned on", () => {
    const shown = EVERY_SCREEN.filter((item) => navVisible(sub({ team_chat: { enabled: true }, website: { enabled: true } }), item)).map((item) => item.to);
    expect(shown).toEqual(["/field", "/field/jobs", "/field/paperwork"]);
  });

  it("keeps My jobs and My paperwork to subs, and My day to crews and subs", () => {
    const paperwork = NAV_GROUPS.flat().find((item) => item.to === "/field/paperwork")!;
    const jobs = NAV_GROUPS.flat().find((item) => item.to === "/field/jobs")!;
    const myDay = NAV_GROUPS.flat().find((item) => item.to === "/field")!;
    for (const role of STAFF) expect(navVisible(staff(role, ["subs"]), paperwork), role).toBe(false);
    for (const role of STAFF) expect(navVisible(staff(role, ["subs", "job_costs"]), jobs), role).toBe(false);
    expect(STAFF.filter((role) => navVisible(staff(role), myDay))).toEqual(["crew_lead", "field_crew"]);
  });

  it("has no Create menu, and their profile in place of Settings", () => {
    expect(createItems({ role: "subcontractor", permissions: ["sales", "schedule", "invoices"] })).toEqual([]);
    expect(settingsItem({ role: "subcontractor" })).toMatchObject({ to: "/settings?tab=profile", label: "Profile" });
    expect(settingsItem({ role: "field_crew" })).toBe(SETTINGS_ITEM);
  });

  it("gives them their own tab bar on the phone: My day, My jobs, Paperwork and Profile", () => {
    expect(mobileTabs(sub({ team_chat: { enabled: true } })).map((t) => t.to)).toEqual(["/field", "/field/jobs", "/field/paperwork", "/settings?tab=profile"]);
    expect(mobileTabs(sub())).toBe(SUB_TABS);
    // The team's is as before: chat only while it's on.
    expect(mobileTabs(staff("field_crew")).map((t) => t.to)).toEqual(MOBILE_TABS.map((t) => t.to));
    expect(mobileTabs({ role: "office", company: { settings: {} } }).map((t) => t.to)).toEqual(["/", "/field", "/schedule", "/clients"]);
  });

  it("doesn't count My jobs or My paperwork as part of My day when they're open", () => {
    expect(SUB_TABS[0]).toMatchObject({ to: "/field", except: ["/field/paperwork", "/field/jobs"] });
    expect(NAV_GROUPS.flat().find((item) => item.to === "/field")).toMatchObject({ except: ["/field/paperwork", "/field/jobs"] });
  });

  it("never has team chat, even if the business has it on", () => {
    expect(chatOn({ role: "subcontractor", company: { id: "c1", name: "Uniform", timezone: "UTC", currency: "USD", settings: { team_chat: { enabled: true } } } })).toBe(false);
    expect(chatOn({ role: "field_crew", company: { id: "c1", name: "Uniform", timezone: "UTC", currency: "USD", settings: { team_chat: { enabled: true } } } })).toBe(true);
  });
});

describe("screens a sub can open by their address", () => {
  it("are My day and their visits, My jobs and an offer in it, My paperwork and Settings (their profile)", () => {
    for (const path of ["/field", "/field/", "/field/visits/0b8f1c1e-1a2b-4c3d-8e9f-001122334455", "/field/paperwork", "/field/jobs", "/field/jobs/", "/field/jobs/0b8f1c1e-1a2b-4c3d-8e9f-001122334455", "/settings"]) {
      expect(subCanOpen(path), path).toBe(true);
    }
  });

  it("aren't Home or anything else: those go to My day", () => {
    for (const path of ["/", "/schedule", "/clients", "/clients/1", "/jobs/1", "/subs", "/subs/1", "/chat", "/timesheets", "/equipment", "/kb", "/messages", "/field/visits", "/field/visits/1/edit", "/field/jobs/1/edit", "/field/jobsx", "/fieldwork", "/settings/x", "/roofing/1/visit"]) {
      expect(subCanOpen(path), path).toBe(false);
    }
  });
});

describe("a sub's settings", () => {
  const session = (role: string) => ({ role, permissions: [], config: { singleCompany: true, platform: "railway" } }) as unknown as Session;

  it("are only their profile (with notifications)", () => {
    expect(settingsGroups(session("subcontractor")).flatMap((g) => g.items.map((i) => ("tab" in i ? i.tab : i.to)))).toEqual(["profile"]);
    expect(settingsGroups(session("field_crew")).flatMap((g) => g.items.map((i) => ("tab" in i ? i.tab : i.to)))).toContain("assistants");
  });

  it("are never offered as a level when inviting someone or changing their role", () => {
    const levels = (owner: boolean) => roleChoices([], owner).map((c) => c.value);
    expect(levels(true)).toEqual(STAFF.map((r) => `level:${r}`));
    expect(levels(true)).not.toContain("level:subcontractor");
    expect(levels(false)).not.toContain("level:owner");
    expect(ROLES).toContain("subcontractor");
  });
});

describe("a sub's clock", () => {
  const person = (role: string, uses_clock?: boolean) => ({ role, subcontractor: uses_clock === undefined ? null : { id: "s1", name: "Apex Roofing", can_contact_clients: false, uses_clock } }) as Pick<Session, "role" | "subcontractor">;

  it("is off unless the office turned on Uses the clock; the team always has one", () => {
    expect(keepsTime(person("subcontractor", false))).toBe(false);
    expect(keepsTime(person("subcontractor"))).toBe(false);
    expect(keepsTime(person("subcontractor", true))).toBe(true);
    for (const role of STAFF) expect(keepsTime(person(role)), role).toBe(true);
  });
});

describe("Call and Text on a visit", () => {
  it("show only with a phone: a sub gets one only when the office lets them contact clients", () => {
    // Can contact clients off: visit_contact() gives the name only.
    const nameOnly = visitContact(null, { name: "Jordan Rivera", phone: null, email: null });
    expect(nameOnly).toEqual({ name: "Jordan Rivera", phone: null });
    expect(contactLinks(nameOnly)).toEqual([]);
    // On: the phone too.
    const allowed = visitContact(null, { name: "Jordan Rivera", phone: "+15405550123", email: "jordan@example.com" });
    expect(contactLinks(allowed)).toEqual([
      { label: "Call", href: "tel:+15405550123" },
      { label: "Text", href: "sms:+15405550123" },
    ]);
    expect(contactLinks(visitContact(null, { name: "Jordan Rivera", phone: "  ", email: null }))).toEqual([]);
  });

  it("use the client on the job for the team, and nothing when there's no one to call", () => {
    expect(visitContact({ display_name: "Jordan Rivera", phone: "555-0100" }, null)).toEqual({ name: "Jordan Rivera", phone: "555-0100" });
    expect(contactLinks(visitContact({ display_name: "Jordan Rivera", phone: null }, null))).toEqual([]);
    expect(visitContact(null, null)).toEqual({ name: null, phone: null });
  });
});

describe("My paperwork", () => {
  const row = (requirement: string, state: string, extra: Partial<PaperworkRow> = {}): PaperworkRow => ({
    subcontractor_id: "s1", requirement, state, expires_on: null, days_left: null, verified: state === "missing" ? null : true, waiting: false, ...extra,
  });

  it("says what's needed, what's waiting for the office and what's OK, in that order of requirements", () => {
    const items = myPaperwork([
      row("w9", "ok"),
      row("liability", "expired", { expires_on: "2026-10-01", days_left: -24 }),
      row("workers_comp", "expiring", { expires_on: "2026-11-05", days_left: 11 }),
    ]);
    expect(items.map((i) => [i.label, i.state, i.status])).toEqual([
      ["W-9", "ok", "OK"],
      ["Liability insurance", "needed", "Expired"],
      ["Workers' comp", "needed", "Ends in 11 days"],
    ]);
    expect(items[1]!.detail).toBe("The one we have ran out Oct 1, 2026. Send the new one.");
    expect(items[2]!.detail).toBe("The one we have ends Nov 5, 2026. Send the new one when you get it.");
    expect(myPaperworkSummary(items)).toBe("2 things needed");
  });

  it("counts anything missing as needed, including a requirement with no row", () => {
    const items = myPaperwork([row("w9", "missing")]);
    expect(items.map((i) => [i.requirement, i.state, i.status])).toEqual([
      ["w9", "needed", "Needed"],
      ["liability", "needed", "Needed"],
      ["workers_comp", "needed", "Needed"],
    ]);
    expect(items[0]!.detail).toBe("We don't have one on file yet.");
    expect(myPaperworkSummary(items.slice(0, 1))).toBe("1 thing needed");
  });

  it("shows one they sent as waiting, even when the one on file ran out", () => {
    const items = myPaperwork([
      row("w9", "ok", { verified: false }),
      row("liability", "expired", { expires_on: "2026-10-01", waiting: true }),
      row("workers_comp", "ok", { expires_on: "2027-06-30" }),
    ]);
    expect(items.map((i) => [i.state, i.status])).toEqual([
      ["waiting", "Waiting to be checked"],
      ["waiting", "Waiting to be checked"],
      ["ok", "OK"],
    ]);
    expect(items[2]!.detail).toBe("Good until Jun 30, 2027.");
    expect(myPaperworkSummary(items)).toBe("Nothing needed. The office is checking what you sent.");
    expect(myPaperworkSummary(myPaperwork([row("w9", "ok"), row("liability", "ok"), row("workers_comp", "ok")]))).toBe("You're all set");
  });

  it("one they sent that ends within 30 days is needed, not waiting, as the reminder that links here says", () => {
    // The only liability document is their own unchecked one, ending in 20 days: the view says it's
    // waiting, since it counts itself.
    const items = myPaperwork([row("w9", "ok"), row("liability", "expiring", { verified: false, waiting: true, expires_on: "2026-11-14", days_left: 20 }), row("workers_comp", "ok")]);
    expect([items[1]!.state, items[1]!.status]).toEqual(["needed", "Ends in 20 days"]);
    expect(items[1]!.detail).toBe("The one we have ends Nov 14, 2026. Send the new one when you get it. The office is still checking the one you sent.");
    expect(myPaperworkSummary(items)).toBe("1 thing needed");
    // Behind a checked one that's ending, a newer one they sent is what's waiting.
    expect(myPaperwork([row("liability", "expiring", { verified: true, waiting: true, days_left: 20 })])[1]!.state).toBe("waiting");
  });

  it("an expired one that isn't checked yet still needs the new one", () => {
    expect(myPaperwork([row("liability", "expired", { verified: false, expires_on: "2026-10-01" })])[1]!.state).toBe("needed");
  });

  it("takes big phone photos (they're shrunk before they go up), but not big PDFs or other files", () => {
    expect(myUploadProblem({ name: "certificate.jpg", size: 40 * MB, type: "image/jpeg" }, 15 * MB)).toBeNull();
    expect(myUploadProblem({ name: "IMG_0042.HEIC", size: 30 * MB, type: "" }, 15 * MB)).toBeNull();
    expect(myUploadProblem({ name: "certificate.pdf", size: 20 * MB, type: "application/pdf" }, 15 * MB)).toBe("That file is bigger than 15 MB. Send a smaller one, or a photo of the page.");
    expect(myUploadProblem({ name: "certificate.pdf", size: 2 * MB, type: "application/pdf" }, 15 * MB)).toBeNull();
    expect(myUploadProblem({ name: "notes.docx", size: MB, type: "" }, 15 * MB)).toBe("Send a PDF or a photo (JPG, PNG or HEIC).");
  });
});
