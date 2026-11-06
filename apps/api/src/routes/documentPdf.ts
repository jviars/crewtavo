/**
 * POST /api/public/documents/<name>.pdf: an estimate or invoice as a PDF (services/documentPdf.ts).
 * A page that prints sends the document it shows as a form, into a new tab (apps/web pdfPrint.ts),
 * and the tab shows the PDF: on an iPhone, Safari prints it on the whole sheet. The name is the
 * file's ("Invoice 1042.pdf"), since Safari names a file it saves or shares by its address.
 *
 * Anyone with a document can ask, as anyone can print the page: so it's limited by the visitor, and
 * its pictures only come from the businesses' own storage.
 */
import { templateSettings } from "@crewtavo/core/documents";
import { Hono, type Context } from "hono";
import type { DocumentData } from "../../../web/src/features/documents/types";
import type { AppEnv } from "../env";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { clientIp } from "../lib/visitor";
import { documentPdf, documentPdfInput } from "../services/documentPdf";
import { formPage } from "../services/websiteForms";

export const documentPdfRoutes = new Hono<AppEnv>();

/** The file's name in its address: "Invoice 1042.pdf". */
const FILE = /^[\p{L}\p{N} ._#'&(),-]{1,100}\.pdf$/u;

/** What the tab says when there's no PDF to show it: a page for the person printing, not an error's text. */
const sorry = (c: Context<AppEnv>, status: 400 | 404 | 429 | 500, text: string) =>
  c.html(formPage({ title: "Couldn't make the PDF", heading: "Couldn't make the PDF", text, company: null, tone: "problem" }), status, { "Cache-Control": "no-store" });

const AGAIN = "Close this tab and try Print again.";

documentPdfRoutes.post("/public/documents/:file", async (c) => {
  if (!FILE.test(c.req.param("file") ?? "")) return sorry(c, 404, `This isn't a document to print. ${AGAIN}`);
  if (!(await allow(c.env, `document-pdf:${clientIp(c)}`, 60, 3600))) return sorry(c, 429, "That's a lot of PDFs at once. Wait a few minutes, then try Print again.");
  const form = await c.req.parseBody();
  let json: unknown = null;
  try {
    json = typeof form.document === "string" ? JSON.parse(form.document) : null;
  } catch {
    // Not JSON: refused below.
  }
  const input = documentPdfInput.safeParse(json);
  if (!input.success) return sorry(c, 400, `This isn't a document to print. ${AGAIN}`);
  const { template, company, data, currency, timeZone } = input.data;
  let pdf: Buffer;
  try {
    pdf = await documentPdf(c.env, { template: templateSettings(template), company, data: data as DocumentData, currency, timeZone });
  } catch (error) {
    reportError(error, { route: "document pdf" });
    return sorry(c, 500, `Something went wrong making it. ${AGAIN} Or print the page itself, from your browser's Share or File menu.`);
  }
  const name = `${data.kind === "estimate" ? "Estimate" : "Invoice"}${data.number != null ? ` ${data.number}` : ""}.pdf`;
  return c.body(new Uint8Array(pdf), 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${name}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
});
