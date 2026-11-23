/**
 * Printing as a PDF the server makes (apps/api routes/documentPdf.ts), in Safari: on an iPhone or
 * iPad (every browser there is Safari's) and on a Mac. Safari prints a web page inside its own
 * margins with its own header and footer, which no page can leave off; a PDF prints on the whole
 * sheet. Other browsers print the page itself on the whole sheet already, in place, so they still do.
 *
 * The document a screen would print (its PrintableDocument) is kept here while it's on the page;
 * printing sends it, as a form, into a new tab, and the tab shows the PDF. Nothing is made on the
 * phone: Safari there crashes making a PDF with react-pdf.
 *
 * The server makes a PDF only for someone it knows, and a form can't carry the sign-in: so printing
 * first asks for a print ticket, which the form carries. The office's come with the person's sign-in;
 * the Client Hub's with its link (printTicketsFrom).
 */
import { api } from "@/lib/api";
import { moneyCurrency } from "@/lib/format";
import { contractBlocks } from "@/lib/html";
import type { PrintableDocumentProps } from "./EstimateDocument";
import { isWebKit } from "./paper";

let current: PrintableDocumentProps | null = null;

/** Puts a document up to be printed as a PDF; the function returned takes it down. */
export function printableOnPage(doc: PrintableDocumentProps): () => void {
  current = doc;
  return () => {
    if (current === doc) current = null;
  };
}

/** Asks the server for a print ticket, good for a few minutes. */
export type PrintTickets = () => Promise<string>;

/** The office's: for the signed-in person, in the business on screen. */
const officeTickets: PrintTickets = async () => (await api.post<{ ticket: string }>("/documents/print-ticket")).ticket;
let tickets: PrintTickets = officeTickets;

/** Print tickets from `source` while a page is up (the Client Hub's, from its link); the function returned goes back to the office's. */
export function printTicketsFrom(source: PrintTickets): () => void {
  tickets = source;
  return () => {
    if (tickets === source) tickets = officeTickets;
  };
}

/**
 * In Safari, opens the document on the page as a PDF: in a new tab, or in this one when it's a tab
 * opened to print (?print=1, the office's Print). A new tab has to open while the tap still counts,
 * or Safari blocks it as a pop-up: so it opens first, empty, and the form goes into it once the
 * ticket is in. False in another browser, with no document, or the new tab blocked: the caller
 * prints the page the old way. When no ticket comes (signed out, no connection, a link that's been
 * replaced), the new tab closes again and `otherwise` prints the page the old way.
 */
export function openPrintablePdf(where: "new tab" | "this tab" = "new tab", otherwise?: () => void): boolean {
  const doc = current;
  if (!doc || typeof document === "undefined" || !isWebKit()) return false;
  let tab: Window | null = null;
  let target = "_self";
  if (where === "new tab") {
    // Opened first, empty, so a blocked one is known; the form then goes into it by its name.
    target = `crewtavo-pdf-${Date.now()}`;
    tab = window.open("", target);
    if (!tab) return false;
  }
  const { template, company, data } = doc;
  // Its contract read into paragraphs, list items and table rows here: the server has no HTML parser.
  const contract = data.contract && { sections: data.contract.sections.map((s) => ({ ...s, blocks: contractBlocks(s.html) })) };
  // Safari names a file it saves or shares by its address: "Invoice 1042.pdf".
  const action = `/api/public/documents/${encodeURIComponent(`${data.kind === "estimate" ? "Estimate" : "Invoice"}${data.number != null ? ` ${data.number}` : ""}`)}.pdf`;
  // Where it's printed, so the day beside a signature is the one on the page.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sent = JSON.stringify({ template, company, currency: moneyCurrency(), timeZone, data: contract ? { ...data, contract } : data });
  tickets().then(
    (ticket) => post(action, target, { ticket, document: sent }),
    () => {
      tab?.close();
      otherwise?.();
    },
  );
  return true;
}

/** Sends `fields` as a form to `action`, into the tab named `target`. */
function post(action: string, target: string, fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.target = target;
  form.acceptCharset = "utf-8";
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
    const field = document.createElement("input");
    field.type = "hidden";
    field.name = name;
    field.value = value;
    form.append(field);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}
