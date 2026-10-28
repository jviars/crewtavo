import { CHANNEL_LABELS } from "@crewtavo/core/analytics";
import type { WebVisit } from "./website";

/** The website visit that brought in a booking-form request or an application (Website Analytics), as rows of a .kv list. */
export function WebVisitRows({ visit, did = "booked" }: { visit: WebVisit; /** What they did on the last page: booked, applied. */ did?: string }) {
  return (
    <>
      <dt>Came from</dt>
      <dd>{visit.source}{visit.channel !== "direct" && CHANNEL_LABELS[visit.channel] ? ` (${CHANNEL_LABELS[visit.channel].toLowerCase()})` : ""}{visit.campaign ? `, campaign ${visit.campaign}` : ""}</dd>
      <dt>First page</dt>
      <dd style={{ overflowWrap: "anywhere" }}>{visit.landing_page}{visit.page !== visit.landing_page ? `, then ${did} from ${visit.page}` : ""}</dd>
    </>
  );
}
