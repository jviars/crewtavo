/**
 * Roofing → Packages: what goes on each kind of roof. A package is the roof itself, priced by the
 * square (a price set by hand, or one that follows ABC Supply: materials plus labor and the rest,
 * plus a markup), what's always on that roof (measured from it, or counted, like 3 pipe boots), and
 * the quick adds a person puts on an estimate with one tap. Picking a package is the first step of
 * a new roof estimate (paving/NewTakeoffDialog.tsx, which uses PackagePicker from here).
 *
 * The price range settings for every package live here too (companies.settings.roofing), with the
 * ABC Supply connection the prices come from.
 */
import { followPrice, marginPct, priceRange, RANGE_ROUNDING, rangeSettings } from "@crewtavo/core/estimates";
import { materialsPerUnit } from "@crewtavo/core/materials";
import { getPreset } from "@crewtavo/core/presets";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCents, timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useServiceMaterials, useSupplier, type ServiceMaterial } from "../materials/data";
import { MaterialPicker } from "../materials/MaterialPicker";
import { copyName, formulaWords, isSquareUnit, moneyText, PACKAGE_NAME_MAX, PACKAGE_STYLES, quickAddChips, roofServiceKind, unitPrice, type PackageStyle } from "./data";
import {
  canEditPackages,
  canEditRanges,
  canSetUpRoofing,
  packagesKey,
  setUpRoofing,
  setupMessage,
  usePriceList,
  useRoofPackages,
  type PriceListService,
  type RoofPackage,
  type RoofPackageItem,
} from "./packages";
import styles from "./RoofPackagesPage.module.css";

const FORMAT = { whole: formatMoney, cents: formatMoneyCents };
const money = (n: number) => moneyText(n, FORMAT);
const round2 = (n: number) => Math.round(n * 100) / 100;
const SERVICES_KEY = (companyId: string) => ["services", companyId, "roof-packages"];

// ---------------------------------------------------------------------------------------------
// Shared pieces: the Projects | Packages tabs, a package's picture, and the picker
// ---------------------------------------------------------------------------------------------

/** Roofing's two screens: the projects and the packages they're priced from. */
export function RoofingTabs() {
  const { pathname } = useLocation();
  const onPackages = pathname.startsWith("/roofing/packages");
  return (
    <nav className={`underline-tabs ${styles.tabs}`} aria-label="Roofing">
      <Link to="/roofing" aria-current={onPackages ? undefined : "page"}>Projects</Link>
      <Link to="/roofing/packages" aria-current={onPackages ? "page" : undefined}>Packages</Link>
    </nav>
  );
}

/** The look of each style: a roof's color and the lines of its shingles or panels. */
const ART: Record<PackageStyle, { bg: string; line: string; w: number; h: number; d: string }> = {
  shingle: { bg: "#5b6770", line: "#4a555d", w: 30, h: 20, d: "M0 10h30M0 20h30M10 0v10M25 10v10" },
  designer: { bg: "#6e5a4b", line: "#5c4a3d", w: 36, h: 24, d: "M0 12h36M0 24h36M14 0l-4 12M32 12l-4 12" },
  metal: { bg: "#3f5566", line: "#5f7889", w: 12, h: 12, d: "M6 0v12" },
  other: { bg: "#66747a", line: "#5a676d", w: 14, h: 14, d: "M0 14L14 0" },
};

/**
 * A package's picture: a tile for lists, or a wide banner for the new-estimate cards. The colors
 * are the roofing material's own, so they're the same in dark mode.
 */
