import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { CustomFieldInputs, customFieldsToSave, useCustomFields } from "../customFields/CustomFields";

/**
 * Start a draft quote; the editor opens next for line items. It can start from a quote template
 * (`initialTemplate` picks one): a copy of its lines, options, sections and message for the client
 * picked (duplicate_quote), titled with the template's name unless another title is typed.
 */
export function NewQuoteDialog({ open, onClose, onCreated, initialClient = null, initialTemplate = null }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; initialClient?: PickedClient; initialTemplate?: string | null }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [templateId, setTemplateId] = useState("");
  const [client, setClient] = useState<PickedClient>(initialClient);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [custom, setCustom] = useState<Record<string, string>>({});
  const fields = useCustomFields("quote");
  const templates = useQuery({
    queryKey: ["quotes", company.id, "templates"],
    enabled: open,
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("quotes").select("id, title, custom_fields").eq("company_id", company.id).eq("is_template", true).order("title")),
  });
  const template = templates.data?.find((t) => t.id === templateId) ?? null;
  useEffect(() => setPropertyId(null), [client?.id]);
  // "New quote from it" on a template's page opens with that template picked.
  useEffect(() => {
    if (open && initialTemplate) setTemplateId(initialTemplate);
  }, [open, initialTemplate]);
  const create = useMutation({
    meta: { inline: true, success: "Quote created", tone: "quote" },
    mutationFn: async () => {
      // Checked before anything is made, so a value that doesn't fit leaves no quote behind.
      const values = Object.keys(custom).length ? customFieldsToSave(fields, template?.custom_fields ?? {}, custom) : null;
      if (template) {
        return unwrap(
          await supabase().rpc("duplicate_quote", {
            p_quote: template.id,
            p_client: client!.id,
            ...(propertyId ? { p_property: propertyId } : {}),
            ...(title.trim() ? { p_title: title.trim() } : {}),
            ...(values ? { p_custom_fields: values } : {}),
          }),
        );
      }
      const settings = company.settings as { default_tax_rate?: number; quote_valid_days?: number };
      return unwrap(
        await supabase()
          .from("quotes")
          .insert({
            company_id: company.id,
            client_id: client!.id,
            property_id: propertyId,
            title: title.trim(),
            tax_rate: Number(settings.default_tax_rate ?? 0),
            valid_until: addDaysIso(todayIn(company.timezone), Number(settings.quote_valid_days ?? 30)),
            ...(values ? { custom_fields: values } : {}),
          })
          .select("id")
          .single(),
      ).id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["quotes", company.id] });
      onCreated(id);
    },
  });
  // Cleared once it has animated out, so it opens fresh next time without blinking the last one.
  const reset = () => {
    setTemplateId("");
    setClient(initialClient);
    setTitle("");
    setPropertyId(null);
    setCustom({});
    create.reset();
  };
  return (
    <Dialog open={open} onClose={onClose} onExited={reset} title="New quote">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && (template || title.trim())) create.mutate(); }}>
        {(templates.data?.length ?? 0) > 0 && (
          <Field label="Start from" hint="A quote template brings its lines, options, contract sections and message.">
            <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">A blank quote</option>
              {templates.data!.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </Field>
        )}
        <Field label="Client" requiredMessage="Pick a client, or type a name to add a new one.">
          <ClientPicker value={client} onChange={setClient} />
          <ClientRequired client={client} />
        </Field>
        {client && <Field label="Property"><PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="Title" optional={Boolean(template)} requiredMessage="Give it a title, like Driveway replacement.">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value.trimStart())} required={!template} maxLength={200} placeholder={template?.title ?? "Driveway replacement"} />
        </Field>
        <CustomFieldInputs fields={fields} current={template?.custom_fields} draft={custom} onChange={setCustom} />
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create quote</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The client picker has no field of its own for the form to check, so this stands in for it inside
 * the Client field: a submit without a client says so under the picker and puts the cursor in its
 * search, and picking one clears it. A checkbox, so nothing focuses it as the dialog opens.
 */
export function ClientRequired({ client }: { client: PickedClient }) {
  const ref = useRef<HTMLInputElement>(null);
  // A pick sets it without an input event, which is what the field's and the form's checks follow.
  useEffect(() => {
    ref.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [client?.id]);
  return (
    <input
      ref={ref}
      type="checkbox"
      hidden
      required
      tabIndex={-1}
      aria-hidden="true"
      checked={Boolean(client)}
      onChange={() => undefined}
      onInvalid={(e) => e.currentTarget.closest(".field")?.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus()}
    />
  );
}
