/**
 * Beside the estimate: the price range the homeowner will see (the estimate rounded down, to the
 * estimate plus the room on top, rounded up), who goes out on the site visit, and sending it. Once
 * it's out it says when, and whether the estimate changed since, and the office can mark a yes the
 * homeowner gave on the phone; once they say yes, it's time to book the visit; once they have an
 * exact price, it shows that.
 */
import { rangeSettings } from "@crewtavo/core/estimates";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { useSession } from "@/lib/session";
import { firstName, money, type EstimateQuote } from "../estimate";
import { blankTab, useMarkRangeAgreed, useOpenPreview, useSetSalesperson, useTeam } from "./data";
import { canMarkAgreed, capital, dayText, estimateShare, hasRange, homeownerName, rangeNow, rangeOutdated, rangePill, rangeState, rangeWords, salesPeople } from "./model";
import styles from "./flow.module.css";

export type SendMode = "range" | "exact";
export type SendChannel = "email" | "sms" | "link";

/**
 * For a yes the homeowner gave another way (on the phone, by text, in person): the office marks the
 * range as agreed, and it's the same as their Yes on the link. The team is told to book the visit,
 * and a note on the estimate says who marked it. Only while the range is waiting for an answer.
 */
export function SaidYesButton({ quote }: { quote: EstimateQuote }) {
  const [open, setOpen] = useState(false);
  if (!canMarkAgreed(quote)) return null;
  return (
    <>
      <Button variant="ghost" icon="check" onClick={() => setOpen(true)}>
        {capital(homeownerName(quote.client?.display_name))} said yes another way
      </Button>
      {open && <SaidYesDialog quote={quote} onClose={() => setOpen(false)} />}
    </>
  );
}

