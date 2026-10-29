/**
 * What floats above everything, open dialogs included: the offline pill, the restart banner and the
 * background task island. Each is a popover="manual" in the browser's top layer, raised again when
 * something newer goes up there (Dialog and the command palette dispatch TOP_LAYER_EVENT as they
 * open), so a dialog's backdrop never covers it. Browsers without popovers show it as a plain fixed
 * element ([data-fallback]).
 */
import { useLayoutEffect, type RefObject } from "react";

export const TOP_LAYER_EVENT = "crewtavo:toplayer";
export const supportsPopover = typeof HTMLElement !== "undefined" && "showPopover" in HTMLElement.prototype;

/** The attributes that put an element in the top layer, or mark it as the fallback. */
export const topLayerProps = supportsPopover ? ({ popover: "manual" } as const) : ({ "data-fallback": "" } as const);

/** Shows the element in the top layer while `shown`, and keeps it above anything opened since. */
export function useTopLayer(ref: RefObject<HTMLElement>, shown: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !supportsPopover) return;
    const hide = () => {
      try {
        if (el.matches(":popover-open")) el.hidePopover();
      } catch {
        // Already out of the document.
      }
    };
    if (!shown) return hide();
    const raise = () => {
      hide();
      try {
        el.showPopover();
      } catch {
        // Out of the document: nothing to raise.
      }
    };
    raise();
    window.addEventListener(TOP_LAYER_EVENT, raise);
    return () => window.removeEventListener(TOP_LAYER_EVENT, raise);
  }, [ref, shown]);
}

/**
 * While `shown`, sets a custom property on the page (`--island-space`, say) to the element's height
 * plus `gap`, so what shares its edge of the window can make room for it. Removed once it's gone.
 */
export function useSpace(ref: RefObject<HTMLElement>, property: string, shown: boolean, gap = 12) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const root = document.documentElement;
    // offsetHeight, not the box on screen: an entrance that scales it shouldn't shrink the room.
    const measure = () => root.style.setProperty(property, `${el.offsetHeight + gap}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(property);
    };
  }, [ref, property, shown, gap]);
}

export const prefersLessMotion = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

const MOTION = {
  enter: { duration: 300, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  exit: { duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
  slide: { duration: 380, easing: "cubic-bezier(0.3, 1.25, 0.5, 1)" },
};

/** A motion token pair from tokens.css (--dur-enter with --ease-enter, and so on), for the Web Animations API. */
export function motion(kind: keyof typeof MOTION): { duration: number; easing: string } {
  const fallback = MOTION[kind];
  if (typeof document === "undefined") return fallback;
  const style = getComputedStyle(document.documentElement);
  return { duration: parseFloat(style.getPropertyValue(`--dur-${kind}`)) || fallback.duration, easing: style.getPropertyValue(`--ease-${kind}`).trim() || fallback.easing };
}

const playing = new WeakMap<Element, Animation>();

/**
 * Plays an entrance or an exit once, in place of the last one played on the element. Web Animations
 * rather than CSS, so raising the element again (above) doesn't replay it. With less motion only the
 * opacity changes. Resolves when it's over (at once where the browser can't animate), false when a
 * newer one took its place.
 */
export function play(el: HTMLElement | null, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<boolean> {
  if (!el || typeof el.animate !== "function") return Promise.resolve(true);
  playing.get(el)?.cancel();
  const frames = prefersLessMotion() ? keyframes.map((k) => ({ offset: k.offset, opacity: k.opacity ?? 1 })) : keyframes;
  const animation = el.animate(frames, options);
  playing.set(el, animation);
  return animation.finished.then(
    () => true,
    () => false,
  );
}
