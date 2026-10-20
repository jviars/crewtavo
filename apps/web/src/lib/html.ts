/** Sanitizing user-written rich text (SOPs, notes) to a small, safe subset of HTML. */
import { videoAttributes, videoEmbed } from "@crewtavo/core/video";
import DOMPurify from "dompurify";

// div holds callouts (data-callout) and checklist items (ul data-type="taskList" > li data-checked); data-* attributes pass by default.
const ALLOWED_TAGS = ["p", "br", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "blockquote", "a", "hr", "code", "pre", "img", "iframe", "table", "thead", "tbody", "tr", "th", "td", "div"];
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
    // Videos: only YouTube and Vimeo players, rebuilt from the video's id with our own attributes.
    if (node.tagName === "IFRAME") {
      const video = videoEmbed(node.getAttribute("src") ?? "");
      for (const { name } of [...node.attributes]) node.removeAttribute(name);
      if (!video) return node.remove();
      for (const [name, value] of Object.entries(videoAttributes(video))) node.setAttribute(name, value);
    }
  });
}

export function sanitizeHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/)/i });
}

/** Whether a guide has anything to read or watch. */
export const hasContent = (html: string) => Boolean(htmlToText(html)) || /<(img|iframe)\b/i.test(sanitizeHtml(html));

/** Plain text for search: block elements become line breaks. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${sanitizeHtml(html)}</div>`, "text/html");
  doc.querySelectorAll("p, h2, h3, h4, li, blockquote, pre, tr, br").forEach((el) => el.append("\n"));
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Section { id: string; title: string; level: 2 | 3 }

const slug = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "section";

/**
 * A guide's sections for "On this page": each h2 and h3 gets an id from its words (so a link can
 * point at it, like /kb/…#mixing-ratio) and a "#" link to copy. Takes sanitized HTML.
 */
export function withSections(html: string): { html: string; sections: Section[] } {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  const used = new Set<string>();
  const sections: Section[] = [];
  root.querySelectorAll("h2, h3").forEach((heading) => {
    const title = heading.textContent?.trim() ?? "";
    if (!title) return;
    let id = slug(title);
    for (let n = 2; used.has(id); n++) id = `${slug(title)}-${n}`;
    used.add(id);
    heading.id = id;
    const anchor = doc.createElement("a");
    anchor.className = "heading-anchor";
    anchor.setAttribute("href", `#${id}`);
    anchor.setAttribute("aria-label", "Copy a link to this section");
    anchor.textContent = "#";
    heading.append(anchor);
    sections.push({ id, title, level: heading.tagName === "H2" ? 2 : 3 });
  });
  return { html: root.innerHTML, sections };
}

export const escapeHtml =(s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text (e.g. pasted) to paragraphs. */
export const textToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
