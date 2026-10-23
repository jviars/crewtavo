/**
 * "Print or save PDF" for an estimate in the office, from the quote's own data: the business's
 * template document with the exact price and any signatures, never the homeowner's link (which
 * only shows a range while one is out). The document goes on the page the first time it's printed
 * and stays, so the browser's own Print prints it too; it follows the quote as it changes.
 */
import { useEffect, useState } from "react";
import { PrintableDocument, printDocument } from "../../documents/EstimateDocument";
import type { EstimateDocumentProps } from "../../documents/types";

/** Asks for a print: each call prints again. */
export function useQuotePrint() {
  const [request, setRequest] = useState(0);
  return { request, print: () => setRequest((n) => n + 1) };
}

export function QuotePrint({ request, template, company, data }: { request: number } & Pick<EstimateDocumentProps, "template" | "company" | "data">) {
  useEffect(() => {
    if (!request) return;
    // Once the document is on the page; printDocument waits for its lettering, logo and signatures.
    const frame = requestAnimationFrame(() => void printDocument());
    return () => cancelAnimationFrame(frame);
  }, [request]);
  if (!request) return null;
  return <PrintableDocument template={template} company={company} data={data} />;
}
