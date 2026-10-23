/**
 * Keeping an estimate's ABC Supply materials priced while it can change: a line whose quantity,
 * materials or labor changed since it was priced gets priced again at the business's branch
 * (POST /quotes/:id/material-prices). The office's materials card (RoofMaterials) shows the result;
 * the iPad uses this on its own, so its margin is at today's prices without showing the card.
 */
import { lineUnitCost, type LineMaterials } from "@crewtavo/core/materials";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useServiceMaterials, useSupplier, type ServiceMaterial } from "../../materials/data";
import { editKey, refreshEstimateAfterEdits } from "./data";

/** The parts of a quote line pricing reads (both the project page's lines and the estimate kit's fit). */
export interface PricedLine {
  id: string;
  name: string;
  service_id: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost: number | null;
  optional: boolean;
  selected: boolean;
  option_group: string | null;
  materials: LineMaterials | null;
  material_cost: number | null;
}

export interface PricedQuote {
  id: string;
  lines: PricedLine[];
}

export interface ServiceCost {
  id: string;
  name: string;
  unit: string;
  labor_cost: number | null;
}

/** Whether a line's priced materials are still the ones its service has. */
function sameItems(line: PricedLine, links: ServiceMaterial[]) {
  const items = line.materials?.items ?? [];
  return items.length === links.length && items.every((item, i) => item.item_number === links[i]!.item_number && item.uom === links[i]!.uom && Number(item.per_unit) === Number(links[i]!.per_unit) && Number(item.length_ft ?? 0) === Number(links[i]!.length_ft ?? 0));
}

/**
 * What was last asked for each quote, so the card and the iPad don't both ask, and a failure (ABC
 * down) isn't asked again and again. The same change is tried again after a couple of minutes.
 */
const tried = new Map<string, { signature: string; at: number }>();
const RETRY_MS = 2 * 60_000;
/** Wait for taps to settle before pricing: + three times quickly prices once. */
const SETTLE_MS = 800;

export function useMaterialReprice(quote: PricedQuote, editable: boolean, onPriced?: () => void) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const supplier = useSupplier();
  const lines = quote.lines.filter((l) => l.service_id);
  const serviceIds = lines.map((l) => l.service_id!);
  const links = useServiceMaterials(serviceIds);
  const ids = [...new Set(serviceIds)].sort();
  const services = useQuery({
    queryKey: ["service-costs", company.id, ids],
    enabled: ids.length > 0,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, unit, labor_cost").in("id", ids)) as ServiceCost[],
  });
  const linksOf = useMemo(() => {
    const map = new Map<string, ServiceMaterial[]>();
    for (const link of links.data ?? []) map.set(link.service_id, [...(map.get(link.service_id) ?? []), link]);
    return (serviceId: string | null) => (serviceId ? (map.get(serviceId) ?? []) : []);
  }, [links.data]);
  const serviceOf = (id: string | null) => services.data?.find((s) => s.id === id);

  const refreshMaterials = () => {
    queryClient.invalidateQueries({ queryKey: ["service-materials", company.id] });
    queryClient.invalidateQueries({ queryKey: ["service-costs", company.id] });
    queryClient.invalidateQueries({ queryKey: ["services", company.id] });
  };
  const price = useMutation({
    mutationKey: ["material-prices", quote.id],
    meta: { inline: true },
    mutationFn: () => api.post<{ priced_at: string | null }>(`/quotes/${quote.id}/material-prices`),
    onSuccess: () => {
      refreshMaterials();
      // Pricing takes a few seconds: − and + tapped meanwhile are still saving, and the editor loads
      // the estimate (with these prices) once they have. Loading it now would undo the taps.
      if (refreshEstimateAfterEdits(queryClient, quote.id, company.id)) onPriced?.();
    },
  });

  // Lines whose materials, quantity or labor changed since they were priced.
  const connected = supplier.data?.status === "connected";
  const ready = connected && editable && links.isSuccess && services.isSuccess;
  const stale = ready
    ? lines.filter((l) => {
        const own = linksOf(l.service_id);
        if (!own.length) return Boolean(l.materials);
        if (!l.materials || l.materials.line_quantity !== Number(l.quantity) || !sameItems(l, own)) return true;
        return l.unit_cost === null || Number(l.unit_cost) !== lineUnitCost(Number(l.material_cost ?? 0), serviceOf(l.service_id)?.labor_cost ?? null, l.quantity);
      })
    : [];
  const signature = stale.map((l) => `${l.id}:${l.quantity}:${linksOf(l.service_id).map((m) => `${m.id}/${m.per_unit}`).join(",")}:${serviceOf(l.service_id)?.labor_cost}`).join("|");
  const { mutate, isPending } = price;
  // While − and + are still saving (useEstimateEditor), the lines aren't final: price them after.
  const editing = useIsMutating({ mutationKey: editKey(quote.id) }) > 0;
  useEffect(() => {
    const last = tried.get(quote.id);
    if (!signature || isPending || editing || (last?.signature === signature && Date.now() - last.at < RETRY_MS)) return;
    const timer = window.setTimeout(() => {
      const again = tried.get(quote.id);
      if (again?.signature === signature && Date.now() - again.at < RETRY_MS) return;
      tried.set(quote.id, { signature, at: Date.now() });
      mutate();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [signature, isPending, editing, mutate, quote.id]);

  return {
    supplier,
    /** Materials are priced at a connected ABC Supply branch. */
    connected,
    links,
    services,
    linksOf,
    serviceOf,
    refreshMaterials,
    /** Price the estimate's materials now ("Update prices"). */
    price,
    /** Some lines are waiting to be priced again. */
    stale: stale.length > 0,
  };
}
