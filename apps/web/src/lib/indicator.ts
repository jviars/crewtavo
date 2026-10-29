/**
 * The selection highlight in segmented controls (.segmented), filter pills (.tabs) and underline
 * tabs (.underline-tabs) slides to the new choice instead of jumping. React owns those containers'
 * children, so nothing is added to them: the highlight is the container's ::before, and this sets
 * --ind-x, --ind-y, --ind-w and --ind-h on the container from the selected child's box, plus
 * data-indicator ("still" the first time it's placed, so it doesn't fly in from the corner, then
 * "on"). Without data-indicator, as when nothing or several are selected or the container is
 * hidden, the selected child keeps its own fill (components.css).
 */
const CONTAINERS = ".segmented, .tabs, .underline-tabs";
const SELECTED = '[aria-pressed="true"], [aria-selected="true"], [aria-current="page"]';

export function startSlidingIndicators(): () => void {
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => undefined;
  const containers = new Set<HTMLElement>();
  const pending = new Set<HTMLElement>();
  const settling = new Set<HTMLElement>();
  let frame = 0;
  let settleFrame = 0;

  // A container changes size (shown, wrapped onto another row), or one of its children does (a
  // count arriving, the font loading), and the selected one may have moved.
  const resize = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      const el = target as HTMLElement;
      if (containers.has(el)) queue(el);
      else if (el.parentElement && containers.has(el.parentElement)) queue(el.parentElement);
      else resize.unobserve(el);
    }
  });

  const track = (el: HTMLElement) => {
    if (!containers.has(el)) {
      containers.add(el);
      resize.observe(el);
    }
    for (const child of el.children) resize.observe(child);
    queue(el);
  };

  const queue = (el: HTMLElement) => {
    pending.add(el);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const forget = (el: HTMLElement) => {
    containers.delete(el);
    resize.unobserve(el);
    for (const child of el.children) resize.unobserve(child);
  };

  // All the measuring first, then all the writing, so the page lays out once.
  const flush = () => {
    frame = 0;
    const boxes = Array.from(pending, (el) => [el, el.isConnected ? measure(el) : undefined] as const);
    pending.clear();
    for (const [el, box] of boxes) {
      if (!el.isConnected) {
        forget(el);
      } else if (!box) {
        el.removeAttribute("data-indicator");
      } else {
        el.style.setProperty("--ind-x", `${box.x}px`);
        el.style.setProperty("--ind-y", `${box.y}px`);
        el.style.setProperty("--ind-w", `${box.w}px`);
        el.style.setProperty("--ind-h", `${box.h}px`);
        if (!el.hasAttribute("data-indicator")) {
          el.setAttribute("data-indicator", "still");
          settling.add(el);
        }
      }
    }
    // A frame later the highlight is in place, and from then on it slides.
    if (settling.size && !settleFrame) {
      settleFrame = requestAnimationFrame(() => {
        settleFrame = 0;
        for (const el of settling) if (el.getAttribute("data-indicator") === "still") el.setAttribute("data-indicator", "on");
        settling.clear();
      });
    }
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        const parent = record.target.parentElement;
        if (parent?.matches(CONTAINERS)) track(parent);
        continue;
      }
      // A choice added to or taken from a container moves the others along.
      const target = record.target instanceof Element ? record.target.closest<HTMLElement>(CONTAINERS) : null;
      if (target) track(target);
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement) || !containers.size) continue;
        if (containers.has(node)) forget(node);
        node.querySelectorAll<HTMLElement>(CONTAINERS).forEach((el) => containers.has(el) && forget(el));
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(CONTAINERS)) track(node);
        node.querySelectorAll<HTMLElement>(CONTAINERS).forEach(track);
      }
    }
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-pressed", "aria-selected", "aria-current"] });
  document.querySelectorAll<HTMLElement>(CONTAINERS).forEach(track);
  // Figtree arriving changes every label's width.
  document.fonts?.ready.then(() => containers.forEach(queue)).catch(() => undefined);

  return () => {
    observer.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
    cancelAnimationFrame(settleFrame);
    containers.clear();
    pending.clear();
    settling.clear();
  };
}

/** The selected child's box within its container, or nothing when there's no single visible one. */
function measure(container: HTMLElement) {
  if (!container.offsetWidth) return undefined;
  const selected = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(SELECTED));
  if (selected.length !== 1) return undefined;
  const [child] = selected;
  if (!child.offsetWidth) return undefined;
  // The container is position: relative, so this is its offsetParent; the offsets leave out a
  // pressed button's scale. Should something else be in between, measure the boxes instead.
  if (child.offsetParent === container) return { x: child.offsetLeft, y: child.offsetTop, w: child.offsetWidth, h: child.offsetHeight };
  const outer = container.getBoundingClientRect();
  const inner = child.getBoundingClientRect();
  return {
    x: inner.left - outer.left - container.clientLeft + container.scrollLeft,
    y: inner.top - outer.top - container.clientTop + container.scrollTop,
    w: inner.width,
    h: inner.height,
  };
}
