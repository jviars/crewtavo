/**
 * The estimate or invoice as a PDF: the business's template drawn with react-pdf's own pieces, for
 * printing and saving. A PDF prints on the whole sheet, so the business's own letterhead cut full
 * width reaches the paper's edges, with no browser header or footer (Safari's can't be turned off).
 *
 * It draws what EstimateDocument draws, from the same data and helpers. Sizes are in the CSS px of
 * EstimateDocument's 816 × 1056 px page, turned into points by px(), so the two look the same.
 * react-pdf decides the pages itself: the letterhead on the first, the running header on the rest,
 * the footer and "Page 2 of 3" on every one.
 *
 * Two copies of the layout: a change to what the pages show or how goes here and in EstimateDocument
 * (its .tsx and .module.css) both. The tests check the words and where key things land, not that the
 * two look alike.
 */
import { companySignatureLabel, documentColor, letterheadSrc, ownLetterhead, printsFullSheet, type LetterheadPicture, type TemplateSettings } from "@crewtavo/core/documents";
import { Document, Image, Page, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ComponentProps, ReactNode } from "react";
// The pages' own measurements, words and contract blocks (apps/web), so the PDF is drawn as they are.
import { contractBlocks, type ContractBlock } from "../../../web/src/lib/html";
import { BODY_INSET, BODY_PAD_BOTTOM, BODY_PAD_TOP, PAGE_MARGIN, PAGE_WIDTH } from "../../../web/src/features/documents/paper";
import type { DocumentCompany, DocumentData, DocumentLine, DocumentOption, DocumentSection, DocumentSignature } from "../../../web/src/features/documents/types";
import { initials, inkOn, licenseLine, longDate, quantityLabel, readableOnWhite, shortDate, websiteLabel } from "../../../web/src/features/documents/words";
import { richText } from "./richText";

/** A picture as it goes in the PDF (a PNG or JPEG's bytes), with its size in pixels. */
export interface PdfPicture {
  src: { data: Buffer; format: "png" | "jpg" };
  width: number;
  height: number;
}

/** Each picture the document uses (its URL as the document has it), loaded; null for one that didn't load. */
export type PdfPictures = ReadonlyMap<string, PdfPicture | null>;

export interface DocumentPdfProps {
  template: TemplateSettings;
  company: DocumentCompany;
  data: DocumentData;
  pictures: PdfPictures;
  /** The registered fonts for the modern look, each tried in turn for a letter (services/documentPdf.ts); the classic look is Times first. */
  font: string[];
  /** The business's currency ("USD"): money shows with its symbol, the numbers as in the US. */
  currency: string;
  /** Where the person printing is ("America/New_York"): the day beside a signature is theirs, as on the page. */
  timeZone?: string;
}

/** CSS px (96 an inch) in points (72). */
const px = (n: number) => n * 0.75;

const INK = "#0f2a35";
const TEXT_2 = "#4e6169";
const TEXT_3 = "#5f6f76";
const RULE = "#ecebe6";
const ROW = "#f1f0ec";
const STRIP = "#f6f5f1";
const CELL = "#dcdbd5";

/** As in EstimateDocument: between the body's parts, above a section's title and between its paragraphs. */
const GAP = 20;
const TITLE_GAP = 18;
const CLAUSE_GAP = 8;
/** A blank line between paragraphs of the notes and of the template's terms. */
const NOTES_LINE = 19.2;
const TERMS_LINE = 17.6;

type TextStyle = ComponentProps<typeof Text>["style"];
const styles = (style: TextStyle): Style[] => (Array.isArray(style) ? (style as Style[]) : style ? [style as Style] : []);

/**
 * Words at `size` CSS px, their lines `lh` apart (1.45 of the size, the pages' own). Each text says
 * its size itself: react-pdf reads a line height against the size on the same text, else against its
 * own default (18 pt), and it leaves a box that's on every page (fixed: the running header, the
 * footer) off altogether when a line height reaches it. So those two use plain Text, no line height.
 */
function T({ size = 12.5, lh = 1.45, style, ...props }: ComponentProps<typeof Text> & { size?: number; lh?: number }) {
  return <Text {...props} style={[{ fontSize: px(size), lineHeight: lh }, ...styles(style)]} />;
}

/** Each picture a document draws, by the URL it has in the document: what to load before drawing it. */
export function documentPictures(template: TemplateSettings, company: DocumentCompany, data: DocumentData): string[] {
  const own = ownLetterhead(template);
  const urls = [
    own.header && letterheadSrc(own.header.path),
    own.footer && letterheadSrc(own.footer.path),
    !own.header && company.logo,
    ...(data.options ?? []).map((o) => o.picture?.src),
    data.signatures?.customer?.image,
    data.signatures?.company?.image,
    ...(data.contract?.sections ?? []).map((s) => s.initialed?.image),
  ];
  return [...new Set(urls.filter((u): u is string => typeof u === "string" && u.length > 0))];
}

