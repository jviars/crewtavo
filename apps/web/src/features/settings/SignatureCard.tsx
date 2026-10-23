/**
 * Settings → Profile → Your signature: a salesperson signs once and it goes on every estimate they
 * sign for the business after (the business's line, beside the homeowner's). They can also save it
 * the first time they sign on site. Kept per business (PUT and DELETE /api/me/signature).
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { useSession } from "@/lib/session";
import { useMySignature, useRemoveMySignature, useSaveMySignature } from "../documents/data";
import { SignaturePad } from "../field/SignaturePad";

export function SignatureCard() {
  const { company } = useSession();
  const mine = useMySignature();
  const save = useSaveMySignature();
  const remove = useRemoveMySignature();
  const [signing, setSigning] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const saved = mine.data ?? null;
  const drawing = signing || (!mine.isPending && !mine.error && !saved);

  return (
    <div className="card card-pad stack-sm">
      <strong id="my-signature-title">Your signature</strong>
      <span className="muted small">It goes on the estimates you sign for {company.name}. Sign once here, or the first time you sign on site.</span>
      {mine.isPending ? (
        <Loading label="Loading your signature"><Skeleton height={100} radius={10} style={{ maxWidth: 420 }} /></Loading>
      ) : mine.error ? (
        <ErrorState compact error={mine.error} onRetry={() => mine.refetch()} />
      ) : drawing ? (
        <>
          <SignaturePad value={draft} onChange={setDraft} label="Sign with your finger or mouse" />
          <FormError error={save.error} />
          <div className="row wrap">
            <Button
              size="sm"
              variant="primary"
              icon="check"
              disabled={!draft}
              loading={save.isPending}
              onClick={() =>
                draft &&
                save.mutate(draft, {
                  onSuccess: () => {
                    setSigning(false);
                    setDraft(null);
                  },
                })
              }
            >
              Save signature
            </Button>
            {saved && (
              <Button size="sm" variant="ghost" onClick={() => { setSigning(false); setDraft(null); }}>
                Keep the one I have
              </Button>
            )}
          </div>
        </>
      ) : (
        <>
          <img src={saved!} alt="Your saved signature" style={{ width: "100%", maxWidth: 420, height: 110, objectFit: "contain", background: "#fff", border: "1px solid var(--border)", borderRadius: 10 }} />
          <div className="row wrap">
            <Button size="sm" icon="pen" onClick={() => { setDraft(null); setSigning(true); }}>Sign again</Button>
            <Button size="sm" variant="ghost" icon="trash" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
          </div>
          <span className="muted small">Estimates you already signed keep the signature they were signed with.</span>
        </>
      )}
    </div>
  );
}
