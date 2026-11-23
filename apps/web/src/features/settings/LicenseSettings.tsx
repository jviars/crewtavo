/** Settings → Terms and license: the Crewtavo Terms and license for everyone, and for owners and admins, who agreed and when. */
import { ROLE_LABELS, type Role } from "@crewtavo/core/roles";
import { useQuery } from "@tanstack/react-query";
import { RowPerson } from "@/components/ui/InboxList";
import { RelatedRow, Section } from "@/components/ui/Section";
import { InboxSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { LicenseNotice, TermsSummary, TermsText, TERMS_VERSION } from "@/features/legal/License";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";

interface Agreement { id: string; full_name: string; email: string | null; role: Role; version: string; accepted_at: string }

export function LicenseSettings() {
  const session = useSession();
  return (
    <>
      <Section level={3} title="Crewtavo Terms" count={`Version ${TERMS_VERSION}`}>
        <div className="set-stack">
          <p className="set-note">What the business agreed to when it set up Crewtavo: it runs Crewtavo itself and is responsible for its data and its customers.</p>
          <TermsSummary />
          <TermsText />
        </div>
      </Section>
      <Section level={3} title="License">
        <LicenseNotice />
      </Section>
      {hasRole(session, "admin") && <Agreements />}
    </>
  );
}

function Agreements() {
  const session = useSession();
  const terms = useQuery({ queryKey: ["terms", session.company.id], queryFn: () => api.get<{ version: string; agreements: Agreement[] }>("/terms") });
  return (
    <Section level={3} title="Who agreed" count={terms.data?.agreements.length || undefined}>
      <p className="set-note">Agreements are kept as they were made and can't be changed. When the terms change, an owner or admin is asked to agree again.</p>
      {terms.isPending ? (
        <InboxSkeleton rows={2} />
      ) : terms.error ? (
        <ErrorState compact error={terms.error} onRetry={() => terms.refetch()} />
      ) : terms.data.agreements.length ? (
        <ul className="rel" role="list">
          {terms.data.agreements.map((a) => (
            <RelatedRow
              key={a.id}
              lead={<RowPerson name={a.full_name || a.email || "Someone"} />}
              title={a.full_name || a.email || "Someone"}
              detail={ROLE_LABELS[a.role]}
              // The version and when as one line of words, its own line on a phone, so it wraps as words and leaves the right edge to Current.
              sub={[a.full_name ? a.email : null, <span key="when" className="meta-break">{`Version ${a.version} · ${formatDateTime(a.accepted_at)}`}</span>]}
              end={a.version === terms.data.version ? <StatusPill tone="good" label="Current" /> : undefined}
            />
          ))}
        </ul>
      ) : (
        <EmptyState inline title="Nobody has agreed yet" />
      )}
    </Section>
  );
}
