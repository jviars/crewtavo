/**
 * Whether an app is installed, like an app store: turned on, signed in to, a key, a calendar or a
 * website's address added, or (Claude and ChatGPT) connected. Installed apps get a check on the Apps grid, and their
 * pages show the setup and an Uninstall button instead of the listing's Install.
 */
import { useAssistantConnections } from "./AssistantAccess";
import { assistantAppFor } from "./assistantConnections";
import type { AppRow } from "./catalog";

/** `assistants`: the apps the person looking has connected an assistant from ("chatgpt", "anthropic"). */
export function isInstalled(app: AppRow, assistants: ReadonlySet<string>): boolean {
  if (app.auth === "builtin" || app.auth === "site") return app.status === "connected";
  // Calendars added by link, Google's by secret address too; Stripe, also when the server set it up.
  if (app.calendars || app.stripe || assistants.has(app.id)) return true;
  if (app.auth === "link" || app.auth === "connector") return false;
  // Signed in or a key added, including one that needs reconnecting. Claude's key counts.
  return app.status !== "disconnected";
}

/** isInstalled, with the assistants the signed-in person has connected. AI assistants are each person's own. */
export function useIsInstalled() {
  const connections = useAssistantConnections();
  const assistants = new Set((connections.data ?? []).map((c) => assistantAppFor(c.name)).filter((id): id is NonNullable<typeof id> => id !== null));
  return { isInstalled: (app: AppRow) => isInstalled(app, assistants), connections: connections.data ?? [] };
}
