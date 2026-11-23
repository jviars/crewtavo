/**
 * The client page's More actions menu (ClientMenu.dc.html, PhoneSheet.dc.html, PhoneSubSheet.dc.html):
 * each way to send says where it goes or why it can't (features/clients/sendWays.ts), the risky items
 * sit together at the end, and a phone's sheet has a real title with a close button.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { askRefusal, reachOf, type AskChannel } from "@crewtavo/core/marketing";
import { Menu } from "../src/components/ui/Menu";
import { askedNot, sendWay, wayBlocked } from "../src/features/clients/sendWays";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const BEN = { display_name: "Ben Okafor", email: "ben@example.com", phone: "(540) 555-0192", status: "active", review_opt_out: false, marketing_opt_out: false, sms_opt_out_at: null };
const READY = { email: true, sms: true };

describe("a way to send, as a menu item", () => {
  it("says where it goes: the email address, the number, or both", () => {
    const reach = reachOf(BEN, READY);
    expect(sendWay(BEN, reach, "email")).toEqual({ description: "ben@example.com", disabled: false });
    expect(sendWay(BEN, reach, "sms")).toEqual({ description: "(540) 555-0192", disabled: false });
    expect(sendWay(BEN, reach, "both")).toEqual({ description: "Both", disabled: false });
  });

  it("is turned off saying why when it can't go", () => {
    expect(sendWay({ ...BEN, phone: null }, reachOf({ ...BEN, phone: null }, READY), "sms")).toEqual({ description: "No mobile number on file", disabled: true });
    expect(sendWay(BEN, { ...reachOf(BEN, READY), textsOff: true }, "sms")).toEqual({ description: "Texts are off for them", disabled: true });
    expect(sendWay(BEN, reachOf(BEN, READY), "both", askedNot({ review_opt_out: true }))).toEqual({ description: "Asked not to get review asks", disabled: true });
    // Both needs both: the one that can't go is the reason.
    expect(wayBlocked(reachOf({ ...BEN, email: null }, READY), "both")).toBe("No email on file");
    expect(wayBlocked(reachOf(BEN, { email: false, sms: true }), "email")).toBe("Email isn't connected");
    expect(wayBlocked(reachOf(BEN, { email: true, sms: false }), "sms")).toBe("Texting isn't set up");
    expect(askedNot({ marketing_opt_out: true })).toBe("Unsubscribed from marketing");
    expect(askedNot({ status: "archived" })).toBe("Archived, so not asked");
    expect(askedNot({ status: "active" })).toBeNull();
  });

  it("is off exactly when Ask a client now would refuse it by email or by text", () => {
    const clients = [BEN, { ...BEN, email: null }, { ...BEN, phone: null }, { ...BEN, sms_opt_out_at: "2026-11-01" }, { ...BEN, email: "not an address" }];
    for (const c of clients)
      for (const ready of [READY, { email: false, sms: true }, { email: true, sms: false }])
        for (const way of ["email", "sms"] as AskChannel[]) expect(sendWay(c, reachOf(c, ready), way).disabled, `${way} ${JSON.stringify(c)} ${JSON.stringify(ready)}`).toBe(Boolean(askRefusal(c, way, ready)));
  });
});

describe("the client's More actions menu", () => {
  const page = source("../src/features/clients/ClientPage.tsx");
  const order = (labels: string[]) => labels.map((l) => page.indexOf(l));

  it("keeps the record first, asking next, and the risky ones together at the end with Delete last", () => {
    const at = order(['label: "Edit client"', 'label: "Copy Client Hub link"', 'label: "Ask for a review"', 'label: "Referrals"', 'label: "Send autopay invite"', 'label: c.status === "archived" ? "Restore client"', 'label: "Merge into another client"', "label: RESET_LINKS_LABEL, description: RESET_LINKS_NOTE", 'label: "Delete client"']);
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("says where asking stands on its sub menus, from what's cheap to read", () => {
    expect(page).toContain('lastAsk.data ? `Asked ${formatDate(lastAsk.data)}` : "Not asked yet"');
    expect(page).toContain('supabase().rpc("last_review_ask", { p_company: session.company.id, p_client: id })');
    expect(page).toContain("referred.data ? `${referred.data} referred` : undefined");
    // Read again after an ask from here (its key starts with the one the ask refreshes).
    expect(page).toContain('queryKey: ["review-ask", id, "last"]');
  });
});

describe("a phone's menu sheet", () => {
  it("has the title as a heading and a round close button beside it", () => {
    const html = renderToStaticMarkup(createElement(Menu, { items: [{ label: "Edit client", onSelect: () => undefined }], title: "Ben Okafor" }));
    expect(html).toContain('<span class="menu-sheet-titles" aria-hidden="true"><span class="menu-sheet-title">Ben Okafor</span></span>');
    expect(html).toMatch(/<button type="button" role="menuitem" class="menu-back" aria-label="Close">/);
    expect(html).not.toContain('aria-label="Back"');
  });

  it("is styled bigger and bolder than a row, with the level above quiet under a sub menu's title", () => {
    const css = source("../src/styles/components.css");
    expect(css).toContain(".menu-sheet-title { font-size: var(--fs-18); font-weight: 700;");
    expect(css).toContain(".menu-sheet-sub { font-size: var(--fs-13); color: var(--text-3); }");
    expect(source("../src/components/ui/Menu.tsx")).toContain("{above && <span className=\"menu-sheet-sub\">{above}</span>}");
  });
});
