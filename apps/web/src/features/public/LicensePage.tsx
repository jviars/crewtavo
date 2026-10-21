/**
 * The Crewtavo Terms and license this server runs, open to anyone (/license). Intuit asks a
 * business's own QuickBooks app for a license agreement address, and this is it (AppKeysCard).
 */
import { useEffect } from "react";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { LicenseNotice, TermsSummary, TermsText } from "@/features/legal/License";

export function LicensePage() {
  useEffect(() => {
    document.title = "Crewtavo Terms and License";
  }, []);
  return (
    <AuthLayout>
      <div className={`card card-pad ${authStyles.card} ${authStyles.wide}`} style={{ padding: 28, gap: 18 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={authStyles.title}>The Crewtavo Terms</h1>
          <p className="muted" style={{ margin: 0 }}>The terms the business that runs this server agreed to when it set up Crewtavo.</p>
        </div>
        <TermsSummary />
        <TermsText open />
        <div style={{ display: "grid", gap: 6 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>License</h2>
          <LicenseNotice />
        </div>
      </div>
    </AuthLayout>
  );
}
