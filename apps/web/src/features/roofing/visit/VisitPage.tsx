/**
 * The salesperson's site visit on an iPad (/roofing/:id/visit). On the left, what to change: "Add
 * items" (pictures of the package's quick adds and the price list, VisitPicks), "Line items" (the
 * estimate the office priced, − and + on what it guessed, a line tapped to change by hand, the
 * options, notes and photos for the office and crew) and "Price" (the exact price, set with the
 * homeowner). On the right, the estimate as it prints and as they'll sign it: the business's own
 * template, letterhead and contract (the same paper as the sign page), redrawn as each change lands,
 * with the line that changed lit up. A line tapped on the paper opens to change. Landscape has the
 * two side by side, with the price and "Review and sign" along the bottom of the paper, in thumb
 * reach; portrait and phones show the paper, with the left side as a sheet over it and the price
 * along the bottom.
 *
 * An estimate that offers options shows them as cards on "Line items" (quotes/QuoteOptions.tsx): the
 * lists and the paper show the one being looked at, and "They chose this one" marks the homeowner's
 * choice, which is what the price is set for and what they sign. Review and sign waits until the
 * option looked at is the one they chose.
 */
import { isSiteAdjustment, marginPct } from "@crewtavo/core/estimates";
import { optionTotals, toCents } from "@crewtavo/core/money";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { AnimatedNumber, MONEY, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Face } from "@/components/ui/Avatar";
import { Spinner } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { contractTemplate, documentCompany, NO_CONTRACT, quoteDate, quoteDocument, useLetterhead, useMySignature, useQuoteContract, useQuoteTemplate } from "../../documents/data";
import { DocumentSheet } from "../../documents/EstimateDocument";
import type { TakeoffRow } from "../../paving/data";
import { optionTabs, viewedOption } from "../../quotes/options";
import { QuoteOptions } from "../../quotes/QuoteOptions";
import { refreshEstimateAfterEdits, useActiveServices, useEstimateEditor, useEstimateQuote, usePackageQuickAdds, useQuoteNotes } from "../estimate/data";
import { AbcBadge } from "../estimate/EstimateNumbers";
import { ChangeList } from "../estimate/ChangeList";
import { EstimateList, type EstimateView } from "../estimate/EstimateList";
import { NotesThread } from "../estimate/NotesThread";
import { RangeBar } from "../estimate/RangeBar";
import { counts, estimateFigures, firstName, isPendingLine, LOW_MARGIN, money, packageServices, rangePosition } from "../estimate/rows";
import { isEditableQuote, type EstimateLine, type EstimateQuote } from "../estimate/types";
import { useMaterialReprice } from "../estimate/useMaterialReprice";
import { useRoofPackages } from "../packages";
import { isSignedQuote, signContractInput, useCanSell, useSetSitePrice, useVisitDetails, visitPath } from "./data";
import { LineEditor } from "./LineEditor";
import {
  adjustmentNote,
  estimatePrice,
  estimateSubtotal,
  keptNote,
  keptPriceKey,
  keptPriceText,
  MAX_SITE_PRICE,
  parsePrice,
  priceInputText,
  priceToSave,
  rangeNote,
  rangeWords,
  readKeptPrice,
  roundDown,
  savedSitePrice,
  shortDay,
  sitePriced,
  totalsAt,
  visitChanges,
  type PaperLine,
} from "./price";
import { VisitClosed, VisitEmpty, VisitError, VisitFrame, VisitLoading, VisitNoAccess, whoAndWhere } from "./VisitFrame";
import { VisitPicks } from "./VisitPicks";
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
// The paper's lines, lit up as they change
// ---------------------------------------------------------------------------------------------

type PanelTab = "items" | "lines" | "price";
const TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: "items", label: "Add items" },
  { id: "lines", label: "Line items" },
  { id: "price", label: "Price" },
];

/** The price's +/− steps on "Price". */
const NUDGES = [-500, -100, 100, 500];

/**
 * A line's mark on the paper: the option it's on and its service (else its own id), so a line added
 * here keeps its mark from the moment it shows to when it's saved under its real id.
 */
const markOf = (line: Pick<PaperLine, "id" | "option_id" | "service_id">) => `${line.option_id ?? "all"}:${line.service_id ?? line.id}`;

