/**
 * Guides: a link to a screen in Crewtavo (another guide) opens in place, anything else is a link out;
 * who has to read a required guide, by access level and by team role; the guides a job description
 * links to (its training); and when a guide on a review schedule is due.
 */
import { describe, expect, it } from "vitest";
import { compareBlocks, diffSeq, wordChanges, type Block } from "../src/features/kb/diff";
import { guideLinks, mustRead, reviewDueAt } from "../src/features/kb/kbData";
import { picturePaths } from "../src/features/kb/pictures";
import { cleanQuiz } from "../src/features/kb/quiz";
import { GUIDE_TEMPLATES, templateFor } from "../src/features/kb/templates";
import { isAppPath } from "../src/lib/html";
import { markdownPaste } from "../src/lib/markdownPaste";

describe("isAppPath", () => {
  it("is a path in the app", () => {
    expect(isAppPath("/kb/0f8c2b6e-1d2a-4c3b-9e4f-5a6b7c8d9e0f")).toBe(true);
    expect(isAppPath("/kb/abc#mixing-ratio")).toBe(true);
  });
  it("isn't another site, even one written like a path", () => {
    expect(isAppPath("//evil.example/kb")).toBe(false);
    expect(isAppPath("/\\evil.example")).toBe(false);
    expect(isAppPath("https://crewtavo.com/kb/abc")).toBe(false);
    expect(isAppPath("kb/abc")).toBe(false);
    expect(isAppPath("#section")).toBe(false);
  });
});

describe("mustRead", () => {
  const officeAdmin = { role: "office", role_id: "role-office-admin" };
  const crew = { role: "field_crew", role_id: null };
  it("is everyone's when nobody is listed", () => {
    expect(mustRead({ audience: null, audience_roles: null }, crew)).toBe(true);
    expect(mustRead({ audience: [], audience_roles: [] }, officeAdmin)).toBe(true);
  });
  it("is for the team roles listed", () => {
    const page = { audience: null, audience_roles: ["role-office-admin"] };
    expect(mustRead(page, officeAdmin)).toBe(true);
    expect(mustRead(page, { role: "office", role_id: "role-estimator" })).toBe(false);
    expect(mustRead(page, crew)).toBe(false);
  });
  it("is for anyone with a listed level or a listed role", () => {
    const page = { audience: ["field_crew"], audience_roles: ["role-office-admin"] };
    expect(mustRead(page, crew)).toBe(true);
    expect(mustRead(page, officeAdmin)).toBe(true);
    expect(mustRead(page, { role: "estimator", role_id: null })).toBe(false);
  });
  it("matches no one through a deleted role", () => {
    expect(mustRead({ audience: null, audience_roles: ["role-deleted"] }, officeAdmin)).toBe(false);
  });
});

describe("guideLinks", () => {
  const a = "0f8c2b6e-1d2a-4c3b-9e4f-5a6b7c8d9e0f";
  const b = "7a1e0000-0000-4000-8000-000000000002";
  it("reads the guides linked to, first first, each once, sections included", () => {
    const html = `<ul><li><p><a href="/kb/${b}">Answer calls</a> and <a href="/kb/${a}#steps">COIs</a></p></li><li><p><a href="/kb/${b}">again</a></p></li></ul>`;
    expect(guideLinks(html)).toEqual([b, a]);
  });
  it("leaves out links out and other screens", () => {
    expect(guideLinks(`<a href="https://example.com/kb/${a}">x</a><a href="/clients/${a}">y</a><p>/kb/${a}</p>`)).toEqual([]);
  });
});

describe("reviewDueAt", () => {
  it("is that many months after the last review", () => {
    expect(reviewDueAt({ review_months: 6, reviewed_at: new Date(2026, 2, 15, 9).toISOString() })).toEqual(new Date(2026, 8, 15, 9));
  });
  it("lands on a shorter month's last day, as the database counts", () => {
    expect(reviewDueAt({ review_months: 1, reviewed_at: new Date(2027, 0, 31, 9).toISOString() })).toEqual(new Date(2027, 1, 28, 9));
  });
  it("is nothing for a guide that isn't on a schedule", () => {
    expect(reviewDueAt({ review_months: null, reviewed_at: new Date().toISOString() })).toBeNull();
    expect(reviewDueAt({ review_months: 6, reviewed_at: null })).toBeNull();
  });
});

