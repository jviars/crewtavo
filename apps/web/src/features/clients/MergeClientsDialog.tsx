/**
 * Merge two clients who are the same person (public.merge_clients): the office picks the one to
 * keep, sees what moves from the other, and merges. The other is then deleted.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useCustomFields } from "../customFields/CustomFields";
import { ClientPicker, type PickedClient } from "./ClientForm";

type Client = { id: string; display_name: string };
interface Preview {
  moves: Record<string, number>;
  fills: string[];
  fields: string[];
  tags: string[];
  autopay_off: boolean;
}

const MOVES: Array<[key: string, one: string, many: string]> = [
  ["properties", "property", "properties"], ["contacts", "contact", "contacts"], ["requests", "request", "requests"], ["quotes", "quote", "quotes"],
  ["jobs", "job", "jobs"], ["invoices", "invoice", "invoices"], ["payments", "payment", "payments"], ["messages", "note or message", "notes and messages"],
  ["files", "file", "files"], ["cards", "card on file", "cards on file"], ["reviews", "review", "reviews"], ["referrals", "referral", "referrals"],
];
const FILLS: Record<string, string> = {
  email: "email", phone: "phone", company_name: "company name", billing_address: "billing address", lead_source: "lead source", notes: "notes", payment_terms_days: "payment terms",
};

/** `client` merges into one picked here, or the two given are chosen between. */
export function MergeClientsDialog({ client, other, onClose }: { client: Client; other?: Client; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<PickedClient>(other ?? null);
  // From a client's menu, it goes into the one picked; from a pair, the first is kept unless changed.
  const [keepId, setKeepId] = useState<string | null>(other ? client.id : null);
  const pair = picked && picked.id !== client.id ? [client, picked] : null;
  const keep = pair ? (pair.find((c) => c.id === keepId) ?? pair[1]) : null;
  const gone = pair && keep ? pair.find((c) => c.id !== keep.id)! : null;
  const fields = useCustomFields("client");

  const preview = useQuery({
    queryKey: ["client-merge", keep?.id, gone?.id],
    enabled: Boolean(keep && gone),
    queryFn: async () => unwrap(await supabase().rpc("client_merge_preview", { p_company: company.id, p_keep: keep!.id, p_merge: gone!.id })) as unknown as Preview,
  });
  const merge = useMutation({
    meta: { success: () => `Merged ${gone!.display_name} into ${keep!.display_name}` },
    mutationFn: async () => unwrap(await supabase().rpc("merge_clients", { p_company: company.id, p_keep: keep!.id, p_merge: gone!.id })),
    onSuccess: () => {
      onClose();
      // From a client's page, which may be the one deleted; a pair's list stays open for the next one.
      if (!other) navigate(`/clients/${keep!.id}`, { replace: true });
      // The deleted client's own queries go rather than refresh (and fail).
      queryClient.removeQueries({ queryKey: ["client", gone!.id] });
      queryClient.invalidateQueries({ queryKey: ["client", keep!.id] });
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
    },
  });

  const p = preview.data;
  const moves = p ? MOVES.filter(([key]) => p.moves[key]).map(([key, one, many]) => `${p.moves[key]} ${p.moves[key] === 1 ? one : many}`) : [];
  const filled = p ? [...p.fills.map((f) => FILLS[f] ?? f), ...p.fields.flatMap((key) => fields.find((f) => f.key === key)?.label ?? [])] : [];

  return (
    <Dialog open onClose={onClose} title="Merge clients" description="Everything on one client moves to the other, and the empty one is deleted.">
      <div className="form-grid">
        {!other && (
          <Field label={`Merge ${client.display_name} with`}>
            <ClientPicker value={picked} onChange={setPicked} allowCreate={false} />
          </Field>
        )}
        {picked?.id === client.id && <span className="muted small" role="status">Pick a different client.</span>}
        {pair && keep && (
          <Field label="Keep">
            <div className="stack-sm">
              {pair.map((c) => (
                <label key={c.id} className="checkbox">
                  <input type="radio" name="merge-keep" checked={keep.id === c.id} onChange={() => setKeepId(c.id)} />
                  {c.display_name}
                </label>
              ))}
            </div>
          </Field>
        )}
        {gone && keep && (
          <div className="stack-sm" role="status">
            {preview.isPending ? (
              <Skeleton width="80%" height={12} />
            ) : p ? (
              <>
                <span>{moves.length ? `Moves to ${keep.display_name}: ${moves.join(", ")}.` : `${gone.display_name} has nothing else to move.`}</span>
                {!!filled.length && <span>{keep.display_name} gets their {filled.join(", ")}.</span>}
                {!!p.tags.length && <span>Adds the tags {p.tags.join(", ")}.</span>}
                {p.autopay_off && <span>Both are on autopay: {keep.display_name}&rsquo;s stays and {gone.display_name}&rsquo;s ends.</span>}
                <span className="muted small">Invoice totals and payments don&rsquo;t change. {gone.display_name} is then deleted, and this can&rsquo;t be undone.</span>
              </>
            ) : null}
          </div>
        )}
      </div>
      <FormError error={merge.error ?? preview.error} />
      <div className="form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={merge.isPending} disabled={!p || !gone} onClick={() => merge.mutate()}>
          {gone ? `Merge into ${keep!.display_name}` : "Merge"}
        </Button>
      </div>
    </Dialog>
  );
}
