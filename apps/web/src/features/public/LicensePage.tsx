/**
 * The Crewtavo License this server runs, open to anyone (/license). Intuit asks a business's own
 * QuickBooks app for a license agreement address, and this is it (AppKeysCard).
 */
import { useEffect } from "react";
import { AuthLayout } from "@/features/auth/LoginPage";
import authStyles from "@/features/auth/auth.module.css";
import { LicenseSummary, LicenseText } from "@/features/legal/License";

export function LicensePage() {
  useEffect(() => {
    document.title = "Crewtavo License";
  }, []);
  return (
    <AuthLayout>
      <div className={`card card-pad ${authStyles.card} ${authStyles.wide}`} style={{ padding: 28, gap: 18 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={authStyles.title}>The Crewtavo License</h1>
          <p className="muted" style={{ margin: 0 }}>The license for the Crewtavo software running on this server, which the business that runs it agreed to.</p>
        </div>
        <LicenseSummary />
        <LicenseText open />
      </div>
    </AuthLayout>
  );
}
