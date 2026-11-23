/**
 * The cards of a draft mailed to the company's own address ("Mail one to us first",
 * public.postcard_proofs): when each was made, with which kind of key, when Lob expects it to
 * arrive, and Lob's own picture of it for as long as Lob's link works. Nothing shows until one is made.
 */
import { addressLine } from "@crewtavo/core/postcards";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/ui/Icon";
import { Section } from "@/components/ui/Section";
import { supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import styles from "./Marketing.module.css";
import { proofLink } from "./postcardForm";

type Address = { line1?: string; line2?: string | null; city?: string; region?: string; postal_code?: string } | null;

export function PostcardProofs({ campaignId }: { campaignId: string }) {
  const proofs = useQuery({
    queryKey: ["postcard-proofs", campaignId],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().from("postcard_proofs").select("id, mode, status, error, address, proof_url, expected_delivery, created_at").eq("campaign_id", campaignId).order("created_at", { ascending: false }).limit(10)),
  });
  if (!proofs.data?.length) return null;
  return (
    <Section title="Mailed to us" count={proofs.data.length} flush>
      <ul className="rel" aria-label="Cards mailed to us">
        {proofs.data.map((p) => {
          const to = p.address as Address;
          const link = proofLink({ proof_url: p.proof_url, proof_at: p.created_at });
          return (
            <li key={p.id} className={styles.recipient}>
              <div className={styles.recipientBody}>
                <span className={styles.recipientName}>{formatDate(p.created_at)} · {p.mode === "live" ? "Live key: mailed" : "Test key: not mailed"}</span>
                <div className={styles.recipientMeta}>{to?.line1 ? addressLine({ line1: to.line1, line2: to.line2, city: to.city ?? "", region: to.region ?? "", postal_code: to.postal_code ?? "" }) : ""}</div>
                {link && <a className={styles.recipientMeta} href={link} target="_blank" rel="noreferrer">See the card as Lob drew it <Icon name="external" size={12} /></a>}
              </div>
              <span className={styles.recipientEnd} data-tone={p.status === "failed" ? "danger" : undefined}>
                {p.status === "failed" ? `Failed: ${p.error ?? "Lob couldn't make it"}` : p.status === "sending" ? "Being made" : p.mode === "live" ? `Mailed${p.expected_delivery ? `, expected ${formatDate(p.expected_delivery)}` : ""}` : "Made in test mode"}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
