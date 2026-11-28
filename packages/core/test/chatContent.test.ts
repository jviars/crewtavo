/**
 * What a chat message carries besides its words (src/chatContent.ts): files by kind, the links in
 * it and the records they name, and a search's words found again in a result.
 */
import { describe, expect, it } from "vitest";
import {
  cardLinks,
  chatDocumentType,
  chatFileKind,
  chatMessageLink,
  chatRecordLink,
  fileSize,
  markMatches,
  messageLinks,
  searchSnippet,
  searchWords,
} from "../src/chatContent";

const ORIGIN = "https://ops.greenlawn.example";
const CO = "1b8c0000-0000-4000-8000-000000000001";
const QUOTE = "2c9d0000-0000-4000-8000-000000000002";

/** ASCII as base64url (core's tests run without Node's or a browser's types). */
function base64url(text: string): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    value = (value << 8) | ch.charCodeAt(0);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += abc[(value >> bits) & 63];
    }
  }
  return bits ? out + abc[(value << (6 - bits)) & 63] : out;
}

/** A Client Hub link as the API signs one (lib/links.ts): base64url JSON, a full stop and a signature. */
function hubLink(payload: Record<string, unknown>) {
  return `${ORIGIN}/hub/${base64url(JSON.stringify(payload))}.c2lnbmF0dXJl`;
}

describe("files", () => {
  it("are photos, documents or voice notes by the ending they're stored under", () => {
    expect(chatFileKind({ path: `${CO}/chat/x/a.JPG` })).toBe("photo");
    expect(chatFileKind({ path: `${CO}/chat/x/a.heic` })).toBe("photo");
    expect(chatFileKind({ path: `${CO}/chat/x/a.pdf` })).toBe("document");
    expect(chatFileKind({ name: "Budget.xlsx" })).toBe("document");
    expect(chatFileKind({ path: `${CO}/chat/x/a.m4a` })).toBe("audio");
    expect(chatFileKind({ name: "setup.exe" })).toBeNull();
    expect(chatFileKind({ name: "image", type: "image/png" })).toBe("photo");
  });

  it("say what kind of document they are", () => {
    expect(chatDocumentType({ name: "Plan.PDF" })).toBe("pdf");
    expect(chatDocumentType({ name: "Letter.docx" })).toBe("word");
    expect(chatDocumentType({ name: "Prices.ods" })).toBe("sheet");
    expect(chatDocumentType({ name: "Deck.pptx" })).toBe("slides");
    expect(chatDocumentType({ name: "list.csv" })).toBe("csv");
    expect(chatDocumentType({ name: "notes.txt" })).toBe("text");
  });

  it("show their size in round numbers", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(820 * 1024)).toBe("820 KB");
    expect(fileSize(1.24 * 1024 * 1024)).toBe("1.2 MB");
    expect(fileSize(2 * 1024 * 1024)).toBe("2 MB");
    expect(fileSize(14.6 * 1024 * 1024)).toBe("15 MB");
    expect(fileSize(undefined)).toBeNull();
    expect(fileSize(-1)).toBeNull();
  });
});

