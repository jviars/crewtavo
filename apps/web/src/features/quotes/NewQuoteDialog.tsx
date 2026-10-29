import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";

/** Start a draft quote; the editor opens next for line items. */
export function NewQuoteDialog({ open, onClose, onCreated, initialClient = null }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; initialClient?: PickedClient }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [client, setClient] = useState<PickedClient>(initialClient);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  useEffect(() => setPropertyId(null), [client?.id]);
  const create = useMutation({
    meta: { inline: true, success: "Quote created", tone: "quote" },
    mutationFn: async () => {
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
    setClient(initialClient);
    setTitle("");
    setPropertyId(null);
    create.reset();
  };
  return (
    <Dialog open={open} onClose={onClose} onExited={reset} title="New quote">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && title.trim()) create.mutate(); }}>
        <Field label="Client" requiredMessage="Pick a client, or type a name to add a new one.">
          <ClientPicker value={client} onChange={setClient} />
          <ClientRequired client={client} />
        </Field>
        {client && <Field label="Property"><PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="Title" requiredMessage="Give it a title, like Driveway replacement.">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Driveway replacement" />
        </Field>
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
