/**
 * The business's own fields on a client, property, job, quote or invoice (Settings → Custom fields):
 * filled in under a record's other fields, and listed with its details when they have a value. The
 * rules for values (their types, what shows where) are core customFields.ts.
 */
import { CUSTOM_FIELD_LIMITS, customFieldsFor, customValueDraft, customValues, saveCustomDrafts, shownCustomFields, type CustomFieldRecord, type CustomValue } from "@crewtavo/core/customFields";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

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
      {shown.map((f) => {
        const value = draft[f.key] ?? customValueDraft(f, values[f.key]);
        const set = (e: { target: { value: string } }) => onChange({ ...draft, [f.key]: e.target.value });
        const options: Array<[string, string]> = f.type === "yes_no" ? [["yes", "Yes"], ["no", "No"]] : (f.choices ?? []).map((c) => [c, c]);
        return (
          <Field key={f.key} label={f.label} optional>
            {f.type === "choice" || f.type === "yes_no" ? (
              <select className="select" value={value} onChange={set}>
                <option value="">Not set</option>
                {options.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                {/* A choice since taken off the field stays until it's changed. */}
                {value && !options.some(([v]) => v === value) && <option value={value}>{value}</option>}
              </select>
            ) : (
              <input
                className="input"
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                step={f.type === "number" ? "any" : undefined}
                maxLength={f.type === "text" ? CUSTOM_FIELD_LIMITS.text : undefined}
                value={value}
                onChange={set}
                autoComplete="off"
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

/** The fields with a value, as rows of a details list (dl.kv). Nothing for the empty ones. */
export function CustomFieldList({ fields, values }: { fields: readonly CustomFieldRow[]; values: unknown }) {
  return (
    <>
      {shownCustomFields(fields, values).map((f) => (
        <Fragment key={f.key}>
          <dt>{f.label}</dt>
          <dd className="pre-wrap">{f.text}</dd>
        </Fragment>
      ))}
    </>
  );
}

/**
 * A quote's or invoice's fields in a card: the ones with a value, and Edit to fill them in. Nothing
 * while the business has none for it, or when none has a value and it can't be edited.
 */
export function CustomFieldsCard({ record, values, editable, onSave }: { record: CustomFieldRecord; values: unknown; editable: boolean; onSave: (values: Record<string, CustomValue>) => Promise<unknown> }) {
  const fields = useCustomFields(record);
  const [editing, setEditing] = useState(false);
  const shown = shownCustomFields(fields, values);
  if (!customFieldsFor(fields).length || (!editable && !shown.length)) return null;
  return (
    <div className="card card-pad stack-sm">
      <div className="row-between">
        <strong>Details</strong>
        {editable && <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
      </div>
      {shown.length ? <dl className="kv"><CustomFieldList fields={fields} values={values} /></dl> : <span className="muted small">Nothing filled in yet.</span>}
      {editing && <CustomFieldsDialog fields={fields} current={values} onSave={onSave} onClose={() => setEditing(false)} />}
    </div>
  );
}

function CustomFieldsDialog({ fields, current, onSave, onClose }: { fields: readonly CustomFieldRow[]; current: unknown; onSave: (values: Record<string, CustomValue>) => Promise<unknown>; onClose: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    meta: { inline: true, success: "Details saved" },
    mutationFn: () => onSave(customFieldsToSave(fields, current, draft)),
    onSuccess: onClose,
  });
  return (
    <Dialog open onClose={onClose} title="Details">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <CustomFieldInputs fields={fields} current={current} draft={draft} onChange={setDraft} />
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
