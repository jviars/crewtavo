/**
 * Starting a paving takeoff or a roof estimate: who it's for and where (and, for a roof, which
 * package prices it), then straight onto the map. The project is a draft quote, so the takeoff,
 * estimate and proposal all live on one record.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, todayIn } from "@/lib/format";
import { useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { PropertyDialog } from "../clients/PropertyDialog";
import { canEditPackages, canSetUpRoofing, packagesKey, setUpRoofing, setupMessage, useRoofPackages } from "../roofing/packages";
import { PackagePicker } from "../roofing/RoofPackagesPage";

const WORDS = {
  paving: { title: "New takeoff", description: "Who it's for and where. The map opens next, at the property.", name: "Lot sealcoat and restripe", at: "Paving at", untitled: "Paving takeoff", start: "Start the takeoff" },
  roofing: { title: "New roof estimate", description: "Two quick picks, then you measure the roof on the map.", name: "Full roof replacement", at: "Roof at", untitled: "Roof estimate", start: "Measure the roof" },
} as const;

export function NewTakeoffDialog({ open, onClose, trade = "paving" }: { open: boolean; onClose: () => void; trade?: keyof typeof WORDS }) {
  const words = WORDS[trade];
  const roofing = trade === "roofing";
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [client, setClient] = useState<PickedClient>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [packageId, setPackageId] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const kindId = useId();
  useEffect(() => {
    if (open) {
      setClient(null);
      setPropertyId(null);
      setTitle("");
      setPackageId(null);
    }
  }, [open]);
  useEffect(() => setPropertyId(null), [client?.id]);

  // A roof estimate starts from a package: the default one unless another is picked.
  const packages = useRoofPackages({ enabled: roofing && open });
  const list = packages.data ?? [];
  const chosen = list.find((p) => p.id === packageId) ?? list.find((p) => p.is_default) ?? list[0] ?? null;
  const setup = useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
      queryClient.invalidateQueries({ queryKey: ["services", company.id] });
    },
  });

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
            title: title.trim() || (street ? `${words.at} ${street}` : words.untitled),
            tax_rate: Number(settings.default_tax_rate ?? 0),
            valid_until: addDaysIso(todayIn(company.timezone), Number(settings.quote_valid_days ?? 30)),
            ...(roofing && chosen ? { roof_package_id: chosen.id } : {}),
          })
          .select("id")
          .single(),
      );
      return quote.id;
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ["quotes", company.id] });
      queryClient.invalidateQueries({ queryKey: [`${trade}-projects`, company.id] });
      const at = new URLSearchParams({ quote: id, [trade]: "1", ...(propertyId ? { property: propertyId } : {}) });
      navigate(`/measure?${at}`);
    },
  });

  return (
    <>
      {/* Adding an address opens over this one: closing a native dialog would close the takeoff too. */}
      <Dialog open={open} onClose={onClose} title={words.title} description={words.description} size={roofing ? "lg" : "md"}>
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (client) create.mutate(); }}>
          <Field label={roofing ? "Who's it for?" : "Client"}><ClientPicker value={client} onChange={setClient} /></Field>
          {client && (
            <Field label="Property">
              <div className="stack-sm">
                <PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} />
                <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setAddingAddress(true)}>Add an address</button>
              </div>
            </Field>
          )}
          {roofing && (
            <div className="field" role="group" aria-labelledby={kindId} style={{ minWidth: 0 }}>
              <span id={kindId} className="field-label">What kind of roof?</span>
              {packages.isPending ? (
                <div className="row" style={{ gap: 12 }} aria-hidden="true">
                  <Skeleton height={150} radius={12} style={{ flex: 1 }} />
                  <Skeleton height={150} radius={12} style={{ flex: 1 }} />
                  <Skeleton height={150} radius={12} style={{ flex: 1 }} />
                </div>
              ) : packages.error ? (
                <ErrorState compact error={packages.error} onRetry={() => packages.refetch()} />
              ) : list.length ? (
                <div className="stack-sm">
                  <PackagePicker packages={list} value={chosen?.id ?? null} onChange={setPackageId} />
                  <span className="hint">
                    You can switch packages later.{" "}
                    {canEditPackages(session) && <Link to="/roofing/packages">Edit packages</Link>}
                  </span>
                </div>
              ) : canSetUpRoofing(session) ? (
                <div className="callout callout-info" style={{ fontWeight: 400 }}>
                  <Icon name="package" size={18} />
                  <span className="grow stack-sm" style={{ gap: 8 }}>
                    <span>Packages price a roof in one tap: Architectural shingle, Designer shingle and Standing-seam metal, from your price list.</span>
                    <Button size="sm" variant="primary" icon="package" style={{ justifySelf: "start" }} loading={setup.isPending} onClick={() => setup.mutate()}>Set up the standard packages</Button>
                  </span>
                </div>
              ) : (
                <span className="hint">No roof packages yet, so you'll price this roof by hand. The office can set them up in Roofing → Packages.</span>
              )}
            </div>
          )}
          <Field label="Project name" hint={`Optional. For example: ${words.name}.`}>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={words.name} />
          </Field>
          <FormError error={create.error} />
          <div className="form-actions">
            {roofing && (
              <>
                <span className="muted small row hide-mobile" style={{ gap: 6 }}>
                  <Icon name="pin" size={16} />Next: outline the roof on the aerial photo
                </span>
                <span className="spacer" />
              </>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="area" loading={create.isPending} disabled={!client || (roofing && setup.isPending)}>{words.start}</Button>
          </div>
        </form>
      </Dialog>
      {addingAddress && client && <PropertyDialog clientId={client.id} onClose={() => setAddingAddress(false)} />}
    </>
  );
}
