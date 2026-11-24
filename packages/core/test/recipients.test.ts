import { describe, expect, it } from "vitest";
import { clientRecipients, contactMessages, phoneMatchKey, recipientNames, sendChoices, uniqueAddresses, type RecipientContact } from "../src/recipients";

const client = { display_name: "Pat Lee", email: "pat@example.com", phone: "(540) 555-0111", sms_opt_out_at: null };
const contact = (id: string, fields: Partial<RecipientContact>): RecipientContact => ({ id, name: id, email: null, phone: null, notify_email: true, notify_sms: true, ...fields });
const mo = contact("Mo Manager", { email: "mo@example.com", phone: "540-555-0122" });
const sam = contact("Sam Spouse", { email: "sam@example.com", phone: "+1 540 555 0133" });
const on = { contactsOn: true };
const to = (list: Array<{ to: string }>) => list.map((r) => r.to);

describe("who a client's message goes to", () => {
  it("is the client, then every contact ticked for that kind of message", () => {
    expect(clientRecipients("email", client, [mo, sam], on)).toEqual([
      { to: "pat@example.com", name: "Pat Lee", contact_id: null },
      { to: "mo@example.com", name: "Mo Manager", contact_id: "Mo Manager" },
      { to: "sam@example.com", name: "Sam Spouse", contact_id: "Sam Spouse" },
    ]);
    expect(to(clientRecipients("sms", client, [mo, sam], on))).toEqual(["(540) 555-0111", "540-555-0122", "+1 540 555 0133"]);
  });

  it("leaves out a contact who isn't ticked for it, or has nowhere to send it", () => {
    const emailOnly = contact("Emails", { email: "e@example.com", phone: "540-555-0144", notify_sms: false });
    const textOnly = contact("Texts", { email: "t@example.com", phone: "540-555-0155", notify_email: false });
    const nothing = contact("Nothing", {});
    expect(to(clientRecipients("email", client, [emailOnly, textOnly, nothing], on))).toEqual(["pat@example.com", "e@example.com"]);
    expect(to(clientRecipients("sms", client, [emailOnly, textOnly, nothing], on))).toEqual(["(540) 555-0111", "540-555-0155"]);
  });

  it("sends to each address or number once, however it's written", () => {
    const again = contact("Pat at work", { email: " PAT@Example.com ", phone: "+1 (540) 555-0111" });
    const twice = contact("Mo again", { email: "MO@example.com", phone: "1-540-555-0122" });
    expect(to(clientRecipients("email", client, [again, mo, twice], on))).toEqual(["pat@example.com", "mo@example.com"]);
    expect(to(clientRecipients("sms", client, [again, mo, twice], on))).toEqual(["(540) 555-0111", "540-555-0122"]);
  });

  it("is the client alone while the company hasn't turned contacts on", () => {
    expect(to(clientRecipients("email", client, [mo, sam], { contactsOn: false }))).toEqual(["pat@example.com"]);
    expect(to(clientRecipients("sms", client, [mo, sam], { contactsOn: false }))).toEqual(["(540) 555-0111"]);
  });

  it("reaches a contact when the client has no address or number of their own", () => {
    const bare = { display_name: "Pat Lee", email: null, phone: " " };
    expect(to(clientRecipients("email", bare, [mo], on))).toEqual(["mo@example.com"]);
    expect(to(clientRecipients("sms", bare, [mo], on))).toEqual(["540-555-0122"]);
    expect(clientRecipients("email", bare, [], on)).toEqual([]);
  });

  it("never emails a stand-in address or something that isn't one", () => {
    const standIn = contact("Stand-in", { email: "sub-123@subs.crewtavo.invalid" });
    const typo = contact("Typo", { email: "not an address" });
    expect(to(clientRecipients("email", { ...client, email: "nobody@x.invalid" }, [standIn, typo, mo], on))).toEqual(["mo@example.com"]);
  });

  describe("after a STOP", () => {
    it("the client's own takes their phone off, and any contact kept under that number, but not other contacts", () => {
      const stopped = { ...client, sms_opt_out_at: "2026-11-01T12:00:00Z" };
      const same = contact("Pat's cell again", { phone: "5405550111" });
      expect(to(clientRecipients("sms", stopped, [same, mo], on))).toEqual(["540-555-0122"]);
      // Emails aren't texts.
      expect(to(clientRecipients("email", stopped, [mo], on))).toEqual(["pat@example.com", "mo@example.com"]);
    });

    it("a contact's takes that number off wherever it's kept, and leaves the rest", () => {
      const stops = { contactsOn: true, stopped: [phoneMatchKey(mo.phone)] };
      expect(to(clientRecipients("sms", client, [mo, sam], stops))).toEqual(["(540) 555-0111", "+1 540 555 0133"]);
      // The client's own number in the list stops the client too, flag or no flag.
      expect(to(clientRecipients("sms", client, [mo], { contactsOn: true, stopped: ["5405550111"] }))).toEqual(["540-555-0122"]);
      expect(clientRecipients("sms", client, [], { contactsOn: false, stopped: ["5405550111"] })).toEqual([]);
    });
  });
});

