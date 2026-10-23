/**
 * Material prices from the business's own supplier account (ABC Supply, apps/api/src/routes/materials.ts):
 * where prices come from, the catalog's items, and the materials in a price list's services.
 */
import { useQuery } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";

export interface Supplier {
  id: "abc_supply";
  name: string;
  status: "connected" | "error";
  last_error: string | null;
  environment: "production" | "sandbox";
  ship_to_name: string;
  branch: string;
  branch_name: string;
}

export interface CatalogUom { code: string; name: string; role: string | null }

/** An item from the supplier's catalog at the branch, with the account's price for one. */
export interface CatalogItem {
  item_number: string;
  name: string;
  family: string | null;
  color: string | null;
  dimensional: boolean;
  uoms: CatalogUom[];
  stocking_uom: string;
  uom: string;
  unit_price: number | null;
  note: string | null;
}

/** A material in a service (service_materials). */
export interface ServiceMaterial {
  id: string;
  service_id: string;
  item_number: string;
  name: string;
  uom: string;
  uom_name: string | null;
  length_ft: number | null;
  per_unit: number;
  unit_price: number | null;
  priced_at: string | null;
  price_note: string | null;
  sort: number;
}

export const MATERIAL_FIELDS = "id, service_id, item_number, name, uom, uom_name, length_ft, per_unit, unit_price, priced_at, price_note, sort";

/** Where material prices come from, or null when ABC Supply isn't installed. */
export function useSupplier() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["supplier", company.id],
    queryFn: async () => (await api.get<{ supplier: Supplier | null }>("/materials/supplier")).supplier,
    staleTime: 60_000,
  });
}

/** The materials in these services, in order. */
export function useServiceMaterials(serviceIds: string[]) {
  const { company } = useSession();
  const ids = [...new Set(serviceIds)].sort();
  return useQuery({
    queryKey: ["service-materials", company.id, ids],
    enabled: ids.length > 0,
    queryFn: async () => unwrap(await supabase().from("service_materials").select(MATERIAL_FIELDS).in("service_id", ids).order("sort").order("created_at")) as unknown as ServiceMaterial[],
  });
}

/** A unit's name in the singular, lower case: "bundle". */
export const uomName = (m: { uom: string; uom_name?: string | null }) => (m.uom_name ?? m.uom).toLowerCase();

/**
 * What to search the supplier's catalog for first, from a service's name: the kind of material it
 * is, since a catalog says "Shingles" where a price list says "Architectural shingle roof".
 */
export function searchFor(serviceName: string): string {
  const name = serviceName.toLowerCase();
  const guesses: Array<[RegExp, string]> = [
    [/drip/, "drip edge"],
    [/ridge/, "ridge cap"],
    [/valley/, "valley"],
    [/starter/, "starter"],
    [/underlay|felt/, "underlayment"],
    [/ice|water shield/, "ice & water"],
    [/pipe|boot/, "pipe boot"],
    [/vent/, "vent"],
    [/gutter guard/, "gutter guard"],
    [/gutter/, "gutter"],
    [/siding/, "siding"],
    [/metal|standing/, "standing seam"],
    [/shingle|roof/, "shingles"],
  ];
  return guesses.find(([pattern]) => pattern.test(name))?.[1] ?? serviceName;
}
