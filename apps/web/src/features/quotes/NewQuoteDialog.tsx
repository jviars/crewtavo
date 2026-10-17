import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
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
  useEffect(() => {
    if (open) {
      setClient(initialClient);
      setTitle("");
      setPropertyId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => setPropertyId(null), [client?.id]);
  const create = useMutation({
    meta: { inline: true, success: "Quote created" },
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
  return (
    <Dialog open={open} onClose={onClose} title="New quote">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); }}>
        <Field label="Client"><ClientPicker value={client} onChange={setClient} /></Field>
        {client && <Field label="Property"><PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="Driveway replacement" /></Field>
        <FormError error={create.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!client || !title.trim()}>Create quote</Button>
        </div>
      </form>
    </Dialog>
  );
}
