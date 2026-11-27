/**
 * Whether the sidebar is closed to its icons. Open until someone closes it, and remembered on this
 * device rather than for the person, since a laptop and a big screen want different things. On its
 * own here, with nothing imported, so the outline shown while the session loads (ShellSkeleton) can
 * read it too.
 */
const SIDEBAR_KEY = "crewtavo.sidebar-closed";
export function sidebarClosed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}
/** Opens a closed sidebar or closes an open one, and remembers it (a state updater for AppShell). */
export function flipSidebar(closed: boolean): boolean {
  try {
    if (closed) localStorage.removeItem(SIDEBAR_KEY);
    else localStorage.setItem(SIDEBAR_KEY, "1");
  } catch {
    // Private mode: it just won't be remembered.
  }
  return !closed;
}

/**
 * Measure is a map tool: there the sidebar is always its icons (features.css, wherever the page is
 * .measure-page), whatever was chosen. So on it nothing opens or closes the sidebar, and each icon
 * says its name as it does closed.
 */
export const iconsOnly = (pathname: string) => /^\/measure\/?$/.test(pathname);