/** Paragraphs of plain text: split at blank lines, line breaks in each kept. */
const paragraphs = (text: string | null | undefined) =>
  (text ?? "")
    .trim()
    .split(/\n[ \t]*\n\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

/** How a document looks: its colors and its font. */
interface Look {
  color: string;
  onColor: string;
  textColor: string;
  font: string[];
  /** The minus sign: Times (the classic look) has no "−", so it's a hyphen there. */
  minus: string;
  /** Money in the business's currency, as the pages show it (lib/format formatMoneyCents). */
  money: Intl.NumberFormat;  /** The time zone the dates beside signatures are in. */
  timeZone?: string;
}

/** Where things sit on the sheet, in CSS px. */
interface Geometry {
  fullSheet: boolean;
  /** The content box's margin from the paper's edge: 0.4 in, or none on the whole sheet. */
  box: number;
  boxWidth: number;
  /** The space inside the content box before the words: the template's 6 px, or the margin and that on the whole sheet. */
  pad: number;
  /** The room the running header and the footer take. */
  running: number;
  footer: number;
}

/** react-pdf's own line spacing, 1.2 of the size: the running header's and the footer's. */
const PLAIN_LINE = 1.2;

function geometryOf(template: TemplateSettings, fullSheet: boolean, words: string): Geometry {
  const box = fullSheet ? 0 : PAGE_MARGIN;
  const boxWidth = PAGE_WIDTH - 2 * box;
  const pad = fullSheet ? PAGE_MARGIN + BODY_INSET : BODY_INSET;
  const own = ownLetterhead(template);
  const line = 10.5 * PLAIN_LINE;
  const running = (fullSheet ? PAGE_MARGIN : 0) + line + 8 + 1;
  let footer = 0;
  if (own.footer) footer = (template.page_numbers ? line + 4 : 0) + (boxWidth * own.footer.height) / own.footer.width;
  else if (words || template.page_numbers) {
    // The footer's words wrap beside "Page 2 of 3" at about 5.4 px a letter (10.5 px Figtree).
    const room = boxWidth - 2 * pad - (template.page_numbers ? 96 : 0);
    const lines = Math.max(1, Math.ceil((words.length * 5.4) / room));
    footer = 2 + 10 + line * lines + (fullSheet ? PAGE_MARGIN : 0);
  }
  return { fullSheet, box, boxWidth, pad, running, footer };
}

/** The business's currency, or US dollars when it isn't one. */
function moneyIn(currency: string): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" });
  } catch {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  }
}

