/** A client's referral link (/refer/:token): their friend asks for a quote, credited to the client. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { publicFetch, useTurnstile } from "@/lib/publicApi";

interface ReferralView {
  company: { name: string; phone: string | null; website: string | null };
  referrer: string;
  offer: string | null;
}

export function ReferralPage() {
  const { token = "" } = useParams();
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

  return (
    <div className="public-page">
      <div className="public-wrap" style={{ maxWidth: 620 }}>
        {view.isPending && <div className="card card-pad stack-sm"><Skeleton width="60%" height={26} /><Skeleton width="80%" /><Skeleton height={220} radius={10} /></div>}
        {view.error && (
          <div className="card"><div className="empty-state error-state"><span className="empty-icon"><Icon name="link" size={24} /></span><h3>This link isn't working</h3><p>{(view.error as Error).message}</p></div></div>
        )}
        {view.data && (
          <>
            <header className="public-brand">
              <span className="tile" aria-hidden="true">{view.data.company.name.slice(0, 2).toUpperCase()}</span>
              <div><strong>{view.data.company.name}</strong>{view.data.company.phone && <div className="muted text-sm">{view.data.company.phone}</div>}</div>
            </header>
            {submit.isSuccess ? (
              <div className="card card-pad stack-sm" style={{ textAlign: "center", justifyItems: "center", padding: 32 }}>
                <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
                <h1 style={{ fontSize: 22 }}>Thanks, we'll be in touch</h1>
                <p className="muted" style={{ margin: 0 }}>{view.data.company.name} will contact you soon about your request (reference #{submit.data.reference}).</p>
              </div>
            ) : (
              <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (!missingContact) submit.mutate(); }}>
                <div className="stack-sm">
                  <span className="chip chip-green" style={{ justifySelf: "start" }}><Icon name="gift" size={12} />Referred by {view.data.referrer}</span>
                  <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{view.data.referrer} thinks you'll like working with {view.data.company.name}</h1>
                  {view.data.offer && <p style={{ margin: 0, fontWeight: 700, color: "var(--green-dark)" }}>{view.data.offer}</p>}
                </div>
                <div className="form-grid">
                  <Field label="Your name"><input className="input" value={f.name} onChange={set("name")} required minLength={2} maxLength={120} autoComplete="name" /></Field>
                  <Field label="Email"><input className="input" type="email" value={f.email} onChange={set("email")} maxLength={200} autoComplete="email" /></Field>
                  <Field label="Phone"><input className="input" type="tel" value={f.phone} onChange={set("phone")} maxLength={30} autoComplete="tel" /></Field>
                </div>
                <Field label="Address where you need the work"><input className="input" value={f.line1} onChange={set("line1")} required minLength={3} maxLength={200} autoComplete="address-line1" /></Field>
                <div className="form-grid">
                  <Field label="City"><input className="input" value={f.city} onChange={set("city")} maxLength={100} autoComplete="address-level2" /></Field>
                  <Field label="ZIP"><input className="input" value={f.postal_code} onChange={set("postal_code")} maxLength={12} inputMode="numeric" autoComplete="postal-code" /></Field>
                </div>
                <Field label="What do you need?" optional><textarea className="textarea" value={f.details} onChange={set("details")} maxLength={4000} /></Field>
                {missingContact && (f.name || f.line1) && <p className="muted small" style={{ margin: 0 }}>Add an email or phone number so we can reach you.</p>}
                <div ref={turnstile.ref} />
                <FormError error={submit.error} />
                <Button type="submit" variant="primary" size="lg" icon="send" loading={submit.isPending} disabled={missingContact || (turnstile.required && !turnstile.token)}>Request a quote</Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
