/**
 * Custom fields: a business's own fields on clients, properties, jobs, quotes and invoices
 * (custom_field_definitions), with each record's values in its custom_fields, keyed by the field's
 * key. The rules every screen, the Client Hub, the import and the AI assistants share: what a value
 * may be for its type, how it reads, and which show where. Carrying values from a quote to its job
 * and invoice is the database's (20261103000700_custom_fields.sql), so every way they're made does it.
 */

export const CUSTOM_FIELD_RECORDS = ["client", "property", "job", "quote", "invoice"] as const;
export type CustomFieldRecord = (typeof CUSTOM_FIELD_RECORDS)[number];
export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "choice", "yes_no"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
/** Keys Crewtavo keeps for itself: the client import's old-system ID. Never a field, never shown. */
export const RESERVED_FIELD_KEYS: readonly string[] = ["source_id"];
export const CUSTOM_FIELD_LIMITS = { label: 80, text: 1000, choices: 50, choice: 80 } as const;

/** A custom_field_definitions row, as much of it as these rules read. */
export interface CustomFieldDef {
  key: string;
  label: string;
  type: string;
  choices?: readonly string[] | null;
  show_on_pdf?: boolean;
  show_in_portal?: boolean;
  archived_at?: string | null;
  sort?: number;
}
export type CustomValue = string | number | boolean;
/** Where a field shows: on its record's page (every field in use), its PDF, or the Client Hub. */
export type CustomFieldPlace = "record" | "pdf" | "portal";
export interface ShownField { key: string; label: string; text: string }

/** A record's custom_fields as an object (anything else holds none). */
export const customValues = (raw: unknown): Record<string, unknown> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

/** A new field's key from its label ("Gate code" is gate_code), not one of `taken`. */
export function customFieldKey(label: string, taken: readonly string[]): string {
  const words = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  const base = !words ? "field" : /^\d/.test(words) ? `f_${words}` : words;
  let key = base;
  for (let n = 2; taken.includes(key) || RESERVED_FIELD_KEYS.includes(key); n++) key = `${base}_${n}`;
  return key;
}

const YES = /^(yes|y|true|1|x|on)$/i;
const NO = /^(no|n|false|0|off)$/i;

/** "2026-03-04", or "3/4/2026" as a spreadsheet writes it, as YYYY-MM-DD; null when it isn't a real day. */
function isoDay(text: string): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  const iso = us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  return iso && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A value for a field, checked against its type: the value to keep, null to clear it, or why it
 * can't be. Text is trimmed; a number can be written "1,200"; a date is YYYY-MM-DD (or 3/4/2026);
 * a choice is one of the field's, in any case; yes/no is true/false or "yes"/"no".
 */
export function checkCustomValue(field: CustomFieldDef, raw: unknown): { value: CustomValue | null } | { error: string } {
  if (raw === null || raw === undefined) return { value: null };
  const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
  if (text === null) return { error: `${field.label} can't be that.` };
  if (text === "") return { value: null };
  switch (field.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(text.replace(/[,$\s]/g, ""));
      return Number.isFinite(n) && Math.abs(n) < 1e15 ? { value: n } : { error: `${field.label} needs a number.` };
    }
    case "date": {
      const day = isoDay(text);
      return day ? { value: day } : { error: `${field.label} needs a date.` };
    }
    case "choice": {
      const choice = (field.choices ?? []).find((c) => c.toLowerCase() === text.toLowerCase());
      return choice ? { value: choice } : { error: `${field.label} is one of: ${(field.choices ?? []).join(", ")}.` };
    }
    case "yes_no":
      return typeof raw === "boolean" ? { value: raw } : YES.test(text) ? { value: true } : NO.test(text) ? { value: false } : { error: `${field.label} is yes or no.` };
    default:
      return text.length <= CUSTOM_FIELD_LIMITS.text ? { value: text } : { error: `${field.label} is ${CUSTOM_FIELD_LIMITS.text} characters at most.` };
  }
}

/**
 * A record's values with `changes` made, by key: a value is checked against its field, and an empty
 * one clears it. Only the fields given may change; any other value the record has (the import's
 * source_id, an archived field's) stays as it is. `errors` says what couldn't be, and nothing changes then.
 */
export function mergeCustomValues(fields: readonly CustomFieldDef[], current: unknown, changes: Readonly<Record<string, unknown>>): { values: Record<string, CustomValue>; errors: string[] } {
  const values = { ...customValues(current) } as Record<string, CustomValue>;
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(changes)) {
    const field = fields.find((f) => f.key === key && !f.archived_at);
    if (!field || RESERVED_FIELD_KEYS.includes(key)) {
      errors.push(`There's no custom field "${key}".`);
      continue;
    }
    const checked = checkCustomValue(field, raw);
    if ("error" in checked) errors.push(checked.error);
    else if (checked.value === null) delete values[key];
    else values[key] = checked.value;
  }
  return { values: errors.length ? ({ ...customValues(current) } as Record<string, CustomValue>) : values, errors };
}

/**
 * A form's text for each field (customValueDraft), saved onto the record's values: only what it
 * changed is checked, so a choice since taken off a field doesn't stop the rest from saving.
 */
export function saveCustomDrafts(fields: readonly CustomFieldDef[], current: unknown, drafts: Readonly<Record<string, string>>) {
  const values = customValues(current);
  const changed = Object.entries(drafts).filter(([key, text]) => {
    const field = fields.find((f) => f.key === key);
    return !field || text !== customValueDraft(field, values[key]);
  });
  return mergeCustomValues(fields, current, Object.fromEntries(changed));
}

/** How a value reads: "Yes", "1,200", "Mar 4, 2026", or its text. A value from before its field's type changed reads as it was typed. */
export function customValueText(field: Pick<CustomFieldDef, "type">, value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return field.type === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : String(value);
  if (typeof value !== "string") return "";
  const day = field.type === "date" ? isoDay(value) : null;
  return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : value;
}

/** A value as a form edits it: text for every type, with yes/no as "yes", "no" or "" (not set). */
export function customValueDraft(field: Pick<CustomFieldDef, "type">, value: unknown): string {
  if (field.type === "yes_no") return value === true ? "yes" : value === false ? "no" : "";
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** The fields a record shows, in order: never an archived one, and on the PDF or the Client Hub only the ones marked for it. */
export function customFieldsFor(fields: readonly CustomFieldDef[], where: CustomFieldPlace = "record"): CustomFieldDef[] {
  return fields
    .map((field, i) => ({ field, i }))
    .filter(({ field: f }) => !f.archived_at && !RESERVED_FIELD_KEYS.includes(f.key) && (where === "record" || (where === "pdf" ? f.show_on_pdf : f.show_in_portal)))
    .sort((a, b) => (a.field.sort ?? 0) - (b.field.sort ?? 0) || a.i - b.i)
    .map(({ field }) => field);
}

/** The fields with a value on a record, as they read there (customFieldsFor). Empty ones are left out. */
export function shownCustomFields(fields: readonly CustomFieldDef[], raw: unknown, where: CustomFieldPlace = "record"): ShownField[] {
  const values = customValues(raw);
  return customFieldsFor(fields, where).flatMap((f) => {
    const text = customValueText(f, values[f.key]).trim();
    return text ? [{ key: f.key, label: f.label, text }] : [];
  });
}

/** The field a spreadsheet column fills: the first one in use whose label is its header, in any case. */
export const fieldForHeader = <T extends CustomFieldDef>(fields: readonly T[], header: string): T | undefined =>
  fields.find((f) => !f.archived_at && f.label.trim().toLowerCase() === header.trim().toLowerCase());
