/**
 * pdf.js's own page viewer and markup tools (the same ones Firefox uses), loaded the first time a PDF
 * is opened in the file viewer. The viewer module reads pdf.js from globalThis.pdfjsLib the moment it
 * loads, so that's set first.
 *
 * Its stylesheet also styles pdf.js's full app, under class names Crewtavo uses for its own things
 * (.dialog, .sidebar), and sets the page's color scheme to follow the device. Put on the page as is,
 * it would restyle every dialog and the sidebar for the rest of the visit, so those rules are taken
 * out of it first.
 */
import { loadPdfJs, type PdfModule } from "@/lib/pdf";

export type PdfViewerModule = typeof import("pdfjs-dist/legacy/web/pdf_viewer.mjs");

export interface PdfKit {
  lib: PdfModule;
  viewer: PdfViewerModule;
}

let loading: Promise<PdfKit> | null = null;

export function loadPdfViewer(): Promise<PdfKit> {
  loading ??= (async () => {
    const lib = await loadPdfJs();
    (globalThis as { pdfjsLib?: PdfModule }).pdfjsLib = lib;
    const [viewer, css] = await Promise.all([import("pdfjs-dist/legacy/web/pdf_viewer.mjs"), import("pdfjs-dist/legacy/web/pdf_viewer.css?inline")]);
    addStyles(css.default);
    return { lib, viewer };
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

/**
 * Rules for parts of pdf.js's app the file viewer doesn't use (its dialogs, sidebars, menus and
 * buttons), several under the same class names as Crewtavo's own.
 */
const FOREIGN = /(?:^|[\s,>+~(])(?:\.dialog|\.sidebar|\.toggle-button|\.messageBar|\.popupMenu|\.primaryButton|\.secondaryButton|\.treeView|\.newBadge|button\.hasPopupMenu|#outerContainer|#viewsManager)(?![\w-])/;

/** True for a rule from pdf.js's stylesheet that must not reach the rest of the app. */
export const isForeignPdfRule = (selector: string) => FOREIGN.test(selector);

type RuleGroup = { cssRules: CSSRuleList; deleteRule(index: number): void };

function tidy(group: RuleGroup) {
  for (let i = group.cssRules.length - 1; i >= 0; i--) {
    const rule = group.cssRules[i]!;
    if (rule instanceof CSSStyleRule) {
      if (isForeignPdfRule(rule.selectorText)) {
        group.deleteRule(i);
        continue;
      }
      // Light or dark is the person's choice in Settings → Profile, not the device's.
      if (rule.selectorText.trim() === ":root") rule.style.removeProperty("color-scheme");
    }
    // Media queries, and nested rules where the browser keeps them nested.
    if ("cssRules" in rule && (rule as unknown as RuleGroup).cssRules.length) tidy(rule as unknown as RuleGroup);
  }
}

function addStyles(cssText: string) {
  if (document.querySelector("style[data-pdf-viewer]")) return;
  const style = document.createElement("style");
  style.dataset.pdfViewer = "";
  style.textContent = cssText;
  document.head.append(style);
  if (style.sheet) tidy(style.sheet);
}
