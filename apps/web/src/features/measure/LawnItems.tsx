/**
 * The lawn add-ons that price a lawn's items and slope (trees, obstacles, edging, steep ground, mulch
 * from beds), for a price list started before they were in the lawn starter list, or that has one
 * without its formula: one quiet line in Measure's Lawn section, for whoever can change prices.
 */
import { LAWN_ADD_ONS } from "@crewtavo/core/lawn";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";

export function LawnAddOns() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canAdd = hasRole(session, "admin") && can(session, "settings");
  const services = useQuery({
    queryKey: ["services", session.company.id, "formulas"],
    // The names that price from a formula; one without a formula isn't priced by the drawing yet.
    queryFn: async () => unwrap(await supabase().from("services").select("name, formula").eq("company_id", session.company.id)).flatMap((s) => (s.formula ? [s.name.trim().toLowerCase()] : [])),
    enabled: canAdd,
  });
  const add = useMutation({
    meta: {
      success: (r: { added: string[]; filled: string[] }) => {
        const names = [...r.added, ...r.filled];
        return names.length ? `${names.join(", ")} now ${names.length === 1 ? "prices" : "price"} from the drawing` : "Your price list already has them";
      },
    },
    mutationFn: () => api.post<{ added: string[]; filled: string[] }>("/lawn/services"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["services"] }),
  });
  const missing = LAWN_ADD_ONS.filter((name) => services.data && !services.data.includes(name.toLowerCase()));
  if (!canAdd || !missing.length) return null;
  return (
    <p className="measure-quiet">
      Your price list doesn't price these from the drawing yet: {missing.join(", ")}.{" "}
      <button type="button" className="link-btn" disabled={add.isPending} onClick={() => add.mutate()}>{add.isPending ? "Adding…" : `Add ${missing.length === 1 ? "it" : "them"}`}</button>
      {" · "}
      <Link className="link-btn" to="/settings?tab=prices">Price list</Link>
    </p>
  );
}