describe("comparing versions", () => {
  const block = (text: string, kind: Block["kind"] = "text"): Block => ({ kind, text });
  it("lines up the same blocks and marks what was taken out or added", () => {
    expect(diffSeq(["a", "b", "c"], ["a", "c", "d"])).toEqual([{ op: "same", a: "a", b: "a" }, { op: "del", a: "b" }, { op: "same", a: "c", b: "c" }, { op: "add", b: "d" }]);
  });
  it("reads a block replaced by one of its kind as that block changed", () => {
    const rows = compareBlocks([block("Steps", "heading"), block("Mix 20 gallons", "item")], [block("Steps", "heading"), block("Mix 30 gallons", "item"), block("Call the office")]);
    expect(rows.map((r) => r.kind)).toEqual(["same", "changed", "added"]);
  });
  it("doesn't pair blocks of different kinds", () => {
    expect(compareBlocks([block("Old step", "item")], [block("New heading", "heading")]).map((r) => r.kind)).toEqual(["removed", "added"]);
  });
  it("marks just the words that changed", () => {
    const w = wordChanges("Mix 20 gallons of water", "Mix 30 gallons of water");
    expect(w.before.filter((p) => p.changed).map((p) => p.text)).toEqual(["20"]);
    expect(w.after.filter((p) => p.changed).map((p) => p.text)).toEqual(["30"]);
    expect(w.after.map((p) => p.text).join("")).toBe("Mix 30 gallons of water");
  });
});

describe("cleanQuiz", () => {
  it("trims, drops empty answers and keeps the right one pointing at the same answer", () => {
    expect(cleanQuiz([{ question: " How long to dry? ", options: ["1 hour", "", " 24 hours "], answer: 2 }])).toEqual({ questions: [{ question: "How long to dry?", options: ["1 hour", "24 hours"], answer: 1 }] });
  });
  it("says what to fix", () => {
    expect(cleanQuiz([{ question: "", options: ["a", "b"], answer: 0 }])).toEqual({ problem: "Write question 1, or remove it." });
    expect(cleanQuiz([{ question: "Q", options: ["a", " "], answer: 0 }])).toEqual({ problem: "Question 1 needs at least two answers." });
    expect(cleanQuiz([{ question: "Q", options: ["a", "b"], answer: null }])).toEqual({ problem: "Pick the right answer for question 1." });
    expect(cleanQuiz([{ question: "Q", options: ["a", "b", ""], answer: 2 }])).toEqual({ problem: "Pick the right answer for question 1." });
  });
  it("is no questions for no quiz", () => {
    expect(cleanQuiz([])).toEqual({ questions: [] });
  });
});

describe("templates", () => {
  it("each has its own key and starts with headings to write under", () => {
    expect(new Set(GUIDE_TEMPLATES.map((t) => t.key)).size).toBe(GUIDE_TEMPLATES.length);
    for (const t of GUIDE_TEMPLATES) expect(t.html.match(/<h2>/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(templateFor("job")?.name).toBe("Job description");
    expect(templateFor("nope")).toBeNull();
  });
});

describe("pictures in guides", () => {
  it("reads the stored pictures a guide shows, each once", () => {
    const html = '<p>Hi</p><img data-path="co/kb/a.jpg" alt="Cones"><img src="https://example.com/b.png"><img data-path="co/kb/a.jpg">';
    expect(picturePaths(html)).toEqual(["co/kb/a.jpg"]);
  });
  it("counts one picture swapped for another as a change, even with the same description", () => {
    const pic = (key: string): Block => ({ kind: "media", text: "Picture", key });
    expect(compareBlocks([pic("co/kb/a.jpg")], [pic("co/kb/b.jpg")]).map((r) => r.kind)).toEqual(["changed"]);
    expect(compareBlocks([pic("co/kb/a.jpg")], [pic("co/kb/a.jpg")]).map((r) => r.kind)).toEqual(["same"]);
  });
});

describe("markdownPaste", () => {
  it("turns pasted Markdown into a guide's headings, steps, lists and checklists", () => {
    const html = markdownPaste("## Before you start\n\n- Cones\n- Arrow board\n\n1. Park the truck\n2. Set the cones\n\n**Never** stand in the lane.\n\n- [ ] Vest on")!;
    expect(html).toContain("<h3>Before you start</h3>");
    expect(html).toContain("<ul><li><p>Cones</p></li>");
    expect(html).toMatch(/<ol>.*Park the truck/);
    expect(html).toContain("<strong>Never</strong>");
    expect(html).toContain('data-type="taskList"');
  });
  it("leaves plain sentences, and copies that bring their own formatting, to paste as they are", () => {
    expect(markdownPaste("Call the office before you unload.")).toBeNull();
    expect(markdownPaste("**Only bold** on one line")).toBeNull();
    expect(markdownPaste("- Cones\n- Board", "<ul><li>Cones</li><li>Board</li></ul>")).toBeNull();
    expect(markdownPaste("   ")).toBeNull();
  });
  it("takes Markdown from a code editor, whose HTML is only styled text", () => {
    expect(markdownPaste("# Steps\n1. Mix", '<div style="color: #333"><span>Steps</span></div>')).toContain("<h2>Steps</h2>");
  });
});
