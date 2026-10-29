import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useEffect, useState } from "react";

/**
 * Animates a list's rows as they're added, removed or reordered (AutoAnimate): put the ref on the
 * element whose direct children are the rows. Short and ease-out like the rest of the app, and off
 * when the person prefers less motion.
 */
export function useListAnimation<T extends HTMLElement>() {
  const [ref] = useAutoAnimate<T>({ duration: 200, easing: "ease-out" });
  return ref;
}

/**
 * Sent right after something opens in the browser's top layer (a modal dialog, the command
 * palette). Popovers that have to stay above it, like toasts, listen and raise themselves again
 * (components/ui/topLayer.ts).
 */
export function announceTopLayer() {
  window.dispatchEvent(new Event("crewtavo:toplayer"));
}

/**
 * Calls done once the element's exit transition has ended, or after `fallback` milliseconds when it
 * never reports one (an older browser, or it was already hidden). Returns a cancel, for when it
 * opens again before then.
 */
export function afterExit(el: Element, done: () => void, fallback = 250): () => void {
  const finish = (e?: Event) => {
    if (e && e.target !== el) return;
    cancel();
    done();
  };
  const timer = window.setTimeout(finish, fallback);
  const cancel = () => {
    window.clearTimeout(timer);
    el.removeEventListener("transitionend", finish);
  };
  el.addEventListener("transitionend", finish);
  return cancel;
}

/**
 * Whether something React shows and hides should be in the page: true while it's open and for `ms`
 * after it closes, so its exit animation can play first. Mark it leaving while it's on its way out:
 *   const shown = usePresence(open);
 *   {shown && <div className="sheet" data-leaving={!open || undefined} />}
 */
export function usePresence(open: boolean, ms = 200): boolean {
  const [present, setPresent] = useState(open);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), ms);
    return () => window.clearTimeout(timer);
  }, [open, ms]);
  return open || present;
}
