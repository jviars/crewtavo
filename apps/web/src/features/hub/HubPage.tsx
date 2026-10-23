/**
 * Client Hub (the customer portal): what a client sees from a link. No account needed; the link
 * is signed and expires.
 *   client  - their account: what's waiting on them, the next visit, history, request work
 *   quote   - choose optional items, approve with their name, or ask for changes; a roof estimate
 *             sent as a price range asks "Yes, send someone out" instead; a signed one shows the
 *             signed estimate itself
 *   invoice - view and pay (with an optional tip)
 * Quotes and invoices print as the business's estimate template. Add ?print=1 to print or save a PDF.
 */
import { greetingName } from "@crewtavo/core/automations";
import { lineTotal, optionLabels, quoteTotals } from "@crewtavo/core/money";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useParams, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { BrandMark } from "@/components/shell/BrandMark";
import { licenseLine, websiteLabel } from "@/features/documents/build";
import { DocumentSheet, PrintableDocument } from "@/features/documents/EstimateDocument";
import { ApiError } from "@/lib/api";
import { dateIn, formatDate, formatMoney, formatMoneyCents, todayIn } from "@/lib/format";
import { ClientPortal, hubZone, MessageDialog, type ClientView, type PortalVisit } from "./ClientPortal";
import {
  credentialLine,
  hubAccent,
  hubLetterhead,
  hubTemplate,
  invoiceDocument,
  maybePrice,
  measuredLine,
  measuredRoof,
  packageLabel,
  phoneHref,
  propertyLine,
  quoteDocument,
  rangeDates,
  roofTiles,
  trustBadges,
  websiteHref,
  type HubCompany,
  type HubDrawing,
  type HubLine,
  type HubPromoInfo,
  type InvoiceView,
  type MeasuredRoof,
  type QuoteView,
  type TrustBadge,
} from "./document";
import styles from "./range.module.css";
import { SignaturePad } from "../field/SignaturePad";

type View = QuoteView | InvoiceView | ClientView;

async function hubFetch<T>(path: string, body?: unknown, method?: "DELETE"): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      `/api/hub/${path}`,
      method ? { method } : body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    );
  } catch {
    throw new ApiError("Couldn't connect. Check your internet connection and try again.", 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((json as { error?: string }).error ?? "Something went wrong. Try again.", res.status);
  return json as T;
}

/**
 * Printing a quote or invoice prints the business's template (PrintableDocument), which is only put
 * on the page once someone prints: from the print button, ?print=1, or the browser's own Print (put
 * in place before the browser lays the page out). It stays after, since some browsers say printing
 * is over before they've made the copy.
 */
function usePrintMode() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    // The browser lays the page out for printing right after this, so the document goes in now.
    const before = () => flushSync(() => setOn(true));
    window.addEventListener("beforeprint", before);
    return () => window.removeEventListener("beforeprint", before);
  }, []);
  const print = useCallback(() => {
    setOn(true);
    void printWhenReady();
  }, []);
  return { on, print };
}

/**
 * Print once the page is ready to: the document on it, the fonts loaded and every picture (the
 * logo, signatures, the roof drawing) loaded or given up on, so the PDF isn't missing any. Waits 5
 * seconds at most.
 */
async function printWhenReady() {
  // Two frames: the document that printing puts on the page is drawn by then.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const pictures = Array.from(document.images).filter((img) => !img.complete);
  await Promise.race([
    Promise.all([
      document.fonts?.ready.catch(() => undefined),
      ...pictures.map((img) => new Promise((resolve) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      })),
    ]),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  window.print();
}

/** "Acme Paving" -> "AP". */
const monogram = (name: string) => (name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("") || name.slice(0, 2)).toUpperCase();

/** The company's logo, or its initials on its color when it has none (or the logo won't load). */
function CompanyMark({ company, logoClass = "hub-logo", tileClass = "tile" }: { company: Pick<HubCompany, "name" | "logo">; logoClass?: string; tileClass?: string }) {
  const [broken, setBroken] = useState(false);
  if (company.logo && !broken) return <img className={logoClass} src={company.logo} alt="" onError={() => setBroken(true)} />;
  return <span className={tileClass} aria-hidden="true">{monogram(company.name)}</span>;
}

/** Text color that reads on the company's color. */
function inkOn(hex: string | undefined) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#182430" : "#fff";
}

