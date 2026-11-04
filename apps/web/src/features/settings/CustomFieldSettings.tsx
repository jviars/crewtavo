/**
 * Settings → Custom fields: the business's own fields on clients, properties, jobs, quotes and
 * invoices, like a gate code or a permit number, in the order they show. A quote's and an invoice's
 * can print on the PDF and show on the Client Hub. A field that's no longer wanted is archived: its
 * values stay on each record, out of sight, until it's restored. Values are filled in on each record
 * (features/customFields); core customFields.ts has the rules.
 */
import { CUSTOM_FIELD_LIMITS, customFieldKey, type CustomFieldRecord, type CustomFieldType } from "@crewtavo/core/customFields";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton, Loading } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { customFieldsKey, customFieldsQuery, type CustomFieldRow } from "../customFields/CustomFields";
import { moveSection, nextSort } from "./ContractSettings";

const RECORDS: Array<[CustomFieldRecord, string]> = [["client", "Clients"], ["property", "Properties"], ["job", "Jobs"], ["quote", "Quotes"], ["invoice", "Invoices"]];
const TYPES: Array<[CustomFieldType, string]> = [["text", "Text"], ["number", "Number"], ["date", "Date"], ["choice", "Choice"], ["yes_no", "Yes or no"]];
const typeLabel = (type: string) => TYPES.find(([t]) => t === type)?.[1] ?? type;
/** Only quotes and invoices have a PDF and a Client Hub page. */
const sentToClients = (record: string) => record === "quote" || record === "invoice";

