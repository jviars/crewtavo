/**
 * The shared list, section and record patterns (components/ui/InboxList.tsx, Section.tsx,
 * StatStrip.tsx, Toolbar.tsx, DetailPage.tsx) and the Requests list built from them: a row is one
 * link, empty facts and meta parts leave nothing behind, ages are short, and requests are grouped
 * by what needs doing first.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { InboxGroup, InboxList, InboxRow, MetaLine, shortAge, wrapDots } from "../src/components/ui/InboxList";
import { Fact, Facts, Section } from "../src/components/ui/Section";
import { Stat, StatStrip } from "../src/components/ui/StatStrip";
import { DetailHeader } from "../src/components/ui/DetailPage";
import { SelectionBar, useSelection } from "../src/components/ui/Selection";
import { groupRequests } from "../src/features/requests/RequestsPage";

const render = (node: Parameters<typeof h>[0], props: Record<string, unknown> | null, ...children: unknown[]) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(node as never, props as never, ...(children as never[]))));
const css = readFileSync(new URL("../src/styles/components.css", import.meta.url), "utf8");

describe("an inbox row", () => {
  const html = render(InboxList, { label: "Requests" },
    h(InboxGroup, { label: "Waiting over 2 days", count: 1, tone: "warning", icon: "clock" },
      h(InboxRow, { to: "/requests/1", title: "Corbin Dental", number: 5, subject: "Snow removal", unread: "New", meta: ["Website form", null, "", false, "88 Main St"], aside: "1w" })));

  it("is one link to the record, holding the name, number and subject, under a group heading", () => {
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a class="il-link" href="\/requests\/1"><span class="sr-only">New: <\/span><span class="il-l1"><span class="il-title">Corbin Dental<\/span><span class="il-num">#5<\/span><\/span><span class="il-subject">Snow removal<\/span><\/a>/);
    expect(html).toMatch(/<section class="il-group" aria-labelledby="([^"]+)">.*<h2 class="il-head-label" id="\1">Waiting over 2 days<\/h2><span class="il-count">1<\/span>/);
    expect(html).toContain('<span class="il-avatar" aria-hidden="true">CD</span>');
  });

  it("leaves empty meta parts out, with a dot only between real ones", () => {
    expect(html).toContain('<div class="meta-line il-meta"><span>Website form</span><span class="meta-dot" aria-hidden="true">·</span><span>88 Main St</span></div>');
    expect(renderToStaticMarkup(h(MetaLine, { parts: [null, false, ""] }))).toBe("");
  });

  it("is stretched over the whole row, with the focus ring on the row", () => {
    expect(css).toContain('.il-link::after { content: ""; position: absolute; inset: 0; }');
    expect(css).toContain(".il-row:has(.il-link:focus-visible) { outline: 2px solid var(--green);");
  });
});

describe("an inbox row that opens something on its page", () => {
  const html = render(InboxList, { label: "Messages" },
    h(InboxGroup, {}, h(InboxRow, { onClick: () => {}, current: true, className: "msg-row", title: "Priya Shah", subject: "Could we skip the crack fill?" })));

  it("is one button in place of the link, looking and focusing the same", () => {
    expect(html).not.toContain("<a ");
    expect(html).toContain('<li class="il-row msg-row" data-current="true">');
    expect(html).toMatch(/<button type="button" class="il-link il-link-button" aria-current="true"><span class="il-l1"><span class="il-title">Priya Shah<\/span><\/span><span class="il-subject">Could we skip the crack fill\?<\/span><\/button>/);
    expect(css).toContain(".il-link-button { width: 100%; margin: 0; padding: 0; border: 0;");
  });
});

describe("an inbox row with more to it", () => {
  it("takes lines after its meta line, their links and buttons above the row's own link", () => {
    const html = render(InboxGroup, {}, h(InboxRow, { to: "/marketing/posts/1", title: "Spring sealcoat", meta: ["Posted"] }, h("a", { href: "https://facebook.com/p/1" }, "Facebook")));
    expect(html).toContain('<div class="meta-line il-meta"><span>Posted</span></div><div class="il-extra"><a href="https://facebook.com/p/1">Facebook</a></div>');
    expect(css).toContain(".il-extra :is(a, button, label, input, select, summary) { position: relative; z-index: 1; }");
  });

  it("can replace the page it's on, for a popup the address names", () => {
    expect(render(InboxGroup, {}, h(InboxRow, { to: "/snow?storm=1", replace: true, title: "Storm" }))).toContain('<a class="il-link" href="/snow?storm=1">');
  });

  it("with nothing to open, has the same lines and no link, button or hover fill", () => {
    const html = render(InboxGroup, {}, h(InboxRow, { title: "Already posted", subject: "Driveway before and after" }));
    expect(html).not.toMatch(/<a |<button/);
    expect(html).toContain('<li class="il-row il-row-static">');
    expect(html).toContain('<div class="il-lines"><span class="il-l1"><span class="il-title">Already posted</span></span><span class="il-subject">Driveway before and after</span></div>');
    expect(css).toContain(".il-row-static:hover { background: none; }");
  });

  it("covers its whole right column with its hover actions, buttons at the top", () => {
    expect(css).toMatch(/\.il-actions \{ position: absolute; top: -4px; bottom: -4px; right: 0; z-index: 2; display: flex; align-items: flex-start;/);
  });
});

describe("picking rows on a phone", () => {
  function Picker() {
    const selection = useSelection(["q1", "q2"], "open");
    return h("div", null,
      h(SelectionBar, { selection, noun: "quotes", always: true }, null),
      h(InboxList, { label: "Quotes" }, h(InboxGroup, {}, h(InboxRow, { to: "/quotes/q1", title: "Priya Shah", id: "q1", selection, selectLabel: "Select quote 8" }))));
  }
  const html = render(Picker, null);

  it("starts with the boxes put away behind a Select button, which a desktop doesn't show", () => {
    expect(html).toContain('data-mode="off"');
    expect(html).toContain('<button type="button" class="select-bar-mode">Select</button>');
    // data-hold: holding a finger on the row picks it too (useHoldToPick).
    expect(html).toMatch(/<li class="il-row il-row-pick" data-pick-off="true" data-hold="">/);
    expect(css).toContain(".select-bar-mode { display: none; }");
    const phone = css.slice(css.indexOf(".select-bar-mode { display: none; }"));
    expect(phone).toContain('.select-bar[data-mode="off"] > .select-bar-all { display: none; }');
    expect(css).toContain(".il-row-pick[data-pick-off] > .il-check { display: none; }");
  });

  it("keeps the picking bar on one line on a phone, its actions scrolling sideways", () => {
    const phone = css.slice(css.indexOf(".select-bar-mode { display: none; }"));
    expect(phone).toContain(".select-bar { flex-wrap: nowrap; }");
    expect(phone).toMatch(/\.select-bar-actions \{[^}]*overflow-x: auto;/);
  });

  it("shows a mouse its boxes only under the pointer, the keyboard or once one is picked, still a Tab stop", () => {
    const mouse = css.split("@media (min-width: 901px) and (hover: hover) {").slice(1).map((block) => block.slice(0, block.indexOf("\n}"))).join("\n");
    expect(mouse).toContain(".il-row-pick[data-pick-off]:not(:hover, :focus-within) > .il-check { opacity: 0; }");
    expect(mouse).toMatch(/\.select-bar\[data-mode="off"\]:not\(:focus-within\) \{[^}]*clip-path: inset\(50%\);/);
    expect(mouse).not.toMatch(/il-check[^{]*\{[^}]*display: none/);
  });
});

describe("a meta line that wraps", () => {
  // Each child's top (a dot's row, or a part's), on lines 20px apart; null for one a page's CSS hides.
  const marks = (tops: Array<number | null>) => {
    const els = tops.map((top, i) => {
      const attrs = new Map<string, string>();
      return {
        dot: i % 2 === 1, attrs, previousElementSibling: null as unknown, nextElementSibling: null as unknown,
        getClientRects: () => (top === null ? [] : [{}]),
        getBoundingClientRect: () => ({ top: top ?? 0, bottom: (top ?? 0) + 16 }),
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        removeAttribute: (k: string) => attrs.delete(k),
      };
    });
    els.forEach((el, i) => Object.assign(el, { previousElementSibling: els[i - 1] ?? null, nextElementSibling: els[i + 1] ?? null }));
    wrapDots({ querySelectorAll: () => els.filter((el) => el.dot) } as unknown as HTMLElement);
    return els.filter((el) => el.dot).map((el) => el.attrs.get("data-wrap") ?? null);
  };

  it("never ends or starts a line with a dot", () => {
    expect(marks([0, 0, 0, 0, 0])).toEqual([null, null]);
    expect(marks([0, 0, 20, 20, 20])).toEqual(["end", null]);
    expect(marks([0, 20, 20])).toEqual(["start"]);
    // A part a page hides passes its dot's neighbor on; a dot it hides is left be.
    expect(marks([0, 0, null, 0, 20])).toEqual([null, "end"]);
    expect(marks([0, null, 0])).toEqual([null]);
    expect(css).toContain('.meta-dot[data-wrap="end"] { visibility: hidden; }');
  });
});

describe("a short age", () => {
  const now = Date.parse("2026-11-21T18:00:00Z");
  it("is minutes, hours, days and weeks, then a date", () => {
    expect(shortAge("2026-11-21T17:55:00Z", now)).toBe("5m");
    expect(shortAge("2026-11-21T15:00:00Z", now)).toBe("3h");
    expect(shortAge("2026-11-17T18:00:00Z", now)).toBe("4d");
    expect(shortAge("2026-11-07T18:00:00Z", now)).toBe("2w");
    expect(shortAge("2026-09-03T18:00:00Z", now)).toBe("Sep 3");
    expect(shortAge("2025-09-03T18:00:00Z", now)).toBe("Sep 2025");
  });
});

describe("facts and figures", () => {
  it("show no row for a fact with nothing to say", () => {
    const html = render(Section, { title: "Details", count: 2 }, h(Facts, null, h(Fact, { label: "Email" }, "a@b.co"), h(Fact, { label: "Phone" }, null), h(Fact, { label: "Notes" }, "")));
    expect(html.match(/class="fact"/g)).toHaveLength(1);
    expect(html).toContain('<h2 class="sec-title"');
    expect(html).toContain('<span class="sec-count">2</span>');
  });

  it("lay a stats strip out by how many figures it has", () => {
    const html = render(StatStrip, { label: "Totals" }, h(Stat, { label: "Past due", value: "$1,920", tone: "danger" }), h(Stat, { label: "Collected", value: "$18,300", delta: { text: "+8%", tone: "good" } }));
    expect(html).toContain('data-count="2"');
    expect(html).toContain('<span class="strip-value" data-tone="danger">$1,920</span>');
    expect(html).toContain('<span class="strip-delta" data-tone="good">+8%</span>');
  });

  it("put a record's crumb, title and quiet status line in its header", () => {
    const html = render(DetailHeader, { crumb: { to: "/clients", label: "Clients" }, title: "Alvarez", status: h("span", { className: "pill" }, "Active"), meta: ["Rita", null] });
    expect(html).toContain('<a class="crumb no-print" href="/clients">');
    expect(html).toContain('<h1 class="page-title">Alvarez</h1>');
    expect(html).toMatch(/<div class="meta-line detail-meta"><span class="pill">Active<\/span><span class="meta-dot" aria-hidden="true">·<\/span><span>Rita<\/span><\/div>/);
  });
});

describe("the Requests list", () => {
  const row = (number: number, status: string, created_at: string) => ({ id: String(number), number, status, created_at, title: "", source: "phone", website_form_id: null, assigned_to: null, asked_starts_at: null, asked_ends_at: null, client: null, property: null }) as never;
  const now = Date.parse("2026-11-21T18:00:00Z"); // a Saturday

  it("puts new requests waiting over two days first, then today, this week and earlier", () => {
    const groups = groupRequests([row(7, "new", "2026-11-21T15:00:00Z"), row(6, "assessment_scheduled", "2026-11-18T15:00:00Z"), row(2, "new", "2026-11-05T15:00:00Z"), row(3, "assessment_complete", "2026-11-05T15:00:00Z")], "America/New_York", now);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.number)])).toEqual([
      ["Waiting over 2 days", [2]],
      ["Today", [7]],
      ["This week", [6]],
      ["Earlier", [3]],
    ]);
    expect(groups[0]).toMatchObject({ tone: "warning", icon: "clock" });
  });
});
