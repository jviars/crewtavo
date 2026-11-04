/**
 * Which checklists a visit shows (features/field/visitChecklists.ts): the ones its job's price list
 * items bring up, ready to fill in, and one more to pick; with nothing matched, as before.
 */
import { describe, expect, it } from "vitest";
import { visitChecklists } from "../src/features/field/visitChecklists";

const MOW = { id: "mow" };
const EDGE = { id: "edge" };
const ANY = { id: "any" };
const response = (id: string, template_id: string | null) => ({ id, template_id });

describe("a visit's checklists", () => {
  it("brings up each one the job's items go with, and offers the rest to pick", () => {
    const { cards, others } = visitChecklists([ANY, EDGE, MOW], ["mow", "edge", "gone"], [], "new-1");
    expect(cards).toEqual([
      { key: "t:edge", fixed: true, templateId: "edge", response: null },
      { key: "t:mow", fixed: true, templateId: "mow", response: null },
      { key: "new-1", fixed: false, templateId: null, response: null },
    ]);
    expect(others).toEqual([ANY]);
  });

  it("keeps a brought-up one's answers on it, and one picked before as its own", () => {
    const mowAnswers = response("r-mow", "mow");
    const picked = response("r-any", "any");
    const { cards } = visitChecklists([ANY, MOW], ["mow"], [picked, mowAnswers], "new-1");
    expect(cards).toEqual([
      { key: "t:mow", fixed: true, templateId: "mow", response: mowAnswers },
      { key: "r-any", fixed: false, templateId: "any", response: picked },
    ]);
  });

  it("has nothing to pick when every checklist was brought up", () => {
    expect(visitChecklists([MOW], ["mow"], [], "new-1").cards).toEqual([{ key: "t:mow", fixed: true, templateId: "mow", response: null }]);
  });

  it("is as before with nothing matched: one to pick, chosen for them when there's only one", () => {
    expect(visitChecklists([MOW], [], [], "new-1").cards).toEqual([{ key: "new-1", fixed: false, templateId: "mow", response: null }]);
    expect(visitChecklists([ANY, MOW], [], [], "new-1").cards).toEqual([{ key: "new-1", fixed: false, templateId: null, response: null }]);
    const started = response("r-1", "mow");
    expect(visitChecklists([ANY, MOW], [], [started], "new-1").cards).toEqual([{ key: "r-1", fixed: false, templateId: "mow", response: started }]);
  });

  it("keeps the one picked under the same key once it's saved, so it isn't made again", () => {
    const before = visitChecklists([ANY, MOW], [], [], "new-1").cards[0]!;
    const after = visitChecklists([ANY, MOW], [], [response("new-1", "any")], "new-1").cards[0]!;
    expect(after.key).toBe(before.key);
  });
});
