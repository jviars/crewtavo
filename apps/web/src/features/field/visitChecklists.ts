/**
 * Which checklists a visit shows (FieldVisitPage), the way Jobber attaches job forms to line items:
 * each one its job's price list items go with (`matched`, from job_checklists()), ready to fill in,
 * and one more to pick from the rest. With nothing matched it's as before: the one checklist to
 * pick from, chosen for them when the business has only one. One already started shows as it was.
 */
export interface VisitChecklist<R> {
  /** The same from the first save on, so the card isn't made again. */
  key: string;
  /** Brought up by the job's items, so there's nothing to pick. */
  fixed: boolean;
  /** Its checklist, or the one chosen for them; null until one is picked. */
  templateId: string | null;
  response: R | null;
}

export function visitChecklists<T extends { id: string }, R extends { id: string; template_id: string | null }>(
  templates: readonly T[],
  matched: readonly string[],
  responses: readonly R[],
  /** The id a checklist not started yet saves with. */
  newId: string,
): { cards: Array<VisitChecklist<R>>; others: T[] } {
  const fixedIds = templates.map((t) => t.id).filter((id) => matched.includes(id));
  const cards: Array<VisitChecklist<R>> = fixedIds.map((id) => ({ key: `t:${id}`, fixed: true, templateId: id, response: responses.find((r) => r.template_id === id) ?? null }));
  const taken = new Set(cards.map((c) => c.response?.id));
  // The rest, for the list to pick from.
  const others = templates.filter((t) => !fixedIds.includes(t.id));
  const started = responses.filter((r) => !taken.has(r.id));
  cards.push(...started.map((r) => ({ key: r.id, fixed: false, templateId: r.template_id, response: r })));
  if (!started.length && others.length) cards.push({ key: newId, fixed: false, templateId: !fixedIds.length && templates.length === 1 ? templates[0]!.id : null, response: null });
  return { cards, others };
}
