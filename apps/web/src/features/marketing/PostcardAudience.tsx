/**
 * Who a postcard draft goes to, in full, before anything is spent: every client who gets a card
 * with the address it's mailed to, and everyone left out with why (public.postcard_audience, read a
 * page at a time). It scrolls, and downloads as a spreadsheet. One card goes to each address, and
 * the list says how the client is chosen when two share one.
 */
import { audienceKeys, type CampaignAudience } from "@crewtavo/core/campaigns";
import { ONE_PER_ADDRESS } from "@crewtavo/core/postcards";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { FilterTabs } from "@/components/ui/Toolbar";
import { supabase } from "@/lib/api";
import { downloadCsv, toCsv } from "@/lib/csv";
import { everyRow, type PagedQuery } from "@/lib/paging";
import { useSession } from "@/lib/session";
import styles from "./Marketing.module.css";
import { audienceAddress, audienceCsvRows, leftOutWords, type AudienceRow } from "./postcardForm";

export function PostcardAudienceDialog({ name, audience, onClose }: { name: string; audience: CampaignAudience; onClose: () => void }) {
  const session = useSession();
  const [show, setShow] = useState<"in" | "out">("in");
  const list = useQuery({
    queryKey: ["postcard-audience-list", session.company.id, JSON.stringify(audienceKeys(audience))],
    queryFn: () =>
      everyRow<AudienceRow>(() => supabase().rpc("postcard_audience", { p_company: session.company.id, p_audience: audienceKeys(audience) as never }) as unknown as PagedQuery<AudienceRow>, { order: "display_name", key: "client_id" }),
  });
  const rows = list.data ?? [];
  const getting = rows.filter((r) => !r.left_out);
  const left = rows.filter((r) => r.left_out);
  const shown = show === "in" ? getting : left;
  const download = () => {
    const sheet = audienceCsvRows(rows);
    downloadCsv(`${name.replace(/[^\w -]+/g, "").trim() || "postcards"} - who gets a card.csv`, toCsv(sheet.rows, sheet.columns));
  };
  return (
    <Dialog open onClose={onClose} title="Who gets a card" size="lg">
      {list.isPending ? (
        <SectionSkeleton rows={5} />
      ) : list.error ? (
        <ErrorState compact error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="stack">
          <div className={styles.filters}>
            <FilterTabs
              label="Show"
              value={show}
              onChange={setShow}
              options={[
                { value: "in", label: "Getting a card", count: getting.length },
                { value: "out", label: "Left out", count: left.length },
              ]}
            />
            <Button size="sm" icon="download" onClick={download} disabled={!rows.length}>Download the list</Button>
          </div>
          {!shown.length ? (
            <EmptyState inline title={show === "in" ? "No one gets a card yet" : "No one is left out"} />
          ) : (
            <ul className={`rel ${styles.scroll}`} aria-label={show === "in" ? "Clients getting a card" : "Clients left out"}>
              {shown.map((r) => (
                <li key={r.client_id} className={styles.recipient}>
                  <div className={styles.recipientBody}>
                    <Link to={`/clients/${r.client_id}`} target="_blank" rel="noreferrer" className={styles.recipientName}>{r.display_name}</Link>
                    <div className={styles.recipientMeta}>{audienceAddress(r) || "No address"}</div>
                  </div>
                  {r.left_out && <span className={styles.recipientEnd}>{leftOutWords(r.left_out)}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className={styles.fine}>Each card goes to the client's billing address, or their first property's when that one can't be mailed to. {ONE_PER_ADDRESS} A wrong address is fixed on the client's page.</p>
        </div>
      )}
    </Dialog>
  );
}
