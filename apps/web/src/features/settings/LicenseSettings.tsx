/** Settings → License: the Crewtavo License for everyone, and for owners and admins, who agreed and when. */
import { ROLE_LABELS, type Role } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { LicenseSummary, LicenseText, TERMS_VERSION } from "@/features/legal/License";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";

interface Agreement { id: string; full_name: string; email: string | null; role: Role; version: string; accepted_at: string }

export function LicenseSettings() {
  const session = useSession();
  return (
    <div className="stack">
      <div className="card card-pad stack-sm" style={{ gap: 12 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <strong>Crewtavo License</strong>
          <span className="muted small">Version {TERMS_VERSION}. The BSD 3-Clause license, plus a branding clause and no liability for your data or what you do with Crewtavo.</span>
        </div>
        <LicenseSummary />
        <LicenseText />
      </div>
      {hasRole(session, "admin") && <Agreements />}
    </div>
  );
}

function Agreements() {
  const session = useSession();
  const terms = useQuery({ queryKey: ["terms", session.company.id], queryFn: () => api.get<{ version: string; agreements: Agreement[] }>("/terms") });
  if (terms.isPending) return <TableSkeleton columns={3} rows={2} />;
  if (terms.error) return <div className="card"><ErrorState error={terms.error} onRetry={() => terms.refetch()} /></div>;
  return (
    <div className="stack-sm">
      <strong>Who agreed</strong>
      <span className="muted small">Agreements are kept as they were made and can't be changed. When the license changes, an owner or admin is asked to agree again.</span>
      <div className="card">
        <table className="table table-stack">
          <thead><tr><th>Person</th><th>Version</th><th>Agreed</th></tr></thead>
          <tbody>
            {terms.data.agreements.map((a) => (
              <tr key={a.id}>
                <td><strong>{a.full_name || a.email || "Someone"}</strong><div className="muted small">{[ROLE_LABELS[a.role], a.full_name ? a.email : null].filter(Boolean).join(" · ")}</div></td>
                <td>{a.version}{a.version === terms.data.version && <span className="chip" style={{ marginLeft: 6 }}>Current</span>}</td>
                <td>{formatDateTime(a.accepted_at)}</td>
              </tr>
            ))}
            {terms.data.agreements.length === 0 && <tr><td colSpan={3} className="muted">Nobody has agreed yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
