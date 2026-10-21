/**
 * Client Hub (the customer portal): what a client sees from a link. No account needed; the link
 * is signed and expires.
 *   client  - their account: what's waiting on them, the next visit, history, request work
 *   quote   - choose optional items, approve with their name, or ask for changes
 *   invoice - view and pay (with an optional tip)
 * Add ?print=1 to print or save a PDF.
 */
import { lineTotal, quoteTotals } from "@crewtavo/core/money";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { BrandMark } from "@/components/shell/BrandMark";
import { ApiError } from "@/lib/api";
import { dateIn, formatDate, formatMoneyCents, todayIn } from "@/lib/format";
import { ClientPortal, hubZone, MessageDialog, type ClientView, type PortalVisit } from "./ClientPortal";
import { SignaturePad } from "../field/SignaturePad";

interface HubLine {
  id?: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  taxable?: boolean;
  optional?: boolean;
  selected?: boolean;
}
interface Company { name: string; phone: string | null; email: string | null; website: string | null; timezone?: string | null; branding?: { color?: string } | null; logo?: string | null }
/** A map drawing the office chose to show the client, with the sizes measured on it. */
interface HubDrawing {
  id: string;
  title: string;
  has_picture: boolean;
  sections: Array<{ label: string; kind: string; value: number; unit: string; pitch?: string }>;
  total_area_sqft: number;
  total_length_ft: number;
  roofing_squares: number | null;
  roof_pitch: string | null;
  imagery: string | null;
}
interface QuoteView {
  kind: "quote";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: Company;
  quote: { id: string; number: number; status: string; title: string; message: string | null; change_order_for?: string | null; discount_amount: number; promo: HubPromoInfo; tax_rate: number; deposit_amount: number; valid_until: string | null; approved_at: string | null; client: { display_name: string } | null; property: { line1: string; city: string | null } | null; lines: HubLine[] };
}
interface InvoiceView {
  kind: "invoice";
  drawings?: HubDrawing[];
  preview?: boolean;
  home: string | null;
  company: Company;
  can_pay: boolean;
  /** A bank payment through Stripe is on its way; asking again would charge twice. */
  processing?: boolean;
  /** Made in Stripe, so it's paid exactly as billed there (no promo codes). */
  from_stripe?: boolean;
  tips: boolean;
  invoice: { id: string; number: number; status: string; subject: string | null; notes: string | null; issued_on: string; due_on: string | null; subtotal: number; discount_amount: number; tax_amount: number; total: number; retainage_amount: number; amount_paid: number; balance_due: number; promo: HubPromoInfo; client: { display_name: string } | null; lines: HubLine[]; payments: Array<{ amount: number; tip_amount: number; received_at: string }> };
}
type View = QuoteView | InvoiceView | ClientView;
type HubPromoInfo = { code: string; kind: string; value: number; description: string | null } | null;

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

/** "Acme Paving" -> "AP". */
const monogram = (name: string) => (name.split(/\s+/).filter((w) => /^[A-Za-z0-9]/.test(w)).slice(0, 2).map((w) => w[0]).join("") || name.slice(0, 2)).toUpperCase();

