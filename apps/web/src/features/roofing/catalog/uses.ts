/**
 * Where a material is used, in the Catalog's words: the services in the price list it's in, how
 * many go into each, and the packages those services are part of.
 */
import { describePerUnit } from "@crewtavo/core/materials";
import type { ServiceMaterial } from "../../materials/data";
import type { PriceListService, RoofPackage } from "../packages";

/** The packages a service is part of: as their roof, or always on them. */
export const packagesUsing = (packages: readonly RoofPackage[], serviceId: string) =>
  packages.filter((p) => p.roof_service_id === serviceId || p.items.some((i) => i.kind === "included" && i.service_id === serviceId)).map((p) => p.name);

export interface Use {
  link: ServiceMaterial;
  service: PriceListService | null;
  /** "3 bundles per square" */
  amount: string;
  packages: string[];
}

export function usesOf(links: readonly ServiceMaterial[], services: readonly PriceListService[], packages: readonly RoofPackage[]): Use[] {
  return links.map((link) => {
    const service = services.find((s) => s.id === link.service_id) ?? null;
    return { link, service, amount: describePerUnit(link.per_unit, link.uom_name ?? link.uom, service?.unit ?? "unit"), packages: packagesUsing(packages, link.service_id) };
  });
}

/** "Good, Better and Best" */
export const listed = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
