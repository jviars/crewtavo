/**
 * The sign-in page's "Create an account" link (features/auth/LoginPage.tsx): offered only once Auth
 * has said sign-up is open. A Crewtavo instance turns sign-up off (the owner invites everyone else),
 * so an instance never shows it, not even while Auth's settings are on their way or didn't come.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LoginPage, signupOpen, SwitchAccountPage } from "../src/features/auth/LoginPage";

/** GoTrue's answer to GET /auth/v1/settings on an instance (GOTRUE_DISABLE_SIGNUP), and on a Supabase project with sign-up on. */
const INSTANCE = { external: { email: true, google: false, phone: false }, disable_signup: true, mailer_autoconfirm: true };
const OPEN = { external: { email: true, google: true, phone: false }, disable_signup: false, mailer_autoconfirm: false };

/** The sign-in page while Auth's settings are loading, after they failed to load, or once they've come. */
async function page(settings: "loading" | "failed" | object) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (settings === "failed") await client.prefetchQuery({ queryKey: ["auth-settings"], queryFn: () => Promise.reject(new Error("settings")) });
  else if (settings !== "loading") client.setQueryData(["auth-settings"], settings);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(LoginPage)));
}

describe("creating an account", () => {
  it("is offered only when Auth says sign-up is open", () => {
    expect(signupOpen(OPEN)).toBe(true);
    expect(signupOpen(INSTANCE)).toBe(false);
    expect(signupOpen(undefined)).toBe(false); // still loading, or the read failed
    expect(signupOpen({ external: { email: true } })).toBe(false); // says nothing about sign-up
  });

  it("isn't offered on an instance, nor before Auth has answered", async () => {
    expect(await page(INSTANCE)).not.toContain("Create an account");
    expect(await page("loading")).not.toContain("Create an account");
    expect(await page("failed")).not.toContain("Create an account");
  });

  it("is offered on the sign-in page where sign-up is open", async () => {
    const html = await page(OPEN);
    expect(html).toContain("Sign in");
    expect(html).toContain("Create an account");
  });
});

describe("a link for another account than the one signed in", () => {
  it("names both, and offers staying first", () => {
    const html = renderToStaticMarkup(createElement(SwitchAccountPage, { current: "owner@greenlawn.example", link: "crew@greenlawn.example", onAnswer: () => undefined }));
    expect(html).toContain("Switch accounts?");
    expect(html).toMatch(/This link signs in as <strong[^>]*>crew@greenlawn\.example<\/strong>\. You&#x27;re signed in here as <strong[^>]*>owner@greenlawn\.example<\/strong>\./);
    expect(html.indexOf("Stay signed in")).toBeLessThan(html.lastIndexOf("Switch accounts"));
  });
});
