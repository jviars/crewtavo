/**
 * The salesperson's site visit on an iPad (/roofing/:id/visit): the estimate the office priced, big
 * enough for a finger, to check on the roof (− and + on what the office guessed, quick adds for what
 * turns up, notes and photos for the office and crew), and the exact price, set with the homeowner,
 * before they sign together. Landscape has the price beside the list; portrait puts it under the
 * list, with the price and "Review and sign" kept along the bottom.
 */
import { isSiteAdjustment, marginPct } from "@crewtavo/core/estimates";
import { toCents } from "@crewtavo/core/money";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useSession } from "@/lib/session";
import { useLetterhead, useMySignature, useTemplates } from "../../documents/data";
import type { TakeoffRow } from "../../paving/data";
import { useActiveServices, useEstimateEditor, useEstimateQuote, usePackageQuickAdds, useQuoteNotes } from "../estimate/data";
import { AbcBadge } from "../estimate/EstimateNumbers";
import { ChangeList } from "../estimate/ChangeList";
import { EstimateList } from "../estimate/EstimateList";
import { NotesThread } from "../estimate/NotesThread";
import { RangeBar } from "../estimate/RangeBar";
import { estimateFigures, firstName, LOW_MARGIN, money, rangePosition } from "../estimate/rows";
import { isEditableQuote, type EstimateQuote } from "../estimate/types";
import { useMaterialReprice } from "../estimate/useMaterialReprice";
import { isSignedQuote, useCanSell, useSetSitePrice, useVisitDetails, visitPath } from "./data";
import {
  adjustmentNote,
  estimatePrice,
  estimateSubtotal,
  keptNote,
  keptPriceText,
  parsePrice,
  priceInputText,
  priceToSave,
  rangeNote,
  rangeWords,
  readKeptPrice,
  roundDown,
  savedSitePrice,
  shortDay,
  totalsAt,
  visitChanges,
} from "./price";
import { VisitClosed, VisitEmpty, VisitError, VisitFrame, VisitLoading, VisitNoAccess, whoAndWhere } from "./VisitFrame";
import styles from "./visit.module.css";

export function RoofVisitPage() {
  const { id = "" } = useParams();
  const canSell = useCanSell();
  const estimate = useEstimateQuote(canSell ? id : null);
  // Once the screen is up it stays up, even if every line is taken off.
  const started = useRef(false);
  const onStarted = useCallback(() => {
    started.current = true;
  }, []);

  if (!canSell) return <VisitNoAccess />;
  // A refresh that fails while the estimate is showing keeps it on screen (with a toast): nothing
  // drawn or typed here is lost to a moment without signal.
  if (!estimate.data) return estimate.error ? <VisitError error={estimate.error} onRetry={() => void estimate.refetch()} /> : <VisitLoading kind="visit" />;
  const { quote, takeoff } = estimate.data;
  if (isSignedQuote(quote)) return <Navigate to={visitPath(quote.id, "signed")} replace />;
  if (!isEditableQuote(quote)) return <VisitClosed quote={quote} />;
  if (!quote.lines.length && !started.current) return <VisitEmpty quote={quote} />;
  return <VisitScreen quote={quote} takeoff={takeoff} onStarted={onStarted} />;
}

// ---------------------------------------------------------------------------------------------
// The price typed on the iPad, kept for this tab until it's saved
// ---------------------------------------------------------------------------------------------

const keptKey = (quoteId: string) => `crewtavo.site-price.${quoteId}`;

function readKept(quoteId: string): string | null {
  try {
    return sessionStorage.getItem(keptKey(quoteId));
  } catch {
    return null;
  }
}

function keep(quoteId: string, price: number | null | undefined) {
  try {
    if (price === undefined) sessionStorage.removeItem(keptKey(quoteId));
    else sessionStorage.setItem(keptKey(quoteId), keptPriceText(price));
  } catch {
    // Private browsing: the price just isn't kept if they step away.
  }
}

