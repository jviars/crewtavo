/**
 * A client's showcases, on the client's own page: a chip saying they have one (a public page shows
 * photos of their property, so whoever is talking to them should know), and under the "Can be
 * posted on social pages" switch what the switch does to it. Only for the office with the
 * marketing area, with Marketing installed: nobody else can read showcases.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Icon } from "@/components/ui/Icon";
import { supabase, unwrap } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import styles from "./Presence.module.css";
import { clientShowcaseWords, photoSwitchNote, type ClientShowcase } from "./showcaseWords";

function useClientShowcases(clientId: string) {
  const session = useSession();
  return useQuery({
    queryKey: ["client-showcases", clientId],
    enabled: hasRole(session, "admin", "office") && can(session, "marketing") && featureOn(session.company.settings, "marketing"),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("showcases").select("id, title, status, unpublished_reason, jobs!inner(client_id)").eq("jobs.client_id", clientId).order("created_at", { ascending: false }).limit(50)) as unknown as ClientShowcase[],
  });
}

/** On the quiet line under the client's name: "1 showcase, published", linking to Marketing → Showcases. */
export function ClientShowcaseChip({ clientId }: { clientId: string }) {
  const showcases = useClientShowcases(clientId).data ?? [];
  if (!showcases.length) return null;
  return (
    <Link className={styles.flag} to="/marketing?tab=showcases" title={showcases.map((s) => s.title).join(", ")}>
      <Icon name="image" size={13} />
      {clientShowcaseWords(showcases)}
    </Link>
  );
}

/** Under the photos switch: what turning it off does to their showcases, or that it has. */
export function ClientShowcaseNote({ clientId, optedOut }: { clientId: string; optedOut: boolean }) {
  const note = photoSwitchNote(useClientShowcases(clientId).data ?? [], optedOut);
  return note ? <span className={styles.switchNote}>{note}</span> : null;
}
