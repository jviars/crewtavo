/**
 * Home's workflow (Page-Home.dc.html): requests, quotes, jobs and invoices left to right as a flat
 * strip of figures between hairlines, a quiet chevron between them, each with what's under it in
 * small rows. Each stage wears its own color: a rule along its top, its icon and its name (the old
 * Home's, without the box). Words turn amber or red only when someone must act (requests waiting over
 * 2 days, past due). On a phone (Mobile-Work.dc.html) the strip is two across in a rounded block and each figure
 * keeps one short note in place of its rows. Each figure opens its list.
 */
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { statusText } from "@/components/ui/StatusPill";
import { formatMoney } from "@/lib/format";
import type { Dashboard } from "./types";
import styles from "./WorkflowStrip.module.css";

interface Row {
  label: string;
  value: string;
  tone?: "warning" | "danger";
}

interface Column {
  key: string;
  label: string;
  /** The stage's own icon, which also gives the column its color (WorkflowStrip.module.css). */
  icon: IconName;
  to: string;
  /** The figure, and the word after it ("open", "awaiting"). */
  value: number;
  money?: boolean;
  unit: string;
  rows: Row[];
  /** A phone's one line under the figure, amber or red like the row it stands for. */
  note: string;
  noteTone?: "warning" | "danger";
}

/** The four columns, from the dashboard's counts. Pure, so it's unit tested. */
export function workflowColumns(workflow: Dashboard["workflow"], showInvoices = true): Column[] {
  const { requests, quotes, jobs, invoices } = workflow;
  const openQuotes = quotes.awaiting + (quotes.approved ?? 0) + quotes.draft;
  const columns: Column[] = [
    {
      key: "requests", label: "Requests", icon: "requests", to: "/requests",
      value: requests.new + requests.assessment_complete, unit: "open",
      rows: [
        { label: statusText("request", "new"), value: String(requests.new) },
        { label: statusText("request", "assessment_complete"), value: String(requests.assessment_complete) },
        // Late work, not late money: a new request nobody has answered in two days.
        { label: "Waiting over 2 days", value: String(requests.overdue), tone: requests.overdue > 0 ? "warning" : undefined },
      ],
      note: requests.overdue > 0 ? `${requests.overdue} waiting` : `${requests.new} new`,
      noteTone: requests.overdue > 0 ? "warning" : undefined,
    },
    {
      key: "quotes", label: "Quotes", icon: "quote", to: "/quotes",
      value: quotes.awaiting_value + (quotes.approved_value ?? 0) + quotes.draft_value, money: true, unit: `${openQuotes} open`,
      rows: [
        { label: `${statusText("quote", "sent")}, ${quotes.awaiting}`, value: formatMoney(quotes.awaiting_value) },
        { label: `${statusText("quote", "approved")}, ${quotes.approved ?? 0}`, value: formatMoney(quotes.approved_value ?? 0) },
        { label: `${statusText("quote", "draft")}, ${quotes.draft}`, value: formatMoney(quotes.draft_value) },
      ],
      note: `${openQuotes} open`,
    },
    {
      key: "jobs", label: "Jobs", icon: "job", to: "/jobs",
      value: jobs.active, unit: "active",
      rows: [{ label: `${statusText("job", "requires_invoicing")}, ${jobs.to_invoice}`, value: formatMoney(jobs.to_invoice_value) }],
      note: `${jobs.to_invoice} to invoice`,
    },
    {
      key: "invoices", label: "Invoices", icon: "invoice", to: "/invoices",
      value: invoices.awaiting_value, money: true, unit: "awaiting",
      rows: [
        { label: statusText("invoice", "sent"), value: String(invoices.awaiting) },
        { label: statusText("invoice", "draft"), value: String(invoices.draft) },
        { label: `${statusText("invoice", "overdue")}, ${invoices.past_due}`, value: formatMoney(invoices.past_due_value), tone: invoices.past_due > 0 ? "danger" : undefined },
        // Autopay's, only when there's one: charges that failed, and ones waiting for the office's OK.
        ...(invoices.autopay_failed ? [{ label: `Autopay failed, ${invoices.autopay_failed}`, value: formatMoney(invoices.autopay_failed_value ?? 0), tone: "danger" as const }] : []),
        ...(invoices.autopay_approval ? [{ label: "Needs your OK", value: String(invoices.autopay_approval) }] : []),
      ],
      note: invoices.past_due > 0 ? `${formatMoney(invoices.past_due_value)} past due` : `${invoices.awaiting} awaiting`,
      noteTone: invoices.past_due > 0 ? "danger" : undefined,
    },
  ];
  return columns.filter((col) => showInvoices || col.key !== "invoices");
}

export function WorkflowStrip({ workflow, showInvoices = true }: { workflow: Dashboard["workflow"]; showInvoices?: boolean }) {
  return (
    <StatStrip label="Workflow" className={styles.flow}>
      {workflowColumns(workflow, showInvoices).map((col, i) => (
        <Stat
          key={col.key}
          to={col.to}
          label={
            <>
              {i > 0 && <span className={styles.chevron} aria-hidden="true"><Icon name="chevronRight" size={14} /></span>}
              <Icon name={col.icon} size={16} />
              {col.label}
            </>
          }
          value={
            <>
              <AnimatedNumber value={col.value} format={col.money ? MONEY : undefined} />
              <span className={styles.unit}>{col.unit}</span>
            </>
          }
          note={
            <>
              <span className={styles.rows}>
                {col.rows.map((row) => (
                  <span key={row.label} className={styles.row} data-tone={row.tone}>
                    <span>{row.label}</span>
                    <b>{row.value}</b>
                  </span>
                ))}
              </span>
              <span className={styles.note} data-tone={col.noteTone}>{col.note}</span>
            </>
          }
        />
      ))}
    </StatStrip>
  );
}