// ---------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------

function VisitScreen({ quote, takeoff, onStarted }: { quote: EstimateQuote; takeoff: TakeoffRow | null; onStarted: () => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const tz = session.company.timezone;
  useEffect(onStarted, [onStarted]);

  const editor = useEstimateEditor({ quote, measurementId: takeoff?.id ?? null });
  const quickAdds = usePackageQuickAdds(quote.roof_package_id);
  const services = useActiveServices();
  // Costs follow the quantities, so the margin is at today's ABC Supply prices.
  useMaterialReprice(quote, true);
  const details = useVisitDetails(quote.id);
  const notes = useQuoteNotes(quote.id);
  const sitePrice = useSetSitePrice(quote.id);
  const estimateId = useId();
  // Signing comes next: have its template, letterhead and saved signature ready.
  useTemplates();
  useLetterhead();
  useMySignature();

  const first = firstName(quote.client?.display_name);
  const author = details.data?.author ?? null;
  const office = author && author.user_id !== session.userId ? firstName(author.name) : null;

  // The list shows the work; a price adjustment set on site last time is the price, shown on the right.
  const listed = useMemo(() => ({ ...quote, lines: quote.lines.filter((l) => !isSiteAdjustment(l)) }), [quote]);
  const changes = useMemo(() => visitChanges(quote.range_lines, quote.lines), [quote.range_lines, quote.lines]);

  // The price: the estimate (less a discount the office gave), unless the salesperson sets one; a
  // price set on site before is where it starts. A promo code sets its own discount.
  const promo = Boolean(quote.promo_code_id);
  const estimate = estimatePrice(quote);
  const [override, setOverrideState] = useState<number | null>(() => {
    if (promo) return null;
    const kept = readKeptPrice(readKept(quote.id));
    return kept === undefined ? savedSitePrice(quote) : kept;
  });
  const setOverride = (value: number | null) => {
    setOverrideState(value);
    keep(quote.id, value);
  };
  const [draft, setDraft] = useState<string | null>(null);
  const price = promo || override === null ? estimate : override;
  const totals = totalsAt(quote, promo ? null : override);
  const invalid = draft !== null && draft.trim() !== "" && parsePrice(draft) === null;
  const rounded = roundDown(estimate);

  const range = quote.range_low !== null && quote.range_high !== null ? { low: quote.range_low, high: quote.range_high } : null;
  const accepted = Boolean(quote.range_accepted_at);
  // The range was the price with tax, so that's what it's held against.
  const position = range ? rangePosition(range.low, range.high, totals.total) : null;
  const note = position ? rangeNote(position.where, position.over, first, accepted) : null;

  const figures = useMemo(() => estimateFigures(listed), [listed]);
  const margin = figures ? marginPct(price, figures.cost) : null;

  const fromOthers = useMemo(() => (notes.data?.thread ?? []).filter((t) => t.note && t.author_id && t.author_id !== session.userId), [notes.data, session.userId]);
  const latest = fromOthers[0] ?? null;
  const latestAuthor = latest?.author_id ? notes.data?.authors[latest.author_id] : undefined;

  const ready = !editor.busy && !invalid && !sitePrice.isPending && price > 0;
  const review = () => {
    if (!ready) return;
    sitePrice.mutate(priceToSave(quote, override), {
      onSuccess: () => {
        // It's on the estimate now; coming back reads it from there.
        keep(quote.id, undefined);
        navigate(visitPath(quote.id, "sign"));
      },
    });
  };
  const toNotes = () => document.getElementById("visit-notes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const measureLink = takeoff ? `/measure?measurement=${takeoff.id}&roofing=1` : `/measure?quote=${quote.id}&roofing=1${quote.property ? `&property=${quote.property.id}` : ""}`;

  const reviewButton = (
    <button type="button" className={`btn btn-primary ${styles.bigButton}`} disabled={!ready} aria-busy={sitePrice.isPending || undefined} onClick={review}>
      {sitePrice.isPending && <Spinner size={18} />}
      {editor.busy ? "Saving your changes…" : invalid ? "Fix the price to go on" : "Review and sign"}
      {!sitePrice.isPending && !editor.busy && !invalid && <Icon name="arrowRight" size={19} strokeWidth={2.5} />}
    </button>
  );

  return (
    <VisitFrame
      title={quote.title}
      subtitle={whoAndWhere(quote)}
      back={{ to: `/roofing/${quote.id}`, label: quote.title || "The project" }}
      pageTitle={`Site visit · ${quote.title}`}
    >
      <div className={styles.visit}>
        <div className={styles.top}>
          {range && quote.range_accepted_at ? (
            <p className={`callout callout-good ${styles.strip}`}>
              <Icon name="check" size={20} strokeWidth={2.5} />
              <span>
                {first || "They"} said yes to <strong>{rangeWords(range.low, range.high)}</strong> on {shortDay(quote.range_accepted_at, tz)}.
              </span>
            </p>
          ) : range ? (
            <p className={`callout ${styles.strip}`}>
              <Icon name="info" size={20} />
              <span>
                The range sent to {first || "them"}
                {quote.range_sent_at ? ` on ${shortDay(quote.range_sent_at, tz)}` : ""} was <strong>{rangeWords(range.low, range.high)}</strong>.
              </span>
            </p>
          ) : null}

          {latest?.note && (
            <div className={styles.noteFrom}>
              <span className={`avatar ${styles.noteFace}`} style={{ background: latestAuthor?.color || "var(--avatar)" }} aria-hidden="true">
                <Face name={latestAuthor?.name ?? "?"} photo={latestAuthor?.photo} />
              </span>
              <div className={styles.noteBody}>
                <strong>Note from {firstName(latestAuthor?.name) || "the office"}</strong>
                <p className="pre-wrap">{latest.note.body}</p>
                {fromOthers.length > 1 && (
                  <button type="button" className={styles.textButton} onClick={toNotes}>
                    {fromOthers.length === 2 ? "1 more note" : `${fromOthers.length - 1} more notes`} below
                  </button>
                )}
              </div>
            </div>
          )}

          <section className={`card ${styles.estimate}`} aria-labelledby={estimateId}>
            <div className={styles.estimateHead}>
              <h2 id={estimateId}>The estimate</h2>
              <p>Fix anything {office ? `${office} guessed` : "that's not right"}: − and + change it, − takes it off.</p>
            </div>
            <EstimateList quote={listed} changes={changes} size="large" editable editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} />
            {services.error && (
              <p className={styles.inlineProblem} role="alert">
                Couldn't load your price list.{" "}
                <button type="button" className="link-btn" onClick={() => void services.refetch()}>Try again</button>
              </p>
            )}
            <div className={styles.match}>
              <span className={styles.matchText}>
                <strong>Does the roof match?</strong>
                <span>{takeoff ? "The roof's lines are worked out from the measurements." : "The roof hasn't been measured yet."}</span>
              </span>
              <Link className={`btn ${styles.touch}`} to={measureLink}>
                <Icon name="ruler" size={18} />
                {takeoff ? "Fix measurements" : "Measure the roof"}
              </Link>
            </div>
          </section>
        </div>

        <aside className={styles.aside} aria-label="Price">
          <div className={styles.asideScroll}>
            <div className={styles.priceHead}>
              <span className={styles.priceLabel}>Price</span>
              <span className={styles.price}>{money(price)}</span>
              {totals.tax > 0 && <span className={styles.withTax}>{money(totals.total)} with tax</span>}
            </div>

            {range && position && note && (
              <>
                <RangeBar low={range.low} high={range.high} value={totals.total} />
                <p className={styles.rangeNote} data-where={position.where}>
                  <Icon name={position.where === "above" ? "alert" : "check"} size={18} strokeWidth={2.4} />
                  {note.text}
                </p>
              </>
            )}

            <div className={styles.setPrice}>
              <label htmlFor={`${estimateId}-price`}>Set the price</label>
              <span className={styles.moneyField}>
                <span aria-hidden="true">$</span>
                <input
                  id={`${estimateId}-price`}
                  className={`input ${styles.moneyInput}`}
                  inputMode="decimal"
                  autoComplete="off"
                  enterKeyHint="done"
                  disabled={promo}
                  aria-invalid={invalid || undefined}
                  aria-describedby={`${estimateId}-price-note`}
                  value={draft ?? priceInputText(price)}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => {
                    const text = e.target.value;
                    setDraft(text);
                    if (!text.trim()) return setOverride(null);
                    const value = parsePrice(text);
                    if (value !== null) setOverride(value);
                  }}
                  onBlur={() => setDraft(null)}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              </span>
              <span id={`${estimateId}-price-note`} className={invalid ? styles.priceError : styles.priceHint} role={invalid ? "alert" : undefined}>
                {invalid
                  ? `Type the price in dollars, like ${priceInputText(rounded > 0 ? rounded : estimate)}.`
                  : promo
                    ? "A promo code is on this estimate, so it sets the price. Take it off in the office to set one here."
                    : (adjustmentNote(estimateSubtotal(quote.lines), override) ?? keptNote(quote) ?? "Before tax. Type a price, or keep the estimate.")}
              </span>
            </div>
            {!promo && (
              <div className={styles.priceChips}>
                {rounded > 0 && toCents(rounded) !== toCents(estimate) && (
                  <button
                    type="button"
                    className={styles.priceChip}
                    aria-pressed={override !== null && toCents(override) === toCents(rounded)}
                    onClick={() => {
                      setDraft(null);
                      setOverride(rounded);
                    }}
                  >
                    Round to {money(rounded)}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.priceChip}
                  aria-pressed={override === null}
                  onClick={() => {
                    setDraft(null);
                    setOverride(null);
                  }}
                >
                  Use {money(estimate)}
                </button>
              </div>
            )}

            {figures && margin !== null && (
              <div className={styles.margin} data-low={margin < LOW_MARGIN || undefined}>
                <span className={styles.marginLabel}>
                  {figures.materials !== null && <AbcBadge />}
                  {figures.materials !== null ? "Margin at today's prices" : "Margin"}
                </span>
                <strong>{margin}%</strong>
              </div>
            )}
            {figures?.costPartial && <p className={styles.smallNote}>Some lines have no cost in your price list, so the real margin is lower.</p>}

            {changes && (
              <div className={styles.changed}>
                <span className={styles.changedTitle}>You changed</span>
                <ChangeList
                  changes={changes}
                  size="large"
                  empty={<p className={styles.smallNote}>Nothing yet. {office ? `${office}'s estimate` : "The estimate"} is right as it is.</p>}
                />
              </div>
            )}
          </div>
          <div className={styles.asideFoot}>
            <FormError error={sitePrice.error} />
            {reviewButton}
          </div>
        </aside>

        <div className={styles.bottom} id="visit-notes">
          <NotesThread quoteId={quote.id} composer="site" title="Your notes" hint={`For the office and crew, not ${first || "the homeowner"}`} />
        </div>
      </div>

      {/* Portrait and phones: the price and the way on, always in reach. */}
      <div className={styles.bottomBar}>
        <FormError error={sitePrice.error} />
        <div className={styles.bottomRow}>
          <div className={styles.bottomPrice}>
            <span className={styles.bottomLabel}>Price</span>
            <strong>{money(price)}</strong>
            {note && position && <span className={styles.bottomNote} data-where={position.where}>{note.short}</span>}
          </div>
          {reviewButton}
        </div>
      </div>
    </VisitFrame>
  );
}
