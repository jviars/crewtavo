/**
 * A menu in the browser's top layer (popover="auto"): light dismiss and Escape come free, and it's
 * never clipped by a card or dialog. Arrow keys move between items, Home and End go to the ends, and a
 * single-letter key hint (kbd) picks its item.
 *
 * Entries (menuModel.ts): an action, a sub menu ({ label, items }), a separator or a heading. An
 * action can carry a key hint (kbd), quiet words on the right (end), a second line (description), an
 * avatar in place of its icon (lead) and a check (checked, with checkbox for a box that leaves the
 * menu open). Put anything destructive last, after a separator.
 *
 * A long list can have a field over it that narrows it (search: the caller filters `items` by its
 * value) and a quiet line at its foot with one action ("2 tags · Clear"), as a filter's popover has.
 *
 * On a desktop a sub menu flies out beside its item: hover, a click, ArrowRight, Enter or Space opens
 * it, and ArrowLeft or Escape closes it. On a phone (900px or narrower, SHEET_QUERY) the whole
 * menu is a bottom sheet over a scrim, with a handle to drag it away and a close button by its title,
 * and a sub menu takes the sheet's place under a heading with a back button.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { flyoutPlacement, hasActions, isAction, isSub, itemRole, nextIndex, sheetDismissed, sheetLevel, shortcutIndex, SHEET_QUERY, type MenuAction, type MenuEntry, type MenuSub } from "./menuModel";
import { t } from "@/lib/i18n";

export type { MenuAction, MenuEntry, MenuSub } from "./menuModel";

const isPhone = () => typeof window !== "undefined" && Boolean(window.matchMedia?.(SHEET_QUERY).matches);
/** Whether a menu element (or one inside it) is showing as the phone's sheet. */
const inSheet = (el: Element | null | undefined) => Boolean(el?.closest("[data-sheet]"));
const isOpen = (el: Element | null | undefined) => {
  try {
    return Boolean(el?.matches(":popover-open"));
  } catch {
    return false;
  }
};

/** The items of one level of a menu that can take focus: its own, not those of a flyout inside it. The search field and the foot's action are in the arrows' round too. */
const levelItems = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLButtonElement | HTMLInputElement>(".menu-search-input, .menu-item, .menu-back, .menu-foot-action")).filter(
    (el) => !el.disabled && el.closest('[role="menu"]') === menu && el.getClientRects().length > 0,
  );

/**
 * Focus the level's first item, skipping the sheet's back button unless it's all there is. A menu
 * with a search field starts in the field on a desktop; on a phone that would pull the keyboard up
 * over the sheet, so there it starts on the first item like any other.
 */
const focusFirst = (menu: HTMLElement) => {
  const items = levelItems(menu);
  const field = items.find((el) => el.classList.contains("menu-search-input"));
  if (field && !menu.hasAttribute("data-sheet")) return field.focus();
  (items.find((el) => !el.classList.contains("menu-back") && el !== field) ?? items[0])?.focus();
};

/** The mouse on an item of this level takes the focus there, so the arrow keys carry on from where it is. */
function followPointer(e: { pointerType: string; target: EventTarget; currentTarget: HTMLElement }) {
  if (e.pointerType !== "mouse") return;
  const at = (e.target as HTMLElement).closest<HTMLButtonElement>(".menu-item");
  if (at && !at.disabled && at !== document.activeElement && at.closest('[role="menu"]') === e.currentTarget) at.focus({ preventScroll: true });
}

/**
 * Keys every level shares (the menu and each flyout): arrows, Home and End move, a key hint picks.
 * True when it handled the key.
 */
