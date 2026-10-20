/** "On this page" for a guide: its headings as links, with the one being read marked. */
import { useEffect, useState } from "react";
import type { Section } from "@/lib/html";
import { toast } from "@/lib/toast";

/** Scrolls to a section and puts it in the address (keeping React Router's history state), optionally copying the link. */
export function goToSection(id: string, copy = false) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  history.replaceState(history.state, "", `#${id}`);
  if (copy) navigator.clipboard?.writeText(location.href).then(() => toast.success("Link to this section copied"), () => {});
}

/** The section at the top of the screen: the last heading scrolled up to just under the top bar (the last one at the very bottom). */
export function useCurrentSection(sections: Section[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (!sections.length) return;
    const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-height")) || 60) + 28;
    let frame = 0;
    const update = () => {
      frame = 0;
      let at: string | null = null;
      for (const s of sections) if ((document.getElementById(s.id)?.getBoundingClientRect().top ?? Infinity) <= line) at = s.id;
      const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      setCurrent(atBottom ? sections[sections.length - 1].id : at);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [sections]);
  return current;
}

export function GuideContents({ sections, current, onPick }: { sections: Section[]; current: string | null; onPick?: () => void }) {
  return (
    <ol className="toc-list">
      {sections.map((s) => (
        <li key={s.id} data-level={s.level}>
          <a
            href={`#${s.id}`}
            aria-current={current === s.id ? "location" : undefined}
            onClick={(e) => {
              e.preventDefault();
              onPick?.();
              goToSection(s.id);
            }}
          >
            {s.title}
          </a>
        </li>
      ))}
    </ol>
  );
}
