/**
 * The salesperson's site visit on an iPad (/roofing/:id/visit): the estimate the office priced, big
 * enough for a finger, to check on the roof (− and + on what the office guessed, quick adds for what
 * turns up, notes and photos for the office and crew), and the exact price, set with the homeowner,
 * before they sign together. Landscape has the price beside the list; portrait puts it under the
 * list, with the price and "Review and sign" kept along the bottom.
 *
 * An estimate that offers options shows them as cards along the top (quotes/QuoteOptions.tsx): the
 * list shows the one being looked at, and "They chose this one" marks the homeowner's choice, which
 * is what the price is set for and what they sign. Review and sign waits until the option looked at
 * is the one they chose.
 */
import { isSiteAdjustment, marginPct } from "@crewtavo/core/estimates";
import { optionTotals, toCents } from "@crewtavo/core/money";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { Face } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useSession } from "@/lib/session";
import { useLetterhead, useMySignature, useTemplates } from "../../documents/data";
import type { TakeoffRow } from "../../paving/data";
import { optionTabs, viewedOption } from "../../quotes/options";
import { QuoteOptions } from "../../quotes/QuoteOptions";
import { refreshEstimateAfterEdits, useActiveServices, useEstimateEditor, useEstimateQuote, usePackageQuickAdds, useQuoteNotes } from "../estimate/data";
import { AbcBadge } from "../estimate/EstimateNumbers";
import { ChangeList } from "../estimate/ChangeList";
import { EstimateList, type EstimateView } from "../estimate/EstimateList";
import { NotesThread } from "../estimate/NotesThread";
import { RangeBar } from "../estimate/RangeBar";
import { estimateFigures, firstName, LOW_MARGIN, money, packageServices, rangePosition } from "../estimate/rows";
import { isEditableQuote, type EstimateQuote } from "../estimate/types";
import { useMaterialReprice } from "../estimate/useMaterialReprice";
import { useRoofPackages } from "../packages";
import { isSignedQuote, useCanSell, useSetSitePrice, useVisitDetails, visitPath } from "./data";
import {
  adjustmentNote,
  estimatePrice,
  estimateSubtotal,
  keptNote,
  keptPriceKey,
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
// The price typed on the iPad, kept for this tab until it's saved (per option: price.ts keptPriceKey)
// ---------------------------------------------------------------------------------------------

function readKept(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function keep(key: string, price: number | null | undefined) {
  try {
    if (price === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, keptPriceText(price));
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
  const queryClient = useQueryClient();
  const tz = session.company.timezone;
  useEffect(onStarted, [onStarted]);

  // The options: the one looked at (kept here; looking changes nothing) and the one they chose
  // (quotes.option_id), which the price is set for and they sign.
  const options = quote.options;
  const shown = options.length ? quote.option_id : null;
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = viewedOption(options, viewing, quote.option_id);
  const tabs = useMemo(() => optionTabs(options, quote.lines, quote), [options, quote]);
  const tab = tabs.find((t) => t.option.id === viewed) ?? null;
  const chosenTab = tabs.find((t) => t.option.id === shown) ?? null;
  const labelOf = (t: (typeof tabs)[number]) => t.tier ?? t.option.name;
  const packages = useRoofPackages({ enabled: options.length > 0 });
  const viewedPkg = tab?.option.package_id ? (packages.data?.find((p) => p.id === tab.option.package_id) ?? null) : null;
  const view = useMemo<EstimateView | null>(() => (tab ? { optionId: tab.option.id, label: tab.tier ?? tab.option.name, own: packageServices(viewedPkg) } : null), [tab, viewedPkg]);
  // Looking at an option they didn't choose: its price shows, but it isn't the one set or signed.
  const looking = options.length > 0 && viewed !== shown;
  const onChanged = () => void refreshEstimateAfterEdits(queryClient, quote.id, session.company.id);

  const editor = useEstimateEditor({ quote, measurementId: takeoff?.id ?? null, optionId: viewed, own: view?.own });
  const quickAdds = usePackageQuickAdds(tab ? tab.option.package_id : quote.roof_package_id);
  const services = useActiveServices();
  // Costs follow the quantities, so the margin is at today's ABC Supply prices.
  useMaterialReprice(quote, true);
  const details = useVisitDetails(quote.id);
  const notes = useQuoteNotes(quote.id);
  const sitePrice = useSetSitePrice(quote.id);
  const estimateId = useId();
  const panelId = `${estimateId}-panel`;
  // Signing comes next: have its template, letterhead and saved signature ready.
  useTemplates();
  useLetterhead();
  useMySignature();

  const first = firstName(quote.client?.display_name);
  const author = details.data?.author ?? null;
  const office = author && author.user_id !== session.userId ? firstName(author.name) : null;

  // The list shows the work; a price adjustment set on site last time is the price, shown on the right.
  const listed = useMemo(() => ({ ...quote, lines: quote.lines.filter((l) => !isSiteAdjustment(l)) }), [quote]);
  const changes = useMemo(() => visitChanges(quote.range_lines, quote.lines, viewed), [quote.range_lines, quote.lines, viewed]);

  // The price: the estimate (less a discount the office gave), unless the salesperson sets one; a
  // price set on site before is where it starts. A promo code sets its own discount. With options
  // it's the price of the option they chose, kept per option.
  const promo = Boolean(quote.promo_code_id);
  const estimate = estimatePrice(quote);
  const priceKey = keptPriceKey(quote.id, shown);
  const startingPrice = () => {
    if (promo) return null;
    const kept = readKeptPrice(readKept(priceKey));
    return kept === undefined ? savedSitePrice(quote) : kept;
  };
  const [typed, setTyped] = useState(() => ({ key: priceKey, value: startingPrice() }));
  const [draft, setDraft] = useState<string | null>(null);
  // They chose another option: start from its own price (the one set for the other went with it).
  if (typed.key !== priceKey) {
    setTyped({ key: priceKey, value: startingPrice() });
    setDraft(null);
  }
  const override = typed.key === priceKey ? typed.value : startingPrice();
  const setOverride = (value: number | null) => {
    setTyped({ key: priceKey, value });
    keep(priceKey, value);
  };
  const price = promo || override === null ? estimate : override;
  const totals = totalsAt(quote, promo ? null : override);
  // An option they didn't choose, as it would come to once chosen (its add-ons off).
  const lookTotals = looking && viewed ? optionTotals(quote.lines, viewed, quote.option_id, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo }) : null;
  const shownPrice = lookTotals ? (toCents(lookTotals.subtotal) - toCents(lookTotals.discount)) / 100 : price;
  const shownTotals = lookTotals ?? totals;
  const invalid = draft !== null && draft.trim() !== "" && parsePrice(draft) === null;
  const rounded = roundDown(estimate);

  const range = quote.range_low !== null && quote.range_high !== null ? { low: quote.range_low, high: quote.range_high } : null;
  const accepted = Boolean(quote.range_accepted_at);
  // The range was the price with tax, so that's what it's held against.
  const position = range ? rangePosition(range.low, range.high, shownTotals.total) : null;
  const note = position ? rangeNote(position.where, position.over, first, accepted) : null;

  const figures = useMemo(() => estimateFigures(listed, viewed), [listed, viewed]);
  const margin = figures ? marginPct(shownPrice, figures.cost) : null;

  const fromOthers = useMemo(() => (notes.data?.thread ?? []).filter((t) => t.note && t.author_id && t.author_id !== session.userId), [notes.data, session.userId]);
  const latest = fromOthers[0] ?? null;
  const latestAuthor = latest?.author_id ? notes.data?.authors[latest.author_id] : undefined;

  // With options, only the option they chose is signed, and it needs lines of its own to be priced.
  const unpriced = shown !== null && !quote.lines.some((l) => l.option_id === shown && !l.optional && !isSiteAdjustment(l));
  const blocker = options.length && !shown ? "Pick their option first" : looking ? "Mark their choice to go on" : unpriced ? "This option has no lines yet" : null;
  const ready = !blocker && !editor.busy && !invalid && !sitePrice.isPending && price > 0;
  const review = () => {
    if (!ready) return;
    // The server sets it on the option shown, and turns it away if another was chosen meanwhile
    // (the estimate loads again, so this screen catches up).
    sitePrice.mutate(priceToSave(quote, override), {
      onSuccess: () => {
        // It's on the estimate now; coming back reads it from there.
        keep(priceKey, undefined);
        navigate(visitPath(quote.id, "sign"));
      },
    });
  };
  const toNotes = () => document.getElementById("visit-notes")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const measureLink = takeoff ? `/measure?measurement=${takeoff.id}&roofing=1` : `/measure?quote=${quote.id}&roofing=1${quote.property ? `&property=${quote.property.id}` : ""}`;

  const reviewButton = (
    <button type="button" className={`btn btn-primary ${styles.bigButton}`} disabled={!ready} aria-busy={sitePrice.isPending || undefined} onClick={review}>
      {sitePrice.isPending && <Spinner size={18} />}
      {editor.busy ? "Saving your changes…" : (blocker ?? (invalid ? "Fix the price to go on" : "Review and sign"))}
      {!sitePrice.isPending && !editor.busy && !invalid && !blocker && <Icon name="arrowRight" size={19} strokeWidth={2.5} />}
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

          {options.length > 0 && (
            <QuoteOptions quote={quote} options={options} lines={quote.lines} viewing={viewing} onView={setViewing} mode="visit" onChanged={onChanged} panelId={panelId} />
          )}

          <section id={panelId} role={view ? "tabpanel" : undefined} className={`card ${styles.estimate}`} aria-labelledby={estimateId}>
            <div className={styles.estimateHead}>
              <h2 id={estimateId}>The estimate{view ? ` · ${view.label}` : ""}</h2>
              <p>Fix anything {office ? `${office} guessed` : "that's not right"}: − and + change it, − takes it off.</p>
            </div>
            <EstimateList quote={listed} changes={changes} size="large" editable editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} view={view} />
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
              <span className={styles.priceLabel}>{looking && view ? `${view.label}, if they choose it` : chosenTab ? `Price for ${labelOf(chosenTab)}` : "Price"}</span>
              <span className={styles.price}>{money(shownPrice)}</span>
              {shownTotals.tax > 0 && <span className={styles.withTax}>{money(shownTotals.total)} with tax</span>}
            </div>

            {range && position && note && (
              <>
                <RangeBar low={range.low} high={range.high} value={shownTotals.total} />
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
                  disabled={promo || looking}
                  aria-invalid={invalid || undefined}
                  aria-describedby={`${estimateId}-price-note`}
                  value={draft ?? priceInputText(looking ? shownPrice : price)}
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
                  : looking && view
                    ? `They chose ${chosenTab ? labelOf(chosenTab) : "another option"}. Tap “They chose this one” above to set ${view.label}'s price.`
                    : promo
                      ? "A promo code is on this estimate, so it sets the price. Take it off in the office to set one here."
                      : (adjustmentNote(estimateSubtotal(quote.lines, shown), override, { onOption: shown !== null, discount: quote.discount_amount }) ?? keptNote(quote) ?? "Before tax. Type a price, or keep the estimate.")}
              </span>
            </div>
            {!promo && !looking && (
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
            <span className={styles.bottomLabel}>{looking && view ? view.label : chosenTab ? `Price for ${labelOf(chosenTab)}` : "Price"}</span>
            <strong>{money(shownPrice)}</strong>
            {note && position && <span className={styles.bottomNote} data-where={position.where}>{note.short}</span>}
          </div>
          {reviewButton}
        </div>
      </div>
    </VisitFrame>
  );
}