export function HubPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const printing = params.get("print") === "1";
  const view = useQuery({ queryKey: ["hub", token], queryFn: () => hubFetch<View>(token), retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 });
  const [messaging, setMessaging] = useState<{ visit?: PortalVisit } | null>(null);
  const { on: printable, print } = usePrintMode();
  const printed = useRef(false);

  useEffect(() => {
    if (view.data) document.title = `${view.data.kind === "quote" ? `${view.data.quote.range ? "Roof estimate" : "Quote"} #${view.data.quote.number}` : view.data.kind === "invoice" ? `Invoice #${view.data.invoice.number}` : "Your account"} · ${view.data.company.name}`;
    // Once: a refresh of the page's data (after paying, say) doesn't print it again.
    if (view.data && printing && !printed.current) {
      printed.current = true;
      print();
    }
  }, [view.data, printing, print]);

  const d = view.data;
  const brand = d?.company.branding?.color || "#3b7d23";
  const onBrand = inkOn(brand);
  const preview = Boolean(d && "preview" in d && d.preview);
  const home = d && d.kind !== "client" ? d.home : null;
  const clientName = d ? (d.kind === "client" ? d.client.name : d.kind === "quote" ? d.quote.client?.display_name : d.invoice.client?.display_name) : null;

  // A roof estimate out as a price range is a page of its own, on the business's letterhead.
  if (d?.kind === "quote" && d.quote.range) {
    return (
      <>
        <RangeHub token={token} data={d} onChanged={() => view.refetch()} onAsk={() => setMessaging({})} onPrint={print} />
        {messaging && <MessageDialog token={token} company={d.company.name} hubFetch={hubFetch} onClose={() => setMessaging(null)} />}
      </>
    );
  }

  return (
    <div
      className="public-page hub"
      data-printing={printing || undefined}
      // --brand-text: the brand color as text on white, or ink when it's too light to read there.
      style={{ ["--brand" as string]: brand, ["--on-brand" as string]: onBrand, ["--brand-text" as string]: onBrand === "#fff" ? brand : "var(--ink)" }}
    >
      {d && (
        <header className="hub-header">
          <div className="hub-header-inner">
            {home ? (
              <a className="hub-company" href={home} aria-label={`${d.company.name}: your account`}>
                <CompanyMark company={d.company} />
                <span className="stack-xs"><strong>{d.company.name}</strong><span className="hub-meta">Your account</span></span>
              </a>
            ) : (
              <div className="hub-company">
                <CompanyMark company={d.company} />
                <span className="stack-xs"><strong>{d.company.name}</strong><span className="hub-meta">{d.kind === "client" ? "Your account" : d.kind === "quote" ? `Quote #${d.quote.number}` : `Invoice #${d.invoice.number}`}</span></span>
              </div>
            )}
            {d.company.phone && <a className="hub-icon-btn no-print" href={`tel:${d.company.phone}`} aria-label={`Call ${d.company.name}`}><Icon name="phone" size={19} /></a>}
            {!preview && <button type="button" className="hub-icon-btn no-print" onClick={() => setMessaging({})} aria-label={`Message ${d.company.name}`}><Icon name="messages" size={19} /></button>}
            {d.kind !== "client" && <button type="button" className="hub-icon-btn no-print" onClick={print} aria-label="Print or save as PDF"><Icon name="printer" size={19} /></button>}
          </div>
        </header>
      )}
      <div className="public-wrap hub-wrap">
        {view.isPending && <HubSkeleton />}
        {view.error && (
          <div className="card">
            <div className="empty-state error-state">
              <span className="empty-icon"><Icon name="link" size={24} /></span>
              <h3>This link isn't working</h3>
              <p>{(view.error as Error).message}</p>
              {!(view.error instanceof ApiError && view.error.status < 500) && <div className="actions"><Button icon="refresh" onClick={() => view.refetch()}>Try again</Button></div>}
            </div>
          </div>
        )}
        {d && (
          <>
            {preview && <div className="callout callout-info no-print"><Icon name="eye" size={18} /><div className="grow">Preview: this is what your client sees.</div></div>}
            {home && <a className="hub-back no-print" href={home}><Icon name="chevronLeft" size={16} />Your account</a>}
            {d.kind === "quote" && <QuoteHub token={token} data={d} onChanged={() => view.refetch()} printing={printable} onPrint={print} />}
            {d.kind === "invoice" && <InvoiceHub token={token} data={d} onChanged={() => view.refetch()} printing={printable} />}
            {d.kind === "client" && <ClientPortal token={token} data={d} hubFetch={hubFetch} onMessage={(visit) => setMessaging({ visit })} />}
            <footer className="public-foot hub-foot">
              <span><Icon name="lock" size={12} /> Private link{clientName ? ` for ${clientName}` : ""}. Please don't share it.</span>
              <span className="hub-powered">Powered by <BrandMark size={13} /> <strong>Crewtavo</strong></span>
            </footer>
          </>
        )}
      </div>
      {d && messaging && <MessageDialog token={token} company={d.company.name} visit={messaging.visit} hubFetch={hubFetch} onClose={() => setMessaging(null)} />}
    </div>
  );
}