export function PackageArt({ style, size = 44, banner = false }: { style: PackageStyle; size?: number; banner?: boolean }) {
  const id = `roof-art-${useId().replace(/:/g, "")}`;
  const art = ART[style] ?? ART.other;
  return (
    <svg className={banner ? styles.banner : styles.art} width={banner ? "100%" : size} height={banner ? 72 : size} aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width={art.w} height={art.h} patternUnits="userSpaceOnUse">
          <path d={art.d} fill="none" stroke={art.line} strokeWidth="2" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={art.bg} />
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/** "$560 a square" for a package's roof (or its own unit), or null when it has no roof yet. */
function squarePrice(roof: { unit_price: number; unit: string } | null | undefined): string | null {
  if (!roof) return null;
  return isSquareUnit(roof.unit) ? `${money(roof.unit_price)} a square` : unitPrice(roof.unit_price, roof.unit, FORMAT);
}

/**
 * The packages as big cards to pick from when a roof estimate starts (NewTakeoffDialog): the
 * picture, the name, the price a square and how many quick adds it has.
 */
export function PackagePicker({ packages, value, onChange }: { packages: RoofPackage[]; value: string | null; onChange: (id: string) => void }) {
  return (
    <div className={styles.picker} role="group" aria-label="Roof packages">
      {packages.map((p) => {
        const quick = p.items.filter((i) => i.kind === "quick").length;
        const on = p.id === value;
        return (
          <button key={p.id} type="button" className={styles.pick} aria-pressed={on} onClick={() => onChange(p.id)}>
            <PackageArt style={p.style} banner />
            <span className={styles.pickText}>
              <strong>{p.name}</strong>
              <span>{squarePrice(p.roof) ?? "No roof picked yet"}</span>
              <small>{quick ? `${quick} quick ${quick === 1 ? "add" : "adds"}` : "No quick adds"}{p.is_default ? " · Default" : ""}</small>
            </span>
            {on && <span className={styles.pickCheck} aria-hidden="true"><Icon name="check" size={15} strokeWidth={3} /></span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/** Packages are for the people who price work (they're read with the price list). */
export function RoofPackagesPage() {
  const session = useSession();
  return hasRole(session, "admin", "office", "estimator") && can(session, "sales") ? <PackagesScreen /> : <NoAccess title="Roofing" />;
}

function PackagesScreen() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const editable = canEditPackages(session);
  const packages = useRoofPackages();
  const services = usePriceList();
  const [params, setParams] = useSearchParams();
  const list = packages.data ?? [];
  const selected = list.find((p) => p.id === params.get("package")) ?? list.find((p) => p.is_default) ?? list[0] ?? null;
  const select = (id: string | null) => setParams(id ? { package: id } : {}, { replace: true });

  const create = useMutation({
    meta: { success: "Package added. Name it and pick what goes on it." },
    mutationFn: async () => {
      // Start from the first roof in the price list (priced by the square, with waste).
      const roof = (services.data ?? []).find((s) => s.active && isSquareUnit(s.unit) && roofServiceKind(s.formula, s.name) === "roof") ?? null;
      const sort = list.reduce((max, p) => Math.max(max, p.sort), -1) + 1;
      return unwrap(await supabase().from("roof_packages").insert({ company_id: company.id, name: "New package", style: "other", roof_service_id: roof?.id ?? null, is_default: list.length === 0, sort }).select("id").single());
    },
    onSuccess: async (row) => {
      await queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
      select(row.id);
    },
  });

  const header = (
    <>
      <PageHeader title="Roofing" actions={editable && list.length > 0 && <Button variant="primary" icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New package</Button>} />
      <p className="page-subtitle">What goes on each kind of roof. Pick a package when you start an estimate, and the roof's measurements fill in the amounts.</p>
      <RoofingTabs />
    </>
  );

  if (packages.isPending || services.isPending) {
    return (
      <>
        {header}
        <Loading className={styles.layout} label="Loading packages">
          <div className={styles.side}>
            <CardSkeleton lines={2} title={false} />
            <CardSkeleton lines={2} title={false} />
            <CardSkeleton lines={3} />
          </div>
          <div className={styles.main}><CardSkeleton lines={10} /></div>
        </Loading>
      </>
    );
  }
  if (packages.error || services.error) {
    return (
      <>
        {header}
        <div className="card"><ErrorState error={packages.error ?? services.error} onRetry={() => { packages.refetch(); services.refetch(); }} /></div>
      </>
    );
  }

  return (
    <>
      {header}
      <div className={styles.layout}>
        <div className={styles.side}>
          {list.length > 0 && (
            <ul className={styles.list} aria-label="Packages">
              {list.map((p) => {
                const roof = services.data.find((s) => s.id === p.roof_service_id);
                const margin = roof ? marginPct(roof.unit_price, roof.unit_cost) : null;
                return (
                  <li key={p.id}>
                    <button type="button" className={styles.pkg} aria-current={p.id === selected?.id ? "true" : undefined} onClick={() => select(p.id)}>
                      <PackageArt style={p.style} />
                      <span className={styles.pkgText}>
                        <strong>{p.name}</strong>
                        <span>{[squarePrice(roof) ?? "Pick the roof", margin !== null ? `${margin}% margin` : null].filter(Boolean).join(" · ")}</span>
                      </span>
                      {p.is_default && <span className="chip chip-green">Default</span>}
                    </button>
                  </li>
                );
              })}
              {editable && (
                <li>
                  <button type="button" className={styles.addPkg} onClick={() => create.mutate()} disabled={create.isPending}>
                    <Icon name="plus" size={16} strokeWidth={2.5} />Add a package
                  </button>
                </li>
              )}
            </ul>
          )}
          <div className={styles.sideCards}>
            <RangeCard />
            <SupplierCard packages={list} />
            {list.length > 0 && <MissingServices services={services.data} />}
          </div>
        </div>
        <div className={styles.main}>
          {selected ? (
            <PackageEditor key={selected.id} pkg={selected} packages={list} services={services.data} editable={editable} onSelect={select} />
          ) : (
            <NoPackages onCreate={() => create.mutate()} creating={create.isPending} />
          )}
        </div>
      </div>
    </>
  );
}

/** A business with no packages yet: set up the standard three, or start from scratch. */
function NoPackages({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const setup = useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: packagesKey(session.company.id) });
      queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
    },
  });
  const canSetUp = canSetUpRoofing(session);
  const editable = canEditPackages(session);
  return (
    <div className="card">
      <EmptyState
        icon="package"
        title="No roof packages yet"
        action={
          (canSetUp || editable) && (
            <div className="row wrap" style={{ justifyContent: "center" }}>
              {canSetUp && <Button variant="primary" icon="package" loading={setup.isPending} onClick={() => setup.mutate()}>Set up the standard packages</Button>}
              {editable && <Button icon="plus" loading={creating} onClick={onCreate}>Start from scratch</Button>}
            </div>
          )
        }
      >
        A package is what goes on a kind of roof: the shingles or metal by the square, what's always on it, and one-tap extras. The standard three are Architectural shingle, Designer shingle and Standing-seam metal.
        {!canSetUp && !editable && " Ask the office to set them up."}
      </EmptyState>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Price ranges (companies.settings.roofing) and where prices come from
// ---------------------------------------------------------------------------------------------

/** The example every business sees, so the sentence always reads the same way. */
const EXAMPLE_ESTIMATE = 18304;

function RangeCard() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const editable = canEditRanges(session);
  const saved = rangeSettings(company.settings);
  const save = useMutation({
    meta: { success: "Price ranges saved" },
    mutationFn: async (patch: { range_pct?: number; range_round?: number }) => {
      // Read the settings fresh, so a change someone made meanwhile isn't undone.
      const current = (unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings ?? {}) as Record<string, unknown>;
      const roofing = { ...((current.roofing ?? {}) as Record<string, unknown>), ...patch };
      unwrap(await supabase().from("companies").update({ settings: { ...current, roofing } as never }).eq("id", company.id));
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      await session.refresh();
    },
  });
  const shown = save.isPending && save.variables ? rangeSettings({ roofing: { range_pct: saved.pct, range_round: saved.round, ...save.variables } }) : saved;
  const example = priceRange(EXAMPLE_ESTIMATE, shown);
  return (
    <section className={`card card-pad ${styles.sideCard}`} aria-labelledby="roof-ranges">
      <div className={styles.sideHead}>
        <h2 id="roof-ranges">Price ranges</h2>
        <p>For every package. The low end is the estimate; the high end leaves room for what only shows up on site, like rotten decking.</p>
      </div>
      {editable ? (
        <div className={styles.rangeFields}>
          <Field label="Room on top">
            <MoneyInput percent max={100} width={110} value={shown.pct} onSave={(v) => save.mutate({ range_pct: v })} />
          </Field>
          <Field label="Round to">
            <select className="select" value={shown.round} onChange={(e) => save.mutate({ range_round: Number(e.target.value) })} disabled={save.isPending}>
              {RANGE_ROUNDING.map((r) => <option key={r} value={r}>{formatMoney(r)}</option>)}
            </select>
          </Field>
        </div>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          {shown.pct}% on top, rounded to {formatMoney(shown.round)}. <span className="muted">An owner or admin can change this.</span>
        </p>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        An {formatMoney(EXAMPLE_ESTIMATE)} estimate goes out as <strong className={styles.ink}>{formatMoney(example.low)} to {formatMoney(example.high)}</strong>.
      </p>
    </section>
  );
}

/** ABC Supply: connected (and when the packages were last priced), needing attention, or not set up. */
function SupplierCard({ packages }: { packages: RoofPackage[] }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const supplier = useSupplier();
  const ids = [...new Set(packages.flatMap((p) => [p.roof_service_id, ...p.items.filter((i) => i.kind === "included").map((i) => i.service_id)]).filter((id): id is string => Boolean(id)))];
  const links = useServiceMaterials(ids);
  const pricedAt = (links.data ?? []).map((l) => l.priced_at).filter((d): d is string => Boolean(d)).sort().at(-1);
  const update = useMutation({
    meta: { success: (r: { priced_at: string | null; branch_name: string | null }) => (r.priced_at ? `Prices updated from ${r.branch_name}` : "None of your packages' services have ABC materials yet") },
    mutationFn: () => api.post<{ priced_at: string | null; branch_name: string | null; services: number }>("/roofing/prices"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
      queryClient.invalidateQueries({ queryKey: ["services", company.id] });
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
    },
  });
  const canOpenApps = hasRole(session, "admin") && can(session, "apps");

  if (supplier.isPending) return <div className={`card card-pad ${styles.sideCard}`}><Skeleton width="60%" height={16} /><Skeleton width="90%" /></div>;
  if (supplier.error) return <div className="card"><ErrorState compact error={supplier.error} onRetry={() => supplier.refetch()} /></div>;
  const s = supplier.data;
  return (
    <section className={`card card-pad ${styles.sideCard}`} aria-labelledby="roof-abc">
      <div className="row" style={{ gap: 8 }}>
        <span className={styles.abc} aria-hidden="true">ABC</span>
        <h2 id="roof-abc" className="grow">ABC Supply</h2>
        {s?.status === "connected" && <span className="chip chip-green">Connected</span>}
        {s?.status === "error" && <span className="chip chip-red">Needs attention</span>}
      </div>
      {!s ? (
        <>
          <p className={styles.sideText}>Price your roofs from your own ABC Supply account, at your branch's prices, and let a package follow them.</p>
          {canOpenApps ? <Link className="btn btn-sm" style={{ justifySelf: "start" }} to="/apps/abc_supply">Connect ABC Supply</Link> : <span className="muted small">An owner or admin can connect it in Apps.</span>}
        </>
      ) : s.status === "error" ? (
        <>
          <p className={styles.sideText}>{s.last_error ?? "ABC Supply stopped answering."} Packages keep the last prices until it's fixed.</p>
          {canOpenApps && <Link className="link-btn small" to="/apps/abc_supply">Open in Apps</Link>}
        </>
      ) : (
        <>
          <p className={styles.sideText}>
            Your prices at {s.branch_name}.{" "}
            {links.isPending && ids.length ? null : pricedAt ? `Priced ${timeAgo(pricedAt)}.` : "None of your packages' services have ABC materials yet."}
          </p>
          <div className="row wrap" style={{ gap: 14 }}>
            {canEditPackages(session) && pricedAt !== undefined && (
              <button type="button" className="link-btn small" onClick={() => update.mutate()} disabled={update.isPending}>
                {update.isPending ? "Updating prices…" : "Update prices"}
              </button>
            )}
            {canOpenApps && <Link className="link-btn small" to="/apps/abc_supply">Open in Apps</Link>}
          </div>
        </>
      )}
    </section>
  );
}

/** The standard roofing services a price list doesn't have yet (Ridge vent, Ice and water shield…). */
function MissingServices({ services }: { services: PriceListService[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const add = useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
      queryClient.invalidateQueries({ queryKey: packagesKey(session.company.id) });
    },
  });
  if (!canSetUpRoofing(session)) return null;
  const have = new Set(services.map((s) => s.name.trim().toLowerCase()));
  const missing = getPreset("roofing_exteriors").services.filter((s) => !have.has(s.name.toLowerCase()));
  if (!missing.length) return null;
  return (
    <div className={`card card-pad ${styles.sideCard}`}>
      <p className={styles.sideText}>
        {missing.length} standard roofing {missing.length === 1 ? "service isn't" : "services aren't"} in your price list yet, like {missing.slice(0, 2).map((s) => s.name).join(" and ")}.
      </p>
      <Button size="sm" icon="plus" style={{ justifySelf: "start" }} loading={add.isPending} onClick={() => add.mutate()}>Add {missing.length === 1 ? "it" : "them"}</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One package
// ---------------------------------------------------------------------------------------------

type PackagePatch = Partial<Pick<RoofPackage, "name" | "style" | "roof_service_id" | "price_mode" | "markup_pct">>;

function PackageEditor({ pkg, packages, services, editable, onSelect }: { pkg: RoofPackage; packages: RoofPackage[]; services: PriceListService[]; editable: boolean; onSelect: (id: string | null) => void }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const supplier = useSupplier();
  const connected = supplier.data?.status === "connected";
  const byId = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const roof = pkg.roof_service_id ? (byId.get(pkg.roof_service_id) ?? null) : null;
  const included = pkg.items.filter((i) => i.kind === "included");
  const materialIds = [roof?.id, ...included.map((i) => i.service_id)].filter((id): id is string => Boolean(id));
  const materials = useServiceMaterials(materialIds);
  const loadingMaterials = materialIds.length > 0 && materials.isPending;
  const linksOf = (serviceId: string): ServiceMaterial[] => (materials.data ?? []).filter((m) => m.service_id === serviceId);
  const [picking, setPicking] = useState<PriceListService | null>(null);

  // Changes save one after another (scope), each shown straight away. The lists are read again once
  // the last one is done, which also puts back anything that failed.
  const mutationKey = ["roof-package", pkg.id];
  const scope = { id: `roof-package-${pkg.id}` };
  const refresh = () => {
    if (queryClient.isMutating({ mutationKey }) > 1) return;
    queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
    queryClient.invalidateQueries({ queryKey: ["services", company.id] });
  };
  const patchPackage = (fn: (p: RoofPackage) => RoofPackage) => {
    void queryClient.cancelQueries({ queryKey: packagesKey(company.id) });
    queryClient.setQueryData<RoofPackage[]>(packagesKey(company.id), (list) => list?.map((p) => (p.id === pkg.id ? fn(p) : p)));
  };
  const patchService = (id: string, patch: Partial<PriceListService>) => {
    void queryClient.cancelQueries({ queryKey: SERVICES_KEY(company.id) });
    queryClient.setQueryData<PriceListService[]>(SERVICES_KEY(company.id), (list) => list?.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  // The roof's materials, a square at today's prices, and what following ABC would charge.
  const roofLinks = roof ? linksOf(roof.id) : [];
  const perSquareExact = materialsPerUnit(roofLinks);
  const perSquare = round2(perSquareExact);
  const canFollow = roofLinks.length > 0;
  const followed = (labor: number | null, markup: number) => followPrice(perSquareExact, labor, markup);

  const savePackage = useMutation({
    mutationKey,
    scope,
    mutationFn: async ({ patch, price }: { patch: PackagePatch; price?: number }) => {
      unwrap(await supabase().from("roof_packages").update(patch).eq("id", pkg.id));
      if (price !== undefined && roof && price > 0) unwrap(await supabase().from("services").update({ unit_price: price }).eq("id", roof.id));
      // A new roof isn't also one of the package's extras.
      if (patch.roof_service_id) unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", patch.roof_service_id));
    },
    onMutate: ({ patch, price }) => {
      patchPackage((p) => ({ ...p, ...patch, items: patch.roof_service_id ? p.items.filter((i) => i.service_id !== patch.roof_service_id) : p.items }));
      if (price !== undefined && roof && price > 0) patchService(roof.id, { unit_price: price });
    },
    onSettled: refresh,
  });
  const saveService = useMutation({
    mutationKey,
    scope,
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<PriceListService, "unit_price">> }) => unwrap(await supabase().from("services").update(patch).eq("id", id)),
    onMutate: ({ id, patch }) => patchService(id, patch),
    onSettled: refresh,
  });
  const saveLabor = useMutation({
    mutationKey,
    scope,
    meta: { success: "Labor and the rest saved" },
    mutationFn: async (labor: number) => {
      await api.put(`/services/${roof!.id}/labor`, { labor_cost: labor });
      if (pkg.price_mode === "follow") unwrap(await supabase().from("services").update({ unit_price: followed(labor, pkg.markup_pct) }).eq("id", roof!.id));
    },
    onMutate: (labor) => patchService(roof!.id, { labor_cost: labor, ...(pkg.price_mode === "follow" ? { unit_price: followed(labor, pkg.markup_pct) } : {}) }),
    onSettled: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["service-costs", company.id] });
    },
  });
  const nextSort = (kind: RoofPackageItem["kind"]) => pkg.items.filter((i) => i.kind === kind).reduce((max, i) => Math.max(max, i.sort), -1) + 1;
  const addItem = useMutation({
    mutationKey,
    scope,
    mutationFn: async ({ serviceId, kind }: { serviceId: string; kind: RoofPackageItem["kind"] }) => {
      // Always on the roof means it isn't a quick add any more.
      if (kind === "included") unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", serviceId).eq("kind", "quick"));
      unwrap(await supabase().from("roof_package_items").insert({ company_id: company.id, package_id: pkg.id, service_id: serviceId, kind, quantity: null, sort: nextSort(kind) }));
    },
    onMutate: ({ serviceId, kind }) =>
      patchPackage((p) => ({
        ...p,
        items: [...p.items.filter((i) => !(kind === "included" && i.service_id === serviceId && i.kind === "quick")), { id: `new-${kind}-${serviceId}`, service_id: serviceId, kind, quantity: null, sort: nextSort(kind) }],
      })),
    onSettled: refresh,
  });
  const removeItem = useMutation({
    mutationKey,
    scope,
    mutationFn: async (item: RoofPackageItem) => unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", item.service_id).eq("kind", item.kind)),
    onMutate: (item) => patchPackage((p) => ({ ...p, items: p.items.filter((i) => !(i.service_id === item.service_id && i.kind === item.kind)) })),
    onSettled: refresh,
  });
  const setCount = useMutation({
    mutationKey,
    scope,
    mutationFn: async ({ item, quantity }: { item: RoofPackageItem; quantity: number }) =>
      unwrap(await supabase().from("roof_package_items").update({ quantity }).eq("package_id", pkg.id).eq("service_id", item.service_id).eq("kind", item.kind)),
    onMutate: ({ item, quantity }) => patchPackage((p) => ({ ...p, items: p.items.map((i) => (i.service_id === item.service_id && i.kind === item.kind ? { ...i, quantity } : i)) })),
    onSettled: refresh,
  });

  const copy = useMutation({
    meta: { success: "Copied. Rename it and change what's different." },
    mutationFn: async () => {
      const db = supabase();
      const sort = packages.reduce((max, p) => Math.max(max, p.sort), -1) + 1;
      const row = unwrap(
        await db
          .from("roof_packages")
          .insert({ company_id: company.id, name: copyName(pkg.name), style: pkg.style, roof_service_id: pkg.roof_service_id, price_mode: pkg.price_mode, markup_pct: pkg.markup_pct, is_default: false, sort })
          .select("id")
          .single(),
      );
      if (pkg.items.length) unwrap(await db.from("roof_package_items").insert(pkg.items.map((i) => ({ company_id: company.id, package_id: row.id, service_id: i.service_id, kind: i.kind, quantity: i.quantity, sort: i.sort }))));
      return row.id;
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
      onSelect(id);
    },
  });
  const remove = useMutation({
    meta: { success: `${pkg.name} deleted` },
    mutationFn: async () => {
      const db = supabase();
      unwrap(await db.from("roof_packages").delete().eq("id", pkg.id));
      // There's always a default while there are packages: the next one takes over.
      const next = packages.find((p) => p.id !== pkg.id);
      if (pkg.is_default && next) unwrap(await db.from("roof_packages").update({ is_default: true }).eq("id", next.id));
    },
    onSuccess: () => {
      // Off the list straight away, so the next package (not this one) opens.
      queryClient.setQueryData<RoofPackage[]>(packagesKey(company.id), (list) => list?.filter((p) => p.id !== pkg.id));
      onSelect(null);
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
    },
  });
  const makeDefault = useMutation({
    meta: { success: `New roof estimates start with ${pkg.name}` },
    mutationFn: async () => {
      const db = supabase();
      unwrap(await db.from("roof_packages").update({ is_default: false }).eq("company_id", company.id).eq("is_default", true));
      unwrap(await db.from("roof_packages").update({ is_default: true }).eq("id", pkg.id));
    },
    onSettled: refresh,
  });

  const [name, setName] = useState(pkg.name);
  useEffect(() => setName(pkg.name), [pkg.name]);
  const saveName = () => {
    const clean = name.trim().slice(0, PACKAGE_NAME_MAX);
    if (!clean) return setName(pkg.name);
    if (clean !== pkg.name) savePackage.mutate({ patch: { name: clean } });
  };

  const roofChoices = services.filter((s) => (s.active && isSquareUnit(s.unit)) || s.id === pkg.roof_service_id);
  const shared = roof ? packages.filter((p) => p.id !== pkg.id && p.roof_service_id === roof.id) : [];
  const onRoof = new Set([pkg.roof_service_id, ...included.map((i) => i.service_id)]);
  const addable = services.filter((s) => s.active && !onRoof.has(s.id));
  const categories = [...new Set(addable.map((s) => s.category?.trim() || "Other"))];
  const chips = quickAddChips(services, pkg.items, pkg.roof_service_id);
  const following = pkg.price_mode === "follow";
  const rows: Array<{ service: PriceListService; item: RoofPackageItem | null }> = [
    ...(roof ? [{ service: roof, item: null }] : []),
    ...included.flatMap((item) => {
      const service = byId.get(item.service_id);
      return service ? [{ service, item }] : [];
    }),
  ];

  return (
    <section className={`card ${styles.editor}`} aria-label={pkg.name}>
      {/* Name, picture and the package's own actions */}
      <div className={styles.part}>
        {editable ? (
          <div className={styles.head}>
            <Field label="Package name" className={styles.nameField}>
              <input className="input" value={name} maxLength={PACKAGE_NAME_MAX} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </Field>
            <div className={styles.headActions}>
              {!pkg.is_default && <Button variant="ghost" icon="star" loading={makeDefault.isPending} onClick={() => makeDefault.mutate()}>Make default</Button>}
              <Button variant="ghost" icon="copy" loading={copy.isPending} onClick={() => copy.mutate()}>Copy</Button>
              <Button
                variant="ghost"
                icon="trash"
                aria-label="Delete this package"
                loading={remove.isPending}
                onClick={async () => (await confirm({ title: `Delete the ${pkg.name} package?`, body: "Estimates already made with it keep their lines.", confirmLabel: "Delete", danger: true })) && remove.mutate()}
              />
            </div>
          </div>
        ) : (
          <div className="row wrap" style={{ gap: 10 }}>
            <PackageArt style={pkg.style} size={36} />
            <h2 className={styles.title}>{pkg.name}</h2>
            {pkg.is_default && <span className="chip chip-green">Default</span>}
          </div>
        )}
        {editable && (
          <div className={styles.styleRow} role="group" aria-label="Picture on its card">
            {PACKAGE_STYLES.map((s) => (
              <button key={s.id} type="button" className={styles.styleBtn} aria-pressed={pkg.style === s.id} onClick={() => pkg.style !== s.id && savePackage.mutate({ patch: { style: s.id } })}>
                <PackageArt style={s.id} size={26} />
                {s.label}
              </button>
            ))}
          </div>
        )}
        {editable ? (
          <Field label="The roof" hint={roof ? `Priced by the square from the roof's measurements${roof.formula ? ` (${formulaWords(roof.formula)?.toLowerCase()})` : ""}.` : "Pick the service in your price list that prices this roof by the square."}>
            <select className="select" value={pkg.roof_service_id ?? ""} onChange={(e) => e.target.value && savePackage.mutate({ patch: { roof_service_id: e.target.value } })}>
              {!pkg.roof_service_id && <option value="">Pick the roof…</option>}
              {(roofChoices.length ? roofChoices : services.filter((s) => s.active)).map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (turned off)"}</option>)}
            </select>
          </Field>
        ) : null}
      </div>

      {/* The price a square */}
      <div className={styles.part}>
        <div className={styles.partHead}>
          <div>
            <h2>Price a square</h2>
            <p>What the homeowner pays for the roof, installed.</p>
          </div>
          {editable && roof && (
            <div className="segmented" role="group" aria-label="How the price is set">
              <button type="button" aria-pressed={!following} onClick={() => following && savePackage.mutate({ patch: { price_mode: "manual" } })}>Set it yourself</button>
              <button
                type="button"
                aria-pressed={following}
                disabled={!canFollow && !following}
                title={canFollow ? undefined : "Pick this roof's materials from ABC Supply first"}
                onClick={() => !following && savePackage.mutate({ patch: { price_mode: "follow" }, price: followed(roof.labor_cost, pkg.markup_pct) })}
              >
                Follow ABC prices
              </button>
            </div>
          )}
        </div>

        {!roof ? (
          <p className="callout callout-info" style={{ margin: 0 }}>Pick the roof above, and its price a square shows here.</p>
        ) : loadingMaterials ? (
          <Skeleton height={64} radius={10} />
        ) : following && canFollow ? (
          <div className="stack-sm">
            <div className={styles.sum}>
              <span className={styles.term}>
                <span><span className={styles.abc}>ABC</span>Materials</span>
                <strong>{formatMoneyCents(perSquare)}</strong>
              </span>
              <span className={styles.op} aria-hidden="true">+</span>
              <span className={styles.term}>
                <span>Labor and the rest</span>
                {editable ? <MoneyInput width={110} label="Labor and the rest, a square" value={roof.labor_cost ?? 0} onSave={(v) => saveLabor.mutate(v)} /> : <strong>{formatMoneyCents(roof.labor_cost ?? 0)}</strong>}
              </span>
              <span className={styles.op} aria-hidden="true">+</span>
              <span className={styles.term}>
                <span>Markup</span>
                {editable ? <MoneyInput percent max={1000} width={96} label="Markup percent" value={pkg.markup_pct} onSave={(v) => savePackage.mutate({ patch: { markup_pct: v }, price: followed(roof.labor_cost, v) })} /> : <strong>{pkg.markup_pct}%</strong>}
              </span>
              <span className={styles.op} aria-hidden="true">=</span>
              <span className={`${styles.term} ${styles.total}`}>
                <span>A square today</span>
                <strong>{formatMoneyCents(followed(roof.labor_cost, pkg.markup_pct))}</strong>
              </span>
            </div>
            <p className={styles.note}>Moves with ABC's prices, so every new estimate is priced at today's materials. Estimates already sent and signed keep their price.</p>
          </div>
        ) : (
          <div className="stack-sm">
            {following && <p className="callout callout-warning" style={{ margin: 0 }}>This roof has no ABC materials any more, so its price stays where it was. Set it yourself, or pick its materials again.</p>}
            <div className={styles.priceRow}>
              {editable ? (
                <span className={styles.bigMoney}><MoneyInput width={160} label="Price a square" value={roof.unit_price} onSave={(v) => saveService.mutate({ id: roof.id, patch: { unit_price: v } })} /></span>
              ) : (
                <strong className={styles.bigPrice}>{squarePrice(roof)}</strong>
              )}
              <span className={styles.costLine}>
                {roof.unit_cost !== null ? (
                  <span>
                    Your cost today: <strong>{formatMoneyCents(roof.unit_cost)}</strong> {isSquareUnit(roof.unit) ? "a square" : `a ${roof.unit}`}
                    {marginPct(roof.unit_price, roof.unit_cost) !== null && <> · <strong>{marginPct(roof.unit_price, roof.unit_cost)}% margin</strong></>}
                  </span>
                ) : (
                  <span>Add your cost in the <Link to="/settings?tab=prices">price list</Link> to see the margin.</span>
                )}
                {canFollow && <span className="small">Stays put when ABC's prices change. The margin moves instead.</span>}
              </span>
            </div>
            {!canFollow && editable && (
              <p className={styles.note}>
                To follow ABC prices, pick what goes into a square from ABC Supply's catalog.{" "}
                {connected ? (
                  <button type="button" className="link-btn" onClick={() => setPicking(roof)}>Pick its materials</button>
                ) : (
                  "Connect ABC Supply first (Apps)."
                )}
              </p>
            )}
          </div>
        )}
        {shared.length > 0 && <p className={styles.note}>The {shared.map((p) => p.name).join(" and ")} {shared.length === 1 ? "package uses" : "packages use"} this roof too, so its price changes there as well.</p>}
      </div>

      {/* Always on this roof */}
      <div className={styles.part}>
        <div className={styles.partHead}>
          <div>
            <h2>Always on this roof</h2>
            <p>Priced from the measurements. Nobody has to type a number.</p>
          </div>
          {editable && addable.length > 0 && (
            <select
              className={`select ${styles.addSelect}`}
              aria-label="Add from your price list"
              value=""
              onChange={(e) => e.target.value && addItem.mutate({ serviceId: e.target.value, kind: "included" })}
            >
              <option value="">+ Add from your price list</option>
              {categories.map((c) => (
                <optgroup key={c} label={c}>
                  {addable.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>Nothing yet. Pick the roof above, then add what always goes on it.</p>
        ) : (
          <div className={styles.rows}>
            <div className={`${styles.row} ${styles.rowHead}`} aria-hidden="true">
              <span>On the estimate</span><span>How much</span><span className={styles.num}>Price</span><span>Your cost</span><span className={styles.num}>Margin</span><span />
            </div>
            <ul className={styles.rowList} aria-label="Always on this roof">
              {rows.map(({ service, item }) => (
                <AlwaysRow
                  key={service.id}
                  service={service}
                  item={item}
                  links={linksOf(service.id)}
                  editable={editable}
                  canPick={editable && connected}
                  onPick={() => setPicking(service)}
                  onRemove={() => item && removeItem.mutate(item)}
                  onCount={(quantity) => item && setCount.mutate({ item, quantity })}
                />
              ))}
            </ul>
          </div>
        )}
        {(materials.data ?? []).length > 0 && (
          <p className={styles.note}><span className={styles.abc}>ABC</span> Materials come from what you picked for each service in ABC's catalog. Change them on any roof estimate's Materials card.</p>
        )}
      </div>

      {/* Quick adds */}
      <div className={styles.part}>
        <div className={styles.partHead}>
          <div>
            <h2>Quick adds</h2>
            <p>One tap to add to an estimate, in the office or on the iPad. Anything else in your price list can still be searched.</p>
          </div>
        </div>
        {chips.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>Everything in your price list is already on this roof.</p>
        ) : editable ? (
          <>
            <div className={styles.chips} role="group" aria-label="Quick adds">
              {chips.map(({ service, on }) => (
                <button
                  key={service.id}
                  type="button"
                  className={styles.quick}
                  aria-pressed={on}
                  onClick={() => {
                    const item = pkg.items.find((i) => i.kind === "quick" && i.service_id === service.id);
                    if (item) removeItem.mutate(item);
                    else addItem.mutate({ serviceId: service.id, kind: "quick" });
                  }}
                >
                  <Icon name={on ? "check" : "plus"} size={15} strokeWidth={3} />
                  {service.name}
                  <small>{unitPrice(service.unit_price, service.unit, FORMAT, true)}</small>
                </button>
              ))}
            </div>
            <p className={styles.note}>Green ones show as buttons on the estimate. Tap one to turn it off or on.</p>
          </>
        ) : chips.some((c) => c.on) ? (
          <div className={styles.chips}>
            {chips.filter((c) => c.on).map(({ service }) => (
              <span key={service.id} className={styles.quick} data-on="">
                <Icon name="check" size={15} strokeWidth={3} />
                {service.name}
                <small>{unitPrice(service.unit_price, service.unit, FORMAT, true)}</small>
              </span>
            ))}
          </div>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>No quick adds on this package.</p>
        )}
      </div>

      {picking && (
        <MaterialPicker
          service={picking}
          lineQuantity={null}
          onClose={() => setPicking(null)}
          onAdded={() => {
            queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
            refresh();
            toast.success(`${picking.name} now has ABC materials`);
          }}
        />
      )}
    </section>
  );
}

/** One line of "Always on this roof": what it is, how much goes on, its price, cost and margin. */
function AlwaysRow({
  service,
  item,
  links,
  editable,
  canPick,
  onPick,
  onRemove,
  onCount,
}: {
  service: PriceListService;
  item: RoofPackageItem | null;
  links: ServiceMaterial[];
  editable: boolean;
  canPick: boolean;
  onPick: () => void;
  onRemove: () => void;
  onCount: (quantity: number) => void;
}) {
  const how = formulaWords(service.formula);
  const margin = marginPct(service.unit_price, service.unit_cost);
  const perUnit = round2(materialsPerUnit(links));
  const [count, setCount] = useState(String(item?.quantity ?? 1));
  useEffect(() => setCount(String(item?.quantity ?? 1)), [item?.quantity]);
  const saveCount = () => {
    const n = Math.round(Number(count) * 1000) / 1000;
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return setCount(String(item?.quantity ?? 1));
    if (n !== (item?.quantity ?? 1)) onCount(n);
  };
  return (
    <li className={styles.row}>
      <span className={styles.cellName}>
        <strong>{service.name}</strong>
        {!item && <span className={styles.sub}>The roof</span>}
        {item && !service.active && <span className={styles.sub}>Turned off in your price list, so it's left off</span>}
      </span>
      <span className={styles.cellHow}>
        {how ?? (
          item && editable ? (
            <label className={styles.count}>
              Count it, starts at
              <input className="input input-sm" type="number" inputMode="decimal" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} onBlur={saveCount} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </label>
          ) : (
            `Count it${item?.quantity ? ` (starts at ${item.quantity})` : ""}`
          )
        )}
      </span>
      <span className={`${styles.cellPrice} ${styles.num}`} data-label="Price">{unitPrice(service.unit_price, service.unit, FORMAT)}</span>
      <span className={styles.cellCost} data-label="Your cost">
        {service.unit_cost !== null ? unitPrice(service.unit_cost, service.unit, FORMAT) : <span className="muted">—</span>}
        {links.length > 0 ? (
          <span className={styles.sub}>ABC {money(perUnit)} + labor {money(service.labor_cost ?? 0)}</span>
        ) : canPick && !item ? (
          <button type="button" className={`link-btn ${styles.sub}`} onClick={onPick}>Pick ABC materials</button>
        ) : null}
      </span>
      <span className={`${styles.cellMargin} ${styles.num}`} data-label="Margin">{margin !== null ? `${margin}%` : "—"}</span>
      <span className={styles.cellRemove}>
        {item && editable && <Button size="sm" variant="ghost" icon="x" aria-label={`Take ${service.name} off this package`} onClick={onRemove} />}
      </span>
    </li>
  );
}
