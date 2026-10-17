/** Connect accounting, calendar, payments and AI. Tokens stay on the server, encrypted; this page only sees status. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import chatgptLogo from "@/assets/apps/chatgpt.svg";
import claudeLogo from "@/assets/apps/claude.svg";
import googleCalendarLogo from "@/assets/apps/google-calendar.svg";
import quickbooksLogo from "@/assets/apps/quickbooks.svg";
import stripeLogo from "@/assets/apps/stripe.svg";
import twilioLogo from "@/assets/apps/twilio.svg";
import zohoLogo from "@/assets/apps/zoho.svg";
import { AssistantAccess } from "./AssistantAccess";

/** Each app's own logo (see assets/apps/README.md). */
const LOGOS: Record<string, string> = {
  quickbooks: quickbooksLogo,
  zoho_books: zohoLogo,
  google_calendar: googleCalendarLogo,
  stripe: stripeLogo,
  twilio: twilioLogo,
  anthropic: claudeLogo,
};

function AppLogo({ provider, name }: { provider: string; name: string }) {
  const src = LOGOS[provider];
  return src ? (
    <span className="app-mark app-logo" data-wide={provider === "zoho_books" || undefined}><img src={src} alt="" width={22} height={22} /></span>
  ) : (
    <span className="app-mark">{name.slice(0, 1)}</span>
  );
}

interface AppRow {
  provider: string;
  name: string;
  category: string;
  description: string;
  auth: "oauth" | "api_key";
  docs: string;
  available: boolean;
  redirect_uri: string | null;
  status: "connected" | "disconnected" | "error";
  account_label?: string | null;
  last_sync_at?: string | null;
  last_error?: string | null;
}

const STATUS: Record<AppRow["status"], { label: string; tone: Tone }> = {
  connected: { label: "Connected", tone: "good" },
  disconnected: { label: "Not connected", tone: "muted" },
  error: { label: "Needs attention", tone: "danger" },
};

