/**
 * Roof packages: what goes on each kind of roof (roof_packages, roof_package_items). The roof
 * itself is a service priced by the square; what's always on it and the one-tap quick adds are
 * services too. Packages are read and changed straight from the browser (RLS: the people who price
 * work read them, the price list's people change them); putting one on an estimate and setting a
 * business up go through the API (apps/api/src/routes/roofing.ts).
 */
import { useQuery } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
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
  style: PackageStyle;
  roof_service_id: string | null;
  price_mode: "manual" | "follow";
  markup_pct: number;
  is_default: boolean;
  sort: number;
  /** The roof's service, for its price a square. */
  roof: { id: string; name: string; unit: string; unit_price: number; unit_cost: number | null } | null;
  items: RoofPackageItem[];
}

export const PACKAGE_FIELDS =
  "id, name, style, roof_service_id, price_mode, markup_pct, is_default, sort, roof:services!roof_packages_company_id_roof_service_id_fkey(id, name, unit, unit_price, unit_cost), items:roof_package_items!roof_package_items_company_id_package_id_fkey(id, service_id, kind, quantity, sort)";

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

/** The business's roof packages, in their order, each with its items in order. */
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
        roof: p.roof ? { ...p.roof, unit_price: Number(p.roof.unit_price), unit_cost: p.roof.unit_cost === null ? null : Number(p.roof.unit_cost) } : null,
        items: [...p.items].map((i) => ({ ...i, quantity: i.quantity === null ? null : Number(i.quantity) })).sort((a, b) => a.sort - b.sort),
      }));
    },
  });
}

/** The whole price list (turned-off services too, so a package's old items still have names). */
export function usePriceList() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["services", company.id, "roof-packages"],
    queryFn: async () =>
      (unwrap(await supabase().from("services").select(PRICE_LIST_FIELDS).eq("company_id", company.id).order("sort").order("name")) as unknown as PriceListService[]).map((s) => ({
        ...s,
        unit_price: Number(s.unit_price),
        unit_cost: s.unit_cost === null ? null : Number(s.unit_cost),
        labor_cost: s.labor_cost === null ? null : Number(s.labor_cost),
      })),
  });
}

/** Who can change packages: the price list's people (Settings), who also price work. */
export const canEditPackages = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office", "estimator") && can(session, "settings");
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

/** What setting up added, in a sentence for a toast. */
export function setupMessage(r: SetupResult): string {
  const parts = [
    r.packages_created ? `${r.packages_created} ${r.packages_created === 1 ? "package" : "packages"}` : null,
    r.services_added.length ? `${r.services_added.length} ${r.services_added.length === 1 ? "service" : "services"}` : null,
  ].filter(Boolean);
  return parts.length ? `Added ${parts.join(" and ")}` : "You already have them";
}

export interface ApplyPackageResult {
  applied: boolean;
  lines?: number;
  skipped?: Array<{ name: string; reason: string }>;
}

/**
 * Put a package on a roof estimate (POST /roofing/:id/package). An estimate with lines keeps them
 * (`applied: false`) unless `replace` starts it over from the package.
 */
export const applyRoofPackage = (quoteId: string, packageId: string, replace = false) => api.post<ApplyPackageResult>(`/roofing/${quoteId}/package`, { package_id: packageId, replace });
