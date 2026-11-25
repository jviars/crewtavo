/**
 * A list page's records as inbox rows (B-Inbox.dc.html), grouped by what needs doing: each group a
 * sentence-case heading with a quiet count, each row an initials avatar, the name and #number, the
 * subject, a quiet meta line, and money or an age on the right. The whole row opens the record: its
 * link is stretched over the row, so the row is one Tab stop, and buttons inside it (a check box,
 * "Book it", hover actions) still work. On a phone (components.css, max-width 900px) the rows are
 * the phone kit's: a 40px avatar, 16px names, edge to edge, hairlines from the text.
 *
 *   <InboxList label="Requests" foot={<ListFoot>8 open requests</ListFoot>}>
 *     <InboxGroup label="Waiting over 2 days" count={3} tone="warning" icon="clock">
 *       <InboxRow to="/requests/1" title="Corbin Dental" number={5} subject="Snow removal" meta={["Website form", "88 Main St"]} aside={<RowAge at={created} tone="warning" />} />
 *     </InboxGroup>
 *   </InboxList>
 */
import { createContext, Fragment, useContext, useId, useLayoutEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { copyText } from "@/lib/clipboard";
import { dateLocale, formatDateTime } from "@/lib/format";
import { intlLocale, t } from "@/lib/i18n";
import { initials } from "./Avatar";
import { cx } from "./Button";
import { ContextMenu } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";
import type { MenuEntry } from "./menuModel";
import { listWalk, withWalk } from "./RecordSteps";
import { shiftHeld, useHoldToPick, type Selection } from "./Selection";

/** What a group heading says about its rows: amber for waiting too long, red for gone wrong, green for ready. */
export type GroupTone = "warning" | "danger" | "good";

const ListLabel = createContext<string | undefined>(undefined);

/**
 * The list: groups, then its foot. `label` names a group with no heading for a screen reader.
 * `stale` dims it while another filter's rows load (keepPreviousData). `inset` is for a phone screen
 * with grouped sections (DetailColumns grouped): the rows sit in a rounded card rather than edge to edge.
 */
export function InboxList({ label, children, foot, stale, inset, className }: { label: string; children: ReactNode; foot?: ReactNode; stale?: boolean; inset?: boolean; className?: string }) {
  return (
    <ListLabel.Provider value={label}>
      {/* A mouse's right-click on a row (rowMenu); on a phone, holding a row picks it instead (InboxRow). */}
      <ContextMenu className={cx("il", inset && "il-inset", stale && "is-stale", className)} aria-busy={stale || undefined} touch={false} items={rowMenu}>
        {children}
        {foot}
      </ContextMenu>
    </ListLabel.Provider>
  );
}

/**
 * Right-click on a row that opens a page: open it, here or in a new tab, pick it where it has a box,
 * or copy its link. A link in the row to somewhere else (a client's name) keeps the browser's own
 * menu, so its "Open in new tab" and "Copy link" are for where it goes, not for the row.
 */
function rowMenu(target: Element): MenuEntry[] | null {
  const row = target.closest(".il-row");
  const link = row?.querySelector<HTMLAnchorElement>("a.il-link[href]");
  if (!row || !link) return null;
  const other = target.closest("a[href]");
  if (other && other !== link) return null;
  const box = row.querySelector<HTMLInputElement>("input[data-pick]");
  return [
    { label: t("Open"), icon: "arrowRight", onSelect: () => link.click() },
    { label: t("Open in a new tab"), icon: "external", onSelect: () => window.open(link.href, "_blank", "noopener") },
    { label: box?.checked ? t("Deselect") : t("Select"), icon: box?.checked ? "x" : "check", hidden: !box, onSelect: () => box?.click() },
    { separator: true },
    { label: t("Copy link"), icon: "link", onSelect: () => void copyText(link.href, t("Link copied")) },
  ];
}

/**
 * One group of rows under its heading (an h2). Without a label the rows are a plain list. `icon` sits
 * before the label in the tone's color; `end` is on the right: a quiet sum ("$6,200") or a link that
 * acts on the whole group ("Remind both").
 */
export function InboxGroup({ label, count, tone, icon, end, children }: { label?: ReactNode; count?: number | string; tone?: GroupTone; icon?: IconName; end?: ReactNode; children: ReactNode }) {
  const listLabel = useContext(ListLabel);
  const id = useId();
  if (!label) return <ul className="il-rows" role="list" aria-label={listLabel}>{children}</ul>;
  return (
    <section className="il-group" aria-labelledby={id}>
      <div className="il-head">
        {icon && <span className="il-head-icon" data-tone={tone}><Icon name={icon} size={14} /></span>}
        <h2 className="il-head-label" id={id}>{label}</h2>
        {count !== undefined && <span className="il-count">{count}</span>}
        {end && <span className="il-head-end">{end}</span>}
      </div>
      <ul className="il-rows" role="list">{children}</ul>
    </section>
  );
}

/**
 * Where the row goes: a page (`to`, with `replace` for a popup on this page that the URL names), or, for
 * a row that opens something on this page (a viewer, a pane, a dialog), `onClick`. Neither: a row with
 * nothing to open (a post that already went out), the same lines with no link.
 */
type InboxRowTarget =
  | { to: string; replace?: boolean; onClick?: undefined }
  | { onClick: () => void; to?: undefined; replace?: undefined }
  | { to?: undefined; onClick?: undefined; replace?: undefined };

export type InboxRowProps = InboxRowTarget & {
  /** The first line, bold: the client or person (or the record's own name when it has no client). */
  title: ReactNode;
  /** The record's number, quiet after the title as "#5". */
  number?: number | string | null;
  /** After the number on the first line: a .tag, or a short colored note (.il-note). */
  badge?: ReactNode;
  /** The second line: what it's about. */
  subject?: ReactNode;
  /** The third line, quiet and small: a status, where it came from, a date. A list gets dots between its parts and drops empty ones. */
  meta?: ReactNode | ReactNode[];
  /** The right column, top to bottom: money or an age, then a quiet line or a face (RowAge, .il-money, .il-sub). */
  aside?: ReactNode;
  /** Whose initials (defaults to the title), your own node (a Face, an icon), or false for no avatar. */
  avatar?: string | ReactNode | false;
  /** A thing rather than a person (equipment, a file): a rounded square. */
  square?: boolean;
  /** A green dot on the left: new since they last looked, or (a string) what the dot means here, for a screen reader and its tooltip ("New"). */
  unread?: boolean | string;
  /** Quick actions shown over the aside while the row is hovered or has focus, on a desktop only: never the only way to do something. */
  actions?: ReactNode;
  /** Bulk picking (Selection.tsx): a box at the start of the row. Needs `id` and `selectLabel`. */
  selection?: Selection;
  id?: string;
  selectLabel?: string;
  /** Router state for the link. */
  state?: unknown;
  /** The one open beside the list (a conversation in its pane): data-current on the row, aria-current on its link. */
  current?: boolean;
  /** On the row, for a screen's own rules. */
  className?: string;
  /** More lines after the meta line (where a post went, a note): its links and buttons work as the row's own do. */
  children?: ReactNode;
};

/**
 * One record. Its link holds the first two lines, so they're what a screen reader says for it. With
 * `onClick` instead of `to` the link is a button (.il-link-button) that looks and focuses the same;
 * with neither, the lines are plain (.il-lines) and the row doesn't light up under the pointer.
 */
export function InboxRow({ to, replace, onClick, title, number, badge, subject, meta, aside, avatar, square, unread, actions, selection, id, selectLabel, state, current, className, children }: InboxRowProps) {
  const face = avatar === false ? null : typeof avatar === "string" || avatar === undefined ? initials(typeof avatar === "string" ? avatar : typeof title === "string" ? title : "") : avatar;
  const picked = selection && id ? selection.has(id) : false;
  const hold = useHoldToPick(selection && id ? selection : undefined);
  const dot = unread ? (typeof unread === "string" ? unread : t("Unread")) : null;
  const navigate = useNavigate();
  // A plain click takes the list's rows along, for the record's ‹ › (RecordSteps). A click with a
  // key held (a new tab, a new window) is the browser's, as is any row with nothing to add.
  const open = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (to === undefined || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
    const next = withWalk(state, listWalk(e.currentTarget));
    if (next === state) return;
    e.preventDefault();
    navigate(to, { state: next, replace });
  };
  const lines = (
    <>
      {dot && <span className="sr-only">{dot}: </span>}
      <span className="il-l1">
        <span className="il-title">{title}</span>
        {number != null && number !== "" && <span className="il-num">#{number}</span>}
        {badge}
      </span>
      {subject && <span className="il-subject">{subject}</span>}
    </>
  );
  return (
    <li
      className={cx("il-row", face === null && "il-row-flat", selection && "il-row-pick", to === undefined && !onClick && "il-row-static", className)}
      data-selected={picked || undefined}
      data-current={current || undefined}
      // A phone shows the boxes only once Select is pressed or something is picked (components.css); a desktop also under the pointer or the keyboard.
      data-pick-off={(selection && !selection.active) || undefined}
      {...hold}
    >
      {selection && id && (
        <label className="il-check">
          <input type="checkbox" data-pick={id} aria-label={selectLabel ?? t("Select")} checked={picked} onChange={(e) => selection.toggle(id, shiftHeld(e))} />
        </label>
      )}
      {dot && <span className="il-unread" aria-hidden="true" title={dot} />}
      {face !== null && <span className={cx("il-avatar", square && "il-avatar-square")} aria-hidden="true">{face}</span>}
      <div className="il-body">
        {to !== undefined ? (
          <Link className="il-link" to={to} state={state} replace={replace} aria-current={current || undefined} onClick={open}>{lines}</Link>
        ) : onClick ? (
          <button type="button" className="il-link il-link-button" onClick={onClick} aria-current={current || undefined}>{lines}</button>
        ) : (
          <div className="il-lines">{lines}</div>
        )}
        <MetaLine className="il-meta" parts={meta} />
        {children != null && children !== false && <div className="il-extra">{children}</div>}
      </div>
      {(aside || actions) && (
        <div className="il-aside">
          {aside}
          {actions && <div className="il-actions">{actions}</div>}
        </div>
      )}
    </li>
  );
}

/**
 * A quiet line of parts with a dot between each: parts={["Website form", "88 Main St"]} reads "Website
 * form · 88 Main St". Empty parts (null, false, "") are left out, so a missing address leaves no stray
 * dot. A prop, not children, so the parts need no keys. Where the line wraps, the dot goes with the
 * part after it (wrapDots), so no line ends or starts with one. Give a part className="meta-break"
 * to start its own line on a phone (a time asked for, with its Book it button).
 */
export function MetaLine({ parts: given, className }: { parts?: ReactNode | ReactNode[]; className?: string }) {
  const parts = (Array.isArray(given) ? given : [given]).filter((p) => p !== null && p !== undefined && p !== false && p !== "");
  const line = useRef<HTMLDivElement>(null);
  const shown = parts.length > 0;
  useLayoutEffect(() => {
    const el = line.current;
    if (!el || !resized) return;
    resized.observe(el);
    return () => resized.unobserve(el);
  }, [shown]);
  // The parts may have changed without the line changing size.
  useLayoutEffect(() => {
    if (line.current) wrapDots(line.current);
  });
  if (!shown) return null;
  return (
    <div ref={line} className={cx("meta-line", className)}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="meta-dot" aria-hidden="true">·</span>}
          {typeof part === "string" || typeof part === "number" ? <span>{part}</span> : part}
        </Fragment>
      ))}
    </div>
  );
}

