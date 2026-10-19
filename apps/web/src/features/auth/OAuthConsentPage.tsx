/**
 * Consent screen for Supabase's OAuth 2.1 server, shown when Claude, ChatGPT or another MCP client
 * asks to connect. Configure this path (/oauth/consent) under Authentication > OAuth Server. A new
 * connection only reads until the person chooses what it can change (Settings → AI assistants).
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase } from "@/lib/api";
import { authMessage, AuthLayout } from "./LoginPage";
import styles from "./auth.module.css";

const CAN = ["Clients, requests, quotes and jobs", "Schedule", "Knowledge base"];

export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [error, setError] = useState<string | null>(null);

  const details = useQuery({
    queryKey: ["oauth-consent", authorizationId],
    enabled: Boolean(authorizationId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase().auth.oauth.getAuthorizationDetails(authorizationId!);
      if (error) throw new Error(authMessage(error));
      // Already approved earlier: Supabase hands back where to send the user.
      if ("redirect_url" in data && !("authorization_id" in data)) {
        window.location.assign(data.redirect_url);
        return null;
      }
      return data;
    },
  });

  async function decide(approve: boolean) {
    setBusy(approve ? "allow" : "deny");
    setError(null);
    const oauth = supabase().auth.oauth;
    const { data, error } = approve
      ? await oauth.approveAuthorization(authorizationId!, { skipBrowserRedirect: true })
      : await oauth.denyAuthorization(authorizationId!, { skipBrowserRedirect: true });
    if (error) {
      setBusy(null);
      setError(authMessage(error));
      return;
    }
    window.location.assign(data.redirect_url);
  }

  const shell = (body: React.ReactNode) => (
    <AuthLayout>
      <div className={`card card-pad ${styles.card}`} style={{ padding: 28, width: "min(440px, 100%)" }}>{body}</div>
    </AuthLayout>
  );

  if (!authorizationId) return shell(<EmptyState icon="link" title="This link is incomplete" />);
  if (details.error) return shell(<EmptyState icon="alert" title="This request can't be used" action={<Button onClick={() => details.refetch()} icon="refresh">Try again</Button>}>{(details.error as Error).message}</EmptyState>);
  if (details.isPending || !details.data || !("client" in details.data))
    return shell(
      <div className="stack" style={{ gap: 16 }} aria-label="Loading" aria-busy="true">
        <div className={styles.apps}><Skeleton width={52} height={52} radius={14} /><span className={styles.dots}>•••</span><Skeleton width={52} height={52} radius={14} /></div>
        <Skeleton width="80%" height={22} style={{ justifySelf: "center" }} />
        <Skeleton height={110} radius={12} />
        <Skeleton height={46} radius={10} />
      </div>,
    );

  const { client, user } = details.data;
  const logo = (client as { logo_uri?: string }).logo_uri;
  return shell(
    <div className="stack" style={{ gap: 18 }}>
      <div className={styles.apps} aria-hidden="true">
        <span className={styles.appTile}>{logo ? <img src={logo} alt="" /> : client.name.slice(0, 1)}</span>
        <span className={styles.dots}>•••</span>
        <span className={styles.appTile} style={{ background: "var(--solid)", color: "var(--on-solid)" }}><Icon name="layers" size={24} /></span>
      </div>
      <div className="stack-sm" style={{ gap: 6, textAlign: "center" }}>
        <h1 className={styles.title} style={{ fontSize: 22 }}>Connect {client.name}?</h1>
        <p className="muted" style={{ margin: 0 }}>Signed in as <strong style={{ color: "var(--ink)" }}>{user.email}</strong></p>
      </div>
      <span className="muted small strong" style={{ marginBottom: -10 }}>Can look at</span>
      <ul className={styles.scopes} aria-label="Can look at">
        {CAN.map((c) => <li key={c}><Icon name="check" size={15} strokeWidth={2.6} />{c}</li>)}
      </ul>
      <span className="muted small" style={{ marginTop: -8 }}>It starts out read only. Choose what it can change in Crewtavo, under Settings → AI assistants.</span>
      {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}
      <div className="stack-sm" style={{ gap: 8 }}>
        <Button variant="primary" size="lg" loading={busy === "allow"} disabled={busy !== null} onClick={() => decide(true)}>Allow access</Button>
        <Button size="lg" variant="ghost" loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>Cancel</Button>
      </div>
    </div>,
  );
}