const sizeText = (value: number, unit: string) => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: unit === "ft" ? 1 : 0 })} ${unit}`;

/** The drawings on a quote or invoice: the picture of the map, then what was measured. */
function HubDrawings({ token, drawings }: { token: string; drawings?: HubDrawing[] }) {
  const [broken, setBroken] = useState<string[]>([]);
  if (!drawings?.length) return null;
  return (
    <>
      {drawings.map((d) => {
        const measured = d.sections.filter((s) => s.kind !== "Count" && s.kind !== "Cutout");
        // Already taken out of the areas above them; listed so the client sees what was left out.
        const cutouts = d.sections.filter((s) => s.kind === "Cutout" && Number(s.value) > 0);
        // Roof sections at different pitches each say theirs.
        const mixed = d.roofing_squares ? new Set(d.sections.filter((s) => s.kind === "Area").map((s) => s.pitch ?? d.roof_pitch)).size > 1 : false;
        // Counts read better added up: "Trees: 4" rather than four rows of one.
        const counts = new Map<string, number>();
        for (const s of d.sections.filter((s) => s.kind === "Count")) {
          const label = /^Count \d+$/.test(s.label) ? "Items" : s.label;
          counts.set(label, (counts.get(label) ?? 0) + Number(s.value));
        }
        return (
          <section key={d.id} className="card hub-drawing">
            {d.has_picture && !broken.includes(d.id) && (
              <img src={`/api/hub/${token}/drawings/${d.id}.jpg`} alt={`Map of the measured areas: ${d.title}`} onError={() => setBroken((b) => [...b, d.id])} />
            )}
            <div className="card-pad stack-sm">
              <strong>{d.title}</strong>
              <div className="totals">
                {measured.map((s, i) => <div key={i} className="line"><span>{s.label}{mixed && s.kind === "Area" && s.pitch ? ` (${s.pitch} pitch)` : ""}</span><span className="tabular">{sizeText(s.value, s.unit)}</span></div>)}
                {[...counts].map(([label, n]) => <div key={label} className="line"><span>{label}</span><span className="tabular">{n.toLocaleString()}</span></div>)}
                {cutouts.map((s, i) => <div key={`cut${i}`} className="line muted"><span>{/^Cutout \d+$/.test(s.label) ? "Left out" : `${s.label} (left out)`}</span><span className="tabular">{sizeText(s.value, s.unit)}</span></div>)}
                {measured.filter((s) => s.kind === "Area").length > 1 && <div className="line grand"><span>Total area</span><span className="tabular">{sizeText(d.total_area_sqft, "sq ft")}</span></div>}
                {d.roofing_squares && <div className="line"><span>Roofing squares{mixed ? "" : d.roof_pitch ? ` (${d.roof_pitch} pitch)` : ""}</span><span className="tabular">{Number(d.roofing_squares).toLocaleString()}</span></div>}
              </div>
              <span className="muted small">Measured from aerial imagery{d.imagery ? ` (${d.imagery})` : ""}. Sizes on site may differ slightly.</span>
            </div>
          </section>
        );
      })}
    </>
  );
}

function HubSkeleton() {
  return (
    <div className="skeleton-wrap stack-lg" aria-busy="true" role="status">
      <span className="sr-only">Loading…</span>
      <div className="row"><Skeleton width={40} height={40} radius={10} /><span className="stack-sm" style={{ flex: 1 }}><Skeleton width={160} height={14} /><Skeleton width={220} height={10} /></span></div>
      <div className="card card-pad stack-sm"><Skeleton width={120} height={10} /><Skeleton width="60%" height={24} /><Skeleton width="40%" height={10} /></div>
      <div className="card">{[0, 1, 2].map((i) => <div key={i} className="card-row"><span className="grow stack-sm"><Skeleton width="50%" /><Skeleton width="30%" height={10} /></span><Skeleton width={70} /></div>)}</div>
    </div>
  );
}

function Done({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 28 }}>
      <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
      <h2 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h2>
      {children && <p className="muted" style={{ margin: 0, maxWidth: 440 }}>{children}</p>}
      {action && <div className="no-print" style={{ marginTop: 6 }}>{action}</div>}
    </div>
  );
}

/** A quote: signed, or waiting for the client's answer. One out as a price range is RangeHub, its own page. */
function QuoteHub({ token, data, onChanged, printing, onPrint }: { token: string; data: QuoteView; onChanged: () => void; printing: boolean; onPrint: () => void }) {
  if (data.quote.status === "approved" || data.quote.status === "converted") return <SignedQuote token={token} data={data} printing={printing} onPrint={onPrint} />;
  // A price range that was turned down (marked lost or archived) keeps its exact price off the page.
  if (data.quote.total == null) {
    return (
      <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 28 }}>
        <h2 style={{ fontSize: 20, fontWeight: 800 }}>This estimate isn't open anymore</h2>
        <p className="muted" style={{ margin: 0, maxWidth: 440 }}>Still thinking about it? Send {data.company.name} a message with the button at the top, and they'll get back to you.</p>
      </div>
    );
  }
  return <OpenQuote token={token} data={data} onChanged={onChanged} printing={printing} />;
}

/**
 * A roof estimate sent as a price range: the business's letterhead, the range, the roof as measured,
 * what's in it and what could change it, and "Yes, send someone out", which tells the office to book
 * the visit. Drawn in the estimate template's color, so it matches the paper they sign later. On a
 * computer the details are on the left and the price and buttons on the right; on a phone it's one
 * column (range.module.css). The exact price never reaches this page.
 */
function RangeHub({ token, data, onChanged, onAsk, onPrint }: { token: string; data: QuoteView; onChanged: () => void; onAsk: () => void; onPrint: () => void }) {
  const q = data.quote;
  const range = q.range!;
  const company = data.company;
  const tz = hubZone(company);
  const today = todayIn(tz);
  const template = hubTemplate(data);
  const accent = hubAccent(data);
  const clientName = q.client?.display_name.trim() ?? "";
  const first = clientName ? greetingName(clientName) : null;
  const place = propertyLine(q.property);
  const dates = rangeDates(data, today);
  const roof = measuredRoof(data.drawings);
  const badges = trustBadges(template);
  const credits = credentialLine(template);
  const tagline = template.tagline.trim();
  const license = template.show_license && template.license.trim() ? licenseLine(template.license) : null;
  const phone = company.phone?.trim() || null;
  const email = company.email?.trim() || null;
  const website = company.website?.trim() || null;
  const address = (company.address ?? []).join(", ");
  const roofType = packageLabel(q.package?.name);
  const [previewNote, setPreviewNote] = useState(false);
  const thanks = useRef<HTMLDivElement>(null);
  const accept = useMutation({
    mutationFn: () => hubFetch<{ accepted_at: string }>(`${token}/accept-range`, {}),
    onSuccess: onChanged,
    // Answered already (the office may have marked it after a phone call), or priced on site since
    // the page loaded: show where it is now.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onChanged();
    },
  });
  const accepted = Boolean(range.accepted_at) || accept.isSuccess;
  const yes = () => (data.preview ? setPreviewNote(true) : accept.mutate());
  const ask = () => (data.preview ? setPreviewNote(true) : onAsk());
  // The button they pressed is gone, so their place on the page moves to the thanks.
  useEffect(() => {
    if (accept.isSuccess) thanks.current?.focus();
  }, [accept.isSuccess]);

  return (
    <div
      // "hub" for the Hub's shared parts (its buttons take --brand); the page itself is range.module.css.
      className={cx("hub", styles.page)}
      style={{ ["--brand" as string]: accent.color, ["--on-brand" as string]: accent.on, ["--brand-text" as string]: accent.text }}
    >
      <header className={styles.letterhead}>
        <div className={styles.letterheadInner}>
          <CompanyMark company={company} logoClass={styles.logo} tileClass={styles.tile} />
          <div className={styles.who}>
            <strong>{company.name}</strong>
            {(tagline || license) && (
              <span className={styles.tagline}>
                {tagline}
                {license && <span className={styles.wideOnly}>{tagline ? " · " : ""}{license}</span>}
              </span>
            )}
          </div>
          <div className={cx(styles.headActions, "no-print")}>
            {phone && (
              <a className={styles.headBtn} href={phoneHref(phone)}>
                <Icon name="phone" size={17} />
                <span className={styles.btnText}><span className="sr-only">Call </span>{phone}</span>
              </a>
            )}
            <button type="button" className={styles.headBtn} onClick={onPrint}>
              <Icon name="printer" size={17} />
              <span className={styles.btnText}>Print<span className="sr-only"> or save as PDF</span></span>
            </button>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        {data.preview && <div className="callout callout-info no-print"><Icon name="eye" size={18} /><div className="grow">Preview: this is what your client sees.</div></div>}
        {data.home && <a className="hub-back no-print" href={data.home}><Icon name="chevronLeft" size={16} />Your account</a>}

        <section className={styles.intro}>
          <div className={styles.title}>
            <span className={styles.eyebrow}>Roof estimate · No. {q.number}</span>
            <h1>{first ? `Your new roof, ${first}` : "Your new roof"}</h1>
          </div>
          {(clientName || place || dates.sent || dates.goodUntil) && (
            <div className={styles.meta}>
              {(clientName || place) && (
                <div>
                  <span className={styles.metaLabel}>Prepared for</span>
                  {clientName && <strong>{clientName}</strong>}
                  {place && <span>{place}</span>}
                </div>
              )}
              {(dates.sent || dates.goodUntil) && (
                <div>
                  <span className={styles.metaLabel}>{dates.sent ? "Sent" : "Good until"}</span>
                  <strong>{dates.sent ?? dates.goodUntil}</strong>
                  {dates.sent && dates.goodUntil && <span>{dates.expired ? "Was good until" : "Good until"} {dates.goodUntil}</span>}
                </div>
              )}
            </div>
          )}
        </section>

        <div className={styles.layout}>
          <div className={styles.details}>
            {roof && <RoofMeasured token={token} roof={roof} included={range.included} timeZone={tz} today={today} />}
            {(range.included.length > 0 || range.maybe.length > 0) && (
              <div className={styles.lists}>
                {range.included.length > 0 && (
                  <section className={cx(styles.card, styles.included)}>
                    <h2>What's included</h2>
                    <ul className={styles.checks}>
                      {range.included.map((item) => (
                        <li key={item}><span className={styles.tick}><Icon name="check" size={13} strokeWidth={3.5} /></span><span>{item}</span></li>
                      ))}
                    </ul>
                  </section>
                )}
                {range.maybe.length > 0 && (
                  <section className={cx(styles.card, styles.maybe)}>
                    <h2>If we find something on the roof</h2>
                    <p className={styles.sub}>Only if we find it, and only with your OK.</p>
                    <ul className={styles.rows}>
                      {range.maybe.map((m) => <li key={m.name}><span>{m.name}</span><strong>{maybePrice(m)}</strong></li>)}
                    </ul>
                  </section>
                )}
              </div>
            )}
          </div>

          <div className={styles.side}>
            <section className={styles.priceCard} aria-label="Price">
              <div className={cx(styles.card, styles.priceTop)}>
                <div className={styles.bar} />
                <div className={styles.priceBody}>
                  <div className={styles.priceHead}>
                    <span className={styles.eyebrow}>Estimated price</span>
                    <p className={styles.amount}>
                      {formatMoney(range.low)} <span className={styles.dash} aria-hidden="true">–</span><span className="sr-only">to</span> {formatMoney(range.high)}
                    </p>
                    {roofType && <span className={styles.package}>{roofType}</span>}
                  </div>
                  <p className={styles.why}>The exact price is set when we look at your roof in person. It only moves toward the top if we find something hidden, like soft wood under the shingles.</p>
                </div>
              </div>

              <div className={cx(styles.card, styles.next, !accepted && "no-print")} data-done={accepted || undefined}>
                {accepted ? (
                  <div ref={thanks} tabIndex={-1} className={styles.thanks}>
                    <span className={styles.thanksMark}><Icon name="check" size={22} strokeWidth={3} /></span>
                    <strong>{first ? `Thanks, ${first}. We'll call you soon.` : "Thanks. We'll call you soon."}</strong>
                    <p>We'll set up a time to look at your roof, usually within one business day.</p>
                    {!data.preview && <button type="button" className={cx(styles.noteBtn, "no-print")} onClick={onAsk}>Send {company.name} a note</button>}
                  </div>
                ) : (
                  <>
                    <h2 className={styles.nextTitle}>Ready for the next step?</h2>
                    <p className={styles.nextText}>Say yes and we'll call to set up a time to look at your roof. You'll see the exact price and sign only if you're happy with it.</p>
                    {dates.expired && dates.goodUntil && (
                      <div className="callout callout-warning"><Icon name="clock" size={18} /><div className="grow">This range was good until {dates.goodUntil}. You can still say yes, and we'll confirm the price.</div></div>
                    )}
                    <Button variant="primary" size="lg" block className={styles.yes} loading={accept.isPending} onClick={yes}>Yes, send someone out</Button>
                    <Button size="lg" block className={styles.ask} onClick={ask}>I have a question</Button>
                    {previewNote && <div className="callout callout-info" role="status"><Icon name="eye" size={18} /><div className="grow">This is a preview, so nothing was sent. Your client's own link sends it.</div></div>}
                    <FormError error={accept.error} />
                    <span className={styles.fine}>Saying yes doesn't commit you to anything.</span>
                  </>
                )}
              </div>
            </section>

            {(badges.length > 0 || phone || email) && (
              <div className={styles.trust}>
                {badges.length > 0 && (
                  <ul className={styles.badges}>
                    {badges.map((b) => (
                      <li key={b.kind} className={styles.badge}>
                        <BadgeIcon kind={b.kind} />
                        <span className={styles.badgeText}><strong>{b.title}</strong> <span className={styles.badgeDetail}>{b.detail}</span></span>
                      </li>
                    ))}
                  </ul>
                )}
                {(phone || email) && (
                  <div className={styles.contact}>
                    <p>
                      <strong>Questions?</strong>{" "}
                      {phone && <>Call <a href={phoneHref(phone)}>{phone}</a></>}
                      {email && <>{phone ? " or email " : "Email "}<a href={`mailto:${email}`}>{email}</a></>}.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerWho}>
            <strong>{company.name}</strong>
            {(address || website) && (
              <span>
                {address}
                {address && website ? " · " : ""}
                {website && <a href={websiteHref(website)} target="_blank" rel="noreferrer">{websiteLabel(website)}</a>}
              </span>
            )}
            {credits && <span>{credits}</span>}
          </div>
          <span className={styles.private}>A private link{clientName ? ` for ${clientName}` : ""}. Powered by Crewtavo.</span>
        </div>
      </footer>
    </div>
  );
}

/** "Your roof, measured": the picture from the drawing, the roof's size, area and pitch as tiles, and when it was measured. */
function RoofMeasured({ token, roof, included, timeZone, today }: { token: string; roof: MeasuredRoof; included: string[]; timeZone: string; today: string }) {
  const [broken, setBroken] = useState<string[]>([]);
  const pictures = roof.drawings.filter((d) => d.has_picture && !broken.includes(d.id));
  // The imagery's credit, which the photo's provider asks for wherever it's shown.
  const credits = [...new Set(roof.drawings.map((d) => d.imagery).filter((c): c is string => Boolean(c)))];
  return (
    <section className={cx(styles.card, styles.roof)}>
      {pictures.length > 0 && (
        <div className={styles.roofPictures}>
          {pictures.map((d) => (
            <img key={d.id} src={`/api/hub/${token}/drawings/${d.id}.jpg`} alt="Your roof from above, with the measured parts outlined" onError={() => setBroken((b) => [...b, d.id])} />
          ))}
        </div>
      )}
      <div className={styles.roofBody}>
        <h2>Your roof, measured</h2>
        <dl className={styles.stats}>
          {roofTiles(roof, included).map((t) => <div key={t.label} className={styles.stat}><dt>{t.label}</dt><dd>{t.value}</dd></div>)}
        </dl>
        <p className={styles.roofNote}>{measuredLine(roof, timeZone, today)}</p>
        {credits.length > 0 && <p className={styles.credit}>{credits.join(" · ")}</p>}
      </div>
    </section>
  );
}

/** A shield (licensed) or a house (insured), each with a check. */
function BadgeIcon({ kind }: { kind: TrustBadge["kind"] }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "license" ? <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /> : <><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></>}
      <path d={kind === "license" ? "m9 12 2 2 4-4" : "m9 15 2 2 4-4"} />
    </svg>
  );
}

