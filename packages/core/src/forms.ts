/**
 * Booking forms and checklists, tidied and checked the same way whether someone saves them on
 * their screens (Online booking, Settings → Checklists) or an AI assistant does (the MCP tools).
 * Problems come back as thrown errors worded for a person.
 */

// ---------------------------------------------------------------------------------------------
// Booking forms (public.intake_forms)
// ---------------------------------------------------------------------------------------------

export const INTAKE_FORM_KINDS = ["request", "assessment", "booking"] as const;
export type IntakeFormKind = (typeof INTAKE_FORM_KINDS)[number];

/** Name, email, phone and address are always asked, so they aren't questions of their own. */
export const INTAKE_QUESTION_TYPES = ["text", "long_text", "number", "yes_no", "choice", "multi_choice", "files", "photos"] as const;
export type IntakeQuestionType = (typeof INTAKE_QUESTION_TYPES)[number];

export interface IntakeQuestion {
  key: string;
  label: string;
  type: IntakeQuestionType;
  required: boolean;
  options?: string[];
}

/** A form's link: /book/<company>/<this>. */
export const formSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "form";

const hasOptions = (type: string) => type === "choice" || type === "multi_choice";

/**
 * A form ready to save: its link made from the slug or name, unique question keys, trimmed labels
 * and options, and its ZIP codes. `taken` is the links the company's other forms use.
 */
export function normalizeIntakeForm(
  form: { name: string; slug?: string | null; zips: readonly string[]; questions: ReadonlyArray<{ key?: string | null; label: string; type: string; required?: boolean; options?: readonly string[] | null }> },
  taken: readonly string[] = [],
): { name: string; slug: string; service_area_zips: string[]; questions: IntakeQuestion[] } {
  const name = form.name.trim();
  if (!name) throw new Error("Name the form.");
  const slug = form.slug?.trim() ? formSlug(form.slug) : formSlug(name);
  if (taken.includes(slug)) throw new Error("Another form already uses that link.");
  const zips = form.zips.map((z) => z.trim()).filter(Boolean);
  const badZips = zips.filter((z) => !/^\d{5}$/.test(z));
  if (badZips.length) throw new Error(`ZIP codes should be 5 digits: ${badZips.slice(0, 3).join(", ")}`);
  const questions = form.questions.filter((q) => q.type !== "address");
  if (questions.length > 30) throw new Error("A form can have at most 30 questions.");
  if (questions.some((q) => !(INTAKE_QUESTION_TYPES as readonly string[]).includes(q.type))) throw new Error(`Question types are: ${INTAKE_QUESTION_TYPES.join(", ")}.`);
  if (questions.some((q) => !q.label.trim())) throw new Error("Every question needs a label.");
  if (questions.some((q) => hasOptions(q.type) && !q.options?.some((o) => o.trim()))) throw new Error("Choice questions need options.");
  const keys = new Set<string>();
  const clean = questions.map((q) => {
    let key = q.key || formSlug(q.label).replace(/-/g, "_");
    while (keys.has(key)) key = `${key}_2`;
    keys.add(key);
    return {
      key,
      label: q.label.trim(),
      type: q.type as IntakeQuestionType,
      required: q.required === true,
      options: hasOptions(q.type) ? q.options?.map((o) => o.trim()).filter(Boolean) : undefined,
    };
  });
  return { name, slug, service_area_zips: [...new Set(zips)], questions: clean };
}

// ---------------------------------------------------------------------------------------------
// Checklists (public.checklist_templates)
// ---------------------------------------------------------------------------------------------

export const CHECKLIST_ITEM_TYPES = ["check", "number", "text", "choice", "photo", "signature"] as const;
export type ChecklistItemType = (typeof CHECKLIST_ITEM_TYPES)[number];

export interface ChecklistItem {
  key: string;
  label: string;
  type: ChecklistItemType;
  required: boolean;
  options?: string[];
  /** A guide the item links to. */
  sop_page_id?: string;
}

export const MAX_CHECKLIST_ITEMS = 60;

/** A key for an item, from its label, that none of `taken` uses. */
export function checklistItemKey(label: string, taken: readonly string[]): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
  let key = base;
  for (let i = 2; taken.includes(key); i++) key = `${base}_${i}`;
  return key;
}

/** A checklist ready to save: a name, and items with unique keys and trimmed labels and options. */
export function normalizeChecklist(checklist: {
  name: string;
  job_type?: string | null;
  items: ReadonlyArray<{ key?: string | null; label: string; type: string; required?: boolean; options?: readonly string[] | null; sop_page_id?: string | null }>;
}): { name: string; job_type: string | null; items: ChecklistItem[] } {
  const name = checklist.name.trim();
  if (!name) throw new Error("Name the checklist.");
  if (!checklist.items.length) throw new Error("Add at least one item.");
  if (checklist.items.length > MAX_CHECKLIST_ITEMS) throw new Error(`A checklist can have at most ${MAX_CHECKLIST_ITEMS} items.`);
  if (checklist.items.some((i) => !(CHECKLIST_ITEM_TYPES as readonly string[]).includes(i.type))) throw new Error(`Item types are: ${CHECKLIST_ITEM_TYPES.join(", ")}.`);
  if (checklist.items.some((i) => !i.label.trim())) throw new Error("Every item needs a label.");
  if (checklist.items.some((i) => i.type === "choice" && !i.options?.some((o) => o.trim()))) throw new Error("Choice items need at least one option.");
  const taken: string[] = [];
  const items = checklist.items.map((i) => {
    const key = i.key && !taken.includes(i.key) ? i.key : checklistItemKey(i.label, taken);
    taken.push(key);
    return {
      key,
      label: i.label.trim(),
      type: i.type as ChecklistItemType,
      required: i.required === true,
      options: i.type === "choice" ? i.options?.map((o) => o.trim()).filter(Boolean) : undefined,
      ...(i.sop_page_id ? { sop_page_id: i.sop_page_id } : {}),
    };
  });
  return { name, job_type: checklist.job_type?.trim() || null, items };
}
