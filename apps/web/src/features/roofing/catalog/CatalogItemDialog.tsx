/**
 * One item in the Catalog: ABC's picture and categories, its colors and sizes at the branch (its
 * product family) with a price on each, its specs, the price list services it's already in, and
 * Add to a service (a service from the price list, then how many go into each unit: MaterialPicker's
 * AddMaterial).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { AbcPicture } from "../../materials/AbcPicture";
import { searchFor, type CatalogDetail, type CatalogItem, type ServiceMaterial, type Supplier } from "../../materials/data";
import { AddMaterial } from "../../materials/MaterialPicker";
import { packagesKey, type PriceListService, type RoofPackage } from "../packages";
import styles from "./catalog.module.css";
import { listed, usesOf } from "./uses";

interface ItemAnswer { item: CatalogDetail; uom: string; length_ft: number | null; unit_price: number | null; note: string | null }

export function CatalogItemDialog({ itemNumber, seed, supplier, uses, services, packages, canEdit, onOpen, onClose }: {
  itemNumber: string;
  /** What the card it was opened from showed, while ABC's full answer comes. */
  seed: Partial<CatalogItem> | null;
  supplier: Supplier;
  uses: ServiceMaterial[];
  services: PriceListService[];
  packages: RoofPackage[];
  canEdit: boolean;
  onOpen: (itemNumber: string, from?: Partial<CatalogItem>) => void;
  onClose: () => void;
}) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const detail = useQuery({
    queryKey: ["material-item", company.id, itemNumber, "detail"],
    queryFn: () => api.get<ItemAnswer>(`/materials/items/${encodeURIComponent(itemNumber)}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const item = detail.data?.item ?? null;
  const shown = item ?? seed;
  const family = useQuery({
    queryKey: ["material-family", company.id, item?.family_id],
    enabled: Boolean(item?.family_id),
    queryFn: () => api.get<{ items: CatalogItem[] }>(`/materials/family/${encodeURIComponent(item!.family_id!)}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const priced: CatalogItem | null = item && detail.data ? { ...item, uom: detail.data.uom, unit_price: detail.data.unit_price, note: detail.data.note } : null;
  const unit = (code: string) => (item?.uoms.find((u) => u.code === code)?.name ?? code).toLowerCase();
  const name = shown?.name ?? itemNumber;

  if (adding && priced) {
    return (
      <Dialog open onClose={onClose} size="lg" title={`Add ${priced.name}`} description="Pick the service it goes into, then say how many go into each of its units.">
        <AddToService
          item={priced}
          services={services}
          has={new Set(uses.map((u) => u.service_id))}
          onBack={() => setAdding(false)}
          onAdded={() => {
            queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
            queryClient.invalidateQueries({ queryKey: ["services", company.id] });
            queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
            setAdding(false);
          }}
        />
      </Dialog>
    );
  }

  // Other colors and sizes: the family at the branch (priced), or ABC's list of it when that's all there is.
  const colors = (family.data?.items.length ?? 0) > 1
    ? family.data!.items.map((f) => ({ item_number: f.item_number, name: f.name, color: f.color, image: f.image, price: f.unit_price, unit: f.uoms.find((u) => u.code === f.uom)?.name ?? f.uom, from: f as Partial<CatalogItem> }))
    : (item?.family_items ?? []).map((f) => ({ item_number: f.item_number, name: f.name, color: f.color, image: null, price: null, unit: "", from: { item_number: f.item_number, name: f.name, color: f.color } }));
  const used = usesOf(uses, services, packages);

  return (
    <Dialog open onClose={onClose} size="lg" title={name} description={[shown?.brand, itemNumber].filter(Boolean).join(" · ")}>
      <div className="dialog-body">
        {detail.error && !shown ? (
          <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
        ) : (
          <div className={styles.detail}>
            <AbcPicture item={{ name, color: shown?.color, image: shown?.image }} caption className={styles.detailPicture} />
            <div className={styles.detailText}>
              {item?.path.length ? <span className={styles.path}>{item.path.join(" › ")}</span> : null}
              <dl className={styles.facts}>
                <dt>Item number</dt><dd>{itemNumber}</dd>
                {shown?.brand && <><dt>Made by</dt><dd>{shown.brand}</dd></>}
                {shown?.color && <><dt>Color</dt><dd>{shown.color}</dd></>}
                {item?.uoms.length ? <><dt>Sold by the</dt><dd>{item.uoms.map((u) => u.name.toLowerCase()).join(", ")}</dd></> : null}
                {item?.lengths.length ? <><dt>Lengths</dt><dd>{item.lengths.map((l) => `${formatNumber(l, 2)} ft`).join(", ")}</dd></> : null}
              </dl>
              <div className={styles.yourPrice}>
                {detail.isPending ? (
                  <Skeleton width={140} height={24} />
                ) : detail.error ? (
                  <strong style={{ fontSize: 15 }}>{(detail.error as Error).message}</strong>
                ) : detail.data!.unit_price !== null ? (
                  <strong>{formatMoneyCents(detail.data!.unit_price)} <small style={{ fontSize: 13, fontWeight: 500 }}>/ {unit(detail.data!.uom)}</small></strong>
                ) : (
                  <strong style={{ fontSize: 15 }}>{detail.data!.note ?? "No price from the branch"}</strong>
                )}
                <span>Your price for one{detail.data?.length_ft ? `, ${formatNumber(detail.data.length_ft, 2)} ft long` : ""}, at {supplier.branch_name}</span>
              </div>
            </div>
          </div>
        )}

        {item?.about && <p className="small" style={{ margin: 0, lineHeight: 1.55 }}>{item.about}</p>}

        {colors.length > 1 && (
          <div className={styles.section}>
            <h3>{family.data && family.data.items.length > 1 ? "Colors and sizes at your branch" : "Other colors and sizes"}</h3>
            <div className={styles.colors}>
              {colors.map((c) => (
                <button key={c.item_number} type="button" className={styles.color} aria-current={c.item_number === itemNumber ? "true" : undefined} onClick={() => c.item_number !== itemNumber && onOpen(c.item_number, c.from)}>
                  <AbcPicture item={c} className={styles.colorDot} />
                  <span>{c.color ?? c.name}</span>
                  {c.price !== null && <small>{formatMoneyCents(c.price)}</small>}
                </button>
              ))}
            </div>
          </div>
        )}

        {item?.specs.length ? (
          <div className={styles.section}>
            <h3>Specs</h3>
            <dl className={styles.specs}>
              {item.specs.map((spec) => <div key={spec.name}><dt>{spec.name}</dt><dd>{spec.value}</dd></div>)}
            </dl>
          </div>
        ) : null}

        {used.length > 0 && (
          <div className={styles.section}>
            <h3>In your price list</h3>
            <ul className={styles.uses}>
              {used.map((u) => (
                <li key={u.link.id}>
                  <strong>{u.service?.name ?? "A service"}</strong>
                  <span className="muted small">{u.amount}{u.packages.length ? ` · in the ${listed(u.packages)} ${u.packages.length === 1 ? "package" : "packages"}` : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="form-actions">
          {!canEdit && <span className="muted small spacer">Someone who can change the price list can add it to a service.</span>}
          <Button onClick={onClose}>Close</Button>
          {canEdit && (
            <Button variant="primary" icon="plus" disabled={!priced} onClick={() => setAdding(true)}>
              {used.length ? "Add to another service" : "Add to a service"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Whether a service looks like where an item goes: shingles to a shingle roof, drip edge to drip edge. */
function fits(item: CatalogItem, service: PriceListService): boolean {
  const words = searchFor(service.name).toLowerCase().split(/\s+/).map((w) => w.replace(/s$/, "")).filter((w) => w.length > 2);
  const text = `${item.name} ${item.kind ?? ""} ${item.family ?? ""}`.toLowerCase();
  return words.length > 0 && words.every((w) => text.includes(w));
}

/** Which service the item goes into (`has`: the ones it's in already), then how many go into each of its units (AddMaterial). */
function AddToService({ item, services, has, onBack, onAdded }: { item: CatalogItem; services: PriceListService[]; has: Set<string>; onBack: () => void; onAdded: () => void }) {
  const choices = services.filter((s) => s.active);
  const [serviceId, setServiceId] = useState(() => choices.find((s) => !has.has(s.id) && fits(item, s))?.id ?? "");
  const [service, setService] = useState<PriceListService | null>(null);
  if (service) return <AddMaterial service={{ id: service.id, name: service.name, unit: service.unit }} item={item} lineQuantity={null} onBack={() => setService(null)} onAdded={onAdded} />;
  const categories = [...new Set(choices.map((s) => s.category?.trim() || "Other"))];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setService(choices.find((s) => s.id === serviceId) ?? null);
  };
  return (
    <form onSubmit={submit}>
      <div className="material-picked">
        <strong>{item.name}</strong>
        <span className="muted small">{[item.item_number, item.color, item.unit_price !== null ? `${formatMoneyCents(item.unit_price)} / ${(item.uoms.find((u) => u.code === item.uom)?.name ?? item.uom).toLowerCase()}` : item.note].filter(Boolean).join(" · ")}</span>
      </div>
      <Field label="Which service is it in?" hint="Every estimate with that service is then priced with it, so you only pick it once.">
        <select className="select" value={serviceId} onChange={(e) => setServiceId(e.target.value)} autoFocus>
          <option value="">Pick a service</option>
          {categories.map((c) => (
            <optgroup key={c} label={c}>
              {choices.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name} (by the {s.unit}){has.has(s.id) ? ", has it already" : ""}</option>)}
            </optgroup>
          ))}
        </select>
      </Field>
      <div className="form-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" disabled={!serviceId}>Next</Button>
      </div>
    </form>
  );
}