function levelKeys(e: KeyboardEvent<HTMLElement>, entries: MenuEntry[]): boolean {
  const menu = e.currentTarget;
  // A flyout handles its own keys, and its events bubble through here.
  if ((e.target as HTMLElement).closest('[role="menu"]') !== menu) return false;
  // In the search field, letters are typed and Home and End move along the words; only the arrows leave it.
  const typing = (e.target as HTMLElement).matches("input");
  if (typing && (e.key === "Home" || e.key === "End")) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    // Moving on from a sub menu's item puts its flyout away, as moving the selection does in a desktop menu.
    for (const fly of menu.querySelectorAll<HTMLElement>(":scope > .menu-sub > .menu-flyout")) if (isOpen(fly)) fly.hidePopover();
    const items: HTMLElement[] = levelItems(menu);
    items[nextIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.key)]?.focus();
    return true;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
  const index = shortcutIndex(entries, e.key);
  if (index < 0) return false;
  e.preventDefault();
  // A click as from the keyboard (detail 0): an action is picked, a sub menu opens with focus in it.
  levelItems(menu).find((el) => el.dataset.index === String(index))?.click();
  return true;
}

/** A field over a menu's items that narrows them; the caller filters `items` by `value`. */
export type MenuSearch = { value: string; onChange: (value: string) => void; placeholder?: string; label?: string };
/** A quiet line at a menu's foot ("2 tags"), with one action on the right ("Clear") that leaves the menu open. */
export type MenuFooter = { text: ReactNode; action?: { label: string; onSelect: () => void; disabled?: boolean } };

