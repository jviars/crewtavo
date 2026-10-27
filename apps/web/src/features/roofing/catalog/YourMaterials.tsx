/**
 * The Catalog's Your materials: every ABC item the price list uses, once each, with the services
 * it's in (and their packages), its last price, and what ABC said about it last time it was priced.
 * Check with ABC prices them all at the branch today and looks each one up: one ABC renamed takes
 * its new name, and one ABC doesn't carry any more (or can't price) is flagged, keeping its last
 * price. Replace swaps one for another item from the catalog in every service it's in, each with
 * how many of the new one go into a unit.
 */
import { suggestPerUnit } from "@crewtavo/core/materials";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatMoneyCents, formatNumber, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { AbcPicture } from "../../materials/AbcPicture";
import { searchFor, uomName, type CatalogItem, type ServiceMaterial } from "../../materials/data";
import { HowMany } from "../../materials/MaterialPicker";
import { MaterialSearch } from "../../materials/MaterialSearch";
import { packagesKey, type PriceListService, type RoofPackage } from "../packages";
import styles from "./catalog.module.css";
import { listed, usesOf } from "./uses";

/** The newest of the price list's links to one item: its last price and what ABC said. */
const newest = (links: readonly ServiceMaterial[]) => [...links].sort((a, b) => (b.priced_at ?? "").localeCompare(a.priced_at ?? ""))[0]!;

