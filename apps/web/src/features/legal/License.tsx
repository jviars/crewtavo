/**
 * The Crewtavo License (LICENSE at the repository root, bundled as text so every deployment shows
 * the version it runs). Whoever sets up a business agrees to it in OnboardingPage; an owner or admin
 * of a business that hasn't agreed to this version sees TermsPage once (lib/session.tsx).
 */
import { TERMS_VERSION } from "@crewtavo/core/terms";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { api, supabase } from "@/lib/api";
import LICENSE_TEXT from "../../../../../LICENSE?raw";
import styles from "./legal.module.css";

export { LICENSE_TEXT, TERMS_VERSION };

const POINTS: Array<{ icon: IconName; text: string }> = [
  { icon: "info", text: "Crewtavo is provided as is, with no warranty of any kind." },
  { icon: "lock", text: "You run it on accounts you own, so you're responsible for your data, your backups and keeping it secure." },
  { icon: "alert", text: "The people who make Crewtavo aren't liable for lost or exposed data, for mistakes, or for anything done with it." },
  { icon: "check", text: "Check quotes, invoices, payments, pay and taxes before you rely on them. AI answers and map measurements can be wrong." },
  { icon: "book", text: "You follow the laws that apply to your business, such as privacy, texting, tax and labor laws." },
  { icon: "star", text: "Keep the Crewtavo name and logo, including \"Powered by Crewtavo\". Your own logo and colors are always fine." },
];

/** The license in plain language: what someone is agreeing to, before the full text. */
export function LicenseSummary() {
  return (
    <ul className={styles.points}>
      {POINTS.map((p) => <li key={p.text}><Icon name={p.icon} size={15} />{p.text}</li>)}
    </ul>
  );
}

/** The full license, folded away until someone opens it. */
export function LicenseText({ open = false }: { open?: boolean }) {
  return (
    <details className="more-options" open={open || undefined}>
      <summary>Read the full license</summary>
      <pre className={styles.text} tabIndex={0} aria-label="Crewtavo License">{LICENSE_TEXT}</pre>
    </details>
  );
}

/** Summary, full text and the "I agree" box, for setting up a business and for TermsPage. */
export function TermsAgreement({ agreed, onChange, error }: { agreed: boolean; onChange: (agreed: boolean) => void; error?: string | null }) {
  return (
    <section className={styles.terms} aria-labelledby="terms-title">
      <h2 id="terms-title">The Crewtavo License</h2>
      <LicenseSummary />
      <LicenseText />
      <label className={`checkbox ${styles.agree}`}>
        <input type="checkbox" checked={agreed} onChange={(e) => onChange(e.target.checked)} aria-invalid={error ? true : undefined} aria-describedby={error ? "terms-error" : undefined} />
        <span>I have read and agree to the Crewtavo License, for myself and on behalf of my business.</span>
      </label>
      {error && <span id="terms-error" className={styles.error} role="alert">{error}</span>}
    </section>
  );
}

export const TERMS_REQUIRED = "Agree to the Crewtavo License to continue.";

/** An owner or admin of a business that hasn't agreed to this version of the license: agree once to go on. */
export function TermsPage({ companyName, onAccepted }: { companyName: string; onAccepted: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  const accept = useMutation({
    meta: { inline: true, success: "Thanks for agreeing" },
    mutationFn: () => api.post("/terms", { version: TERMS_VERSION }),
    onSuccess: onAccepted,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (agreed) accept.mutate();
  };

  return (
    <AuthLayout>
      <form className={`card card-pad ${authStyles.card} ${authStyles.wide}`} style={{ padding: 28, gap: 18 }} onSubmit={submit}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={authStyles.title}>Before you continue</h1>
          <p className="muted" style={{ margin: 0 }}>
            An owner or admin needs to agree to the current Crewtavo License for <strong style={{ color: "var(--ink)" }}>{companyName}</strong>. You only do this once.
          </p>
        </div>
        <TermsAgreement agreed={agreed} onChange={setAgreed} error={touched && !agreed ? TERMS_REQUIRED : null} />
        <FormError error={accept.error} />
        <div className="row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" icon="logout" onClick={() => supabase().auth.signOut()}>Sign out</Button>
          <Button type="submit" variant="primary" size="lg" loading={accept.isPending}>Agree and continue</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
