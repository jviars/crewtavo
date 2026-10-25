/**
 * Beside the estimate: the price range the homeowner will see (the estimate rounded down, to the
 * estimate plus the room on top, rounded up; with options, from the lowest option to the highest,
 * each option a tick on the bar), who goes out on the site visit, and sending it. Once it's out it
 * says when, and whether the estimate changed since. The office can mark a yes the homeowner gave on
 * the phone, before it's sent too; once they say yes, it's time to book the visit; once they have an
 * exact price, it shows that (or the options they have, from the lowest).
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
import { PackagePicture } from "../PackageCards";
import { blankTab, useMarkRangeAgreed, useOpenPreview, useSetSalesperson, useTeam } from "./data";
import {
  ACROSS_OPTIONS,
  canMarkAgreed,
  capital,
  dayText,
  estimateShare,
  hasRange,
  homeownerName,
  isPriced,
  leaningChoices,
  optionPrices,
  optionTicks,
  rangeAcrossOptions,
  rangeNow,
  rangeOutdated,
  rangePill,
  rangeState,
  rangeWords,
  rangeWordsFor,
  salesPeople,
} from "./model";
import styles from "./flow.module.css";

export type SendMode = "range" | "exact";
export type SendChannel = "email" | "sms" | "link";

/**
 * For a yes the homeowner gave another way (on the phone, by text, in person): the office marks the
 * range as agreed, and it's the same as their Yes on the link, with the option they're leaning toward
 * when they said. Before the range has gone out (the office told them on the phone), the server saves
 * it as they were told it, without sending them anything. The team is told to book the visit, and a
 * note on the estimate says who marked it.
 */
export function SaidYesButton({ quote, disabled }: { quote: EstimateQuote; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canMarkAgreed(quote)) return null;
  const unsent = rangeState(quote) === "unsent";
  return (
    <>
      <Button variant="ghost" icon="check" disabled={disabled || !isPriced(quote)} onClick={() => setOpen(true)}>
        {capital(homeownerName(quote.client?.display_name))} said yes {unsent ? "on the phone" : "another way"}
      </Button>
      {open && <SaidYesDialog quote={quote} unsent={unsent} onClose={() => setOpen(false)} />}
    </>
  );
}

