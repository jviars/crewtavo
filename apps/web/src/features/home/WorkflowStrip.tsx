import { Link } from "react-router-dom";
import { AnimatedNumber, moneyCompact } from "@/components/ui/AnimatedNumber";
import { Icon, type IconName } from "@/components/ui/Icon";
import { formatMoneyCompact } from "@/lib/format";
import type { Dashboard } from "./types";
import styles from "./WorkflowStrip.module.css";

interface Column {
  key: string;
  label: string;
  icon: IconName;
  to: string;
  color: string;
  textColor: string;
  count: number;
  value?: number;
  caption: string;
  rows: Array<{ label: string; value: string; danger?: boolean }>;
}

export function WorkflowStrip({ workflow, showInvoices = true }: { workflow: Dashboard["workflow"]; showInvoices?: boolean }) {
  const { requests, quotes, jobs, invoices } = workflow;
  const columns: Column[] = [
    {
      key: "requests", label: "Requests", icon: "requests", to: "/requests", color: "var(--req)", textColor: "var(--req-text)",
      count: requests.new, caption: "New",
      rows: [
        { label: "Assessment complete", value: String(requests.assessment_complete) },
        { label: "Overdue", value: String(requests.overdue) },
      ],
    },
    {
      key: "quotes", label: "Quotes", icon: "quote", to: "/quotes", color: "var(--quote)", textColor: "var(--quote-text)",
      count: quotes.awaiting, value: quotes.awaiting_value, caption: "Awaiting response",
      rows: [
        { label: `Approved (${quotes.approved ?? 0})`, value: formatMoneyCompact(quotes.approved_value ?? 0) },
        { label: `Draft (${quotes.draft})`, value: formatMoneyCompact(quotes.draft_value) },
      ],
    },
    {
      key: "jobs", label: "Jobs", icon: "job", to: "/jobs", color: "var(--job)", textColor: "var(--job-text)",
      count: jobs.to_invoice, value: jobs.to_invoice_value, caption: "Require invoicing",
      rows: [{ label: "Active", value: String(jobs.active) }],
    },
    {
      key: "invoices", label: "Invoices", icon: "invoice", to: "/invoices", color: "var(--invoice)", textColor: "var(--invoice-text)",
      count: invoices.awaiting, value: invoices.awaiting_value, caption: "Awaiting payment",
      rows: [
        { label: `Draft (${invoices.draft})`, value: "" },
        { label: `Past due (${invoices.past_due})`, value: formatMoneyCompact(invoices.past_due_value), danger: invoices.past_due > 0 },
      ],
    },
  ];

  return (
    <section aria-labelledby="workflow-title" className={styles.section}>
      <h2 id="workflow-title" className="section-title">Workflow</h2>
      <div className={styles.strip} style={{ ["--cols" as string]: showInvoices ? 4 : 3 }}>
        {columns.filter((col) => showInvoices || col.key !== "invoices").map((col, i) => (
          <Link key={col.key} to={col.to} className={styles.column} style={{ borderTopColor: col.color }}>
            {i > 0 && <span className={styles.chevron} aria-hidden="true"><Icon name="chevronRight" size={12} /></span>}
            <span className={styles.label} style={{ color: col.textColor }}>
              <span style={{ color: col.color }}><Icon name={col.icon} /></span>
              {col.label}
            </span>
            <span>
              <span className={styles.countRow}>
                <AnimatedNumber className={styles.count} value={col.count} />
                {col.value !== undefined && <AnimatedNumber className="muted" value={col.value} format={moneyCompact(col.value)} />}
              </span>
              <span className={styles.caption}>{col.caption}</span>
            </span>
            <span className={styles.rows}>
              {col.rows.map((row) => (
                <span key={row.label} className={styles.row} style={row.danger ? { color: "var(--danger)", fontWeight: 600 } : undefined}>
                  <span>{row.label}</span>
                  <span>{row.value}</span>
                </span>
              ))}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
