/**
 * The app's tooltips: every `title` shown as a small dark chip, sooner than the browser's own and
 * in the app's type, without touching the hundreds of places that set one. One layer for the whole
 * app (App.tsx) follows the pointer and keyboard focus, and shows Base UI's Tooltip (MIT) against
 * whatever has a title.
 *
 * - It shows half a second after the pointer rests on something with a title, or keyboard focus
 *   lands on it; at once if another has just been showing, so a row of icons reads quickly.
 * - It goes on leaving, a press, a scroll, Escape, or focus moving on. It can be hovered itself
 *   (WCAG 1.4.13), so there's a moment to reach it.
 * - Not on touch, as before: there's nothing to hover, and a held finger has other uses.
 * - Not where the title only says the words already shown, unless they're cut off.
 * - Inside data-tip="right" (the closed sidebar, whose links show only their icons) a title always
 *   shows, and beside its element rather than above, so it doesn't cover the link above.
 *
 * While the pointer is on an element its title is lifted (titles.ts), or the browser would show its
 * tooltip too. Keyboard focus leaves it alone: browsers never show theirs for focus, so assistive
 * technology reads exactly what it did. Titles on SVG drawings are theirs and left be.
 */
import { Tooltip } from "@base-ui/react/tooltip";
import { useEffect, useRef, useState } from "react";
import { layerFor } from "./layer";
import { liftTitle, restoreTitle, tipAdds, titleText, type LiftedTitle } from "./titles";
import styles from "./Tooltips.module.css";

/** Before one shows. */
const DELAY = 500;
/** After one goes, the next shows at once for this long. */
const WARM = 400;
/** Leaving its element, the time to reach the tooltip itself. */
const GRACE = 100;
const TOOLTIP_ID = "app-tooltip";

type Tip = { anchor: HTMLElement; text: string };

/** The element whose title applies where the pointer or focus is, as the browser finds it. */
function titled(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest("[title]") : null;
  if (!(el instanceof HTMLElement) || el.tagName === "IFRAME") return null;
  return titleText(el) ? el : null;
}

/** Whether its words don't all fit (an ellipsis or a clamp). */
const cutOff = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
/** Inside data-tip="right": its words aren't on screen, so its title shows, to the right. */
const beside = (el: HTMLElement) => el.closest('[data-tip="right"]') !== null;

export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [open, setOpen] = useState(false);
  const hideNow = useRef(() => {});

  useEffect(() => {
    let hovered: { el: HTMLElement; lifted: LiftedTitle | null } | null = null;
    let focused: HTMLElement | null = null;
    let showing: HTMLElement | null = null;
    let showTimer = 0;
    let hideTimer = 0;
    let hiddenAt = 0;

    const hide = () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
      hideTimer = 0;
      if (!showing) return;
      showing = null;
      hiddenAt = Date.now();
      setOpen(false);
    };
    hideNow.current = hide;
    const show = (el: HTMLElement, text: string) => {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
      showing = el;
      setTip({ anchor: el, text });
      setOpen(true);
    };
    const showSoon = (el: HTMLElement) => {
      const text = titleText(el);
      if (!tipAdds(el, text, cutOff(el) || beside(el))) return hide();
      window.clearTimeout(showTimer);
      if (showing || Date.now() - hiddenAt < WARM) return show(el, text);
      // Still what the pointer is on, or what has focus, when the time comes (a scroll may have moved it away).
      showTimer = window.setTimeout(() => {
        if (el === focused || (el === hovered?.el && el.matches(":hover"))) show(el, text);
      }, DELAY);
    };
    const unhover = () => {
      if (hovered?.lifted) restoreTitle(hovered.el, hovered.lifted, TOOLTIP_ID);
      hovered = null;
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(`#${TOOLTIP_ID}`)) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
        return;
      }
      const el = titled(target);
      if (el && el === hovered?.el) return;
      unhover();
      if (!el) {
        window.clearTimeout(showTimer);
        if (showing && !hideTimer) hideTimer = window.setTimeout(hide, GRACE);
        return;
      }
      hovered = { el, lifted: liftTitle(el, TOOLTIP_ID) };
      showSoon(el);
    };
    const onOut = (e: PointerEvent) => {
      // Off the window altogether.
      if (e.relatedTarget) return;
      unhover();
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.matches(":focus-visible")) return;
      focused = titled(target);
      if (focused) showSoon(focused);
    };
    const onFocusOut = () => {
      if (focused && showing === focused) hide();
      focused = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    // A press hides it, but the title stays lifted until the pointer leaves, or the browser's own
    // would come up while it rests there.
    const onPress = () => hide();
    // A scroll hides one that's showing; one about to show still does if its element stayed put.
    const onScroll = () => {
      if (!showing) return;
      hide();
    };
    const onLeaveWindow = () => {
      unhover();
      hide();
    };

    const capture = { capture: true, passive: true };
    document.addEventListener("pointerover", onOver, capture);
    document.addEventListener("pointerout", onOut, capture);
    document.addEventListener("pointerdown", onPress, capture);
    document.addEventListener("focusin", onFocusIn, capture);
    document.addEventListener("focusout", onFocusOut, capture);
    document.addEventListener("keydown", onKey, capture);
    document.addEventListener("scroll", onScroll, capture);
    window.addEventListener("blur", onLeaveWindow);
    return () => {
      document.removeEventListener("pointerover", onOver, capture);
      document.removeEventListener("pointerout", onOut, capture);
      document.removeEventListener("pointerdown", onPress, capture);
      document.removeEventListener("focusin", onFocusIn, capture);
      document.removeEventListener("focusout", onFocusOut, capture);
      document.removeEventListener("keydown", onKey, capture);
      document.removeEventListener("scroll", onScroll, capture);
      window.removeEventListener("blur", onLeaveWindow);
      unhover();
      hide();
    };
  }, []);

  return (
    <Tooltip.Root
      open={open && tip !== null}
      onOpenChange={(next, details) => {
        if (next) return;
        // Hidden here, and whatever else Escape or the press was for still happens (closing the
        // dialog it's in, say), as if no tooltip had been showing.
        details.cancel();
        details.allowPropagation();
        hideNow.current();
      }}
    >
      <Tooltip.Portal container={layerFor(tip?.anchor) ?? undefined}>
        <Tooltip.Positioner className={styles.positioner} anchor={tip?.anchor} side={tip && beside(tip.anchor) ? "right" : "top"} sideOffset={6} collisionPadding={8} positionMethod="fixed">
          <Tooltip.Popup id={TOOLTIP_ID} role="tooltip" className={styles.tip}>
            {tip?.text}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
