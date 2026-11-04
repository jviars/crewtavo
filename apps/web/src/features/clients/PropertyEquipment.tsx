/**
 * Equipment at this property: the client's own water heater, AC unit or pool pump (property_assets),
 * not the business's fleet. On a client's property cards, the job page and a visit in the field app.
 * Opening an item shows its details and its service history: the visits that ticked it, with their
 * crew and checklists. The office adds, edits and retires items; in the field the crew adds one,
 * keeps its notes, and ticks what this visit serviced.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, todayIn } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { ASSET_FIELDS, ASSET_NAMES, assetDetails, byNewest, warrantyNote, type PropertyAsset, type ServiceVisit } from "./propertyAssets";

const assetsKey = (propertyId: string) => ["property-assets", propertyId];

/**
 * The property's equipment. `inCard` sits inside a property card; otherwise it's a card of its own.
 * With `visitId` (the field app) each item can be ticked as serviced on that visit, retired ones are
 * left out, and anyone on the visit can add one.
 */
export function PropertyEquipment({ propertyId, visitId, inCard }: { propertyId: string | null; visitId?: string; inCard?: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  // The office edits everything; the field adds items and keeps notes (the database holds it to that).
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const canAdd = isOffice || Boolean(visitId);
  const [open, setOpen] = useState<PropertyAsset | "new" | null>(null);
  const list = useQuery({
    queryKey: assetsKey(propertyId ?? ""),
    enabled: Boolean(propertyId),
    queryFn: async () => unwrap(await supabase().from("property_assets").select(ASSET_FIELDS).eq("property_id", propertyId!).order("status").order("name")) as PropertyAsset[],
  });
  const ticked = useQuery({
    queryKey: ["visit-assets", visitId],
    enabled: Boolean(visitId),
    queryFn: async () => new Set(unwrap(await supabase().from("visit_assets").select("asset_id").eq("visit_id", visitId!)).map((r) => r.asset_id)),
  });
  const tick = useMutation({
    meta: { inline: true },
    mutationFn: async ({ asset, on }: { asset: PropertyAsset; on: boolean }) =>
      unwrap(
        on
          ? await supabase().from("visit_assets").insert({ company_id: session.company.id, visit_id: visitId!, asset_id: asset.id })
          : await supabase().from("visit_assets").delete().eq("visit_id", visitId!).eq("asset_id", asset.id),
      ),
    onSettled: (_d, _e, { asset }) => {
      queryClient.invalidateQueries({ queryKey: ["visit-assets", visitId] });
      queryClient.invalidateQueries({ queryKey: ["property-asset-history", asset.id] });
    },
  });

  const today = todayIn(session.company.timezone);
  const items = (list.data ?? []).filter((a) => !visitId || a.status === "active");
  // No property, or nothing recorded and nothing to add: no section at all.
  if (!propertyId || (list.isSuccess && !items.length && !canAdd)) return null;

  const body = (
    <>
      <div className="row-between">
        <strong className={inCard ? "small" : undefined}>Equipment at this property</strong>
        {canAdd && <Button size="sm" variant="ghost" icon="plus" onClick={() => setOpen("new")}>Add equipment</Button>}
      </div>
      {list.isPending && <Skeleton width="60%" />}
      {items.map((a) => {
        const line = [assetDetails(a), warrantyNote(a.warranty_until, today)].filter(Boolean).join(" · ");
        return (
          <div key={a.id} className="row" style={{ alignItems: "flex-start", gap: 10 }}>
            <button type="button" className="link-btn grow" style={{ textAlign: "left", minWidth: 0 }} onClick={() => setOpen(a)}>
              <span className={a.status === "retired" ? "muted" : "strong"}>{a.name}</span>
              {a.status === "retired" && <span className="chip" style={{ marginLeft: 6 }}>Retired</span>}
              {line && <span className="muted small" style={{ display: "block" }}>{line}</span>}
            </button>
            {visitId && (
              <label className="checkbox small">
                <input type="checkbox" checked={ticked.data?.has(a.id) ?? false} disabled={ticked.isPending || tick.isPending} onChange={(e) => tick.mutate({ asset: a, on: e.target.checked })} />
                <span>Serviced</span>
              </label>
            )}
          </div>
        );
      })}
      <FormError error={tick.error} />
      {open && <AssetDialog propertyId={propertyId} asset={open === "new" ? null : open} isOffice={isOffice} visitId={visitId} onClose={() => setOpen(null)} />}
    </>
  );
  return inCard ? <div className="stack-sm" style={{ marginTop: 4 }}>{body}</div> : <section className="card card-pad stack-sm">{body}</section>;
}

/** Add an item, or open one: its details (the office edits them all, the field its notes) and its service history. */
function AssetDialog({ propertyId, asset, isOffice, visitId, onClose }: { propertyId: string; asset: PropertyAsset | null; isOffice: boolean; visitId?: string; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const names = useId();
  // A new item is the person's to fill in; an existing one is the office's, but for its notes.
  const locked = Boolean(asset) && !isOffice;
  const [f, setF] = useState({
    name: asset?.name ?? "",
    make: asset?.make ?? "",
    model: asset?.model ?? "",
    serial: asset?.serial ?? "",
    installed_on: asset?.installed_on ?? "",
    warranty_until: asset?.warranty_until ?? "",
    location: asset?.location ?? "",
    notes: asset?.notes ?? "",
    status: asset?.status ?? "active",
  });
  const [photo, setPhoto] = useState<File | null>(null);
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const photoUrl = useQuery({
    queryKey: ["property-asset-photo", asset?.photo_path],
    enabled: Boolean(asset?.photo_path),
    meta: { silent: true },
    queryFn: async () => (await signedUrls([asset!.photo_path!]))[asset!.photo_path!] ?? null,
  });

  const save = useMutation({
    meta: { inline: true, success: asset ? "Equipment saved" : "Equipment added" },
    mutationFn: async () => {
      if (locked) return unwrap(await supabase().from("property_assets").update({ notes: f.notes.trim() || null }).eq("id", asset!.id));
      const row = {
        name: f.name.trim(),
        make: f.make.trim() || null,
        model: f.model.trim() || null,
        serial: f.serial.trim() || null,
        installed_on: f.installed_on || null,
        warranty_until: f.warranty_until || null,
        location: f.location.trim() || null,
        notes: f.notes.trim() || null,
        status: f.status,
        photo_path: photo ? await uploadFile(session.company.id, "property-equipment", photo) : asset?.photo_path ?? null,
      };
      if (asset) return unwrap(await supabase().from("property_assets").update(row).eq("id", asset.id));
      const made = unwrap(await supabase().from("property_assets").insert({ ...row, company_id: session.company.id, property_id: propertyId }).select("id").single());
      // Added on a visit: it's what the visit serviced.
      if (visitId) unwrap(await supabase().from("visit_assets").insert({ company_id: session.company.id, visit_id: visitId, asset_id: made.id }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: assetsKey(propertyId) });
      queryClient.invalidateQueries({ queryKey: ["visit-assets", visitId] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={asset ? asset.name : "Add equipment"} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="What it is" hint={asset ? undefined : "Water heater, AC unit, pool pump…"}>
          <input className="input" list={names} value={f.name} onChange={set("name")} required maxLength={120} disabled={locked} autoFocus={!asset} />
        </Field>
        <datalist id={names}>{ASSET_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
        <div className="form-grid-3">
          <Field label="Make" optional><input className="input" value={f.make} onChange={set("make")} maxLength={80} disabled={locked} placeholder="Rheem, Carrier, Pentair" /></Field>
          <Field label="Model" optional><input className="input" value={f.model} onChange={set("model")} maxLength={80} disabled={locked} /></Field>
          <Field label="Serial number" optional><input className="input" value={f.serial} onChange={set("serial")} maxLength={80} disabled={locked} /></Field>
        </div>
        <div className="form-grid-3">
          <Field label="Installed" optional><input className="input" type="date" value={f.installed_on} onChange={set("installed_on")} disabled={locked} /></Field>
          <Field label="Warranty until" optional><input className="input" type="date" value={f.warranty_until} onChange={set("warranty_until")} disabled={locked} /></Field>
          <Field label="Where it is" optional><input className="input" value={f.location} onChange={set("location")} maxLength={120} disabled={locked} placeholder="Basement, attic, side yard" /></Field>
        </div>
        {asset && isOffice && (
          <Field label="Status">
            <select className="select" value={f.status} onChange={set("status")}>
              <option value="active">In use</option>
              <option value="retired">Retired (removed or replaced)</option>
            </select>
          </Field>
        )}
        <Field label="Notes" optional hint="Filter size, refrigerant, quirks."><textarea className="textarea" value={f.notes} onChange={set("notes")} maxLength={4000} rows={3} /></Field>
        {photoUrl.data && <a href={photoUrl.data} target="_blank" rel="noreferrer"><img src={photoUrl.data} alt={asset?.name} style={{ maxWidth: 240, borderRadius: 8, display: "block" }} /></a>}
        {!locked && (
          <label className="dropzone" style={{ padding: 14 }}>
            <Icon name="camera" size={20} />
            <span className="small strong">{photo ? photo.name : asset?.photo_path ? "Replace the photo" : "Add a photo of its label"}</span>
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {asset && <ServiceHistory assetId={asset.id} />}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} slowHint={photo ? false : undefined}>{asset ? "Save" : "Add equipment"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The visits that ticked an item, with who did it and the checklists filled in on each (those the person can see). */
function ServiceHistory({ assetId }: { assetId: string }) {
  const history = useQuery({
    queryKey: ["property-asset-history", assetId],
    queryFn: async () => {
      const links = unwrap(
        await supabase()
          .from("visit_assets")
          .select("visit:visits(id, title, scheduled_on, completed_at, crew:crews(name), assignees:visit_assignees(user_id), checklists:checklist_responses(id, completed_at, template:checklist_templates(name)))")
          .eq("asset_id", assetId),
      );
      const visits = byNewest(links.flatMap((l) => (l.visit ? [l.visit as unknown as ServiceVisit] : [])));
      // Who was on a visit with no crew.
      const ids = [...new Set(visits.filter((v) => !v.crew).flatMap((v) => v.assignees.map((a) => a.user_id)))];
      const people = ids.length ? unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const name = new Map(people.map((p) => [p.user_id, p.full_name]));
      return visits.map((v) => ({ ...v, who: v.crew?.name ?? v.assignees.map((a) => name.get(a.user_id)).filter(Boolean).join(", ") }));
    },
  });
  return (
    <div className="form-section">
      <h3>Service history</h3>
      {history.isPending && <Skeleton width="50%" />}
      {history.data?.length === 0 && <span className="muted small">No visits yet. A crew ticks Serviced on the visit.</span>}
      {history.data?.map((v) => (
        <div key={v.id} className="small">
          <strong>{formatDate(v.completed_at ?? v.scheduled_on)}</strong> · {v.title}
          {v.who && <span className="muted"> · {v.who}</span>}
          {v.checklists.length > 0 && <span className="muted"> · {v.checklists.map((c) => `${c.template?.name ?? "Checklist"}${c.completed_at ? "" : " (not finished)"}`).join(", ")}</span>}
        </div>
      ))}
    </div>
  );
}
