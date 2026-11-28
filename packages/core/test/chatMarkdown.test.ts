import { describe, expect, it } from "vitest";
import { chatBlocks, chatInline, chatPlainText } from "../src/chat";

const MARCUS = "c4a70000-0000-0000-0000-000000000004";
const names = (p: { kind: string; id?: string; key?: string }) => (p.kind === "user" ? "Marcus Reyes" : p.kind === "role" ? "Office" : "everyone");

describe("chat formatting", () => {
  it("reads bold, italics, strikethrough and code, with mentions inside them", () => {
    expect(chatInline(`**Gate code** is \`4411\`, *not* ~~4410~~ <@${MARCUS}>`)).toEqual([
      { kind: "bold", children: [{ kind: "text", text: "Gate code" }] },
      { kind: "text", text: " is " },
      { kind: "code", text: "4411" },
      { kind: "text", text: ", " },
      { kind: "italic", children: [{ kind: "text", text: "not" }] },
      { kind: "text", text: " " },
      { kind: "strike", children: [{ kind: "text", text: "4410" }] },
      { kind: "text", text: " " },
      { kind: "user", id: MARCUS },
    ]);
    expect(chatInline(`__ask <@&office>__`)).toEqual([{ kind: "bold", children: [{ kind: "text", text: "ask " }, { kind: "role", key: "office" }] }]);
    expect(chatInline("***both***")).toEqual([{ kind: "bold", children: [{ kind: "italic", children: [{ kind: "text", text: "both" }] }] }]);
  });

  it("leaves what only looks like formatting as it was typed", () => {
    for (const plain of ["snake_case_name and file_name.txt", "2 * 3 * 4", "a ** b", "price: $5 * 2", "~~", "* not a list here", "`", "@everyones", "email sam@everyone.test"]) {
      const out = chatInline(plain);
      expect(out, plain).toEqual([{ kind: "text", text: plain }]);
    }
    expect(chatInline("\\*kept\\* and \\_this\\_")).toEqual([{ kind: "text", text: "*kept* and _this_" }]);
  });

  it("makes links of web addresses, and of [words](address) only for safe ones", () => {
    expect(chatInline("see https://example.com/a_b_c. and [the map](https://maps.example/x) or [bad](javascript:alert(1))")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com/a_b_c", children: [{ kind: "text", text: "https://example.com/a_b_c" }] },
      { kind: "text", text: ". and " },
      { kind: "link", href: "https://maps.example/x", children: [{ kind: "text", text: "the map" }] },
      { kind: "text", text: " or [bad](javascript:alert(1))" },
    ]);
    expect(chatInline("[https://a.example](https://b.example)")).toEqual([{ kind: "link", href: "https://b.example", children: [{ kind: "text", text: "https://a.example" }] }]);
    expect(chatInline("**https://example.com**")).toEqual([{ kind: "bold", children: [{ kind: "link", href: "https://example.com", children: [{ kind: "text", text: "https://example.com" }] }] }]);
  });

  it("keeps each typed line, and reads lists, quotes, headings and code blocks", () => {
    const body = ["Today:", "first line", "", "- Load truck 3", "- Gas", "  before 8", "1. Drive", "2. Mow", "> they said", "> *call first*", "## Notes", "```", "a  *b*", "```", "after"].join("\n");
    expect(chatBlocks(body)).toEqual([
      { kind: "paragraph", lines: [[{ kind: "text", text: "Today:" }], [{ kind: "text", text: "first line" }]] },
      { kind: "list", ordered: false, start: 1, items: [[{ kind: "text", text: "Load truck 3" }], [{ kind: "text", text: "Gas\nbefore 8" }]] },
      { kind: "list", ordered: true, start: 1, items: [[{ kind: "text", text: "Drive" }], [{ kind: "text", text: "Mow" }]] },
      { kind: "quote", blocks: [{ kind: "paragraph", lines: [[{ kind: "text", text: "they said" }], [{ kind: "italic", children: [{ kind: "text", text: "call first" }] }]] }] },
      { kind: "heading", children: [{ kind: "text", text: "Notes" }] },
      { kind: "code", text: "a  *b*" },
      { kind: "paragraph", lines: [[{ kind: "text", text: "after" }]] },
    ]);
    expect(chatBlocks("3. Third\n4. Fourth")[0]).toMatchObject({ kind: "list", ordered: true, start: 3 });
    expect(chatBlocks("#5 is done")).toEqual([{ kind: "paragraph", lines: [[{ kind: "text", text: "#5 is done" }]] }]);
    expect(chatBlocks("```\nnever closed")).toEqual([{ kind: "code", text: "never closed" }]);
  });

  it("gives a one-line preview without the marks", () => {
    expect(chatPlainText(`**Gate** code:\n- \`4411\`\n> ask <@${MARCUS}>`, names)).toBe("Gate code: 4411 ask @Marcus Reyes");
  });
});
