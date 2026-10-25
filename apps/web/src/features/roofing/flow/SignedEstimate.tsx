/**
 * The estimate as its document: the business's template with the exact price and both signatures,
 * the same pages the homeowner's link shows once it's signed. Its first page, small, to look at; Open
 * for all of them; and Print or save PDF from right here.
 */
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { dateIn, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { DocumentSheet } from "../../documents/EstimateDocument";
import { documentCompany, quoteDocument, readApproval, useLetterhead, useQuoteTemplate } from "../../documents/data";
import type { TakeoffRow } from "../../paving/data";
import { firstName, type EstimateQuote } from "../estimate";
import type { RoofProjectExtras } from "./data";
import { documentFacts } from "./model";
import { QuotePrint, useQuotePrint } from "./QuotePrint";
import styles from "./flow.module.css";

/**
 * The quote as its template document, with what the project page knows about it. Once signed, it's
 * on the template it was signed with, whatever changed in Settings since.
 */
export function useEstimateDocument(quote: EstimateQuote, extras: RoofProjectExtras, takeoff: TakeoffRow | null) {
  const { company } = useSession();
  const { template } = useQuoteTemplate(quote);
  const letterhead = useLetterhead();
  const tz = company.timezone;
  const data = useMemo(
    () =>
      quoteDocument(
        { ...quote, sent_at: extras.sent_at, valid_until: extras.valid_until, deposit_amount: extras.deposit_amount, message: extras.message, created_at: extras.created_at, promo: extras.promo },
        quote.lines,
        // Dated the day it went out where the business is, like the homeowner's copy. Signed for an
        // option, the strip names it ("Your choice: Better · Designer shingle") instead of the package.
        { date: extras.sent_at ? dateIn(extras.sent_at, tz) : todayIn(tz), facts: documentFacts(readApproval(quote.approval)?.option ? null : extras.package?.name, takeoff) },
      ),
    [quote, extras, takeoff, tz],
  );
  return { template, company: letterhead.data ?? documentCompany(company), data };
}

/** "with Dana's and Mike's signatures" */
function signedBy(approval: ReturnType<typeof readApproval>): string {
  const customer = approval?.method !== "manual" && approval?.signature ? firstName(approval.name) : "";
  const rep = approval?.company ? firstName(approval.company.name) : "";
  const names = [customer, rep].filter(Boolean).map((n) => `${n}'s`);
  if (!names.length) return approval?.method === "manual" ? "Marked approved in the office, so the signature lines are blank" : "On your letterhead";
  return `On your letterhead, with ${names.join(" and ")} ${names.length === 1 ? "signature" : "signatures"}`;
}

export function SignedEstimate({ quote, extras, takeoff }: { quote: EstimateQuote; extras: RoofProjectExtras; takeoff: TakeoffRow | null }) {
  const { company } = useSession();
  const id = useId();
  const doc = useEstimateDocument(quote, extras, takeoff);
  const printer = useQuotePrint();
  const [open, setOpen] = useState(false);
  const approval = readApproval(quote.approval);
  const companyLineBlank = doc.template.company_signs && !approval?.company && approval?.method !== "manual";

  return (
    <section className={styles.panel} aria-labelledby={id}>
      <div className={styles.doc}>
        {/* The little first page opens the whole document with a click; Open beside it does the same for keyboards and screen readers. */}
        <div className={styles.thumb} onClick={() => setOpen(true)} aria-hidden="true">
          <DocumentSheet template={doc.template} company={doc.company} data={doc.data} firstPageOnly />
        </div>
        <div className={styles.docText}>
          <div>
            <h3 id={id}>The signed estimate</h3>
            <p>{signedBy(approval)}</p>
            {companyLineBlank && (
              <p>
                The line for {company.name} is still blank. <Link to={`/quotes/${quote.id}`}>Sign it on the quote</Link>.
              </p>
            )}
          </div>
          <div className={styles.actions}>
            <Button icon="eye" onClick={() => setOpen(true)}>Open</Button>
            <Button icon="printer" onClick={printer.print}>Print or save PDF</Button>
          </div>
        </div>
      </div>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={quote.number ? `Estimate #${quote.number}` : "The signed estimate"} description={signedBy(approval)} size="xl">
          <div className="dialog-body">
            <DocumentSheet className={styles.docSheet} template={doc.template} company={doc.company} data={doc.data} />
            <div className="form-actions">
              <Button icon="printer" onClick={printer.print}>Print or save PDF</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        </Dialog>
      )}
      <QuotePrint request={printer.request} template={doc.template} company={doc.company} data={doc.data} />
    </section>
  );
}