/** One observer for every meta line: a line that changes width may wrap somewhere else. */
const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => entries.forEach((e) => wrapDots(e.target as HTMLElement)));

/**
 * A dot is a flex item of its own, so a wrapped line could end with one (or the next start with it).
 * Such a dot is marked data-wrap (components.css): one ending a line keeps its room but isn't seen, so
 * the wrap stays where it is; one starting a line is taken out. Dots a page's own CSS hides are left be.
 */
export function wrapDots(line: HTMLElement) {
  const dots = [...line.querySelectorAll<HTMLElement>(":scope > .meta-dot")];
  dots.forEach((dot) => dot.removeAttribute("data-wrap"));
  const box = (el: Element | null) => (el && el.getClientRects().length ? el.getBoundingClientRect() : null);
  const near = (dot: Element, way: "previousElementSibling" | "nextElementSibling") => {
    let el = dot[way];
    while (el && !box(el)) el = el[way];
    return box(el);
  };
  // Measured first, then marked, so one mark doesn't move the next dot before it's measured.
  const marks = dots.map((dot) => {
    const at = box(dot);
    if (!at) return null;
    const before = near(dot, "previousElementSibling"), after = near(dot, "nextElementSibling");
    if (!before || before.bottom <= at.top) return "start";
    return !after || after.top >= at.bottom ? "end" : null;
  });
  dots.forEach((dot, i) => marks[i] && dot.setAttribute("data-wrap", marks[i]));
}