/** The company's logo, or its initials on its color when it has none (or the logo won't load). */
function CompanyMark({ company }: { company: Company }) {
  const [broken, setBroken] = useState(false);
  if (company.logo && !broken) return <img className="hub-logo" src={company.logo} alt="" onError={() => setBroken(true)} />;
  return <span className="tile" aria-hidden="true">{monogram(company.name)}</span>;
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

  useEffect(() => {
    if (view.data) document.title = `${view.data.kind === "quote" ? `Quote #${view.data.quote.number}` : view.data.kind === "invoice" ? `Invoice #${view.data.invoice.number}` : "Your account"} · ${view.data.company.name}`;
    if (view.data && printing) setTimeout(() => window.print(), 500);
  }, [view.data, printing]);

  const d = view.data;
  const brand = d?.company.branding?.color || "#3b7d23";
  const preview = Boolean(d && "preview" in d && d.preview);
  const home = d && d.kind !== "client" ? d.home : null;
  const clientName = d ? (d.kind === "client" ? d.client.name : d.kind === "quote" ? d.quote.client?.display_name : d.invoice.client?.display_name) : null;

  return (
    <div className="public-page hub" data-printing={printing || undefined} style={{ ["--brand" as string]: brand, ["--on-brand" as string]: inkOn(brand) }}>
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
            {d.kind !== "client" && <button type="button" className="hub-icon-btn no-print" onClick={() => window.print()} aria-label="Print or save as PDF"><Icon name="printer" size={19} /></button>}
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
            {d.kind === "quote" && <QuoteHub token={token} data={d} onChanged={() => view.refetch()} />}
            {d.kind === "invoice" && <InvoiceHub token={token} data={d} onChanged={() => view.refetch()} />}
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

function Done({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 28 }}>
      <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
      <h2 style={{ fontSize: 20, fontWeight: 800 }}>{title}</h2>
      {children && <p className="muted" style={{ margin: 0, maxWidth: 440 }}>{children}</p>}
    </div>
  );
}

function QuoteHub({ token, data, onChanged }: { token: string; data: QuoteView; onChanged: () => void }) {
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
  // The database's own math (to the cent), so the total the client approves is the one saved. A
  // percent code follows the options the client picks, as it does on the saved quote.
  const { subtotal, discount, tax, total } = quoteTotals(q.lines.map((l) => ({ ...l, selected: included(l) })), { taxRate: q.tax_rate, discountAmount: q.discount_amount, promo: q.promo });

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
        {q.lines.map((l) => (
          <div key={l.id} className="card-row" style={{ alignItems: "flex-start", opacity: included(l) ? 1 : 0.6, transition: "opacity 200ms" }}>
            {l.optional && (
              <input type="checkbox" aria-label={`Add ${l.name}`} checked={chosen.includes(l.id!)} disabled={!open} onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id!] : chosen.filter((x) => x !== l.id))} style={{ marginTop: 4, width: 18, height: 18 }} />
            )}
            <div className="grow">
              <strong>{l.name}</strong>
              {l.optional && <span className="chip chip-blue" style={{ marginLeft: 6 }}>Optional</span>}
              {l.description && <div className="muted text-sm pre-wrap">{l.description}</div>}
              <div className="muted small">{Number(l.quantity).toLocaleString()} {l.unit} × {formatMoneyCents(l.unit_price)}</div>
            </div>
            <strong className="tabular">{formatMoneyCents(lineTotal(l.quantity, l.unit_price))}</strong>
          </div>
        ))}
        <div className="card-pad totals" style={{ borderTop: "1px solid var(--divider)" }}>
          <div className="line"><span>Subtotal</span><span>{formatMoneyCents(subtotal)}</span></div>
          <HubDiscount token={token} promo={q.promo} discount={discount} canChange={open && !data.preview} onChanged={onChanged} />
          {tax > 0 && <div className="line"><span>Tax</span><span>{formatMoneyCents(tax)}</span></div>}
          <div className="line grand" style={{ fontSize: 22 }}><span>Total</span><span>{formatMoneyCents(total)}</span></div>
          {Number(q.deposit_amount) > 0 && <div className="line"><span>Deposit to book</span><span>{formatMoneyCents(q.deposit_amount)}</span></div>}
          {q.valid_until && <div className="line"><span>Valid until</span><span className={expired ? "text-danger" : undefined}>{formatDate(q.valid_until)}</span></div>}
        </div>
      </section>

      {q.status === "approved" || q.status === "converted" ? (
        <Done title={`Approved${q.approved_at ? ` on ${formatDate(dateIn(q.approved_at, tz))}` : ""}`}>Thank you! {data.company.name} will be in touch to schedule the work.{Number(q.deposit_amount) > 0 ? " You'll receive an invoice for the deposit." : ""}</Done>
      ) : requestChanges.isSuccess ? (
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
    </>
  );
}

function InvoiceHub({ token, data, onChanged }: { token: string; data: InvoiceView; onChanged: () => void }) {
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
