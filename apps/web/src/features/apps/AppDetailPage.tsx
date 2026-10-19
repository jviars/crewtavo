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
import { CalendarFeedCard } from "../settings/CalendarFeedCard";
import { AppIcon, AppTile } from "./AppIcon";
import { AssistantAccess, ConnectedAssistants } from "./AssistantAccess";
import { CalendarRow, GoogleCalendarPanel, LinkCalendarsPanel, AddCalendarForm, useCalendars, type CalendarSource } from "./CalendarPanels";
import { CATEGORY_LABELS, infoFor, LINK_ACCESS, MORE_LABELS, useApps, type AppRow } from "./catalog";
import { StripePanel } from "./StripePanel";

const GOOGLE_SETTINGS = "https://calendar.google.com/calendar/r/settings";
const GOOGLE_SIGNIN_GUIDE = "https://crewtavo.com/docs/connections/google-calendar/#instant-updates-with-google-sign-in";

/**
 * What Crewtavo's Stripe key may do: add its webhook, customers and invoices (with their items),
 * and read payments, fees, deposits and the account's name. Stripe's create-key form sets these
 * from its link (each name is a row there; balance transactions come under Balance). Stripe doesn't
 * document that, so if it stops, people still land on the form.
 */
const STRIPE_KEY_PERMISSIONS = ["webhook_write", "customer_write", "invoice_write", "charge_read", "balance_read", "balance_transaction_source_read", "payout_read", "connected_account_read"];
const STRIPE_NEW_KEY = `https://dashboard.stripe.com/apikeys/create?name=Crewtavo&${STRIPE_KEY_PERMISSIONS.map((p) => `permissions%5B%5D=rak_${p}`).join("&")}`;

/** Where each assistant keeps its connector settings. */
const CONNECTOR_STEPS: Record<string, string[]> = {
  anthropic: ["In Claude, open Settings, then Connectors.", "Choose Add custom connector and paste the link above.", "Sign in with your Crewtavo account when Claude asks."],
  chatgpt: ["In ChatGPT, open Settings, then Apps and connectors.", "With developer mode on, add a connector and paste the link above.", "Sign in with your Crewtavo account when ChatGPT asks."],
};

/** Google Calendar on a server without Google sign-in: it works by secret address, like the link apps. */
const byLinkOnly = (app: AppRow) => app.id === "google_calendar" && !app.available;

