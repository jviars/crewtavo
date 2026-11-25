import { formatDate, timeAgo } from "@/lib/format";

/**
 * When the client last opened a quote or invoice in the Client Hub (hub_opens, never the office's
 * preview), for its page's header: "Opened 2h ago", with the first time on hover once they came back.
 */
export function OpenedWhen({ opened }: { opened: { first_at: string; last_at: string } }) {
  const again = opened.first_at !== opened.last_at;
  return <span title={again ? `First opened ${formatDate(opened.first_at)}` : undefined}>Opened {timeAgo(opened.last_at)}</span>;
}