describe("comparing phone numbers", () => {
  it("reads one number the same however it's written", () => {
    for (const spelling of ["540-555-0111", "(540) 555-0111", "+1 540 555 0111", "15405550111", "1 (540) 555.0111"]) expect(phoneMatchKey(spelling)).toBe("5405550111");
    expect(phoneMatchKey("+44 20 7946 0958")).toBe("2079460958");
  });

  it("reads a UK number kept with its 0 as Twilio's +44 for it, so a STOP from it holds", () => {
    for (const spelling of ["07700 900123", "07700 900 123", "+44 7700 900123", "0044 7700 900123", "+447700900123"]) expect(phoneMatchKey(spelling), spelling).toBe("7700900123");
    expect(phoneMatchKey("020 7946 0958")).toBe(phoneMatchKey("+442079460958"));
    const uk = { display_name: "Pat Lee", email: null, phone: "07700 900123", sms_opt_out_at: null };
    expect(clientRecipients("sms", uk, [], { contactsOn: true, stopped: [phoneMatchKey("+447700900123")] })).toEqual([]);
  });

  it("has nothing for what isn't a number", () => {
    for (const nothing of [null, undefined, "", "call the office", "555-01"]) expect(phoneMatchKey(nothing)).toBe("");
  });
});

describe("the company's switch", () => {
  it("is on for a company with nothing saved, which is a new one", () => {
    expect(contactMessages({})).toEqual({ enabled: true, pending: false });
    expect(contactMessages(null)).toEqual({ enabled: true, pending: false });
  });

  it("is off and waiting for an answer for a company that had contacts before", () => {
    expect(contactMessages({ contact_messages: { enabled: false, pending: true } })).toEqual({ enabled: false, pending: true });
  });

  it("is settled once someone answers, either way", () => {
    expect(contactMessages({ contact_messages: { enabled: true, pending: false } })).toEqual({ enabled: true, pending: false });
    expect(contactMessages({ contact_messages: { enabled: false, pending: false } })).toEqual({ enabled: false, pending: false });
    // On is never still pending.
    expect(contactMessages({ contact_messages: { enabled: true, pending: true } })).toEqual({ enabled: true, pending: false });
  });
});

describe("the Send dialog's choices", () => {
  it("offers the client and every contact with an address, ticking whoever would get it anyway", () => {
    const unticked = contact("Billing", { email: "billing@example.com", notify_email: false });
    expect(sendChoices("email", client, [mo, unticked], on)).toEqual([
      { to: "pat@example.com", name: "Pat Lee", contact_id: null, ticked: true },
      { to: "mo@example.com", name: "Mo Manager", contact_id: "Mo Manager", ticked: true },
      { to: "billing@example.com", name: "Billing", contact_id: "Billing", ticked: false },
    ]);
  });

  it("ticks only the client while contacts are off for the company", () => {
    expect(sendChoices("email", client, [mo], { contactsOn: false }).map((c) => [c.to, c.ticked])).toEqual([["pat@example.com", true], ["mo@example.com", false]]);
  });

  it("shows a number that texted STOP, unticked and marked", () => {
    const stopped = { ...client, sms_opt_out_at: "2026-11-01T12:00:00Z" };
    expect(sendChoices("sms", stopped, [mo, sam], { contactsOn: true, stopped: [phoneMatchKey(sam.phone)] })).toEqual([
      { to: "(540) 555-0111", name: "Pat Lee", contact_id: null, ticked: false, blocked: "Texts off" },
      { to: "540-555-0122", name: "Mo Manager", contact_id: "Mo Manager", ticked: true },
      { to: "+1 540 555 0133", name: "Sam Spouse", contact_id: "Sam Spouse", ticked: false, blocked: "Texts off" },
    ]);
  });
});

describe("the addresses a send names", () => {
  it("are tidied: trimmed, blanks dropped, each once", () => {
    expect(uniqueAddresses("email", [" pat@example.com ", "", "PAT@example.com", null, "mo@example.com"])).toEqual(["pat@example.com", "mo@example.com"]);
    expect(uniqueAddresses("sms", ["540-555-0111", "+1 (540) 555-0111", " 540 555 0122"])).toEqual(["540-555-0111", "540 555 0122"]);
  });
});

describe("who a message went to, in a line", () => {
  it("names up to three, then counts the rest", () => {
    const people = ["Ana", "Bo", "Cy", "Di"].map((name) => ({ to: `${name.toLowerCase()}@example.com`, name }));
    expect(recipientNames(people.slice(0, 1))).toBe("Ana");
    expect(recipientNames(people.slice(0, 2))).toBe("Ana and Bo");
    expect(recipientNames(people.slice(0, 3))).toBe("Ana, Bo and Cy");
    expect(recipientNames(people)).toBe("Ana, Bo and 2 others");
    expect(recipientNames([{ to: "typed@example.com" }])).toBe("typed@example.com");
  });
});