export function YourMaterials({ materials, services, packages, canEdit, onOpen }: {
  materials: UseQueryResult<ServiceMaterial[]>;
  services: PriceListService[];
  packages: RoofPackage[];
  canEdit: boolean;
  onOpen: (itemNumber: string, from?: Partial<CatalogItem>) => void;
}) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState<ServiceMaterial[] | null>(null);
  // One row per item, unit and length; the ones that need a look first.
  const groups = useMemo(() => {
    const map = new Map<string, ServiceMaterial[]>();
    for (const m of materials.data ?? []) {
      const key = `${m.item_number}:${m.uom}:${m.length_ft ?? ""}`;
      map.set(key, [...(map.get(key) ?? []), m]);
    }
    const flagged = (links: ServiceMaterial[]) => (links.some((l) => l.price_note) ? 0 : 1);
    return [...map.values()].sort((a, b) => flagged(a) - flagged(b) || a[0]!.name.localeCompare(b[0]!.name));
  }, [materials.data]);
  const needLook = groups.filter((links) => links.some((l) => l.price_note)).length;
  const checkedAt = (materials.data ?? []).map((m) => m.priced_at).filter((d): d is string => Boolean(d)).sort().at(-1);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
    queryClient.invalidateQueries({ queryKey: ["services", company.id] });
    queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
  };
  const check = useMutation({
    meta: { success: (r: { flagged: number }) => (r.flagged ? `Checked with ABC: ${r.flagged} ${r.flagged === 1 ? "needs" : "need"} a look` : "Checked with ABC: everything is still carried and priced") },
    mutationFn: () => api.post<{ priced_at: string | null; services: number; flagged: number }>("/materials/check"),
    onSettled: refresh,
  });

  return (
    <section className="stack" aria-labelledby="catalog-yours" style={{ gap: 14 }}>
      <div className={styles.head}>
        <div>
          <h2 id="catalog-yours">Your materials</h2>
          <p>Every ABC item in your price list, the services it's in, and its last price{checkedAt ? `, from ${timeAgo(checkedAt)}` : ""}.</p>
        </div>
        {canEdit && groups.length > 0 && (
          <Button icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check with ABC</Button>
        )}
      </div>
      {check.error && <span className="field-error" role="alert">{(check.error as Error).message}</span>}
      {needLook > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={18} />
          <span className="grow" style={{ fontWeight: 400 }}>
            <strong>{needLook} {needLook === 1 ? "needs" : "need"} a look.</strong> Your branch couldn't price {needLook === 1 ? "it" : "them"} last time, or ABC doesn't carry {needLook === 1 ? "it" : "them"} any more.
            Each keeps its last price, so nothing gets cheaper by itself. {canEdit ? "Replace one and every service it's in changes with it." : ""}
          </span>
        </div>
      )}

      {materials.isPending ? (
        <Loading className={styles.rows} label="Loading your materials">
          {Array.from({ length: 4 }, (_, i) => <div key={i} className="card card-pad"><Skeleton width="60%" /><Skeleton width="35%" /></div>)}
        </Loading>
      ) : materials.error ? (
        <div className="card"><ErrorState error={materials.error} onRetry={() => materials.refetch()} /></div>
      ) : !groups.length ? (
        <div className="card">
          <EmptyState icon="package" title="No ABC materials in your price list yet">
            Open any item in the catalog and add it to a service, or pick materials on a roof estimate's Materials card. They show here, so you can keep them current.
          </EmptyState>
        </div>
      ) : (
        <ul className={styles.rows} aria-label="Your materials">
          {groups.map((links) => {
            const last = newest(links);
            const note = links.find((l) => l.price_note)?.price_note ?? null;
            const price = last.unit_price !== null && Number(last.unit_price) > 0 ? Number(last.unit_price) : null;
            return (
              <li key={links[0]!.id} className={styles.row} data-flagged={note ? "" : undefined}>
                <AbcPicture item={{ name: last.name }} />
                <span className={styles.rowName}>
                  <strong>{last.name}</strong>
                  <span className="muted small">{last.item_number}{last.length_ft ? ` · ${formatNumber(Number(last.length_ft), 2)} ft` : ""} · by the {uomName(last)}</span>
                </span>
                <span className={styles.rowUses}>
                  {usesOf(links, services, packages).map((u) => (
                    <span key={u.link.id}>
                      <strong>{u.service?.name ?? "A service"}</strong> · {u.amount}{u.packages.length ? ` · ${listed(u.packages)}` : ""}
                    </span>
                  ))}
                </span>
                <span className={styles.rowPrice}>
                  {price !== null ? <strong>{formatMoneyCents(price)}</strong> : <span className="muted">No price</span>}
                  <span className="muted small">/ {uomName(last)}{last.priced_at ? ` · ${timeAgo(last.priced_at)}` : ""}</span>
                </span>
                <span className={styles.rowActions}>
                  <Button size="sm" onClick={() => onOpen(last.item_number, { item_number: last.item_number, name: last.name })}>Open</Button>
                  {canEdit && <Button size="sm" variant={note ? "primary" : "secondary"} onClick={() => setReplacing(links)}>Replace</Button>}
                </span>
                {note && (
                  <span className={styles.flag}>
                    <Icon name="alert" size={15} />
                    <span>{note.replace(/ ?Replace it in Roofing → Catalog\.?/, "")}{price !== null ? " Until then, it counts at its last price." : ""}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {replacing && <ReplaceDialog links={replacing} services={services} onClose={() => setReplacing(null)} onDone={() => { refresh(); setReplacing(null); }} />}
    </section>
  );
}

/** Pick what to use instead from the catalog, then how many of it go into each service. */
function ReplaceDialog({ links, services, onClose, onDone }: { links: ServiceMaterial[]; services: PriceListService[]; onClose: () => void; onDone: () => void }) {
  const first = links[0]!;
  const [item, setItem] = useState<CatalogItem | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Replace ${first.name}`}
      description={item ? "Check how many of the new one go into each service, then replace it." : `Pick what to use instead. It changes in ${links.length === 1 ? "the service" : `all ${links.length} services`} it's in.`}
    >
      {item ? (
        <ReplaceForm links={links} services={services} item={item} onBack={() => setItem(null)} onDone={onDone} />
      ) : (
        <div className="dialog-body stack">
          <MaterialSearch initial={searchFor(first.name)} onPick={setItem} autoFocus />
        </div>
      )}
    </Dialog>
  );
}

function ReplaceForm({ links, services, item, onBack, onDone }: { links: ServiceMaterial[]; services: PriceListService[]; item: CatalogItem; onBack: () => void; onDone: () => void }) {
  const { company } = useSession();
  const first = links[0]!;
  const [uom, setUom] = useState(item.uom);
  const [length, setLength] = useState<number | null>(null);
  const units = item.uoms.length ? item.uoms : [{ code: item.uom, name: item.uom, role: null }];
  const unit = units.find((u) => u.code === uom) ?? units[0]!;
  const serviceOf = (link: ServiceMaterial) => services.find((s) => s.id === link.service_id) ?? null;
  // What ABC's description says one covers comes first: a 10-square roll replacing a 2-square
  // one is sold by the roll too, but goes five times as far. Without that, the same unit keeps
  // how many went in.
  const amountFor = (link: ServiceMaterial, code: string) => {
    const guess = suggestPerUnit(`${item.name} ${item.family ?? ""}`, code, serviceOf(link)?.unit ?? "unit");
    const described = guess.covers !== undefined || guess.per_unit !== 1;
    return described || code !== link.uom ? guess.per_unit : Number(link.per_unit);
  };
  const [amounts, setAmounts] = useState<Record<string, number>>(() => Object.fromEntries(links.map((l) => [l.id, amountFor(l, item.uom)])));
  const detail = useQuery({
    queryKey: ["material-item", company.id, item.item_number, uom, length],
    enabled: item.dimensional || uom !== item.uom,
    queryFn: () => api.get<{ item: CatalogItem & { lengths: number[] }; length_ft: number | null; unit_price: number | null; note: string | null }>(`/materials/items/${encodeURIComponent(item.item_number)}?${new URLSearchParams({ uom, ...(length ? { length_ft: String(length) } : {}) })}`),
  });
  const lengths = detail.data?.item.lengths ?? [];
  const chosenLength = item.dimensional ? (length ?? detail.data?.length_ft ?? null) : null;
  const price = item.dimensional || uom !== item.uom ? (detail.data?.unit_price ?? null) : item.unit_price;
  const replace = useMutation({
    meta: { inline: true, success: `${first.name} replaced with ${item.name}` },
    mutationFn: () => api.post("/materials/replace", { item_number: item.item_number, uom, length_ft: chosenLength, links: links.map((l) => ({ id: l.id, per_unit: amounts[l.id] })) }),
    onSuccess: onDone,
  });
  const ready = links.every((l) => (amounts[l.id] ?? 0) > 0) && (!item.dimensional || chosenLength !== null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) replace.mutate();
  };
  return (
    <form onSubmit={submit}>
      <div className={styles.replacing}>
        <span className="muted small">Instead of {first.name} ({first.item_number})</span>
        <span>
          <strong>{item.name}</strong>
          <span className="muted small" style={{ display: "block" }}>{[item.item_number, item.color, price !== null ? `${formatMoneyCents(price)} / ${unit.name.toLowerCase()}` : (detail.isPending && detail.fetchStatus !== "idle" ? "Getting the price…" : item.note)].filter(Boolean).join(" · ")}</span>
        </span>
      </div>
      <div className="row wrap" style={{ gap: 12, alignItems: "flex-end" }}>
        {units.length > 1 && (
          <Field label="Priced by the">
            <select className="select" value={uom} onChange={(e) => { setUom(e.target.value); setAmounts(Object.fromEntries(links.map((l) => [l.id, amountFor(l, e.target.value)]))); }}>
              {units.map((u) => <option key={u.code} value={u.code}>{u.name}{u.role === "stocking" ? " (how it's ordered)" : ""}</option>)}
            </select>
          </Field>
        )}
        {item.dimensional && (
          <Field label="Length">
            <select className="select" value={chosenLength ?? ""} onChange={(e) => setLength(Number(e.target.value) || null)} disabled={!lengths.length}>
              {!lengths.length && <option value="">{detail.isPending ? "Loading lengths…" : "No lengths listed"}</option>}
              {lengths.map((l) => <option key={l} value={l}>{formatNumber(l, 2)} ft</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className={styles.perService}>
        {links.map((link) => {
          const service = serviceOf(link);
          return (
            <div key={link.id}>
              <strong>{service?.name ?? "A service"}</strong>
              <HowMany key={`${link.id}:${uom}`} perUnit={amounts[link.id] ?? 0} onChange={(v) => setAmounts((a) => ({ ...a, [link.id]: v }))} uom={unit} serviceUnit={service?.unit ?? "unit"} />
            </div>
          );
        })}
      </div>
      <FormError error={replace.error} />
      <div className="form-actions">
        <Button onClick={onBack}>Back</Button>
        <Button type="submit" variant="primary" icon="refresh" loading={replace.isPending} disabled={!ready}>
          Replace in {links.length === 1 ? (serviceOf(first)?.name ?? "its service") : `${links.length} services`}
        </Button>
      </div>
    </form>
  );
}
