/**
 * A letter-size estimate or invoice on the business's template: the page that prints, that "Print or
 * save PDF" makes, and that the homeowner's link shows once it's signed, with both signatures on
 * their lines. Three ways to show it:
 *   - EstimateDocument: the page itself, 816 px wide (8.5 in).
 *   - DocumentSheet: the page scaled down to fit its column, as a sheet of paper on screen.
 *   - PrintableDocument: nothing on screen, and the only thing on the page when it's printed.
 */
import { companySignatureLabel, documentColor, type TemplateSettings } from "@crewtavo/core/documents";
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatMoneyCents } from "@/lib/format";
import { initials, inkOn, licenseLine, longDate, pageFooterCss, quantityLabel, readableOnWhite, shortDate, websiteLabel } from "./build";
import styles from "./EstimateDocument.module.css";
import type { DocumentCompany, DocumentData, DocumentSignature, EstimateDocumentProps } from "./types";

/** 8.5 × 11 in at 96 dpi. */
export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
/** What's left of a letter page inside PrintableDocument's 0.4 in margins: 10.2 in. */
const PRINT_PAGE_HEIGHT = 10.2 * 96;

/** How many printed pages a document this tall (laid out at the printed width) takes. Any bit over a page is another page. */
export const printedPages = (height: number) => Math.max(1, Math.ceil(height / PRINT_PAGE_HEIGHT - 0.001));

export const CLASSIC_FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function EstimateDocument({ template, company, data, className, pages = 1 }: EstimateDocumentProps) {
  const color = documentColor(template, company.settings);
  const estimate = data.kind === "estimate";
  const vars = {
    "--doc-color": color,
    "--doc-on-color": inkOn(color),
    "--doc-text-color": readableOnWhite(color),
    fontFamily: template.font === "classic" ? CLASSIC_FONT : "var(--font)",
  } as CSSProperties;
  const kind = estimate ? "Estimate" : "Invoice";
  const footer = template.footer.trim();

  return (
    <article className={cx(styles.page, className)} style={vars} aria-label={data.number ? `${kind} ${data.number}` : kind}>
      <Letterhead template={template} company={company} />
      <div className={styles.body}>
        <div className={styles.parties}>
          <div>
            <div className={styles.eyebrow}>{estimate ? "Prepared for" : "Bill to"}</div>
            <div className={styles.clientName}>{data.client.name || " "}</div>
            {data.client.lines.length > 0 && <div className={styles.clientLines}>{data.client.lines.map((line, i) => <div key={i}>{line}</div>)}</div>}
          </div>
          <div className={styles.heading}>
            <div className={styles.kind}>{kind}</div>
            <div className={styles.meta}>
              {data.number != null && <div>No. {data.number}</div>}
              {data.date && <div>{longDate(data.date)}</div>}
              {estimate && data.validUntil && <div>Good until {longDate(data.validUntil)}</div>}
              {!estimate && data.dueOn && <div>Due {longDate(data.dueOn)}</div>}
            </div>
          </div>
        </div>

        {(data.title || (data.facts?.length ?? 0) > 0) && (
          <div className={styles.strip}>
            {data.title && <strong>{data.title}</strong>}
            {data.facts?.map((fact, i) => <span key={i}>{fact}</span>)}
          </div>
        )}

        <table className={styles.lines}>
          <colgroup>
            <col />
            <col className={styles.colQty} />
            <col className={styles.colPrice} />
            <col className={styles.colAmount} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className={styles.num}>Qty</th>
              <th scope="col" className={styles.num}>Price</th>
              <th scope="col" className={styles.num}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line, i) => (
              <tr key={i}>
                <td>
                  {line.name}
                  {line.description && <span className={styles.lineDescription}>{line.description}</span>}
                </td>
                <td className={cx(styles.num, styles.muted)}>{quantityLabel(line.quantity, line.unit)}</td>
                <td className={cx(styles.num, styles.muted)}>{formatMoneyCents(line.unit_price)}</td>
                <td className={cx(styles.num, styles.amount)}>{formatMoneyCents(line.total)}</td>
              </tr>
            ))}
            {data.lines.length === 0 && (
              <tr>
                <td colSpan={4} className={styles.empty}>Nothing on it yet.</td>
              </tr>
            )}
          </tbody>
        </table>

        <Totals data={data} />

        {data.notes?.trim() && (
          <div className={styles.notes}>
            <div className={styles.eyebrow}>Notes</div>
            {data.notes.trim()}
          </div>
        )}
        {template.terms.trim() && <div className={styles.terms}>{template.terms.trim()}</div>}
        {estimate && <Signatures template={template} company={company} signatures={data.signatures} />}
      </div>
      {(footer || template.page_numbers) && (
        <footer className={styles.footer}>
          <span>{footer}</span>
          {template.page_numbers && <span>Page {pages} of {pages}</span>}
        </footer>
      )}
    </article>
  );
}

