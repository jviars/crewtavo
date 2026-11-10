/**
 * A map that fills the whole screen on a phone or tablet, the way ride apps show theirs: over the top
 * bar and the tab bar, edge to edge, with its own controls kept inside the screen's safe area. Safari
 * on iPhone has no real full screen for a web page, so it's done with layout on every device alike:
 * the map's frame is fixed to the viewport (its CSS, under [data-extended]), and the page behind it
 * stops scrolling (html.map-extended). The map's own button puts it back, and so does the screen
 * growing to desktop size. MapLibre follows its container's size by itself.
 */
import { useEffect, useState } from "react";

/** Phones and tablets: a narrow screen, or a touch screen of any size. */
const EXTENDABLE = "(max-width: 900px), (pointer: coarse)";

const matches = () => typeof window !== "undefined" && window.matchMedia(EXTENDABLE).matches;

export function useExtendedMap() {
  const [available, setAvailable] = useState(matches);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(EXTENDABLE);
    const change = () => setAvailable(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const extended = on && available;
  useEffect(() => {
    if (!extended) return;
    const root = document.documentElement;
    root.classList.add("map-extended");
    return () => root.classList.remove("map-extended");
  }, [extended]);
  return { available, extended, setExtended: setOn };
}
