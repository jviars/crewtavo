/**
 * Roofing → Catalog (/roofing/catalog): ABC Supply's catalog at the business's branch, at its own
 * prices, once ABC Supply is connected. Start from what the account usually buys (ABC's record of
 * its invoices), a roofing category or a search; open an item for its colors, sizes and specs, and
 * put it in a service in the price list from there (CatalogItemDialog). Your materials lists every
 * ABC item the price list uses, checks them all with ABC at once, and replaces one ABC doesn't
 * carry any more everywhere it's used (YourMaterials).
 *
 * ABC's search finds items by the words that describe them, not by category, so a category is a
 * search (CATALOG_CATEGORIES), narrowed by ABC's own product types and brands on what comes back.
 * Prices are ABC's answer when the page asks; nothing here keeps them (ABC's terms).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { api } from "@/lib/api";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { AbcPicture } from "../../materials/AbcPicture";
import { CATALOG_CATEGORIES, uomWord, useAllMaterials, useSupplier, type CatalogCategory, type CatalogItem, type ServiceMaterial, type Supplier, type UsualItem } from "../../materials/data";
import { canSeePackages, usePriceList, useRoofPackages } from "../packages";
import { RoofingTabs } from "../RoofingTabs";
import { CatalogItemDialog } from "./CatalogItemDialog";
import styles from "./catalog.module.css";
import { YourMaterials } from "./YourMaterials";

export function RoofCatalogPage() {
  const session = useSession();
  const supplier = useSupplier();
  const canOpenApps = hasRole(session, "admin") && can(session, "apps");
  const header = (
    <>
      <PageHeader title="Roofing" documentTitle="Catalog" />
      <p className="page-subtitle">ABC Supply's catalog at your branch, at your prices. Find what you buy, see its colors and sizes, and put it in your price list.</p>
      <RoofingTabs />
    </>
  );
  if (!canSeePackages(session)) return <NoAccess title="Roofing" />;
  if (supplier.isPending) {
    return (
      <>
        {header}
        <Loading className={styles.layout} label="Loading the catalog">
          <CardSkeleton lines={8} title={false} />
          <CardSkeleton lines={6} />
        </Loading>
      </>
    );
  }
  if (supplier.error) return <>{header}<div className="card"><ErrorState error={supplier.error} onRetry={() => supplier.refetch()} /></div></>;
  if (!supplier.data) {
    return (
      <>
        {header}
        <div className="card">
          <EmptyState icon="truck" title="Connect ABC Supply to see its catalog" action={canOpenApps && <Link className="btn btn-primary" to="/apps/abc_supply">Set up ABC Supply</Link>}>
            {canOpenApps
              ? "Once your ABC Supply account is connected, its catalog shows here at your branch's prices, with what you buy most up front."
              : "An owner or admin can connect your ABC Supply account in Apps. Its catalog then shows here at your branch's prices."}
          </EmptyState>
        </div>
      </>
    );
  }
  return (
    <>
      {header}
      <Catalog supplier={supplier.data} />
    </>
  );
}

/** Where the catalog's items are, in words: "ABC Supply - Madison, WI". Branch names mostly say ABC already. */
const branchLabel = (supplier: Supplier) => (/abc/i.test(supplier.branch_name) ? supplier.branch_name : `ABC Supply, ${supplier.branch_name}`);

