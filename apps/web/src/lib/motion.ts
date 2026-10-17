import { useAutoAnimate } from "@formkit/auto-animate/react";

/**
 * Animates a list's rows as they're added, removed or reordered (AutoAnimate): put the ref on the
 * element whose direct children are the rows. Short and ease-out like the rest of the app, and off
 * when the person prefers less motion.
 */
export function useListAnimation<T extends HTMLElement>() {
  const [ref] = useAutoAnimate<T>({ duration: 200, easing: "ease-out" });
  return ref;
}
