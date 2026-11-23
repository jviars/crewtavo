import { CHANNEL_LABELS } from "@crewtavo/core/analytics";
import { Fact } from "@/components/ui/Section";
import type { WebVisit } from "./website";

/** Where the visit came from, in words: "Google (search), campaign spring". */
const cameFrom = (visit: WebVisit) =>
  `${visit.source}${visit.channel !== "direct" && CHANNEL_LABELS[visit.channel] ? ` (${CHANNEL_LABELS[visit.channel].toLowerCase()})` : ""}${visit.campaign ? `, campaign ${visit.campaign}` : ""}`;
/** The page it started on, and the one they did it from when that's another. */
const firstPage = (visit: WebVisit, did: string) => `${visit.landing_page}${visit.page !== visit.landing_page ? `, then ${did} from ${visit.page}` : ""}`;

/** The website visit that brought in a booking-form request or an application (Website Analytics), as rows of a .kv list. */
export function WebVisitRows({ visit, did = "booked" }: { visit: WebVisit; /** What they did on the last page: booked, applied. */ did?: string }) {
  return (
    <>
      <dt>Came from</dt>
      <dd>{cameFrom(visit)}</dd>
      <dt>First page</dt>
      <dd style={{ overflowWrap: "anywhere" }}>{firstPage(visit, did)}</dd>
    </>
  );
}

/** The same two rows as Fact rows, for a page that shows its facts with Section's Facts (hairline rows). */
export function WebVisitFacts({ visit, did = "booked" }: { visit: WebVisit; did?: string }) {
  return (
    <>
      <Fact label="Came from">{cameFrom(visit)}</Fact>
      <Fact label="First page" wide>{firstPage(visit, did)}</Fact>
    </>
  );
}
