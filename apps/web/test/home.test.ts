/**
 * Home (features/home): the workflow strip's figures and the words that take color, what each
 * needs-attention row's icon says, when Home is a business's first visit, the days collected is
 * compared with, and the setup checklist's order: done first, the step up next, then the rest with
 * how long each takes.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { attentionLook, nothingYet, sameDaysLastMonth, shownAttention } from "../src/features/home/HomePage";
import { orderSteps, SetupChecklist, type SetupStep } from "../src/features/home/SetupCard";
import type { Dashboard } from "../src/features/home/types";
import { workflowColumns, WorkflowStrip } from "../src/features/home/WorkflowStrip";

const workflow = (over: Partial<{ [K in keyof Dashboard["workflow"]]: Partial<Dashboard["workflow"][K]> }> = {}): Dashboard["workflow"] => ({
  requests: { new: 4, assessment_complete: 1, overdue: 2, ...over.requests },
  quotes: { awaiting: 3, awaiting_value: 9924, approved: 1, approved_value: 1259, draft: 2, draft_value: 13643, ...over.quotes },
  jobs: { to_invoice: 1, to_invoice_value: 2350, active: 8, ...over.jobs },
  invoices: { awaiting: 5, awaiting_value: 60987, past_due: 2, past_due_value: 44264, draft: 2, ...over.invoices },
});

describe("Home's workflow strip", () => {
  it("leads each column with its figure and the word after it", () => {
    const cols = workflowColumns(workflow());
    expect(cols.map((c) => [c.label, c.value, c.unit])).toEqual([
      ["Requests", 5, "open"],
      ["Quotes", 24826, "6 open"],
      ["Jobs", 8, "active"],
      ["Invoices", 60987, "awaiting"],
    ]);
  });

  it("colors only what someone must act on: requests waiting over 2 days amber, past due red", () => {
    const cols = workflowColumns(workflow());
    const toned = cols.flatMap((c) => c.rows.filter((r) => r.tone).map((r) => [r.label, r.tone]));
    expect(toned).toEqual([["Waiting over 2 days", "warning"], ["Past due, 2", "danger"]]);
    const calm = workflowColumns(workflow({ requests: { overdue: 0 }, invoices: { past_due: 0, past_due_value: 0 } }));
    expect(calm.flatMap((c) => c.rows.filter((r) => r.tone))).toEqual([]);
  });

  it("gives a phone one short note per figure, amber or red like the row it stands for (Mobile-Work.dc.html)", () => {
    expect(workflowColumns(workflow()).map((c) => [c.note, c.noteTone])).toEqual([
      ["2 waiting", "warning"], ["6 open", undefined], ["1 to invoice", undefined], ["$44,264 past due", "danger"],
    ]);
    const calm = workflowColumns(workflow({ requests: { overdue: 0 }, invoices: { past_due: 0 } }));
    expect(calm.map((c) => [c.note, c.noteTone])).toEqual([["4 new", undefined], ["6 open", undefined], ["1 to invoice", undefined], ["5 awaiting", undefined]]);
  });

  it("adds autopay's rows only when there are some, and leaves invoices out for people who don't see money", () => {
    const rows = workflowColumns(workflow({ invoices: { autopay_failed: 1, autopay_failed_value: 85, autopay_approval: 2 } }))[3]!.rows.map((r) => r.label);
    expect(rows).toEqual(["Awaiting payment", "Draft", "Past due, 2", "Autopay failed, 1", "Needs your OK"]);
    expect(workflowColumns(workflow(), false).map((c) => c.key)).toEqual(["requests", "quotes", "jobs"]);
  });

  it("draws on the shared stats strip, each figure one link to its list, with chevrons between", () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(WorkflowStrip, { workflow: workflow() })));
    expect(html).toMatch(/^<div class="strip [^"]+" role="group" aria-label="Workflow" data-count="4">/);
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html.match(/href="\/(requests|quotes|jobs|invoices)"/g)).toEqual(['href="/requests"', 'href="/quotes"', 'href="/jobs"', 'href="/invoices"']);
    expect(html.match(/aria-hidden="true"><svg/g)).toHaveLength(3);
  });
});

describe("Home's needs attention", () => {
  it("says what each item is with its icon's color, never a colored tile", () => {
    expect(attentionLook({ kind: "invoice", title: "Invoice #212 is past due" })).toEqual({ icon: "invoice", tone: "danger" });
    expect(attentionLook({ kind: "autopay_failed", title: "Autopay failed: Tom Becker" })).toEqual({ icon: "card", tone: "danger" });
    expect(attentionLook({ kind: "quote", title: "Quote #88 approved: convert to a job" })).toEqual({ icon: "check", tone: "good" });
    expect(attentionLook({ kind: "quote", title: "Quote #91: changes requested" })).toEqual({ icon: "quote", tone: "warning" });
    expect(attentionLook({ kind: "equipment", title: "Oil change overdue" })).toEqual({ icon: "truck", tone: "warning" });
    expect(attentionLook({ kind: "visit", title: "Weather hold: Leaf cleanup" })).toEqual({ icon: "cloud" });
    expect(attentionLook({ kind: "something_new", title: "Anything" })).toEqual({ icon: "alert" });
  });
});

describe("Needs attention's length", () => {
  it("shows six things until Show all, so today's visits stay in view, and all seven when there's only one more", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(shownAttention(items(14), false)).toEqual({ shown: items(6), folds: true });
    expect(shownAttention(items(14), true)).toEqual({ shown: items(14), folds: true });
    expect(shownAttention(items(7), false)).toEqual({ shown: items(7), folds: false });
    expect(shownAttention(items(3), false)).toEqual({ shown: items(3), folds: false });
  });
});

describe("a business's first visit", () => {
  const empty = workflow({ requests: { new: 0, assessment_complete: 0, overdue: 0 }, quotes: { awaiting: 0, approved: 0, draft: 0 }, jobs: { to_invoice: 0, active: 0 }, invoices: { awaiting: 0, draft: 0, past_due: 0 } });
  const today = (total: number) => ({ total, by_status: {}, visits: [] });

  it("is Home with nothing to show yet: no work, no visits today, nothing to see to", () => {
    expect(nothingYet({ workflow: empty, today: today(0) }, 0)).toBe(true);
    expect(nothingYet({ workflow: empty, today: today(1) }, 0)).toBe(false);
    expect(nothingYet({ workflow: empty, today: today(0) }, 1)).toBe(false);
    expect(nothingYet({ workflow: workflow({ ...empty, quotes: { ...empty.quotes, draft: 1 } }), today: today(0) }, 0)).toBe(false);
  });
});

describe("collected this month's comparison", () => {
  it("names the same days of last month, cut to that month's length", () => {
    expect(sameDaysLastMonth("2026-11-21")).toBe("Oct 1–21");
    expect(sameDaysLastMonth("2026-03-31")).toBe("Feb 1–28");
    expect(sameDaysLastMonth("2026-01-01")).toBe("Dec 1");
  });
});

describe("the setup checklist (Setup-Flow.dc.html)", () => {
  const step = (key: string, done: boolean, minutes = 2): SetupStep => ({ key, show: true, done, title: `Step ${key}`, detail: `What ${key} is for.`, to: `/${key}`, minutes, action: `Do ${key}` });
  const steps = [step("prices", true), step("payments", false, 3), step("logo", true), step("email", false), step("team", false, 3)];

  it("puts done steps first, then the one up next, then the rest in order", () => {
    const order = orderSteps(steps);
    expect(order.done.map((s) => s.key)).toEqual(["prices", "logo"]);
    expect(order.next?.key).toBe("payments");
    expect(order.rest.map((s) => s.key)).toEqual(["email", "team"]);
  });

  it("shows how long each step left takes, and the step up next with its button inside its one link", () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(SetupChecklist, { steps, done: 2 })));
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html).toMatch(/Step payments<span class="[^"]+">Up next<\/span>/);
    expect(html).toMatch(/<span class="btn btn-sm [^"]+" aria-hidden="true">Do payments<\/span><\/a>/);
    expect(html).not.toContain("btn-primary");
    expect(html).toContain(">2 min<");
    expect(html).toContain(">3 min<");
    expect(html).toContain("Step prices<span class=\"sr-only\"> (done)</span>");
    // The side column's is short: no progress bar, done steps without the word, and only the step up next says what it's for.
    expect(html).not.toContain("of 5 done");
    expect(html).not.toContain(">Done<");
    expect(html.match(/What \w+ is for\./g)).toEqual(["What payments is for."]);
  });

  it("is the screen on a first visit: a progress bar, what each step is for, and the one green button", () => {
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(SetupChecklist, { steps, done: 2, full: true })));
    expect(html).toContain("2 of 5 done");
    expect(html.match(/>Done</g)).toHaveLength(2);
    expect(html.match(/btn-primary/g)).toHaveLength(1);
    expect(html.match(/What \w+ is for\./g)).toEqual(["What payments is for.", "What email is for.", "What team is for."]);
  });
});
