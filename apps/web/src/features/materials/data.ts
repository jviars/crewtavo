/**
 * Material prices from the business's own supplier account (ABC Supply, apps/api/src/routes/materials.ts):
 * where prices come from, the catalog's items, and the materials in a price list's services.
 * Roofing → Catalog (features/roofing/catalog) browses the catalog by these.
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
  /** Its product family (every color of one shingle), for "Other colors". */
  family_id?: string | null;
  color: string | null;
  /** Who makes it: GAF, Owens Corning, CertainTeed. */
  brand?: string | null;
  /** What kind of product it is in ABC's categories ("Laminated Shingles"). */
  kind?: string | null;
  /** ABC's picture of it, by asset id (AbcPicture), when it has one. */
  image?: string | null;
  dimensional: boolean;
  uoms: CatalogUom[];
  stocking_uom: string;
  uom: string;
  unit_price: number | null;
  note: string | null;
}

/** One item in full (GET /materials/items/:number). */
export interface CatalogDetail extends CatalogItem {
  lengths: number[];
  about: string | null;
  /** ABC's categories, from the broadest. */
  path: string[];
  specs: Array<{ name: string; value: string }>;
  family_items: Array<{ item_number: string; name: string; color: string | null }>;
}

/** Something the account buys again and again (GET /materials/usual). */
export interface UsualItem {
  item_number: string;
  name: string;
  uom: string;
  /** The unit in words, when ABC gives them. */
  uom_name: string | null;
  count: number;
  at_branch: boolean | null;
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

/** Roofing → Catalog, and its list of the materials in use. */
export const CATALOG = "/roofing/catalog";
export const CATALOG_MATERIALS = `${CATALOG}?view=yours`;

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

/** ABC's unit codes in words, for answers that give only the code (what an account usually buys). */
const UOM_WORDS: Record<string, string> = { BD: "Bundle", RL: "Roll", PC: "Piece", EA: "Each", BX: "Box", SQ: "Square", LF: "Linear foot", FT: "Foot", TB: "Tube", CT: "Carton", CS: "Case", PA: "Pail", PL: "Pail", GL: "Gallon", SH: "Sheet", PR: "Pair" };
export const uomWord = (code: string) => UOM_WORDS[code.trim().toUpperCase()] ?? code;

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

/** Every material in the price list, for the Catalog's "Your materials" (and its "Used in"). */
export function useAllMaterials({ enabled = true }: { enabled?: boolean } = {}) {
  const { company } = useSession();
  return useQuery({
    queryKey: ["service-materials", company.id, "all"],
    enabled,
    queryFn: async () => unwrap(await supabase().from("service_materials").select(MATERIAL_FIELDS).eq("company_id", company.id).order("name").order("sort")) as unknown as ServiceMaterial[],
  });
}

/**
 * The Catalog's roofing categories. ABC's search finds items by the words in their description (it
 * can't filter by category), so each is the words its items are described with; ABC's own product
 * types on what comes back narrow it further.
 */
export interface CatalogCategory {
  key: string;
  name: string;
  search: string;
  icon: "roofing" | "layers" | "line" | "area" | "ruler" | "pin" | "bolt" | "package" | "pen" | "cloud";
}

export const CATALOG_CATEGORIES: CatalogCategory[] = [
  { key: "shingles", name: "Shingles", search: "shingles", icon: "roofing" },
  { key: "ridge", name: "Hip & ridge", search: "ridge cap", icon: "line" },
  { key: "starter", name: "Starter strip", search: "starter", icon: "line" },
  { key: "underlayment", name: "Underlayment", search: "underlayment", icon: "layers" },
  { key: "ice", name: "Ice & water", search: "ice water", icon: "cloud" },
  { key: "drip", name: "Drip edge", search: "drip edge", icon: "ruler" },
  { key: "valley", name: "Valley & flashing", search: "flashing", icon: "area" },
  { key: "vents", name: "Vents", search: "vent", icon: "cloud" },
  { key: "boots", name: "Pipe boots", search: "pipe boot", icon: "pin" },
  { key: "nails", name: "Nails & fasteners", search: "nails", icon: "bolt" },
  { key: "sealant", name: "Sealants", search: "sealant", icon: "pen" },
  { key: "metal", name: "Metal roofing", search: "standing seam", icon: "package" },
];

/** The same supplier item, sold by the same unit. */
export const sameItem = (a: { item_number: string; uom: string }, b: { item_number: string; uom: string }) => a.item_number === b.item_number && a.uom === b.uom;

/**
 * A color swatch for an item ABC has no picture of, from its color's name. Shingle and trim colors
 * mostly come from a short list; anything else gets a neutral gray.
 */
const SWATCHES: Array<[RegExp, string]> = [
  [/charcoal|onyx|black|moire/, "#34363a"],
  [/weathered wood|driftwood|weatherwood/, "#6f675b"],
  [/pewter|slate|granite|estate gray|colonial slate|storm/, "#5f666d"],
  [/barkwood|mission brown|brownwood|hickory|chestnut|teak|walnut|brown/, "#5c4535"],
  [/shakewood|desert|tan|sand|buff|biscayne|birchwood/, "#a48b6a"],
  [/hunter|forest|green/, "#3c5443"],
  [/red|terra|copper|burgundy|patriot/, "#8a3b2c"],
  [/blue|harbor|atlantic/, "#3c5a78"],
  [/oyster|silver|gray|grey|aluminum|galvan|mill|zinc/, "#9a9da1"],
  [/white|bright|ivory|cream|almond|linen/, "#ecebe6"],
  [/bronze|dark bronze/, "#4e4033"],
];

export function swatchOf(color: string | null | undefined, name = ""): string | null {
  const text = `${color ?? ""} ${color ? "" : name}`.toLowerCase();
  return SWATCHES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}
