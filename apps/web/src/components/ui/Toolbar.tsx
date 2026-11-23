/**
 * The row over a list (B-Inbox.dc.html, Page-Quotes.dc.html): its filters as a segmented control on
 * the left, and on the right the search field, the sort and filter menus and any other small tool.
 * On a phone (components.css) the search is a full-width filled field with the sort and filter as
 * round buttons beside it, and the filters are a row of chips under it that scrolls sideways.
 *
 *   <Toolbar
 *     filters={<FilterTabs label="Filter requests" value={filter} onChange={setFilter} options={[{ value: "open", label: "Open", count: 8 }]} />}
 *     search={<SearchField value={search} onChange={setSearch} placeholder="Search client or #" label="Search requests" />}
 *     tools={<SortMenu value={sort} onChange={setSort} options={[{ value: "newest", label: "Newest first" }, { value: "oldest", label: "Oldest first" }]} />}
 *   />
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "@/lib/i18n";
import { scrollToTab } from "@/lib/tabStrip";
import { cx } from "./Button";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";

export function Toolbar({ filters, search, tools, children, label }: {
  /** The list's filters: a FilterTabs. */
  filters?: ReactNode;
  /** A SearchField. */
  search?: ReactNode;
  /** Small tools on the right, after the search: SortMenu, FilterMenu, a view switch. */
  tools?: ReactNode;
  /** Anything else, on its own line under the row (an active filter's chip, "From website forms ×"). */
  children?: ReactNode;
  label?: string;
}) {
  return (
    <div className="list-tools" role={label ? "group" : undefined} aria-label={label}>
      <div className="toolbar list-toolbar">
        {filters}
        {(search || tools) && (
          <div className="toolbar-end">
            {search}
            {tools}
          </div>
        )}
      </div>
      {children && <div className="toolbar-extra">{children}</div>}
    </div>
  );
}

/** One filter: its words, and a quiet count when there is one. `countTone` danger makes the count red words (Past due 2). */
export type FilterOption<K extends string> = { value: K; label: string; count?: number | null; countTone?: "danger" | "good"; hidden?: boolean };

/**
 * A list's filters as one segmented control (chips on a phone). The chosen one is aria-pressed. When
 * they don't all fit (a phone's chips), the row scrolls itself, never the page, so the chosen one is
 * in view: on the way in (/invoices?status=void) and whenever the choice changes.
 */
