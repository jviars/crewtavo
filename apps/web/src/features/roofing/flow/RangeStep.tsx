/**
 * The range step: whether the homeowner has their price range yet, and what's next. Not sent: send
 * it (the card beside the estimate). Out: when, for how much, send it again or copy their link, or
 * mark a yes they gave on the phone or in person. A yes: book the visit and start it on the iPad. After that, what happened, in a line.
 */
import { rangeSettings } from "@crewtavo/core/estimates";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session";
import { firstName, type EstimateQuote } from "../estimate";
import { capital, dayText, hasRange, homeownerName, rangeNow, rangeOutdated, rangeState, rangeWords } from "./model";
import { SaidYesButton, type SendChannel, type SendMode } from "./RangeCard";
import styles from "./flow.module.css";

/** Takes the person to the range card beside the estimate, and onto its send button. */
function goToRangeCard() {
  const card = document.getElementById("range-card");
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const navigate = useNavigate();
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

  if (!quote.lines.length) return <span className="muted small">Price the estimate first; the range comes from it.</span>;
  const sent = hasRange(quote) ? `${quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, tz)}: ` : ""}${rangeWords({ low: quote.range_low, high: quote.range_high })}.` : null;
  const yes = quote.range_accepted_at ? `${Who} said yes ${dayText(quote.range_accepted_at, tz)}.` : null;

  if (state === "unsent") {
    return (
      <div className={styles.stepBody}>
        <p className={styles.stepLead}>Send {who} a price range before anyone goes out, so nobody drives out to a roof that's out of their budget. When they say yes, you book the visit.</p>
        {canSell && (
          <div className={styles.actions}>
            <Button variant="primary" icon="send" onClick={goToRangeCard}>Send the range</Button>
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
          Sent to {Who}{quote.range_sent_at ? ` on ${dayText(quote.range_sent_at, tz)}` : ""}: <strong>{rangeWords({ low: quote.range_low, high: quote.range_high })}</strong>. Waiting for their answer.
        </p>
        {outdated && (
          <p className={styles.changedNote}>
            <Icon name="alert" size={16} />
            <span>The estimate changed since you sent it. Send it again and {who} sees {rangeWords(rangeNow(quote, settings))}.</span>
          </p>
        )}
        {canSell && (
          <div className={styles.actions}>
            <Button icon="send" variant={outdated ? "primary" : undefined} onClick={() => onSend("range")}>{outdated ? "Send the new range" : "Resend"}</Button>
            {/* A new link would carry the new range: that goes through the dialog, where it's shown. */}
            <Button icon="copy" loading={copyLink.isPending} onClick={() => (outdated ? onSend("range", "link") : copyLink.mutate())}>Copy link</Button>
            <SaidYesButton quote={quote} />
          </div>
        )}
        <p className={`muted small ${styles.note}`}>When {who} says yes, you get a note to book {rep || "the visit"}.</p>
      </div>
    );
  }

  if (state === "accepted") {
    return (
      <div className={styles.stepBody}>
        <div className={styles.yes} role="status">
          <span className={styles.yesIcon} aria-hidden="true"><Icon name="check" size={17} strokeWidth={3} /></span>
          <p>
            <strong>{Who} said yes{quote.range_accepted_at ? ` on ${dayText(quote.range_accepted_at, tz)}` : ""}.</strong> Book {rep ? `${rep}'s` : "the site"} visit.
          </p>
        </div>
        {canSell && (
          <div className={styles.actions}>
            <Button icon="tablet" onClick={() => navigate(`/roofing/${quote.id}/visit`)}>Start the site visit</Button>
            <button type="button" className={styles.linkBtn} onClick={() => onSend("exact")}>Send the exact price instead</button>
          </div>
        )}
      </div>
    );
  }

  if (state === "closed") return <span className="muted small">{sent ? `${sent} ${yes ?? ""}` : `This estimate was marked ${quote.status === "lost" ? "lost" : "archived"}.`}</span>;

  // The exact price is out, or it's signed: what happened with the range, if there was one.
  if (!hasRange(quote)) {
    return (
      <span className="muted small">
        {quote.priced_on_site_at ? "Priced on site, so no range went out." : state === "exact" ? `You sent ${who} the exact price instead, so no range went out.` : "No range went out for this one."}
      </span>
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
