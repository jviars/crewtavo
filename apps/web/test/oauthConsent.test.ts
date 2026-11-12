/**
 * The connect screen for an AI assistant (features/auth/OAuthConsentPage.tsx, oauthConsent.ts): any
 * app can sign itself up as "Claude" with Claude's logo, so the screen shows where the connection
 * really leads, cautions when that isn't Claude's or ChatGPT's own address, and says plainly that
 * the app will read everything the person can see, and can't change anything until they allow it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OAuthConsentPage } from "../src/features/auth/OAuthConsentPage";
import { CAN_READ, CANT_CHANGE, consentDestination } from "../src/features/auth/oauthConsent";

vi.mock("../src/lib/session", () => ({ useSessionIfAny: () => null, onlySubs: () => false }));

describe("where a connection leads", () => {
  it("knows the addresses Claude's and ChatGPT's own connectors use", () => {
    expect(consentDestination("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", kind: "known", owner: "Claude", note: "Claude's own address." });
    expect(consentDestination("https://claude.com/api/mcp/auth_callback")).toMatchObject({ host: "claude.com", kind: "known", owner: "Claude" });
    expect(consentDestination("https://chatgpt.com/connector_platform_oauth_redirect")).toEqual({ host: "chatgpt.com", kind: "known", owner: "ChatGPT", note: "ChatGPT's own address." });
    expect(consentDestination("https://chatgpt.com/connector/oauth/abc123")).toMatchObject({ kind: "known", owner: "ChatGPT" });
  });

  it("isn't fooled by an address that only looks like one of them", () => {
    for (const address of [
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://evil.example/claude.ai/api/mcp/auth_callback",
      "https://claude.ai@evil.example/callback",
      "https://sub.claude.ai/api/mcp/auth_callback",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "http://claude.ai/api/mcp/auth_callback",
      "https://clаude.ai/api/mcp/auth_callback", // a Cyrillic а
      "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
    ]) {
      const d = consentDestination(address);
      expect(d.kind, address).toBe("other");
      expect(d.owner, address).toBeNull();
      expect(d.note, address).toContain("This isn't Claude's or ChatGPT's own address, whatever the app calls itself.");
    }
    expect(consentDestination("https://claude.ai.evil.example/cb").host).toBe("claude.ai.evil.example");
    expect(consentDestination("https://claude.ai@evil.example/cb").host).toBe("evil.example");
    expect(consentDestination("https://clаude.ai/cb").host).toMatch(/^xn--/);
  });

  it("says an app on this computer is that, with its own caution", () => {
    for (const address of ["http://localhost:53682/callback", "http://127.0.0.1:8976/oauth/callback", "http://[::1]:4000/cb"]) {
      const d = consentDestination(address);
      expect(d.kind, address).toBe("local");
      expect(d.note).toBe("That's an app on this computer, not Claude's or ChatGPT's own site. Allow it only if you started this from that app just now.");
    }
    expect(consentDestination("http://localhost:53682/callback").host).toBe("localhost:53682");
  });

  it("shows any other address, an app's own kind of link included, with the caution", () => {
    expect(consentDestination("https://connect.example.com:8443/cb?x=1")).toMatchObject({ host: "connect.example.com:8443", kind: "other" });
    expect(consentDestination("cursor://anysphere.cursor-mcp/oauth/callback")).toMatchObject({ host: "cursor://anysphere.cursor-mcp", kind: "other" });
    expect(consentDestination("not an address")).toMatchObject({ host: "not an address", kind: "other" });
    expect(consentDestination(undefined)).toMatchObject({ host: "an address we couldn't read", kind: "other" });
    expect(consentDestination("https://connect.example.com/cb").note).toContain("know who runs connect.example.com.");
  });
});

describe("the connect screen", () => {
  /** The screen for an app that signed up under this name and logo, with this address to send the person's access to. */
  function screen(client: { name: string; logo_uri?: string }, redirect_uri: string, given?: { level: string; areas: string[] }) {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    queries.setQueryData(["oauth-consent", "auth-1"], { authorization_id: "auth-1", redirect_uri, client: { id: "client-1", uri: "", ...client }, user: { id: "user-1", email: "owner@kilo.test" }, scope: "openid" });
    queries.setQueryData(["oauth-consent-access", "client-1"], given ?? { level: "read", areas: [] });
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queries }, createElement(MemoryRouter, { initialEntries: ["/oauth/consent?authorization_id=auth-1"] }, createElement(OAuthConsentPage))),
    );
  }
  const CLAUDE_LOGO = "https://cdn.example/claude-logo.png";

  it("shows Claude where Claude really is, with its logo and no caution", () => {
    const html = screen({ name: "Claude", logo_uri: CLAUDE_LOGO }, "https://claude.ai/api/mcp/auth_callback");
    expect(html).toContain("Connect Claude?");
    expect(html).toContain(">claude.ai</strong>");
    expect(html).toContain("Claude&#x27;s own address.");
    expect(html).toContain(CLAUDE_LOGO);
    expect(html).not.toContain('role="alert"');
  });

  it("doesn't take an app's word that it's Claude: it shows where it leads, with a caution and without the logo", () => {
    const html = screen({ name: "Claude", logo_uri: CLAUDE_LOGO }, "https://claude-connect.example/callback");
    expect(html).toContain("Connect an app called Claude?");
    expect(html).not.toContain("Connect Claude?");
    expect(html).toContain(">claude-connect.example</strong>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("This isn&#x27;t Claude&#x27;s or ChatGPT&#x27;s own address, whatever the app calls itself.");
    expect(html).not.toContain(CLAUDE_LOGO);
    // The address comes before what it can read and before Allow.
    expect(html.indexOf("claude-connect.example")).toBeLessThan(html.indexOf("Allow access"));
  });

  it("says an app on this computer is one", () => {
    const html = screen({ name: "Claude Code" }, "http://localhost:53682/callback");
    expect(html).toContain("Connect an app called Claude Code?");
    expect(html).toContain(">localhost:53682</strong>");
    expect(html).toContain("That&#x27;s an app on this computer");
  });

  it("says it will read everything the person can see, and can't change anything until they allow it", () => {
    const html = screen({ name: "Claude" }, "https://claude.ai/api/mcp/auth_callback");
    expect(CAN_READ).toMatch(/^Everything you can see in Crewtavo\./);
    for (const what of ["gate and alarm codes", "invoices and payments", "pay"]) expect(CAN_READ).toContain(what);
    expect(html).toContain(CAN_READ);
    expect(CANT_CHANGE).toBe("It can't change anything until you allow it, in Crewtavo under Settings → AI assistants.");
    expect(html).toContain("It can&#x27;t change anything until you allow it");
    // What it used to say it could look at, which left out the money, the codes and the pay.
    expect(html).not.toContain("Knowledge base");
    expect(html).not.toContain("Can look at");
  });

  it("doesn't say it can't change anything about an app the person already gave more", () => {
    const html = screen({ name: "Claude" }, "https://claude.ai/api/mcp/auth_callback", { level: "areas", areas: ["prices"] });
    expect(html).toContain("It keeps what you gave it before (Can change: Price list).");
    expect(html).not.toContain("It can&#x27;t change anything until you allow it");
  });
});
