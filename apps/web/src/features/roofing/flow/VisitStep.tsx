/**
 * The site visit step. Before it's signed: whoever goes out opens the estimate on the iPad, checks
 * it on the roof, sets the exact price and signs with the homeowner (or the office sends it to sign
 * online). Once it's signed, what the office needs to see: how and when it was signed and whether
 * the homeowner got a copy, what changed on site against the range they said yes to, the signed
 * price and its margin, the notes and photos, and the signed document to open or print.
 */
import { lineChanges } from "@crewtavo/core/estimates";
import { useId, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/StatusPill";
import { useSession } from "@/lib/session";
import { readApproval } from "../../documents/data";
import { AbcBadge, ChangeList, estimateFigures, firstName, LOW_MARGIN, money, NotesThread, signedMoney, type EstimateQuote } from "../estimate";
import { useSendSignedCopy, useSignedCopies, type RoofProjectExtras } from "./data";
import { copySentence, dayText, hasRange, homeownerName, rangePill, rangeState, rangeWords, signedHeadline, signedSentence } from "./model";
import type { SendChannel, SendMode } from "./RangeCard";
import { SignedEstimate } from "./SignedEstimate";
import styles from "./flow.module.css";

export function VisitStep({ quote, extras, salesperson, current, canSell, onSend }: {
  quote: EstimateQuote;
  extras: RoofProjectExtras;
  salesperson: string | null;
  /** This is the step the project is at. */
  current: boolean;
  canSell: boolean;
  onSend: (mode: SendMode, startWith?: SendChannel) => void;
}) {
  const { company } = useSession();
  const navigate = useNavigate();
  const state = rangeState(quote);
  const who = homeownerName(quote.client?.display_name);
  const rep = firstName(salesperson);

  if (state === "signed") return <SignedView quote={quote} extras={extras} salesperson={salesperson} canSell={canSell} />;
  if (!quote.lines.length) return <span className="muted small">Price the estimate first; the iPad shows the same list.</span>;
  if (state === "closed") return <span className="muted small">This estimate was marked {quote.status === "lost" ? "lost" : "archived"}. Reopen it from the quote to visit.</span>;

  // Only a price set on the iPad counts as priced on site; the office sending the exact price
  // instead of the range (exact_sent_at) means nobody has been out yet.
  const priced = quote.priced_on_site_at;
  const emailed = !priced ? quote.exact_sent_at : null;
  return (
    <div className={styles.stepBody}>
      <p className={styles.stepLead}>
        {priced
          ? `${rep || "Your salesperson"} set the price on site ${dayText(priced, company.timezone)}: ${money(quote.total)}. Open the site visit to sign with ${who}.`
          : emailed
            ? `You sent ${who} the exact price on ${dayText(emailed, company.timezone)} to sign online. ${rep || "Whoever goes out"} can still check the roof and sign with ${who} on the iPad.`
            : `${rep || "Whoever goes out"} checks the roof and signs with ${who} on the iPad.`}
      </p>
      {canSell && (
        <div className={styles.actions}>
          <Button variant={current ? "primary" : undefined} icon="tablet" onClick={() => navigate(`/roofing/${quote.id}/visit`)}>
            {priced ? "Open the site visit" : "Start the site visit"}
          </Button>
          <Button icon="send" onClick={() => onSend("exact")}>Send it to sign online</Button>
        </div>
      )}
      <p className={`muted small ${styles.note}`}>On the iPad: the same list, bigger. Check it on the roof, add what's found, set the exact price, then sign together.</p>
    </div>
  );
}

function SignedView({ quote, extras, salesperson, canSell }: { quote: EstimateQuote; extras: RoofProjectExtras; salesperson: string | null; canSell: boolean }) {
  const { company } = useSession();
  const changedId = useId();
  const approval = readApproval(quote.approval);
  const signedAt = approval?.signed_at ?? quote.approved_at;
  const copies = useSignedCopies(quote.id, signedAt);
  const sendCopy = useSendSignedCopy(quote.id);
  // Against the range: the shared lines and the option they chose.
  const changes = useMemo(() => (quote.range_lines ? lineChanges(quote.range_lines, quote.lines, quote.option_id) : []), [quote.range_lines, quote.lines, quote.option_id]);
  const figures = estimateFigures(quote);
  const who = homeownerName(quote.client?.display_name);
  const copy = copies.data ? copySentence(copies.data, quote.client?.display_name) : null;
  const ranged = hasRange(quote);
  const pill = ranged ? rangePill(quote.total, { low: quote.range_low!, high: quote.range_high! }) : null;
  // Whoever signed for the business on site, else whoever the visit was booked for.
  const rep = firstName(approval?.company?.name ?? salesperson);
  const onSite = approval?.method === "in_person";
  const changedTitle = !ranged ? "The signed price" : onSite ? `What ${rep || "they"} changed on site` : "What changed since the range";
  const discount = Number(quote.discount_amount);
  const canCopy = canSell && approval?.method !== "manual" && !copy && copies.isSuccess && Boolean(quote.client?.email);

  return (
    <div className={styles.signed}>
      <div className={styles.banner} role="status">
        <span className={styles.bannerIcon} aria-hidden="true"><Icon name="check" size={18} strokeWidth={2.25} /></span>
        <div className={styles.bannerText}>
          <strong>{signedHeadline(approval, quote.total)}</strong>
          <p>
            {signedSentence(approval, quote.approved_at, company.name, company.timezone)}
            {copy ? ` ${copy}` : ""}
          </p>
          {canCopy && (
            <div className={styles.bannerActions}>
              <Button size="sm" icon="mail" loading={sendCopy.isPending} onClick={() => sendCopy.mutate("email")}>Email {who} a copy</Button>
            </div>
          )}
        </div>
      </div>

      <section className={styles.panel} aria-labelledby={changedId}>
        <h3 id={changedId}>{changedTitle}</h3>
        <div className={styles.compare}>
          {ranged && (
            <>
              <div className={`${styles.compareRow} ${styles.compareMuted}`}>
                <span>The range you sent{quote.range_accepted_at ? `, ${who} said yes ${dayText(quote.range_accepted_at, company.timezone)}` : ""}</span>
                <span>{rangeWords({ low: quote.range_low!, high: quote.range_high! })}</span>
              </div>
              <div className={styles.changes}>
                <ChangeList changes={changes} empty={<p className={styles.note}>Nothing changed. It was signed just as the estimate went out.</p>} />
              </div>
            </>
          )}
          {discount > 0 && (
            <div className={styles.compareRow}>
              <span>Discount</span>
              <span>{signedMoney(-discount)}</span>
            </div>
          )}
          <div className={styles.compareTotal}>
            <span>
              <strong>Signed price</strong>
              {pill && <StatusPill label={pill.label} tone={pill.tone} />}
            </span>
            <strong>{money(quote.total)}</strong>
          </div>
          {figures?.margin != null && (
            <p className={styles.marginLine} data-low={figures.margin < LOW_MARGIN || undefined}>
              {figures.pricedAt && <AbcBadge />}
              <span>
                <strong>{figures.margin}% margin</strong>
                {figures.pricedAt ? " at the ABC Supply prices it was signed with" : " at your price list's costs"}
                {figures.costPartial ? ". Some lines have no cost, so it's really lower." : ""}
              </span>
            </p>
          )}
        </div>
      </section>

      <section className={styles.panel}>
        <NotesThread quoteId={quote.id} composer="office" title="Notes" placeholder="Add a note for the crew: where the dumpster goes, the gate code…" bare />
      </section>

      <SignedEstimate quote={quote} extras={extras} />
    </div>
  );
}
