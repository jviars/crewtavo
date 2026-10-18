/**
 * One app's page, laid out like an app store listing: its icon, name and the button to get it;
 * a strip of facts; then managing it (calendars, sign-in, keys), what it does, and what Crewtavo
 * can see and do in it.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { BackLink, useDocumentTitle } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { AppIcon, AppTile } from "./AppIcon";
import { AssistantAccess, ConnectedAssistants } from "./AssistantAccess";
import { CalendarRow, GoogleCalendarPanel, LinkCalendarsPanel, AddCalendarForm, useCalendars } from "./CalendarPanels";
import { CATEGORY_LABELS, infoFor, MORE_LABELS, useApps, type AppRow } from "./catalog";
import { StripePanel } from "./StripePanel";

/** Where each assistant keeps its connector settings. */
const CONNECTOR_STEPS: Record<string, string[]> = {
  anthropic: ["In Claude, open Settings, then Connectors.", "Choose Add custom connector and paste the link above.", "Sign in with your Crewtavo account when Claude asks."],
  chatgpt: ["In ChatGPT, open Settings, then Apps and connectors.", "With developer mode on, add a connector and paste the link above.", "Sign in with your Crewtavo account when ChatGPT asks."],
};

function statusOf(app: AppRow): { label: string; tone: Tone } {
  if (!app.available) return { label: "Not available yet", tone: "muted" };
  if (app.status === "error" || app.calendar_errors) return { label: "Needs attention", tone: "danger" };
  if (app.auth === "link") return app.calendars ? { label: `${app.calendars} ${app.calendars === 1 ? "calendar" : "calendars"}`, tone: "good" } : { label: "Not added", tone: "muted" };
  if (app.auth === "connector") return { label: "Ready to connect", tone: "info" };
  // Claude connects by link like ChatGPT; its key is optional.
  if (app.id === "anthropic") return app.status === "connected" ? { label: "Ready · your key added", tone: "good" } : { label: "Ready to connect", tone: "info" };
  return app.status === "connected" ? { label: "Connected", tone: "good" } : { label: "Not connected", tone: "muted" };
}

export function AppDetailPage() {
  const { id = "" } = useParams();
  const apps = useApps();
  const app = apps.data?.apps.find((a) => a.id === id);
  useDocumentTitle(app?.name ?? "Apps");

  if (!apps.allowed) return <NoAccess title="Apps" />;
  if (apps.error) return <><BackLink to="/apps">Apps</BackLink><div className="card"><ErrorState error={apps.error} onRetry={() => apps.refetch()} /></div></>;
  if (apps.isPending) {
    return (
      <Loading label="Loading app">
        <BackLink to="/apps">Apps</BackLink>
        <div className="app-hero">
          <Skeleton width={112} height={112} radius={26} />
          <div className="stack-sm grow"><Skeleton width={220} height={28} /><Skeleton width={280} height={14} /><Skeleton width={120} height={36} radius={999} /></div>
        </div>
      </Loading>
    );
  }
  if (!app) {
    return (
      <>
        <BackLink to="/apps">Apps</BackLink>
        <div className="card"><EmptyState icon="apps" title="That app isn't here" action={<Link className="btn" to="/apps">See all apps</Link>}>It may have been renamed or removed.</EmptyState></div>
      </>
    );
  }
  return <AppListing app={app} all={apps.data!.apps} mcpUrl={apps.data!.mcp_url} />;
}

