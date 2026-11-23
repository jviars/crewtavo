/**
 * The Crewtavo Terms (TERMS at the repository root) and the license (LICENSE, the GNU AGPL-3.0, with
 * the additional terms in NOTICE), bundled as text so every deployment shows the versions it runs.
 * Whoever sets up a business agrees to the terms in OnboardingPage; an owner or admin of a business
 * that hasn't agreed to this version sees TermsPage once (lib/session.tsx).
 */
import { TERMS_VERSION } from "@crewtavo/core/terms";
import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { api } from "@/lib/api";
import LICENSE_TEXT from "../../../../../LICENSE?raw";
import NOTICE_TEXT from "../../../../../NOTICE?raw";
import TERMS_TEXT from "../../../../../TERMS?raw";
import styles from "./legal.module.css";

export { LICENSE_TEXT, NOTICE_TEXT, TERMS_TEXT, TERMS_VERSION };

/**
 * Where this version's source code is. The AGPL asks anyone running a modified Crewtavo for others to
 * offer them its source (section 13): a modified version points this at its own.
 */
export const SOURCE_URL = "https://github.com/jviars/crewtavo";

/**
 * TERMS and NOTICE are wrapped at 100 characters for reading as files. Joins each paragraph's
 * lines (a long line followed by more text) so it flows to the width of the box instead.
 */
function flow(text: string) {
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const previous = lines[lines.length - 1];
    if (previous !== undefined && previous.length >= 70 && line.trim()) lines[lines.length - 1] = `${previous} ${line.trim()}`;
    else lines.push(line);
  }
  return lines.join("\n");
}

const POINTS = [
  "Crewtavo is free and open source, provided as is, with no warranty of any kind.",
  "You run it on accounts you own, so you're responsible for your data, your backups and keeping it secure.",
  "Your customers deal with your business. You handle their questions, complaints, refunds and claims.",
  "The people who make Crewtavo aren't liable for lost or exposed data, for mistakes, or for anything done with it, and you cover them if a claim about your Crewtavo is made against them.",
  "Check quotes, invoices, payments, pay and taxes before you rely on them. AI answers and map measurements can be wrong.",
  "You follow the laws that apply to your business, such as privacy, texting, tax and labor laws.",
];

/** The terms in plain language, each with a check: what someone is agreeing to, before the full text. */
export function TermsSummary() {
  return (
    <ul className={styles.points}>
      {POINTS.map((text) => <li key={text}><Icon name="check" size={16} />{text}</li>)}
    </ul>
  );
}

/** The full terms, folded away under a link until someone opens them. */
export function TermsText({ open = false }: { open?: boolean }) {
  return (
    <details className={styles.full} open={open || undefined}>
      <summary>Read the full terms</summary>
      <pre className={styles.text} tabIndex={0} aria-label="Crewtavo Terms">{flow(TERMS_TEXT)}</pre>
    </details>
  );
}

/**
 * The license's notices (copyright, AGPL, no warranty, where the source is) and its full text: the
 * "Appropriate Legal Notices" the AGPL asks the app to show. Beside them, the licenses of the
 * open-source packages built into the app, which ask to go with every copy (apps/web/licenses.ts
 * writes the file at each build).
 */
export function LicenseNotice() {
  return (
    <div className={styles.notice}>
      <span className={styles.noticeText}>
        Copyright (C) 2026 Joshua Viars. Crewtavo is free software under the GNU Affero General Public License, version 3, with the additional terms in its notice, and comes with no warranty. <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source code</a>
        {" · "}<a href="/licenses.txt" target="_blank" rel="noopener noreferrer">Open-source licenses</a>
      </span>
      <details className={styles.full}>
        <summary>Read the notice and additional terms</summary>
        <pre className={styles.text} tabIndex={0} aria-label="Crewtavo notice">{flow(NOTICE_TEXT)}</pre>
      </details>
      <details className={styles.full}>
        <summary>Read the full license</summary>
        <pre className={styles.text} tabIndex={0} aria-label="GNU Affero General Public License">{LICENSE_TEXT}</pre>
      </details>
    </div>
  );
}

/**
 * Summary, full text and the "I agree" box, for setting up a business and for TermsPage. `title`
 * heads it; null when the page's own title already says it's the terms.
 */
export function TermsAgreement({ agreed, onChange, error, title = "The Crewtavo Terms" }: { agreed: boolean; onChange: (agreed: boolean) => void; error?: string | null; title?: string | null }) {
  return (
    <section className={styles.terms} aria-labelledby={title ? "terms-title" : undefined} aria-label={title ? undefined : "The Crewtavo Terms"}>
      {title && <h2 id="terms-title">{title}</h2>}
      <TermsSummary />
      <TermsText />
      <label className={styles.agree}>
        <input type="checkbox" checked={agreed} onChange={(e) => onChange(e.target.checked)} aria-invalid={error ? true : undefined} aria-describedby={error ? "terms-error" : undefined} />
        <span>I have read and agree to the Crewtavo Terms, for myself and on behalf of my business.</span>
      </label>
      {error && <span id="terms-error" className={styles.error} role="alert">{error}</span>}
    </section>
  );
}

export const TERMS_REQUIRED = "Agree to the Crewtavo Terms to continue.";

/**
 * An owner or admin of a business that hasn't agreed to this version of the terms: agree once to
 * go on. `onSignOut` is the session's, which leaves nothing of theirs on the phone.
 */
export function TermsPage({ companyName, onAccepted, onSignOut }: { companyName: string; onAccepted: () => void; onSignOut: () => void }) {
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
    <AuthLayout onSignOut={onSignOut} width="read">
      <form className={authStyles.flow} onSubmit={submit}>
        <h1 className={authStyles.title}>Before you continue</h1>
        <p className={authStyles.sub}>
          An owner or admin needs to agree to the current Crewtavo Terms for <strong>{companyName}</strong>. You only do this once.
        </p>
        <TermsAgreement agreed={agreed} onChange={setAgreed} error={touched && !agreed ? TERMS_REQUIRED : null} />
        <div style={{ marginTop: 16 }}><FormError error={accept.error} /></div>
        <div className={authStyles.acts}>
          <Button type="submit" variant="primary" loading={accept.isPending}>Agree and continue</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
