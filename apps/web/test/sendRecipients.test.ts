/**
 * Who the Send dialog sends a quote or invoice to (features/quotes/sendRecipients.ts): the ticked
 * people and typed addresses as one list, what stops it going, and the body it posts.
 */
import { describe, expect, it } from "vitest";
import { messageFrom, messagePeople } from "../src/features/clients/messagePeople";
import { listWords, ownChoices, sendList, sendListProblem, sendPayload, typedAddresses } from "../src/features/quotes/sendRecipients";

describe("the list a send goes to", () => {
  it("is everyone ticked, then anyone typed, each once", () => {
    expect(sendList("email", ["pat@example.com", "mo@example.com"], "sam@example.com, PAT@example.com")).toEqual(["pat@example.com", "mo@example.com", "sam@example.com"]);
    expect(sendList("sms", ["(540) 555-0111"], "+1 540 555 0111")).toEqual(["(540) 555-0111"]);
    expect(sendList("email", [], "  ")).toEqual([]);
  });

  it("takes several typed emails apart by commas, semicolons, spaces or lines", () => {
    expect(typedAddresses("email", "a@x.com, b@x.com;c@x.com\nd@x.com e@x.com")).toEqual(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);
    // A phone number has spaces of its own.
    expect(typedAddresses("sms", "(540) 555-0111, 540 555 0122")).toEqual(["(540) 555-0111", "540 555 0122"]);
  });

  it("can't be empty, too long, or hold something that isn't an address or number", () => {
    expect(sendListProblem("email", [])).toBe("Pick who to email, or add an address.");
    expect(sendListProblem("sms", [])).toBe("Pick who to text, or add a number.");
    expect(sendListProblem("email", ["pat@example.com", "mo at example"])).toBe("mo at example isn't an email address.");
    expect(sendListProblem("sms", ["540-555-0111", "ext 12"])).toBe("ext 12 isn't a phone number.");
    const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    expect(sendListProblem("email", eleven)).toBe("Send it to 10 people at most.");
    expect(sendListProblem("email", eleven.slice(0, 10))).toBeNull();
    expect(sendListProblem("sms", ["540-555-0111"])).toBeNull();
  });
});

describe("what the dialog posts", () => {
  it("names everyone, and the first one again for a server from before it took a list", () => {
    expect(sendPayload({ channel: "email", list: ["pat@example.com", "mo@example.com"], subject: " Quote #7 ", message: " Thanks " })).toEqual({
      channel: "email", to: "pat@example.com", recipients: ["pat@example.com", "mo@example.com"], subject: "Quote #7", message: "Thanks",
    });
  });

  it("leaves the subject off a text, and everyone off a link", () => {
    expect(sendPayload({ channel: "sms", list: ["540-555-0111"], subject: "Quote #7", message: "" })).toEqual({ channel: "sms", to: "540-555-0111", recipients: ["540-555-0111"], subject: undefined, message: undefined });
    expect(sendPayload({ channel: "link", list: ["pat@example.com"], subject: "Quote #7", message: "" })).toEqual({ channel: "link", message: undefined });
  });
});

describe("before the server says who the contacts are", () => {
  it("offers the client's own email and phone, as the dialog always did", () => {
    const offered = ownChoices({ email: " pat@example.com ", phone: "(540) 555-0111" });
    expect(offered.email).toEqual([{ to: "pat@example.com", name: "The client", contact_id: null, ticked: true }]);
    expect(offered.sms).toEqual([{ to: "(540) 555-0111", name: "The client", contact_id: null, ticked: true }]);
    expect(ownChoices({ email: null, phone: "" })).toMatchObject({ email: [], sms: [] });
  });

  it("shows a client who texted STOP as not to be texted", () => {
    expect(ownChoices({ email: null, phone: "540-555-0111", textsOffSince: "2026-11-01T12:00:00Z" }).sms).toEqual([{ to: "540-555-0111", name: "The client", contact_id: null, ticked: false, blocked: "Texts off" }]);
  });
});

describe("saying who got it", () => {
  it("lists them in a sentence", () => {
    expect(listWords(["a@x.com"])).toBe("a@x.com");
    expect(listWords(["a@x.com", "b@x.com"])).toBe("a@x.com and b@x.com");
    expect(listWords(["a@x.com", "b@x.com", "c@x.com"])).toBe("a@x.com, b@x.com and c@x.com");
  });

  it("reads one message to several people as one line on the timeline", () => {
    const sent = messagePeople({
      direction: "out",
      recipients: [{ to: "pat@example.com", name: "Pat Lee" }, { to: "mo@example.com", name: "Mo Manager" }, { to: "typed@example.com", name: "typed@example.com" }, { to: "sam@example.com", name: "Sam Spouse", failed: true }],
    });
    expect(sent.to).toBe("Pat Lee, Mo Manager and typed@example.com");
    expect(sent.toFull).toBe("Pat Lee (pat@example.com)\nMo Manager (mo@example.com)\ntyped@example.com");
    expect(sent.missed).toBe("sam@example.com");
  });

  it("says nothing for a message from before this was kept, a note, or one that reached nobody", () => {
    expect(messagePeople({ direction: "out", recipients: null })).toEqual({ to: null, toFull: null, missed: null, why: null });
    expect(messagePeople({ direction: "internal", recipients: [{ to: "pat@example.com" }] }).to).toBeNull();
    // Not delivered shows for that one already.
    expect(messagePeople({ direction: "out", recipients: [{ to: "pat@example.com", failed: true }] })).toEqual({ to: null, toFull: null, missed: null, why: null });
    expect(messagePeople({ direction: "out", recipients: "pat@example.com" }).to).toBeNull();
  });

  it("says why a text didn't arrive when the text provider said, once for the same reason", () => {
    const off = "Their phone is off or out of reach (Twilio error 30003).";
    expect(messagePeople({ direction: "out", recipients: [{ to: "(540) 555-0163", name: "Pat Lee", failed: true, reason: off }] }).why).toBe(off);
    const several = messagePeople({ direction: "out", recipients: [{ to: "(540) 555-0163", name: "Pat Lee" }, { to: "(540) 555-0333", name: "Mo", failed: true, reason: off }, { to: "(540) 555-0444", name: "Sam", failed: true, reason: off }, { to: "(540) 555-0555", name: "Al", failed: true, reason: 7 }] });
    expect([several.missed, several.why]).toEqual(["(540) 555-0333, (540) 555-0444, (540) 555-0555", off]);
  });

  it("names the contact a text came from, and nobody for the client's own", () => {
    expect(messageFrom({ direction: "in", from_name: " Mo Manager " })).toBe("Mo Manager");
    expect(messageFrom({ direction: "in", from_name: null })).toBeNull();
    expect(messageFrom({ direction: "out", from_name: "Mo Manager" })).toBeNull();
  });
});
