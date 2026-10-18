import { readdirSync, readFileSync } from "node:fs";
import { MAIL_PRESETS, type MailPreset } from "@crewtavo/core/email";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderMark } from "../src/features/settings/EmailSettings";

const ASSETS = new URL("../src/assets/apps/", import.meta.url);
const readme = readFileSync(new URL("README.md", ASSETS), "utf8");
const mark = (id: MailPreset["id"]) => renderToStaticMarkup(createElement(ProviderMark, { preset: id }));

/** Vite inlines small SVGs as data URLs (quotes made single, white space squeezed); this finds which file one is. */
const squeeze = (svg: string) => svg.trim().replace(/>\s+</g, "><").replaceAll('"', "'").replace(/\s+/g, " ");
const FILES = readdirSync(ASSETS).filter((f) => f.endsWith(".svg")).map((name) => ({ name, svg: readFileSync(new URL(name, ASSETS), "utf8") }));
function logoFile(src: string) {
  const url = src.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  if (!url.startsWith("data:")) return FILES.find((f) => url.endsWith(`/assets/apps/${f.name}`));
  const svg = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  return FILES.find((f) => squeeze(f.svg) === svg);
}

describe("email provider logos", () => {
  it("shows each provider's own logo, decorative, from a clean file the README credits", () => {
    const used = new Set<string>();
    for (const preset of MAIL_PRESETS.filter((p) => p.id !== "other")) {
      const html = mark(preset.id);
      const src = html.match(/<img src="([^"]+)" alt=""\/>/)?.[1];
      expect(src, preset.label).toBeTruthy();
      expect(html, preset.label).toContain('aria-hidden="true"');
      expect(html, preset.label).not.toContain("lucide");
      const file = logoFile(src!);
      expect(file, preset.label).toBeDefined();
      expect(file!.svg, file!.name).toMatch(/^<svg [^>]*viewBox="[^"]+"/);
      expect(file!.svg, file!.name).not.toMatch(/<title|<metadata|<desc|sodipodi|inkscape|<!--/);
      expect(readme, file!.name).toContain(file!.name);
      used.add(file!.name);
    }
    // Gmail and Google Workspace get different logos (the M and the G); none is shared.
    expect(used.size).toBe(MAIL_PRESETS.length - 1);
  });

  it("keeps the mail icon for any other server", () => {
    const html = mark("other");
    expect(html).toContain("lucide-mail");
    expect(html).not.toContain("<img");
    expect(html).toContain('aria-hidden="true"');
  });
});
