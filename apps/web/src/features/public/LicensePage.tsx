/**
 * The Crewtavo Terms and license this server runs, open to anyone (/license). Intuit asks a
 * business's own QuickBooks app for a license agreement address, and this is it (AppKeysCard).
 * In the frame of the screens before the app (AuthLayout), as a page to read: no card around it.
 */
import { useEffect } from "react";
import { Section } from "@/components/ui/Section";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { LicenseNotice, TermsSummary, TermsText } from "@/features/legal/License";
import styles from "./license.module.css";

export function LicensePage() {
  useEffect(() => {
    document.title = "Crewtavo Terms and License";
  }, []);
  return (
    <AuthLayout>
      <div className={`${authStyles.flow} ${authStyles.wide} ${styles.page}`}>
        <div>
          <h1 className={authStyles.title}>The Crewtavo Terms</h1>
          <p className={authStyles.sub}>The terms the business that runs this server agreed to when it set up Crewtavo.</p>
        </div>
        <TermsSummary />
        <TermsText open />
        <Section title="License">
          <LicenseNotice />
        </Section>
      </div>
    </AuthLayout>
  );
}