/** A signed (or approved) quote: the signed estimate itself, on the business's template, to keep or print. */
function SignedQuote({ token, data, printing, onPrint }: { token: string; data: QuoteView; printing: boolean; onPrint: () => void }) {
  const q = data.quote;
  const tz = hubZone(data.company);
  const doc = { template: hubTemplate(data), company: hubLetterhead(data.company), data: quoteDocument(data) };
  const when = q.approval?.signed_at ?? q.approved_at;
  const signed = Boolean(q.approval?.signature) && q.approval?.method !== "manual";
  return (
    <>
      <Done
        title={`${signed ? "Signed" : "Approved"}${when ? ` on ${formatDate(dateIn(when, tz))}` : ""}`}
        action={<Button icon="printer" onClick={onPrint}>Print or save PDF</Button>}
      >
        Thank you! {data.company.name} will be in touch to schedule the work.{Number(q.deposit_amount) > 0 ? " You'll receive an invoice for the deposit." : ""}
      </Done>
      <section className="hub-document" aria-label={`${signed ? "Signed estimate" : "Estimate"} #${q.number}`}>
        <DocumentSheet {...doc} />
      </section>
      <HubDrawings token={token} drawings={data.drawings} />
      {printing && <PrintableDocument {...doc} />}
    </>
  );
}