function Catalog({ supplier }: { supplier: Supplier }) {
  const session = useSession();
  const canEdit = hasRole(session, "admin", "office", "estimator") && can(session, "settings");
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "usual";
  const query = params.get("q")?.trim() ?? "";
  const opened = params.get("item");
  const category = CATALOG_CATEGORIES.find((c) => c.key === view) ?? null;
  // What a card showed, so an item opens with it while ABC's full answer comes.
  const [seed, setSeed] = useState<Partial<CatalogItem> | null>(null);

  const materials = useAllMaterials();
  const services = usePriceList();
  const packages = useRoofPackages();
  const usedIn = useMemo(() => {
    const map = new Map<string, ServiceMaterial[]>();
    for (const m of materials.data ?? []) map.set(m.item_number, [...(map.get(m.item_number) ?? []), m]);
    return map;
  }, [materials.data]);
  const flagged = new Set((materials.data ?? []).filter((m) => m.price_note).map((m) => m.item_number)).size;

  const go = (next: Record<string, string>) => setParams(next);
  const open = (itemNumber: string, from?: Partial<CatalogItem>) => {
    setSeed(from ?? null);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("item", itemNumber);
      return next;
    });
  };
  const close = () =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("item");
      return next;
    }, { replace: true });

  return (
    <div className={styles.layout}>
      <nav className={styles.nav} aria-label="Catalog">
        <NavItem current={view === "usual"} icon="star" onClick={() => go({ view: "usual" })}>What you usually buy</NavItem>
        <NavItem current={view === "yours"} icon="list" badge={flagged} onClick={() => go({ view: "yours" })}>Your materials</NavItem>
        <span className={styles.navTitle}>Categories</span>
        {CATALOG_CATEGORIES.map((c) => (
          <NavItem key={c.key} current={view === c.key} icon={c.icon} onClick={() => go({ view: c.key })}>{c.name}</NavItem>
        ))}
      </nav>

      <div className={styles.main}>
        <div className={styles.bar}>
          <SearchBox query={view === "search" ? query : ""} onSearch={(text) => (text ? setParams({ view: "search", q: text }, { replace: view === "search" }) : view === "search" && go({ view: "usual" }))} />
          <span className={styles.where}>
            <Icon name="truck" size={15} />
            Your prices at {branchLabel(supplier)}{supplier.environment === "sandbox" ? " (ABC's sandbox test prices)" : ""}
          </span>
        </div>
        {supplier.status === "error" && (
          <span className="field-error" role="alert">{supplier.last_error ?? "ABC Supply needs attention."} The catalog may not answer until it's fixed in Apps.</span>
        )}

        {view === "yours" ? (
          <YourMaterials materials={materials} services={services.data ?? []} packages={packages.data ?? []} canEdit={canEdit} onOpen={open} />
        ) : view === "search" && query.length >= 2 ? (
          <Results key={`q:${query}`} query={query} title={`"${query}"`} usedIn={usedIn} onOpen={open} />
        ) : category ? (
          <Results key={category.key} query={category.search} title={category.name} icon={category.icon} usedIn={usedIn} onOpen={open} />
        ) : (
          <Usual usedIn={usedIn} onOpen={open} onCategory={(c) => go({ view: c.key })} />
        )}
      </div>

      {opened && (
        <CatalogItemDialog
          key={opened}
          itemNumber={opened}
          seed={seed?.item_number === opened ? seed : null}
          supplier={supplier}
          uses={usedIn.get(opened) ?? []}
          services={services.data ?? []}
          packages={packages.data ?? []}
          canEdit={canEdit}
          onOpen={open}
          onClose={close}
        />
      )}
    </div>
  );
}

function NavItem({ current, icon, badge, onClick, children }: { current: boolean; icon: IconName; badge?: number; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={styles.navItem} aria-current={current ? "true" : undefined} onClick={onClick}>
      <Icon name={icon} size={16} />
      <span>{children}</span>
      {badge ? <span className={styles.navBadge} aria-label={`${badge} need a look`}>{badge}</span> : null}
    </button>
  );
}