function AppListing({ app, all, mcpUrl }: { app: AppRow; all: AppRow[]; mcpUrl: string }) {
  const info = infoFor(app);
  const session = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const calendars = useCalendars(app.id === "google_calendar");
  const refresh = () => {
    for (const key of ["apps", "calendars", "google-calendars"]) queryClient.invalidateQueries({ queryKey: [key] });
  };
  const connect = useMutation({
    mutationFn: () => api.post<{ authorization_url: string }>(`/apps/${app.id}/connect`),
    onSuccess: (res) => window.location.assign(res.authorization_url), // the provider sends the person back to this page
  });
  const disconnect = useMutation({
    meta: { success: `${app.name} disconnected` },
    mutationFn: () => api.post(`/apps/${app.id}/disconnect`),
    onSettled: refresh,
  });
  const status = statusOf(app);
  const callback = params.get("status") ? { ok: params.get("status") === "connected", message: params.get("message") } : null;
  const scrollTo = (target: string) => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const askDisconnect = async () => {
    const body =
      app.id === "google_calendar"
        ? "Its calendars come off the schedule, and the visits calendar Crewtavo made is removed from your Google account. Calendars added by link stay. You can reconnect any time."
        : app.id === "stripe"
          ? "Crewtavo's webhook comes out of your Stripe account, and new invoices and payments stop showing up here. Nothing already recorded is deleted, and you can reconnect any time."
          : "Syncing stops right away. Nothing already synced is deleted, and you can reconnect any time.";
    if (await confirm({ title: `Disconnect ${app.name}?`, body, confirmLabel: "Disconnect", danger: true })) disconnect.mutate();
  };

  // The button next to the name, like "Get" in an app store.
  let action: ReactNode = null;
  if (!app.available) action = <Button className="app-get" disabled>Not available</Button>;
  else if (app.auth === "oauth") {
    action = app.status === "connected"
      ? <Button className="app-get" loading={disconnect.isPending} onClick={askDisconnect}>Disconnect</Button>
      : <Button className="app-get" variant="primary" icon={app.status === "error" ? "refresh" : undefined} loading={connect.isPending} onClick={() => connect.mutate()}>{app.status === "error" ? "Reconnect" : "Connect"}</Button>;
  } else if (app.auth === "link") action = <Button className="app-get" variant="primary" icon="plus" onClick={() => scrollTo(`${app.id}-add`)}>{app.calendars ? "Add another" : "Add a calendar"}</Button>;
  else if (app.auth === "connector" || app.id === "anthropic") action = <Button className="app-get" variant="primary" icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy link</Button>;
  else if (app.id === "stripe") action = <Button className="app-get" variant={app.stripe?.own ? "secondary" : "primary"} onClick={() => scrollTo("app-setup")}>{app.stripe?.own ? "Replace key" : "Connect"}</Button>;
  else action = <Button className="app-get" variant={app.status === "connected" ? "secondary" : "primary"} onClick={() => scrollTo("app-setup")}>{app.status === "connected" ? "Replace key" : "Add key"}</Button>;

  const others = all.filter((a) => a.category === app.category && a.id !== app.id);
  const googleSources = (calendars.data?.calendars ?? []).filter((s) => s.app === "google_calendar" && s.kind === "ics");

  return (
    <>
      <BackLink to="/apps">Apps</BackLink>

      <header className="app-hero">
        <AppIcon id={app.id} name={app.name} size="lg" />
        <div className="app-hero-text">
          <h1 className="app-hero-name">{app.name}</h1>
          <p className="app-hero-tagline">{info.tagline}</p>
          <div className="app-hero-actions">
            {action}
            <StatusPill label={status.label} tone={status.tone} />
          </div>
        </div>
      </header>

      <dl className="app-facts" aria-label="About this app">
        <div><dt>Category</dt><dd>{CATEGORY_LABELS[app.category] ?? app.category}</dd></div>
        <div><dt>Made by</dt><dd>{info.developer}</dd></div>
        {info.connectsWith && <div><dt>Connects with</dt><dd>{info.connectsWith}</dd></div>}
        <div><dt>Status</dt><dd>{status.label}</dd></div>
      </dl>

      {callback && (
        <div className={`callout ${callback.ok ? "callout-good" : "callout-warning"}`} role={callback.ok ? "status" : "alert"}>
          <Icon name={callback.ok ? "check" : "alert"} size={18} />
          <div className="grow">
            {callback.ok ? `Connected to ${app.name}.` : (callback.message ?? `${app.name} couldn't be connected. Try again.`)}
            {callback.ok && <span style={{ display: "block", fontWeight: 400 }}>{app.id === "google_calendar" ? "Now pick the calendars to show on your schedule." : app.category === "Accounting" ? "New invoices and payments will sync automatically." : null}</span>}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setParams({}, { replace: true })}><Icon name="x" size={16} /></button>
        </div>
      )}

      {/* ---- Managing it ---- */}
      {!app.available && app.auth === "oauth" && <NotAvailable app={app} />}
      {app.auth === "oauth" && app.available && <AccountCard app={app} />}
      {app.id === "google_calendar" && app.status === "connected" && <GoogleCalendarPanel />}
      {app.id === "google_calendar" && (
        <details className="card card-pad app-details" open={!app.available || googleSources.length > 0 || undefined}>
          <summary>{app.available ? "Or add a calendar by its secret address" : "Add a Google calendar by its secret address"}</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <span className="muted small">Works without signing in. It only shows that calendar on your schedule; visits can't go to Google this way.</span>
            {googleSources.map((s) => <CalendarRow key={s.id} source={s} />)}
            <span id="google_calendar-add" />
            <AddCalendarForm app="google_calendar" appName="Google" steps={info.steps} />
          </div>
        </details>
      )}
      {app.auth === "link" && <LinkCalendarsPanel app={app.id} appName={app.name} steps={info.steps} />}
      {app.auth === "connector" && <ConnectorCard app={app} mcpUrl={mcpUrl} />}
      {app.id === "anthropic" && <ConnectorCard app={app} mcpUrl={mcpUrl} />}
      {app.id === "stripe" && app.stripe && <StripePanel app={app} disconnecting={disconnect.isPending} onDisconnect={askDisconnect} onChanged={refresh} />}
      {app.auth === "api_key" && (app.available ? <KeyCard app={app} onSaved={refresh} /> : <NotAvailable app={app} />)}

      {/* ---- What it does ---- */}
      {info.highlights.length > 0 && (
        <section aria-labelledby="app-highlights" className="stack-sm" style={{ gap: 12 }}>
          <h2 id="app-highlights" className="section-title">What it does</h2>
          <div className="app-highlights">
            {info.highlights.map((h) => (
              <div key={h.title} className="app-highlight">
                <span className="app-highlight-icon"><Icon name={h.icon} size={18} /></span>
                <strong>{h.title}</strong>
                <span className="muted small">{h.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="app-about" className="stack-sm" style={{ gap: 8 }}>
        <h2 id="app-about" className="section-title">About</h2>
        <p className="app-about">{info.about}</p>
      </section>

      <section aria-labelledby="app-info" className="stack-sm" style={{ gap: 8 }}>
        <h2 id="app-info" className="section-title">Information</h2>
        <dl className="card app-info">
          <div><dt>Made by</dt><dd>{info.developer}</dd></div>
          <div><dt>Category</dt><dd>{CATEGORY_LABELS[app.category] ?? app.category}</dd></div>
          {info.connectsWith && <div><dt>Connects with</dt><dd>{info.connectsWith}</dd></div>}
          {info.access.length > 0 && (
            <div>
              <dt>Crewtavo can</dt>
              <dd><ul className="app-access">{info.access.map((a) => <li key={a}>{a}</li>)}</ul></dd>
            </div>
          )}
          <div><dt>Who can change it</dt><dd>Owners and admins of {session.company.name}</dd></div>
          <div><dt>Website</dt><dd><a href={info.website} target="_blank" rel="noreferrer">{new URL(info.website).hostname.replace(/^www\./, "")} <Icon name="external" size={12} /></a></dd></div>
        </dl>
      </section>

      {others.length > 0 && (
        <section aria-labelledby="app-more" className="stack-sm" style={{ gap: 12 }}>
          <h2 id="app-more" className="section-title">{MORE_LABELS[app.category] ?? "More apps"}</h2>
          <div className="app-grid">{others.map((a) => <AppTile key={a.id} app={a} />)}</div>
        </section>
      )}
    </>
  );
}

/** The provider account a sign-in app is connected to. */
function AccountCard({ app }: { app: AppRow }) {
  if (app.status === "disconnected") return null;
  return (
    <section className="card card-pad stack-sm" aria-label="Account" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 10 }}>
        <Icon name={app.status === "error" ? "alert" : "check"} size={16} />
        <span className="grow">
          {app.status === "error" ? <strong>{app.name} needs to be reconnected</strong> : <>Connected{app.account_label ? <> to <strong>{app.account_label}</strong></> : null}</>}
        </span>
      </div>
      {app.last_error && <span className="small" style={{ color: "var(--danger)", fontWeight: 600 }}>{app.last_error}</span>}
      {app.last_sync_at && app.status === "connected" && <span className="muted small">Last synced {timeAgo(app.last_sync_at)}</span>}
    </section>
  );
}

function NotAvailable({ app }: { app: AppRow }) {
  return (
    <section className="callout" aria-label="Not available yet">
      <Icon name="info" size={18} />
      <div className="grow stack-sm" style={{ gap: 6 }}>
        <span>Not available yet</span>
        <span style={{ fontWeight: 400 }}>Ask whoever set up Crewtavo to turn on {app.name}.</span>
        <details>
          <summary style={{ cursor: "pointer", fontWeight: 400 }}>Setup details</summary>
          <div className="stack-sm small" style={{ gap: 4, marginTop: 6, fontWeight: 400 }}>
            <a href={app.docs} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
            {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
          </div>
        </details>
      </div>
    </section>
  );
}

/** Claude and ChatGPT connect to Crewtavo with the MCP link. */
function ConnectorCard({ app, mcpUrl }: { app: AppRow; mcpUrl: string }) {
  const steps = CONNECTOR_STEPS[app.id] ?? [];
  return (
    <section className="card card-pad stack-sm" aria-labelledby="connector-title" style={{ gap: 12 }}>
      <h2 id="connector-title" className="section-title" style={{ fontSize: 17 }}>Use Crewtavo in {app.name}</h2>
      <div className="row wrap" style={{ gap: 8 }}>
        <code className="code-pill grow">{mcpUrl}</code>
        <Button icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy</Button>
      </div>
      {steps.length > 0 && <ol className="app-steps">{steps.map((s) => <li key={s}>{s}</li>)}</ol>}
      <ConnectedAssistants />
      <AssistantAccess />
    </section>
  );
}

/** Apps that use a key (a company's own Anthropic key, for example). The key is never shown again. */
function KeyCard({ app, onSaved }: { app: AppRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const stripe = app.id === "stripe";
  const save = useMutation({
    meta: { inline: true, success: stripe ? "Stripe connected" : `${app.name} key saved` },
    mutationFn: () => api.put(`/apps/${app.id}/key`, { api_key: key.trim() }),
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
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="key-title" style={{ gap: 10 }}>
      <h2 id="key-title" className="section-title" style={{ fontSize: 17 }}>
        {app.id === "anthropic" ? "Your own Anthropic key (optional)" : stripe ? (app.stripe && !app.stripe.own ? "Use your own Stripe account" : "Stripe secret key") : `${app.name} key`}
      </h2>
      <span className="muted small">
        {app.id === "anthropic" ? "Crewtavo's writing help and answers from your guides use this key when you add one. " : null}
        {stripe ? "From Stripe: Developers, then API keys, then the secret key (it starts with sk_live_). Crewtavo adds the webhook it needs to your Stripe account. " : null}
        {app.status === "connected" && app.account_label && (!stripe || app.stripe?.own) ? `Saved: ${app.account_label}.` : "It's stored encrypted and never shown again."}
      </span>
      <form className="row" style={{ gap: 8 }} onSubmit={submit}>
        <div className="input-group grow">
          <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={(stripe ? app.stripe?.own : app.status === "connected") ? "Paste a new key to replace it" : stripe ? "sk_live_…" : "Paste your key"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label={`${app.name} ${stripe ? "secret key" : "API key"}`} style={{ paddingLeft: 12, paddingRight: 36 }} />
          <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={15} /></button>
        </div>
        <Button type="submit" loading={save.isPending} disabled={key.trim().length < 10}>{stripe ? "Connect" : "Save"}</Button>
      </form>
      {save.error && <span className="field-error">{(save.error as Error).message}</span>}
    </section>
  );
}
