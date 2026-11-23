/**
 * Settings → Web address and connecting Railway (features/settings/WebAddressSettings.tsx, and the
 * setup step and Settings → Hosting, which use the same pieces): choosing the address and giving
 * Crewtavo Railway access ask for the person's own password, which the API checks
 * (apps/api/src/routes/address.ts confirmAddressChange), since the address is where every link
 * Crewtavo sends points.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ChooseAddress, ConnectRailway, RailwayTokenForm } from "../src/features/settings/WebAddressSettings";

const OVERVIEW: AddressOverview = {
  current: "https://crewtavo-production.up.railway.app",
  platform: "railway",
  railway: { connected: false, oauth: true, settingsUrl: null, variablesUrl: null, tokensUrl: null, projectName: "Crewtavo", error: null, domains: [] },
  suggestion: null,
  change: null,
};

const render = (element: ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MemoryRouter, null, element)));

describe("moving where Crewtavo's links point", () => {
  it("asks for the password with the address", () => {
    const html = render(createElement(ChooseAddress, { overview: OVERVIEW, onDone: () => undefined }));
    expect(html).toContain("Choose your address");
    expect(html).toContain("Your Crewtavo password");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"[^>]*required=""/);
  });

  it("and with a Railway project token", () => {
    const html = render(createElement(RailwayTokenForm, { tokensUrl: null }));
    expect(html).toContain("Project token");
    expect(html).toContain("Your Crewtavo password");
    expect(html).toMatch(/<input[^>]*type="password"[^>]*autoComplete="current-password"[^>]*required=""/);
  });

  it("asks once Log in with Railway is pressed, before Railway's screen opens", () => {
    const html = render(createElement(ConnectRailway, { returnTo: "settings", projectName: "Crewtavo" }));
    expect(html).toContain("Log in with Railway");
    // The password is asked in a dialog when it's pressed, not on the page.
    expect(html).not.toContain("Your Crewtavo password");
  });
});