/** Whether this screen is wide enough for the two sides together (the same width the CSS uses). */
const sideBySide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1000px)").matches;
const stillMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scroll the first of these lines on the paper into view and light them all up. */
function lightUp(root: HTMLElement | null, marks: readonly string[]) {
  if (!root || !marks.length) return;
  const rows = marks.flatMap((mark) => {
    const row = root.querySelector<HTMLElement>(`section[data-page] tr[data-mark="${CSS.escape(mark)}"]`);
    return row ? [row] : [];
  });
  rows[0]?.scrollIntoView({ block: "nearest", behavior: stillMotion() ? "auto" : "smooth" });
  for (const row of rows) {
    row.classList.remove(styles.paperFlash);
    void row.offsetWidth;
    row.classList.add(styles.paperFlash);
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
  const baseId = useId();
  const estimateId = `${baseId}-estimate`;
  const panelId = `${baseId}-panel`;
  // Signing comes next: have the saved signature ready.
  useMySignature();

  const [panelTab, setPanelTab] = useState<PanelTab>(() => (options.length && !quote.option_id ? "lines" : "items"));
  // Portrait and phones: the left side is a sheet over the paper.
  const [sheet, setSheet] = useState(false);
  // The margin is for the salesperson, and the homeowner can see the screen.
  const [showMargin, setShowMargin] = useState(false);
  const [editing, setEditing] = useState<EstimateLine | null>(null);
  const openTab = (t: PanelTab) => {
    setPanelTab(t);
    if (!sideBySide()) setSheet(true);
  };

  const first = firstName(quote.client?.display_name);
  const author = details.data?.author ?? null;
  const office = author && author.user_id !== session.userId ? firstName(author.name) : null;

  // The list shows the work; a price adjustment set on site last time is the price, shown on its own.
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
  const nudge = (by: number) => {
    setDraft(null);
    setOverride(Math.min(MAX_SITE_PRICE, Math.max(1, (toCents(price) + by * 100) / 100)));
  };

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

  // ---- The paper: the estimate as it prints, with the price set here as it will be saved ----
  const { template, isPending: templatePending } = useQuoteTemplate(quote);
  const letterhead = useLetterhead();
  const letter = letterhead.data ?? documentCompany(session.company);
  const paperOptionId = options.length ? viewed : null;
  const paperOption = details.data?.options.find((o) => o.id === paperOptionId) ?? null;
  const choice = useMemo(() => (paperOption ? { name: paperOption.name, tier: tab?.tier ?? paperOption.tier ?? null } : null), [paperOption, tab?.tier]);
  const priced = useMemo(() => (looking ? { lines: quote.lines, discount: Number(quote.discount_amount) } : sitePriced(quote, promo ? null : override)), [looking, quote, promo, override]);
  const paperLines = useMemo(() => priced.lines.map((l) => ({ ...l, mark: markOf(l) })), [priced]);
  const contractFor = useMemo(
    () => signContractInput(quote, details.data, template, paperOption, shownTotals.total, choice?.tier ?? null),
    [quote, details.data, template, paperOption, shownTotals.total, choice?.tier],
  );
  // The terms with their fill-ins filled; none until they're in, rather than the template's unfilled.
  const terms = useQuoteContract(contractFor);
  const contract = terms.contract ?? NO_CONTRACT;
  const data = useMemo(
    () =>
      quoteDocument(
        {
          ...quote,
          subtotal: shownTotals.subtotal,
          discount_amount: shownTotals.discount,
          tax_amount: shownTotals.tax,
          total: shownTotals.total,
          option_id: paperOptionId,
          message: details.data?.message ?? null,
          valid_until: details.data?.valid_until ?? null,
          deposit_amount: details.data?.deposit_amount ?? 0,
          sent_at: details.data?.sent_at ?? null,
          created_at: details.data?.created_at ?? null,
          approval: null,
        },
        paperLines,
        {
          date: quoteDate({ sent_at: details.data?.sent_at, created_at: details.data?.created_at }, tz),
          signatures: { customer: null, company: null },
          optionId: paperOptionId,
          choice,
          contract,
        },
      ),
    [quote, shownTotals, paperOptionId, details.data, paperLines, tz, choice, contract],
  );
  const paperReady = !templatePending && Boolean(details.data);
  const paperRef = useRef<HTMLDivElement>(null);

  // Light up each line on the paper that changed (added, more or fewer, a new price), once it's drawn.
  // The estimate often loads again right after a change; that doesn't cancel the light.
  const seen = useRef<{ option: string | null; lines: Map<string, string> } | null>(null);
  const toLight = useRef(new Set<string>());
  useEffect(() => {
    const now = new Map(paperLines.filter((l) => counts(l, paperOptionId)).map((l) => [l.mark, `${Number(l.quantity)}|${Number(l.unit_price)}|${l.name}|${l.description ?? ""}`]));
    const before = seen.current;
    seen.current = { option: paperOptionId, lines: now };
    // Another option shown is a different paper, not a change on it.
    if (!before || before.option !== paperOptionId) return;
    const moved = [...now].filter(([mark, value]) => before.lines.get(mark) !== value).map(([mark]) => mark);
    if (!moved.length) return;
    for (const mark of moved) toLight.current.add(mark);
    window.setTimeout(() => {
      lightUp(paperRef.current, [...toLight.current]);
      toLight.current.clear();
    }, 200);
  }, [paperLines, paperOptionId]);

  // A line tapped on the paper opens to change; the price adjustment opens the price.
  const onPaper = (target: EventTarget) => {
    const row = (target as Element).closest?.<HTMLElement>("tr[data-mark]");
    const found = row ? paperLines.find((l) => l.mark === row.dataset.mark) : null;
    if (!found) return;
    if (isSiteAdjustment(found)) return openTab("price");
    const line = quote.lines.find((l) => l.id === found.id);
    if (line && !isPendingLine(line)) setEditing(line);
  };

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
  const toNotes = () => {
    openTab("lines");
    requestAnimationFrame(() => document.getElementById("visit-notes")?.scrollIntoView({ behavior: stillMotion() ? "auto" : "smooth", block: "start" }));
  };
  const measureLink = takeoff ? `/measure?measurement=${takeoff.id}&roofing=1` : `/measure?quote=${quote.id}&roofing=1${quote.property ? `&property=${quote.property.id}` : ""}`;

  const priceLabel = looking && view ? `${view.label}, if they choose it` : chosenTab ? `Price for ${labelOf(chosenTab)}` : "Price";
  // In whole dollars, or with cents when it has them, rolling to each new price.
  const priceFigure = <AnimatedNumber className={styles.priceFigure} value={shownPrice} format={toCents(shownPrice) % 100 ? MONEY_CENTS : MONEY} />;
  const reviewButton = (
    <button type="button" className={`btn btn-primary ${styles.bigButton}`} disabled={!ready} aria-busy={sitePrice.isPending || undefined} onClick={review}>
      {sitePrice.isPending && <Spinner size={20} />}
      {editor.busy ? "Saving your changes…" : (blocker ?? (invalid ? "Fix the price to go on" : "Review and sign"))}
      {!sitePrice.isPending && !editor.busy && !invalid && !blocker && <Icon name="arrowRight" size={20} strokeWidth={2} />}
    </button>
  );
  const changeCount = changes?.length ?? 0;

  // ---- The left side's three parts ----
  const linesPart = (
    <>
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

      {options.length > 0 && <QuoteOptions quote={quote} options={options} lines={quote.lines} viewing={viewing} onView={setViewing} mode="visit" onChanged={onChanged} panelId={panelId} />}

      <section id={panelId} role={view ? "tabpanel" : undefined} className={`card ${styles.estimate}`} aria-labelledby={estimateId}>
        <div className={styles.estimateHead}>
          <h2 id={estimateId}>The estimate{view ? ` · ${view.label}` : ""}</h2>
          <p>Fix anything {office ? `${office} guessed` : "that's not right"}: − and + change it, − takes it off. Tap a line to change its price or words.</p>
        </div>
        <EstimateList quote={listed} changes={changes} size="large" editable editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} view={view} onEdit={setEditing} />
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
            <Icon name="ruler" size={20} />
            {takeoff ? "Fix measurements" : "Measure the roof"}
          </Link>
        </div>
      </section>

      <div id="visit-notes" className={styles.notes}>
        <NotesThread quoteId={quote.id} composer="site" title="Your notes" hint={`For the office and crew, not ${first || "the homeowner"}`} />
      </div>
    </>
  );

  const pricePart = (
    <>
      {range && quote.range_accepted_at ? (
        <p className={`callout callout-good ${styles.strip}`}>
          <Icon name="check" size={20} strokeWidth={2} />
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

      <div className={styles.priceHead}>
        <span className={styles.priceLabel}>{priceLabel}</span>
        <span className={styles.price}>{money(shownPrice)}</span>
        {shownTotals.tax > 0 && <span className={styles.withTax}>{money(shownTotals.total)} with tax</span>}
      </div>

      {range && position && note && (
        <>
          <RangeBar low={range.low} high={range.high} value={shownTotals.total} />
          <p className={styles.rangeNote} data-where={position.where}>
            <Icon name={position.where === "above" ? "alert" : "check"} size={20} />
            {note.text}
          </p>
        </>
      )}

      <div className={styles.setPrice}>
        <label htmlFor={`${baseId}-price`}>Set the price</label>
        <span className={styles.moneyField}>
          <span aria-hidden="true">$</span>
          <input
            id={`${baseId}-price`}
            className={`input ${styles.moneyInput}`}
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            disabled={promo || looking}
            aria-invalid={invalid || undefined}
            aria-describedby={`${baseId}-price-note`}
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
        <span id={`${baseId}-price-note`} className={invalid ? styles.priceError : styles.priceHint} role={invalid ? "alert" : undefined}>
          {invalid
            ? `Type the price in dollars, like ${priceInputText(rounded > 0 ? rounded : estimate)}.`
            : looking && view
              ? `They chose ${chosenTab ? labelOf(chosenTab) : "another option"}. Tap “They chose this one” on Line items to set ${view.label}'s price.`
              : promo
                ? "A promo code is on this estimate, so it sets the price. Take it off in the office to set one here."
                : (adjustmentNote(estimateSubtotal(quote.lines, shown), override, { onOption: shown !== null, discount: quote.discount_amount }) ?? keptNote(quote) ?? "Before tax. Type a price, or keep the estimate.")}
        </span>
      </div>
      {!promo && !looking && (
        <>
          <div className={styles.nudges} role="group" aria-label="Change the price by">
            {NUDGES.map((by) => (
              <button key={by} type="button" className={styles.nudge} onClick={() => nudge(by)}>
                {by < 0 ? "−" : "+"}
                {money(Math.abs(by))}
              </button>
            ))}
          </div>
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
        </>
      )}

      {figures && margin !== null &&
        (showMargin ? (
          <div className={styles.margin} data-low={margin < LOW_MARGIN || undefined}>
            <span className={styles.marginLabel}>
              {figures.materials !== null && <AbcBadge />}
              {figures.materials !== null ? "Margin at today's prices" : "Margin"}
            </span>
            <strong>{margin}%</strong>
            <button type="button" className={styles.textButton} aria-expanded="true" onClick={() => setShowMargin(false)}>Hide</button>
          </div>
        ) : (
          <button type="button" className={styles.marginShow} aria-expanded="false" onClick={() => setShowMargin(true)}>
            <Icon name="eye" size={20} />
            <span>
              <strong>Show margin</strong>
              <span>{first || "The homeowner"} can see this screen, so it starts hidden.</span>
            </span>
          </button>
        ))}
      {showMargin && figures?.costPartial && <p className={styles.smallNote}>Some lines have no cost in your price list, so the real margin is lower.</p>}

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
    </>
  );

  return (
    <VisitFrame
      title={quote.title}
      subtitle={whoAndWhere(quote)}
      back={{ to: `/roofing/${quote.id}`, label: quote.title || "The project" }}
      pageTitle={`Site visit · ${quote.title}`}
    >
      <div className={styles.visit}>
        <section className={styles.panel} data-open={sheet || undefined} aria-label="Change the estimate">
          <div className={styles.grab} aria-hidden="true" />
          <div className={`segmented ${styles.panelTabs}`} role="tablist" aria-label="What to change">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`${baseId}-${t.id}-tab`}
                className={styles.panelTab}
                aria-selected={panelTab === t.id}
                aria-controls={`${baseId}-${t.id}`}
                onClick={() => setPanelTab(t.id)}
              >
                {t.label}
                {t.id === "lines" && changeCount > 0 && <span className={styles.tabCount} aria-label={`${changeCount} changed`}>{changeCount}</span>}
              </button>
            ))}
          </div>
          <div className={styles.panelBody} role="tabpanel" id={`${baseId}-${panelTab}`} aria-labelledby={`${baseId}-${panelTab}-tab`}>
            {panelTab === "items" ? (
              <VisitPicks quote={listed} editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} view={view} onShow={(line) => lightUp(paperRef.current, [markOf(line)])} />
            ) : panelTab === "lines" ? (
              linesPart
            ) : (
              pricePart
            )}
          </div>
          <div className={styles.panelFoot}>
            <div className={styles.bottomPrice}>
              <span className={styles.bottomLabel}>{priceLabel}</span>
              <strong>{priceFigure}</strong>
              {note && position && <span className={styles.bottomNote} data-where={position.where}>{note.short}</span>}
            </div>
            <button type="button" className={`btn btn-primary ${styles.touch}`} onClick={() => setSheet(false)}>
              See the estimate
            </button>
          </div>
        </section>
        {sheet && <div className={styles.scrim} aria-hidden="true" onClick={() => setSheet(false)} />}

        <section className={styles.paperSide} aria-label={`The estimate ${first || "the homeowner"} signs`}>
          <div className={styles.paperBar}>
            <button type="button" className={styles.paperPrice} onClick={() => openTab("price")}>
              <span className={styles.priceLabel}>
                {priceLabel}
                {changeCount > 0 && <span className={styles.changeChip}>{changeCount === 1 ? "1 change" : `${changeCount} changes`}</span>}
              </span>
              <span className={styles.paperPriceRow}>
                {priceFigure}
                <span className={styles.setHint}>
                  <Icon name="edit" size={14} />
                  Set
                </span>
              </span>
              {note && position && <span className={styles.bottomNote} data-where={position.where}>{note.text}</span>}
            </button>
            <div className={styles.paperGo}>
              <FormError error={sitePrice.error} />
              {reviewButton}
            </div>
          </div>
          {looking && view && (
            <p className={`callout ${styles.paperNote}`}>
              <Icon name="info" size={20} />
              <span>
                This is {view.label}. {first || "They"} chose {chosenTab ? labelOf(chosenTab) : "another option"}, so it isn't the one they'd sign yet.
              </span>
            </p>
          )}
          <p className={styles.paperHint}>
            <Icon name="eye" size={16} />
            What {first || "they"} will sign. It changes as you do. Tap a line to change it.
          </p>
          {/* Taps on the paper's lines open them (a mouse or a finger); the same lines are in Line items for the keyboard. */}
          <div ref={paperRef} className={styles.paper} onClick={(e) => onPaper(e.target)}>
            {paperReady ? (
              <DocumentSheet template={contractTemplate(template, contract)} company={letter} data={data} />
            ) : !details.data && details.error ? (
              <div className="card">
                <ErrorState error={details.error} title="The estimate didn't load" onRetry={() => void details.refetch()} />
              </div>
            ) : (
              <div className={styles.docSkeleton} role="status" aria-label="Loading the estimate" />
            )}
          </div>
        </section>
      </div>

      {/* Portrait and phones: the price and the way on, always in reach. */}
      <div className={styles.bottomBar}>
        <FormError error={sitePrice.error} />
        <div className={styles.bottomRow}>
          <button type="button" className={`btn ${styles.changeButton}`} onClick={() => setSheet(true)}>
            <Icon name="edit" size={20} />
            Make changes
          </button>
          <div className={styles.bottomPrice}>
            <span className={styles.bottomLabel}>{priceLabel}</span>
            <strong>{priceFigure}</strong>
            {note && position && <span className={styles.bottomNote} data-where={position.where}>{note.short}</span>}
          </div>
          {reviewButton}
        </div>
      </div>

      <LineEditor line={editing} editor={editor} onClose={() => setEditing(null)} />
    </VisitFrame>
  );
}