function SaidYesDialog({ quote, onClose }: { quote: EstimateQuote; onClose: () => void }) {
  const { company } = useSession();
  const who = homeownerName(quote.client?.display_name);
  const [note, setNote] = useState("");
  const mark = useMarkRangeAgreed(quote.id, capital(who));
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title={`Did ${who} say yes to the range?`}
      description="Use this when they told you on the phone, by text or in person. We'll tell the team to book the visit, the same as if they'd tapped Yes."
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          mark.mutate(note, { onSuccess: onClose });
        }}
      >
        {hasRange(quote) && (
          <p className={styles.agreedRange}>
            {quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, company.timezone)}: ` : "The range: "}
            <strong>{rangeWords({ low: quote.range_low, high: quote.range_high })}</strong>
          </p>
        )}
        <Field label="How they said yes" optional>
          <textarea className={`textarea ${styles.agreedNote}`} value={note} maxLength={500} placeholder="Like “Called the office Tuesday”" onChange={(e) => setNote(e.target.value)} />
        </Field>
        <FormError error={mark.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={mark.isPending}>Yes, they agreed</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Who goes out on the site visit: anyone on the team who prices work. */
export function SalespersonSelect({ quoteId, value, disabled, label = "Site visit by" }: { quoteId: string; value: string | null; disabled?: boolean; label?: string }) {
  const { userId } = useSession();
  const id = useId();
  const team = useTeam();
  const set = useSetSalesperson(quoteId);
  const people = salesPeople(team.data ?? [], value);
  return (
    <div className={styles.fieldLabel}>
      <label htmlFor={id}>{label}</label>
      <select id={id} className={`select ${styles.select}`} value={value ?? ""} disabled={disabled || set.isPending || team.isPending} onChange={(e) => set.mutate(e.target.value || null)}>
        <option value="">{team.isPending ? "Loading your team…" : "Pick who goes out"}</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.id === userId ? " (you)" : ""}
            {!p.active ? " (no longer on the team)" : ""}
          </option>
        ))}
      </select>
      {team.error && <span className="field-error" role="alert">Couldn't load your team. <button type="button" className="link-btn" onClick={() => team.refetch()}>Try again</button></span>}
    </div>
  );
}

export function RangeCard({ quote, salesperson, canSell, busy, onSend }: {
  quote: EstimateQuote;
  /** The salesperson's name, once someone's picked. */
  salesperson: string | null;
  canSell: boolean;
  /** Edits still saving: the range would go out at the old total. */
  busy: boolean;
  onSend: (mode: SendMode, startWith?: SendChannel) => void;
}) {
  const { company } = useSession();
  const titleId = useId();
  const preview = useOpenPreview(quote.id);
  const settings = rangeSettings(company.settings);
  const state = rangeState(quote);
  const who = homeownerName(quote.client?.display_name);
  const Who = capital(who);
  const rep = firstName(salesperson);
  const priced = quote.lines.length > 0 && quote.total > 0;
  const now = rangeNow(quote, settings);
  const tz = company.timezone;
  if (state === "signed" || state === "closed") return null;

  const sees = (
    <Button icon="eye" loading={preview.isPending} disabled={!priced} onClick={() => preview.mutate(blankTab())}>
      See what {Who} sees
    </Button>
  );
  const sitePrice = (
    <div className="callout callout-info">
      <Icon name="info" size={18} />
      <span className="grow" style={{ fontWeight: 400 }}>{rep ? `${rep} sets` : "Whoever goes out sets"} the exact price on site, after checking this list on the roof.</span>
    </div>
  );
  const assign = <SalespersonSelect quoteId={quote.id} value={quote.salesperson_id} disabled={!canSell} />;
  const exactInstead = canSell && (
    <button type="button" className={`${styles.linkBtn} ${styles.quiet}`} disabled={!priced || busy} onClick={() => onSend("exact")}>
      Send the exact price instead
    </button>
  );

  if (state === "accepted" && hasRange(quote)) {
    return (
      <section id="range-card" className={styles.rangeCard} data-state="accepted" aria-labelledby={titleId}>
        <div>
          <p className={styles.eyebrow} id={titleId}>{Who} said yes</p>
          <p className={styles.rangeBig}>{money(quote.range_low)} <span className={styles.rangeTo}>to</span> {money(quote.range_high)}</p>
          <p className={styles.when}>On {dayText(quote.range_accepted_at!, tz)}. Book {rep ? `${rep}'s` : "the"} visit.</p>
        </div>
        {sitePrice}
        {assign}
        {canSell && <div className={styles.cardActions}>{sees}</div>}
        {exactInstead}
      </section>
    );
  }

  if (state === "exact") {
    const pill = hasRange(quote) ? rangePill(quote.total, { low: quote.range_low, high: quote.range_high }) : null;
    return (
      <section id="range-card" className={styles.rangeCard} data-state="exact" aria-labelledby={titleId}>
        <div>
          <p className={styles.eyebrow} id={titleId}>{quote.priced_on_site_at ? "Priced on site" : `The price ${who} has`}</p>
          <p className={styles.rangeBig}>{money(quote.total)}</p>
          <p className={styles.when}>
            {quote.priced_on_site_at
              ? `Set ${dayText(quote.priced_on_site_at, tz)}, not signed yet.`
              : quote.exact_sent_at
                ? `Sent ${dayText(quote.exact_sent_at, tz)} instead of the range, to sign online.`
                : "Sent to sign online."}
          </p>
        </div>
        {pill && hasRange(quote) && (
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="muted small">The range was {rangeWords({ low: quote.range_low, high: quote.range_high })}</span>
            <StatusPill label={pill.label} tone={pill.tone} />
          </div>
        )}
        {assign}
        {canSell && <div className={styles.cardActions}>{sees}</div>}
      </section>
    );
  }

  if (state === "waiting" && hasRange(quote)) {
    const outdated = rangeOutdated(quote, settings);
    return (
      <section id="range-card" className={styles.rangeCard} data-state="waiting" aria-labelledby={titleId}>
        <div>
          <p className={styles.eyebrow} id={titleId}>The range {who} was sent</p>
          <p className={styles.rangeBig}>{money(quote.range_low)} <span className={styles.rangeTo}>to</span> {money(quote.range_high)}</p>
          <p className={styles.when}>{quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, tz)}. ` : ""}Waiting for their answer.</p>
        </div>
        {outdated && priced && (
          <p className={styles.changedNote}>
            <Icon name="alert" size={16} />
            <span>The estimate changed since. Send it again and {who} sees {rangeWords(now)}.</span>
          </p>
        )}
        {sitePrice}
        {assign}
        {canSell && (
          <div className={styles.cardActions}>
            <Button variant={outdated ? "primary" : undefined} icon="send" disabled={!priced || busy} onClick={() => onSend("range")}>
              {outdated ? "Send the new range" : "Send it again"}
            </Button>
            {sees}
            <SaidYesButton quote={quote} />
          </div>
        )}
        {exactInstead}
      </section>
    );
  }

  // Not sent yet.
  const share = estimateShare(quote.total, now.high);
  return (
    <section id="range-card" className={styles.rangeCard} data-state="unsent" aria-labelledby={titleId}>
      <div>
        <p className={styles.eyebrow} id={titleId}>The range {who} will see</p>
        {priced ? (
          <p className={styles.rangeBig}>{money(now.low)} <span className={styles.rangeTo}>to</span> {money(now.high)}</p>
        ) : (
          <p className={styles.when}>Put the roof on the estimate to see its range.</p>
        )}
      </div>
      {priced && (
        <div>
          <div className={styles.split} aria-hidden="true">
            <span className={styles.splitEstimate} style={{ flex: share }} />
            {share < 1 && <span className={styles.splitRoom} style={{ flex: 1 - share }} />}
          </div>
          <div className={styles.splitLabels}>
            <span>The estimate{Number(quote.tax_amount) > 0 ? " with tax" : ""}, {money(quote.total)}</span>
            <span>+{settings.pct}% room</span>
          </div>
        </div>
      )}
      {sitePrice}
      {assign}
      {canSell && (
        <div className={styles.cardActions}>
          <Button variant="primary" size="lg" className={styles.bigButton} icon="send" disabled={!priced || busy} onClick={() => onSend("range")}>
            Send the range to {Who}
          </Button>
          {sees}
        </div>
      )}
      <p className={styles.smallPrint}>
        {Who} gets a link to see the range and what's included. When they say yes, you get a note to book {rep || "the visit"}.
        {busy ? " Saving your changes first…" : ""}
      </p>
      {exactInstead}
    </section>
  );
}
