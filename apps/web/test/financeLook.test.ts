/**
 * Finance and Metrics in the quiet look (Page-Finance.dc.html, Page-Metrics.dc.html): the dates
 * under a chart, a change in plain colored words, a list's day headings, the figures as a flat strip,
 * report sections on a hairline, tables whose heads sort by keyboard, and a phone's grouped cards.
 */
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { Stat, StatStrip } from "../src/components/ui/StatStrip";
import { axisDates, Change, changeDelta, HBars, Lines, ReportCard, ReportTable } from "../src/features/finance/Charts";
import { bucketsFor, dayWords, resolveRange } from "../src/features/finance/range";
import { datesWords } from "../src/features/finance/shared";

const render = (node: Parameters<typeof h>[0], props: Record<string, unknown> | null, ...children: unknown[]) =>
  renderToStaticMarkup(h(MemoryRouter, null, h(node as never, props as never, ...(children as never[]))));
const module = readFileSync(new URL("../src/features/finance/Finance.module.css", import.meta.url), "utf8");
const features = readFileSync(new URL("../src/styles/features.css", import.meta.url), "utf8");

describe("a chart's dates", () => {
  it("are four, evenly spaced, the first and last at the chart's edges", () => {
    const buckets = bucketsFor(resolveRange("custom", "2026-11-21", "America/New_York", { from: "2026-11-01", to: "2026-11-21" }));
    expect(axisDates(buckets)).toEqual([
      { at: 0, label: "Nov 1" },
      { at: 7 / 20, label: "Nov 8" },
      { at: 13 / 20, label: "Nov 14" },
      { at: 1, label: "Nov 21" },
    ]);
  });

  it("name months by their short name, with the year on the edges when the range crosses one", () => {
    const buckets = bucketsFor(resolveRange("custom", "2026-11-21", "America/New_York", { from: "2025-10-01", to: "2026-03-31" }));
    const dates = axisDates(buckets);
    expect(dates[0]).toEqual({ at: 0, label: "Oct 2025" });
    expect(dates.at(-1)).toEqual({ at: 1, label: "Mar 2026" });
    expect(dates.slice(1, -1).every((d) => /^[A-Z][a-z]{2}$/.test(d.label))).toBe(true);
  });

  it("is one date for a range of one day", () => {
    const buckets = bucketsFor(resolveRange("custom", "2026-11-21", "America/New_York", { from: "2026-11-21", to: "2026-11-21" }));
    expect(axisDates(buckets)).toEqual([{ at: 0, label: "Nov 21" }]);
  });
});

describe("the change from the period before", () => {
  it("is plus or minus in words, green when it went the right way", () => {
    expect(changeDelta(112, 100)).toEqual({ text: "+12%", tone: "good", after: undefined });
    expect(changeDelta(88, 100)).toEqual({ text: "−12%", tone: "danger", after: undefined });
    expect(changeDelta(88, 100, "down", "vs last month")).toEqual({ text: "−12%", tone: "good", after: "vs last month" });
    expect(changeDelta(2400, 100)?.text).toBe("24×");
  });

  it("says nothing without an earlier figure, or when nothing changed", () => {
    expect(changeDelta(50, 0)).toBeUndefined();
    expect(changeDelta(100, 100)).toBeUndefined();
    expect(renderToStaticMarkup(h(Change, { now: 50, before: 0 }))).toBe("");
  });

  it("reads as up or down to a screen reader, the sign only for the eye", () => {
    const html = renderToStaticMarkup(h(Change, { now: 112, before: 100, compared: "last month" }));
    expect(html).toContain('class="chip tabular chip-green"');
    expect(html).toContain('<span class="sr-only">Up </span><span aria-hidden="true">+12%</span><span class="sr-only">12% from last month</span>');
  });
});

describe("dates in words", () => {
  it("say the year only when it isn't this one", () => {
    expect(datesWords("2026-10-11", "2026-10-31", "2026-11-21")).toBe("Oct 11 – Oct 31");
    expect(datesWords("2024-01-02", "2024-12-31", "2026-11-21")).toBe("Jan 2 – Dec 31, 2024");
    expect(datesWords("2026-10-25", "2026-10-25", "2026-11-21")).toBe("Oct 25");
  });
});

describe("a day's heading over payments", () => {
  it("is today, yesterday, a weekday this past week, then the date", () => {
    expect(dayWords("2026-11-21", "2026-11-21")).toBe("Today");
    expect(dayWords("2026-11-20", "2026-11-21")).toBe("Yesterday");
    expect(dayWords("2026-11-17", "2026-11-21")).toBe("Tue, Nov 17");
    expect(dayWords("2026-11-03", "2026-11-21")).toBe("Nov 3");
    expect(dayWords("2025-12-30", "2026-01-02")).toBe("Dec 30, 2025");
  });
});

