/**
 * Packages: services sold together, for every trade. A roofer's are Roofing → Packages: what goes on
 * each kind of roof, the roof itself priced by the square (a price set by hand, or one that follows
 * ABC Supply: materials plus labor and the rest, plus a markup), with the price range settings
 * (companies.settings.roofing) and the ABC Supply connection the prices come from. Every other trade
 * has /packages (Settings → Packages): a main service if there is one, the rest the same.
 *
 * A package has what's always on it (measured, or counted, like 3 pipe boots), and what the
 * customer reads when it's offered as one of two or three options: its tier, picture, highlights,
 * warranty and contract sections. A roof's package also has the quick adds a person puts on an
 * estimate with one tap (only a roofer's estimate and iPad visit show them, so only Roofing →
 * Packages sets them). Until each package has the business's own warranty, the page says the one
 * setup gave it is example wording.
 *
 * The pieces other screens show (PackagePicker, the cards a salesperson picks one package from, or
 * two or three to offer as options; a package's picture; the highlights input) are PackageCards.tsx,
 * so those screens don't load this page.
 */
import { STARTER_NOTE } from "@crewtavo/core/contracts";
import { followPrice, LOW_MARGIN, marginForMarkup, marginPct, markupForMargin, priceRange, RANGE_ROUNDING, rangeSettings, TYPICAL_SQUARES_MAX, typicalRoof, typicalSquares } from "@crewtavo/core/estimates";
import { materialsPerUnit, unpricedLinks } from "@crewtavo/core/materials";
import { getPreset, isExampleWarranty, PACKAGE_LIMITS } from "@crewtavo/core/presets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Button, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { PageHeader } from "@/components/ui/PageHeader";
import { SaveStatus, useSaveStatus, type SaveStatusHandle } from "@/components/ui/SaveStatus";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { packagePicture } from "@/lib/files";
import { formatMoney, formatMoneyCents, timeAgo } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { startTask } from "@/lib/tasks";
import { toast } from "@/lib/toast";
import { customFieldsKey, customFieldsQuery } from "../customFields/CustomFields";
import { CATALOG_MATERIALS, useServiceMaterials, useSupplier, type ServiceMaterial } from "../materials/data";
import { MaterialPicker } from "../materials/MaterialPicker";
import { RoofingTabs } from "./RoofingTabs";
import {
  cleanHighlights,
  copyName,
  exampleWarrantyNote,
  formulaWords,
  isRoofingCompany,
  isSquareUnit,
  moneyText,
  PACKAGE_NAME_MAX,
  PACKAGE_STYLES,
  packagePriceLine,
  quickAddChips,
  roofServiceKind,
  sameList,
  squarePrice,
  toggleSection,
  typedOrSaved,
  unitPrice,
} from "./data";
import { HighlightsField, PackageArt, PackagePicture, TierWords } from "./PackageCards";
import {
  canEditContracts,
  canEditPackages,
  canEditRanges,
  canSeePackages,
  canSetUpRoofing,
  followedPriceOf,
  followedPrices,
  missingRoofingFields,
  packagesKey,
  removePackagePicture,
  setPackagePicture,
  setUpRoofing,
  setupMessage,
  typicalFigures,
  useContractLibrary,
  usePriceList,
  useRoofPackages,
  type PriceListService,
  type RoofPackage,
  type RoofPackageItem,
} from "./packages";
import styles from "./RoofPackagesPage.module.css";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";
import { NumberInput } from "@/components/ui/NumberInput";

const FORMAT = { whole: formatMoney, cents: formatMoneyCents };
const money = (n: number) => moneyText(n, FORMAT);
const round2 = (n: number) => Math.round(n * 100) / 100;
const SERVICES_KEY = (companyId: string) => ["services", companyId, "roof-packages"];

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

/**
 * Roofing → Packages (/roofing/packages), for the people who price work (they're read with the price
 * list). Any other trade's packages are /packages, so a link here from before goes there.
 */
export function RoofPackagesPage() {
  const session = useSession();
  const { search } = useLocation();
  if (!isRoofingCompany(session.company)) return <Navigate to={{ pathname: "/packages", search }} replace />;
  return canSeePackages(session) ? <PackagesScreen roofing /> : <NoAccess title="Roofing" />;
}

/** Packages (/packages, from Settings) for every other trade. A roofer's are under Roofing, so they go there. */
export function PackagesPage() {
  const session = useSession();
  const { search } = useLocation();
  if (isRoofingCompany(session.company)) return <Navigate to={{ pathname: "/roofing/packages", search }} replace />;
  return canSeePackages(session) ? <PackagesScreen roofing={false} /> : <NoAccess title="Packages" />;
}

/**
 * The list of packages and the one picked. `roofing` (Roofing → Packages) prices each roof by the
 * square and adds the range settings, ABC Supply and the standard roofing packages and services.
 */