describe("links", () => {
  it("are found once each, in order, and never inside code", () => {
    const body = "See https://a.example/x and [the plan](https://b.example/plan).\n`https://code.example/no`\n```\nhttps://block.example/no\n```\n> quoted https://c.example\n- https://a.example/x again";
    expect(messageLinks(body)).toEqual(["https://a.example/x", "https://b.example/plan", "https://c.example"]);
    expect(messageLinks("mail me: mailto:a@b.example, call tel:5551234")).toEqual([]);
  });

  it("name this Crewtavo's quotes, invoices, jobs, clients and requests", () => {
    expect(chatRecordLink(`${ORIGIN}/quotes/${QUOTE}`, ORIGIN)).toEqual({ kind: "quote", id: QUOTE, hub: false });
    expect(chatRecordLink(`${ORIGIN}/jobs/${QUOTE.toUpperCase()}?tab=visits#top`, ORIGIN)).toEqual({ kind: "job", id: QUOTE, hub: false });
    expect(chatRecordLink(`${ORIGIN}/invoices/${QUOTE}`, `${ORIGIN}/chat/abc`)?.kind).toBe("invoice");
    // Not another site's, another screen, or a record's sub-page.
    expect(chatRecordLink(`https://elsewhere.example/quotes/${QUOTE}`, ORIGIN)).toBeNull();
    expect(chatRecordLink(`${ORIGIN}/schedule`, ORIGIN)).toBeNull();
    expect(chatRecordLink(`${ORIGIN}/quotes/new`, ORIGIN)).toBeNull();
    expect(chatRecordLink(`${ORIGIN}/quotes/${QUOTE}/print`, ORIGIN)).toBeNull();
  });

  it("read the record a Client Hub link is for, only for this business", () => {
    const link = hubLink({ c: CO, t: "quote", id: QUOTE, exp: 2_000_000_000 });
    expect(chatRecordLink(link, ORIGIN, CO)).toEqual({ kind: "quote", id: QUOTE, hub: true });
    expect(chatRecordLink(hubLink({ c: CO, t: "client", id: QUOTE, exp: 1 }), ORIGIN, CO)?.kind).toBe("client");
    expect(chatRecordLink(link, ORIGIN, "9f000000-0000-4000-8000-000000000009")).toBeNull();
    expect(chatRecordLink(hubLink({ c: CO, t: "unsub", id: QUOTE }), ORIGIN, CO)).toBeNull();
    expect(chatRecordLink(`${ORIGIN}/hub/not-a-token`, ORIGIN, CO)).toBeNull();
    expect(chatRecordLink(`${ORIGIN}/hub/${base64url("[1,2]")}.x`, ORIGIN, CO)).toBeNull();
  });

  it("get a card under the message, at most three, not for this Crewtavo's other screens", () => {
    const body = `${ORIGIN}/schedule then https://a.example ${ORIGIN}/quotes/${QUOTE} https://b.example https://c.example https://d.example`;
    expect(cardLinks(body, ORIGIN, CO).map((l) => l.href)).toEqual(["https://a.example", `${ORIGIN}/quotes/${QUOTE}`, "https://b.example"]);
    expect(cardLinks(body, ORIGIN, CO)[1]!.record?.kind).toBe("quote");
  });

  it("make a message's own address", () => {
    expect(chatMessageLink(`${ORIGIN}/`, "ch1", "m1")).toBe(`${ORIGIN}/chat/ch1?message=m1`);
  });
});

describe("search marks", () => {
  const hits = (text: string, query: string) => markMatches(text, query).filter((p) => p.hit).map((p) => p.text);

  it("split a search into its words as the database does", () => {
    expect(searchWords("  Gate-code, 4411!  gate ")).toEqual(["gate", "code", "4411"]);
    expect(searchWords("")).toEqual([]);
  });

  it("mark each word, its start and a word found inside another", () => {
    expect(hits("The gate code is 4411", "GATE code")).toEqual(["gate code"]);
    expect(hits("The code for the gate", "GATE code")).toEqual(["code", "gate"]);
    expect(hits("Fences at Maple Ct", "fenc")).toEqual(["Fences"]);
    expect(hits("Fence at Maple Ct", "fences")).toEqual(["Fence"]);
    expect(hits("Driveway gravel", "way")).toEqual(["way"]);
    // A short word only marks the start of words.
    expect(hits("a banana at Alma's", "a")).toEqual(["a", "at", "Alma"]);
    expect(markMatches("No match here", "zebra")).toEqual([{ text: "No match here", hit: false }]);
  });

  it("keep the text as written", () => {
    expect(markMatches("Gate code", "code").map((p) => p.text).join("")).toBe("Gate code");
  });

  it("cut a long result around the first word found", () => {
    const long = `${"Lots of words before. ".repeat(20)}The gate code is 4411. ${"And after that. ".repeat(20)}`;
    const snippet = searchSnippet(long, "gate", 120);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("The gate code is 4411");
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(searchSnippet("Short and sweet", "sweet")).toBe("Short and sweet");
    expect(searchSnippet(`gate ${"x ".repeat(200)}`, "gate", 50).startsWith("gate")).toBe(true);
  });
});
