/**
 * A Client Hub home reached through an office copy made by someone who doesn't see the business's
 * money (the server leaves the invoices, payments and credit out, and says money: false): the page
 * never says nothing is owed, since it can't know. The client's own home is as it was. And a link's
 * token is its two parts.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ClientView } from "../src/features/hub/ClientPortal";
import { hubToken } from "../src/features/hub/document";
import { HubPage } from "../src/features/hub/HubPage";

const company = { name: "Radford Lawn Care", phone: "555-0142", email: null, website: null, timezone: "America/New_York", branding: null, logo: null, address: [] };

/** What a screen says, without its tags. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The Hub page for a link, as it draws with the server's answer already in. */
function page(view: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["hub", "tok"], view);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: ["/hub/tok"] }, createElement(Routes, null, createElement(Route, { path: "/hub/:token", element: createElement(HubPage) }))),
    ),
  );
}

function clientView(over: Partial<ClientView> = {}): ClientView {
  return {
    kind: "client", company, preview: false, autopay: null,
    client: { name: "Pat Lee", first_name: "Pat", properties: [{ id: "p1", line1: "12 Elm St", city: "Radford" }] },
    quotes: [], invoices: [], visits: [], past_visits: [], payments: [], requests: [], services: [], refer: null,
    ...over,
  };
}

describe("a Client Hub home without the money", () => {
  it("never says nothing is owed", () => {
    const html = text(page(clientView({ money: false })));
    expect(html).not.toContain("All caught up");
    expect(html).not.toContain("Nothing needs your attention right now.");
    expect(html).toContain("No quotes are waiting on you.");
  });

  it("leaves the client's own home as it was", () => {
    for (const view of [clientView(), clientView({ money: true })]) {
      const html = text(page(view));
      expect(html).toContain("All caught up");
      expect(html).toContain("Nothing needs your attention right now.");
    }
  });
});

describe("a Client Hub link's token", () => {
  it("is the two parts the server made, whatever a text or chat app took in after it", () => {
    for (const raw of ["eyJj.c2ln", "eyJj.c2ln.", "eyJj.c2ln)", "eyJj.c2ln,", "eyJj.c2ln.1"]) expect(hubToken(raw), raw).toBe("eyJj.c2ln");
    // Anything else goes to the server as it is, which says the link isn't valid.
    expect(hubToken("not-a-link")).toBe("not-a-link");
  });
});
