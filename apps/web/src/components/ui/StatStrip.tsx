/**
 * A few figures side by side, flat, with hairlines between them (Page-Invoices.dc.html): a quiet
 * label, the figure large and tabular, and a quiet note under it that can carry a change in green or
 * red words. On a tablet four figures go two by two; on a phone they're two across in a filled,
 * rounded block (Mobile-Sales.dc.html), and an odd last one takes the whole row.
 *
 *   <StatStrip label="Invoices">
 *     <Stat label="Awaiting payment" value={formatMoney(owed)} note="7 invoices" delta={{ text: "+8%", tone: "good" }} />
 *     <Stat label="Past due" value={formatMoney(late)} tone="danger" to="/invoices?status=overdue" />
 *   </StatStrip>
 */
import { Children, isValidElement, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./Button";

export function StatStrip({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  const count = Children.toArray(children).filter(isValidElement).length;
  return (
    <div className={cx("strip", className)} role="group" aria-label={label} data-count={count}>
      <div className="strip-grid">{children}</div>
    </div>
  );
}

export function Stat({ label, value, note, delta, tone, to, onClick, title }: {
  label: ReactNode;
  value: ReactNode;
  /** Under the figure, quiet: what it counts ("7 invoices · past 30 days"). */
  note?: ReactNode;
  /** A change, in colored words after the note: { text: "+8%", tone: "good" }, and an optional "vs 30 days ago". */
  delta?: { text: string; tone?: "good" | "danger"; after?: string };
  /** The figure itself in color, only when someone must act on it (past due red). */
  tone?: "warning" | "danger" | "good";
  /** Opens the list behind the figure. */
  to?: string;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <span className="strip-label">{label}</span>
      <span className="strip-value" data-tone={tone}>{value}</span>
      {(note || delta) && (
        <span className="strip-note">
          {note}
          {note && delta && " · "}
          {delta && <span className="strip-delta" data-tone={delta.tone}>{delta.text}</span>}
          {delta?.after && ` ${delta.after}`}
        </span>
      )}
    </>
  );
  if (to) return <Link className={cx("strip-item", "strip-link")} to={to} title={title}>{body}</Link>;
  if (onClick) return <button type="button" className={cx("strip-item", "strip-link")} onClick={onClick} title={title}>{body}</button>;
  return <div className="strip-item" title={title}>{body}</div>;
}