function statusOf(app: AppRow): { label: string; tone: Tone } {
  if (!app.available && !byLinkOnly(app)) return { label: "Not available yet", tone: "muted" };
  if (app.status === "error" || app.calendar_errors) return { label: "Needs attention", tone: "danger" };
  if (app.auth === "link" || byLinkOnly(app)) return app.calendars ? { label: `${app.calendars} ${app.calendars === 1 ? "calendar" : "calendars"}`, tone: "good" } : { label: "Not added", tone: "muted" };
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
  if (byLinkOnly(app)) action = <Button className="app-get" variant="primary" icon="plus" onClick={() => scrollTo("google-setup")}>{app.calendars ? "Add another" : "Set up"}</Button>;
  else if (!app.available) action = <Button className="app-get" disabled>Not available</Button>;
  else if (app.auth === "oauth") {
    action = app.status === "connected"
      ? <Button className="app-get" loading={disconnect.isPending} onClick={askDisconnect}>Disconnect</Button>
      : <Button className="app-get" variant="primary" icon={app.status === "error" ? "refresh" : undefined} loading={connect.isPending} onClick={() => connect.mutate()}>{app.status === "error" ? "Reconnect" : "Connect"}</Button>;
  } else if (app.auth === "link") action = <Button className="app-get" variant="primary" icon="plus" onClick={() => scrollTo(`${app.id}-add`)}>{app.calendars ? "Add another" : "Add a calendar"}</Button>;
  else if (app.auth === "connector" || app.id === "anthropic") action = <Button className="app-get" variant="primary" icon="copy" onClick={() => copyText(mcpUrl, "Connector link copied")}>Copy link</Button>;
  else if (app.id === "stripe") action = <Button className="app-get" variant={app.stripe?.own ? "secondary" : "primary"} onClick={() => scrollTo("app-setup")}>{app.stripe?.own ? "Replace key" : "Connect"}</Button>;
  else action = <Button className="app-get" variant={app.status === "connected" ? "secondary" : "primary"} onClick={() => scrollTo("app-setup")}>{app.status === "connected" ? "Replace key" : "Add key"}</Button>;

  const others = all.filter((a) => a.category === app.category && a.id !== app.id);
  const googleSources = (calendars.data?.calendars ?? []).filter((s) => s.app === "google_calendar" && s.kind !== "google");
  const access = byLinkOnly(app) ? LINK_ACCESS : info.access;
  const connectsWith = byLinkOnly(app) ? "Secret address (ICS)" : info.connectsWith;

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
        {connectsWith && <div><dt>Connects with</dt><dd>{connectsWith}</dd></div>}
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
      {byLinkOnly(app) && <GoogleBySecretAddress app={app} sources={googleSources} />}
      {!app.available && app.auth === "oauth" && !byLinkOnly(app) && <NotAvailable app={app} />}
      {app.auth === "oauth" && app.available && <AccountCard app={app} />}
      {app.id === "google_calendar" && app.status === "connected" && <GoogleCalendarPanel />}
      {app.id === "google_calendar" && app.available && (
        <details className="card card-pad app-details" open={googleSources.length > 0 || undefined}>
          <summary>Or add a calendar by its secret address</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <span className="muted small">Works without signing in, and only shows that calendar on your schedule. For visits in Google without signing in, use <Link to="/settings?tab=calendars">Settings → Calendars</Link>.</span>
            {googleSources.map((s) => <CalendarRow key={s.id} source={s} />)}
            <span id="google_calendar-add" />
            <AddCalendarForm app="google_calendar" appName="Google" steps={info.steps} addOnPaste />
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
          {connectsWith && <div><dt>Connects with</dt><dd>{connectsWith}</dd></div>}
          {access.length > 0 && (
            <div>
              <dt>Crewtavo can</dt>
              <dd><ul className="app-access">{access.map((a) => <li key={a}>{a}</li>)}</ul></dd>
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

/**
 * Google Calendar with nothing to set up: its secret address brings a calendar onto the schedule,
 * and the subscribe link puts visits on Google Calendar. Google sign-in (instant, but a Google
 * Cloud project for whoever runs the server) stays as a footnote.
 */
function GoogleBySecretAddress({ app, sources }: { app: AppRow; sources: CalendarSource[] }) {
  return (
    <>
      <section id="google-setup" className="card card-pad stack" aria-labelledby="google-in">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 id="google-in" className="section-title" style={{ fontSize: 17 }}>1. Show your Google Calendar on the schedule</h2>
          <span className="muted small">About a minute, on a computer: Google's phone app doesn't show this address.</span>
        </div>
        <ol className="app-steps">
          <li>
            <a className="btn btn-sm" href={GOOGLE_SETTINGS} target="_blank" rel="noreferrer">Open Google Calendar settings <Icon name="external" size={12} /></a>
          </li>
          <li>On the left, under <strong>Settings for my calendars</strong>, click your calendar.</li>
          <li>Scroll down to <strong>Integrate calendar</strong> and copy the <strong>Secret address in iCal format</strong>.</li>
          <li>Paste it here. It's added as soon as you paste.</li>
        </ol>
        {sources.map((s) => <CalendarRow key={s.id} source={s} />)}
        <span id="google_calendar-add" />
        <AddCalendarForm app="google_calendar" appName="Google" addOnPaste />
        <span className="muted small">Each calendar has its own address: repeat this for the others you want to see. Have a calendar file instead? <Link to="/settings?tab=calendars">Upload it in Settings</Link>.</span>
      </section>
      <CalendarFeedCard title="2. Show your visits in Google Calendar" />
      <details className="card card-pad app-details">
        <summary>Instant updates with Google sign-in</summary>
        <div className="stack-sm small" style={{ marginTop: 10 }}>
          <span>
            Whoever runs your Crewtavo server can turn on Google sign-in. Then you pick calendars from your account instead of pasting addresses, and visits reach Google within
            minutes instead of whenever Google next checks. It takes a Google Cloud project, so most businesses don't need it.
          </span>
          <a href={GOOGLE_SIGNIN_GUIDE} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
          {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
        </div>
      </details>
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
  // Until the company's own Stripe key is in: how to get one from the form Stripe fills in.
  const stripeSteps = stripe && !app.stripe?.own;
  return (
    <section id="app-setup" className="card card-pad stack-sm" aria-labelledby="key-title" style={{ gap: 10 }}>
      <h2 id="key-title" className="section-title" style={{ fontSize: 17 }}>
        {app.id === "anthropic" ? "Your own Anthropic key (optional)" : stripe ? (app.stripe?.own ? "Stripe key" : app.stripe ? "Use your own Stripe account" : "Connect your Stripe account") : `${app.name} key`}
      </h2>
      {stripeSteps && (
        <>
          <ol className="app-steps">
            <li>Click <strong>Get a key from Stripe</strong> and sign in if Stripe asks. A new key named Crewtavo opens with what it needs already set, so leave the list as it is (most of it stays at None).</li>
            <li>Scroll to the bottom of Stripe's page, click <strong>Create key</strong> and enter the code Stripe sends you.</li>
            <li>Copy the key Stripe shows you, then paste it below.</li>
          </ol>
          <a className="btn btn-primary" style={{ justifySelf: "start" }} href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">
            <Icon name="external" size={16} />
            Get a key from Stripe
          </a>
        </>
      )}
      <span className="muted small">
        {app.id === "anthropic" ? "Crewtavo's writing help and answers from your guides use this key when you add one. " : null}
        {stripe ? "Crewtavo adds the webhook it needs to your Stripe account. " : null}
        {app.status === "connected" && app.account_label && (!stripe || app.stripe?.own) ? `Saved: ${app.account_label}.` : "It's stored encrypted and never shown again."}
        {stripe && app.stripe?.own ? <> To switch keys, <a href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">get a new one from Stripe</a>.</> : null}
      </span>
      <form className="row" style={{ gap: 8 }} onSubmit={submit}>
        <div className="input-group grow">
          <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={(stripe ? app.stripe?.own : app.status === "connected") ? "Paste a new key to replace it" : stripe ? "Paste the key from Stripe" : "Paste your key"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label={stripe ? "Key from Stripe" : `${app.name} API key`} style={{ paddingLeft: 12, paddingRight: 36 }} />
          <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={15} /></button>
        </div>
        <Button type="submit" loading={save.isPending} disabled={key.trim().length < 10}>{stripe ? "Connect" : "Save"}</Button>
      </form>
      {save.error && <span className="field-error">{(save.error as Error).message}</span>}
    </section>
  );
}