/** Searching the whole catalog, once typing stops. */
function SearchBox({ query, onSearch }: { query: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(query);
  const search = useRef(onSearch);
  search.current = onSearch;
  // Another place picked (a category) clears it.
  useEffect(() => setText(query), [query]);
  useEffect(() => {
    const typed = text.trim();
    if (typed === query || (typed.length > 0 && typed.length < 2)) return;
    const wait = setTimeout(() => search.current(typed), 450);
    return () => clearTimeout(wait);
  }, [text, query]);
  return (
    <div className={`input-group ${styles.search}`}>
      <span className="addon"><Icon name="search" size={16} /></span>
      <input
        className="input"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search ABC's catalog: brand, product, color or item number"
        aria-label="Search ABC Supply's catalog"
        style={{ paddingLeft: 34 }}
      />
    </div>
  );
}

/** One item as a card: its picture, who makes it, its name and color, and the price for one. */
function Card({ item, eyebrow, price, unit, note, used, icon, onOpen }: {
  item: { item_number: string; name: string; color?: string | null; image?: string | null };
  eyebrow?: string | null;
  price: number | null;
  unit: string;
  note: string | null;
  used: boolean;
  icon?: IconName;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={styles.card} onClick={onOpen}>
      <AbcPicture item={item} icon={icon} className={styles.cardPicture} />
      <span className={styles.cardBody}>
        {eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}
        <strong className={styles.cardName}>{item.name}</strong>
        <span className={styles.cardMeta}>{[item.item_number, item.color].filter(Boolean).join(" · ")}</span>
      </span>
      <span className={styles.cardFoot}>
        {price !== null ? (
          <span className={styles.price}>{formatMoneyCents(price)} <small>/ {unit.toLowerCase()}</small></span>
        ) : (
          <span className={styles.noPrice}>{note ?? "No price"}</span>
        )}
        {used && <span className="chip chip-green"><Icon name="check" size={12} strokeWidth={3} />In your price list</span>}
      </span>
    </button>
  );
}

const CardsLoading = () => (
  <Loading className={styles.grid} label="Asking ABC Supply">
    {Array.from({ length: 8 }, (_, i) => (
      <div key={i} className="card card-pad stack-sm"><Skeleton height={120} radius={8} /><Skeleton width="80%" /><Skeleton width="50%" /></div>
    ))}
  </Loading>
);

/** How many of each value there are, most first: ABC's product types or brands on a page of items. */
function countsOf(values: Array<string | null | undefined>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** A category or a search: what ABC has at the branch, narrowed by its product types and brands. */
function Results({ query, title, icon, usedIn, onOpen }: { query: string; title: string; icon?: IconName; usedIn: Map<string, ServiceMaterial[]>; onOpen: (itemNumber: string, from?: Partial<CatalogItem>) => void }) {
  const { company } = useSession();
  const results = useQuery({
    queryKey: ["material-search", company.id, query, 60],
    queryFn: () => api.get<{ branch_name: string; items: CatalogItem[] }>(`/materials/search?${new URLSearchParams({ q: query, limit: "60" })}`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [kind, setKind] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const items = results.data?.items ?? [];
  const kinds = countsOf(items.map((i) => i.kind)).slice(0, 8);
  const brands = countsOf(items.filter((i) => !kind || i.kind === kind).map((i) => i.brand)).slice(0, 8);
  const shown = items.filter((i) => (!kind || i.kind === kind) && (!brand || i.brand === brand));

  return (
    <section className="stack" aria-labelledby="catalog-results" style={{ gap: 14 }}>
      <div className={styles.head}>
        <div>
          <h2 id="catalog-results">{title}</h2>
          <p>{results.data ? `${shown.length} ${shown.length === 1 ? "item" : "items"} at ${results.data.branch_name}` : "Asking ABC Supply…"}</p>
        </div>
      </div>
      {(kinds.length > 1 || brands.length > 1) && (
        <div className={styles.filters}>
          {kinds.length > 1 && (
            <div className={styles.filterRow} role="group" aria-label="Narrow by type">
              <span className={styles.filterLabel}>Type</span>
              <button type="button" className={styles.filter} aria-pressed={!kind} onClick={() => { setKind(null); setBrand(null); }}>All</button>
              {kinds.map(([name, n]) => (
                <button key={name} type="button" className={styles.filter} aria-pressed={kind === name} onClick={() => { setKind(kind === name ? null : name); setBrand(null); }}>{name}<small>{n}</small></button>
              ))}
            </div>
          )}
          {brands.length > 1 && (
            <div className={styles.filterRow} role="group" aria-label="Narrow by brand">
              <span className={styles.filterLabel}>Brand</span>
              <button type="button" className={styles.filter} aria-pressed={!brand} onClick={() => setBrand(null)}>All</button>
              {brands.map(([name, n]) => (
                <button key={name} type="button" className={styles.filter} aria-pressed={brand === name} onClick={() => setBrand(brand === name ? null : name)}>{name}<small>{n}</small></button>
              ))}
            </div>
          )}
        </div>
      )}
      {results.isPending ? (
        <CardsLoading />
      ) : results.error ? (
        <div className="card"><ErrorState error={results.error} onRetry={() => results.refetch()} /></div>
      ) : !shown.length ? (
        <div className="card"><EmptyState icon="search" title="Nothing at your branch matches" compact>Try fewer words, the brand's name, or an ABC item number.</EmptyState></div>
      ) : (
        <div className={styles.grid}>
          {shown.map((item) => (
            <Card
              key={item.item_number}
              item={item}
              eyebrow={[item.brand, item.kind].filter(Boolean).join(" · ") || null}
              price={item.unit_price}
              unit={item.uoms.find((u) => u.code === item.uom)?.name ?? uomWord(item.uom)}
              note={item.note}
              used={usedIn.has(item.item_number)}
              icon={icon}
              onOpen={() => onOpen(item.item_number, item)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** What the account buys again and again, from ABC's record of its invoices; the categories when there's none. */
function Usual({ usedIn, onOpen, onCategory }: { usedIn: Map<string, ServiceMaterial[]>; onOpen: (itemNumber: string, from?: Partial<CatalogItem>) => void; onCategory: (c: CatalogCategory) => void }) {
  const { company } = useSession();
  const usual = useQuery({
    queryKey: ["material-usual", company.id],
    queryFn: () => api.get<{ branch_name: string; items: UsualItem[]; note?: string }>("/materials/usual"),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const items = usual.data?.items ?? [];
  return (
    <section className="stack" aria-labelledby="catalog-usual" style={{ gap: 14 }}>
      <div className={styles.head}>
        <div>
          <h2 id="catalog-usual">What you usually buy</h2>
          <p>From ABC's record of your account's invoices, most often first, at today's prices.</p>
        </div>
      </div>
      {usual.isPending ? (
        <CardsLoading />
      ) : usual.error ? (
        <div className="card"><ErrorState error={usual.error} onRetry={() => usual.refetch()} /></div>
      ) : items.length ? (
        <div className={styles.grid}>
          {items.map((item) => (
            <Card
              key={item.item_number}
              item={item}
              eyebrow={item.at_branch === false ? "Not at your branch" : item.count ? `On ${formatNumber(item.count)} ${item.count === 1 ? "invoice" : "invoices"} lately` : null}
              price={item.unit_price}
              unit={uomWord(item.uom)}
              note={item.note}
              used={usedIn.has(item.item_number)}
              onOpen={() => onOpen(item.item_number, { item_number: item.item_number, name: item.name })}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="callout callout-info" role="note">
            <Icon name="info" size={18} />
            <span className="grow" style={{ fontWeight: 400 }}>{usual.data?.note ?? "Nothing yet."}</span>
          </div>
          <h3 className="section-title" style={{ margin: "4px 0 0" }}>Start from a category</h3>
          <div className={styles.tiles}>
            {CATALOG_CATEGORIES.map((c) => (
              <button key={c.key} type="button" className={styles.tile} onClick={() => onCategory(c)}>
                <Icon name={c.icon} size={18} />
                {c.name}
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