export function AppsPage() {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const isAdmin = hasRole(session, "admin") && can(session, "apps");
  const apps = useQuery({ queryKey: ["apps", company.id], enabled: isAdmin, queryFn: () => api.get<{ mcp_url: string; apps: AppRow[] }>("/apps") });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["apps", company.id] });
  const connect = useMutation({
    mutationFn: (provider: string) => api.post<{ authorization_url: string }>(`/apps/${provider}/connect`),
    onSuccess: (res) => window.location.assign(res.authorization_url), // the provider sends the user back to /apps
  });
  const disconnect = useMutation({
    meta: { success: (_: unknown, provider: string) => `${apps.data?.apps.find((a) => a.provider === provider)?.name ?? "App"} disconnected` },
    mutationFn: (provider: string) => api.post(`/apps/${provider}/disconnect`),
    onSettled: refresh,
  });

  const callback = params.get("app") ? { app: params.get("app"), ok: params.get("status") === "connected", message: params.get("message") } : null;
  const groups = new Map<string, AppRow[]>();
  for (const app of apps.data?.apps ?? []) groups.set(app.category, [...(groups.get(app.category) ?? []), app]);

  if (!isAdmin) return <NoAccess title="Apps" />;

  return (
    <>
      <BackLink to="/settings">Settings</BackLink>
      <PageHeader title="Apps" />
      {callback && (
        <div className={`callout ${callback.ok ? "callout-good" : "callout-warning"}`} role={callback.ok ? "status" : "alert"}>
          <Icon name={callback.ok ? "check" : "alert"} size={18} />
          <div className="grow">{callback.ok ? `Connected${callback.app ? ` to ${apps.data?.apps.find((a) => a.provider === callback.app)?.name ?? callback.app}` : ""}. New invoices and payments will sync automatically.` : callback.message ?? "That app couldn't be connected. Try again."}</div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setParams({}, { replace: true })}><Icon name="x" size={16} /></button>
        </div>
      )}

      <section className="card card-pad stack-sm" aria-labelledby="assistants-title" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <span className="app-logos" aria-hidden="true">
            <span className="app-mark app-logo"><img src={claudeLogo} alt="" width={22} height={22} /></span>
            <span className="app-mark app-logo"><img src={chatgptLogo} alt="" width={22} height={22} /></span>
          </span>
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <h2 id="assistants-title" className="section-title" style={{ fontSize: 17 }}>Connect Claude or ChatGPT</h2>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {apps.data ? <code className="code-pill grow">{apps.data.mcp_url}</code> : <Skeleton height={38} radius={8} style={{ flex: 1 }} />}
          <Button icon="copy" disabled={!apps.data} onClick={() => copyText(apps.data!.mcp_url, "Link copied")}>Copy</Button>
        </div>
        <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>Claude:</strong> Settings → Connectors → Add custom connector</li>
          <li><strong>ChatGPT:</strong> Settings → Apps and connectors → Add (developer mode)</li>
        </ul>
        <AssistantAccess />
      </section>

      {apps.error && <div className="card"><ErrorState error={apps.error} onRetry={() => apps.refetch()} /></div>}
      {apps.isPending && (
        <Loading label="Loading apps" className="stack">
          <Skeleton width={140} height={18} />
          <div className="grid-cards">{[0, 1, 2].map((i) => <CardSkeleton key={i} lines={3} />)}</div>
        </Loading>
      )}

      {[...groups].map(([category, rows]) => (
        <section key={category} aria-label={category} className="stack-sm" style={{ gap: 12 }}>
          <h2 className="section-title">{category}</h2>
          <div className="grid-cards">
            {rows.map((app) => (
              <AppCard
                key={app.provider}
                app={app}
                connecting={connect.isPending && connect.variables === app.provider}
                disconnecting={disconnect.isPending && disconnect.variables === app.provider}
                onConnect={() => connect.mutate(app.provider)}
                onDisconnect={async () => {
                  if (await confirm({ title: `Disconnect ${app.name}?`, body: "Syncing stops right away. Nothing already synced is deleted, and you can reconnect any time.", confirmLabel: "Disconnect", danger: true })) disconnect.mutate(app.provider);
                }}
                onSaved={refresh}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function AppCard({ app, connecting, disconnecting, onConnect, onDisconnect, onSaved }: { app: AppRow; connecting: boolean; disconnecting: boolean; onConnect: () => void; onDisconnect: () => void; onSaved: () => void }) {
  const status = STATUS[app.status] ?? STATUS.disconnected;
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const save = useMutation({
    meta: { inline: true, success: `${app.name} key saved` },
    mutationFn: () => api.put(`/apps/${app.provider}/key`, { api_key: key.trim() }),
    onSuccess: () => {
      setKey("");
      onSaved();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim().length >= 10) save.mutate();
  };
  return (
    <div className="card card-pad stack-sm app-card" data-status={app.status} style={{ gap: 10, alignContent: "start" }}>
      <div className="row" style={{ gap: 10 }}>
        <AppLogo provider={app.provider} name={app.name} />
        <strong className="grow" style={{ fontSize: 15 }}>{app.name}</strong>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <p className="muted small" style={{ margin: 0 }}>{app.description}</p>
      {app.status === "connected" && (app.account_label || app.last_sync_at) && (
        <div className="small" style={{ display: "grid", gap: 2 }}>
          {app.account_label && <span className="strong">{app.account_label}</span>}
          {app.last_sync_at && <span className="muted">Last synced {timeAgo(app.last_sync_at)}</span>}
        </div>
      )}
      {app.last_error && <div className="small" style={{ color: "var(--danger)", fontWeight: 600 }} title={app.last_error}><Icon name="alert" size={13} /> The last sync didn't work. Try reconnecting.</div>}

      {!app.available ? (
        <div className="muted small stack-sm" style={{ gap: 4 }}>
          <span>Not available yet. Ask whoever set up Crewtavo to turn it on.</span>
          <details>
            <summary style={{ cursor: "pointer" }}>Setup details</summary>
            <div className="stack-sm" style={{ gap: 4, marginTop: 4 }}>
              <a href={app.docs} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
              {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
            </div>
          </details>
        </div>
      ) : app.auth === "oauth" ? (
        <div className="row" style={{ gap: 8, marginTop: 2 }}>
          {app.status === "connected" ? (
            <Button loading={disconnecting} onClick={onDisconnect}>Disconnect</Button>
          ) : (
            <Button variant="primary" icon={app.status === "error" ? "refresh" : "link"} loading={connecting} onClick={onConnect}>{app.status === "error" ? "Reconnect" : "Connect"}</Button>
          )}
        </div>
      ) : (
        <form className="stack-sm" onSubmit={submit} style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <div className="input-group grow">
              <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={app.status === "connected" ? "Paste a new key to replace it" : "Paste your key"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label={`${app.name} API key`} style={{ paddingLeft: 12, paddingRight: 36 }} />
              <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={15} /></button>
            </div>
            <Button type="submit" loading={save.isPending} disabled={key.trim().length < 10}>Save</Button>
          </div>
          {save.error && <span className="field-error">{(save.error as Error).message}</span>}
        </form>
      )}
    </div>
  );
}