export function Menu({
  items,
  label = t("More actions"),
  title,
  trigger,
  triggerClassName = "btn btn-icon",
  align = "end",
  search,
  footer,
}: {
  items: MenuEntry[];
  label?: string;
  /** A heading for the phone's sheet (a desktop menu has none), such as the record it acts on. */
  title?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
  search?: MenuSearch;
  footer?: MenuFooter;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  // The sheet's sub menus, opened one inside another; empty at the top, and always on a desktop.
  const [path, setPath] = useState<number[]>([]);
  // What to focus once the sheet has changed level: the first item, or the item a back step returned to.
  const focusAfter = useRef<"first" | number | null>(null);

  // Under its button, or above it when it doesn't fit below and there's more room above, lined up
  // with its start or end. Never taller than the room it opens into, so a long one (the price list)
  // scrolls inside the window rather than losing its search field off the top.
  const place = () => {
    const b = button.current!.getBoundingClientRect();
    const m = menu.current!;
    const width = Math.max(m.offsetWidth, 220);
    const left = align === "end" ? Math.max(8, b.right - width) : Math.min(b.left, window.innerWidth - width - 8);
    const below = b.bottom + 6;
    m.style.maxHeight = "";
    const spaceBelow = window.innerHeight - 8 - below, spaceAbove = b.top - 14;
    const down = m.offsetHeight <= spaceBelow || spaceBelow >= spaceAbove;
    const room = down ? spaceBelow : spaceAbove;
    if (m.offsetHeight > room) m.style.maxHeight = `${room}px`;
    m.style.left = `${left}px`;
    m.style.top = down ? `${below}px` : "auto";
    m.style.bottom = down ? "auto" : `${window.innerHeight - b.top + 6}px`;
  };

  useEffect(() => {
    const m = menu.current;
    if (!m) return;
    const beforeToggle = (e: Event) => {
      if ((e as Event & { newState: string }).newState !== "open") return;
      // Decided as it opens, so a window resized since gets the right one.
      if (isPhone()) {
        m.dataset.sheet = "";
        m.style.left = m.style.top = m.style.bottom = m.style.maxHeight = "";
      } else {
        delete m.dataset.sheet;
      }
      setPath([]);
    };
    const onToggle = (e: Event) => {
      const nowOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(nowOpen);
      if (nowOpen) {
        if (!m.hasAttribute("data-sheet")) place();
        focusFirst(m);
      }
    };
    m.addEventListener("beforetoggle", beforeToggle);
    m.addEventListener("toggle", onToggle);
    return () => {
      m.removeEventListener("beforetoggle", beforeToggle);
      m.removeEventListener("toggle", onToggle);
    };
  });

  useLayoutEffect(() => {
    const m = menu.current;
    const want = focusAfter.current;
    if (!m || want === null) return;
    focusAfter.current = null;
    if (want === "first") focusFirst(m);
    else levelItems(m).find((el) => el.dataset.index === String(want))?.focus();
  }, [path]);

  // A menu with a search field stays, with nothing in it, while what's typed matches nothing.
  if (!hasActions(items) && !search) return null;
  const level = sheetLevel(items, path);
  const top = level.path.length === 0;
  // A sub menu's sheet names where it came from under its own title: the record, or the sub menu it's in.
  const above = top ? undefined : (sheetLevel(items, level.path.slice(0, -1)).title ?? title);

  const pick = (entry: MenuAction) => {
    if (entry.disabled) return;
    // A check box leaves the menu open, for picking several.
    if (!entry.checkbox) {
      menu.current?.hidePopover();
      button.current?.focus();
    }
    entry.onSelect();
  };
  const push = (index: number) => {
    focusAfter.current = "first";
    setPath([...level.path, index]);
  };
  const back = () => {
    focusAfter.current = level.path[level.path.length - 1] ?? "first";
    setPath(level.path.slice(0, -1));
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        popovertarget={id}
      >
        {trigger ?? <Icon name="more" size={20} />}
      </button>
      <div
        ref={menu}
        id={id}
        className="menu"
        role="menu"
        aria-label={level.title ?? label}
        popover="auto"
        onPointerMove={followPointer}
        onKeyDown={(e) => {
          if (e.key === "Tab") return menu.current?.hidePopover();
          if (levelKeys(e, level.entries)) return;
          if ((e.target as HTMLElement).closest('[role="menu"]') !== e.currentTarget) return;
          // On the sheet, Escape and ArrowLeft step back out of a sub menu before Escape closes it.
          if (level.path.length && (e.key === "Escape" || e.key === "ArrowLeft")) {
            e.preventDefault();
            back();
          }
        }}
      >
        <div className="menu-top" role="none">
          <span className="menu-grab" aria-hidden="true" onPointerDown={(e) => drag(e, menu.current)} />
          {/* The level's title, a sub menu's with the level above's under it, and a way to close the sheet that isn't dragging it. */}
          <div className="menu-sheet-head" role="none">
            {!top && (
              <button type="button" role="menuitem" className="menu-back" aria-label={t("Back")} onClick={back}>
                <Icon name="chevronLeft" size={20} />
              </button>
            )}
            <span className="menu-sheet-titles" aria-hidden="true">
              <span className="menu-sheet-title">{top ? title : level.title}</span>
              {above && <span className="menu-sheet-sub">{above}</span>}
            </span>
            <button type="button" role="menuitem" className="menu-back" aria-label={t("Close")} onClick={() => { menu.current?.hidePopover(); button.current?.focus(); }}>
              <Icon name="x" size={20} />
            </button>
          </div>
        </div>
        {search && top && (
          <div className="menu-search" role="none">
            <Icon name="search" size={15} />
            <input
              className="menu-search-input"
              type="search"
              aria-label={search.label ?? search.placeholder ?? t("Search")}
              placeholder={search.placeholder}
              value={search.value}
              autoComplete="off"
              enterKeyHint="search"
              onChange={(e) => search.onChange(e.target.value)}
            />
          </div>
        )}
        <Entries entries={level.entries} onPick={pick} onPush={push} />
        {search && top && search.value.trim() && !level.entries.some((e) => isAction(e) || isSub(e)) && (
          <div className="menu-empty" role="none">{t("No results for “{query}”", { query: search.value.trim() })}</div>
        )}
        {footer && top && (
          <div className="menu-foot" role="none">
            <span className="menu-foot-text">{footer.text}</span>
            {footer.action && (
              <button type="button" role="menuitem" className="menu-foot-action" disabled={footer.action.disabled} onClick={footer.action.onSelect}>
                {footer.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** One level's entries: the menu's, a flyout's, or the sheet's current sub menu. */
function Entries({ entries, onPick, onPush }: { entries: MenuEntry[]; onPick: (entry: MenuAction) => void; onPush: (index: number) => void }) {
  return (
    <>
      {entries.map((entry, i) =>
        "separator" in entry ? (
          <div key={`s${i}`} className="menu-sep" role="separator" />
        ) : "heading" in entry ? (
          <div key={`h${i}`} className="menu-label">{entry.heading}</div>
        ) : isSub(entry) ? (
          <SubMenu key={`${i}-${entry.label}`} entry={entry} index={i} onPick={onPick} onPush={() => onPush(i)} />
        ) : isAction(entry) ? (
          <ActionItem key={`${i}-${entry.label}`} entry={entry} index={i} onPick={onPick} />
        ) : null,
      )}
    </>
  );
}

function ActionItem({ entry, index, onPick }: { entry: MenuAction; index: number; onPick: (entry: MenuAction) => void }) {
  const role = itemRole(entry);
  return (
    <button
      type="button"
      role={role}
      aria-checked={entry.checked === undefined ? undefined : entry.checked}
      aria-keyshortcuts={entry.kbd?.length === 1 ? entry.kbd : undefined}
      className="menu-item"
      data-index={index}
      data-danger={entry.danger || undefined}
      disabled={entry.disabled}
      title={entry.title}
      onClick={() => onPick(entry)}
    >
      {entry.checkbox && <span className="menu-box" aria-hidden="true">{entry.checked && <Icon name="check" size={12} bold />}</span>}
      {entry.lead ? <span className="menu-lead" aria-hidden="true">{entry.lead}</span> : entry.icon && <Icon name={entry.icon} size={16} />}
      {entry.description ? (
        <span className="menu-text">
          {entry.label}
          <span className="menu-desc">{entry.description}</span>
        </span>
      ) : (
        entry.label
      )}
      {(entry.end || entry.kbd || (role === "menuitemradio" && entry.checked)) && (
        <span className="menu-trail">
          {entry.end && <span className="menu-end">{entry.end}</span>}
          {entry.kbd && <kbd className="menu-kbd" aria-hidden="true">{entry.kbdLabel ?? entry.kbd}</kbd>}
          {role === "menuitemradio" && entry.checked && <span className="menu-check" aria-hidden="true"><Icon name="check" size={14} bold /></span>}
        </span>
      )}
    </button>
  );
}

/** How long the pointer rests on a sub menu's item before it opens, and on another item before it closes. */
const HOVER_OPEN = 120;
const HOVER_CLOSE = 220;

/** A sub menu's item, and on a desktop its flyout: another popover inside this one, so opening it keeps this open. */
function SubMenu({ entry, index, onPick, onPush }: { entry: MenuSub; index: number; onPick: (entry: MenuAction) => void; onPush: () => void }) {
  const id = useId();
  const item = useRef<HTMLButtonElement>(null);
  const fly = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const focusOnOpen = useRef(false);

  const place = () => {
    const f = fly.current;
    const b = item.current;
    const parent = b?.closest<HTMLElement>('[role="menu"]');
    if (!f || !b || !parent) return;
    const spot = flyoutPlacement(parent.getBoundingClientRect(), b.getBoundingClientRect(), { width: f.offsetWidth, height: f.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    f.style.left = `${spot.left}px`;
    f.style.top = `${spot.top}px`;
    f.dataset.side = spot.side;
  };
  const show = (withFocus: boolean) => {
    window.clearTimeout(timer.current);
    const f = fly.current;
    if (!f) return;
    if (isOpen(f)) {
      if (withFocus) focusFirst(f);
      return;
    }
    focusOnOpen.current = withFocus;
    try {
      f.showPopover();
    } catch {
      // Its menu closed in the meantime.
    }
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    if (isOpen(fly.current)) fly.current!.hidePopover();
  };

  useEffect(() => {
    const f = fly.current;
    if (!f) return;
    const onToggle = (e: Event) => {
      const nowOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(nowOpen);
      if (nowOpen) {
        place();
        if (focusOnOpen.current) focusFirst(f);
        return;
      }
      // Closed with the focus in it (Escape, ArrowLeft): back to its item, while the menu it's in is still open.
      const parent = item.current?.closest('[role="menu"]');
      const active = document.activeElement;
      if (isOpen(parent) && (!active || active === document.body || f.contains(active))) item.current?.focus();
    };
    f.addEventListener("toggle", onToggle);
    return () => {
      f.removeEventListener("toggle", onToggle);
      window.clearTimeout(timer.current);
    };
  }, []);

  // Resting the mouse on the item opens it; moving on to another item of the same menu closes it.
  useEffect(() => {
    const b = item.current;
    const parent = b?.parentElement?.closest<HTMLElement>('[role="menu"]');
    if (!b || !parent) return;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || inSheet(b)) return;
      const target = e.target as HTMLElement;
      if (fly.current?.contains(target)) return window.clearTimeout(timer.current);
      const at = target.closest(".menu-item");
      if (!at || at.closest('[role="menu"]') !== parent) return;
      window.clearTimeout(timer.current);
      if (at === b) timer.current = window.setTimeout(() => show(false), HOVER_OPEN);
      else if (isOpen(fly.current)) timer.current = window.setTimeout(hide, HOVER_CLOSE);
    };
    parent.addEventListener("pointerover", over);
    return () => parent.removeEventListener("pointerover", over);
  }, []);

  return (
    <div className="menu-sub" role="none">
      <button
        ref={item}
        type="button"
        role="menuitem"
        className="menu-item"
        data-index={index}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        aria-keyshortcuts={entry.kbd?.length === 1 ? entry.kbd : undefined}
        disabled={entry.disabled}
        // A click from the keyboard (Enter, Space, a key hint) has no detail, and takes the focus into the flyout.
        onClick={(e) => (inSheet(e.currentTarget) ? onPush() : show(e.detail === 0))}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight") return;
          e.preventDefault();
          if (inSheet(e.currentTarget)) onPush();
          else show(true);
        }}
      >
        {entry.lead ? <span className="menu-lead" aria-hidden="true">{entry.lead}</span> : entry.icon && <Icon name={entry.icon} size={16} />}
        {entry.label}
        <span className="menu-trail">
          {entry.end && <span className="menu-end">{entry.end}</span>}
          {entry.kbd && <kbd className="menu-kbd" aria-hidden="true">{entry.kbd}</kbd>}
          <span className="menu-chevron" aria-hidden="true"><Icon name="chevronRight" size={14} /></span>
        </span>
      </button>
      <div
        ref={fly}
        id={id}
        className="menu menu-flyout"
        role="menu"
        aria-label={entry.label}
        popover="auto"
        onPointerMove={followPointer}
        onKeyDown={(e) => {
          if (levelKeys(e, entry.items)) return;
          if ((e.target as HTMLElement).closest('[role="menu"]') !== e.currentTarget) return;
          if (e.key === "ArrowLeft" || e.key === "Escape") {
            // Only this flyout, not the menu it came out of.
            e.preventDefault();
            e.stopPropagation();
            hide();
            item.current?.focus();
          }
        }}
      >
        <Entries entries={entry.items} onPick={onPick} onPush={() => undefined} />
      </div>
    </div>
  );
}

/** Dragging the sheet's handle: it follows the finger down, and goes away if pulled far or flicked. */
function drag(e: ReactPointerEvent<HTMLElement>, sheet: HTMLElement | null) {
  if (!sheet?.hasAttribute("data-sheet") || e.button !== 0) return;
  const grab = e.currentTarget;
  const startY = e.clientY;
  let lastY = startY;
  let lastTime = e.timeStamp;
  let velocity = 0;
  grab.setPointerCapture?.(e.pointerId);
  sheet.dataset.dragging = "";
  const move = (ev: PointerEvent) => {
    velocity = (ev.clientY - lastY) / Math.max(1, ev.timeStamp - lastTime);
    lastY = ev.clientY;
    lastTime = ev.timeStamp;
    sheet.style.transform = `translateY(${Math.max(0, ev.clientY - startY)}px)`;
  };
  const end = (ev: PointerEvent) => {
    grab.removeEventListener("pointermove", move);
    grab.removeEventListener("pointerup", end);
    grab.removeEventListener("pointercancel", end);
    // Back to its transitions, so it settles or slides away from where it was let go.
    delete sheet.dataset.dragging;
    sheet.style.transform = "";
    if (ev.type === "pointerup" && sheetDismissed(Math.max(0, ev.clientY - startY), velocity)) sheet.hidePopover();
  };
  grab.addEventListener("pointermove", move);
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
}
