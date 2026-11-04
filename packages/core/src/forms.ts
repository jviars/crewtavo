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

/** A ZIP or postal code, from any country: letters, digits, spaces and dashes, up to 10 ("24141", "M5V 2T6", "SW1A 1AA"). */
export const isPostalCode = (s: string) => /^[A-Za-z0-9][A-Za-z0-9 -]{0,9}$/.test(s.trim());

const postalKey = (s: string) => s.toUpperCase().replace(/\s+/g, "");

/**
 * A booking form takes a request from its service areas, or anywhere when it has none. A postal code
 * is in an area when it starts with the area's code, ignoring case and spaces: "24141-1234" is in
 * "24141", and "M5V 2T6" in "M5V".
 */
export const inServiceArea = (postalCode: string | null | undefined, areas: readonly string[]) =>
  !areas.length || areas.some((area) => postalKey(area) && postalKey(postalCode ?? "").startsWith(postalKey(area)));

/**
 * A form ready to save: its link made from the slug or name, unique question keys, trimmed labels
 * and options, and its ZIP or postal codes in capitals. `taken` is the links the company's other forms use.
 */
export function normalizeIntakeForm(
  form: { name: string; slug?: string | null; zips: readonly string[]; questions: ReadonlyArray<{ key?: string | null; label: string; type: string; required?: boolean; options?: readonly string[] | null }> },
  taken: readonly string[] = [],
): { name: string; slug: string; service_area_zips: string[]; questions: IntakeQuestion[] } {
  const name = form.name.trim();
  if (!name) throw new Error("Name the form.");
  const slug = form.slug?.trim() ? formSlug(form.slug) : formSlug(name);
  if (taken.includes(slug)) throw new Error("Another form already uses that link.");
  const zips = form.zips.map((z) => z.trim().toUpperCase()).filter(Boolean);
  const badZips = zips.filter((z) => !isPostalCode(z));
  if (badZips.length) throw new Error(`Not a ZIP or postal code: ${badZips.slice(0, 3).join(", ")}`);
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
  items: ReadonlyArray<{ key?: string | null; label: string; type: string; required?: boolean; options?: readonly string[] | null; sop_page_id?: string | null }>;
}): { name: string; items: ChecklistItem[] } {
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
  return { name, items };
}

// ---------------------------------------------------------------------------------------------
// Filled-in checklists (public.checklist_responses)
// ---------------------------------------------------------------------------------------------

/**
 * One item of a filled-in checklist, as it reads. `text` is null when it isn't answered; a check is
 * "Yes" or "No". A signature reads as the printed name, with its drawing (`image`, a PNG data URL).
 * A photo item has no answer of its own: the field app adds its photos to the visit's. `missing` is
 * a required item the field app still asks for.
 */
export interface ChecklistAnswer {
  key: string;
  label: string;
  type: ChecklistItemType;
  text: string | null;
  image?: string;
  missing: boolean;
}

function answerText(type: ChecklistItemType, value: unknown): { text: string | null; image?: string } {
  if (type === "photo") return { text: null };
  if (type === "check") return { text: value === true ? "Yes" : "No" };
  // Older checklists stored a typed name; a drawn one is { name, image }, and only counts with the drawing.
  if (type === "signature" && value && typeof value === "object") {
    const { name, image } = value as { name?: unknown; image?: unknown };
    return typeof image === "string" && image ? { text: (typeof name === "string" && name.trim()) || "Signed", image } : { text: null };
  }
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return { text: text || null };
}

/**
 * A filled-in checklist's answers in its items' order, the same words wherever they show (a job,
 * a visit, the Client Hub, the invoice, the assistant, the data download). `items` is the checklist's
 * (checklist_templates.items); with the checklist deleted (null), each answer shows under its key.
 */
export function checklistAnswers(items: unknown, answers: unknown): ChecklistAnswer[] {
  const given = (answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {}) as Record<string, unknown>;
  const list: ReadonlyArray<Pick<ChecklistItem, "key" | "label" | "type" | "required">> = Array.isArray(items)
    ? (items as ChecklistItem[])
    : Object.entries(given).map(([key, v]) => ({ key, label: key.replace(/_/g, " "), type: (typeof v === "boolean" ? "check" : v && typeof v === "object" ? "signature" : "text") as ChecklistItemType, required: false }));
  return list.map((item) => {
    const value = given[item.key];
    const read = answerText(item.type, value);
    const answered = item.type === "check" ? value === true : read.text !== null;
    return { key: item.key, label: item.label, type: item.type, ...read, missing: item.required && item.type !== "photo" && !answered };
  });
}

/** A filled-in checklist as its client sees it (Show to client on), on a past visit and the invoice. */
export interface ClientChecklist {
  name: string;
  /** The visit's day. */
  visit_on: string | null;
  answers: Array<{ label: string; text: string }>;
}

/**
 * What a client is shown of a checklist's answers: the answered items in words. Never photos (they
 * are the visit's, not the item's), drawings, or answers to items the checklist no longer has.
 */
export const clientAnswers = (items: unknown, answers: unknown): ClientChecklist["answers"] =>
  checklistAnswers(Array.isArray(items) ? items : [], answers).flatMap((a) => (a.text !== null && a.type !== "photo" ? [{ label: a.label, text: a.text }] : []));
