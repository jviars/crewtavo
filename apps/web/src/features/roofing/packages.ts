/**
 * Packages (roof_packages, roof_package_items): every trade's services sold together, kept in the
 * tables roofing started with. A package has a main service (for a roof, the roof itself, priced by
 * the square), what's always on it, a roof's one-tap quick adds, and what the customer reads when
 * it's offered as an option: its tier, picture, highlights, warranty and contract sections.
 * Packages are read and changed straight from the browser (RLS: the people who price work read
 * them, the price list's people change them); a picture and setting a roofer up go through the API
 * (apps/api/src/routes/packages.ts and roofing.ts), and putting one or more on an estimate goes
 * through its options (quotes/options.ts, POST /quotes/:id/options).
 */
import { followPrice, packageFigures } from "@crewtavo/core/estimates";
import { materialsPerUnit, unpricedLinks, type MaterialLink } from "@crewtavo/core/materials";
import { useQuery } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { base64Of } from "@/lib/files";
import { can, hasRole, useSession, type Session } from "@/lib/session";
import type { PackageStyle } from "./data";

export interface RoofPackageItem {
  id: string;
  service_id: string;
  kind: "included" | "quick";
  /** How many to start with for a counted service (3 pipe boots). Null: the measurement, or 1. */
  quantity: number | null;
  sort: number;
}

export interface RoofPackage {
  id: string;
  name: string;
  /** The drawing on its card when it has no picture. */
  style: PackageStyle;
  /** Its main service (for a roof, the roof itself); optional outside roofing. */
  roof_service_id: string | null;
  price_mode: "manual" | "follow";
  markup_pct: number;
  is_default: boolean;
  sort: number;
  /** "Good", "Better", "Best" or the business's own word. */
  tier: string | null;
  /** <company>/packages/<uuid>.jpg (core packagePictureSrc), with its size; null for the drawing. */
  picture: string | null;
  picture_width: number | null;
  picture_height: number | null;
  highlights: string[];
  warranty: string;
  /** Contract sections that come with it (contract_sections ids, in the library's order). */
  section_ids: string[];
  /** The main service, for its price (a square, for a roof). */
  roof: { id: string; name: string; unit: string; unit_price: number; unit_cost: number | null } | null;
  items: RoofPackageItem[];
}

export const PACKAGE_FIELDS =
  "id, name, style, roof_service_id, price_mode, markup_pct, is_default, sort, tier, picture, picture_width, picture_height, highlights, warranty, section_ids, roof:services!roof_packages_company_id_roof_service_id_fkey(id, name, unit, unit_price, unit_cost), items:roof_package_items!roof_package_items_company_id_package_id_fkey(id, service_id, kind, quantity, sort)";

/** A service in the price list, as packages use it. */
export interface PriceListService {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  labor_cost: number | null;
  taxable: boolean;
  formula: string | null;
  formula_target: string;
  active: boolean;
  sort: number;
}

export const PRICE_LIST_FIELDS = "id, name, category, unit, unit_price, unit_cost, labor_cost, taxable, formula, formula_target, active, sort";

export const packagesKey = (companyId: string) => ["roof-packages", companyId];

/** The business's packages, in their order, each with its items in order. */
export function useRoofPackages({ enabled = true }: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: packagesKey(company.id),
    enabled,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("roof_packages").select(PACKAGE_FIELDS).eq("company_id", company.id).order("sort").order("name")) as unknown as RoofPackage[];
      return rows.map((p) => ({
        ...p,
        markup_pct: Number(p.markup_pct),
        highlights: p.highlights ?? [],
        section_ids: p.section_ids ?? [],
        roof: p.roof ? { ...p.roof, unit_price: Number(p.roof.unit_price), unit_cost: p.roof.unit_cost === null ? null : Number(p.roof.unit_cost) } : null,
        items: [...p.items].map((i) => ({ ...i, quantity: i.quantity === null ? null : Number(i.quantity) })).sort((a, b) => a.sort - b.sort),
      }));
    },
  });
}

/** The whole price list (turned-off services too, so a package's old items still have names). */
export function usePriceList({ enabled = true }: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["services", company.id, "roof-packages"],
    enabled,
    queryFn: async () =>
      (unwrap(await supabase().from("services").select(PRICE_LIST_FIELDS).eq("company_id", company.id).order("sort").order("name")) as unknown as PriceListService[]).map((s) => ({
        ...s,
        unit_price: Number(s.unit_price),
        unit_cost: s.unit_cost === null ? null : Number(s.unit_cost),
        labor_cost: s.labor_cost === null ? null : Number(s.labor_cost),
      })),
  });
}

/** A contract section as a package lists it (contract_sections, Settings → Contract terms). */
export interface LibrarySection {
  id: string;
  title: string;
  place: "signatures" | "terms";
  initials: boolean;
}

/** The business's contract sections in their order, for switching them on for a package. */
export function useContractLibrary({ enabled = true }: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["contract-sections", company.id, "titles"],
    enabled,
    queryFn: async () =>
      unwrap(await supabase().from("contract_sections").select("id, title, place, initials").eq("company_id", company.id).order("sort").order("created_at").order("id")) as LibrarySection[],
  });
}

