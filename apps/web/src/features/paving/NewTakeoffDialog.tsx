/**
 * Starting a paving takeoff: who it's for and where, then straight onto the map. The project is a
 * draft quote, so the takeoff, estimate and proposal all live on one record.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { PropertyDialog } from "../clients/PropertyDialog";

export function NewTakeoffDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [client, setClient] = useState<PickedClient>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [addingAddress, setAddingAddress] = useState(false);
  useEffect(() => {
    if (open) {
      setClient(null);
      setPropertyId(null);
      setTitle("");
    }
  }, [open]);
  useEffect(() => setPropertyId(null), [client?.id]);

  const create = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const settings = company.settings as { default_tax_rate?: number; quote_valid_days?: number };
      const db = supabase();
      const street = propertyId ? unwrap(await db.from("properties").select("line1").eq("id", propertyId).maybeSingle())?.line1 : null;
      const quote = unwrap(
        await db
          .from("quotes")
          .insert({
            company_id: company.id,
            client_id: client!.id,
            property_id: propertyId,
            title: title.trim() || (street ? `Paving at ${street}` : "Paving takeoff"),
            tax_rate: Number(settings.default_tax_rate ?? 0),
            valid_until: addDaysIso(todayIn(company.timezone), Number(settings.quote_valid_days ?? 30)),
          })
          .select("id")
          .single(),
      );
      return quote.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["quotes", company.id] });
      queryClient.invalidateQueries({ queryKey: ["paving-projects", company.id] });
      const at = new URLSearchParams({ quote: id, paving: "1", ...(propertyId ? { property: propertyId } : {}) });
      navigate(`/measure?${at}`);
    },
  });

  return (
    <>
      {/* Adding an address opens over this one: closing a native dialog would close the takeoff too. */}
      <Dialog open={open} onClose={onClose} title="New takeoff" description="Who it's for and where. The map opens next, at the property.">
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); }}>
          <Field label="Client"><ClientPicker value={client} onChange={setClient} /></Field>
          {client && (
            <Field label="Property">
              <div className="stack-sm">
                <PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} />
                <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setAddingAddress(true)}>Add an address</button>
              </div>
            </Field>
          )}
          <Field label="Project name" hint="Optional. For example: Lot sealcoat and restripe.">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Lot sealcoat and restripe" />
          </Field>
          <FormError error={create.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="area" loading={create.isPending} disabled={!client}>Start the takeoff</Button>
          </div>
        </form>
      </Dialog>
      {addingAddress && client && <PropertyDialog clientId={client.id} onClose={() => setAddingAddress(false)} />}
    </>
  );
}
