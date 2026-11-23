/**
 * The Equipment, Applicants and Subcontractors lists as inbox rows (Page-Equipment, Page-Applicants and
 * Page-Subs .dc.html): each is grouped by what needs doing first, and empty groups are left out.
 */
import { describe, expect, it } from "vitest";
import { groupApplicants } from "../src/features/careers/ApplicantsPage";
import { groupEquipment } from "../src/features/equipment/EquipmentPage";
import type { Equipment } from "../src/features/equipment/equipmentData";
import { groupSubs } from "../src/features/subs/SubsPage";

const machine = (id: string, status: Equipment["status"]) => ({ id, status }) as Equipment;

describe("the Equipment list's groups", () => {
  it("puts machines needing attention first, then in service, in the shop and retired", () => {
    const rows = [machine("retired", "retired"), machine("shop", "in_shop"), machine("fine", "active"), machine("late", "active"), machine("soon", "active"), machine("nothing", "active")];
    const next = new Map([["late", { state: "overdue" as const }], ["soon", { state: "due_soon" as const }], ["fine", { state: "ok" as const }]]);
    const groups = groupEquipment(rows, next);
    expect(groups.map((g) => g.label)).toEqual(["Needs attention", "In service", "In the shop", "Retired"]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([["late", "soon"], ["fine", "nothing"], ["shop"], ["retired"]]);
    // Only the group that's gone wrong takes a red icon.
    expect(groups.map((g) => g.tone)).toEqual(["danger", undefined, undefined, undefined]);
  });

  it("leaves a machine in the shop or retired out of Needs attention, and empty groups out", () => {
    const groups = groupEquipment([machine("shop", "in_shop")], new Map([["shop", { state: "overdue" as const }]]));
    expect(groups.map((g) => g.label)).toEqual(["In the shop"]);
  });
});

describe("the Applicants list's groups", () => {
  it("follows the pipeline, new first, and skips statuses nobody is in", () => {
    const groups = groupApplicants([{ status: "offer" }, { status: "new" }, { status: "interview" }, { status: "new" }] as const);
    expect(groups.map((g) => g.label)).toEqual(["New", "Interview", "Offer made"]);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 1, 1]);
  });
});

describe("the Subcontractors list's groups", () => {
  it("puts subs whose paperwork needs attention first, in red, then the rest", () => {
    const groups = groupSubs(["ok-1", "late", "ok-2"], (s) => s === "late");
    expect(groups.map((g) => [g.label, g.rows])).toEqual([["Needs attention", ["late"]], ["Paperwork OK", ["ok-1", "ok-2"]]]);
    expect(groups[0]).toMatchObject({ tone: "danger", icon: "alert" });
    expect(groupSubs(["a"], () => false).map((g) => g.label)).toEqual(["Paperwork OK"]);
  });
});
