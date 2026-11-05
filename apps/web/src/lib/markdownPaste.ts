/**
 * Markdown pasted into the guide editor as a guide's own formatting: headings, lists, numbered
 * steps, checklists, quotes, callouts, code, bold, italics and links (markdownToGuide, which an AI
 * assistant's guides go through too). For text copied as plain text from a .md file, a notes app or
 * a chat with an AI. A copy that carries its own formatting (a web page, Word, Google Docs) pastes
 * as it is.
 */
import { markdownToGuide } from "@crewtavo/core/markdown";

/** A line that starts a Markdown block: a heading, a list item or step, a checklist item, a quote or a code fence. */
const BLOCK = /^ {0,3}(#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s|>\s?|```)/m;
/** Formatting the copy brings with it, which the editor reads better than its Markdown. */
const FORMATTED = /<(h[1-6]|ul|ol|li|table|strong|b|em|i|a|blockquote|img|pre|code)\b/i;

/** The HTML to paste for `text` (the clipboard's plain text), or null to paste as usual. `html`: the clipboard's HTML, if any. */
export function markdownPaste(text: string, html = ""): string | null {
  if (!text.trim() || FORMATTED.test(html) || !BLOCK.test(text)) return null;
  return markdownToGuide(text).html;
}