describe("report parts", () => {
  it("put the figures in a flat strip, a figure to act on in red", () => {
    const html = render(StatStrip, { label: "Profit" }, h(Stat, { label: "Job profit", value: "$-120", tone: "danger", note: "Contract totals" }), false, h(Stat, { label: "Jobs", value: "5" }));
    expect(html).toContain('<div class="strip" role="group" aria-label="Profit" data-count="2">');
    expect(html).toContain('<span class="strip-value" data-tone="danger">$-120</span>');
    expect(html).not.toContain("card");
  });

  it("are sections on a hairline, the figure quiet after the heading and the link on the right", () => {
    const html = render(ReportCard, { title: "Unpaid invoices", count: "$12,480", more: { label: "View all", to: "/invoices" }, subtitle: "As of today" }, "rows");
    expect(html).toMatch(/<section class="sec" aria-labelledby="[^"]+"><div class="sec-head"><h2 class="sec-title" id="[^"]+">Unpaid invoices<\/h2><span class="sec-count">\$12,480<\/span><div class="sec-action"><a href="\/invoices">View all<\/a><\/div><\/div>/);
    expect(html).toContain("As of today</p>rows");
  });

  it("keep a figure's explanation out of the heading's name, and read it right after", () => {
    const html = render(ReportCard, { title: "Time to get paid", info: "Days from issue to payment." }, "rows");
    expect(html).toMatch(/<h2 class="sec-title" id="[^"]+">Time to get paid<span class="[^"]+" title="Days from issue to payment\." aria-hidden="true">/);
    // In the heading's row, so the body's first rows still sit on the hairline (.sec-body > .rel:first-child).
    expect(html).toContain('<div class="sec-action"><span class="sr-only">Days from issue to payment.</span></div></div><div class="sec-body">rows');
  });

  it("color a row's figure only when someone must act, and leave an empty row quiet", () => {
    const html = render(Lines, { rows: [{ key: "a", label: "1–30 days late", note: "2 invoices", value: "$1,240", tone: "warning" }, { key: "b", label: "Over 90 days late", value: "$0", tone: "danger", none: true }] });
    expect(html).toMatch(/data-tone="warning">\$1,240</);
    expect(html).toMatch(/data-none="true"><span class="[^"]+">Over 90 days late<\/span><span class="[^"]+">\$0</);
  });

  it("draw bars as long as their share of the largest, a quiet row dimmed", () => {
    const html = render(HBars, { rows: [{ key: "p", label: "Price", value: 3 }, { key: "n", label: "No reason given", value: 1, quiet: true }], format: String, color: "var(--quote)" });
    expect(html).toContain("width:100%;background:var(--quote)");
    expect(html).toContain("width:33.33");
    expect(html).toMatch(/data-quiet="true"/);
  });

  it("sort a table by a button in each head, so the keyboard can, and say which way", () => {
    const html = render(ReportTable, {
      rows: [{ id: "1", name: "Luis", value: 2 }, { id: "2", name: "Ana", value: 9 }],
      rowKey: (r: { id: string }) => r.id,
      filename: "people",
      initialSort: { key: "value", desc: true },
      columns: [
        { key: "name", label: "Name", value: (r: { name: string }) => r.name },
        { key: "sent", label: "Sent", num: true, value: () => 1 },
        { key: "value", label: "Won value", num: true, value: (r: { value: number }) => r.value },
      ],
    });
    expect(html).toMatch(/<th scope="col" class="[^"]+" aria-sort="descending"><button type="button" class="[^"]+">Won value/);
    expect(html.indexOf("Ana")).toBeLessThan(html.indexOf("Luis"));
    // The middle columns carry their names, for a phone's quiet line under each row.
    expect(html).toMatch(/data-label="Sent">1<\/td>/);
    // So does the last, whose figure sits alone on the right there: "Won value 9", never a bare "9".
    expect(html).toMatch(/data-label="Won value">9<\/td>/);
    // The first is the row's own name and needs none.
    expect(html).not.toContain('data-label="Name"');
    expect(html).toContain(">Download</button>");
  });
});

describe("the look", () => {
  it("has no tinted panel of cards or boxed strip left in the shared stylesheet", () => {
    expect(features).not.toMatch(/\.fin-grid|\.kpi-strip|\.report-card|\.goal-track|\.fin-hero|\.fin-balance|\.metric-pick/);
  });

  it("turns a table into list rows on a phone, and the section tabs into chips", () => {
    expect(module).toMatch(/@media \(max-width: 900px\)[\s\S]*\.rt thead \{ display: none; \}/);
    expect(module).toContain('.rt td.mid::before { content: attr(data-label) "\\00a0"; }');
    // The figure on the right says what it is, quietly before it (the Website tab's "Booked 0%", not "0%").
    expect(module).toMatch(/\.rt td\.end::before \{ content: attr\(data-label\) "\\00a0";[^}]*color: var\(--text-3\); \}/);
    expect(module).toContain(".tabs > button[aria-selected=\"true\"] { background: var(--solid); color: var(--on-solid); }");
  });

  it("ends a wrapped quiet line on a dot, not a new one on it, and makes a linked row one target on a phone", () => {
    expect(module).toContain('.rt td.mid:has(~ td.mid:not(:empty))::after { content: "\\00a0·\\00a0"; }');
    expect(module).not.toMatch(/td\.mid:not\(:empty\) ~ td\.mid::before/);
    expect(module).toContain(".rt td:first-child :global(.cell-link)::after { content: \"\"; position: absolute; inset: 0; }");
  });

  it("lets bars fade in at their length with Reduce Motion", () => {
    expect(module).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.trackFill, \.splitBar, \.barFill \{ animation-name: fade; \}/);
  });
});