export function CustomFieldSettings() {
  const session = useSession();
  const canEdit = hasRole(session, "admin", "office") && can(session, "settings");
  const queryClient = useQueryClient();
  const [record, setRecord] = useState<CustomFieldRecord>("client");
  const [editing, setEditing] = useState<CustomFieldRow | "new" | null>(null);
  const fields = useQuery(customFieldsQuery(session.company.id));
  const refresh = () => queryClient.invalidateQueries({ queryKey: customFieldsKey(session.company.id) });
  const move = useMutation({
    meta: { inline: true },
    mutationFn: async (changes: Array<{ id: string; sort: number }>) =>
      Promise.all(changes.map(async (c) => unwrap(await supabase().from("custom_field_definitions").update({ sort: c.sort }).eq("id", c.id)))),
    onSettled: refresh,
  });
  const archive = useMutation({
    meta: { success: (_: unknown, v: { archived: boolean }) => (v.archived ? "Field archived" : "Field restored") },
    mutationFn: async ({ id, archived }: { id: string; archived: boolean }) =>
      unwrap(await supabase().from("custom_field_definitions").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id)),
    onSettled: refresh,
  });

  if (fields.isPending) return <Loading label="Loading your custom fields"><CardSkeleton lines={4} /></Loading>;
  if (fields.error) return <div className="card"><ErrorState error={fields.error} onRetry={() => fields.refetch()} /></div>;
  const rows = fields.data.filter((f) => f.record_type === record);
  const active = rows.filter((f) => !f.archived_at);
  const archived = rows.filter((f) => f.archived_at);
  const noun = RECORDS.find(([r]) => r === record)![1].toLowerCase();
  const moveRow = (id: string, by: -1 | 1) => {
    const changes = moveSection(active, id, by);
    if (changes.length && !move.isPending) move.mutate(changes);
  };

  return (
    <div className="stack">
      <div className="card card-pad stack-sm">
        <h2 className="section-title">Custom fields</h2>
        <p className="muted" style={{ margin: 0 }}>Your own fields, like a gate code, a permit number or a unit's model. They're filled in where each record is edited, and show on it once they have a value. Crews see a visit's job and property fields.</p>
      </div>
      {!canEdit && (
        <div className="callout">
          <Icon name="lock" size={20} />
          <span className="grow">Only people in the office who manage Settings can change these.</span>
        </div>
      )}
      <div className="row-between wrap">
        <div className="segmented" role="group" aria-label="Fields on" style={{ flexWrap: "wrap", maxWidth: "100%" }}>
          {RECORDS.map(([r, label]) => (
            <button key={r} type="button" aria-pressed={record === r} onClick={() => setRecord(r)}>{label}</button>
          ))}
        </div>
        {canEdit && <Button variant="primary" icon="plus" onClick={() => setEditing("new")}>Add a field</Button>}
      </div>
      <div className="card">
        {active.map((f, i) => (
          <div key={f.id} className="card-row">
            <span className="grow">
              <strong>{f.label}</strong>
              <span className="muted small" style={{ display: "block" }}>
                {typeLabel(f.type)}
                {f.type === "choice" ? `: ${f.choices.join(", ")}` : ""}
                {f.show_on_pdf ? " · On the PDF" : ""}
                {f.show_in_portal ? " · On the Client Hub" : ""}
              </span>
            </span>
            {canEdit && (
              <>
                <Button size="sm" variant="ghost" icon="chevronUp" aria-label={`Move ${f.label} up`} disabled={i === 0 || move.isPending} onClick={() => moveRow(f.id, -1)} />
                <Button size="sm" variant="ghost" icon="chevronDown" aria-label={`Move ${f.label} down`} disabled={i === active.length - 1 || move.isPending} onClick={() => moveRow(f.id, 1)} />
                <Button size="sm" variant="ghost" icon="edit" aria-label={`Edit ${f.label}`} onClick={() => setEditing(f)} />
                <Button size="sm" variant="ghost" icon="archive" aria-label={`Archive ${f.label}`} onClick={() => archive.mutate({ id: f.id, archived: true })} />
              </>
            )}
          </div>
        ))}
        {!active.length && <EmptyState inline title={`No fields on ${noun} yet`} />}
      </div>
      {archived.length > 0 && (
        <section className="stack-sm">
          <h3 className="section-title">Archived</h3>
          <p className="muted small" style={{ margin: 0 }}>Their values stay on each record, hidden. Restore one to show them again.</p>
          <div className="card">
            {archived.map((f) => (
              <div key={f.id} className="card-row">
                <span className="grow"><strong>{f.label}</strong><span className="muted small" style={{ display: "block" }}>{typeLabel(f.type)}</span></span>
                {canEdit && <Button size="sm" icon="undo" loading={archive.isPending && archive.variables?.id === f.id} onClick={() => archive.mutate({ id: f.id, archived: false })}>Restore</Button>}
              </div>
            ))}
          </div>
        </section>
      )}
      {editing && <FieldDialog record={record} field={editing === "new" ? null : editing} others={rows} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

/** Add a field to a kind of record, or change one. Its key comes from its first label and never changes, so its values stay put. */
function FieldDialog({ record, field, others, onClose, onSaved }: { record: CustomFieldRecord; field: CustomFieldRow | null; others: readonly CustomFieldRow[]; onClose: () => void; onSaved: () => void }) {
  const { company } = useSession();
  const [f, setF] = useState({
    label: field?.label ?? "",
    type: (field?.type ?? "text") as CustomFieldType,
    choices: field?.choices.join(", ") ?? "",
    show_on_pdf: field?.show_on_pdf ?? false,
    show_in_portal: field?.show_in_portal ?? false,
  });
  const sent = sentToClients(record);
  const save = useMutation({
    meta: { inline: true, success: field ? "Field saved" : "Field added" },
    mutationFn: async () => {
      const label = f.label.trim();
      // Two with one name would be confusing, and an import fills the first.
      if (others.some((o) => o.id !== field?.id && !o.archived_at && o.label.trim().toLowerCase() === label.toLowerCase())) throw new Error("There's already a field with that name.");
      const choices = [...new Set(f.choices.split(",").map((c) => c.trim().slice(0, CUSTOM_FIELD_LIMITS.choice)).filter(Boolean))].slice(0, CUSTOM_FIELD_LIMITS.choices);
      if (f.type === "choice" && !choices.length) throw new Error("Add the choices, separated by commas.");
      const row = { label, type: f.type, choices: f.type === "choice" ? choices : [], show_on_pdf: sent && f.show_on_pdf, show_in_portal: sent && f.show_in_portal };
      if (field) unwrap(await supabase().from("custom_field_definitions").update(row).eq("id", field.id));
      else unwrap(await supabase().from("custom_field_definitions").insert({ ...row, company_id: company.id, record_type: record, key: customFieldKey(label, others.map((o) => o.key)), sort: nextSort(others) }));
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={field ? "Edit field" : "Add a field"}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name"><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value.trimStart() })} required maxLength={CUSTOM_FIELD_LIMITS.label} placeholder="Gate code" /></Field>
        <Field label="Type" hint={field && f.type !== field.type ? "Values already filled in keep what was typed." : undefined}>
          <select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as CustomFieldType })}>
            {TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>)}
          </select>
        </Field>
        {f.type === "choice" && <Field label="Choices" hint="Separated by commas."><input className="input" value={f.choices} onChange={(e) => setF({ ...f, choices: e.target.value })} placeholder="Heat pump, Furnace, Boiler" required /></Field>}
        {sent && (
          <>
            <label className="switch-row"><input type="checkbox" className="switch" checked={f.show_on_pdf} onChange={(e) => setF({ ...f, show_on_pdf: e.target.checked })} />Print it on the PDF</label>
            <label className="switch-row"><input type="checkbox" className="switch" checked={f.show_in_portal} onChange={(e) => setF({ ...f, show_in_portal: e.target.checked })} />Show it on the Client Hub</label>
          </>
        )}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{field ? "Save field" : "Add field"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