function SaidYesDialog({ quote, unsent, onClose }: { quote: EstimateQuote; unsent: boolean; onClose: () => void }) {
  const { company } = useSession();
  const group = useId();
  const settings = rangeSettings(company.settings);
  const who = homeownerName(quote.client?.display_name);
  const [note, setNote] = useState("");
  const [leaning, setLeaning] = useState("");
  const mark = useMarkRangeAgreed(quote.id, capital(who));
  // Not sent yet: the range they were told is the one it would go out at now.
  const range = unsent ? rangeNow(quote, settings) : hasRange(quote) ? { low: quote.range_low, high: quote.range_high } : null;
  const choices = quote.options.length >= 2 ? leaningChoices(quote, settings) : [];
  return (
    <Dialog
      open
      size={choices.length ? "md" : "sm"}
      onClose={onClose}
      title={`Did ${who} say yes to the range?`}
      description={
        unsent
          ? "Use this when you told them the range on the phone or in person. Nothing is sent to them: the range is saved on the estimate as you told it, and we'll tell the team to book the visit, the same as if they'd tapped Yes."
          : "Use this when they told you on the phone, by text or in person. We'll tell the team to book the visit, the same as if they'd tapped Yes."
      }
    >
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          mark.mutate({ note, optionId: leaning || null }, { onSuccess: onClose });
        }}
      >
        {range && (
          <p className={styles.agreedRange}>
            {!unsent && quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, company.timezone)}: ` : "The range: "}
            <strong>{rangeWords(range)}</strong>
            {rangeAcrossOptions(quote) && `, ${ACROSS_OPTIONS}`}
          </p>
        )}
        {choices.length > 0 && (
          <fieldset className={styles.leaning}>
            <legend>Which one are they leaning toward? <span className="muted">(optional)</span></legend>
            <label className={styles.lean} data-on={!leaning || undefined}>
              <input type="radio" name={group} value="" checked={!leaning} onChange={() => setLeaning("")} />
              <span className={styles.leanText}><strong>Not sure yet</strong><span className={styles.leanRange}>They can choose on the visit.</span></span>
            </label>
            {choices.map(({ option, tier, range: own }) => (
              <label key={option.id} className={styles.lean} data-on={leaning === option.id || undefined}>
                <input type="radio" name={group} value={option.id} checked={leaning === option.id} onChange={() => setLeaning(option.id)} />
                <PackagePicture path={option.picture} style={option.style} className={styles.leanPicture} />
                <span className={styles.leanText}>
                  <strong>{tier ? `${tier} · ` : ""}{option.name}</strong>
                  <span className={styles.leanRange}>{own ? rangeWords(own) : "No price yet"}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <Field label="How they said yes" optional>
          <textarea className={`textarea ${styles.agreedNote}`} value={note} maxLength={500} placeholder={unsent ? "Like “On the phone with Sarah”" : "Like “Called the office Tuesday”"} onChange={(e) => setNote(e.target.value)} />
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
  const offered = quote.options.length > 0;
  // With options, the range is made of the options that have a price.
  const prices = optionPrices(quote);
  const priced = isPriced(quote);
  const now = rangeNow(quote, settings);
  // A range sent across the options says so under it.
  const across = rangeAcrossOptions(quote) && <p className={styles.when}>{capital(ACROSS_OPTIONS)}.</p>;
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
          {across}
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
    // Sent to sign online with options: they choose one, so it's the options they have, from the lowest.
    const choosing = !quote.priced_on_site_at && prices.length >= 2;
    return (
      <section id="range-card" className={styles.rangeCard} data-state="exact" aria-labelledby={titleId}>
        <div>
          <p className={styles.eyebrow} id={titleId}>{quote.priced_on_site_at ? "Priced on site" : choosing ? `The ${prices.length} options ${who} has` : `The price ${who} has`}</p>
          {choosing ? (
            <p className={styles.rangeBig}><span className={styles.rangeTo}>from</span> {money(Math.min(...prices.map((p) => p.total)))}</p>
          ) : (
            <p className={styles.rangeBig}>{money(quote.total)}</p>
          )}
          <p className={styles.when}>
            {quote.priced_on_site_at
              ? `Set ${dayText(quote.priced_on_site_at, tz)}, not signed yet.`
              : quote.exact_sent_at
                ? `Sent ${dayText(quote.exact_sent_at, tz)} instead of the range, to sign online.`
                : "Sent to sign online."}
          </p>
        </div>
        {pill && hasRange(quote) && !choosing && (
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="muted small">The range was {rangeWordsFor({ low: quote.range_low, high: quote.range_high }, quote)}</span>
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
          {across}
          <p className={styles.when}>{quote.range_sent_at ? `Sent ${dayText(quote.range_sent_at, tz)}. ` : ""}Waiting for their answer.</p>
        </div>
        {outdated && priced && (
          <p className={styles.changedNote}>
            <Icon name="alert" size={16} />
            <span>The estimate changed since. Send it again and {who} sees {rangeWordsFor(now, quote)}.</span>
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
  const ticks = offered ? optionTicks(quote, now.high) : [];
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
      {priced && offered ? (
        <OptionsBar ticks={ticks} pct={settings.pct} taxed={Number(quote.tax_rate) > 0} unpriced={quote.options.length - ticks.length} />
      ) : priced ? (
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
      ) : null}
      {sitePrice}
      {assign}
      {canSell && (
        <div className={styles.cardActions}>
          <Button variant="primary" size="lg" className={styles.bigButton} icon="send" disabled={!priced || busy} onClick={() => onSend("range")}>
            Send the range to {Who}
          </Button>
          {sees}
          <SaidYesButton quote={quote} disabled={busy} />
        </div>
      )}
      <p className={styles.smallPrint}>
        {Who} gets a link to see the range and {offered ? "the options" : "what's included"}. When they say yes, you get a note to book {rep || "the visit"}.
        {busy ? " Saving your changes first…" : ""}
      </p>
      {exactInstead}
    </section>
  );
}

/**
 * The range across the options: the bar runs to the range's high end, filled to the priciest option
 * with the room on top after it, and a tick at each option's price, named underneath (the tier word,
 * else its name). Options without a price yet aren't in the range.
 */
function OptionsBar({ ticks, pct, taxed, unpriced }: { ticks: ReturnType<typeof optionTicks>; pct: number; taxed: boolean; unpriced: number }) {
  const top = ticks.at(-1)?.at ?? 0;
  return (
    <div>
      <div className={styles.optionsBar} aria-hidden="true">
        <div className={styles.split}>
          <span className={styles.splitEstimate} style={{ flex: top }} />
          {top < 1 && <span className={styles.splitRoom} style={{ flex: 1 - top }} />}
        </div>
        {ticks.map((t) => <span key={t.id} className={styles.tick} style={{ left: `${t.at * 100}%` }} />)}
      </div>
      <div className={styles.splitLabels}>
        <span>From the lowest option to the highest{taxed ? ", with tax" : ""}</span>
        <span>+{pct}% room</span>
      </div>
      <ul className={styles.tickList} aria-label="The options in the range">
        {ticks.map((t) => (
          <li key={t.id}>
            <span>{t.label}</span>
            <strong>{money(t.total)}</strong>
          </li>
        ))}
      </ul>
      {unpriced > 0 && <p className={styles.smallPrint}>{unpriced === 1 ? "One option has" : `${unpriced} options have`} no lines yet, so {unpriced === 1 ? "it isn't" : "they aren't"} in the range.</p>}
    </div>
  );
}
