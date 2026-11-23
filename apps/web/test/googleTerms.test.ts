/**
 * The notice Google asks an app that uses Google Maps to give: the Crewtavo Terms say the app
 * includes Google Maps features and content and whose terms they come under, with both links, and
 * Settings → Maps says the same under the Google key. And the terms' version follows the text, so
 * owners and admins agree again when it changes.
 */
import { readFileSync } from "node:fs";
import { GOOGLE_MAPS_TERMS_URL, GOOGLE_PRIVACY_URL, TERMS_VERSION } from "@crewtavo/core/terms";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const terms = read("../../../TERMS");
/** The file's paragraphs as sentences on one line each, as the app flows them to read. */
const flowed = terms.replace(/\n +/g, " ");

describe("the Google Maps notice", () => {
  it("is in the Crewtavo Terms, with Google's two links", () => {
    expect(GOOGLE_MAPS_TERMS_URL).toBe("https://maps.google.com/help/terms_maps/");
    expect(GOOGLE_PRIVACY_URL).toBe("https://policies.google.com/privacy");
    expect(flowed).toContain("Crewtavo includes Google Maps features and content.");
    expect(flowed).toContain(`subject to the then-current versions of the Google Maps/Google Earth Additional Terms of Service at ${GOOGLE_MAPS_TERMS_URL} and the Google Privacy Policy at ${GOOGLE_PRIVACY_URL}.`);
  });

  it("keeps the terms' version line with the version people agree to, and the file readable at 100 characters", () => {
    expect(terms.split("\n")[1]).toBe(`Version ${TERMS_VERSION}`);
    expect(terms.split("\n").every((line) => line.length <= 100)).toBe(true);
  });

  it("is under the Google key in Settings → Maps, key or no key", () => {
    const settings = read("../src/features/settings/MapsSettings.tsx");
    expect(settings).toContain("Google Maps features and content in Crewtavo are subject to the");
    expect(settings).toContain('<a href={GOOGLE_MAPS_TERMS_URL} target="_blank" rel="noreferrer">Google Maps/Google Earth Additional Terms of Service</a>');
    expect(settings).toContain('<a href={GOOGLE_PRIVACY_URL} target="_blank" rel="noreferrer">Google Privacy Policy</a>');
    // Shown whether or not the company has saved a key of its own (the server's may be in use).
    expect(settings).toContain('{footnote && <p className="set-note">{footnote}</p>}');
    expect(settings.indexOf("{set && children}")).toBeLessThan(settings.indexOf("{footnote && "));
  });
});
