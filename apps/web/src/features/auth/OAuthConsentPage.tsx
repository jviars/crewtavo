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
import { BrandMark } from "@/components/shell/BrandMark";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
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

  const shell = (body: React.ReactNode) => <AuthLayout>{body}</AuthLayout>;
  /** A message in place of the request: a quiet icon, a title, what to do. */
  const message = (icon: IconName, title: string, text: React.ReactNode, action?: React.ReactNode) => (
    <AuthLayout center>
      <span className={styles.mailTile} aria-hidden="true"><Icon name={icon} size={28} /></span>
      <h1 className={styles.title}>{title}</h1>
      {text && <p className={styles.sub} style={{ maxWidth: 440 }}>{text}</p>}
      {action && <div className={styles.acts}>{action}</div>}
    </AuthLayout>
  );

  if (!authorizationId) return message("link", "This link is incomplete", null);
  if (onlySub) {
    return message("lock", "Can't connect an AI assistant", error ?? NO_ASSISTANTS_FOR_SUBS, <Button loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>Go back</Button>);
  }
  if (details.error) return message("alert", "This request can't be used", (details.error as Error).message, <Button onClick={() => details.refetch()} icon="refresh">Try again</Button>);
  if (details.isPending || !details.data || !("client" in details.data))
    return shell(
      <div className={styles.flow} aria-label="Loading" aria-busy="true">
        <div className={styles.apps}><Skeleton width={52} height={52} radius={14} /><span className={styles.link} /><Skeleton width={52} height={52} radius={14} /></div>
        <Skeleton width="70%" height={28} style={{ justifySelf: "center", alignSelf: "center", marginTop: 22 }} />
        <div className={styles.skeletonStack}>
          <Skeleton height={64} radius={10} />
          <Skeleton height={88} radius={10} />
          <Skeleton height={46} radius={10} />
        </div>
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
  const where = (
    <>
      <strong className={styles.host}>{destination.host}</strong>
      <span>{destination.note}</span>
    </>
  );
  return shell(
    <div className={styles.flow}>
      <div className={styles.apps} aria-hidden="true">
        <span className={styles.appTile}>{logo ? <img src={logo} alt="" /> : name.slice(0, 1)}</span>
        <span className={styles.link}><Icon name="link" size={14} /></span>
        <span className={styles.appTile} data-us=""><BrandMark size={26} /></span>
      </div>
      <div className={styles.consentHead}>
        <h1 className={styles.title} style={{ fontSize: "var(--fs-24)" }}>{known ? `Connect ${name}?` : `Connect an app called ${name}?`}</h1>
        <p className={styles.sub}>Signed in as <strong>{user.email}</strong></p>
      </div>
      {!known && (
        <div className={`callout callout-warning ${styles.consentWarn}`} role="alert" data-destination={destination.kind}>
          <Icon name="alert" size={16} />
          <span className={`grow ${styles.destination}`}><span className="strong">It connects to</span>{where}</span>
        </div>
      )}
      <dl className={styles.facts}>
        {known && (
          <div className={styles.fact} data-destination={destination.kind}>
            <dt>It connects to</dt>
            <dd className={styles.destination} data-known=""><Icon name="check" size={16} />{where}</dd>
          </div>
        )}
        <div className={styles.fact}>
          <dt>It will be able to read</dt>
          <dd>
            <ul className={styles.scopes} aria-label="It will be able to read">
              <li><Icon name="check" size={14} bold />{CAN_READ}</li>
            </ul>
          </dd>
        </div>
      </dl>
      <p className={styles.note} style={{ marginTop: 12 }}>{kept ? keepsAccess(kept) : CANT_CHANGE}</p>
      {error && <div className="callout callout-warning" role="alert" style={{ marginTop: 16 }}><Icon name="alert" size={16} /><span className="grow" style={{ fontWeight: 600 }}>{error}</span></div>}
      <div className={styles.acts} data-stack="">
        <Button variant="primary" loading={busy === "allow"} disabled={busy !== null} onClick={() => decide(true)}>Allow access</Button>
        <Button variant="ghost" loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)}>Cancel</Button>
      </div>
    </div>,
  );
}
