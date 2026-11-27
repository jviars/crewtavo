/**
 * Working down a list without going back to it each time: a record opened from a list page (an
 * InboxRow) carries the list's rows in its history entry, and its header shows "3 of 25" with ‹ ›
 * to the one before and after, and J and K for the same on a keyboard. Stepping replaces the history
 * entry, so Back still returns to the list, where it was scrolled. Opened any other way (a link, a
 * search, a new tab), there's no list and nothing shows.
 */
import { useEffect } from "react";
import { useLocation, useNavigate, type Location } from "react-router-dom";
import { t } from "@/lib/i18n";
import { Icon } from "./Icon";

type Walk = { walk: string[] };

/**
 * The rows' pages in a list, as they're shown, for the record `link` opens. Each page once, where it
 * first comes: a list can open one record from several rows (Snow's storm log has a row for each
 * storm on a job), and counted twice › would lead back to the same page.
 */
export function listWalk(link: HTMLAnchorElement): string[] {
  const list = link.closest(".il");
  if (!list) return [];
  return [...new Set([...list.querySelectorAll<HTMLAnchorElement>("a.il-link[href]")].map((a) => a.pathname))];
}

/** Router state for opening a row: what it already carried, and the list's rows. */
export function withWalk(state: unknown, walk: string[]): unknown {
  if (walk.length < 2 || (state !== undefined && (typeof state !== "object" || state === null || Array.isArray(state)))) return state;
  return { ...(state as object | undefined), walk } satisfies Walk;
}

const walkOf = (location: Location): string[] | null => {
  const walk = (location.state as Partial<Walk> | null)?.walk;
  return Array.isArray(walk) && walk.every((p) => typeof p === "string") ? walk : null;
};

/** Where this record is in the list it came from, or null when it didn't come from one. */
export function stepsFor(walk: readonly string[] | null, pathname: string) {
  const index = walk ? walk.indexOf(pathname) : -1;
  if (!walk || index < 0 || walk.length < 2) return null;
  return { index, count: walk.length, before: walk[index - 1] ?? null, after: walk[index + 1] ?? null };
}

export function RecordSteps() {
  const location = useLocation();
  const navigate = useNavigate();
  const steps = stepsFor(walkOf(location), location.pathname);
  const go = (to: string | null) => to && navigate(to, { replace: true, state: location.state });

  useEffect(() => {
    if (!steps) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if (typing || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented || document.querySelector('dialog[open], [popover="auto"]:popover-open')) return;
      const to = e.key === "j" ? steps.after : e.key === "k" ? steps.before : null;
      if (!to) return;
      e.preventDefault();
      navigate(to, { replace: true, state: location.state });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps?.before, steps?.after, location.state, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!steps) return null;
  return (
    <span className="record-steps hide-mobile" role="group" aria-label={t("This list")}>
      <span className="record-steps-count">{t("{n} of {count}", { n: steps.index + 1, count: steps.count })}</span>
      <button type="button" className="icon-btn record-steps-btn" onClick={() => go(steps.before)} disabled={!steps.before} aria-label={t("Previous in the list")} title={t("Previous (K)")}>
        <Icon name="chevronLeft" size={16} />
      </button>
      <button type="button" className="icon-btn record-steps-btn" onClick={() => go(steps.after)} disabled={!steps.after} aria-label={t("Next in the list")} title={t("Next (J)")}>
        <Icon name="chevronRight" size={16} />
      </button>
    </span>
  );
}
