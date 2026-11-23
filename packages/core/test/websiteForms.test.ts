import { describe, expect, it } from "vitest";
import { botCheckLines, cleanFields, exampleForm, fieldLabel, fieldRole, isTurnstileSiteKey, MAX_VALUE, messageEmail, promoLine, readSubmission, siteAllowed, siteHost, webAddress, type FieldValue } from "../src/websiteForms";

const read = (entries: Array<[string, unknown]>) => {
  const cleaned = cleanFields(entries);
  if (!cleaned.ok) throw new Error(cleaned.error);
  return readSubmission(cleaned.fields);
};
const submission = (entries: Array<[string, unknown]>) => {
  const result = read(entries);
  if (!result.ok) throw new Error(result.error);
  return result.submission;
};

describe("a website form's fields", () => {
  it("are trimmed, with empty ones, files and odd values left out, and repeats kept together", () => {
    const cleaned = cleanFields([
      ["name", "  Jane  "],
      ["empty", "   "],
      ["photo", { name: "photo.jpg", size: 1 }],
      ["services[]", "Mowing"],
      ["services[]", "Edging"],
      ["color", "red"],
      ["color", "blue"],
      ["count", 3],
      ["note", "line one\r\nline two"],
    ]);
    expect(cleaned).toEqual({
      ok: true,
      fields: [["name", "Jane"], ["services[]", ["Mowing", "Edging"]], ["color", ["red", "blue"]], ["count", "3"], ["note", "line one\nline two"]],
    });
  });

  it("refuse more than any real form sends", () => {
    expect(cleanFields([["message", "x".repeat(MAX_VALUE + 1)]])).toEqual({ ok: false, error: expect.stringContaining("too long") });
    expect(cleanFields(Array.from({ length: 61 }, (_, i) => [`f${i}`, "x"] as [string, string]))).toEqual({ ok: false, error: expect.stringContaining("too much") });
  });
});