function OpenQuote({ token, data, onChanged, printing }: { token: string; data: QuoteView; onChanged: () => void; printing: boolean }) {
  const q = data.quote;
  const tz = hubZone(data.company);
  // Valid through the end of that day where the company is, not in UTC.
  const expired = Boolean(q.valid_until && q.valid_until < todayIn(tz));
  const open = ["sent", "changes_requested"].includes(q.status) && !data.preview;
  const [chosen, setChosen] = useState<string[]>(() => q.lines.filter((l) => l.optional && l.selected).map((l) => l.id!));
  const [name, setName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [changes, setChanges] = useState("");
  const [mode, setMode] = useState<"approve" | "changes">("approve");
  const approve = useMutation({ mutationFn: () => hubFetch(`${token}/approve`, { name: name.trim(), selected_line_ids: chosen, signature: signature ?? undefined }), onSuccess: onChanged });
  const requestChanges = useMutation({ mutationFn: () => hubFetch(`${token}/request-changes`, { message: changes.trim() }), onSuccess: onChanged });

  const included = (l: HubLine) => !l.optional || chosen.includes(l.id!);
  const groupOf = (l: HubLine) => (l.optional && l.option_group ? l.option_group : null);
  const tiers = optionLabels(q.lines);
  // Picking one choice in a group drops the others in it.
  const choose = (l: HubLine, on: boolean) => {
    const group = groupOf(l);
    if (group) setChosen([...chosen.filter((id) => groupOf(q.lines.find((x) => x.id === id) ?? l) !== group), l.id!]);
    else setChosen(on ? [...chosen, l.id!] : chosen.filter((x) => x !== l.id));
  };
  const firstOf = (l: HubLine, i: number) => groupOf(l) !== null && !q.lines.slice(0, i).some((x) => groupOf(x) === groupOf(l));
  // The database's own math (to the cent), so the total the client approves is the one saved. A
  // percent code follows the options the client picks, as it does on the saved quote.
  const { subtotal, discount, tax, total } = quoteTotals(q.lines.map((l) => ({ ...l, selected: included(l) })), { taxRate: q.tax_rate, discountAmount: q.discount_amount ?? 0, promo: q.promo });
  const deposit = Number(q.deposit_amount ?? 0);

  return (
    <>
      <section className="card card-pad stack-sm">
        <span className="muted">Quote #{q.number}{q.client ? ` for ${q.client.display_name}` : ""}</span>
        <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{q.title}</h1>
        {q.property && <span className="muted">{q.property.line1}{q.property.city ? `, ${q.property.city}` : ""}</span>}
        {q.message && <p className="pre-wrap" style={{ margin: "8px 0 0" }}>{q.message}</p>}
      </section>

      <HubDrawings token={token} drawings={data.drawings} />

      <section className="card">
        {q.lines.map((l, i) => (
          <Fragment key={l.id}>
          {firstOf(l, i) && <div className="card-row hub-choice-head"><strong>{l.option_group}</strong><span className="muted small">{open ? "Pick one" : "One of these"}</span></div>}
          <div className="card-row" style={{ alignItems: "flex-start", opacity: included(l) ? 1 : 0.6, transition: "opacity 200ms" }}>
            {l.optional && (
              <input type={groupOf(l) ? "radio" : "checkbox"} name={groupOf(l) ? `choice-${groupOf(l)}` : undefined} aria-label={groupOf(l) ? `Choose ${l.name}` : `Add ${l.name}`} checked={chosen.includes(l.id!)} disabled={!open} onChange={(e) => choose(l, e.target.checked)} style={{ marginTop: 4, width: 18, height: 18 }} />
            )}
            <div className="grow">
              <strong>{l.name}</strong>
              {l.optional && <span className="chip chip-blue" style={{ marginLeft: 6 }}>{groupOf(l) ? tiers.get(l.id!) ?? "Choice" : "Optional"}</span>}
              {l.description && <div className="muted text-sm pre-wrap">{l.description}</div>}
              <div className="muted small">{Number(l.quantity).toLocaleString()} {l.unit} × {formatMoneyCents(l.unit_price)}</div>
            </div>
            <strong className="tabular">{formatMoneyCents(lineTotal(l.quantity, l.unit_price))}</strong>
          </div>
          </Fragment>
        ))}
        <div className="card-pad totals" style={{ borderTop: "1px solid var(--divider)" }}>
          <div className="line"><span>Subtotal</span><span>{formatMoneyCents(subtotal)}</span></div>
          <HubDiscount token={token} promo={q.promo} discount={discount} canChange={open && !data.preview} onChanged={onChanged} />
          {tax > 0 && <div className="line"><span>Tax</span><span>{formatMoneyCents(tax)}</span></div>}
          <div className="line grand" style={{ fontSize: 22 }}><span>Total</span><span>{formatMoneyCents(total)}</span></div>
          {deposit > 0 && <div className="line"><span>Deposit to book</span><span>{formatMoneyCents(deposit)}</span></div>}
          {q.valid_until && <div className="line"><span>Valid until</span><span className={expired ? "text-danger" : undefined}>{formatDate(q.valid_until)}</span></div>}
        </div>
      </section>

      {requestChanges.isSuccess ? (
        <Done title="Request sent">{data.company.name} will review your notes and follow up with an updated quote.</Done>
      ) : open ? (
        <section className="card card-pad stack no-print">
          {expired && <div className="callout callout-warning"><Icon name="clock" size={18} /><div className="grow">This quote's valid-until date has passed. You can still approve it, and {data.company.name} will confirm the price.</div></div>}
          {q.status === "changes_requested" && <div className="callout"><Icon name="messages" size={18} /><div className="grow">You've asked for changes. {data.company.name} may send an updated quote, or you can approve this one as it is.</div></div>}
          <div className="segmented" role="group" aria-label="Your response" style={{ justifySelf: "start" }}>
            <button type="button" aria-pressed={mode === "approve"} onClick={() => setMode("approve")}>Approve</button>
            <button type="button" aria-pressed={mode === "changes"} onClick={() => setMode("changes")}>Request changes</button>
          </div>
          {mode === "approve" ? (
            <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); approve.mutate(); }}>
              <label className="field">Your full name<input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name" /></label>
              <div className="field">
                <span>Your signature</span>
                <SignaturePad value={signature} onChange={setSignature} label="Sign with your finger or mouse" />
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                I approve this {q.change_order_for ? "change order" : "quote"} for {formatMoneyCents(total)} and authorize {data.company.name} to do {q.change_order_for ? "this added work" : "the work"}.
              </label>
              <FormError error={approve.error} />
              <Button type="submit" variant="primary" size="lg" icon="check" loading={approve.isPending} disabled={!agree || name.trim().length < 2 || !signature}>{q.change_order_for ? "Approve change order" : "Approve quote"}</Button>
            </form>
          ) : (
            <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); requestChanges.mutate(); }}>
              <label className="field">What would you like changed?<textarea className="textarea" value={changes} onChange={(e) => setChanges(e.target.value)} required minLength={3} maxLength={2000} placeholder="Could you add the side walkway? Can we start after the 15th?" /></label>
              <FormError error={requestChanges.error} />
              <Button type="submit" size="lg" icon="send" loading={requestChanges.isPending} disabled={changes.trim().length < 3}>Send request</Button>
            </form>
          )}
        </section>
      ) : !data.preview ? (
        <div className="card card-pad muted">This quote is no longer open. Contact {data.company.name} if you have questions.</div>
      ) : null}

      {/* What prints: the estimate on the business's template, with the options the client has picked. */}
      {printing && <PrintableDocument template={hubTemplate(data)} company={hubLetterhead(data.company)} data={quoteDocument(data, chosen)} />}
    </>
  );
}