/** The business's name, logo and details, in the template's header style. */
function Letterhead({ template, company }: { template: TemplateSettings; company: DocumentCompany }) {
  const tagline = template.tagline.trim();
  const license = template.show_license && template.license.trim() ? licenseLine(template.license) : null;
  const insurer = template.show_insurer && template.insurer.trim() ? `Insured by ${template.insurer.trim()}` : null;
  const website = websiteLabel(company.website);
  const contact = [company.phone, company.email].filter(Boolean).join(" · ");
  const name = (
    <div>
      <div className={styles.name}>{company.name}</div>
      {tagline && <div className={styles.tagline}>{tagline}</div>}
    </div>
  );

  if (template.header === "centered") {
    const line = [company.address.join(", "), company.phone, company.email, website].filter(Boolean).join(" · ");
    return (
      <header className={styles.centered}>
        <Mark company={company} />
        <div className={styles.name}>{company.name}</div>
        {tagline && <div className={styles.tagline}>{tagline}</div>}
        {line && <div className={styles.detailsLine}>{line}</div>}
        {(license || insurer) && (
          <div className={styles.detailsLine} style={{ paddingTop: 0 }}>
            {license && <span className={styles.license}>{license}</span>}
            {license && insurer && " · "}
            {insurer}
          </div>
        )}
        <span className={styles.bar} aria-hidden="true" />
      </header>
    );
  }

  const details = (
    <div className={styles.details}>
      {company.address.map((line, i) => <div key={i}>{line}</div>)}
      {contact && <div>{contact}</div>}
      {website && <div>{website}</div>}
      {license && <div className={styles.license}>{license}</div>}
      {insurer && <div>{insurer}</div>}
    </div>
  );
  if (template.header === "banner") {
    return (
      <header className={styles.banner}>
        <div className={styles.brand}>
          <span className={styles.tile}>{company.logo ? <img className={styles.logo} src={company.logo} alt={company.name} /> : <span className={styles.tileInitials} aria-hidden="true">{initials(company.name)}</span>}</span>
          {name}
        </div>
        {details}
      </header>
    );
  }
  return (
    <header className={styles.classic}>
      <div className={styles.brand}>
        <Mark company={company} />
        {name}
      </div>
      {details}
    </header>
  );
}

/** The logo, or the business's initials on its color. */
function Mark({ company }: { company: DocumentCompany }) {
  return company.logo ? <img className={styles.logo} src={company.logo} alt={company.name} /> : <span className={styles.monogram} aria-hidden="true">{initials(company.name)}</span>;
}

function Totals({ data }: { data: DocumentData }) {
  const estimate = data.kind === "estimate";
  return (
    <dl className={styles.totals}>
      <dt>Subtotal</dt>
      <dd>{formatMoneyCents(data.subtotal)}</dd>
      {data.discount > 0 && (
        <>
          <dt>{data.discountLabel || "Discount"}</dt>
          <dd>−{formatMoneyCents(data.discount)}</dd>
        </>
      )}
      {data.tax > 0 && (
        <>
          <dt>Tax</dt>
          <dd>{formatMoneyCents(data.tax)}</dd>
        </>
      )}
      <dt className={styles.grand}>Total</dt>
      <dd className={styles.grand}>{formatMoneyCents(data.total)}</dd>
      {estimate && Number(data.deposit) > 0 && (
        <>
          <dt>Deposit to get on the schedule</dt>
          <dd>{formatMoneyCents(data.deposit)}</dd>
        </>
      )}
      {!estimate &&
        data.payments?.map((p, i) => (
          <PaymentRow key={i} label={p.label} amount={p.amount} />
        ))}
      {!estimate && data.balanceDue != null && (
        <>
          <dt className={styles.grand}>Balance due</dt>
          <dd className={styles.grand}>{formatMoneyCents(data.balanceDue)}</dd>
        </>
      )}
    </dl>
  );
}

function PaymentRow({ label, amount }: { label: string; amount: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{amount >= 0 ? `−${formatMoneyCents(amount)}` : `+${formatMoneyCents(-amount)}`}</dd>
    </>
  );
}

/**
 * The signature lines the template asks for. A line someone already signed shows even if the
 * template no longer asks for it: a signature is never left off the copy.
 */
function Signatures({ template, company, signatures }: { template: TemplateSettings; company: DocumentCompany; signatures: DocumentData["signatures"] }) {
  const customer = signatures?.customer ?? null;
  const business = signatures?.company ?? null;
  const showCustomer = template.customer_signs || Boolean(customer?.image);
  const showCompany = template.company_signs || Boolean(business?.image);
  if (!showCustomer && !showCompany) return null;
  return (
    <div className={styles.signatures}>
      {showCustomer && <SignatureLine label={template.customer_label.trim() || "Customer"} signature={customer} dates={template.sign_dates} />}
      {showCompany && <SignatureLine label={companySignatureLabel(template, company.name)} signature={business} dates={template.sign_dates} />}
    </div>
  );
}

