/**
 * How a search row (CommandPalette) shows why it matched: the typed letters in bold, and for a row
 * found only by its hidden keywords, the keyword words that found it.
 */

/** text cut into [piece, matched] parts: the first place each typed word appears in it is matched. */
export function marks(text: string, words: string[]): Array<[string, boolean]> {
  const lower = text.toLowerCase();
  // shortcut: a letter whose lowercase is longer ("İ") leaves the row plain, the bold is only a hint.
  if (lower.length !== text.length) return [[text, false]];
  const hit = Array<boolean>(text.length).fill(false);
  for (const w of words) {
    const at = w ? lower.indexOf(w) : -1;
    if (at >= 0) hit.fill(true, at, at + w.length);
  }
  const parts: Array<[string, boolean]> = [];
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last[1] === hit[i]) last[0] += text[i];
    else parts.push([text[i], hit[i]]);
  }
  return parts;
}

/**
 * When a typed word isn't in what the row shows, the keyword it matched and the one after it
 * ("invoice numbering"), not the whole list. Addresses ("/jobs") are left out, as no one reads them.
 * A comma ends a phrase, so the hint never runs on into the next one ("invoices", not "invoices Settings").
 */
export function keywordHint(shown: string, keywords: string | undefined, words: string[]): string | undefined {
  const visible = shown.toLowerCase();
  const hidden = words.find((w) => !visible.includes(w));
  if (!hidden || !keywords) return undefined;
  for (const phrase of keywords.split(",")) {
    const tokens = phrase.split(/\s+/).filter((k) => k && !k.startsWith("/"));
    const at = tokens.findIndex((k) => k.toLowerCase().includes(hidden));
    if (at >= 0) return tokens.slice(at, at + 2).join(" ");
  }
  return undefined;
}
