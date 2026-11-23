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
import { cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { signedUrls, uploadFile } from "@/lib/files";
import { formatDate, todayIn } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { ASSET_FIELDS, ASSET_NAMES, assetDetails, byNewest, warrantyNote, type PropertyAsset, type ServiceVisit } from "./propertyAssets";
import { t } from "@/lib/i18n";
import styles from "./clients.module.css";
import { Select } from "@/components/ui/Select";

const assetsKey = (propertyId: string) => ["property-assets", propertyId];

/**
 * The property's equipment, each item a hairline row that opens it. `inCard` sits inside another
 * section: under the job page's client facts with a quiet label, or in a visit's own "Equipment at
 * this property" section as rows alone; otherwise it's a Section of its own. With `visitId` (the
 * field app) each item can be ticked as serviced on that visit, retired ones are left out, anyone
 * on the visit can add one, and Add equipment is the last row in green words. `inRow` is a client page's property row: each item a
 * quiet line, nothing at all while there are none, and Add equipment in the row's menu (`adding`).
 */
export function PropertyEquipment({ propertyId, visitId, inCard, inRow, adding, onAddingDone }: { propertyId: string | null; visitId?: string; inCard?: boolean; inRow?: boolean; adding?: boolean; onAddingDone?: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  // The office edits everything; the field adds items and keeps notes (the database holds it to that).
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const canAdd = isOffice || Boolean(visitId);
  const [picked, setOpen] = useState<PropertyAsset | "new" | null>(null);
  const open = picked ?? (adding ? "new" : null);
  const close = () => {
    setOpen(null);
    onAddingDone?.();
  };
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
  const dialog = open && <AssetDialog propertyId={propertyId} asset={open === "new" ? null : open} isOffice={isOffice} visitId={visitId} onClose={close} />;

  if (inRow) {
    if (!items.length) return dialog || null;
    return (
      <div className={styles.equipment}>
        {items.map((a) => {
          const line = [assetDetails(a), warrantyNote(a.warranty_until, today)].filter(Boolean).join(" · ");
          return (
            <button key={a.id} type="button" className={styles.asset} onClick={() => setOpen(a)}>
              <Icon name="wrench" size={12} />
              <span className={styles.assetName} data-retired={a.status === "retired" || undefined}>{a.name}</span>
              {a.status === "retired" && <span> · {t("Retired")}</span>}
              {line && <span className={styles.assetLine}> · {line}</span>}
            </button>
          );
        })}
        {dialog}
      </div>
    );
  }

  const rows = items.length > 0 && (
    <RelatedList label={t("Equipment at this property")}>
      {items.map((a) => (
        <RelatedRow
          key={a.id}
          onClick={() => setOpen(a)}
          title={a.name}
          sub={[assetDetails(a), warrantyNote(a.warranty_until, today)]}
          end={a.status === "retired" ? <span className={styles.retired}>{t("Retired")}</span> : undefined}
          actions={visitId && (
            <label className={cx("checkbox", styles.serviced)}>
              <input type="checkbox" checked={ticked.data?.has(a.id) ?? false} disabled={ticked.isPending || tick.isPending} onChange={(e) => tick.mutate({ asset: a, on: e.target.checked })} />
              <span>{t("Serviced")}</span>
            </label>
          )}
        />
      ))}
    </RelatedList>
  );
  // In the field the last row adds one, in green words like the visit's Add work; for the office it's a quiet row.
  const add = canAdd && (
    <button type="button" className={visitId ? cx("field-add", styles.fieldAdd) : styles.equipAdd} onClick={() => setOpen("new")}>
      <Icon name="plus" size={visitId ? 18 : 14} />
      {t("Add equipment")}
    </button>
  );
  const parts = (
    <>
      {list.isPending && <Skeleton width="60%" />}
      {rows}
      {add}
      <FormError error={tick.error} />
      {dialog}
    </>
  );
  // A visit's own section names it already; on the job page it sits under the client's facts with a quiet label.
  if (inCard) {
    return visitId ? parts : (
      <div className={styles.equipBlock}>
        <h3 className={styles.equipLabel}>{t("Equipment at this property")}</h3>
        {parts}
      </div>
    );
  }
  return <Section title={t("Equipment at this property")} count={items.length || undefined}>{parts}</Section>;
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
    meta: { inline: true, success: asset ? t("Equipment saved") : t("Equipment added") },
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
    <Dialog open onClose={onClose} title={asset ? asset.name : t("Add equipment")} size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label={t("What it is")} hint={asset ? undefined : t("Water heater, AC unit, pool pump…")}>
          <input className="input" list={names} value={f.name} onChange={set("name")} required maxLength={120} disabled={locked} autoFocus={!asset} />
        </Field>
        <datalist id={names}>{ASSET_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
        <div className="form-grid-3">
          <Field label={t("Make")} optional><input className="input" value={f.make} onChange={set("make")} maxLength={80} disabled={locked} placeholder={t("Rheem, Carrier, Pentair")} /></Field>
          <Field label={t("Model")} optional><input className="input" value={f.model} onChange={set("model")} maxLength={80} disabled={locked} /></Field>
          <Field label={t("Serial number")} optional><input className="input" value={f.serial} onChange={set("serial")} maxLength={80} disabled={locked} /></Field>
        </div>
        <div className="form-grid-3">
          <Field label={t("Installed")} optional><input className="input" type="date" value={f.installed_on} onChange={set("installed_on")} disabled={locked} /></Field>
          <Field label={t("Warranty until")} optional><input className="input" type="date" value={f.warranty_until} onChange={set("warranty_until")} disabled={locked} /></Field>
          <Field label={t("Where it is")} optional><input className="input" value={f.location} onChange={set("location")} maxLength={120} disabled={locked} placeholder={t("Basement, attic, side yard")} /></Field>
        </div>
        {asset && isOffice && (
          <Field label={t("Status")}>
            <Select className="select" value={f.status} onChange={set("status")}>
              <option value="active">{t("In use")}</option>
              <option value="retired">{t("Retired (removed or replaced)")}</option>
            </Select>
          </Field>
        )}
        <Field label={t("Notes")} optional hint={t("Filter size, refrigerant, quirks.")}><textarea className="textarea" value={f.notes} onChange={set("notes")} maxLength={4000} rows={3} /></Field>
        {photoUrl.data && <a href={photoUrl.data} target="_blank" rel="noreferrer"><img src={photoUrl.data} alt={asset?.name} style={{ maxWidth: 240, borderRadius: 8, display: "block" }} /></a>}
        {!locked && (
          <label className="dropzone" style={{ padding: 14 }}>
            <Icon name="camera" size={20} />
            <span className="small strong">{photo ? photo.name : asset?.photo_path ? t("Replace the photo") : t("Add a photo of its label")}</span>
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
        )}
        {asset && <ServiceHistory assetId={asset.id} />}
        <FormError error={save.error} />
        <div className="form-actions">
          <FormChecks />
          <Button onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} slowHint={photo ? false : undefined}>{asset ? t("Save") : t("Add equipment")}</Button>
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
      <h3>{t("Service history")}</h3>
      {history.isPending && <Skeleton width="50%" />}
      {history.data?.length === 0 && <span className="muted small">{t("No visits yet. A crew ticks Serviced on the visit.")}</span>}
      {history.data?.map((v) => (
        <div key={v.id} className="small">
          <strong>{formatDate(v.completed_at ?? v.scheduled_on)}</strong> · {v.title}
          {v.who && <span className="muted"> · {v.who}</span>}
          {v.checklists.length > 0 && <span className="muted"> · {v.checklists.map((c) => (c.completed_at ? c.template?.name ?? t("Checklist") : t("{checklist} (not finished)", { checklist: c.template?.name ?? t("Checklist") }))).join(", ")}</span>}
        </div>
      ))}
    </div>
  );
}