function InvoiceHub({ token, data, onChanged, printing }: { token: string; data: InvoiceView; onChanged: () => void; printing: boolean }) {
  const inv = data.invoice;
  const [params] = useSearchParams();
  const balance = Number(inv.balance_due);
  const [tipChoice, setTipChoice] = useState<number | "custom">(0);
  const [customTip, setCustomTip] = useState("");
  const tip = !data.tips ? 0 : tipChoice === "custom" ? Math.max(Math.round(Number(customTip) * 100) / 100 || 0, 0) : Math.round(balance * tipChoice) / 100;
  const pay = useMutation({
    mutationFn: () => hubFetch<{ url: string }>(`${token}/pay`, { tip }),
    onSuccess: (res) => window.location.assign(res.url),
  });
  const tz = hubZone(data.company);
  // Late the day after it's due where the company is (the same day the invoice turns overdue).
  const late = inv.due_on && balance > 0 && inv.due_on < todayIn(tz);
  return (
    <>
      <section className="card card-pad stack-sm">
        <span className="muted">Invoice #{inv.number}{inv.client ? ` for ${inv.client.display_name}` : ""}{inv.subject ? ` · ${inv.subject}` : ""}</span>
        <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" }}>{balance > 0 ? `${formatMoneyCents(balance)} due` : "Paid in full"}</h1>
        <span className={late ? "text-danger strong" : "muted"}>Issued {formatDate(inv.issued_on)}{inv.due_on ? ` · due ${formatDate(inv.due_on)}` : " · due on receipt"}</span>
      </section>
      {params.get("paid") === "1" && <Done title="Thank you!">Your payment is processing. You'll get a receipt by email.</Done>}
      <HubDrawings token={token} drawings={data.drawings} />
      <section className="card">
        {inv.lines.map((l, i) => (
          <div key={i} className="card-row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <strong>{l.name}</strong>
              {l.description && <div className="muted text-sm pre-wrap">{l.description}</div>}
              <div className="muted small">{Number(l.quantity).toLocaleString()} {l.unit} × {formatMoneyCents(l.unit_price)}</div>
            </div>
            <span className="tabular">{formatMoneyCents(lineTotal(l.quantity, l.unit_price))}</span>
          </div>
        ))}
        <div className="card-pad totals" style={{ borderTop: "1px solid var(--divider)" }}>
          <div className="line"><span>Subtotal</span><span>{formatMoneyCents(inv.subtotal)}</span></div>
          <HubDiscount
            token={token}
            promo={inv.promo}
            discount={Math.min(Number(inv.discount_amount), Math.max(Number(inv.subtotal), 0))}
            canChange={!data.preview && !data.from_stripe && balance > 0 && inv.payments.length === 0}
            onChanged={onChanged}
          />
          {Number(inv.tax_amount) > 0 && <div className="line"><span>Tax</span><span>{formatMoneyCents(inv.tax_amount)}</span></div>}
          <div className="line"><span>Total</span><span>{formatMoneyCents(inv.total)}</span></div>
          {Number(inv.retainage_amount) > 0 && <div className="line"><span>Retainage (billed later)</span><span>−{formatMoneyCents(inv.retainage_amount)}</span></div>}
          {inv.payments.map((p, i) =>
            Number(p.amount) > 0 ? (
              <div key={i} className="line"><span>Paid {formatDate(dateIn(p.received_at, tz))}</span><span>−{formatMoneyCents(p.amount)}</span></div>
            ) : (
              <div key={i} className="line"><span>Refunded {formatDate(dateIn(p.received_at, tz))}</span><span>+{formatMoneyCents(-Number(p.amount))}</span></div>
            ),
          )}
          <div className="line grand" style={{ fontSize: 20 }}><span>Balance due</span><span>{formatMoneyCents(balance)}</span></div>
        </div>
      </section>
      {inv.notes && <section className="card card-pad pre-wrap">{inv.notes}</section>}
      {balance > 0 && !data.preview && (
        data.processing ? (
          <div className="card card-pad muted no-print" role="status">Your bank payment is on its way. It usually takes a few business days to clear, and this page updates when it does.</div>
        ) : data.can_pay ? (
          <div className="stack no-print">
            {data.tips && (
              <section className="card card-pad stack-sm">
                <strong>Add a tip for the crew?</strong>
                <div className="segmented" role="group" aria-label="Tip">
                  {[0, 10, 15, 20].map((pct) => (
                    <button key={pct} type="button" aria-pressed={tipChoice === pct} onClick={() => setTipChoice(pct)}>{pct ? `${pct}%` : "No tip"}</button>
                  ))}
                  <button type="button" aria-pressed={tipChoice === "custom"} onClick={() => setTipChoice("custom")}>Other</button>
                </div>
                {tipChoice === "custom" && (
                  <span className="input-group" style={{ maxWidth: 180 }}><span className="addon">$</span><input className="input" style={{ paddingLeft: 22 }} inputMode="decimal" aria-label="Tip amount" value={customTip} onChange={(e) => setCustomTip(e.target.value.replace(/[^0-9.]/g, ""))} autoFocus /></span>
                )}
                {tip > 0 && <span className="muted small">{formatMoneyCents(tip)} tip. Thank you!</span>}
              </section>
            )}
            <Button variant="primary" size="lg" icon="lock" loading={pay.isPending} onClick={() => pay.mutate()}>Pay {formatMoneyCents(balance + tip)} by card or bank</Button>
          </div>
        ) : (
          <div className="card card-pad muted">To pay, contact {data.company.name}{data.company.phone ? ` at ${data.company.phone}` : ""}.</div>
        )
      )}
      <FormError error={pay.error} />
      {/* What prints: the invoice on the business's template. */}
      {printing && <PrintableDocument template={hubTemplate(data)} company={hubLetterhead(data.company)} data={invoiceDocument(data)} />}
    </>
  );
}

/** The discount line: an applied promo code (removable while it can change), or a box to enter one. */
function HubDiscount({ token, promo, discount, canChange, onChanged }: { token: string; promo: HubPromoInfo; discount: number; canChange: boolean; onChanged: () => void }) {
  const [entering, setEntering] = useState(false);
  const [code, setCode] = useState("");
  const apply = useMutation({
    mutationFn: () => hubFetch(`${token}/promo`, { code: code.trim() }),
    onSuccess: () => {
      setEntering(false);
      setCode("");
      onChanged();
    },
  });
  const remove = useMutation({ mutationFn: () => hubFetch(`${token}/promo`, undefined, "DELETE"), onSuccess: onChanged });

  if (promo) {
    return (
      <div className="line" style={{ alignItems: "flex-start" }}>
        <span className="promo-applied">
          <span className="promo-code">{promo.code}</span>
          <span className="muted small">{promo.description ?? (promo.kind === "percent" ? `${Number(promo.value)}% off` : "Discount")}</span>
          {canChange && <button type="button" className="btn btn-sm btn-ghost no-print" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove</button>}
        </span>
        <span>−{formatMoneyCents(discount)}</span>
      </div>
    );
  }
  return (
    <>
      {discount > 0 && <div className="line"><span>Discount</span><span>−{formatMoneyCents(discount)}</span></div>}
      {canChange && (
        entering ? (
          <form className="promo-entry no-print" onSubmit={(e: FormEvent) => { e.preventDefault(); if (code.trim()) apply.mutate(); }}>
            <input className="input mono grow" aria-label="Promo code" placeholder="Promo code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} autoFocus autoCapitalize="characters" />
            <Button type="submit" variant="primary" loading={apply.isPending} disabled={!code.trim()}>Apply</Button>
          </form>
        ) : (
          <div className="line no-print"><button type="button" className="btn btn-sm btn-ghost" onClick={() => setEntering(true)}><Icon name="tag" size={14} />Have a promo code?</button></div>
        )
      )}
      {apply.error && <FormError error={apply.error} />}
    </>
  );
}
