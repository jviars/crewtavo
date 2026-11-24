/**
 * The business's own fields on a client, property, job, quote or invoice (Settings → Custom fields):
 * filled in under a record's other fields, and listed with its details when they have a value. The
 * rules for values (their types, what shows where) are core customFields.ts.
 */
import { CUSTOM_FIELD_LIMITS, customFieldsFor, customValueDraft, customValues, customValueText, saveCustomDrafts, shownCustomFields, type CustomFieldDef, type CustomFieldRecord, type CustomValue } from "@crewtavo/core/customFields";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, cx } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { companyCountry } from "@/lib/format";
import { useSession } from "@/lib/session";
import { t } from "@/lib/i18n";
import styles from "./CustomFields.module.css";
import { Select } from "@/components/ui/Select";

export interface CustomFieldRow {
  id: string;
  record_type: string;
  key: string;
  label: string;
  type: string;
  choices: string[];
  show_on_pdf: boolean;
  show_in_portal: boolean;
  sort: number;
  archived_at: string | null;
}

export const customFieldsKey = (companyId: string) => ["custom-fields", companyId] as const;

/** Every field the business has, archived ones too, in order. */
export const customFieldsQuery = (companyId: string) =>
  queryOptions({
    queryKey: customFieldsKey(companyId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CustomFieldRow[]> =>
      unwrap(await supabase().from("custom_field_definitions").select("id, record_type, key, label, type, choices, show_on_pdf, show_in_portal, sort, archived_at").eq("company_id", companyId).order("sort").order("created_at")),
  });

/** One kind of record's fields (archived ones too: core leaves them out wherever they'd show). None while they load. */
export function useCustomFields(record: CustomFieldRecord): CustomFieldRow[] {
  const { company } = useSession();
  const { data } = useQuery({ ...customFieldsQuery(company.id), meta: { silent: true } });
  return useMemo(() => (data ?? []).filter((f) => f.record_type === record), [data, record]);
}

/** A form's edits, saved onto the record's values (core saveCustomDrafts); says what doesn't fit instead. */
export function customFieldsToSave(fields: readonly CustomFieldRow[], current: unknown, draft: Readonly<Record<string, string>>): Record<string, CustomValue> {
  const { values, errors } = saveCustomDrafts(fields, current, draft);
  if (errors.length) throw new Error(errors.join(" "));
  return values;
}

/** How a value reads on a page: core's words (customValueText), with yes and no in the reader's language. */
function valueText(field: CustomFieldDef, value: unknown): string {
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  return customValueText(field, value, companyCountry()).trim();
}

/**
 * One field's control: a list for a choice or yes/no, else a text, number or date field. A choice
 * since taken off the field stays in the list until it's changed.
 */
function CustomFieldControl({ field: f, value, onChange, className }: { field: CustomFieldDef; value: string; onChange: (value: string) => void; className?: string }) {
  if (f.type === "choice" || f.type === "yes_no") {
    const options: Array<[string, string]> = f.type === "yes_no" ? [["yes", t("Yes")], ["no", t("No")]] : (f.choices ?? []).map((c) => [c, c]);
    return (
      <Select className={cx("select", className)} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("Not set")}</option>
        {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        {value && !options.some(([v]) => v === value) && <option value={value}>{value}</option>}
      </Select>
    );
  }
  return (
    <input
      className={cx("input", className)}
      type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
      step={f.type === "number" ? "any" : undefined}
      maxLength={f.type === "text" ? CUSTOM_FIELD_LIMITS.text : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="off"
    />
  );
}

/**
 * The fields in use, to fill in under a record's other fields. `draft` holds only what's been typed
 * here, by key; the rest show the record's `current` values.
 */
export function CustomFieldInputs({ fields, current, draft, onChange }: { fields: readonly CustomFieldRow[]; current: unknown; draft: Record<string, string>; onChange: (draft: Record<string, string>) => void }) {
  const shown = customFieldsFor(fields);
  if (!shown.length) return null;
  const values = customValues(current);
  return (
    <div className="form-grid">
      {shown.map((f) => (
        <Field key={f.key} label={f.label} optional>
          <CustomFieldControl field={f} value={draft[f.key] ?? customValueDraft(f, values[f.key])} onChange={(value) => onChange({ ...draft, [f.key]: value })} />
        </Field>
      ))}
    </div>
  );
}

/** The fields with a value, as rows of a details list (dl.kv). Nothing for the empty ones. */
export function CustomFieldList({ fields, values }: { fields: readonly CustomFieldRow[]; values: unknown }) {
  return (
    <>
      {shownCustomFields(fields, values, "record", companyCountry()).map((f) => (
        <Fragment key={f.key}>
          <dt>{f.label}</dt>
          <dd className="pre-wrap">{f.text}</dd>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The fields as Fact rows, for inside a <Facts> list: the ones with a value, or with `empty` every
 * field in use, an empty one as a quiet dash (read out as "Not set").
 */
export function CustomFieldFacts({ fields, values, empty = false }: { fields: readonly CustomFieldRow[]; values: unknown; empty?: boolean }) {
  const all = customValues(values);
  return (
    <>
      {customFieldsFor(fields).map((f) => {
        const text = valueText(f, all[f.key]);
        if (!text && !empty) return null;
        return (
          <Fact key={f.key} label={f.label}>
            {text ? (
              <span className="pre-wrap">{text}</span>
            ) : (
              <span className={styles.unset}>
                <span aria-hidden="true">—</span>
                <span className="sr-only">{t("Not set")}</span>
              </span>
            )}
          </Fact>
        );
      })}
    </>
  );
}

/**
 * A quote's or invoice's fields as a section of its page: label and value on hairline rows, and Edit
 * on the right to fill them in right there. Nothing while the business has none for it, or when none
 * has a value and it can't be edited.
 */
export function CustomFieldsCard({ record, values, editable, onSave }: { record: CustomFieldRecord; values: unknown; editable: boolean; onSave: (values: Record<string, CustomValue>) => Promise<unknown> }) {
  const fields = useCustomFields(record);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const open = editing && editable;

  // Back on Edit once the form closes, so the keyboard doesn't start over at the top of the page.
  useEffect(() => {
    if (open || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [open]);

  const hasValues = shownCustomFields(fields, values).length > 0;
  if (!customFieldsFor(fields).length || (!editable && !hasValues)) return null;
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };
  return (
    <Section
      title={t("Details")}
      action={editable && !open && <button ref={editButton} type="button" aria-label={t("Edit details")} onClick={() => setEditing(true)}>{t("Edit")}</button>}
    >
      {open ? (
        <CustomFieldsForm fields={fields} current={values} onSave={onSave} onDone={close} />
      ) : hasValues ? (
        <Facts>
          <CustomFieldFacts fields={fields} values={values} empty={editable} />
        </Facts>
      ) : (
        <EmptyState inline title={t("Nothing filled in yet")} />
      )}
    </Section>
  );
}

/**
 * The section's fields in place: each row's value becomes a quiet field, with Save and Cancel under
 * them. Escape cancels. Saving with nothing changed just closes it.
 */
function CustomFieldsForm({ fields, current, onSave, onDone }: { fields: readonly CustomFieldRow[]; current: unknown; onSave: (values: Record<string, CustomValue>) => Promise<unknown>; onDone: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const save = useMutation({
    meta: { inline: true, success: t("Details saved") },
    mutationFn: () => onSave(customFieldsToSave(fields, current, draft)),
    onSuccess: onDone,
  });
  const values = customValues(current);

  useEffect(() => {
    form.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!Object.keys(draft).length) onDone();
    else save.mutate();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || save.isPending) return;
    e.preventDefault();
    onDone();
  };

  return (
    <form ref={form} className={styles.form} onSubmit={submit} onKeyDown={onKeyDown}>
      <div className={styles.rows}>
        {customFieldsFor(fields).map((f) => (
          <Field key={f.key} label={f.label} className={styles.row}>
            <CustomFieldControl field={f} value={draft[f.key] ?? customValueDraft(f, values[f.key])} onChange={(value) => setDraft((d) => ({ ...d, [f.key]: value }))} className={styles.control} />
          </Field>
        ))}
      </div>
      <FormError error={save.error} />
      <div className={cx("form-actions", styles.actions)}>
        <FormChecks />
        <Button size="sm" variant="ghost" onClick={onDone} disabled={save.isPending}>{t("Cancel")}</Button>
        <Button size="sm" type="submit" variant="primary" loading={save.isPending}>{t("Save")}</Button>
      </div>
    </form>
  );
}