/**
 * How long ago, as short as a list's right edge needs: "5m", "3h", "4d", "2w", then "Oct 3". The full
 * date and time is its tooltip. `tone` colors it when the wait is the problem (warning amber, danger red).
 */
export function RowAge({ at, tone, timeZone }: { at: string; tone?: "warning" | "danger"; timeZone?: string }) {
  return <time className="il-age" data-tone={tone} dateTime={at} title={formatDateTime(at, timeZone)}>{shortAge(at)}</time>;
}

/** "5m", "3h", "4d", "2w", "Oct 3", or "Oct 2025" from another year. */
export function shortAge(value: string | Date, now = Date.now()): string {
  const then = new Date(value);
  const minutes = Math.max(0, (now - then.getTime()) / 60_000);
  const unit = (n: number, u: "minute" | "hour" | "day" | "week") => new Intl.NumberFormat(intlLocale(), { style: "unit", unit: u, unitDisplay: "narrow" }).format(n);
  if (minutes < 60) return unit(Math.max(1, Math.floor(minutes)), "minute");
  if (minutes < 1440) return unit(Math.floor(minutes / 60), "hour");
  const days = Math.floor(minutes / 1440);
  if (days < 7) return unit(days, "day");
  if (days < 35) return unit(Math.floor(days / 7), "week");
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return then.toLocaleDateString(dateLocale(), sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}

/**
 * Under the list: a quiet "8 open requests" on the left, an optional total on the right (`end`, with
 * the figure in <b>), and Load more when there are more than it shows.
 */
export function ListFoot({ children, end, more }: { children: ReactNode; end?: ReactNode; more?: { onClick: () => void; loading?: boolean; label?: string } }) {
  return (
    <div className="il-foot">
      <span>{children}</span>
      {end && <span className="il-foot-end">{end}</span>}
      {more && (
        <button type="button" className="il-more" onClick={more.onClick} disabled={more.loading} aria-busy={more.loading || undefined}>
          {more.loading && <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />}
          {more.label ?? t("Load more")}
        </button>
      )}
    </div>
  );
}

/** The dark colors a person's small face takes (white initials read on each), picked by their name so it's always the same one. */
const HUES = ["#2f6f6a", "#6b3fa0", "#2357a8", "#a8471b", "#3c7a1f", "#94580e", "#a72940", "#1d6b66"];
export const personHue = (name: string) => HUES[[...name].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length]!;

/** A small face in the right column: who it's assigned to, or a dashed ring for nobody yet. */
export function RowPerson({ name, empty }: { name?: string | null; empty?: string }) {
  if (!name) return <span className="il-person il-person-none" title={empty ?? t("Not assigned")} role="img" aria-label={empty ?? t("Not assigned")} />;
  return <span className="il-person" style={{ background: personHue(name) }} title={name} role="img" aria-label={name}>{initials(name)}</span>;
}
