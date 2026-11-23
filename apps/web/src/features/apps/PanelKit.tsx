/**
 * The small parts an app's panels are built from, so every app's page reads the same: each panel is
 * a Section (components/ui/Section) with `className={kit.panel}`, and in it go quiet notes, numbered
 * Steps, values to copy as CodeRows, a CodeBlock to paste, a Fold for what's optional, SwitchLines,
 * and lists as hairline rows (kit.rows, kit.row). The look is in PanelKit.module.css.
 *
 *   <Section title="Set up QuickBooks" className={kit.panel}>
 *     <p className={kit.note}>It's free, and these steps give you everything Intuit asks for.</p>
 *     <Steps>
 *       <Step>Sign in to Intuit Developer …</Step>
 *       <Step><span>Add this under Redirect URIs:</span><CodeRow label="Redirect URI" value={uri} /></Step>
 *     </Steps>
 *   </Section>
 */
import { useId, type ReactNode } from "react";
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { copyText } from "@/lib/clipboard";
import styles from "./PanelKit.module.css";

export const kit = styles;

/** Numbered steps, each in a small grey circle. */
export function Steps({ children, label }: { children: ReactNode; label?: string }) {
  return <ol className={styles.steps} aria-label={label}>{children}</ol>;
}

/** One step: its words, then anything it needs (a value to copy, a button), stacked. */
export function Step({ children }: { children: ReactNode }) {
  return <li><div className={styles.step}>{children}</div></li>;
}

/** Copy, quietly: a small button whose words stay "Copy" and whose name says what it copies. */
export function CopyButton({ value, what, done = "Copied" }: { value: string; what?: string; done?: string }) {
  return (
    <button type="button" className={styles.copy} aria-label={what ? `Copy ${what}` : undefined} onClick={() => copyText(value, done)}>
      <Icon name="copy" size={13} />Copy
    </button>
  );
}

/**
 * A value to copy into another app's form (or a website), on a hairline row: the name that form
 * gives it, the value in a mono face, and Copy. With no label the value takes the row.
 */
export function CodeRow({ label, value, done, name }: { label?: string; value: string; done?: string; name?: string }) {
  return (
    <div className={cx(styles.codeRow, !label && styles.bare)}>
      {label && <span className={styles.codeLabel}>{label}</span>}
      <code className={styles.codeValue} aria-label={name}>{value}</code>
      <CopyButton value={value} what={label ?? name} done={done ?? (label ? `${label} copied` : "Copied")} />
    </div>
  );
}

/** A block of code to paste somewhere else, on the faintest fill, with Copy in its corner. */
export function CodeBlock({ code, what, done = "Copied" }: { code: string; what?: string; done?: string }) {
  return (
    <div className={styles.codeBlock}>
      <pre aria-label={what}>{code}</pre>
      <CopyButton value={code} what={what} done={done} />
    </div>
  );
}

/** What's optional, shut until it's asked for; `note` says quietly what's in it now. */
export function Fold({ summary, note, open, children }: { summary: ReactNode; note?: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details className={styles.fold} open={open || undefined}>
      <summary>
        {summary}
        {note && <span className={styles.foldNote}>· {note}</span>}
      </summary>
      <div className={styles.foldBody}>{children}</div>
    </details>
  );
}

/** A switch on a hairline row: its words are its label, the quiet line under them describes it. */
export function SwitchLine({ label, hint, checked, onChange, disabled, children }: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  /** Under the words: what goes with it (when the last change was sent). */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.switchLine}>
      <input id={id} type="checkbox" className="switch" checked={checked} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={(e) => onChange(e.target.checked)} />
      <div className={styles.switchText}>
        <label htmlFor={id} className={styles.switchLabel}>{label}</label>
        {hint && <span id={`${id}-hint`} className={styles.hint}>{hint}</span>}
        {children}
      </div>
    </div>
  );
}

/**
 * A thing on a hairline row: something on the left, its name and a quiet line, and its buttons.
 * `basis`: how wide the words stay before the buttons wrap under them (a long name on a phone).
 */
export function Row({ lead, title, badge, sub, problem, end, off, basis, children }: {
  lead?: ReactNode;
  title: ReactNode;
  /** After the name: a small chip ("Main"). */
  badge?: ReactNode;
  sub?: ReactNode;
  /** What's gone wrong, in red under the quiet line. */
  problem?: ReactNode;
  end?: ReactNode;
  /** Turned off: the words fade. */
  off?: boolean;
  basis?: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.row} data-off={off || undefined}>
      {lead && <span className={styles.rowLead}>{lead}</span>}
      <div className={styles.rowText} style={basis ? { flex: `1 1 ${basis}` } : undefined}>
        <span className={styles.rowTitle}><span>{title}</span>{badge}</span>
        {sub && <span className={styles.rowSub}>{sub}</span>}
        {problem && <span className={styles.rowProblem}><Icon name="alert" size={13} />{problem}</span>}
        {children}
      </div>
      {end && <div className={styles.rowEnd}>{end}</div>}
    </div>
  );
}

/** Rows standing in for a list while it loads. */
export function RowsSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className={styles.rows} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.row}>
          <Skeleton width={28} height={28} radius={8} />
          <div className={styles.rowText}><Skeleton width="38%" height={12} /><Skeleton width={i % 2 ? "52%" : "64%"} height={10} /></div>
        </div>
      ))}
    </div>
  );
}

/** Parts of a quiet line, a dot between each and empty ones left out. */
export const dotted = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" · ");
