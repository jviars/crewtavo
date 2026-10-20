/**
 * Markdown to a guide's HTML and plain text, for guides an AI assistant writes (it writes Markdown
 * naturally). Only the small set the guide editor makes comes out: headings, paragraphs, lists,
 * quotes, dividers, code, bold, italics, links and YouTube or Vimeo videos (a link alone on its
 * line). Everything else is escaped, so no markup in the text gets through as markup. Pages
 * sanitise again when they show it (apps/web/src/lib/html.ts).
 */
import { videoEmbed, videoIframe } from "./video";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SAFE_LINK = /^(?:https?:\/\/|mailto:|tel:)/i;

/** Bold, italics, code and links in one line of text, as HTML and as plain text. */
function inline(source: string): { html: string; text: string } {
  const codes: string[] = [];
  // Code first, so nothing inside it is read as Markdown.
  let html = escapeHtml(source.replace(/`([^`]+)`/g, (_, code: string) => `\u0000${codes.push(code) - 1}\u0000`));
  html = html
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
      const href = url.replace(/&amp;/g, "&");
      return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, (_, p1?: string, a?: string, p2?: string, b?: string) => `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`)
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
  const text = source
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => a ?? b ?? "")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)|(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, (_, p1?: string, a?: string, p2?: string, b?: string) => `${p1 ?? p2 ?? ""}${a ?? b}`);
  return { html, text };
}

/** A guide's body_html and body_text from Markdown. */
export function markdownToGuide(markdown: string): { html: string; text: string } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  const text: string[] = [];
  let paragraph: string[] = [];
  let list = null as { tag: "ul" | "ol"; items: string[] } | null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    // A YouTube or Vimeo link alone on its line is the video, as when it's pasted in the editor.
    const video = paragraph.length === 1 && /^https?:\/\/\S+$/i.test(paragraph[0]) ? videoEmbed(paragraph[0]) : null;
    if (video) {
      html.push(`<p>${videoIframe(video)}</p>`);
      paragraph = [];
      return;
    }
    const p = inline(paragraph.join(" "));
    html.push(`<p>${p.html}</p>`);
    text.push(p.text);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map(inline);
    html.push(`<${list.tag}>${items.map((i) => `<li><p>${i.html}</p></li>`).join("")}</${list.tag}>`);
    text.push(...items.map((i) => i.text));
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const q = inline(quote.join(" "));
    html.push(`<blockquote><p>${q.html}</p></blockquote>`);
    text.push(q.text);
    quote = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      text.push(code.join("\n"));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      // The guide's title is the page's heading, so its own headings start a level down.
      const tag = heading[1].length === 1 ? "h2" : heading[1].length === 2 ? "h3" : "h4";
      const h = inline(heading[2]);
      html.push(`<${tag}>${h.html}</${tag}>`);
      text.push(h.text);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }
    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const tag = bullet ? "ul" : "ol";
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list!.items.push((bullet ?? numbered)![1]);
      continue;
    }
    // A line under a list item carries on that item.
    if (list && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flush();
  return { html: html.join(""), text: text.join("\n").trim() };
}