export function FilterTabs<K extends string>({ label, value, onChange, options }: { label: string; value: K; onChange: (value: K) => void; options: FilterOption<K>[] }) {
  const strip = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  // What the row holds: the chips shown and their counts, which widen them as they come in.
  const layout = options.map((o) => `${o.hidden ? "" : o.value}:${o.count ?? ""}`).join();
  useEffect(() => {
    const el = strip.current;
    const chip = el?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!el || !chip || el.scrollWidth <= el.clientWidth) return;
    const box = el.getBoundingClientRect();
    const at = chip.getBoundingClientRect();
    const start = at.left - box.left - el.clientLeft + el.scrollLeft;
    // Clear of the 40px fade at an edge with more past it (components.css).
    const left = scrollToTab(start, start + at.width, el.scrollLeft, el.clientWidth, 44);
    if (left === null) return;
    const smooth = shown.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left, behavior: smooth ? "smooth" : "auto" });
  }, [value, layout]);
  useEffect(() => {
    shown.current = true;
  }, []);
  return (
    <div ref={strip} className="tabs" role="group" aria-label={label}>
      {options.filter((o) => !o.hidden).map((o) => (
        <button key={o.value} type="button" className="tab" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && o.count !== null && <span className={cx("badge", o.countTone === "danger" && o.count > 0 && "badge-red", o.countTone === "good" && o.count > 0 && "badge-green")}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Whether a "/" pressed now is for the page, not for something being typed in or a menu or dialog that's open. */
function slashIsFree(e: KeyboardEvent): boolean {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return false;
  const el = e.target as HTMLElement | null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return false;
  try {
    return !document.querySelector("dialog[open], .menu:popover-open, .panel:popover-open");
  } catch {
    return !document.querySelector("dialog[open]");
  }
}

/**
 * A list's search: a quiet filled field with a "/" key hint, and "/" anywhere on the page puts the
 * cursor in it (with `shortcut`, one per page). On other screens "/" opens the command palette; here
 * the list's own search takes it first (a window listener in the capture phase, before the palette's).
 * A phone's is full width, 44px, in 16px type.
 */
export function SearchField({ value, onChange, placeholder, label, shortcut = true, autoFocus }: { value: string; onChange: (value: string) => void; placeholder: string; label: string; shortcut?: boolean; autoFocus?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (!slashIsFree(e) || !input.current?.isConnected) return;
      e.preventDefault();
      e.stopPropagation();
      input.current.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcut]);
  return (
    <label className="search-field">
      <Icon name="search" size={15} />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        aria-keyshortcuts={shortcut ? "/" : undefined}
        enterKeyHint="search"
        autoComplete="off"
        autoFocus={autoFocus}
      />
      {shortcut && !value && <kbd className="kbd search-field-kbd" aria-hidden="true">/</kbd>}
    </label>
  );
}

/**
 * The list's order: a quiet button that says the current order, opening a menu of the orders with a
 * check by the chosen one. On a phone it's a round button with the sort icon, its words still its name.
 */
export function SortMenu<K extends string>({ value, onChange, options, title }: { value: K; onChange: (value: K) => void; options: { value: K; label: string }[]; title?: string }) {
  const current = options.find((o) => o.value === value) ?? options[0]!;
  const items: MenuEntry[] = options.map((o) => ({ label: o.label, checked: o.value === value, onSelect: () => onChange(o.value) }));
  return (
    <Menu
      items={items}
      align="end"
      label={t("Sort: {order}", { order: current.label })}
      title={title ?? t("Sort")}
      triggerClassName="btn btn-sm btn-ghost toolbar-btn"
      trigger={<><Icon name="sort" size={15} /><span className="toolbar-btn-text">{current.label}</span></>}
    />
  );
}

/**
 * Narrowing a list by several values at once (tags, crews, people): check boxes with counts, a
 * search field when there are many, and a foot that says how many are picked with Clear. The button
 * says the filter's name and how many of it are on.
 */
export function FilterMenu<V extends string>({ label, options, selected, onChange, searchPlaceholder, summary, icon = "filter" }: {
  /** The filter's name, on its button and as the sheet's heading ("Tags"). */
  label: string;
  options: { value: V; label: string; count?: number }[];
  selected: readonly V[];
  onChange: (selected: V[]) => void;
  /** Shows a search field over the options ("Find a tag"); worth it past about eight. */
  searchPlaceholder?: string;
  /** The foot's words for how many are picked ("2 tags"); "2 selected" otherwise. */
  summary?: (count: number) => string;
  icon?: "filter" | "tag" | "users" | "user";
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  }, [options, query]);
  const on = new Set(selected);
  const toggle = (value: V) => onChange(on.has(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const items: MenuEntry[] = shown.map((o) => ({ label: o.label, checkbox: true, checked: on.has(o.value), end: o.count === undefined ? undefined : String(o.count), onSelect: () => toggle(o.value) }));
  const count = selected.length;
  return (
    <Menu
      items={items}
      align="end"
      label={count ? t("{filter}, {count} selected", { filter: label, count }) : label}
      title={label}
      triggerClassName={cx("btn btn-sm btn-ghost toolbar-btn", count > 0 && "is-on")}
      trigger={
        <>
          <Icon name={icon} size={15} />
          <span className="toolbar-btn-text">{label}</span>
          {count > 0 && <span className="badge toolbar-btn-count">{count}</span>}
        </>
      }
      search={searchPlaceholder ? { value: query, onChange: setQuery, placeholder: searchPlaceholder } : undefined}
      footer={{ text: summary ? summary(count) : t("{count} selected", { count }), action: { label: t("Clear"), onSelect: () => onChange([]), disabled: count === 0 } }}
    />
  );
}