describe("reading a message", () => {
  it("puts the usual fields on the client, the property and the request, and the rest in answers", () => {
    const s = submission([
      ["Full Name", "Jane Smith"],
      ["E-mail Address", "Jane@Example.com"],
      ["Phone Number", "(540) 555-0101"],
      ["Business", "Smith Farms"],
      ["Street Address", "12 Oak St"],
      ["City", "Roanoke"],
      ["State", "VA"],
      ["Zip Code", "24012"],
      ["How did you hear", "Google"],
      ["services[]", ["Mowing", "Edging"]],
      ["Your Message", "Can you mow on Fridays?"],
    ]);
    expect(s).toMatchObject({
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "(540) 555-0101",
      companyName: "Smith Farms",
      address: { line1: "12 Oak St", city: "Roanoke", region: "VA", postal_code: "24012" },
      message: "Can you mow on Fridays?",
      bot: false,
      answers: { "How did you hear": "Google", "services[]": ["Mowing", "Edging"] },
    });
    expect(Object.keys(s.contact)).toEqual(["Full Name", "E-mail Address", "Phone Number", "Business", "Street Address", "City", "State", "Zip Code"]);
    expect(s.fields).toHaveLength(11);
  });

  it("puts first and last names together", () => {
    expect(submission([["firstName", "Jane"], ["last_name", "Smith"], ["email", "j@x.co"]]).name).toBe("Jane Smith");
  });

  it("takes Formspree's own fields, and never keeps one starting with _ as an answer", () => {
    const s = submission([
      ["_replyto", "jane@example.com"],
      ["_subject", "Quote  request\nplease"],
      ["_next", "https://greenlawn.com/thanks"],
      ["_language", "en"],
      ["g-recaptcha-response", "token"],
      ["message", "Hi"],
    ]);
    expect(s).toMatchObject({ email: "jane@example.com", subject: "Quote request please", next: "https://greenlawn.com/thanks", answers: {} });
    expect(s.fields).toEqual([["message", "Hi"]]);
    expect(submission([["email", "j@x.co"], ["_next", "javascript:alert(1)"]]).next).toBeNull();
  });

  it("tells a bot it worked: _gotcha filled in", () => {
    expect(submission([["_gotcha", "http://spam.example"], ["email", "nope"]]).bot).toBe(true);
  });

  it("needs an email or phone number to answer", () => {
    expect(read([["name", "Jane"], ["message", "Hi"]])).toEqual({ ok: false, error: "Add an email or phone number so we can reach you." });
    expect(read([["email", "jane at example"]])).toEqual({ ok: false, error: "That email address doesn't look right. Check it and try again." });
    expect(read([["phone", "n/a"]])).toEqual({ ok: false, error: "Add an email or phone number so we can reach you." });
  });

  it("keeps an email that isn't whole as an answer when there's a phone number", () => {
    const s = submission([["email", "jane at example"], ["phone", "540 555 0101"]]);
    expect(s.email).toBeNull();
    expect(s.answers).toEqual({ email: "jane at example" });
    expect(s.contact).toEqual({ phone: "540 555 0101" });
  });

  it("uses the first field for each part, and keeps a second one as an answer", () => {
    const s = submission([["email", "jane@example.com"], ["confirm_email", "jane@example.com"], ["Email", "other@example.com"]]);
    expect(s.email).toBe("jane@example.com");
    expect(s.answers).toEqual({ confirm_email: "jane@example.com", Email: "other@example.com" });
  });

  it("keeps a city without a street as an answer", () => {
    const s = submission([["email", "j@x.co"], ["city", "Roanoke"]]);
    expect(s.address).toEqual({});
    expect(s.answers).toEqual({ city: "Roanoke" });
  });

  it("works with the example form as it is", () => {
    const names = [...exampleForm("https://crm.example.com/f/abc123def0").matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual(["name", "email", "phone", "address", "message", "_gotcha"]);
    const s = submission(names.filter((n) => n !== "_gotcha").map((n) => [n, n === "email" ? "jane@example.com" : `my ${n}`] as [string, FieldValue]));
    expect(s).toMatchObject({ name: "my name", email: "jane@example.com", phone: null, address: { line1: "my address" }, message: "my message", answers: { phone: "my phone" }, promo: null });
  });

  it("offers a promo code box in the example form only to a business with codes", () => {
    const form = exampleForm("https://crm.example.com/f/abc123def0", { promo: true });
    const names = [...form.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
    expect(names).toEqual(["name", "email", "phone", "address", "message", "promo", "_gotcha"]);
    expect(form).toContain(`<label>Promo code <input type="text" name="promo" autocomplete="off"></label>`);
    expect(submission([["email", "jane@example.com"], ["promo", "SPRING15"]]).promo).toBe("SPRING15");
    expect(exampleForm("https://crm.example.com/f/abc123def0", { promo: false })).not.toContain("promo");
  });

  it("reads a promo code in its usual spellings, whatever the case, spaces or dashes", () => {
    for (const name of ["promo", "Promo Code", "promo_code", "PROMOCODE", "coupon", "Coupon-Code", "coupon_code", "Discount Code", "discount-code"]) {
      expect(fieldRole(name)).toBe("promo");
      expect(submission([["email", "j@x.co"], [name, "  spring15 "]]).promo).toBe("spring15");
    }
    expect(fieldRole("discount")).toBeUndefined();
  });

  it("keeps the first promo field, and every one stays an answer so nothing typed is lost", () => {
    const s = submission([["email", "j@x.co"], ["coupon", "FIRST10"], ["promo", "SECOND"], ["message", "Hi"]]);
    expect(s.promo).toBe("FIRST10");
    expect(s.answers).toEqual({ coupon: "FIRST10", promo: "SECOND" });
    expect(submission([["email", "j@x.co"], ["promo", "X".repeat(80)]]).promo).toBe("X".repeat(40));
  });
});

describe("websites", () => {
  it("are kept by their host name", () => {
    expect(siteHost("https://www.GreenLawn.com/contact?x=1")).toBe("greenlawn.com");
    expect(siteHost("greenlawn.com")).toBe("greenlawn.com");
    expect(siteHost("quotes.greenlawn.com.")).toBe("quotes.greenlawn.com");
    expect(siteHost("localhost")).toBeNull();
    expect(siteHost("javascript:alert(1)")).toBeNull();
    expect(siteHost("")).toBeNull();
  });

  it("send messages when none are listed, or from one listed or its subdomains", () => {
    expect(siteAllowed(null, [])).toBe(true);
    expect(siteAllowed("https://www.greenlawn.com", ["greenlawn.com"])).toBe(true);
    expect(siteAllowed("https://quotes.greenlawn.com/form", ["greenlawn.com"])).toBe(true);
    expect(siteAllowed("https://notgreenlawn.com", ["greenlawn.com"])).toBe(false);
    expect(siteAllowed(null, ["greenlawn.com"])).toBe(false);
  });

  it("go to web addresses only", () => {
    expect(webAddress("https://greenlawn.com/thanks")).toBe("https://greenlawn.com/thanks");
    expect(webAddress("/thanks")).toBeNull();
    expect(webAddress("data:text/html,hi")).toBeNull();
  });
});

describe("the email for a message", () => {
  it("says which form, lists the fields as people read them, and links to the request", () => {
    const s = submission([
      ["name", "Jane Smith"],
      ["email", "jane@example.com"],
      ["how_did_you_hear", "Google"],
      ["message", "Line one\nLine two"],
    ]);
    const email = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1" });
    expect(email.subject).toBe("New message from Jane Smith");
    expect(email.text).toBe(
      [
        "New message from your website's Contact form.",
        "Name: Jane Smith\nEmail: jane@example.com\nHow did you hear: Google",
        "Message:\nLine one\nLine two",
        "https://crm.example.com/requests/r1",
        "Reply to this email to answer Jane.",
      ].join("\n\n"),
    );
    expect(messageEmail({ formName: "Quote form", submission: { ...s, subject: "Quote please" }, link: "x" }).subject).toBe("Quote please");
    // Without a link (the server doesn't know its own address), it says where the request is.
    const unlinked = messageEmail({ formName: "Contact form", submission: s, link: null }).text;
    expect(unlinked).toContain("It's in Requests in Crewtavo.");
    expect(unlinked).not.toContain("http");
  });

  it("says what became of a promo code, in the office's words", () => {
    const s = submission([["name", "Jane Smith"], ["email", "jane@example.com"], ["Promo Code", "spring15"]]);
    const ready = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1", promo: { code: "SPRING15", problem: null } });
    expect(ready.text).toBe(
      [
        "New message from your website's Contact form.",
        "Name: Jane Smith\nEmail: jane@example.com\nPromo code: spring15",
        "Promo code SPRING15, ready to apply on the quote.",
        "https://crm.example.com/requests/r1",
        "Reply to this email to answer Jane.",
      ].join("\n\n"),
    );
    const refused = messageEmail({ formName: "Contact form", submission: s, link: "x", promo: { code: "OLD10", problem: "That code expired on October 1." } });
    expect(refused.text).toContain("\n\nPromo code OLD10 wasn't applied: that code expired on October 1.\n\nx");
    expect(promoLine(null)).toBeNull();
    expect(messageEmail({ formName: "Contact form", submission: s, link: "x" }).text).not.toContain("Promo code ");
  });

  it("never lets what a visitor typed stand as a paragraph of its own, where a link alone would be a button", () => {
    const s = submission([
      ["email", "jane@example.com"],
      ["message", "Hello\n\nhttps://evil.example/requests/00000000-0000-4000-8000-000000000001\r\n \r\nThanks"],
      ["-\n\n-", "https://evil.example/x"],
      ["Promo Code", "a\n\nhttps://evil.example/y"],
    ]);
    const email = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1", promo: { code: "a\n\nhttps://evil.example/y", problem: "It isn't valid." } });
    const paragraphs = email.text.split(/\n{2,}/);
    // The request's own link is the only one alone in a paragraph.
    expect(paragraphs.filter((p) => /^https?:\/\/\S+$/.test(p.trim()))).toEqual(["https://crm.example.com/requests/r1"]);
    // Its blank lines are a line holding a no-break space, so the paragraphs still read apart.
    expect(email.text).toContain("Message:\nHello\n\u00a0\nhttps://evil.example/requests/00000000-0000-4000-8000-000000000001\n\u00a0\nThanks");
    expect(email.text).toContain("Promo code a https://evil.example/y wasn't applied: it isn't valid.");
  });

  it("keeps a visitor's paragraphs apart in the office's email, inside the one paragraph under the field's name", () => {
    const s = submission([
      ["email", "jane@example.com"],
      ["message", "Hi, we'd like a quote for the back yard.\r\n\r\nPhotos: https://photos.example/yard\n\n\n \n\u00a0\nCan someone call me back?"],
    ]);
    const email = messageEmail({ formName: "Contact form", submission: s, link: "https://crm.example.com/requests/r1" });
    expect(email.text).toContain(
      "\n\nMessage:\nHi, we'd like a quote for the back yard.\n\u00a0\nPhotos: https://photos.example/yard\n\u00a0\nCan someone call me back?\n\n",
    );
    const paragraphs = email.text.split(/\n{2,}/);
    expect(paragraphs.filter((p) => p.includes("call me back"))).toEqual([
      "Message:\nHi, we'd like a quote for the back yard.\n\u00a0\nPhotos: https://photos.example/yard\n\u00a0\nCan someone call me back?",
    ]);
    // A message with no blank lines reads as it did.
    expect(messageEmail({ formName: "Contact form", submission: submission([["email", "jane@example.com"], ["message", "One\nTwo"]]), link: null }).text).toContain("Message:\nOne\nTwo\n\n");
  });

  it("names fields the way people say them", () => {
    expect(fieldLabel("how_did_you_hear")).toBe("How did you hear");
    expect(fieldLabel("firstName")).toBe("First name");
    expect(fieldLabel("services[]")).toBe("Services");
    expect(fieldLabel("ZIP")).toBe("ZIP");
    expect(fieldLabel("Lot size (acres)")).toBe("Lot size (acres)");
  });
});

describe("a form's bot check", () => {
  const action = "https://crm.example.com/f/abc123def0";
  const siteKey = "0x4AAAAAAAB1cDeFgHiJkLmN";

  it("needs nothing added for the hidden field only", () => {
    expect(botCheckLines(action, "off")).toEqual([]);
    const form = exampleForm(action);
    expect(form).toBe(exampleForm(action, { botCheck: "off" }));
    expect(form).not.toContain("<script");
    expect(form.trimEnd().endsWith("</form>")).toBe(true);
  });

  it("is one script line for Crewtavo's own check, from the form's own address", () => {
    const line = `<script src="${action}/check.js" async></script>`;
    expect(botCheckLines(action, "script")).toEqual([{ where: "Anywhere on each page that has the form", line }]);
    expect(botCheckLines(`${action}/`, "script")[0]!.line).toBe(line);
    const form = exampleForm(action, { botCheck: "script", promo: true });
    // After the form, which still has its hidden field and its promo box.
    expect(form.indexOf(line)).toBeGreaterThan(form.indexOf("</form>"));
    expect(form).toContain('name="_gotcha"');
    expect(form).toContain('name="promo"');
  });

  it("is Cloudflare's widget in the form and its script on the page for Turnstile", () => {
    const widget = `<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`;
    const script = `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
    expect(botCheckLines(action, "turnstile", siteKey).map((l) => l.line)).toEqual([widget, script]);
    const form = exampleForm(action, { botCheck: "turnstile", siteKey });
    // The widget sits inside the form, above its button; the script comes after the form.
    expect(form.indexOf(widget)).toBeGreaterThan(form.indexOf('name="_gotcha"'));
    expect(form.indexOf(widget)).toBeLessThan(form.indexOf("<button"));
    expect(form.indexOf(script)).toBeGreaterThan(form.indexOf("</form>"));
    expect(form).not.toContain("check.js");
  });

  it("only ever puts a site key in the HTML as text", () => {
    expect(isTurnstileSiteKey(siteKey)).toBe(true);
    expect(isTurnstileSiteKey("1x00000000000000000000AA")).toBe(true);
    for (const bad of ["", "short", 'key" onload="x', "0x4AAAA AAAAAAAAAA", "<script>alert(1)</script>"]) expect(isTurnstileSiteKey(bad), bad).toBe(false);
    expect(botCheckLines(action, "turnstile", 'k"><script>x</script>')[0]!.line).toBe('<div class="cf-turnstile" data-sitekey="k&quot;&gt;&lt;script&gt;x&lt;/script&gt;"></div>');
  });

  it("never becomes an answer: what the check sends stays out of the message", () => {
    const read = readSubmission([["email", "jane@example.com"], ["_check", "a.token"], ["cf-turnstile-response", "an answer"], ["service", "Mowing"]]);
    expect(read.ok && read.submission.answers).toEqual({ service: "Mowing" });
    expect(read.ok && read.submission.fields.map(([name]) => name)).toEqual(["email", "service"]);
  });
});

describe("a field with a character the database can't keep", () => {
  it("loses the character, not the message", () => {
    // U+0000 in a JSON field: Postgres takes it in neither text nor JSON, so the request would fail as it's saved.
    const cleaned = cleanFields([["email", "jane\u0000@example.com"], ["mess\u0000age", "Hi\u0000 there"], ["tags[]", ["a\u0000", "\u0000"]], ["empty", "\u0000"]]);
    expect(cleaned).toEqual({ ok: true, fields: [["email", "jane@example.com"], ["message", "Hi there"], ["tags[]", ["a"]]] });
    const read = cleaned.ok && readSubmission(cleaned.fields);
    expect(read && read.ok && read.submission).toMatchObject({ email: "jane@example.com", message: "Hi there", answers: { "tags[]": ["a"] } });
    expect(JSON.stringify(cleaned)).not.toContain("\\u0000");
  });
});