function PackagesScreen({ roofing }: { roofing: boolean }) {
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
  // The package and the price ranges save as they're changed; the header says how that's going.
  const save = useSaveStatus();
  const listRef = useListAnimation<HTMLUListElement>();

  const create = useMutation({
    meta: { success: "Package added" },
    mutationFn: async () => {
      // A roof starts from the first roof in the price list (priced by the square, with waste);
      // anything else starts empty.
      const roof = roofing ? ((services.data ?? []).find((s) => s.active && isSquareUnit(s.unit) && roofServiceKind(s.formula, s.name) === "roof") ?? null) : null;
      const sort = list.reduce((max, p) => Math.max(max, p.sort), -1) + 1;
      return unwrap(await supabase().from("roof_packages").insert({ company_id: company.id, name: "New package", style: "other", roof_service_id: roof?.id ?? null, is_default: list.length === 0, sort }).select("id").single());
    },
    onSuccess: async (row) => {
      await queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
      select(row.id);
    },
  });

  const newPackage = (
    <>
      <SaveStatus status={save.status} />
      {editable && list.length > 0 && <Button variant="primary" icon="plus" loading={create.isPending} onClick={() => create.mutate()}>New package</Button>}
    </>
  );
  const header = roofing ? (
    <>
      <PageHeader
        title="Roofing"
        actions={newPackage}
        lede={<span className="hide-mobile">What goes on each kind of roof. Pick a package when you start an estimate, and the roof's measurements fill in the amounts.</span>}
      />
      <RoofingTabs />
    </>
  ) : (
    <PageHeader
      title="Packages"
      actions={newPackage}
      lede="Services you sell together, each with a picture so it's easy to pick. Put one on an estimate, or offer two or three side by side."
    />
  );
  const side = roofing || list.length > 0;
  const examples = exampleWarrantyNote(list);
  const byId = useMemo(() => new Map((services.data ?? []).map((s) => [s.id, s])), [services.data]);
  const typical = useMemo(() => typicalRoof(typicalSquares(company.settings)), [company.settings]);

  if (packages.isPending || services.isPending) {
    return (
      <>
        {header}
        <Loading className={styles.layout} label="Loading packages">
          <div className={styles.side}>
            <div className={styles.listBlock}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={styles.skRow}>
                  <Skeleton width={36} height={36} radius={8} />
                  <span className={styles.skLines}><Skeleton width="60%" height={11} /><Skeleton width="85%" height={9} /></span>
                </div>
              ))}
            </div>
            {roofing && <div className={styles.settings}><SectionSkeleton rows={2} /></div>}
          </div>
          <div className={styles.main}>
            <div className={styles.editor}>
              <SectionSkeleton rows={2} />
              <SectionSkeleton rows={3} />
              <SectionSkeleton rows={5} />
            </div>
          </div>
        </Loading>
      </>
    );
  }
  if (packages.error || services.error) {
    return (
      <>
        {header}
        <ErrorState error={packages.error ?? services.error} onRetry={() => { packages.refetch(); services.refetch(); }} />
      </>
    );
  }

  return (
    <>
      {header}
      <div className={styles.layout} data-single={side ? undefined : ""}>
        {side && (
          <div className={styles.side}>
            {(examples || list.length > 0) && (
              <div className={styles.listBlock}>
                {/* Setup's example warranties, until each package has the business's own. */}
                {examples && (
                  <div className={`callout ${styles.examples}`}>
                    <Icon name="info" size={16} />
                    <div className="grow">{examples}</div>
                  </div>
                )}
                {list.length > 0 && (
                  <ul ref={listRef} className={styles.list} aria-label="Packages">
                    {list.map((p) => {
                      const main = services.data.find((s) => s.id === p.roof_service_id);
                      // A roof's are the whole package's on the typical roof (what's always on it too), not just the roof line's.
                      const figures = roofing ? typicalFigures(p, byId, typical) : null;
                      const margin = roofing ? (figures?.margin ?? null) : main ? marginPct(main.unit_price, main.unit_cost) : null;
                      const price = roofing ? (figures?.perUnit ? `${money(figures.perUnit)} a square` : (squarePrice(main, FORMAT) ?? "Pick the roof")) : main ? unitPrice(main.unit_price, main.unit, FORMAT) : packagePriceLine(p, false, FORMAT);
                      return (
                        <li key={p.id}>
                          <button type="button" className={styles.pkg} aria-current={p.id === selected?.id ? "true" : undefined} onClick={() => select(p.id)}>
                            <PackagePicture path={p.picture} style={p.style} className={styles.tile} />
                            <span className={styles.pkgText}>
                              <span className={styles.pkgName}>
                                <span>{p.name}</span>
                                {roofing && p.is_default && <span className="tag">Default</span>}
                              </span>
                              <span className={styles.pkgSub}>{[p.tier, price, margin !== null ? `${margin}% margin` : null].filter(Boolean).join(" · ")}</span>
                              {isExampleWarranty(p.warranty) && (
                                <span className={styles.flag}>
                                  <Icon name="alert" size={12} />
                                  Example warranty
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {editable && (
                      <li>
                        <button type="button" className={styles.addPkg} onClick={() => create.mutate()} disabled={create.isPending}>
                          <Icon name="plus" size={16} />Add a package
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            )}
            {roofing && (
              <div className={styles.settings}>
                <RangeCard save={save} />
                <SupplierCard packages={list} />
                {list.length > 0 && <MissingServices services={services.data} />}
              </div>
            )}
          </div>
        )}
        <div className={styles.main}>
          {selected ? (
            <PackageEditor key={selected.id} pkg={selected} packages={list} services={services.data} editable={editable} roofing={roofing} onSelect={select} save={save} />
          ) : (
            <NoPackages roofing={roofing} onCreate={() => create.mutate()} creating={create.isPending} />
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A business with no packages yet: a roofer can set up the standard three; anyone who changes
 * packages can start one from scratch.
 */
function NoPackages({ roofing, onCreate, creating }: { roofing: boolean; onCreate: () => void; creating: boolean }) {
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
  if (!roofing) {
    return (
      <EmptyState icon="package" title="No packages yet" action={editable && <Button variant="primary" icon="plus" loading={creating} onClick={onCreate}>New package</Button>}>
        A package is a set of services you sell together, with a picture so it's easy to pick.
        {!editable && " Ask the office to set them up."}
      </EmptyState>
    );
  }
  return (
    <EmptyState
        icon="package"
        title="No roof packages yet"
        action={
          (canSetUp || editable) && (
            <>
              {canSetUp && <Button variant="primary" icon="package" loading={setup.isPending} onClick={() => setup.mutate()}>Set up the standard packages</Button>}
              {editable && <Button variant="ghost" icon="plus" loading={creating} onClick={onCreate}>Start from scratch</Button>}
            </>
          )
        }
      >
        A package is what goes on a kind of roof: the shingles or metal by the square, what's always on it, and one-tap extras. The standard three are Architectural shingle, Designer shingle and Standing-seam metal.
        {!canSetUp && !editable && " Ask the office to set them up."}
      </EmptyState>
  );
}

// ---------------------------------------------------------------------------------------------
// Price ranges (companies.settings.roofing) and where prices come from
// ---------------------------------------------------------------------------------------------

/** The example every business sees, so the sentence always reads the same way. */
const EXAMPLE_ESTIMATE = 18304;

type RoofingSettingsPatch = { range_pct?: number; range_round?: number; typical_squares?: number };

/** Saves companies.settings.roofing: the price ranges, and the typical roof a package's margin is shown on. */
function useSaveRoofingSettings() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inline: true },
    mutationFn: async (patch: RoofingSettingsPatch) => {
      // Read the settings fresh, so a change someone made meanwhile isn't undone.
      const current = await loadSettings(company.id);
      const roofing = { ...((current.roofing ?? {}) as Record<string, unknown>), ...patch };
      unwrap(await supabase().from("companies").update({ settings: { ...current, roofing } as never }).eq("id", company.id));
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["company", company.id] });
      await session.refresh();
    },
  });
}

function RangeCard({ save }: { save: SaveStatusHandle }) {
  const session = useSession();
  const { company } = session;
  const editable = canEditRanges(session);
  const saved = rangeSettings(company.settings);
  const saveRange = useSaveRoofingSettings();
  const shown = saveRange.isPending && saveRange.variables ? rangeSettings({ roofing: { range_pct: saved.pct, range_round: saved.round, ...saveRange.variables } }) : saved;
  const change = (patch: { range_pct?: number; range_round?: number }) => void save.track(saveRange.mutateAsync(patch));
  const example = priceRange(EXAMPLE_ESTIMATE, shown);
  return (
    <Section title="Price ranges">
      <p className={styles.sideText} style={{ marginBottom: 12 }}>For every package. The low end is the estimate; the high end leaves room for what only shows up on site, like rotten decking.</p>
      {editable ? (
        <div className={styles.rangeFields}>
          <Field label="Room on top">
            <MoneyInput percent max={100} width={110} value={shown.pct} onSave={(v) => change({ range_pct: v })} />
          </Field>
          <Field label="Round to">
            <Select className="select" value={shown.round} onChange={(e) => change({ range_round: Number(e.target.value) })} disabled={saveRange.isPending}>
              {RANGE_ROUNDING.map((r) => <option key={r} value={r}>{formatMoney(r)}</option>)}
            </Select>
          </Field>
        </div>
      ) : (
        <p className={styles.sideText}>
          {shown.pct}% on top, rounded to {formatMoney(shown.round)}. <span className="muted">An owner or admin can change this.</span>
        </p>
      )}
      <p className={styles.example}>
        An {formatMoney(EXAMPLE_ESTIMATE)} estimate goes out as <strong className={styles.ink}>{formatMoney(example.low)} to {formatMoney(example.high)}</strong>.
      </p>
    </Section>
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
  // ABC prices every package's materials in its own time, so the update shows in the task island.
  const update = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const task = startTask({ label: "Updating prices from ABC" });
      try {
        const r = await api.post<{ priced_at: string | null; branch_name: string | null; services: number }>("/roofing/prices");
        task.done(r.priced_at ? `Prices updated from ${r.branch_name}` : "None of your packages' services have ABC materials yet");
        return r;
      } catch (error) {
        task.fail(errorMessage(error));
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
      queryClient.invalidateQueries({ queryKey: ["services", company.id] });
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
    },
  });
  const canOpenApps = hasRole(session, "admin") && can(session, "apps");

  if (supplier.isPending) return <SectionSkeleton rows={1} />;
  if (supplier.error) return <Section title="ABC Supply"><ErrorState compact error={supplier.error} onRetry={() => supplier.refetch()} /></Section>;
  const s = supplier.data;
  return (
    <Section
      title="ABC Supply"
      action={s?.status === "connected" ? <StatusPill label="Connected" tone="good" /> : s?.status === "error" ? <StatusPill label="Needs attention" tone="danger" /> : undefined}
    >
      {!s ? (
        <>
          <p className={styles.sideText}>Price your roofs from your own ABC Supply account, at your branch's prices, and let a package follow them.</p>
          <div className={styles.sideActions}>
            {canOpenApps ? <Link className="btn btn-sm" to="/apps/abc_supply">Connect ABC Supply</Link> : <span className="muted small">An owner or admin can connect it in Apps.</span>}
          </div>
        </>
      ) : s.status === "error" ? (
        <>
          <p className={styles.sideText}>{s.last_error ?? "ABC Supply stopped answering."} Packages keep the last prices until it's fixed.</p>
          {canOpenApps && <div className={styles.sideActions}><Link className="link-btn small" to="/apps/abc_supply">Open in Apps</Link></div>}
        </>
      ) : (
        <>
          <div className={styles.line}>
            <span className="grow">
              Your prices at {s.branch_name}.{" "}
              {links.isPending && ids.length ? null : pricedAt ? `Priced ${timeAgo(pricedAt)}.` : "None of your packages' services have ABC materials yet."}
            </span>
            {canEditPackages(session) && pricedAt !== undefined && (
              <Button size="sm" icon="refresh" loading={update.isPending} slowHint={false} onClick={() => update.mutate()}>
                Update prices
              </Button>
            )}
          </div>
          {canOpenApps && <div className={styles.sideActions}><Link className="link-btn small" to="/apps/abc_supply">Open in Apps</Link></div>}
        </>
      )}
    </Section>
  );
}

/**
 * The standard roofing services a price list doesn't have yet (Ridge vent, Ice and water shield…),
 * and the insurance claim fields a business's quotes and jobs don't have yet (insurance company,
 * claim number, adjuster, date of loss, deductible). One button adds what's missing of both.
 */
function MissingServices({ services }: { services: PriceListService[] }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const fields = useQuery({ ...customFieldsQuery(session.company.id), meta: { silent: true } });
  const add = useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
      queryClient.invalidateQueries({ queryKey: packagesKey(session.company.id) });
      queryClient.invalidateQueries({ queryKey: customFieldsKey(session.company.id) });
    },
  });
  if (!canSetUpRoofing(session)) return null;
  const have = new Set(services.map((s) => s.name.trim().toLowerCase()));
  const missing = getPreset("roofing_exteriors").services.filter((s) => !have.has(s.name.toLowerCase()));
  // Not known until the fields have loaded: nothing is said about them before then.
  const missingFields = fields.data ? missingRoofingFields(fields.data) : [];
  if (!missing.length && !missingFields.length) return null;
  return (
    <Section title="Standard roofing setup">
      {missing.length > 0 && (
        <p className={styles.sideText}>
          {missing.length} standard roofing {missing.length === 1 ? "service isn't" : "services aren't"} in your price list yet, like {missing.slice(0, 2).map((s) => s.name).join(" and ")}.
        </p>
      )}
      {missingFields.length > 0 && (
        <p className={styles.sideText} style={missing.length > 0 ? { marginTop: 8 } : undefined}>
          Your quotes and jobs can keep an insurance claim's details: {missingFields.join(", ").toLowerCase()}. They carry from the quote to its job, and you can change them in Settings → Custom fields.
        </p>
      )}
      <div className={styles.sideActions}>
        <Button size="sm" icon="plus" loading={add.isPending} onClick={() => add.mutate()}>Add {missing.length + missingFields.length === 1 ? "it" : "them"}</Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// One package
// ---------------------------------------------------------------------------------------------

type PackagePatch = Partial<Pick<RoofPackage, "name" | "style" | "roof_service_id" | "price_mode" | "markup_pct" | "tier" | "highlights" | "warranty" | "section_ids">>;

function PackageEditor({ pkg, packages, services, editable, roofing, onSelect, save }: { pkg: RoofPackage; packages: RoofPackage[]; services: PriceListService[]; editable: boolean; roofing: boolean; onSelect: (id: string | null) => void; save: SaveStatusHandle }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const supplier = useSupplier();
  // ABC Supply prices roofs; other trades' packages are priced by hand.
  const connected = roofing && supplier.data?.status === "connected";
  const byId = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const roof = pkg.roof_service_id ? (byId.get(pkg.roof_service_id) ?? null) : null;
  const included = pkg.items.filter((i) => i.kind === "included");
  const materialIds = [roof?.id, ...pkg.items.map((i) => i.service_id)].filter((id): id is string => Boolean(id));
  const materials = useServiceMaterials(materialIds);
  const loadingMaterials = materialIds.length > 0 && materials.isPending;
  const linksOf = (serviceId: string): ServiceMaterial[] => (materials.data ?? []).filter((m) => m.service_id === serviceId);
  const [picking, setPicking] = useState<PriceListService | null>(null);
  const rowsRef = useListAnimation<HTMLUListElement>();

  // Changes save one after another (scope), each shown straight away. The lists are read again once
  // the last one is done, which also puts back anything that failed. The header says "Saving…",
  // "Saved" or "Couldn't save" for all of them (inline), rather than a toast for each.
  const mutationKey = ["roof-package", pkg.id];
  const scope = { id: `roof-package-${pkg.id}` };
  const meta = { inline: true };
  const run = <V,>(mutation: { mutateAsync: (variables: V) => Promise<unknown> }, variables: NoInfer<V>) => void save.track(mutation.mutateAsync(variables));
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
  const canFollow = roofing && roofLinks.length > 0;
  // Materials the branch never priced: following would leave them out, so the price holds until they have one.
  const unpriced = unpricedLinks(roofLinks);
  // Materials ABC didn't price last time, kept at their last price.
  const stale = roofLinks.filter((l) => l.price_note && !unpriced.includes(l));
  const followed = (labor: number | null, markup: number) => (unpriced.length ? undefined : followPrice(perSquareExact, labor, markup));

  const savePackage = useMutation({
    mutationKey,
    scope,
    meta,
    mutationFn: async ({ patch, prices }: { patch: PackagePatch; prices?: ReadonlyMap<string, number> }) => {
      unwrap(await supabase().from("roof_packages").update(patch).eq("id", pkg.id));
      for (const [id, unit_price] of prices ?? []) unwrap(await supabase().from("services").update({ unit_price }).eq("id", id));
      // A new roof isn't also one of the package's extras.
      if (patch.roof_service_id) unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", patch.roof_service_id));
    },
    onMutate: ({ patch, prices }) => {
      patchPackage((p) => ({ ...p, ...patch, items: patch.roof_service_id ? p.items.filter((i) => i.service_id !== patch.roof_service_id) : p.items }));
      for (const [id, unit_price] of prices ?? []) patchService(id, { unit_price });
    },
    onSettled: refresh,
  });
  const saveService = useMutation({
    mutationKey,
    scope,
    meta,
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Pick<PriceListService, "unit_price">> }) => unwrap(await supabase().from("services").update(patch).eq("id", id)),
    onMutate: ({ id, patch }) => patchService(id, patch),
    onSettled: refresh,
  });
  const saveLabor = useMutation({
    mutationKey,
    scope,
    meta,
    mutationFn: async (labor: number) => {
      await api.put(`/services/${roof!.id}/labor`, { labor_cost: labor });
      const price = pkg.price_mode === "follow" ? followed(labor, pkg.markup_pct) : undefined;
      if (price !== undefined) unwrap(await supabase().from("services").update({ unit_price: price }).eq("id", roof!.id));
    },
    onMutate: (labor) => {
      const price = pkg.price_mode === "follow" ? followed(labor, pkg.markup_pct) : undefined;
      patchService(roof!.id, { labor_cost: labor, ...(price !== undefined ? { unit_price: price } : {}) });
    },
    onSettled: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["service-costs", company.id] });
    },
  });
  const nextSort = (kind: RoofPackageItem["kind"]) => pkg.items.filter((i) => i.kind === kind).reduce((max, i) => Math.max(max, i.sort), -1) + 1;
  const addItem = useMutation({
    mutationKey,
    scope,
    meta,
    mutationFn: async ({ serviceId, kind }: { serviceId: string; kind: RoofPackageItem["kind"] }) => {
      // Always on the roof means it isn't a quick add any more.
      if (kind === "included") unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", serviceId).eq("kind", "quick"));
      unwrap(await supabase().from("roof_package_items").insert({ company_id: company.id, package_id: pkg.id, service_id: serviceId, kind, quantity: null, sort: nextSort(kind) }));
      // On a package that follows ABC, it's priced from ABC like the rest of it.
      const price = pkg.price_mode === "follow" ? await followedPriceOf(serviceId, pkg.markup_pct) : null;
      if (price !== null) unwrap(await supabase().from("services").update({ unit_price: price }).eq("id", serviceId));
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
    meta,
    mutationFn: async (item: RoofPackageItem) => unwrap(await supabase().from("roof_package_items").delete().eq("package_id", pkg.id).eq("service_id", item.service_id).eq("kind", item.kind)),
    onMutate: (item) => patchPackage((p) => ({ ...p, items: p.items.filter((i) => !(i.service_id === item.service_id && i.kind === item.kind)) })),
    onSettled: refresh,
  });
  const setCount = useMutation({
    mutationKey,
    scope,
    meta,
    mutationFn: async ({ item, quantity }: { item: RoofPackageItem; quantity: number }) =>
      unwrap(await supabase().from("roof_package_items").update({ quantity }).eq("package_id", pkg.id).eq("service_id", item.service_id).eq("kind", item.kind)),
    onMutate: ({ item, quantity }) => patchPackage((p) => ({ ...p, items: p.items.map((i) => (i.service_id === item.service_id && i.kind === item.kind ? { ...i, quantity } : i)) })),
    onSettled: refresh,
  });

  const copy = useMutation({
    meta: { success: "Package copied" },
    mutationFn: async () => {
      const db = supabase();
      const sort = packages.reduce((max, p) => Math.max(max, p.sort), -1) + 1;
      // The same picture file: pictures are never changed or deleted, so both can show it.
      const row = unwrap(
        await db
          .from("roof_packages")
          .insert({
            company_id: company.id, name: copyName(pkg.name), style: pkg.style, roof_service_id: pkg.roof_service_id, price_mode: pkg.price_mode, markup_pct: pkg.markup_pct, is_default: false, sort,
            tier: pkg.tier, picture: pkg.picture, picture_width: pkg.picture_width, picture_height: pkg.picture_height, highlights: pkg.highlights, warranty: pkg.warranty, section_ids: pkg.section_ids,
          })
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
  // Only a roofer's new estimates start from the default package, so only Roofing → Packages sets it.
  const makeDefault = useMutation({
    meta: { success: `New roof estimates start with ${pkg.name}` },
    mutationFn: async () => {
      const db = supabase();
      unwrap(await db.from("roof_packages").update({ is_default: false }).eq("company_id", company.id).eq("is_default", true));
      unwrap(await db.from("roof_packages").update({ is_default: true }).eq("id", pkg.id));
    },
    onSettled: refresh,
  });

  // Typed and then put back as it was: nothing to save, so the header stops saying Edited.
  const unchanged = () => save.status === "edited" && save.reset();
  const [name, setName] = useState(pkg.name);
  useEffect(() => setName(pkg.name), [pkg.name]);
  const saveName = () => {
    const clean = name.trim().slice(0, PACKAGE_NAME_MAX);
    if (!clean) {
      unchanged();
      return setName(pkg.name);
    }
    if (clean !== pkg.name) run(savePackage, { patch: { name: clean } });
    else unchanged();
  };
  const tiersId = useId();
  const [tier, setTier] = useState(pkg.tier ?? "");
  useEffect(() => setTier(pkg.tier ?? ""), [pkg.tier]);
  const saveTier = () => {
    const clean = tier.trim().slice(0, PACKAGE_LIMITS.tier) || null;
    setTier(clean ?? "");
    if (clean !== pkg.tier) run(savePackage, { patch: { tier: clean } });
    else unchanged();
  };
  // Lines being typed stay as they are until they're saved (cleanHighlights), and while what's saved
  // is what they come to, so a line just added isn't taken away by the save before it.
  const [highlights, setHighlights] = useState(pkg.highlights);
  const savedHighlights = JSON.stringify(pkg.highlights);
  useEffect(() => {
    const saved = JSON.parse(savedHighlights) as string[];
    setHighlights((typed) => typedOrSaved(typed, saved));
  }, [savedHighlights]);
  const saveHighlights = (lines: string[]) => {
    const clean = cleanHighlights(lines);
    if (!sameList(clean, pkg.highlights)) run(savePackage, { patch: { highlights: clean } });
    else unchanged();
  };
  const [warranty, setWarranty] = useState(pkg.warranty);
  useEffect(() => setWarranty(pkg.warranty), [pkg.warranty]);
  const saveWarranty = () => {
    const clean = warranty.trim().slice(0, PACKAGE_LIMITS.warranty);
    setWarranty(clean);
    if (clean !== pkg.warranty) run(savePackage, { patch: { warranty: clean } });
    else unchanged();
  };

  const roofChoices = services.filter((s) => (s.active && isSquareUnit(s.unit)) || s.id === pkg.roof_service_id);
  const mainChoices = services.filter((s) => s.active || s.id === pkg.roof_service_id);
  const shared = roof ? packages.filter((p) => p.id !== pkg.id && p.roof_service_id === roof.id) : [];
  const onRoof = new Set([pkg.roof_service_id, ...included.map((i) => i.service_id)]);
  const addable = services.filter((s) => s.active && !onRoof.has(s.id));
  const categories = [...new Set(addable.map((s) => s.category?.trim() || "Other"))];
  const chips = quickAddChips(services, pkg.items, pkg.roof_service_id);
  const following = roofing && pkg.price_mode === "follow";
  // Everything on it with ABC materials at today's prices and this markup: the roof, what's always on it, its quick adds.
  const followAt = (markup: number) => followedPrices(pkg, byId, materials.data ?? [], markup);
  const follows = following ? followAt(pkg.markup_pct) : undefined;
  const setMarkup = (markup: number) => run(savePackage, { patch: { markup_pct: markup }, prices: following ? followAt(markup) : undefined });
  // The whole package a square on the typical roof: what's always on it, spread over the roof's squares.
  const squares = typicalSquares(company.settings);
  const whole = roofing ? typicalFigures(pkg, byId, typicalRoof(squares), follows) : null;
  const roofSquare = roof ? (follows?.get(roof.id) ?? roof.unit_price) : 0;
  const [byMargin, setByMargin] = useState(readByMargin);
  const chooseMargin = (on: boolean) => {
    setByMargin(on);
    storeByMargin(on);
  };
  const customer = roofing ? "homeowner" : "customer";
  const rows: Array<{ service: PriceListService; item: RoofPackageItem | null }> = [
    ...(roof ? [{ service: roof, item: null }] : []),
    ...included.flatMap((item) => {
      const service = byId.get(item.service_id);
      return service ? [{ service, item }] : [];
    }),
  ];

  // "Add from your price list": a menu of what isn't on it yet, by category, with a search over it.
  const [addTerm, setAddTerm] = useState("");
  const term = addTerm.trim().toLowerCase();
  const addItems: MenuEntry[] = categories.flatMap((c): MenuEntry[] => {
    const inCategory = addable.filter((s) => (s.category?.trim() || "Other") === c && (!term || s.name.toLowerCase().includes(term)));
    if (!inCategory.length) return [];
    return [
      ...(categories.length > 1 ? [{ heading: c }] : []),
      ...inCategory.map((s) => ({ label: s.name, end: unitPrice(s.unit_price, s.unit, FORMAT, true), onSelect: () => run(addItem, { serviceId: s.id, kind: "included" }) })),
    ];
  });
  // The package's own actions past Copy: the default for new roof estimates, then delete.
  const deletePackage = async () => (await confirm({ title: `Delete the ${pkg.name} package?`, body: "Estimates already made with it keep their lines.", confirmLabel: "Delete", danger: true })) && remove.mutate();
  const moreItems: MenuEntry[] = [
    { label: "Make it the default", description: "New roof estimates start with it", icon: "star", hidden: !roofing || pkg.is_default, disabled: makeDefault.isPending, onSelect: () => makeDefault.mutate() },
    { separator: true },
    { label: "Delete package", icon: "trash", danger: true, disabled: remove.isPending, onSelect: () => void deletePackage() },
  ];

  const roofHint = roof ? `Priced by the square from the roof's measurements${roof.formula ? ` (${formulaWords(roof.formula)?.toLowerCase()})` : ""}.` : "Pick the service in your price list that prices this roof by the square.";
  const mainHint = roof ? `Its price shows on the package's card${roof.formula ? `, measured: ${formulaWords(roof.formula)?.toLowerCase()}` : ""}.` : "What this package is mostly about, if there's one service. Its price shows on the package's card.";

  return (
    <section className={styles.editor} aria-label={pkg.name}>
      {/* Name, tier and the package's own actions; its picture and style; the roof */}
      <div className={styles.look}>
        {editable ? (
          <div className={styles.head}>
            <Field label="Package name" className={styles.nameField}>
              <input className="input" value={name} maxLength={PACKAGE_NAME_MAX} onChange={(e) => {
                  setName(e.target.value);
                  save.edited();
                }} onBlur={saveName} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </Field>
            <Field label="Tier" optional>
              <input className="input" list={tiersId} value={tier} maxLength={PACKAGE_LIMITS.tier} placeholder="Good, Better…" onChange={(e) => {
                  setTier(e.target.value);
                  save.edited();
                }} onBlur={saveTier} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
              <TierWords id={tiersId} />
            </Field>
            <div className={styles.headActions}>
              <Button variant="ghost" size="sm" icon="copy" loading={copy.isPending} onClick={() => copy.mutate()}>Copy</Button>
              <Menu items={moreItems} label="More package actions" title={pkg.name} triggerClassName="btn btn-sm btn-ghost btn-icon" />
            </div>
          </div>
        ) : (
          <div className={styles.readHead}>
            <PackagePicture path={pkg.picture} style={pkg.style} className={styles.tile} />
            <h2 className={styles.title}>{pkg.name}</h2>
            {pkg.tier && <span className="tag">{pkg.tier}</span>}
            {roofing && pkg.is_default && <span className="tag">Default</span>}
          </div>
        )}
        {editable && (
          <PictureControl pkg={pkg} customer={customer}>
            {roofing && (
              <div className={`segmented ${styles.styleRow}`} role="group" aria-label="Drawing on its card, without a picture">
                {PACKAGE_STYLES.map((s) => (
                  <button key={s.id} type="button" aria-pressed={pkg.style === s.id} onClick={() => pkg.style !== s.id && run(savePackage, { patch: { style: s.id } })}>
                    <PackageArt style={s.id} size={14} />
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </PictureControl>
        )}
        {editable && roofing ? (
          <Field label="The roof" hint={roofHint}>
            <Select className="select" value={pkg.roof_service_id ?? ""} onChange={(e) => e.target.value && run(savePackage, { patch: { roof_service_id: e.target.value } })}>
              {!pkg.roof_service_id && <option value="">Pick the roof…</option>}
              {(roofChoices.length ? roofChoices : services.filter((s) => s.active)).map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (turned off)"}</option>)}
            </Select>
          </Field>
        ) : editable ? (
          <Field label="Main service" optional hint={mainHint}>
            <Select className="select" value={pkg.roof_service_id ?? ""} onChange={(e) => run(savePackage, { patch: { roof_service_id: e.target.value || null } })}>
              <option value="">None</option>
              {[...new Set(mainChoices.map((s) => s.category?.trim() || "Other"))].map((c) => (
                <optgroup key={c} label={c}>
                  {mainChoices.filter((s) => (s.category?.trim() || "Other") === c).map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (turned off)"}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>

      {/* The price a square (a roof), or the main service's price */}
      {(roofing || roof) && (
        <Section
          className={styles.priceSection}
          title={roofing ? "Price a square" : "Price"}
          action={
            editable && roof && roofing ? (
              <div className="segmented" role="group" aria-label="How the price is set">
                <button type="button" aria-pressed={!following} onClick={() => following && run(savePackage, { patch: { price_mode: "manual" } })}>Set it yourself</button>
                <button
                  type="button"
                  aria-pressed={following}
                  disabled={!canFollow && !following}
                  title={canFollow ? undefined : "Pick this roof's materials from ABC Supply first"}
                  onClick={() => !following && run(savePackage, { patch: { price_mode: "follow" }, prices: followAt(pkg.markup_pct) })}
                >
                  Follow ABC prices
                </button>
              </div>
            ) : undefined
          }
        >
          {!roof ? (
            <p className={styles.note}>{roofing ? "Pick the roof above, and its price a square shows here." : "Pick the main service above, and its price shows here."}</p>
          ) : loadingMaterials ? (
            <Skeleton height={84} radius={8} />
          ) : (
            <>
              <dl className={styles.ledger}>
                {following && canFollow ? (
                  <>
                    <div className={styles.lrow}>
                      <dt><span><span className={styles.abc}>ABC</span>Materials, a square</span></dt>
                      <dd>{formatMoneyCents(perSquare)}</dd>
                    </div>
                    <div className={styles.lrow}>
                      <dt>Labor and the rest, a square</dt>
                      <dd>{editable ? <MoneyInput width={110} label="Labor and the rest, a square" value={roof.labor_cost ?? 0} onSave={(v) => run(saveLabor, v)} /> : formatMoneyCents(roof.labor_cost ?? 0)}</dd>
                    </div>
                    <div className={styles.lrow}>
                      <dt>
                        {editable ? (
                          <span className={`segmented ${styles.markupSwitch}`} role="group" aria-label="Set the price by">
                            <button type="button" aria-pressed={!byMargin} onClick={() => chooseMargin(false)}>Markup</button>
                            <button type="button" aria-pressed={byMargin} onClick={() => chooseMargin(true)}>Margin</button>
                          </span>
                        ) : (
                          "Markup"
                        )}
                      </dt>
                      <dd>
                        <span className={styles.conv}>{byMargin && editable ? `${pkg.markup_pct}% markup` : `${Math.round(marginForMarkup(pkg.markup_pct))}% margin`}</span>
                        {!editable ? (
                          `${pkg.markup_pct}%`
                        ) : byMargin ? (
                          <MoneyInput key="margin" percent max={90} width={96} label="Margin percent" value={marginForMarkup(pkg.markup_pct)} onSave={(v) => setMarkup(markupForMargin(v))} />
                        ) : (
                          <MoneyInput key="markup" percent max={1000} width={96} label="Markup percent" value={pkg.markup_pct} onSave={setMarkup} />
                        )}
                      </dd>
                    </div>
                    <div className={styles.lrow} data-total={whole?.perUnit ? undefined : ""}>
                      <dt>{unpriced.length ? "The roof, a square, held" : "The roof, a square"}</dt>
                      <dd>{formatMoneyCents(followed(roof.labor_cost, pkg.markup_pct) ?? roof.unit_price)}</dd>
                    </div>
                  </>
                ) : (
                  <div className={styles.lrow} data-total={whole?.perUnit ? undefined : ""}>
                    <dt>
                      {roofing ? "The roof, a square" : `${roof.name}`}
                      <small>
                        {roof.unit_cost !== null ? (
                          <>
                            Your cost today: {formatMoneyCents(roof.unit_cost)} {isSquareUnit(roof.unit) ? "a square" : `a ${roof.unit}`}
                            {marginPct(roof.unit_price, roof.unit_cost) !== null && <> · {marginPct(roof.unit_price, roof.unit_cost)}% margin</>}
                          </>
                        ) : (
                          <>Add your cost in the <Link to="/settings?tab=prices">price list</Link> to see the margin.</>
                        )}
                      </small>
                    </dt>
                    <dd>
                      {editable ? (
                        <MoneyInput width={130} label={roofing ? "Price a square" : "Price"} value={roof.unit_price} onSave={(v) => run(saveService, { id: roof.id, patch: { unit_price: v } })} />
                      ) : (
                        squarePrice(roof, FORMAT)
                      )}
                    </dd>
                  </div>
                )}
                {whole?.perUnit ? (
                  <>
                    <div className={styles.lrow}>
                      <dt>What's always on it, a square</dt>
                      <dd>{formatMoneyCents(round2(whole.perUnit - roofSquare))}</dd>
                    </div>
                    <div className={styles.lrow} data-total="">
                      <dt>The package, a square</dt>
                      <dd>{formatMoneyCents(whole.perUnit)}</dd>
                    </div>
                  </>
                ) : null}
              </dl>
              <div className={styles.notes}>
                {following && canFollow && unpriced.length > 0 && (
                  <div className="callout callout-warning">
                    <Icon name="alert" size={16} />
                    <div className="grow">
                      ABC has no price for {unpriced.map((l) => l.name).join(" or ")} at your branch, so this roof stays at {formatMoneyCents(roof.unit_price)} a square instead of leaving it out.
                      Call the branch for a price, or <Link to={CATALOG_MATERIALS}>replace it in the Catalog</Link>.
                    </div>
                  </div>
                )}
                {following && !canFollow && (
                  <div className="callout callout-warning">
                    <Icon name="alert" size={16} />
                    <div className="grow">This roof has no ABC materials any more, so its price stays where it was. Set it yourself, or pick its materials again.</div>
                  </div>
                )}
                {following && canFollow && !unpriced.length && (
                  <p className={styles.note}>
                    Moves with ABC's prices, and so does everything on this package with ABC materials (marked Follows ABC below), at this markup. That's also true of one added to an estimate later, in the office or on site. Every new estimate is priced at today's materials; estimates already sent and signed keep their price.
                  </p>
                )}
                {following && canFollow && stale.length > 0 && (
                  <p className={styles.note}>
                    ABC didn't price {stale.map((l) => l.name).join(" or ")} last time ({stale[0]!.price_note!.replace(/\.$/, "")}), so {stale.length === 1 ? "it keeps its" : "they keep their"} last price. <Link to={CATALOG_MATERIALS}>Check it in the Catalog</Link>.
                  </p>
                )}
                {!following && canFollow && <p className={styles.note}>Stays put when ABC's prices change. The margin moves instead.</p>}
                {!canFollow && editable && roofing && (
                  <p className={styles.note}>
                    To follow ABC prices, pick what goes into a square from ABC Supply's catalog.{" "}
                    {connected ? (
                      <button type="button" className="link-btn" onClick={() => setPicking(roof)}>Pick its materials</button>
                    ) : (
                      "Connect ABC Supply first (Apps)."
                    )}
                  </p>
                )}
                {whole?.perUnit ? <p className={styles.note}>What's always on this roof, on a typical {squares}-square roof, split across its squares. On an estimate each is still its own line, measured from the roof, and the total comes out the same.</p> : null}
                {shared.length > 0 && <p className={styles.note}>The {shared.map((p) => p.name).join(" and ")} {shared.length === 1 ? "package uses" : "packages use"} this {roofing ? "roof" : "service"} too, so its price changes there as well.</p>}
              </div>
            </>
          )}
        </Section>
      )}

      {/* Always on this roof (always included) */}
      <Section
        title={roofing ? "Always on this roof" : "Always included"}
        count={rows.length || undefined}
        action={
          editable && addable.length > 0 ? (
            <Menu
              items={addItems}
              label="Add from your price list"
              title="Add from your price list"
              triggerClassName="btn"
              trigger={<><Icon name="plus" size={14} />Add from your price list</>}
              search={{ value: addTerm, onChange: setAddTerm, placeholder: "Find a service", label: "Find a service in your price list" }}
            />
          ) : undefined
        }
      >
        <p className={styles.note} style={{ marginBottom: rows.length ? 12 : 0 }}>{roofing ? "Priced from the measurements. Nobody has to type a number." : "On the estimate every time: measured ones fill in from the measurements, the rest start at the count you set."}</p>
        {rows.length === 0 ? (
          <EmptyState inline title={roofing ? "Nothing on this roof yet" : "Nothing included yet"}>
            {roofing ? "Pick the roof above, then add what always goes on it." : "Add what always goes in this package from your price list."}
          </EmptyState>
        ) : (
          <div className={styles.rows}>
            <div className={`${styles.row} ${styles.rowHead}`} aria-hidden="true">
              <span>On the estimate</span><span>How much</span><span className={styles.num}>Price</span><span className={styles.num}>Your cost</span><span className={styles.num}>Margin</span><span />
            </div>
            <ul ref={rowsRef} className={styles.rowList} aria-label={roofing ? "Always on this roof" : "Always included"}>
              {rows.map(({ service, item }) => (
                <AlwaysRow
                  key={service.id}
                  service={service}
                  item={item}
                  links={linksOf(service.id)}
                  followedPrice={follows?.get(service.id)}
                  main={roofing ? "The roof" : "Main service"}
                  editable={editable}
                  canPick={editable && connected}
                  onPick={() => setPicking(service)}
                  onRemove={() => item && run(removeItem, item)}
                  onCount={(quantity) => item && run(setCount, { item, quantity })}
                />
              ))}
            </ul>
          </div>
        )}
        {roofing && (materials.data ?? []).length > 0 && (
          <p className={styles.note} style={{ marginTop: 10 }}><span className={styles.abc}>ABC</span> Materials come from what you picked for each service in ABC's catalog. Change them on any roof estimate's Materials card.</p>
        )}
      </Section>

      {roofing && roof && <TypicalRoofPart pkg={pkg} byId={byId} prices={follows} save={save} />}

      {/* Quick adds: only a roofer's estimate and iPad visit show them */}
      {roofing && (
        <Section title="Quick adds" count={chips.filter((c) => c.on).length || undefined}>
          <p className={styles.note} style={{ marginBottom: 12 }}>One tap to add to an estimate, in the office or on the iPad. Anything else in your price list can still be searched.</p>
          {chips.length === 0 ? (
            <EmptyState inline title="Everything in your price list is already on this roof" />
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
                      if (item) run(removeItem, item);
                      else run(addItem, { serviceId: service.id, kind: "quick" });
                    }}
                  >
                    <Icon name={on ? "check" : "plus"} size={14} bold />
                    {service.name}
                    <small>{unitPrice(service.unit_price, service.unit, FORMAT, true)}</small>
                  </button>
                ))}
              </div>
              <p className={styles.note} style={{ marginTop: 10 }}>Checked ones show as buttons on the estimate. Tap one to turn it off or on.</p>
            </>
          ) : chips.some((c) => c.on) ? (
            <div className={styles.chips}>
              {chips.filter((c) => c.on).map(({ service }) => (
                <span key={service.id} className={styles.quick} data-on="">
                  <Icon name="check" size={14} bold />
                  {service.name}
                  <small>{unitPrice(service.unit_price, service.unit, FORMAT, true)}</small>
                </span>
              ))}
            </div>
          ) : (
            <EmptyState inline title="No quick adds on this package" />
          )}
        </Section>
      )}

      {/* What the customer reads on its card */}
      <Section title="On its card">
        <p className={styles.note} style={{ marginBottom: 12 }}>What the {customer} reads when you offer it as one of two or three options.</p>
        {editable ? (
          <div className={styles.cardPart}>
            <HighlightsField
              value={highlights}
              onChange={(lines) => {
                setHighlights(lines);
                save.edited();
              }}
              onCommit={saveHighlights}
            />
            <Field label="Warranty" optional hint="One line: what it covers, and for how long.">
              <textarea className="textarea" rows={2} style={{ minHeight: 0 }} value={warranty} maxLength={PACKAGE_LIMITS.warranty} onChange={(e) => {
                setWarranty(e.target.value);
                save.edited();
              }} onBlur={saveWarranty} />
            </Field>
            {isExampleWarranty(warranty) && (
              <div className="callout">
                <Icon name="info" size={16} />
                <div className="grow">{STARTER_NOTE}</div>
              </div>
            )}
          </div>
        ) : pkg.highlights.length || pkg.warranty ? (
          <div className={styles.cardPart}>
            {pkg.highlights.length > 0 && (
              <ul className={styles.cardLines}>
                {pkg.highlights.map((line, i) => <li key={i}>{line}</li>)}
              </ul>
            )}
            {pkg.warranty && <p className={styles.sideText}><strong className={styles.ink}>Warranty:</strong> {pkg.warranty}</p>}
            {isExampleWarranty(pkg.warranty) && (
              <div className="callout">
                <Icon name="info" size={16} />
                <div className="grow">{STARTER_NOTE}</div>
              </div>
            )}
          </div>
        ) : (
          <EmptyState inline title="No highlights or warranty yet" />
        )}
      </Section>

      {/* Contract sections */}
      <ContractPart pkg={pkg} editable={editable} onChange={(section_ids) => run(savePackage, { patch: { section_ids } })} />

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

// Whether this person sets a package's markup by the margin it comes to: kept on this device.
const BY_MARGIN_KEY = "crewtavo.packages.by-margin";

function readByMargin(): boolean {
  try {
    return localStorage.getItem(BY_MARGIN_KEY) === "1";
  } catch {
    return false;
  }
}

function storeByMargin(on: boolean) {
  try {
    localStorage.setItem(BY_MARGIN_KEY, on ? "1" : "0");
  } catch {
    // Storage full or blocked: it's back to the markup next time, which is harmless.
  }
}

/**
 * Everything on a roof package, on a typical roof: what the homeowner pays, the cost, the profit and
 * the margin, so the margin isn't only the roof's. The typical roof's size is the business's
 * (companies.settings.roofing.typical_squares), set here by those who set the price ranges.
 */
function TypicalRoofPart({ pkg, byId, prices, save }: { pkg: RoofPackage; byId: ReadonlyMap<string, PriceListService>; prices?: ReadonlyMap<string, number>; save: SaveStatusHandle }) {
  const session = useSession();
  const editable = canEditRanges(session);
  const saveSquares = useSaveRoofingSettings();
  const squares = (saveSquares.isPending && saveSquares.variables?.typical_squares) || typicalSquares(session.company.settings);
  const roof = typicalRoof(squares);
  const figures = typicalFigures(pkg, byId, roof, prices);
  const [draft, setDraft] = useState(String(squares));
  useEffect(() => setDraft(String(squares)), [squares]);
  const saveDraft = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > TYPICAL_SQUARES_MAX) return setDraft(String(squares));
    if (n !== squares) void save.track(saveSquares.mutateAsync({ typical_squares: n }));
  };
  const low = figures?.margin !== null && figures?.margin !== undefined && figures.margin < LOW_MARGIN;
  const noCost = figures?.noCost ?? [];
  return (
    <Section
      className={styles.typicalSection}
      title={`On a typical ${squares}-square roof`}
      action={
        editable ? (
          <label className={styles.squares}>
            Typical roof
            <NumberInput className="input input-sm" inputMode="numeric" min={1} max={TYPICAL_SQUARES_MAX} step={1} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={saveDraft} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            squares
          </label>
        ) : undefined
      }
    >
      {figures ? (
        <StatStrip label={`This package on a ${squares}-square roof`} className={styles.strip}>
          <Stat label="Homeowner pays" value={formatMoney(figures.price)} />
          <Stat label="Your cost" value={formatMoney(figures.cost)} />
          <Stat label="Profit" value={formatMoney(figures.profit)} tone={figures.profit < 0 ? "danger" : undefined} />
          {figures.margin !== null && <Stat label="Margin" value={`${figures.margin}%`} tone={low ? "warning" : undefined} note={low ? `Under ${LOW_MARGIN}%` : undefined} />}
        </StatStrip>
      ) : (
        <p className={styles.note}>Nothing on this package comes to a price on this roof yet.</p>
      )}
      <div className={styles.notes}>
        <p className={styles.note}>
          Every line on this package, on a {squares}-square roof with {roof.eave_ft + roof.rake_ft} ft of eaves and rakes and {roof.ridge_ft + roof.hip_ft} ft of ridges and hips.
        </p>
        {noCost.length > 0 && (
          <p className={styles.note}>
            {noCost.join(", ")} {noCost.length === 1 ? "has" : "have"} no cost in your <Link to="/settings?tab=prices">price list</Link>, so the real margin is lower.
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * A package's picture: added, changed (a new file each time, so options already offered keep the
 * one they showed) and taken off again, back to its drawing (`children`: the drawing's styles).
 */
function PictureControl({ pkg, customer, children }: { pkg: RoofPackage; customer: string; children?: ReactNode }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const saved = (patch: Pick<RoofPackage, "picture" | "picture_width" | "picture_height">) => {
    queryClient.setQueryData<RoofPackage[]>(packagesKey(company.id), (list) => list?.map((p) => (p.id === pkg.id ? { ...p, ...patch } : p)));
    queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
  };
  const set = useMutation({
    meta: { inline: true },
    mutationFn: async (file: File) => {
      const jpeg = await packagePicture(file);
      if (!jpeg) throw new Error("Crewtavo can't open that picture here. Try a JPEG or PNG.");
      return setPackagePicture(pkg.id, jpeg);
    },
    onSuccess: (r) => saved({ picture: r.path, picture_width: r.width, picture_height: r.height }),
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: () => removePackagePicture(pkg.id),
    onSuccess: () => saved({ picture: null, picture_width: null, picture_height: null }),
  });
  const setDone = useJustDone(set);
  return (
    <div className={styles.pictureRow}>
      <PackagePicture path={pkg.picture} style={pkg.style} className={styles.editorPicture} />
      <div className={styles.pictureSide}>
        {children && (
          <>
            <span className={styles.styleLabel}>{pkg.picture ? "Without a picture, its card shows:" : "Until it has a picture, its card shows:"}</span>
            {children}
          </>
        )}
        <div className={styles.pictureButtons}>
          <Button size="sm" variant="ghost" icon="image" loading={set.isPending} done={setDone} slowHint={false} disabled={remove.isPending} onClick={() => input.current?.click()}>
            {pkg.picture ? "Change picture" : "Add a picture"}
          </Button>
          {pkg.picture && <Button size="sm" variant="ghost" icon="x" loading={remove.isPending} disabled={set.isPending} onClick={() => remove.mutate()}>Remove picture</Button>}
        </div>
        <span className={styles.pictureHint}>A photo of the finished work or what goes in, so it's easy to pick. The {customer} sees it when it's one of the options.</span>
        <FormError error={set.error ?? remove.error} />
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) set.mutate(file);
        }}
      />
    </div>
  );
}

/**
 * The contract sections that come with a package (roof_packages.section_ids), switched on from the
 * business's library (Settings → Contract terms). An option offered from the package copies them
 * (quote_options.section_ids), and they print after the template's own when that option is the one
 * shown or chosen. An estimate priced from the package alone takes them as its own (quotes.
 * section_ids, its Contract card in quotes/QuoteSections.tsx), and another package put on it takes
 * them off again for its own; when the estimate starts offering options they move onto the option
 * it becomes, leaving the ones added for the job.
 */
function ContractPart({ pkg, editable, onChange }: { pkg: RoofPackage; editable: boolean; onChange: (sectionIds: string[]) => void }) {
  const session = useSession();
  const library = useContractLibrary();
  const sections = library.data ?? [];
  const full = pkg.section_ids.length >= PACKAGE_LIMITS.sections;
  const writes = canEditContracts(session);
  return (
    <Section title="Contract" count={pkg.section_ids.length || undefined} action={writes && sections.length > 0 ? <Link to="/settings?tab=contracts">Contract terms</Link> : undefined}>
      <p className={styles.note} style={{ marginBottom: sections.length && !library.isPending ? 4 : 0 }}>Sections that print on every estimate this package is on, after the ones every estimate has.</p>
      {library.isPending ? (
        <Skeleton height={40} radius={8} style={{ marginTop: 12 }} />
      ) : library.error ? (
        <ErrorState compact error={library.error} onRetry={() => library.refetch()} />
      ) : !sections.length ? (
        <EmptyState inline title="No contract sections yet">
          {writes ? <>Write them in <Link to="/settings?tab=contracts">Settings → Contract terms</Link>, then pick the ones for this package here.</> : "The office writes them in Settings → Contract terms."}
        </EmptyState>
      ) : (
        <ul className={styles.sections} aria-label="Contract sections">
          {sections.map((s) => {
            const on = pkg.section_ids.includes(s.id);
            return (
              <li key={s.id}>
                <label className="checkbox">
                  <input type="checkbox" checked={on} disabled={!editable || (!on && full)} onChange={(e) => onChange(toggleSection(sections, pkg.section_ids, s.id, e.target.checked))} />
                  <span>
                    {s.title}
                    <span className={styles.sub}>{s.place === "signatures" ? "Above the signatures" : "On the terms pages"}{s.initials ? " · The customer initials it" : ""}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/**
 * One line of "Always on this roof" ("Always included"): what it is, how much goes on, its price,
 * cost and margin. The package's main service (the roof) comes first, labelled `main`.
 */
function AlwaysRow({
  service,
  item,
  links,
  followedPrice,
  main,
  editable,
  canPick,
  onPick,
  onRemove,
  onCount,
}: {
  service: PriceListService;
  item: RoofPackageItem | null;
  links: ServiceMaterial[];
  /** Its price at today's ABC materials, for a package that follows ABC. */
  followedPrice?: number;
  main: string;
  editable: boolean;
  canPick: boolean;
  onPick: () => void;
  onRemove: () => void;
  onCount: (quantity: number) => void;
}) {
  const how = formulaWords(service.formula);
  const price = followedPrice ?? service.unit_price;
  const margin = marginPct(price, service.unit_cost);
  const low = margin !== null && margin < LOW_MARGIN;
  const perUnit = round2(materialsPerUnit(links));
  const [count, setCount] = useState(String(item?.quantity ?? 1));
  useEffect(() => setCount(String(item?.quantity ?? 1)), [item?.quantity]);
  const saveCount = () => {
    const n = Math.round(Number(count) * 1000) / 1000;
    if (!Number.isFinite(n) || n <= 0 || n > 100000) return setCount(String(item?.quantity ?? 1));
    if (n !== (item?.quantity ?? 1)) onCount(n);
  };
  return (
    <li className={styles.row} data-low={low || undefined}>
      <span className={styles.cellName}>
        <strong>{service.name}</strong>
        {!item && <span className={styles.sub}>{main}</span>}
        {item && !service.active && <span className={styles.sub}>Turned off in your price list, so it's left off</span>}
      </span>
      <span className={styles.cellHow}>
        {how ?? (
          item && editable ? (
            <label className={styles.count}>
              Count it, starts at
              <NumberInput className="input input-sm" inputMode="decimal" min={1} step={1} value={count} onChange={(e) => setCount(e.target.value)} onBlur={saveCount} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </label>
          ) : (
            `Count it${item?.quantity ? ` (starts at ${item.quantity})` : ""}`
          )
        )}
      </span>
      <span className={`${styles.cellPrice} ${styles.num}`} data-label="Price">
        {unitPrice(price, service.unit, FORMAT)}
        {followedPrice !== undefined && <span className={`${styles.sub} ${styles.follows}`}>Follows ABC</span>}
      </span>
      <span className={styles.cellCost} data-label={service.unit_cost !== null ? "Your cost" : undefined}>
        {service.unit_cost !== null ? unitPrice(service.unit_cost, service.unit, FORMAT) : <span className="muted">No cost</span>}
        {links.length > 0 ? (
          <span className={styles.sub}>ABC {money(perUnit)} + labor {money(service.labor_cost ?? 0)}</span>
        ) : canPick && !item ? (
          <button type="button" className={`link-btn ${styles.sub}`} onClick={onPick}>Pick ABC materials</button>
        ) : null}
      </span>
      <span className={`${styles.cellMargin} ${styles.num}`} data-label="Margin">
        {low && <Icon name="alert" size={14} label={`Under ${LOW_MARGIN}%, a low margin`} />}
        {margin !== null ? `${margin}%` : null}
      </span>
      <span className={styles.cellRemove}>
        {item && editable && <Button size="sm" variant="ghost" icon="x" aria-label={`Take ${service.name} off this package`} onClick={onRemove} />}
      </span>
    </li>
  );
}
