/**
 * A part of a page on a hairline, not in a box (Page-Client.dc.html): a 15px heading with a quiet
 * count, and on the right one quiet action ("Add property", "Edit", "All invoices"). What's under it
 * is the page's own: facts (Facts), a short list of related records (RelatedList), a form, a note.
 * On a phone a grouped page (DetailColumns grouped) shows each section as the phone kit's inset
 * card under a small grey heading; otherwise the hairline stays.
 *
 *   <Section title="Details" action={<Link to="edit">Edit</Link>}>
 *     <Facts>
 *       <Fact label="Email">{client.email}</Fact>
 *       <Fact label="Phone">{client.phone}</Fact>
 *     </Facts>
 *   </Section>
 */
import { useId, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./Button";
import { Icon, type IconName } from "./Icon";
import { MetaLine } from "./InboxList";

export function Section({ title, count, action, icon, children, level = 2, className, id, flush }: {
  title: ReactNode;
  /** A quiet number after the title: how many there are. */
  count?: number | string;
  /** On the right: a link or a button, drawn as a quiet text link. One per section. */
  action?: ReactNode;
  /** A quiet icon before the title, only where it helps tell sections apart. */
  icon?: IconName;
  children?: ReactNode;
  /** The heading's level: 2 on a page, 3 inside another section. */
  level?: 2 | 3;
  className?: string;
  id?: string;
  /** No inset card on a grouped phone page (a section that is itself a list, chart or form). */
  flush?: boolean;
}) {
  const headingId = useId();
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <section className={cx("sec", flush && "sec-flush", className)} id={id} aria-labelledby={headingId}>
      <div className="sec-head">
        {icon && <span className="sec-icon"><Icon name={icon} size={15} /></span>}
        <Heading className="sec-title" id={headingId}>{title}</Heading>
        {count !== undefined && count !== null && <span className="sec-count">{count}</span>}
        {action && <div className="sec-action">{action}</div>}
      </div>
      {children !== undefined && children !== null && children !== false && <div className="sec-body">{children}</div>}
    </section>
  );
}

/** Facts as label and value on hairline rows (a <dl>). A Fact with nothing to show leaves no row. */
export function Facts({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <dl className={cx("facts", className)} aria-label={label}>{children}</dl>;
}

/**
 * One fact: its label quiet on the left, its value in ink. With no value (null, undefined, "" or
 * false) there's no row at all, so a page never shows a "—". `tone` colors a value someone must act on.
 */
export function Fact({ label, children, tone, wide }: { label: ReactNode; children?: ReactNode; tone?: "warning" | "danger" | "good"; wide?: boolean }) {
  if (children === null || children === undefined || children === "" || children === false) return null;
  return (
    <div className={cx("fact", wide && "fact-wide")}>
      <dt className="fact-label">{label}</dt>
      <dd className="fact-value" data-tone={tone}>{children}</dd>
    </div>
  );
}

/**
 * A section's short list of other records (a client's invoices, a job's visits): small rows, no avatars.
 * On a phone a row that opens something shows a quiet chevron (components.css). `className="rel-figures"`
 * suits rows that end in a figure (money, a quantity): on a phone the figure sits on the title's line and
 * the quiet line runs under both, as an inbox row's does.
 */
export function RelatedList({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return <ul className={cx("rel", className)} role="list" aria-label={label}>{children}</ul>;
}

/**
 * One related record. `to` makes the whole row a link (its title is the link, stretched over the
 * row); buttons in `actions` still work. `lead` is a quiet column on the left (#212, a time, a small
 * face); `detail` follows the title quietly ("· 12 Commerce Ct"); `sub` is a second, smaller line
 * (a string or a list, dotted like a meta line); `end` sits on the right (a status, money).
 */
export function RelatedRow({ to, onClick, lead, title, detail, sub, end, actions, current }: {
  to?: string;
  onClick?: () => void;
  lead?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  sub?: ReactNode | ReactNode[];
  end?: ReactNode;
  actions?: ReactNode;
  /** The record this page is about, in a list of its siblings. */
  current?: boolean;
}) {
  const head = (
    <>
      <span className="rel-title">{title}</span>
      {detail && <span className="rel-detail"> · {detail}</span>}
    </>
  );
  return (
    <li className={cx("rel-row", (to || onClick) && "rel-row-link")} aria-current={current || undefined}>
      {lead !== undefined && lead !== null && <span className="rel-lead">{lead}</span>}
      <div className="rel-body">
        {to ? (
          <Link className="rel-link" to={to}>{head}</Link>
        ) : onClick ? (
          <button type="button" className="rel-link" onClick={onClick}>{head}</button>
        ) : (
          <span className="rel-head">{head}</span>
        )}
        <MetaLine className="rel-sub" parts={sub} />
      </div>
      {end !== undefined && end !== null && end !== false && <span className="rel-end">{end}</span>}
      {actions && <span className="rel-actions">{actions}</span>}
    </li>
  );
}
