import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { ClientRequired } from "../quotes/NewQuoteDialog";
import styles from "./RequestPage.module.css";

/** How a request someone logs came in, with the icon its row on Requests shows. */
const SOURCES: Array<{ value: string; label: string; icon: IconName }> = [
  { value: "phone", label: "Phone", icon: "phone" },
  { value: "email", label: "Email", icon: "mail" },
  { value: "manual", label: "In person", icon: "users" },
];

/** Log a request that came in by phone, email or in person. */
export function NewRequestDialog({ open, onClose, onCreated, initialClient = null }: { open: boolean; onClose: () => void; onCreated: (id: string) => void; initialClient?: PickedClient }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [client, setClient] = useState<PickedClient>(initialClient);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [source, setSource] = useState("phone");
  useEffect(() => setPropertyId(null), [client?.id]);
  const create = useMutation({
    meta: { inline: true, success: "Request created", tone: "request" },
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("requests")
          .insert({ company_id: company.id, client_id: client!.id, property_id: propertyId, title: title.trim(), details: details.trim() || null, source })
          .select("id")
          .single(),
      ).id,
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["requests", company.id] });
      queryClient.invalidateQueries({ queryKey: ["client", client!.id] });
      onCreated(id);
    },
  });
  // Cleared once it has animated out, so it opens fresh next time without blinking the last one.
  const reset = () => {
    setClient(initialClient);
    setTitle("");
    setDetails("");
    setPropertyId(null);
    create.reset();
  };
  return (
    <Dialog open={open} onClose={onClose} onExited={reset} title="New request">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client && title.trim()) create.mutate(); }}>
        <Field label="Client" requiredMessage="Pick a client, or type a name to add a new one.">
          <ClientPicker value={client} onChange={setClient} />
          <ClientRequired client={client} />
        </Field>
        {client && <Field label="Property"><PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} /></Field>}
        <Field label="What do they need?" requiredMessage="Say what they need, like a driveway estimate.">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value.trimStart())} required maxLength={200} placeholder="Driveway estimate, gutter repair…" />
        </Field>
        <Field label="Details" optional><textarea className="textarea" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000} /></Field>
        <Field label="How did it come in?">
          {/* Three short choices: a switch, not a list to open. */}
          <div className={`segmented ${styles.sources}`} role="group" aria-label="How did it come in?">
            {SOURCES.map((s) => (
              <button key={s.value} type="button" aria-pressed={source === s.value} onClick={() => setSource(s.value)}>
                <Icon name={s.icon} size={15} />
                {s.label}
              </button>
            ))}
          </div>
        </Field>
        <FormError error={create.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create request</Button>
        </div>
      </form>
    </Dialog>
  );
}
