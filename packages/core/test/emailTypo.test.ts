import { describe, expect, it } from "vitest";
import { emailTypo } from "../src/email";

describe("emailTypo", () => {
  it("catches slips on the big mailboxes", () => {
    expect(emailTypo("jo@gmial.com")).toBe("jo@gmail.com");
    expect(emailTypo("jo@gmal.com")).toBe("jo@gmail.com");
    expect(emailTypo("jo@hotmial.com")).toBe("jo@hotmail.com");
    expect(emailTypo("jo@outlok.com")).toBe("jo@outlook.com");
    expect(emailTypo("jo@yahoo.con")).toBe("jo@yahoo.com");
    expect(emailTypo("jo@gmail.co")).toBe("jo@gmail.com");
    expect(emailTypo("jo@comcast.ner")).toBe("jo@comcast.net");
    expect(emailTypo(" Jo.Rivera@Gmial.com ")).toBe("Jo.Rivera@gmail.com");
  });

  it("keeps the country ending on a slip that has one", () => {
    expect(emailTypo("jo@yaho.co.uk")).toBe("jo@yahoo.co.uk");
  });

  it("fixes an ending that doesn't exist on any domain", () => {
    expect(emailTypo("jo@acme.con")).toBe("jo@acme.com");
  });

  it("leaves real addresses alone", () => {
    for (const email of ["jo@gmail.com", "jo@yahoo.co.uk", "jo@email.com", "jo@mail.com", "jo@acme.com", "jo@lime.com", "jo@aim.com", "jo@gmx.com", "jo@me.com", "jo@hotmail.fr", "jo@acme.co", "jo@verizon.net", "jo@icloud.com"]) {
      expect(emailTypo(email), email).toBeNull();
    }
  });

  it("says nothing until there's a domain to look at", () => {
    for (const email of ["", "jo", "jo@", "jo@gmail", "jo@gmail.", "@gmial.com"]) expect(emailTypo(email), email).toBeNull();
  });
});
