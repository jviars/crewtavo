/**
 * The range step: whether the homeowner has their price range yet, and what's next. Not sent: send
 * it (the card beside the estimate), or mark the yes they gave when the office told them on the phone. Out: when, for how much, send it again or copy their link, or
 * mark a yes they gave on the phone or in person. A yes: book the visit (the site visit step under it starts it on the iPad). After that, what happened, in a line.
 */
import { rangeSettings } from "@crewtavo/core/estimates";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { firstName, type EstimateQuote } from "../estimate";
import { ACROSS_OPTIONS, capital, dayText, hasRange, homeownerName, rangeAcrossOptions, rangeNow, rangeOutdated, rangeState, rangeWords, rangeWordsFor } from "./model";
import { SaidYesButton, type SendChannel, type SendMode } from "./RangeCard";
import styles from "./flow.module.css";

/** Takes the person to the range card beside the estimate, and onto its send button (a jump, with less motion). */
function goToRangeCard() {
  const card = document.getElementById("range-card");
  if (!card) return;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  card.querySelector<HTMLButtonElement>("button.btn-primary:not(:disabled)")?.focus({ preventScroll: true });
}

export function RangeStep({ quote, salesperson, canSell, refresh, onSend }: {
  quote: EstimateQuote;
  salesperson: string | null;
  canSell: boolean;
  refresh: () => void;
  onSend: (mode: SendMode, startWith?: SendChannel) => void;
}) {
  const { company } = useSession();
  const tz = company.timezone;
  const settings = rangeSettings(company.settings);
  const who = homeownerName(quote.client?.display_name);
  const Who = capital(who);
  const rep = firstName(salesperson);
  const state = rangeState(quote);
  // The same range, a fresh link to paste anywhere (making one doesn't change what they see).
  const copyLink = useMutation({
    mutationFn: () => api.post<{ link: string }>(`/roofing/${quote.id}/send-range`, { channel: "link" }),
    onSuccess: (r) => {
      void copyText(r.link, `Link copied. Paste it into a message to ${who}.`);
      refresh();
    },
  });

  if (!quote.lines.length) return <p className={styles.note}>Price the estimate first; the range comes from it.</p>;
  // With options, the range runs from the lowest option to the highest, and says so.
  const across = rangeAcrossOptions(quote);
  const sent = hasRange(quote) ? `${quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, tz)}: ` : ""}${rangeWordsFor({ low: quote.range_low, high: quote.range_high }, quote)}.` : null;
  const yes = quote.range_accepted_at ? `${Who} said yes ${dayText(quote.range_accepted_at, tz)}.` : null;

  if (state === "unsent") {
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepLead}>Send {who} a price range before anyone goes out, so nobody drives out to a roof that's out of their budget. When they say yes, you book the visit.</p>
        {canSell && (
          <div className={styles.actions}>
            {/* The green Send is on the range card itself; this takes them there. */}
            <Button icon="send" onClick={goToRangeCard}>Send the range</Button>
            <SaidYesButton quote={quote} />
          </div>
        )}
      </div>
    );
  }

  if (state === "waiting" && hasRange(quote)) {
    const outdated = rangeOutdated(quote, settings);
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepLead}>
          Sent to {Who}{quote.range_sent_at ? ` on ${dayText(quote.range_sent_at, tz)}` : ""}: <strong>{rangeWords({ low: quote.range_low, high: quote.range_high })}</strong>
          {across && `, ${ACROSS_OPTIONS}`}. Waiting for their answer.
        </p>
        {outdated && (
          <div className="callout callout-warning" role="note">
            <Icon name="alert" size={16} />
            <div className="grow">
              <div>The estimate changed since you sent it.</div>
              Send it again and {who} sees {rangeWordsFor(rangeNow(quote, settings), quote)}.
            </div>
          </div>
        )}
        {canSell && (
          <div className={styles.actions}>
            <Button icon="send" onClick={() => onSend("range")}>{outdated ? "Send the new range" : "Resend"}</Button>
            {/* A new link would carry the new range: that goes through the dialog, where it's shown. */}
            <Button icon="copy" loading={copyLink.isPending} onClick={() => (outdated ? onSend("range", "link") : copyLink.mutate())}>Copy link</Button>
            <SaidYesButton quote={quote} />
          </div>
        )}
        <p className={styles.note}>When {who} says yes, you get a note to book {rep || "the visit"}.</p>
      </div>
    );
  }

  // Their yes; starting the visit (or sending the exact price instead) is the site visit step's, just under it.
  if (state === "accepted") {
    return (
      <div className="callout callout-good" role="status">
        <Icon name="check" size={16} />
        <div className="grow">
          <div>{Who} said yes{quote.range_accepted_at ? ` on ${dayText(quote.range_accepted_at, tz)}` : ""}.</div>
          Book {rep ? `${rep}'s` : "the site"} visit.
        </div>
      </div>
    );
  }

  if (state === "closed") return <p className={styles.note}>{sent ? `${sent} ${yes ?? ""}` : `This estimate was marked ${quote.status === "lost" ? "lost" : "archived"}.`}</p>;

  // The exact price is out, or it's signed: what happened with the range, if there was one.
  if (!hasRange(quote)) {
    return (
      <p className={styles.note}>
        {quote.priced_on_site_at ? "Priced on site, so no range went out." : state === "exact" ? `You sent ${who} the exact price instead, so no range went out.` : "No range went out for this one."}
      </p>
    );
  }
  return (
    <p className={styles.stepLead}>
      {sent}{" "}
      {quote.priced_on_site_at
        ? `${yes ? `${yes} ` : ""}Priced on site ${dayText(quote.priced_on_site_at, tz)}.`
        : quote.exact_sent_at
          ? `${yes ? `${yes} ` : ""}On ${dayText(quote.exact_sent_at, tz)}, you sent ${who} the exact price instead.`
          : (yes ?? "")}
    </p>
  );
}
