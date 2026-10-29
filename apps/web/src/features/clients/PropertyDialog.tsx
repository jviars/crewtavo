import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { api, supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";

export interface PropertyRow {
  id: string;
  label: string | null;
  line1: string;
  line2?: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  notes: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface AccessRow {
  property_id: string;
  gate_code: string | null;
  lockbox_code: string | null;
  alarm_code?: string | null;
  instructions: string | null;
}

/** Add or edit a service address, including gate and lockbox codes (office only). */
export function PropertyDialog({ clientId, property, access, onClose }: { clientId: string; property?: PropertyRow; access?: AccessRow | null; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const isOffice = hasRole(session, "admin", "office");
  const [p, setP] = useState({
    label: property?.label ?? "",
    line1: property?.line1 ?? "",
    line2: property?.line2 ?? "",
    city: property?.city ?? "",
    region: property?.region ?? "",
    postal_code: property?.postal_code ?? "",
    notes: property?.notes ?? "",
    gate_code: access?.gate_code ?? "",
    lockbox_code: access?.lockbox_code ?? "",
    instructions: access?.instructions ?? "",
  });
  const set = (key: keyof typeof p) => (e: { target: { value: string } }) => setP({ ...p, [key]: e.target.value });
  const addressChanged = !property || ["line1", "line2", "city", "region", "postal_code"].some((k) => (property as unknown as Record<string, unknown>)[k] !== (p as Record<string, string>)[k]);

  const save = useMutation({
    meta: { inline: true, success: property ? "Property saved" : "Property added" },
    mutationFn: async () => {
      const fields = {
        label: p.label.trim() || null,
        line1: p.line1.trim(),
        line2: p.line2.trim() || null,
        city: p.city.trim() || null,
        region: p.region.trim() || null,
        postal_code: p.postal_code.trim() || null,
        notes: p.notes.trim() || null,
        // A new address needs a new map location.
        ...(addressChanged ? { lat: null, lng: null } : {}),
      };
      const id = property
        ? (unwrap(await supabase().from("properties").update(fields).eq("id", property.id)), property.id)
        : unwrap(await supabase().from("properties").insert({ company_id: session.company.id, client_id: clientId, ...fields }).select("id").single()).id;
      if (isOffice) {
        const codes = { gate_code: p.gate_code.trim() || null, lockbox_code: p.lockbox_code.trim() || null, instructions: p.instructions.trim() || null };
        if (codes.gate_code || codes.lockbox_code || codes.instructions || access) {
          unwrap(await supabase().from("property_access").upsert({ company_id: session.company.id, property_id: id, ...codes }));
        }
      }
      if (addressChanged) await api.post(`/properties/${id}/geocode`).catch(() => undefined);
      return id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={property ? "Edit property" : "Add property"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Label" optional><input className="input" value={p.label} onChange={set("label")} placeholder="Main office, Lot B, Rental #2…" maxLength={80} /></Field>
        {/* No leading spaces, so a street of only spaces is caught as missing. */}
        <Field label="Street address" requiredMessage="Add the street address so crews can find it."><input className="input" value={p.line1} onChange={(e) => setP({ ...p, line1: e.target.value.trimStart() })} required maxLength={200} autoComplete="off" /></Field>
        <Field label="Apartment, suite or unit" optional><input className="input" value={p.line2} onChange={set("line2")} maxLength={100} /></Field>
        <div className="form-grid-3">
          <Field label="City"><input className="input" value={p.city} onChange={set("city")} maxLength={100} /></Field>
          <Field label="State"><input className="input" value={p.region} onChange={set("region")} maxLength={20} /></Field>
          <Field label="ZIP"><input className="input" value={p.postal_code} onChange={set("postal_code")} maxLength={12} inputMode="numeric" /></Field>
        </div>
        {isOffice && (
          <div className="form-section">
            <h3>Access</h3>
            <p className="muted small" style={{ margin: "-8px 0 0" }}>Crews only see these on the day they're scheduled here.</p>
            <div className="form-grid">
              <Field label="Gate code" optional><input className="input" value={p.gate_code} onChange={set("gate_code")} maxLength={40} autoComplete="off" /></Field>
              <Field label="Lockbox code" optional><input className="input" value={p.lockbox_code} onChange={set("lockbox_code")} maxLength={40} autoComplete="off" /></Field>
            </div>
            <Field label="Access instructions" optional><textarea className="textarea" value={p.instructions} onChange={set("instructions")} maxLength={2000} placeholder="Dog in the back yard; park on the street…" /></Field>
          </div>
        )}
        <Field label="Property notes" optional><textarea className="textarea" value={p.notes} onChange={set("notes")} maxLength={4000} /></Field>
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>{property ? "Save property" : "Add property"}</Button>
        </div>
      </form>
    </Dialog>
  );
}
