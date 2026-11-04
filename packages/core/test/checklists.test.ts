import { describe, expect, it } from "vitest";
import { checklistAnswers, clientAnswers, type ChecklistItem } from "../src/forms";

const items: ChecklistItem[] = [
  { key: "gate", label: "Gate closed", type: "check", required: true },
  { key: "edges", label: "Edges trimmed", type: "check", required: false },
  { key: "height", label: "Cut height (in)", type: "number", required: false },
  { key: "notes", label: "Notes", type: "text", required: false },
  { key: "grass", label: "Grass looked", type: "choice", required: true, options: ["Healthy", "Dry"] },
  { key: "after", label: "After photos", type: "photo", required: true },
  { key: "sign", label: "Customer signature", type: "signature", required: true },
];
const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("a filled-in checklist's answers", () => {
  it("read in the items' order: checks as Yes or No, a signature as the printed name with its drawing", () => {
    const answers = checklistAnswers(items, { gate: true, edges: false, height: 3.5, notes: "  Dog in the yard ", grass: "Dry", sign: { name: "Dana Whitfield", image: PNG } });
    expect(answers.map(({ label, text, missing }) => [label, text, missing])).toEqual([
      ["Gate closed", "Yes", false],
      ["Edges trimmed", "No", false],
      ["Cut height (in)", "3.5", false],
      ["Notes", "Dog in the yard", false],
      ["Grass looked", "Dry", false],
      // Its photos are the visit's, so it's never missing.
      ["After photos", null, false],
      ["Customer signature", "Dana Whitfield", false],
    ]);
    expect(answers.at(-1)!.image).toBe(PNG);
  });

  it("mark the required items still to do, as the field app counts them", () => {
    const answers = checklistAnswers(items, { gate: false, notes: "", sign: { name: "Dana", image: null } });
    expect(answers.filter((a) => a.missing).map((a) => a.key)).toEqual(["gate", "grass", "sign"]);
    expect(answers.find((a) => a.key === "notes")!.text).toBeNull();
  });

  it("show an older typed signature, and drawn ones without a name as Signed", () => {
    expect(checklistAnswers(items, { sign: "Dana W" }).at(-1)).toMatchObject({ text: "Dana W", missing: false });
    expect(checklistAnswers(items, { sign: { name: " ", image: PNG } }).at(-1)).toMatchObject({ text: "Signed", image: PNG });
  });

  it("list each answer under its key once the checklist is deleted", () => {
    expect(checklistAnswers(null, { gate_closed: true, notes: "Fine" }).map(({ label, type, text }) => [label, type, text])).toEqual([
      ["gate closed", "check", "Yes"],
      ["notes", "text", "Fine"],
    ]);
    expect(checklistAnswers(items, null).every((a) => a.type === "check" || a.text === null)).toBe(true);
  });
});

describe("what a client sees of a checklist", () => {
  it("is the answered items in words: no photos, drawings, or answers to items it no longer has", () => {
    const shown = clientAnswers(items, { gate: true, notes: "", grass: "Healthy", sign: { name: "Dana Whitfield", image: PNG }, gate_code: "4821" });
    expect(shown).toEqual([
      { label: "Gate closed", text: "Yes" },
      { label: "Edges trimmed", text: "No" },
      { label: "Grass looked", text: "Healthy" },
      { label: "Customer signature", text: "Dana Whitfield" },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/4821|base64|photos/);
  });

  it("is nothing without the checklist's items, never the answers by key", () => {
    expect(clientAnswers(null, { gate_code: "4821" })).toEqual([]);
  });
});