export function DocumentPdf({ template, company, data, pictures, font, currency, timeZone }: DocumentPdfProps) {
  const estimate = data.kind === "estimate";
  const kind = estimate ? "Estimate" : "Invoice";
  const color = documentColor(template, company.settings);
  const classic = template.font === "classic";
  const look: Look = { color, onColor: inkOn(color), textColor: readableOnWhite(color), font: classic ? ["Times-Roman", ...font] : font, minus: classic ? "-" : "−", money: moneyIn(currency), timeZone };
  const own = ownLetterhead(template);
  const words = template.footer.trim();
  const g = geometryOf(template, printsFullSheet(own), words);
  // The body starts under the running header on every page; the first page's letterhead is pulled up into that room.
  const top = g.box + g.running + BODY_PAD_TOP;
  const bottom = g.box + g.footer + BODY_PAD_BOTTOM;
  const pic = (url: string | null | undefined) => (url ? pictures.get(url) ?? null : null);

  const options = estimate && (data.options?.length ?? 0) >= 2 ? data.options! : [];
  const sections = data.contract?.sections ?? [];
  const terms = estimate ? sections.filter((s) => s.place === "terms") : [];
  const signs = estimate && signsAnything(template, data.signatures);

  return (
    <Document title={data.number ? `${kind} ${data.number}` : kind} author={company.name} creator="Crewtavo" producer="Crewtavo">
      <Page size="LETTER" style={{ paddingTop: px(top), paddingBottom: px(bottom), paddingHorizontal: px(g.box + g.pad), fontFamily: look.font, color: INK }}>
        <RunningHeader company={company} kind={kind} number={data.number} g={g} />
        <Footer template={template} own={own.footer} picture={pic(own.footer && letterheadSrc(own.footer.path))} words={words} g={g} look={look} />

        {/* The letterhead, at the top of the content box, the body's room under it. */}
        <View style={{ marginTop: px(g.box - top), marginHorizontal: px(-g.pad), marginBottom: px(BODY_PAD_TOP) }}>
          {own.header ? <OwnPicture picture={pic(letterheadSrc(own.header.path))} cut={own.header} width={g.boxWidth} padBottom={6} /> : <Letterhead template={template} company={company} logo={pic(company.logo)} g={g} look={look} />}
        </View>

        <Parties data={data} look={look} />
        {(data.title || (data.facts?.length ?? 0) > 0) && (
          <View style={{ marginTop: px(GAP), flexDirection: "row", flexWrap: "wrap", paddingVertical: px(10), paddingHorizontal: px(14), borderRadius: px(6), backgroundColor: STRIP }}>
            {!!data.title && <T style={{ fontWeight: 700, marginRight: px(18) }}>{data.title}</T>}
            {data.facts?.map((fact, i) => <T key={i} style={{ marginRight: px(18), color: TEXT_2 }}>{fact}</T>)}
          </View>
        )}
        {options.length > 0 && <Options options={options} pictures={pictures} look={look} />}
        <Lines lines={data.lines} look={look} />
        <Totals data={data} look={look} />

        {paragraphs(data.notes).map((text, i) => (
          <View key={`n${i}`} style={{ marginTop: px(i ? NOTES_LINE : GAP) }} minPresenceAhead={i ? 0 : px(40)}>
            {i === 0 && <T size={10.5} style={eyebrow({ marginBottom: px(4) })}>Notes</T>}
            <T size={12} lh={1.6}>{text}</T>
          </View>
        ))}
        {paragraphs(template.terms).map((text, i) => (
          <T key={`t${i}`} size={11} lh={1.6} style={{ marginTop: px(i ? TERMS_LINE : GAP), color: TEXT_2, ...(i === 0 && { paddingTop: px(14), borderTopWidth: px(1), borderTopColor: RULE }) }}>
            {text}
          </T>
        ))}

        {sections.map((section, n) => (!estimate || section.place !== "terms" ? <Section key={`s${n}`} section={section} pictures={pictures} timeZone={timeZone} /> : null))}

        {signs && (
          <View wrap={false} style={{ marginTop: px(GAP) }}>
            {terms.length > 0 && <T size={11.5} style={{ color: TEXT_2, marginBottom: px(4) }}>By signing, you agree to this estimate and the terms on the pages that follow.</T>}
            <Signatures template={template} company={company} signatures={data.signatures} pictures={pictures} timeZone={timeZone} />
          </View>
        )}
        {terms.length > 0 && (
          <>
            <T break minPresenceAhead={px(60)} size={17} lh={1.3} style={{ paddingBottom: px(8), borderBottomWidth: px(2), borderBottomColor: look.color, fontWeight: 700, color: look.textColor }}>
              Terms and conditions
            </T>
            {terms.map((section) => <Section key={section.id} section={section} pictures={pictures} timeZone={timeZone} />)}
          </>
        )}
      </Page>
    </Document>
  );
}

/** The small capitals over a group ("Bill to", "Notes"), at 10.5 px. */
const eyebrow = (more: Style = {}): Style => ({ fontWeight: 700, letterSpacing: px(10.5 * 0.12), textTransform: "uppercase", color: TEXT_3, ...more });

/** "Bill to" and the client; the document's name, number and dates. */
function Parties({ data, look }: { data: DocumentData; look: Look }) {
  const estimate = data.kind === "estimate";
  const meta = [data.number != null && `No. ${data.number}`, data.date && longDate(data.date), estimate && data.validUntil && `Good until ${longDate(data.validUntil)}`, !estimate && data.dueOn && `Due ${longDate(data.dueOn)}`].filter(Boolean);
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
      <View style={{ flexShrink: 1, marginRight: px(24) }}>
        <T size={10.5} style={eyebrow()}>{estimate ? "Prepared for" : "Bill to"}</T>
        <T size={14} style={{ marginTop: px(5), fontWeight: 600 }}>{data.client.name || " "}</T>
        {data.client.lines.map((line, i) => (
          <T key={i} lh={1.55} style={{ color: TEXT_2 }}>{line}</T>
        ))}
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <T size={22} style={{ fontWeight: 700, letterSpacing: px(22 * 0.06), textTransform: "uppercase", color: look.textColor }}>{estimate ? "Estimate" : "Invoice"}</T>
        {meta.map((line, i) => (
          <T key={i} lh={1.6} style={{ color: TEXT_2, textAlign: "right" }}>{line}</T>
        ))}
      </View>
    </View>
  );
}

