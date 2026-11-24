/** A client's referral link (/refer/:token): their friend asks for a quote, credited to the client. */
import { addressLabels } from "@crewtavo/core/countries";
import { textDisclosure } from "@crewtavo/core/marketing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { Field, FormChecks, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { PrivacyFooter } from "@/components/ui/PrivacyLink";
import { linkToken } from "@/lib/linkToken";
import { publicFetch, useTurnstile } from "@/lib/publicApi";
import { formatPhoneTyping } from "@/lib/validate";
import { Broken, ClientBody, ClientHeader, ClientPage, ClientSkeleton, Done, kit as k } from "./ClientKit";

interface ReferralView {
  company: { name: string; phone: string | null; website: string | null; country?: string | null; logo?: string | null; color?: string | null; texts?: boolean; privacy_url?: string | null };
  referrer: string;
  offer: string | null;
  /** "Ana gets a credit from Acme if you become a client.", when the business gives one. */
  disclosure?: string | null;
}

export function ReferralPage() {
  const { token: raw = "" } = useParams();
  const token = linkToken(raw);
  const view = useQuery({ queryKey: ["referral", token], retry: false, queryFn: () => publicFetch<ReferralView>(`/public/refer/${token}`) });
  const [f, setF] = useState({ name: "", email: "", phone: "", line1: "", city: "", postal_code: "", details: "" });
  const turnstile = useTurnstile(Boolean(view.data));
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  const submit = useMutation({
    mutationFn: () =>
      publicFetch<{ reference: number }>(`/public/refer/${token}`, {
        name: f.name.trim(),
        email: f.email.trim() || undefined,
        phone: f.phone.trim() || undefined,
        address: { line1: f.line1.trim(), city: f.city.trim() || undefined, postal_code: f.postal_code.trim() || undefined },
        details: f.details.trim() || undefined,
        turnstile_token: turnstile.token || undefined,
      }),
  });
  useEffect(() => {
    if (view.data) document.title = `${view.data.referrer} recommends ${view.data.company.name}`;
  }, [view.data]);
  const missingContact = !f.email.trim() && !f.phone.trim();
  // The button stays on; trying it without a way to reach them says so on the email field.
  const [tried, setTried] = useState(false);

  return (
    <ClientPage color={view.data?.company.color}>
      {view.data && <ClientHeader name={view.data.company.name} logo={view.data.company.logo} phone={view.data.company.phone} />}
      <ClientBody>
        {view.isPending && <ClientSkeleton lines={3} />}
        {view.error && <Broken title="This link isn't working">{(view.error as Error).message}</Broken>}
        {view.data && (
          <>
            {submit.isSuccess ? (
              <Done title="Thanks, we'll be in touch">
                <p className={k.doneText}>{view.data.company.name} will contact you soon about your request (reference #{submit.data.reference}).</p>
                {view.data.company.phone && <p className={k.doneText}>Questions? Call <a className={k.link} href={`tel:${view.data.company.phone}`}>{view.data.company.phone}</a></p>}
              </Done>
            ) : (
              <>
                <section className={k.card} aria-labelledby="referral-title">
                  <p className={k.kick}><Icon name="gift" size={14} />Referred by {view.data.referrer}</p>
                  <h1 id="referral-title" className={cx(k.title, k.long)}>{view.data.referrer} thinks you'll like working with {view.data.company.name}</h1>
                  {view.data.offer && <p className={k.offer}>{view.data.offer}</p>}
                  {/* The person recommending gets a credit: the friend is told, where they read the recommendation. */}
                  {view.data.disclosure && <p className={k.msg}>{view.data.disclosure}</p>}
                </section>
                <form className={cx(k.card, k.formCard, k.form)} aria-label="Request a quote" onSubmit={(e: FormEvent) => { e.preventDefault(); setTried(true); if (!missingContact) submit.mutate(); }}>
                  <section className={k.part} aria-labelledby="referral-you">
                    <h2 id="referral-you" className={k.legend}>How to reach you</h2>
                    <div className={k.grid2}>
                      <Field className={k.full} label="Your name" requiredMessage="Enter your name, so we know who to reply to."><input className="input" value={f.name} onChange={set("name")} required minLength={2} maxLength={120} autoComplete="name" /></Field>
                      <Field label="Email" error={tried && missingContact ? "Add an email or a phone number, so we can reach you." : null}><input className="input" type="email" value={f.email} onChange={set("email")} maxLength={200} autoComplete="email" /></Field>
                      <Field label="Phone" hint={view.data.company.texts ? textDisclosure(view.data.company.name) : undefined}><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: formatPhoneTyping(e.target.value) })} maxLength={30} autoComplete="tel" /></Field>
                    </div>
                    {missingContact && !tried && (f.name || f.line1) && <p className={k.note}>Add an email or phone number so we can reach you.</p>}
                  </section>
                  <section className={k.part} aria-labelledby="referral-where">
                    <h2 id="referral-where" className={k.legend}>Where the work is</h2>
                    <Field label="Address where you need the work" requiredMessage="Enter the address where the work is."><input className="input" value={f.line1} onChange={set("line1")} required minLength={3} maxLength={200} autoComplete="address-line1" /></Field>
                    <div className={cx(k.grid2, k.pair)}>
                      <Field label="City"><input className="input" value={f.city} onChange={set("city")} maxLength={100} autoComplete="address-level2" /></Field>
                      <Field label={addressLabels(view.data.company.country).postalCode}><input className="input" value={f.postal_code} onChange={set("postal_code")} maxLength={12} autoComplete="postal-code" /></Field>
                    </div>
                  </section>
                  <section className={k.part} aria-labelledby="referral-job">
                    <h2 id="referral-job" className={k.legend}>About the job</h2>
                    <Field label="What do you need?" optional><textarea className="textarea" value={f.details} onChange={set("details")} maxLength={4000} /></Field>
                  </section>
                  <div ref={turnstile.ref} className={k.check} />
                  <div className={k.bar}>
                    <FormError error={submit.error} />
                    <FormChecks />
                    <Button type="submit" variant="primary" size="lg" className={k.cta} icon="send" loading={submit.isPending} disabled={turnstile.required && !turnstile.token}>Request a quote</Button>
                  </div>
                </form>
              </>
            )}
            <div className={k.foot}><PrivacyFooter url={view.data.company.privacy_url} /></div>
          </>
        )}
      </ClientBody>
    </ClientPage>
  );
}
