/**
 * Consent screen for Supabase's OAuth 2.1 server, shown when Claude, ChatGPT or another MCP client
 * asks to connect. Configure this path (/oauth/consent) under Authentication > OAuth Server. A new
 * connection only reads until the person chooses what it can change (Settings → AI assistants).
 * A sub's sign-in can't connect one (the server refuses it too).
 *
 * Any app can sign itself up under any name and logo, so the screen shows where the connection
 * really leads (the host the sign-in server will send the person's access to), cautions when that
 * isn't Claude's or ChatGPT's own address, and says plainly what the app will be able to read:
 * everything the person can see (oauthConsent.ts).
 */
import { describeAssistantAccess, toAssistantAccess } from "@crewtavo/core/assistants";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/States";
import { supabase } from "@/lib/api";
import { onlySubs, useSessionIfAny } from "@/lib/session";
import { authMessage, AuthLayout } from "./LoginPage";
import { CAN_READ, CANT_CHANGE, consentDestination, keepsAccess } from "./oauthConsent";
import styles from "./auth.module.css";

const NO_ASSISTANTS_FOR_SUBS = "AI assistants are for a business's own team. A subcontractor's sign-in can't use one.";

export function OAuthConsentPage() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id");
  const [busy, setBusy] = useState<null | "allow" | "deny">(null);
  const [error, setError] = useState<string | null>(null);
  // Someone whose every sign-in is a sub's.
  const session = useSessionIfAny();
  const onlySub = onlySubs(session?.companies);

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

  // What this person gave the app before, if they connected it earlier (no row: it only reads).
  const clientId = details.data && "client" in details.data ? details.data.client.id : null;
  const given = useQuery({
    queryKey: ["oauth-consent-access", clientId],
    enabled: Boolean(clientId) && !onlySub,
    retry: false,
    queryFn: async () => {
      const { data } = await supabase().from("assistant_connections").select("level, areas").eq("client_id", clientId!).maybeSingle();
      return toAssistantAccess(data);
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
  if (onlySub) {
    return shell(
      <EmptyState icon="lock" title="Can't connect an AI assistant" action={<Button loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>Go back</Button>}>
        {error ?? NO_ASSISTANTS_FOR_SUBS}
      </EmptyState>,
    );
  }
  if (details.error) return shell(<EmptyState icon="alert" title="This request can't be used" action={<Button onClick={() => details.refetch()} icon="refresh">Try again</Button>}>{(details.error as Error).message}</EmptyState>);
  if (details.isPending || !details.data || !("client" in details.data))
    return shell(
      <div className="stack" style={{ gap: 16 }} aria-label="Loading" aria-busy="true">
        <div className={styles.apps}><Skeleton width={52} height={52} radius={12} /><span className={styles.dots}>•••</span><Skeleton width={52} height={52} radius={12} /></div>
        <Skeleton width="80%" height={22} style={{ justifySelf: "center" }} />
        <Skeleton height={110} radius={12} />
        <Skeleton height={46} radius={8} />
      </div>,
    );

  const { client, user, redirect_uri } = details.data;
  const name = client.name?.trim() || "an app";
  // The address can't be faked; the name and logo can (oauthConsent.ts). So an app only gets its own
  // logo and a plain "Connect Claude?" when it leads where Claude or ChatGPT really are.
  const destination = consentDestination(redirect_uri);
  const known = destination.kind === "known";
  const logo = known ? (client as { logo_uri?: string }).logo_uri : undefined;
  // Connected before and given more than reading: it keeps that, so the screen doesn't say otherwise.
  const kept = given.data && given.data.level !== "read" ? describeAssistantAccess(given.data) : null;
  return shell(
    <div className="stack" style={{ gap: 18 }}>
      <div className={styles.apps} aria-hidden="true">
        <span className={styles.appTile}>{logo ? <img src={logo} alt="" /> : name.slice(0, 1)}</span>
        <span className={styles.dots}>•••</span>
        <span className={styles.appTile} style={{ background: "var(--solid)", color: "var(--on-solid)" }}><Icon name="layers" size={24} /></span>
      </div>
      <div className="stack-sm" style={{ gap: 6, textAlign: "center" }}>
        <h1 className={styles.title}>{known ? `Connect ${name}?` : `Connect an app called ${name}?`}</h1>
        <p className="muted" style={{ margin: 0 }}>Signed in as <strong style={{ color: "var(--ink)" }}>{user.email}</strong></p>
      </div>
      <div className={known ? "callout" : "callout callout-warning"} role={known ? undefined : "alert"} data-destination={destination.kind}>
        <Icon name={known ? "check" : "alert"} size={16} />
        <span className="grow stack-sm" style={{ gap: 2 }}>
          <span className="small strong">It connects to</span>
          <strong className={styles.host}>{destination.host}</strong>
          <span className="small">{destination.note}</span>
        </span>
      </div>
      <span className="muted small strong" style={{ marginBottom: -10 }}>It will be able to read</span>
      <ul className={styles.scopes} aria-label="It will be able to read">
        <li><Icon name="check" size={14} strokeWidth={2} />{CAN_READ}</li>
      </ul>
      <span className="muted small" style={{ marginTop: -8 }}>{kept ? keepsAccess(kept) : CANT_CHANGE}</span>
      {error && <div className="callout callout-warning" role="alert" style={{ padding: "10px 12px" }}><Icon name="alert" size={16} /><span className="grow small" style={{ fontWeight: 600 }}>{error}</span></div>}
      <div className="stack-sm" style={{ gap: 8 }}>
        <Button variant="primary" size="lg" loading={busy === "allow"} disabled={busy !== null} onClick={() => decide(true)}>Allow access</Button>
        <Button size="lg" variant="ghost" loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>Cancel</Button>
      </div>
    </div>,
  );
}