/** The quantity, price and amount columns, each with 10 px before it, as on the pages. */
const COL_QTY = 84;
const COL_PRICE = 92;
const COL_AMOUNT = 100;

/** Money as the document shows it, with Times's minus sign on the classic look. */
const money = (n: number | null | undefined, look: Look) => look.money.format(n ?? 0).replace("−", look.minus);

/** The lines: the head, then each row, a row kept on one page. */
function Lines({ lines, look }: { lines: DocumentLine[]; look: Look }) {
  const th: Style = { fontWeight: 700, letterSpacing: px(10.5 * 0.08), textTransform: "uppercase", color: TEXT_2 };
  const num = (width: number): Style => ({ width: px(width), paddingLeft: px(10), textAlign: "right" });
  return (
    <View style={{ marginTop: px(GAP) }}>
      {/* Fixed: on every page the lines go on to, as the pages repeat their table's head. */}
      <View fixed style={{ flexDirection: "row", paddingBottom: px(8), borderBottomWidth: px(1.5), borderBottomColor: INK }} minPresenceAhead={px(40)}>
        <T size={10.5} style={[th, { flex: 1 }]}>Description</T>
        <T size={10.5} style={[th, num(COL_QTY)]}>Qty</T>
        <T size={10.5} style={[th, num(COL_PRICE)]}>Price</T>
        <T size={10.5} style={[th, num(COL_AMOUNT)]}>Amount</T>
      </View>
      {lines.map((line, i) => (
        <View key={i} wrap={false} style={{ flexDirection: "row", alignItems: "flex-start", paddingVertical: px(8), borderBottomWidth: px(1), borderBottomColor: ROW }}>
          <View style={{ flex: 1 }}>
            <T>{line.name}</T>
            {!!line.description && <T size={11.5} style={{ marginTop: px(1), color: TEXT_3 }}>{line.description}</T>}
          </View>
          <T style={[num(COL_QTY), { color: TEXT_2 }]}>{quantityLabel(line.quantity, line.unit)}</T>
          <T style={[num(COL_PRICE), { color: TEXT_2 }]}>{money(line.unit_price, look)}</T>
          <T style={[num(COL_AMOUNT), { fontWeight: 600 }]}>{money(line.total, look)}</T>
        </View>
      ))}
      {!lines.length && <T style={{ paddingVertical: px(14), color: TEXT_3 }}>Nothing on it yet.</T>}
    </View>
  );
}

