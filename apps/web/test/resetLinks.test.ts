/**
 * "Reset this client's links" on a client's page (features/clients/resetLinks.ts): the office sees
 * it, it says what it does in one sentence before it does it, and it asks the server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import { RESET_LINKS_BODY, RESET_LINKS_LABEL, resetLinksPath } from "../src/features/clients/resetLinks";

const page = readFileSync(fileURLToPath(new URL("../src/features/clients/ClientPage.tsx", import.meta.url)), "utf8");

describe("resetting a client's links from their page", () => {
  it("is in the client's menu for the office only, under Copy Client Hub link", () => {
    expect(RESET_LINKS_LABEL).toBe("Reset this client's links");
    const copy = page.indexOf('label: "Copy Client Hub link"');
    const reset = page.indexOf("{ label: RESET_LINKS_LABEL, icon: \"refresh\", onSelect: resetClientLinks, hidden: !isOffice }");
    expect(copy).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(copy);
    expect(page).toContain('const isOffice = hasRole(session, "admin", "office");');
  });

  it("says what it does in one sentence, and waits for a yes", () => {
    expect(RESET_LINKS_BODY.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(RESET_LINKS_BODY).toMatch(/quote, invoice and Client Hub link/);
    expect(RESET_LINKS_BODY).toMatch(/stops opening/);
    expect(page).toContain("if (await confirm({ title: `Reset ${c.display_name}'s links?`, body: RESET_LINKS_BODY, confirmLabel: \"Reset links\", danger: true })) resetLinks.mutate();");
  });

  it("asks the server, which ends the links and notes it on the timeline", () => {
    expect(resetLinksPath("c1")).toBe("/clients/c1/links/reset");
    expect(page).toContain("api.post<{ reset_at: string }>(resetLinksPath(id))");
    expect(page).toContain('queryClient.invalidateQueries({ queryKey: ["client", id, "messages"] })');
  });
});
