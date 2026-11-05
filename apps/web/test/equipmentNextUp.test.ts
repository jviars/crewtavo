import { describe, expect, it } from "vitest";
import { nextUp, type DueRow, type PaperRow } from "../src/features/equipment/equipmentData";

const plan = (state: DueRow["state"], days_left: number | null): DueRow =>
  ({ plan_id: "p", equipment_id: "e", name: "Oil change", state, days_left, meter_left: null, meter: "miles" }) as DueRow;
const paper = (state: PaperRow["state"], days_left: number): PaperRow =>
  ({ id: "d", equipment_id: "e", kind: "registration", name: null, expires_on: "2026-11-30", state, days_left }) as PaperRow;

describe("what a machine needs next", () => {
  it("shows the worse of its maintenance and paperwork", () => {
    expect(nextUp([plan("due_soon", 10)], [paper("overdue", -5)])?.name).toBe("Registration");
    expect(nextUp([plan("overdue", -2)], [paper("due_soon", 20)])?.name).toBe("Oil change");
  });

  it("at the same state, whichever comes first", () => {
    expect(nextUp([plan("due_soon", 10)], [paper("due_soon", 25)])?.name).toBe("Oil change");
    expect(nextUp([plan("due_soon", 30)], [paper("due_soon", 25)])?.summary).toBe("Runs out in 25 days");
    // Due by hours or miles only: the paperwork, since it has a date.
    expect(nextUp([plan("due_soon", null)], [paper("due_soon", 25)])?.name).toBe("Registration");
  });

  it("when nothing is due, the next maintenance; paperwork only if there's none", () => {
    expect(nextUp([plan("ok", 90)], [paper("ok", 200)])?.name).toBe("Oil change");
    expect(nextUp([], [paper("ok", 200)])?.summary).toBe("Current");
    expect(nextUp([], [])).toBeNull();
  });
});
