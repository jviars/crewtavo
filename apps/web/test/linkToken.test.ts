/**
 * A signed link a text or chat app took the sentence's full stop (or a bracket) into still opens:
 * the Client Hub, a referral link, a sub's paperwork link and an unsubscribe link all read the
 * token's two parts and nothing more (lib/linkToken.ts).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { linkToken } from "../src/lib/linkToken";

describe("a link's token", () => {
  it("is its two parts, whatever came after them", () => {
    for (const raw of ["eyJj.c2ln", "eyJj.c2ln.", "eyJj.c2ln)", "eyJj.c2ln,", "eyJj.c2ln.1"]) expect(linkToken(raw), raw).toBe("eyJj.c2ln");
    // Anything else (a test page's word, say) is left as it is.
    expect(linkToken("test")).toBe("test");
  });

  it("is how every page opened by a signed link reads it", () => {
    for (const page of ["features/public/ReferralPage.tsx", "features/public/PaperworkPage.tsx", "features/public/UnsubscribePage.tsx"]) {
      const source = readFileSync(new URL(`../src/${page}`, import.meta.url), "utf8");
      expect(source, page).toMatch(/const token = linkToken\(raw\);/);
    }
  });
});
