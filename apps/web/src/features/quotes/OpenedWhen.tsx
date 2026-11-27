import { dateIn, formatDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";

/** "First opened Oct 16, 2026": the day it was where the business is, as its other dates are, not where this browser is. */
export const firstOpenedWords = (firstAt: string, timeZone: string) => `First opened ${formatDate(dateIn(firstAt, timeZone))}`;

/**
 * When the client last opened a quote or invoice in the Client Hub (hub_opens, never the office's
 * preview), for its page's header: "Opened 2h ago", with the first time on hover once they came back.
 */
export function OpenedWhen({ opened }: { opened: { first_at: string; last_at: string } }) {
  const session = useSession();
  const again = opened.first_at !== opened.last_at;
  return <span title={again ? firstOpenedWords(opened.first_at, session.company.timezone) : undefined}>Opened {timeAgo(opened.last_at)}</span>;
}
