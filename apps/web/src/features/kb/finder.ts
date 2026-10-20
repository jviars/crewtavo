/**
 * Search as you type over guide titles, tags and categories (MiniSearch, in the browser): part of a
 * word ("seal" finds "Sealcoat") and small typos still match. The words inside guides are searched
 * on the server (search_sops), which this doesn't replace.
 */
import MiniSearch from "minisearch";

export interface FindableGuide { id: string; title: string; tags: string[]; category_id: string | null }

/** Guide ids for what's typed, best match first; every word has to match something. */
export function guideFinder(guides: FindableGuide[], categories: Array<{ id: string; name: string }>): (term: string) => string[] {
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const index = new MiniSearch<FindableGuide>({
    fields: ["title", "tags", "category"],
    extractField: (g, field) => (field === "tags" ? g.tags.join(" ") : field === "category" ? (names.get(g.category_id ?? "") ?? "") : field === "title" ? g.title : g.id),
    searchOptions: { prefix: true, fuzzy: 0.2, combineWith: "AND", boost: { title: 3, tags: 2 } },
  });
  index.addAll(guides);
  return (term) => index.search(term).map((hit) => String(hit.id));
}
