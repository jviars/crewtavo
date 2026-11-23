/**
 * Settings → Profile → Your signature: a salesperson signs once and it goes on every estimate they
 * sign for the business after (the business's line, beside the homeowner's). They can also save it
 * the first time they sign on site. Kept per business (PUT and DELETE /api/me/signature).
 */
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
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
    <Section level={3} title="Your signature">
      <div className="set-signature">
      <p className="set-note">It goes on the estimates you sign for {company.name}. Sign once here, or the first time you sign on site.</p>
      {mine.isPending ? (
        <Loading label="Loading your signature"><Skeleton height={110} radius={10} style={{ maxWidth: 420 }} /></Loading>
      ) : mine.error ? (
        <ErrorState compact error={mine.error} onRetry={() => mine.refetch()} />
      ) : drawing ? (
        <>
          <SignaturePad value={draft} onChange={setDraft} label="Sign with your finger or mouse" />
          <FormError error={save.error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button
              size="sm"
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
          <img className="set-signature-img" src={saved!} alt="Your saved signature" />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" icon="pen" onClick={() => { setDraft(null); setSigning(true); }}>Sign again</Button>
            <Button size="sm" variant="ghost" icon="trash" loading={remove.isPending} onClick={() => remove.mutate()}>Remove</Button>
          </div>
          <p className="set-note">Estimates you already signed keep the signature they were signed with.</p>
        </>
      )}
      </div>
    </Section>
  );
}
