/**
 * Calls on a business's Quo number in the web app: in words on a client's timeline and in Messages
 * (features/clients/callWords.ts), and unknown numbers that called (features/messages/unknownTexts.ts).
 */
import { callHeadline, type CallDetails } from "@crewtavo/core/calls";
import { describe, expect, it } from "vitest";
import { callIcon, callIsLong, callPreview, callTitle, callView, foldedCall } from "../src/features/clients/callWords";
import { byNumber, kindsOf, movesWords, numbersFor } from "../src/features/messages/unknownTexts";

const call = (outcome: CallDetails["outcome"], seconds: number | null, more: Partial<CallDetails> = {}): CallDetails => ({ outcome, seconds, quo_id: "AC1", ...more });

describe("a call in words", () => {
  it("says how it went and who with", () => {
    expect(callTitle("in", call("missed", null), "Ana")).toBe("Missed call from Ana");
    expect(callTitle("in", call("voicemail", 42), "Ana")).toBe("Voicemail from Ana · 42 sec");
    expect(callTitle("in", call("answered", 240), "Ana")).toBe("Call with Ana · 4 min");
    expect(callTitle("out", call("answered", 240), "Ana")).toBe("Call to Ana · 4 min");
    expect(callTitle("out", call("missed", 12), "Ana")).toBe("Call to Ana, not answered");
    expect(callTitle("out", call("voicemail", 20), "Ana")).toBe("Left a voicemail for Ana · 20 sec");
    // No length known, and a call that lasted hours.
    expect(callTitle("in", call("answered", null), "Ana")).toBe("Call with Ana");
    expect(callTitle("in", call("answered", 3900), "Ana")).toBe("Call with Ana · 1 hr 5 min");
  });

  it("with nobody named, says what the server keeps as the call's words", () => {
    for (const direction of ["in", "out"])
      for (const outcome of ["answered", "missed", "voicemail"] as const)
        for (const seconds of [null, 42, 240]) {
          expect(callTitle(direction, call(outcome, seconds))).toBe(callHeadline(direction, call(outcome, seconds)));
          expect(callTitle(direction, call(outcome, seconds), "  ")).toBe(callHeadline(direction, call(outcome, seconds)));
        }
  });

  it("reads what Quo added, and nothing from a call whose details weren't kept", () => {
    const view = callView({ direction: "in", call: call("voicemail", 42, { voicemail: "Hi, it's Ana about the gutters", summary: ["Wants a quote"], next_steps: ["Call back"] }) }, "Ana");
    expect(view).toEqual({ outcome: "voicemail", title: "Voicemail from Ana · 42 sec", voicemail: "Hi, it's Ana about the gutters", summary: ["Wants a quote"], steps: ["Call back"] });
    expect(callView({ direction: "in", call: null })).toBeNull();
    expect(callView({ direction: "in", call: { outcome: "ringing" } })).toBeNull();
    expect(callIcon("missed")).toBe("phoneMissed");
    expect(callIcon("voicemail")).toBe("voicemail");
    expect(callIcon("answered")).toBe("phone");
    expect(callIcon(undefined)).toBe("phone");
  });

  it("is one line in a list: what it was, then the voicemail or the summary's first line", () => {
    expect(callPreview({ direction: "in", call: call("missed", null) })).toBe("Missed call");
    expect(callPreview({ direction: "in", call: call("voicemail", 42, { voicemail: "Call me back" }) })).toBe("Voicemail · 42 sec: “Call me back”");
    expect(callPreview({ direction: "out", call: call("answered", 240, { summary: ["Booked for Tuesday", "Gate code 1234"] }) })).toBe("Call · 4 min: Booked for Tuesday");
    expect(callPreview({ direction: "in", call: null, body: "Missed call" })).toBe("Missed call");
  });

  it("folds a long one on the timeline to its first lines", () => {
    const short = { voicemail: "Call me", summary: ["a", "b", "c"], steps: ["d", "e"] };
    expect(callIsLong(short)).toBe(false);
    expect(callIsLong({ ...short, voicemail: "x".repeat(321) })).toBe(true);
    const long = { voicemail: null, summary: ["a", "b", "c", "d", "e"], steps: ["f", "g"] };
    expect(callIsLong(long)).toBe(true);
    expect(foldedCall(long)).toEqual({ voicemail: null, summary: ["a", "b", "c"], steps: [] });
  });
});

describe("unknown numbers that called", () => {
  const row = (id: string, from_phone: string, channel: string, created_at: string) => ({ id, from_phone, phone_key: from_phone.slice(-10), body: channel === "call" ? "Missed call" : "Hi", created_at, channel });
  const rows = [
    row("4", "+15405550163", "call", "2026-11-26T15:00:00Z"),
    row("3", "+15405550177", "sms", "2026-11-26T14:00:00Z"),
    row("2", "+15405550163", "sms", "2026-11-26T13:00:00Z"),
    row("1", "+15405550188", "call", "2026-11-26T12:00:00Z"),
  ];

  it("count each number's texts and calls", () => {
    expect(byNumber(rows).map((n) => [n.from_phone, n.channel, n.texts, n.calls])).toEqual([
      ["+15405550163", "call", 1, 1],
      ["+15405550177", "sms", 1, 0],
      ["+15405550188", "call", 0, 1],
    ]);
    // Rows from before calls had no channel: texts.
    expect(byNumber([{ id: "1", from_phone: "+15405550163", phone_key: "5405550163", body: "Hi", created_at: "2026-11-26T12:00:00Z" }])[0]).toMatchObject({ texts: 1, calls: 0 });
  });

  it("show under each filter as they belong", () => {
    const numbers = byNumber(rows);
    const shown = (filter: string, term = "") => numbersFor(numbers, filter, term).map((n) => n.from_phone.slice(-4));
    expect(shown("all")).toEqual(["0163", "0177", "0188"]);
    expect(shown("in")).toEqual(["0163", "0177", "0188"]);
    expect(shown("email")).toEqual([]);
    expect(shown("sms")).toEqual(["0163", "0177"]);
    expect(shown("calls")).toEqual(["0163", "0188"]);
    expect(shown("calls", "0188")).toEqual(["0188"]);
  });

  it("say what attaching moves", () => {
    expect(kindsOf(rows)).toEqual({ texts: 2, calls: 2 });
    expect(kindsOf([])).toEqual({ texts: 0, calls: 0 });
    expect(movesWords(0, 1)).toBe("Its call moves onto the client's timeline, and new texts and calls go there from now on.");
    expect(movesWords(0, 3)).toBe("Its 3 calls move onto the client's timeline, and new texts and calls go there from now on.");
    expect(movesWords(2, 1)).toBe("Its 2 texts and 1 call move onto the client's timeline, and new ones go there from now on.");
    expect(movesWords(1, 2)).toBe("Its 1 text and 2 calls move onto the client's timeline, and new ones go there from now on.");
  });
});