function SignatureLine({ label, signature, dates }: { label: string; signature: DocumentSignature | null; dates: boolean }) {
  return (
    <div className={styles.sign}>
      <div className={styles.signLine}>
        {signature?.image && <img className={styles.signImage} src={signature.image} alt={signature.name ? `Signature of ${signature.name}` : "Signature"} />}
        {dates && signature?.image && signature.date && <span className={styles.signDate}>{shortDate(signature.date)}</span>}
      </div>
      <div className={styles.signUnder}>
        <span>{label}</span>
        {dates && <span>Date</span>}
      </div>
      {signature?.name && <div className={styles.printed}>{signature.name}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------------------------

/** Whether the browser can zoom an element, which keeps scaled-down text sharp (else a transform). */
const canZoom = () => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "0.5");

export type DocumentSheetProps = { children?: ReactNode; className?: string } & Partial<EstimateDocumentProps>;

/**
 * The page as a sheet of paper, scaled down to fit its column (never up). Pass the document's
 * template, company and data, or an EstimateDocument as its child.
 */
export function DocumentSheet({ children, className, template, company, data, pages }: DocumentSheetProps) {
  const outer = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [zoom] = useState(canZoom);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(PAGE_HEIGHT);

  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => {
      setScale(Math.min(1, Math.max(0.2, el.clientWidth / PAGE_WIDTH)));
      if (paper.current) setHeight(paper.current.offsetHeight);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    if (paper.current) observer.observe(paper.current);
    return () => observer.disconnect();
  }, []);

  const content = children ?? (template && company && data ? <EstimateDocument template={template} company={company} data={data} pages={pages} /> : null);
  return (
    <div ref={outer} className={cx(styles.sheet, className)}>
      <div className={styles.frame} style={zoom ? { zoom: scale } : { width: PAGE_WIDTH * scale, height: height * scale }}>
        <div ref={paper} className={styles.paper} style={zoom ? undefined : { transform: `scale(${scale})` }}>
          {content}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// In print
// ---------------------------------------------------------------------------------------------

export type PrintableDocumentProps = { children?: ReactNode } & Partial<EstimateDocumentProps>;

/** Whether this browser prints @page margin boxes (recent Chrome and Edge do). Elsewhere the footer prints once, at the end. */
const printsMarginBoxes = () => typeof window !== "undefined" && "CSSMarginRule" in window;

/**
 * The document, hidden on screen, and the only thing on the page when this screen prints (the
 * browser's Print, or Save as PDF): letter paper, 0.4 in margins. While it's mounted, printing
 * anything on the screen prints the document instead. A one-page document fills the page, so the
 * signatures and the footer sit at the bottom like on screen. Where the browser can, the footer and
 * "Page 2 of 3" print at the bottom of every page; elsewhere the footer ends the last page, with the
 * pages counted here.
 */
export function PrintableDocument({ children, className, template, company, data }: PrintableDocumentProps) {
  const root = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(1);
  const [marginBoxes] = useState(printsMarginBoxes);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const count = () => setPages(printedPages(el.offsetHeight));
    count();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(count);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (typeof document === "undefined") return null;
  const content = children ?? (template && company && data ? <EstimateDocument template={template} company={company} data={data} pages={pages} className={className} /> : null);
  const footer = marginBoxes && !children && template && company && data ? pageFooterCss(template, documentColor(template, company.settings), template.font === "classic" ? CLASSIC_FONT : "var(--font, system-ui, sans-serif)") : "";
  return createPortal(
    <div ref={root} className={styles.printRoot} data-printable-document="" data-page-footer={footer ? "" : undefined}>
      {/* Only while it's mounted: letter paper, and nothing else on the printed page. */}
      <style>{`@page { size: letter; margin: 0.4in;${footer ? `\n${footer}\n` : " "}}
@media print {
  html, body { background: #fff !important; margin: 0 !important; padding: 0 !important; }
  body > :not(.${styles.printRoot}) { display: none !important; }
}`}</style>
      {content}
    </div>,
    document.body,
  );
}

/**
 * Prints the PrintableDocument on this screen once its lettering and pictures (the logo and the
 * signatures) have loaded, so the copy is never missing them. Gives up waiting after a few seconds.
 */
export async function printDocument(waitMs = 4000): Promise<void> {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>("[data-printable-document] img"));
  const loaded = images.map((img) =>
    img.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
  );
  await Promise.race([Promise.all([document.fonts?.ready, ...loaded]), new Promise((resolve) => setTimeout(resolve, waitMs))]);
  window.print();
}
