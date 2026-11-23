/**
 * A right-click menu, on Base UI's ContextMenu (MIT), drawn as Menu.tsx's menus are (the same
 * entries, menuModel.ts, and the same .menu look; a sub menu isn't offered here). It's a quicker way
 * in, never the only one: whatever it offers is on the page too (a row opens with a click, its ⋯
 * menu has the rest), since not everyone knows to right-click, or can.
 *
 * The browser's own menu still comes up where it's what's wanted: over a text field, over words
 * picked to copy, and wherever there's nothing to offer.
 */
import { ContextMenu as Base } from "@base-ui/react/context-menu";
import { useRef, useState, type HTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { Icon } from "./Icon";
import { layerFor } from "./layer";
import { hasActions, isAction, visibleEntries, type MenuEntry } from "./menuModel";

/** How long a touch counts as how a right-click came, where the event doesn't say. */
const TOUCH_MS = 1000;

export function ContextMenu({
  items,
  touch = true,
  render,
  children,
  style,
  onContextMenu,
  onPointerDown,
  onTouchStart,
  ...props
}: {
  /** The entries, or a way to get them for what was right-clicked (null for the browser's own). */
  items: MenuEntry[] | ((target: Element) => MenuEntry[] | null);
  /** Whether holding a finger down opens it too: not where that already does something (useHoldToPick). */
  touch?: boolean;
  /** The element it's on, e.g. <li />: a <div> otherwise. */
  render?: ReactElement;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "children">) {
  // What was right-clicked, for its entries and the layer to open in.
  const [target, setTarget] = useState<Element | null>(null);
  // Where focus was before it opened, to go back to.
  const before = useRef<HTMLElement | null>(null);
  const lastPointer = useRef({ type: "", at: 0 });
  const entriesFor = (el: Element) => {
    const list = typeof items === "function" ? items(el) : items;
    return list && hasActions(list) ? visibleEntries(list).filter((e) => !("items" in e)) : [];
  };

  const byTouch = (e: ReactMouseEvent) => {
    // Chrome says which pointer a contextmenu came from; elsewhere it's the last one pressed here.
    const type = (e.nativeEvent as Partial<PointerEvent>).pointerType;
    if (type) return type === "touch";
    return lastPointer.current.type === "touch" && Date.now() - lastPointer.current.at < TOUCH_MS;
  };
  /** Whether there's a menu for this spot: not over a text field, and only with something in it. */
  const offers = (el: Element) =>
    !el.closest('input:not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable]:not([contenteditable="false"])') && entriesFor(el).some(isAction);
  const wanted = (e: ReactMouseEvent) => {
    const el = e.target as Element;
    if (!touch && byTouch(e)) return false;
    const picked = window.getSelection();
    if (picked && !picked.isCollapsed && picked.containsNode(el, true)) return false;
    return offers(el);
  };
  const remember = (el: Element) => {
    const focused = document.activeElement;
    before.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    setTarget(el);
  };

  return (
    <Base.Root>
      <Base.Trigger
        render={render}
        {...props}
        // Base UI stops a held finger's callout (copy, open in a new tab) so its menu can take the
        // hold; where it doesn't take it, the phone's stays.
        style={touch ? style : { WebkitTouchCallout: undefined, ...style }}
        onPointerDown={(e) => {
          lastPointer.current = { type: e.pointerType, at: Date.now() };
          onPointerDown?.(e);
        }}
        onTouchStart={(e) => {
          onTouchStart?.(e);
          // A held finger opens it from Base UI's own timer, with no contextmenu event on an
          // iPhone: what it's on is noted now.
          if (!touch || !offers(e.target as Element)) e.preventBaseUIHandler();
          else remember(e.target as Element);
        }}
        onContextMenu={(e) => {
          onContextMenu?.(e);
          // One inside another (a row's own in a list's): the inner one has it.
          if (e.isDefaultPrevented()) {
            e.preventBaseUIHandler();
            return;
          }
          if (!wanted(e)) {
            // The browser's menu, then: Base UI turns it off for the whole area unless the event
            // stops here.
            e.preventBaseUIHandler();
            e.stopPropagation();
            return;
          }
          remember(e.target as Element);
        }}
      >
        {children}
      </Base.Trigger>
      {/* In the layer what was right-clicked is in (a dialog, a popover), where one on the page would sit behind it. */}
      <Base.Portal container={layerFor(target) ?? undefined}>
        <Base.Positioner className="menu-positioner" positionMethod="fixed" collisionPadding={8}>
          <Base.Popup
            className="menu"
            // Back where focus was (Base UI would take it to the first thing in the area it covers),
            // unless what was chosen put it somewhere else, like a dialog's first field.
            finalFocus={() => {
              const now = document.activeElement;
              if (now && now !== document.body && !now.closest('[role="menu"]')) return false;
              return before.current?.isConnected ? before.current : false;
            }}
          >
            {(target ? entriesFor(target) : []).map((entry, i) =>
              "separator" in entry ? (
                <Base.Separator key={i} className="menu-sep" />
              ) : "heading" in entry ? (
                <div key={i} className="menu-label">{entry.heading}</div>
              ) : isAction(entry) ? (
                <Base.Item key={i} className="menu-item" data-danger={entry.danger || undefined} disabled={entry.disabled} title={entry.title} onClick={() => entry.onSelect()}>
                  {entry.icon && <Icon name={entry.icon} size={16} />}
                  {entry.label}
                </Base.Item>
              ) : null,
            )}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