/** Subtotal down to the total, and on an invoice its payments and what's left. */
function Totals({ data, look }: { data: DocumentData; look: Look }) {
  const estimate = data.kind === "estimate";
  const rows: Array<{ label: string; value: string; grand?: boolean }> = [{ label: "Subtotal", value: money(data.subtotal, look) }];
  if (data.discount > 0) rows.push({ label: data.discountLabel || "Discount", value: `${look.minus}${money(data.discount, look)}` });
  for (const c of data.credits ?? []) rows.push({ label: c.label, value: `${look.minus}${money(c.amount, look)}` });
  if (data.tax > 0) rows.push({ label: "Tax", value: money(data.tax, look) });
  if (data.taxExempt !== undefined) rows.push({ label: data.taxExempt ? `Tax exempt · ${data.taxExempt}` : "Tax exempt", value: money(0, look) });
  rows.push({ label: estimate && data.repeats ? "Total per visit" : "Total", value: money(data.total, look), grand: true });
  if (estimate && data.repeats) rows.push({ label: "How often", value: data.repeats });
  if (estimate && Number(data.deposit) > 0) rows.push({ label: "Deposit to get on the schedule", value: money(data.deposit, look) });
  if (!estimate) for (const p of data.payments ?? []) rows.push({ label: p.label, value: p.amount >= 0 ? `${look.minus}${money(p.amount, look)}` : `+${money(-p.amount, look)}` });
  if (!estimate && data.balanceDue != null) rows.push({ label: "Balance due", value: money(data.balanceDue, look), grand: true });
  return (
    <View wrap={false} style={{ marginTop: px(GAP) }}>
      {rows.map((r, i) => {
        const grand: Style = r.grand ? { fontWeight: 700, color: look.textColor } : {};
        return (
          <View key={i} style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: i ? px(6) : 0 }}>
            <T size={r.grand ? 15 : 13} style={[{ textAlign: "right", color: TEXT_2 }, grand]}>{r.label}</T>
            {/* The amounts' column is at least 110 px, its amounts flush right (a text's own minimum width doesn't move its words). */}
            <View style={{ minWidth: px(110), marginLeft: px(24), alignItems: "flex-end" }}>
              <T size={r.grand ? 15 : 13} style={grand}>{r.value}</T>
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A package's look when it has no picture: its material's color. */
const OPTION_COLOR: Record<string, string> = { shingle: "#5b6770", designer: "#6e5a4b", metal: "#3f5566", other: "#66747a" };

/** "Your options": the options side by side, kept together. */
function Options({ options, pictures, look }: { options: DocumentOption[]; pictures: PdfPictures; look: Look }) {
  return (
    <View wrap={false} style={{ marginTop: px(GAP) }}>
      <T size={10.5} style={eyebrow({ marginBottom: px(8) })}>Your options</T>
      <View style={{ flexDirection: "row" }}>
        {options.map((o, i) => {
          const picture = o.picture ? pictures.get(o.picture.src) ?? null : null;
          return (
            <View key={o.id} style={{ flex: 1, marginLeft: i ? px(12) : 0, borderWidth: px(o.chosen ? 2 : 1), borderColor: o.chosen ? look.color : RULE, borderRadius: px(8), overflow: "hidden" }}>
              {picture ? <Image src={picture.src} style={{ width: "100%", height: px(92), objectFit: "cover" }} /> : <View style={{ height: px(92), backgroundColor: OPTION_COLOR[o.style] ?? OPTION_COLOR.other }} />}
              <View style={{ flexGrow: 1, paddingTop: px(10), paddingHorizontal: px(12), paddingBottom: px(12) }}>
                {!!o.tier && <T size={10} style={{ alignSelf: "flex-start", marginBottom: px(4), paddingHorizontal: px(8), paddingVertical: px(1), borderRadius: px(999), backgroundColor: STRIP, fontWeight: 700, letterSpacing: px(0.8), textTransform: "uppercase", color: TEXT_2 }}>{o.tier}</T>}
                <T size={13} lh={1.3} style={{ fontWeight: 700, marginBottom: px(4) }}>{o.name}</T>
                {o.highlights.map((h, j) => (
                  <T key={j} size={11} lh={1.5} style={{ maxLines: 2, textOverflow: "ellipsis", color: TEXT_2 }}>• {h}</T>
                ))}
                {!!o.warranty.trim() && <T size={11} lh={1.5} style={{ maxLines: 3, textOverflow: "ellipsis", marginTop: px(4), color: TEXT_2 }}>{o.warranty.trim()}</T>}
                {o.total != null && <T size={15} style={{ marginTop: "auto", paddingTop: px(4), fontWeight: 700, color: look.textColor }}>{money(o.total, look)}</T>}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const CLAUSE: Style = { color: TEXT_2 };
const STRONG: Style = { fontWeight: 700, color: INK };

type ContractRowBlock = Extract<ContractBlock, { kind: "row" }>;

/** A contract section: its title, its paragraphs, lists, quotes and tables, and the box for the customer's initials. */
function Section({ section, pictures, timeZone }: { section: DocumentSection; pictures: PdfPictures; timeZone?: string }) {
  // Read from its HTML in the browser that sent it (a server has no HTML parser): else its words alone.
  const blocks = section.blocks ?? contractBlocks(section.html);
  const title = section.title.trim();
  const out: ReactNode[] = [];
  for (let n = 0; n < blocks.length; n++) {
    const b = blocks[n]!;
    const prev = blocks[n - 1];
    // The section's own space is above it; a little under the title, else a paragraph's.
    const gap = px(n === 0 ? (title ? 6 : 0) : CLAUSE_GAP);
    if (b.kind === "row") {
      const rows: ContractRowBlock[] = [];
      while (n < blocks.length && blocks[n]!.kind === "row" && (blocks[n] as ContractRowBlock).table === b.table) rows.push(blocks[n++] as ContractRowBlock);
      n--;
      out.push(
        <View key={n} style={{ marginTop: gap, borderTopWidth: px(1), borderLeftWidth: px(1), borderColor: CELL }}>
          {rows.map((row, r) => (
            <View key={r} wrap={false} style={{ flexDirection: "row" }}>
              {row.cells.map((cell, c) => (
                <View key={c} style={{ width: `${(100 * cell.colSpan) / row.columns}%`, paddingVertical: px(5), paddingHorizontal: px(8), borderRightWidth: px(1), borderBottomWidth: px(1), borderColor: CELL, ...(cell.tag === "th" && { backgroundColor: STRIP }) }}>
                  <T size={11} lh={1.5} style={cell.tag === "th" ? STRONG : CLAUSE}>{richText(cell.html, STRONG)}</T>
                </View>
              ))}
            </View>
          ))}
        </View>,
      );
    } else if (b.kind === "hr") out.push(<View key={n} style={{ marginTop: px(10), borderTopWidth: px(1), borderTopColor: RULE }} />);
    else if (b.kind === "h3" || b.kind === "h4") {
      out.push(<T key={n} minPresenceAhead={px(30)} size={11.5} lh={1.5} style={[STRONG, { marginTop: n === 0 ? gap : px(12) }]}>{richText(b.html, STRONG)}</T>);
    } else if (b.kind === "li") {
      out.push(
        <View key={n} style={{ marginTop: prev?.kind === "li" && b.number > 1 ? px(3) : gap, flexDirection: "row" }}>
          <T size={11.5} lh={1.6} style={[CLAUSE, { width: px(22), textAlign: "right", paddingRight: px(6) }]}>{b.list === "ol" ? `${b.number}.` : "•"}</T>
          <T size={11.5} lh={1.6} style={[CLAUSE, { flex: 1 }]}>{richText(b.html, STRONG)}</T>
        </View>,
      );
    } else if (b.kind === "quote") {
      out.push(
        <T key={n} size={11.5} lh={1.6} style={[CLAUSE, { marginTop: prev?.kind === "quote" && prev.quote === b.quote ? 0 : gap, paddingVertical: px(2), paddingLeft: px(12), borderLeftWidth: px(3), borderLeftColor: RULE }]}>
          {richText(b.html, STRONG)}
        </T>,
      );
    } else out.push(<T key={n} size={11.5} lh={1.6} style={[CLAUSE, { marginTop: gap }]}>{richText(b.html, STRONG, b.kind === "text")}</T>);
  }
  return (
    <View style={{ marginTop: px(TITLE_GAP) }}>
      {!!title && <T minPresenceAhead={px(40)} lh={1.4} style={STRONG}>{title}</T>}
      {out}
      {section.initials && <Initials section={section} pictures={pictures} timeZone={timeZone} />}
    </View>
  );
}

const PNG = /^data:image\/png;base64,/;

/** The customer's initials on a section, or the box they go in. */
function Initials({ section, pictures, timeZone }: { section: DocumentSection; pictures: PdfPictures; timeZone?: string }) {
  const done = section.initialed && PNG.test(section.initialed.image) ? section.initialed : null;
  const picture = done ? pictures.get(done.image) ?? null : null;
  return (
    <View wrap={false} style={{ marginTop: px(CLAUSE_GAP), flexDirection: "row", justifyContent: "flex-end", alignItems: "flex-end" }}>
      <T size={11} style={{ marginRight: px(10), color: TEXT_2 }}>Initials{done?.date ? ` · ${shortDate(done.date, timeZone)}` : ""}</T>
      <View style={{ position: "relative", width: px(96), height: px(34), borderBottomWidth: px(1), borderBottomColor: INK }}>
        {picture && <Image src={picture.src} style={{ position: "absolute", left: px(6), bottom: px(-6), height: px(40), width: px(Math.min(84, (40 * picture.width) / picture.height)), objectFit: "contain" }} />}
      </View>
    </View>
  );
}

/** Whether there's any signature line to draw. */
const signsAnything = (template: TemplateSettings, signatures: DocumentData["signatures"]) =>
  template.customer_signs || template.company_signs || Boolean(signatures?.customer?.image) || Boolean(signatures?.company?.image);

/** The signature lines the template asks for, and any line someone already signed. */
function Signatures({ template, company, signatures, pictures, timeZone }: { template: TemplateSettings; company: DocumentCompany; signatures: DocumentData["signatures"]; pictures: PdfPictures; timeZone?: string }) {
  const customer = signatures?.customer ?? null;
  const business = signatures?.company ?? null;
  const showCustomer = template.customer_signs || Boolean(customer?.image);
  const showCompany = template.company_signs || Boolean(business?.image);
  return (
    <View style={{ flexDirection: "row", paddingTop: px(18) }}>
      {showCustomer && <SignatureLine label={template.customer_label.trim() || "Customer"} signature={customer} dates={template.sign_dates} pictures={pictures} timeZone={timeZone} />}
      {showCustomer && showCompany && <View style={{ width: px(36) }} />}
      {showCompany && <SignatureLine label={companySignatureLabel(template, company.name)} signature={business} dates={template.sign_dates} pictures={pictures} timeZone={timeZone} />}
    </View>
  );
}

function SignatureLine({ label, signature, dates, pictures, timeZone }: { label: string; signature: DocumentSignature | null; dates: boolean; pictures: PdfPictures; timeZone?: string }) {
  const picture = signature?.image ? pictures.get(signature.image) ?? null : null;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ position: "relative", height: px(56), borderBottomWidth: px(1), borderBottomColor: INK }}>
        {picture && <Image src={picture.src} style={{ position: "absolute", left: 0, bottom: px(-10), height: px(64), width: px(Math.min(260, (64 * picture.width) / picture.height)), objectFit: "contain" }} />}
        {dates && picture && signature?.date && <T size={12} style={{ position: "absolute", right: 0, bottom: px(5) }}>{shortDate(signature.date, timeZone)}</T>}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: px(6) }}>
        <T size={11} style={{ color: TEXT_2 }}>{label}</T>
        {dates && <T size={11} style={{ color: TEXT_2 }}>Date</T>}
      </View>
      <T size={12} style={{ minHeight: px(12 * 1.45), marginTop: px(2), fontWeight: 600 }}>{signature?.name ?? ""}</T>
    </View>
  );
}

/** A picture of the business's own letterhead across the content box, at the size it was cut for. */
function OwnPicture({ picture, cut, width, padBottom = 0 }: { picture: PdfPicture | null; cut: LetterheadPicture; width: number; padBottom?: number }) {
  const height = (width * cut.height) / cut.width;
  return <View style={{ height: px(height + padBottom) }}>{picture && <Image src={picture.src} style={{ width: px(width), height: px(height) }} />}</View>;
}

/** On the pages after the first: who it's from and which document, small, with a rule under it. Plain Text (T's line height would hide it). */
function RunningHeader({ company, kind, number, g }: { company: DocumentCompany; kind: string; number: number | null; g: Geometry }) {
  return (
    <View
      fixed
      style={{ position: "absolute", top: px(g.box), left: px(g.box), right: px(g.box) }}
      render={({ pageNumber }) =>
        pageNumber > 1 ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: px(g.fullSheet ? PAGE_MARGIN : 0), paddingHorizontal: px(g.pad), paddingBottom: px(8), borderBottomWidth: px(1), borderBottomColor: RULE, fontSize: px(10.5), color: TEXT_3 }}>
            <Text style={{ maxLines: 1, textOverflow: "ellipsis", flexShrink: 1, marginRight: px(16) }}>
              {company.name} · {kind}
              {number != null ? ` No. ${number}` : ""}
            </Text>
            <Text>continued</Text>
          </View>
        ) : null
      }
    />
  );
}

/** Every page's foot: the business's own picture (with "Page 2 of 3" over it), or the template's words and the page number. Plain Text, as above. */
function Footer({ template, own, picture, words, g, look }: { template: TemplateSettings; own: LetterheadPicture | null; picture: PdfPicture | null; words: string; g: Geometry; look: Look }) {
  // "Page 2 of 3" is filled in after the page is laid out, so its box is as wide as the widest number could be ("Page 888 of 888", as on the pages).
  const numbers = template.page_numbers ? <Text fixed style={{ width: px(96), textAlign: "right" }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} /> : null;
  if (own) {
    return (
      <View fixed style={{ position: "absolute", bottom: px(g.box), left: px(g.box), right: px(g.box), fontSize: px(10.5), color: TEXT_3 }}>
        {numbers && <View style={{ alignItems: "flex-end", paddingHorizontal: px(g.pad), marginBottom: px(4) }}>{numbers}</View>}
        <OwnPicture picture={picture} cut={own} width={g.boxWidth} />
      </View>
    );
  }
  if (!words && !numbers) return null;
  return (
    <View fixed style={{ position: "absolute", bottom: px(PAGE_MARGIN), left: px(g.box + g.pad), right: px(g.box + g.pad), flexDirection: "row", justifyContent: "space-between", paddingTop: px(10), borderTopWidth: px(2), borderTopColor: look.color, fontSize: px(10.5), color: TEXT_3 }}>
      <Text style={{ flexShrink: 1, marginRight: px(16) }}>{words || " "}</Text>
      {numbers}
    </View>
  );
}

/** The business's name, logo and details, in the template's header style (classic, centered or banner). */
function Letterhead({ template, company, logo, g, look }: { template: TemplateSettings; company: DocumentCompany; logo: PdfPicture | null; g: Geometry; look: Look }) {
  const tagline = template.tagline.trim();
  const license = template.show_license && template.license.trim() ? licenseLine(template.license) : null;
  const insurer = template.show_insurer && template.insurer.trim() ? `Insured by ${template.insurer.trim()}` : null;
  const website = websiteLabel(company.website);
  const contact = [company.phone, company.email].filter(Boolean).join(" · ");
  const sheetTop = g.fullSheet ? px(PAGE_MARGIN) : 0;

  if (template.header === "centered") {
    const line = [company.address.join(", "), company.phone, company.email, website].filter(Boolean).join(" · ");
    return (
      <View style={{ alignItems: "center", paddingTop: sheetTop, paddingHorizontal: px(g.pad), paddingBottom: px(18), borderBottomWidth: px(1), borderBottomColor: "#e3e2dd" }}>
        <Mark company={company} logo={logo} look={look} height={60} maxWidth={240} />
        <T size={24} lh={1.15} style={{ marginTop: px(6), fontWeight: 700, letterSpacing: px(0.24), color: look.textColor, textAlign: "center" }}>{company.name}</T>
        {!!tagline && <T size={12} style={{ marginTop: px(6), textTransform: "uppercase", letterSpacing: px(12 * 0.14), color: TEXT_2, textAlign: "center" }}>{tagline}</T>}
        {!!line && <T size={11.5} style={{ marginTop: px(6), paddingTop: px(4), color: TEXT_2, textAlign: "center" }}>{line}</T>}
        {(license || insurer) && (
          <T size={11.5} style={{ marginTop: px(6), color: TEXT_2, textAlign: "center" }}>
            {!!license && <Text style={{ color: INK, fontWeight: 600 }}>{license}</Text>}
            {license && insurer && " · "}
            {insurer}
          </T>
        )}
        <View style={{ width: px(64), height: px(3), marginTop: px(14), borderRadius: px(2), backgroundColor: look.color }} />
      </View>
    );
  }

  const banner = template.header === "banner";
  const quiet = banner ? look.onColor : TEXT_2;
  const details = (
    <View style={{ maxWidth: "46%", alignItems: "flex-end" }}>
      {[...company.address, contact, website].filter(Boolean).map((line, i) => (
        <T key={i} size={11.5} lh={1.65} style={{ textAlign: "right", color: quiet }}>{line}</T>
      ))}
      {!!license && <T size={11.5} lh={1.65} style={{ textAlign: "right", color: banner ? look.onColor : INK, fontWeight: banner ? 700 : 600 }}>{license}</T>}
      {!!insurer && <T size={11.5} lh={1.65} style={{ textAlign: "right", color: quiet }}>{insurer}</T>}
    </View>
  );
  const name = (
    <View style={{ flexShrink: 1 }}>
      <T size={22} lh={1.15} style={{ fontWeight: 700, color: banner ? look.onColor : look.textColor }}>{company.name}</T>
      {!!tagline && <T size={12} style={{ marginTop: px(2), color: quiet }}>{tagline}</T>}
    </View>
  );
  if (banner) {
    return (
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: px(22), paddingHorizontal: px(g.fullSheet ? g.pad : 20), backgroundColor: look.color }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, marginRight: px(24) }}>
          <View style={{ minWidth: px(56), height: px(56), paddingVertical: px(6), paddingHorizontal: px(10), marginRight: px(14), borderRadius: px(12), backgroundColor: "#fff", alignItems: "center", justifyContent: "center" }}>
            {logo ? <Image src={logo.src} style={fit(logo, 170, 44)} /> : <T size={18} style={{ fontWeight: 700, color: look.textColor }}>{initials(company.name)}</T>}
          </View>
          {name}
        </View>
        {details}
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: sheetTop, paddingHorizontal: px(g.pad), paddingBottom: px(22), borderBottomWidth: px(3), borderBottomColor: look.color }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, marginRight: px(24) }}>
        <View style={{ marginRight: px(14) }}>
          <Mark company={company} logo={logo} look={look} height={56} maxWidth={200} />
        </View>
        {name}
      </View>
      {details}
    </View>
  );
}

/** A picture's size, shrunk (never grown) to fit `maxWidth` × `maxHeight` CSS px. */
function fit(picture: PdfPicture, maxWidth: number, maxHeight: number): Style {
  const scale = Math.min(1, maxWidth / picture.width, maxHeight / picture.height);
  return { width: px(picture.width * scale), height: px(picture.height * scale) };
}

/** The logo, or the business's initials on its color. */
function Mark({ company, logo, look, height, maxWidth }: { company: DocumentCompany; logo: PdfPicture | null; look: Look; height: number; maxWidth: number }) {
  if (logo) {
    return (
      <View style={{ height: px(height), justifyContent: "center" }}>
        <Image src={logo.src} style={fit(logo, maxWidth, height)} />
      </View>
    );
  }
  return (
    <View style={{ width: px(50), height: px(50), borderRadius: px(10), backgroundColor: look.color, alignItems: "center", justifyContent: "center" }}>
      <T size={18} style={{ fontWeight: 700, letterSpacing: px(0.36), color: look.onColor }}>{initials(company.name)}</T>
    </View>
  );
}