/** Who sees the packages page: the people who sell, who read packages with the price list. */
export const canSeePackages = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office", "estimator") && can(session, "sales");
/** Who can change packages: the price list's people (Settings), who also price work. */
export const canEditPackages = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office", "estimator") && can(session, "settings");
/** Who can write the contract sections a package picks from (Settings → Contract terms). */
export const canEditContracts = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "settings");
/** Who can set a business up with the standard packages (POST /roofing/setup). */
export const canSetUpRoofing = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "settings");
/** Who can change the price range settings (companies.settings is for owners and admins). */
export const canEditRanges = (session: Pick<Session, "role">) => hasRole(session, "admin");

export interface SetupResult {
  services_added: string[];
  packages_created: number;
}

/** The standard roofing services and packages, for a business that doesn't have them yet. */
export const setUpRoofing = () => api.post<SetupResult>("/roofing/setup");

/**
 * What setting up added, in a sentence for a toast. New packages come with the preset's warranties,
 * which are example wording (core isExampleWarranty), so the toast says so; the packages page keeps
 * saying it until each has the business's own.
 */
export function setupMessage(r: SetupResult): string {
  const parts = [
    r.packages_created ? `${r.packages_created} ${r.packages_created === 1 ? "package" : "packages"}` : null,
    r.services_added.length ? `${r.services_added.length} ${r.services_added.length === 1 ? "service" : "services"}` : null,
  ].filter(Boolean);
  if (!parts.length) return "You already have them";
  const added = `Added ${parts.join(" and ")}`;
  return r.packages_created ? `${added}. ${r.packages_created === 1 ? "Its warranty is" : "Their warranties are"} example wording, so have your attorney review ${r.packages_created === 1 ? "it" : "them"}.` : added;
}

export interface PackagePictureResult {
  path: string;
  width: number;
  height: number;
}

/** A package's new picture (a JPEG from lib/files.ts packagePicture), as a new file: options offered before keep theirs. */
export const setPackagePicture = async (packageId: string, jpeg: Blob) => api.put<PackagePictureResult>(`/packages/${packageId}/picture`, { picture: await base64Of(jpeg) });

/** Back to the package's drawing. The file stays, for the options and signed estimates that show it. */
export const removePackagePicture = (packageId: string) => api.delete<{ ok: true }>(`/packages/${packageId}/picture`);

/**
 * A roof package's whole price, cost and margin on a roof (`roof`, a typical one), and what that comes
 * to a square: the price list's prices, or `prices` instead (a package that follows ABC, from
 * followedPrices).
 */
// shortcut: without `prices` it reads the price list, where a service on two following packages with different markups has the last one saved; pass followedPrices if the package cards ever need it exact.
export function typicalFigures(pkg: RoofPackage, byId: ReadonlyMap<string, PriceListService>, roof: Record<string, number | null>, prices?: ReadonlyMap<string, number>) {
  const at = (s: PriceListService) => ({ ...s, unit_price: prices?.get(s.id) ?? s.unit_price });
  const main = pkg.roof_service_id ? byId.get(pkg.roof_service_id) : undefined;
  const included = pkg.items.filter((i) => i.kind === "included").flatMap((i) => {
    const service = byId.get(i.service_id);
    return service ? [{ ...at(service), quantity: i.quantity }] : [];
  });
  return packageFigures(main ? at(main) : null, included, roof);
}

/**
 * A service's price at today's ABC materials plus its labor and `markup`, read fresh, for a package
 * that follows ABC (a line added to its estimate, in the office or on site, or to the package); null
 * when it has no ABC materials, or one ABC never priced (it keeps its price).
 */
export async function followedPriceOf(serviceId: string, markup: number): Promise<number | null> {
  const db = supabase();
  const [links, service] = await Promise.all([
    db.from("service_materials").select("item_number, name, uom, per_unit, unit_price").eq("service_id", serviceId),
    db.from("services").select("labor_cost").eq("id", serviceId).single(),
  ]);
  const own = unwrap(links) as unknown as MaterialLink[];
  const price = own.length && !unpricedLinks(own).length ? followPrice(materialsPerUnit(own), unwrap(service).labor_cost, markup) : 0;
  return price > 0 ? price : null;
}

/**
 * For a package that follows ABC Supply: each of its services with ABC materials (the roof, what's
 * always on it and its quick adds) at today's materials plus its labor, plus `markup`, as the API
 * prices them (loadPackages, recostServices). One with a material ABC never priced keeps its price.
 */
export function followedPrices(pkg: RoofPackage, byId: ReadonlyMap<string, PriceListService>, links: ReadonlyArray<MaterialLink & { service_id: string }>, markup: number): Map<string, number> {
  const prices = new Map<string, number>();
  for (const id of [pkg.roof_service_id, ...pkg.items.map((i) => i.service_id)]) {
    const service = id ? byId.get(id) : undefined;
    const own = links.filter((l) => l.service_id === id);
    if (!service || !own.length || unpricedLinks(own).length) continue;
    const price = followPrice(materialsPerUnit(own), service.labor_cost, markup);
    if (price > 0) prices.set(service.id, price);
  }
  return prices;
}
