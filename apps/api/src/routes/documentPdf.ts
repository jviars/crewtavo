/**
 * POST /api/public/documents/<name>.pdf: an estimate or invoice as a PDF (services/documentPdf.ts).
 * A page that prints sends the document it shows as a form, into a new tab (apps/web pdfPrint.ts),
 * and the tab shows the PDF: on an iPhone, Safari prints it on the whole sheet. The name is the
 * file's ("Invoice 1042.pdf"), since Safari names a file it saves or shares by its address.
 *
 * A form can't carry the sign-in, so it carries a print ticket the page asked for just before:
 * POST /api/documents/print-ticket for a signed-in member of the business (the office's Print), or
 * POST /api/hub/<token>/print-ticket for a Client Hub link (its quote or invoice, and only that one).
 * The PDF's pictures only come from the ticket's business's own storage. It's limited by the
 * visitor too, and by how big a document may be.
 */
import { STAFF, type Permission } from "@crewtavo/core";
import { templateSettings } from "@crewtavo/core/documents";
import { Hono, type Context } from "hono";
import type { DocumentData } from "../../../web/src/features/documents/types";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, must } from "../lib/http";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { Busy, TookTooLong } from "../pdf/threads";
import { documentPdf, documentPdfInput, printTicket, readPrintTicket, ticketCovers, tooMuchToDraw, tooMuchToRead } from "../services/documentPdf";
import { formPage } from "../services/websiteForms";
import { link } from "./public";

export const documentPdfRoutes = new Hono<AppEnv>();

/** The file's name in its address: "Invoice 1042.pdf". */
const FILE = /^[\p{L}\p{N} ._#'&(),-]{1,100}\.pdf$/u;

/** What the tab says when there's no PDF to show it: a page for the person printing, not an error's text. */
const sorry = (c: Context<AppEnv>, status: 400 | 403 | 404 | 413 | 429 | 500 | 503, text: string) =>
  c.html(formPage({ title: "Couldn't make the PDF", heading: "Couldn't make the PDF", text, company: null, tone: "problem" }), status, { "Cache-Control": "no-store" });

const AGAIN = "Close this tab and try Print again.";
const PRINT_PAGE = "Print the page itself instead, from your browser's Share or File menu.";

documentPdfRoutes.post("/public/documents/:file", async (c) => {
  if (!FILE.test(c.req.param("file") ?? "")) return sorry(c, 404, `This isn't a document to print. ${AGAIN}`);
  if (!(await allow(c.env, `document-pdf:${clientIp(c)}`, 60, 3600))) return sorry(c, 429, "That's a lot of PDFs at once. Wait a few minutes, then try Print again.");
  const form = await c.req.parseBody();
  const ticket = await readPrintTicket(c.env, form.ticket);
  if (!ticket) return sorry(c, 403, `This print has run out. ${AGAIN}`);
  let json: unknown = null;
  try {
    json = typeof form.document === "string" ? JSON.parse(form.document) : null;
  } catch {
    // Not JSON: refused below.
  }
  // Counted before it's read any further, so an outsized one costs next to nothing.
  if (tooMuchToRead(json)) return sorry(c, 413, `This document is too big to make into a PDF. ${PRINT_PAGE}`);
  const input = documentPdfInput.safeParse(json);
  if (!input.success) return sorry(c, 400, `This isn't a document to print. ${AGAIN}`);
  const { template, company, data, currency, timeZone } = input.data;
  // A Client Hub link's ticket is for its own quote or invoice.
  if (!ticketCovers(ticket, data)) return sorry(c, 403, `This isn't the document this page prints. ${AGAIN}`);
  if (tooMuchToDraw(data as DocumentData)) return sorry(c, 413, `This document is too big to make into a PDF. ${PRINT_PAGE}`);
  let pdf: Buffer;
  try {
    pdf = await documentPdf(c.env, { companyId: ticket.c, template: templateSettings(template), company, data: data as DocumentData, currency, timeZone });
  } catch (error) {
    if (error instanceof Busy) return sorry(c, 503, "Lots of PDFs are being made right now. Wait a minute, then try Print again.");
    reportError(error, { route: "document pdf" });
    if (error instanceof TookTooLong) return sorry(c, 500, `This document took too long to make into a PDF. ${PRINT_PAGE}`);
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

/** The areas with a screen that prints a document: Quotes (the roofing visit's too), Invoices, and Settings' template sample. */
const PRINTS: readonly Permission[] = ["sales", "invoices", "settings"];

/** A print ticket for a signed-in member of the business on screen (X-Company-Id), for any of its documents. */
documentPdfRoutes.post("/documents/print-ticket", requireUser, requireCompany(STAFF), async (c) => {
  if (!PRINTS.some((area) => c.var.permissions.includes(area))) throw new HttpError(403, "You don't have permission to do that. Ask an admin if you need it.");
  return c.json({ ticket: await printTicket(c.env, c.var.companyId) });
});

/** A print ticket from a Client Hub link to a quote or invoice, for that document only: its kind and number. */
documentPdfRoutes.post("/hub/:token/print-ticket", async (c) => {
  if (!(await allow(c.env, `document-pdf-ticket:${clientIp(c)}`, 120, 3600))) throw new HttpError(429, "That's a lot of printing at once. Wait a few minutes, then try again.");
  const l = await link(c, ["quote", "invoice"]);
  const record = must(
    await adminClient(c.env).from(l.t === "quote" ? "quotes" : "invoices").select("number").eq("company_id", l.c).eq("id", l.id).maybeSingle(),
    "This link isn't valid anymore.",
  );
  return c.json({ ticket: await printTicket(c.env, l.c, { kind: l.t === "quote" ? "estimate" : "invoice", number: record.number ?? null }) });
});
