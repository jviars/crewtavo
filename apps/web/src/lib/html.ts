/** Sanitizing user-written rich text (SOPs, notes) to a small, safe subset of HTML. */
import DOMPurify from "dompurify";

const ALLOWED_TAGS = ["p", "br", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "a", "hr", "code", "pre", "img", "table", "thead", "tbody", "tr", "th", "td"];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "target", "rel", "colspan", "rowspan"];

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  // Links open in a new tab and never get access to this window.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
}

export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/)/i });
}

/** Plain text for search: block elements become line breaks. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${sanitizeHtml(html)}</div>`, "text/html");
  doc.querySelectorAll("p, h2, h3, h4, li, blockquote, pre, tr, br").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text (e.g. pasted) to paragraphs. */
export const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
