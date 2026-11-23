/**
 * One app's page, a record page in the directory's language (App-Directory.dc.html, Page-Client):
 * the crumb back to Apps, the app's icon beside its name, what it does in a quiet line, and a quiet
 * line of facts (installed or not, who makes it). Before it's installed: Install, the one green
 * button (on a phone, the floating pill), then screenshots, what it does and about it, with the facts
 * and what Crewtavo can see and do in it on the side. Install turns it on or signs in right away, or
 * opens its setup (a key, a calendar link) at the top of the page. Once it's installed: Open, and a
 * More menu with the setup guide and Uninstall (danger, last); managing it (calendars, sign-in, keys)
 * comes first, as flat sections.
 *
 * Claude and ChatGPT here are what powers Crewtavo's own AI (a key, or for ChatGPT a person's own
 * plan). Using Crewtavo from inside either chat app is the connector, which is added and managed in
 * Settings → AI assistants: their pages only point there.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { DetailColumns } from "@/components/ui/DetailPage";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { BackLink, Crumb, useDocumentTitle } from "@/components/ui/PageHeader";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { StatusPill, type Tone } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { useDriveSwitch } from "../drive/useDriveSwitch";
import { useMarketingSwitch } from "../marketing/useMarketingSwitch";
import { CalendarFeedCard } from "../settings/CalendarFeedCard";
import { AbcSupplyPanel } from "./AbcSupplyPanel";
import { AiServiceChoice, OpenAiModelCard } from "./AiPanels";
import { AnalyticsPanel, useAnalyticsSwitch } from "./AnalyticsPanel";
import { AppCard, AppIcon, shortName } from "./AppIcon";
import { AppKeysCard } from "./AppKeysCard";
import { ChatGptPlanCard, TeamPlansSwitch, useChatGptPlan } from "./ChatGptPlan";
import { CalendarList, GoogleCalendarPanel, LinkCalendarsPanel, AddCalendarForm, useCalendars, type CalendarSource } from "./CalendarPanels";
import { categoryName, infoFor, isFullSecretKey, LINK_ACCESS, MORE_LABELS, PASSWORD_HINT, STRIPE_NEW_KEY, useApps, usesMarketing, type AiState, type AppInfo, type AppRow } from "./catalog";
import { DrivePanel } from "./DrivePanel";
import { GoogleBeforeSignIn, GoogleBusinessPanel } from "./GoogleBusinessPanel";
import { InstallRing, type InstallPhase } from "./InstallRing";
import { useIsInstalled } from "./installed";
import { LobPanel } from "./LobPanel";
import { MarketingPanel } from "./MarketingPanel";
import { MetaPanel } from "./MetaPanel";
import { Fold, Step, Steps, kit } from "./PanelKit";
import { SCREENSHOTS, type Screenshot } from "./screenshots";
import { StripePanel } from "./StripePanel";
import { TeamChatPanel, useTeamChatSwitch } from "./TeamChatPanel";
import { TwilioPanel } from "./TwilioPanel";
import { useTradeAppSwitch } from "./tradeApps";
import { WebsiteFormsPanel, useWebsiteFormsSwitch } from "./WebsiteFormsPanel";
import { WebsitePanel } from "./WebsitePanel";

const GOOGLE_SETTINGS = "https://calendar.google.com/calendar/r/settings";
// OpenAI: where a key is made, and where its credit is added.
const OPENAI_KEYS = "https://platform.openai.com/api-keys";
const OPENAI_BILLING = "https://platform.openai.com/settings/organization/billing";
// fal.ai: where a key is made, and where credit is added.
const FAL_KEYS = "https://fal.ai/dashboard/keys";
const FAL_BILLING = "https://fal.ai/dashboard/billing";
const GOOGLE_SIGNIN_GUIDE = "https://crewtavo.com/docs/connections/google-calendar/#instant-updates-with-google-sign-in";

/** Google Calendar on a server without Google sign-in: it works by secret address, like the link apps. */
const byLinkOnly = (app: AppRow) => app.id === "google_calendar" && !app.available;

/**
 * QuickBooks and Zoho Books sign in with the business's own app at Intuit or Zoho. Install shows its
 * keys first when the server has no app of its own, or when the business saved some (to change them).
 */
const keysFirst = (app: AppRow) => Boolean(app.takes_app_keys && (!app.available || app.app_keys));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


function statusOf(app: AppRow, installed: boolean): { label: string; tone: Tone } {
  if (app.status === "error" || app.calendar_errors) return { label: "Needs attention", tone: "danger" };
  // Google Business Profile waits on Google's approval, and on Marketing being installed.
  if (installed && app.google_business) {
    if (!app.google_business.marketing_on) return { label: "Paused", tone: "warning" };
    if (app.google_business.problem === "approval" || app.google_business.problem === "not_enabled") return { label: "Waiting on Google", tone: "warning" };
    if (app.google_business.problem === "location" || app.google_business.problem === "pick") return { label: "Needs attention", tone: "warning" };
    // Google erring: Crewtavo tries again by itself, but nothing is coming in meanwhile.
    if (app.google_business.problem === "error") return { label: "Not syncing", tone: "warning" };
  }
  // Facebook & Instagram posts from Marketing → Social, and only to the public once the Meta app is Live.
  if (installed && app.meta) {
    if (!app.meta.marketing_on) return { label: "Paused", tone: "warning" };
    if (app.meta.problem === "pick" || app.meta.problem === "permissions" || app.meta.needs_business_permissions) return { label: "Needs attention", tone: "warning" };
    if (!app.meta.live_confirmed_at) return { label: "Not Live yet", tone: "warning" };
  }
  if (installed) return app.calendars ? { label: plural(app.calendars, "calendar"), tone: "good" } : { label: "Installed", tone: "good" };
  if (!app.available && !byLinkOnly(app) && !app.takes_app_keys) return { label: "Not available yet", tone: "muted" };
  return { label: "Not installed", tone: "muted" };
}

/** Signed in or a key added: what /apps/:id/disconnect takes away. Stripe or Twilio set up for the server isn't the company's to remove. */
const hasAccount = (app: AppRow) =>
  (app.auth === "oauth" || app.auth === "api_key") && app.status !== "disconnected" && !(app.id === "stripe" && !app.stripe?.own) && !(app.id === "twilio" && !app.twilio?.own);

/** Where Open goes: a page in Crewtavo, or the app itself. */
const openTarget = (app: AppRow, info: AppInfo) => (app.id === "stripe" && !app.stripe?.own ? "/payouts" : (info.open ?? info.website));

export function AppDetailPage() {
  const { id = "" } = useParams();
  const apps = useApps();
  const app = apps.data?.apps.find((a) => a.id === id);
  useDocumentTitle(app ? shortName(app) : "Apps");

  if (!apps.allowed) return <NoAccess title="Apps" />;
  if (apps.error) return <><BackLink to="/apps">Apps</BackLink><ErrorState error={apps.error} onRetry={() => apps.refetch()} /></>;
  if (apps.isPending) return <DetailSkeleton />;
  if (!app) {
    return (
      <>
        <BackLink to="/apps">Apps</BackLink>
        <EmptyState icon="apps" title="That app isn't here" action={<Link className="btn" to="/apps">See all apps</Link>}>It may have been renamed or removed.</EmptyState>
      </>
    );
  }
  return <AppListing key={app.id} app={app} all={apps.data!.apps} ai={apps.data!.ai} />;
}

function AppListing({ app, all, ai }: { app: AppRow; all: AppRow[]; ai: AiState | undefined }) {
  const info = infoFor(app);
  const session = useSession();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { isInstalled } = useIsInstalled();
  const installed = isInstalled(app);
  const calendars = useCalendars(app.category === "Calendar");
  // Install pressed: installing right away ("working"), or waiting on the setup below for a key or a
  // calendar link ("waiting"); then the ring fills ("done") and Uninstall shows.
  // Back from signing in to it: the ring finishes filling there too.
  const [phase, setPhase] = useState<InstallPhase | null>(() => (params.get("status") === "connected" ? "done" : null));
  const started = useRef(0);
  const setup = phase === "waiting";
  const refresh = () => {
    for (const key of ["apps", "calendars", "google-calendars"]) queryClient.invalidateQueries({ queryKey: [key] });
    // The company's own Anthropic or OpenAI key (or the person's ChatGPT plan) turns on Ask and the other AI buttons, a fal.ai key
    // Find paving on the measuring map, its Twilio account texting (lib/session.tsx), and the
    // website's editor puts Website in the menu.
    if (app.id === "anthropic" || app.id === "chatgpt" || app.id === "fal" || app.id === "twilio" || app.auth === "site") session.refresh();
  };
  const connect = useMutation({
    mutationFn: () => api.post<{ authorization_url: string }>(`/apps/${app.id}/connect`),
    onSuccess: (res) => window.location.assign(res.authorization_url), // the provider sends the person back to this page
  });
  const chatSwitch = useTeamChatSwitch();
  const analyticsSwitch = useAnalyticsSwitch();
  const formsSwitch = useWebsiteFormsSwitch();
  const careersSwitch = useWebsiteFormsSwitch("careers");
  const driveSwitch = useDriveSwitch();
  const marketingSwitch = useMarketingSwitch();
  const tradeSwitch = useTradeAppSwitch(app.id === "roofing" || app.id === "snow" ? app.id : "paving");
  // Built-in apps turn on and off in the company's settings.
  const builtinSwitch =
    app.id === "website_analytics" ? analyticsSwitch
    : app.id === "website_forms" ? formsSwitch
    : app.id === "careers" ? careersSwitch
    : app.id === "drive" ? driveSwitch
    : app.id === "marketing" ? marketingSwitch
    : app.id === "paving" || app.id === "roofing" || app.id === "snow" ? tradeSwitch
    : chatSwitch;

  // Uninstall takes this app's own calendars with it.
  const sources = (calendars.data?.calendars ?? []).filter((s) => s.app === app.id);
  // ChatGPT: the person's own plan, and whether the whole team may connect theirs, go with Uninstall too.
  const plan = useChatGptPlan(app.id === "chatgpt");
  // Stripe decides where clients' payments go: uninstalling it asks for the person's password.
  const [askPassword, setAskPassword] = useState(false);
  const uninstall = useMutation({
    meta: { success: `${app.name} uninstalled`, inline: askPassword },
    mutationFn: async (options: { remove_reviews?: boolean; password?: string } = {}) => {
      // Google's own calendars go with its sign-in; the ones added by address are removed here.
      if (hasAccount(app)) {
        const res = await api.post<{ revoked?: boolean }>(`/apps/${app.id}/disconnect`, options);
        // The other Google app signs in the same way, and Google would sign it out too.
        if (res?.revoked === false) toast.info(`Your Google sign-in stays, since ${app.id === "google_business" ? "Google Calendar" : "Google Business Profile"} uses it too. Remove Crewtavo in your Google account's security settings to end both.`);
      }
      if (app.id === "chatgpt") {
        if (app.team_plans || plan.data?.team_plans) await api.put("/ai/team-plans", { on: false });
        if (app.my_plan) await api.post("/ai/chatgpt/disconnect", {});
      }
      if (app.auth === "site") await api.delete(`/apps/${app.id}/site`);
      await Promise.all(sources.filter((s) => s.kind !== "google").map((s) => api.delete(`/calendars/${s.id}`)));
    },
    onSuccess: () => {
      setPhase(null);
      setAskPassword(false);
    },
    onSettled: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["chatgpt-plan"] });
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
    },
  });
  const canUninstall = installed && (app.auth === "builtin" || app.auth === "site" || hasAccount(app) || Boolean(app.my_plan) || Boolean(app.team_plans) || sources.length > 0);

  const askUninstall = async () => {
    if (app.auth === "builtin") return builtinSwitch.turnOff();
    if (app.id === "stripe" && hasAccount(app)) return setAskPassword(true);
    if (app.id === "google_business") {
      const choice = { remove: false };
      const body = <UninstallReviews count={app.google_business?.review_count ?? 0} onChange={(remove) => (choice.remove = remove)} />;
      if (await confirm({ title: `Uninstall ${app.name}?`, body, confirmLabel: "Uninstall", danger: true })) uninstall.mutate({ remove_reviews: choice.remove });
      return;
    }
    const body = uninstallBody(app, { calendars: sources.length, teamPlans: app.team_plans || plan.data?.team_plans });
    if (await confirm({ title: `Uninstall ${app.name}?`, body, confirmLabel: "Uninstall", danger: true })) uninstall.mutate({});
  };

  const install = () => {
    started.current = Date.now();
    const failed = { onError: () => setPhase(null) };
    if (app.auth === "builtin") {
      setPhase("working");
      return builtinSwitch.toggle.mutate(true, failed);
    }
    // Signing in is the setup; Google also offers adding a calendar by its address instead. Google
    // Business Profile has steps to take before signing in, Google's access request first.
    if (app.auth === "oauth" && app.available && app.id !== "google_calendar" && app.id !== "google_business" && !keysFirst(app)) {
      setPhase("working");
      return connect.mutate(undefined, failed);
    }
    setPhase("waiting");
  };
  useEffect(() => {
    if (setup) document.getElementById("app-install")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [setup]);
  // Installed: the ring fills, held long enough to be seen when installing was quick, then Uninstall.
  useEffect(() => {
    if (phase === "done") {
      const finish = setTimeout(() => setPhase(null), 650);
      return () => clearTimeout(finish);
    }
    if (!phase) return;
    if (installed) {
      const fill = setTimeout(() => setPhase("done"), Math.max(0, started.current + 900 - Date.now()));
      return () => clearTimeout(fill);
    }
    // Installing that never shows up as installed (the page couldn't refresh) gives Install back.
    if (phase === "working") {
      const giveUp = setTimeout(() => setPhase(null), 20_000);
      return () => clearTimeout(giveUp);
    }
  }, [phase, installed]);

  const status = statusOf(app, installed);
  const callback = params.get("status") ? { ok: params.get("status") === "connected", message: params.get("message"), pending: params.get("pending") } : null;
  const unavailable = !app.available && !byLinkOnly(app) && !app.takes_app_keys;
  // Google Business Profile's reviews show in Marketing, and Facebook & Instagram posts from it, so Marketing is installed first.
  const needsMarketing = (app.id === "google_business" || app.id === "meta") && !installed && !featureOn(session.company.settings, "marketing");
  const needsReconnect = app.auth === "oauth" && app.status === "error" && app.available;
  // The business's own app keys are saved but it isn't signed in yet: their card shows, with the sign-in.
  const keysSaved = keysFirst(app) && Boolean(app.app_keys);
  const open = openTarget(app, info);
  // Google Business Profile opens Marketing → Reviews, which isn't there while Marketing is off.
  const opens = !(app.id === "google_business" && app.google_business?.marketing_on === false);
  // Facebook & Instagram opens Marketing → Social, which isn't there while Marketing is off either.
  const metaOpens = !(app.id === "meta" && app.meta?.marketing_on === false);
  // These three open Marketing, which an admin who connects apps without the marketing area can't
  // open: no Open, rather than one that leads to "no access".
  const marketingOpens = !OPENS_MARKETING.has(app.id) || usesMarketing(session);

  // The buttons next to the name: Install (the page's one green button; a phone's floating pill),
  // which turns into its progress ring like an app store's; once it's installed, Open (or Reconnect
  // when it needs it), with Uninstall last in the More menu.
  const removing = uninstall.isPending || (installed && builtinSwitch.toggle.isPending);
  let actions: ReactNode;
  if (phase) {
    actions = <InstallRing phase={phase} name={app.name} onStop={() => setPhase(null)} />;
  } else if (removing) {
    actions = <Button loading>Uninstalling</Button>;
  } else if (installed) {
    actions = needsReconnect ? (
      <Button variant="primary" icon="refresh" loading={connect.isPending} onClick={() => connect.mutate()}>Reconnect</Button>
    ) : !opens || !metaOpens || !marketingOpens ? null : open.startsWith("/") ? (
      <Link className="btn" to={open}><Icon name="arrowRight" size={16} />Open</Link>
    ) : (
      <a className="btn" href={open} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Open</a>
    );
  } else if (unavailable || needsMarketing) {
    actions = <Button className="app-install" disabled>Install</Button>;
  } else {
    actions = <Button className="app-install" variant="primary" icon="plus" onClick={install}>Install</Button>;
  }
  const more: MenuEntry[] = [
    { label: "Setup guide", icon: "book", end: "↗", onSelect: () => window.open(app.docs, "_blank", "noopener,noreferrer") },
    { separator: true },
    { label: "Uninstall", icon: "trash", danger: true, onSelect: askUninstall, hidden: !canUninstall },
  ];
  const showMore = installed && !phase && !removing;

  const others = all.filter((a) => a.category === app.category && a.id !== app.id);
  const googleSources = sources.filter((s) => s.app === "google_calendar" && s.kind !== "google");
  const access = byLinkOnly(app) ? LINK_ACCESS : info.access;
  const connectsWith = byLinkOnly(app) ? "Secret address (ICS)" : info.connectsWith;
  const shots = SCREENSHOTS[app.id] ?? [];
  const name = shortName(app);
  const callbackGood = callback?.ok && !signedInNotReady(callback.pending, app);

  // Google, signed in or not: adding a calendar by its secret address instead.
  const googleByAddress = (
    <Fold summary="Or add a calendar by its secret address" open={googleSources.length > 0 || undefined}>
      <p className={kit.note}>Works without signing in, and only shows that calendar on your schedule. For visits in Google without signing in, use <Link to="/settings?tab=calendars">Settings → Calendars</Link>.</p>
      {googleSources.length > 0 && <CalendarList sources={googleSources} />}
      <span id="google_calendar-add" />
      <AddCalendarForm app="google_calendar" appName="Google" steps={info.steps} addOnPaste />
    </Fold>
  );
  const googleSignIn = (
    <Section className={kit.panel} title="Sign in with Google">
      <p className={kit.note}>Pick which of your calendars show on the schedule, and put visits on a Google calendar that stays up to date.</p>
      <Button variant="primary" loading={connect.isPending} onClick={() => connect.mutate()}>Sign in with Google</Button>
    </Section>
  );

  return (
    <>
      {askPassword && (
        <UninstallWithPassword
          app={app}
          busy={uninstall.isPending}
          error={uninstall.error}
          onUninstall={(password) => uninstall.mutate({ password })}
          onClose={() => {
            setAskPassword(false);
            uninstall.reset();
          }}
        />
      )}

      <header className="page-header app-head">
        <div className="app-head-crumb"><Crumb to="/apps">Apps</Crumb></div>
        <AppIcon id={app.id} name={app.name} size="xl" />
        <h1 className="page-title">{name}</h1>
        {(actions || showMore) && (
          <div className="page-actions">
            {actions}
            {showMore && <Menu items={more} title={name} />}
          </div>
        )}
        <p className="page-lede">{info.tagline}</p>
        {/* The App Store's row of facts under the name: each a quiet label over its value, between hairlines. */}
        <dl className="app-stats">
          {!phase && <div><dt>Status</dt><dd><StatusPill label={status.label} tone={status.tone} /></dd></div>}
          <div><dt>Made by</dt><dd>{info.developer}</dd></div>
          {app.category !== "Team" && <div><dt>Category</dt><dd>{categoryName(app.category)}</dd></div>}
          {installed && ((app.id === "stripe" && !app.stripe?.own) || (app.id === "twilio" && !app.twilio?.own)) && <div><dt>Account</dt><dd>Set up for this server</dd></div>}
        </dl>
      </header>

      {/* Not installed yet: what it looks like comes first, as an app store shows it. */}
      {!installed && shots.length > 0 && <Screenshots shots={shots} />}

      {info.beta && (
        <div className="callout callout-info" role="note">
          <Icon name="info" size={16} />
          <div className="grow"><div>Beta</div>{info.beta}</div>
        </div>
      )}

      {callback && (
        <div className={`callout ${callbackGood ? "callout-good" : "callout-warning"}`} role={callback.ok ? "status" : "alert"}>
          <Icon name={callbackGood ? "check" : "alert"} size={16} />
          <div className="grow">
            <div>{callback.ok ? (signedInNotReady(callback.pending, app) ? signedInWaiting(callback.pending) : `${app.name} is installed.`) : (callback.message ?? `${app.name} couldn't be installed. Try again.`)}</div>
            {callbackGood && (
              app.id === "google_calendar" ? "Now pick the calendars to show on your schedule."
                : app.id === "google_business" ? googleBusinessNext(callback.pending, app)
                : app.id === "meta" ? metaNext(callback.pending)
                : app.category === "Accounting" ? "New invoices and payments will sync automatically." : null
            )}
          </div>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setParams({}, { replace: true })}><Icon name="x" size={16} /></button>
        </div>
      )}

      {/* ---- Installing it ---- */}
      {/* Installing Drive on Railway makes its bucket first, and says what to do when it can't. */}
      {app.id === "drive" && driveSwitch.toggle.error && (
        <div className="callout callout-warning" role="alert">
          <Icon name="alert" size={16} />
          <div className="grow"><div>{driveSwitch.toggle.error.message}</div><Link to="/settings?tab=hosting">Settings → Hosting</Link></div>
        </div>
      )}
      {!installed && unavailable && <NotAvailable app={app} />}
      {needsMarketing && !unavailable && (
        <div className="callout callout-info" role="note">
          <Icon name="info" size={16} />
          <div className="grow">{app.id === "meta" ? "Install Marketing - Crewtavo first: your posts are made in Marketing → Social." : "Install Marketing - Crewtavo first: your Google reviews show in Marketing → Reviews."} <Link to="/apps/marketing">Marketing - Crewtavo</Link></div>
        </div>
      )}

      <DetailColumns
        grouped
        className="app-cols"
        side={
          <>
            <Section title="Information">
              <Facts>
                <Fact label="Made by">{info.developer}</Fact>
                {/* The built-in apps' category is Crewtavo itself, which Made by already says. */}
                <Fact label="Category">{app.category !== "Team" && categoryName(app.category)}</Fact>
                <Fact label="Connects with">{connectsWith}</Fact>
                {access.length > 0 && (
                  <Fact label="Crewtavo can" wide>
                    <ul className="app-access">{access.map((a) => <li key={a}>{a}</li>)}</ul>
                  </Fact>
                )}
                <Fact label="Who can change it">Owners and admins of {session.company.name}</Fact>
                <Fact label="Website"><a href={info.website} target="_blank" rel="noreferrer">{new URL(info.website).hostname.replace(/^www\./, "")} <Icon name="external" size={12} /></a></Fact>
                <Fact label="Help"><a href={app.docs} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a></Fact>
              </Facts>
            </Section>
          </>
        }
      >
        {!installed && (setup || keysSaved) && !unavailable && (
          <div id="app-install" className="app-panels">
            {byLinkOnly(app) ? (
              <GoogleBySecretAddress app={app} sources={googleSources} />
            ) : keysFirst(app) ? (
              <AppKeysCard app={app} onChanged={refresh} onConnect={() => connect.mutate()} connecting={connect.isPending} />
            ) : app.id === "google_business" ? (
              <>
                <GoogleBeforeSignIn app={app} onConnect={() => connect.mutate()} connecting={connect.isPending} />
                <Fold summary="Or use your own Google app">
                  <AppKeysCard app={app} onChanged={refresh} onConnect={() => connect.mutate()} connecting={connect.isPending} anchor={false} />
                </Fold>
              </>
            ) : app.id === "google_calendar" ? (
              <>{googleSignIn}{googleByAddress}</>
            ) : app.auth === "link" ? (
              <LinkCalendarsPanel app={app.id} appName={app.name} steps={info.steps} />
            ) : app.auth === "site" ? (
              <WebsitePanel app={app} onSaved={refresh} />
            ) : app.id === "abc_supply" ? (
              <AbcSupplyPanel app={app} onChanged={refresh} />
            ) : app.id === "twilio" ? (
              <TwilioPanel app={app} onChanged={refresh} />
            ) : app.id === "lob" ? (
              <LobPanel app={app} onChanged={refresh} />
            ) : app.id === "chatgpt" ? (
              <>
                <KeyCard app={app} onSaved={refresh} />
                <ChatGptPlanCard where="app" />
                <TeamPlansSwitch />
              </>
            ) : (
              <KeyCard app={app} onSaved={refresh} />
            )}
          </div>
        )}

        {/* ---- Managing it ---- */}
        {installed && (
          <>
            {byLinkOnly(app) && <GoogleBySecretAddress app={app} sources={googleSources} />}
            {app.auth === "oauth" && app.available && app.id !== "google_business" && app.id !== "meta" && (app.status === "disconnected" ? app.id === "google_calendar" && googleSignIn : <AccountCard app={app} onChanged={refresh} />)}
            {app.id === "meta" && <MetaPanel app={app} onChanged={refresh} />}
            {app.id === "google_business" && <GoogleBusinessPanel app={app} onChanged={refresh} onReconnect={() => connect.mutate()} reconnecting={connect.isPending} />}
            {/* Google Business Profile's and Facebook & Instagram's own panels are the page's setup anchor. */}
            {app.app_keys && <AppKeysCard app={app} onChanged={refresh} onConnect={() => connect.mutate()} connecting={connect.isPending} anchor={app.id !== "google_business" && app.id !== "meta"} />}
            {app.id === "google_calendar" && app.status === "connected" && <GoogleCalendarPanel />}
            {app.id === "google_calendar" && app.available && googleByAddress}
            {app.auth === "link" && <LinkCalendarsPanel app={app.id} appName={app.name} steps={info.steps} />}
            {(app.id === "anthropic" || app.id === "chatgpt") && <AiServiceChoice ai={ai} onChanged={refresh} />}
            {app.id === "stripe" && app.stripe && <StripePanel app={app} onChanged={refresh} />}
            {app.auth === "api_key" && app.id !== "abc_supply" && app.id !== "twilio" && app.id !== "lob" && <KeyCard app={app} onSaved={refresh} />}
            {app.id === "chatgpt" && app.status !== "disconnected" && <OpenAiModelCard app={app} onChanged={refresh} />}
            {app.id === "chatgpt" && <ChatGptPlanCard where="app" />}
            {app.id === "chatgpt" && <TeamPlansSwitch />}
            {app.id === "lob" && <LobPanel app={app} onChanged={refresh} />}
            {app.id === "abc_supply" && <AbcSupplyPanel app={app} onChanged={refresh} />}
            {app.id === "twilio" && <TwilioPanel app={app} onChanged={refresh} />}
            {app.id === "website_analytics" && <AnalyticsPanel />}
            {app.id === "website_forms" && <WebsiteFormsPanel />}
            {app.id === "careers" && <WebsiteFormsPanel kind="careers" />}
            {app.id === "drive" && <DrivePanel />}
            {app.id === "marketing" && <MarketingPanel />}
            {app.id === "team_chat" && <TeamChatPanel />}
            {app.auth === "site" && <WebsitePanel app={app} onSaved={refresh} />}
          </>
        )}

        {/* Using Crewtavo from inside the chat app is the connector, which lives in Settings. */}
        {AI_CHAT_APPS.has(app.id) && (
          <div className="callout callout-info" role="note">
            <Icon name="info" size={16} />
            <div className="grow">
              <div>Using Crewtavo from inside {app.name}</div>
              Add the connector in <Link to="/settings?tab=assistants" style={{ textDecoration: "underline" }}>Settings → AI assistants</Link>.
            </div>
          </div>
        )}

        {installed && shots.length > 0 && <Screenshots shots={shots} />}

        {/* ---- What it does ---- */}
        {info.highlights.length > 0 && (
          <Section title="What it does">
            <ul className="app-highlights">
              {info.highlights.map((h) => (
                <li key={h.title} className="app-highlight">
                  <Icon name={h.icon} size={18} />
                  <strong>{h.title}</strong>
                  <span>{h.text}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="About">
          <p className="app-about">{info.about}</p>
        </Section>
      </DetailColumns>

      {/* "You might also like": the rest of its category, as the directory's cards. */}
      {others.length > 0 && (
        <section className="app-shelf app-more" aria-labelledby="app-more-title">
          <div className="app-shelf-head">
            <h2 id="app-more-title">{MORE_LABELS[app.category] ?? "More apps"}</h2>
            <Link className="link-btn" to={`/apps?cat=${encodeURIComponent(app.category)}`}>See all</Link>
          </div>
          <ul className="app-grid">{others.slice(0, 6).map((a) => <li key={a.id}><AppCard app={a} installed={isInstalled(a)} /></li>)}</ul>
        </section>
      )}
    </>
  );
}

/** Screenshots, side by side like an app store's, in the app's light and dark looks, scrolling sideways when there are more. */
function Screenshots({ shots }: { shots: Screenshot[] }) {
  return (
    <section aria-label="Screenshots" className="app-shots">
      {shots.map((shot) => (
        <figure key={shot.light}>
          {/* The caption says what each shows, for everyone, so the pictures themselves are left unnamed. */}
          <img className="app-shot-light" src={shot.light} alt="" loading="lazy" />
          <img className="app-shot-dark" src={shot.dark} alt="" loading="lazy" />
          <figcaption>{shot.alt}</figcaption>
        </figure>
      ))}
    </section>
  );
}

/** The two chat apps that can also use Crewtavo over its connector (Settings → AI assistants). */
const AI_CHAT_APPS = new Set(["anthropic", "chatgpt"]);

/** The apps whose Open goes to Marketing. */
const OPENS_MARKETING = new Set(["marketing", "google_business", "meta"]);

/**
 * Back from signing in to Google Business Profile: a location to pick next, reviews on their way, or
 * (installed, and waiting on Google's approval) when they start. The callout below says what to do
 * about the wait, so this doesn't say it again.
 */
export function googleBusinessNext(pending: string | null, app: Pick<AppRow, "google_business">): string {
  // What the sign-in came back with, while it's still so: a location picked since, or Google letting
  // Crewtavo in on Check again, moves on to what's next.
  const now = app.google_business;
  const still = (problem: string) => !now || now.problem === problem;
  if (pending === "pick" && (still("pick") || !now?.location)) return "Now pick your business's location.";
  if (pending === "approval" && still("approval")) return "Reviews start coming in once Google approves access.";
  if (pending === "not_enabled" && still("not_enabled")) return "Reviews start coming in once the Business Profile APIs are turned on.";
  return now?.marketing_on === false ? "Your reviews come in once Marketing is installed again." : "Your reviews are on their way to Marketing → Reviews.";
}

/** Back from signing in to Facebook & Instagram: the Page to pick next, permissions to allow, or the last step, going Live. */
function metaNext(pending: string | null): string {
  if (pending === "pick") return "Now pick your Page below.";
  if (pending === "permissions") return "Some permissions weren't allowed. See below for which.";
  return "Last step: switch your Meta app to Live, below.";
}

/**
 * Back from signing in while something's in the way, so it isn't installed in full yet: for Google
 * Business Profile, what the page doesn't explain below (a location problem, Google erring, or a
 * Google account that manages no Business Profile); for Facebook & Instagram, a Facebook account
 * that manages no Page.
 */
const signedInNotReady = (pending: string | null, app: AppRow) =>
  app.id === "meta" ? pending === "no_pages"
  : pending === "location" || pending === "error" || (pending === "pick" && app.google_business?.problem_detail === "none");

function signedInWaiting(pending: string | null): string {
  if (pending === "no_pages") return "Signed in, but that Facebook account doesn't manage a Page. Sign in again with your Page's admin below.";
  if (pending === "pick") return "Signed in, but that Google account doesn't manage a Business Profile. Sign in with the one that does below.";
  // The location's problem itself is said in the panel below.
  if (pending === "location") return "Signed in, but something about the location needs looking at first.";
  return "Signed in. Google didn't answer, so Crewtavo tries again soon.";
}

/** Uninstalling Google Business Profile: its reviews stay (for as long as a copy that isn't syncing is kept), unless this is ticked. */
function UninstallReviews({ count, onChange }: { count: number; onChange: (remove: boolean) => void }) {
  const [remove, setRemove] = useState(false);
  return (
    <div className="stack-sm">
      <p style={{ margin: 0 }}>Reviews stop coming in, and replies can't be posted from Crewtavo. Your reviews on Google aren't changed. You can install it again any time.</p>
      {count > 0 && (
        <label className="checkbox">
          <input type="checkbox" checked={remove} onChange={(e) => { setRemove(e.target.checked); onChange(e.target.checked); }} />
          <span>Also remove the {count.toLocaleString("en-US")} {count === 1 ? "review" : "reviews"} brought in (asks start again for clients they matched)</span>
        </label>
      )}
      {count > 0 && !remove && <p className="muted small" style={{ margin: 0 }}>Kept, they show in Marketing → Reviews for up to 30 days more, and their clients still aren't asked again.</p>}
    </div>
  );
}

/** What Uninstall takes away, in the words of each kind of app. */
function uninstallBody(app: AppRow, counts: { calendars: number; teamPlans?: boolean }): string {
  const again = "You can install it again any time.";
  if (app.id === "google_calendar") {
    const visits = app.status !== "disconnected" ? " The visits calendar Crewtavo made is removed from your Google account." : "";
    return `Its calendars come off the schedule.${visits} Your own Google calendars aren't changed. ${again}`;
  }
  if (app.auth === "link") return `${counts.calendars === 1 ? "Its calendar comes" : `Its ${counts.calendars} calendars come`} off the schedule. The calendars themselves aren't changed. ${again}`;
  if (app.id === "stripe") return `Crewtavo's webhook comes out of your Stripe account, and new invoices and payments stop showing up here. Nothing already recorded is deleted. ${again}`;
  if (app.category === "Accounting") {
    const keys = app.app_keys ? ` Your ${app.id === "quickbooks" ? "Intuit" : "Zoho"} app's keys stay, so installing it again is one sign-in.` : "";
    return `Syncing stops right away. Nothing already synced is deleted.${keys} ${again}`;
  }
  if (app.id === "meta") {
    const n = app.meta?.scheduled_posts ?? 0;
    const waiting = n ? ` ${n === 1 ? "1 scheduled post won't" : `${n} scheduled posts won't`} go to Facebook or Instagram. Use Post again once you've connected again.` : "";
    return `Posts stop going to your Page and Instagram, and Crewtavo's access to them is removed at Meta.${waiting} Posts already made stay, and your app's keys stay, so installing it again is one sign-in.`;
  }
  if (app.id === "abc_supply") return `Estimates stop getting prices from ABC, and your ABC app's keys are removed from Crewtavo. The materials in your price list and the prices already on estimates stay. ${again}`;
  if (app.id === "lob") return `Postcard campaigns stop, including any being mailed now, and your Lob key is removed from Crewtavo. Cards Lob already made are still mailed. ${again}`;
  if (app.id === "fal") return `Find paving stops working, and your fal.ai key is removed from Crewtavo. Shapes it already found stay on your drawings. ${again}`;
  if (app.category === "AI") {
    const parts = [];
    if (hasAccount(app)) parts.push(`Your ${app.id === "chatgpt" ? "OpenAI" : "Anthropic"} key is removed, so Crewtavo's AI stops using it.`);
    if (app.my_plan) parts.push("Your own ChatGPT plan is signed out.");
    if (counts.teamPlans) parts.push("Everyone else's ChatGPT plan is disconnected too.");
    // The connector is a different thing, and stays.
    if (AI_CHAT_APPS.has(app.id)) parts.push(`Assistants connected in Settings → AI assistants keep working.`);
    return `${parts.join(" ")} ${again}`;
  }
  if (app.id === "twilio") return `Texts stop going out from your number, and your Twilio account's keys are removed from Crewtavo. Nothing already sent is deleted, and your Twilio account isn't changed. ${again}`;
  if (app.auth === "site") return `Website comes out of the menu. Your website, its editor and everything on it stay as they are. ${again}`;
  return `Crewtavo stops using it right away. Nothing already here is deleted. ${again}`;
}

/** Uninstall's question for Stripe, with the person's password; it's cleared once sent, and a wrong one says so here. */
function UninstallWithPassword({ app, busy, error, onUninstall, onClose }: { app: AppRow; busy: boolean; error: unknown; onUninstall: (password: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  return (
    <Dialog open onClose={onClose} title={`Uninstall ${app.name}?`} size="sm">
      <form
        className="stack-sm"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          onUninstall(password);
          setPassword("");
        }}
      >
        <div className="muted" style={{ marginTop: -6 }}>{uninstallBody(app, { calendars: 0 })}</div>
        <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" maxLength={200} required autoFocus />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger-solid" loading={busy}>Uninstall</Button>
        </div>
      </form>
    </Dialog>
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
      <Section className={kit.panel} id="google-setup" title="1. Show your Google Calendar on the schedule">
        <p className={kit.note}>About a minute, on a computer: Google's phone app doesn't show this address.</p>
        <Steps>
          <Step>
            <a className="btn btn-sm" href={GOOGLE_SETTINGS} target="_blank" rel="noreferrer">Open Google Calendar settings <Icon name="external" size={12} /></a>
          </Step>
          <Step>On the left, under <strong>Settings for my calendars</strong>, click your calendar.</Step>
          <Step>Scroll down to <strong>Integrate calendar</strong> and copy the <strong>Secret address in iCal format</strong>.</Step>
          <Step>Paste it here. It's added as soon as you paste.</Step>
        </Steps>
        {sources.length > 0 && <CalendarList sources={sources} />}
        <span id="google_calendar-add" />
        <AddCalendarForm app="google_calendar" appName="Google" addOnPaste />
        <p className={kit.note}>Each calendar has its own address: repeat this for the others you want to see. Have a calendar file instead? <Link to="/settings?tab=calendars">Upload it in Settings</Link>.</p>
      </Section>
      <CalendarFeedCard title="2. Show your visits in Google Calendar" />
      <Fold summary="Instant updates with Google sign-in">
        <p className={kit.note}>
          Whoever runs your Crewtavo server can turn on Google sign-in. Then you pick calendars from your account instead of pasting addresses, and visits reach Google within
          minutes instead of whenever Google next checks. It takes a Google Cloud project, so most businesses don't need it.
        </p>
        <a href={GOOGLE_SIGNIN_GUIDE} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
        {app.redirect_uri && <span className={kit.note}>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
      </Fold>
    </>
  );
}

/** The provider account a sign-in app is connected to. */
function AccountCard({ app, onChanged }: { app: AppRow; onChanged: () => void }) {
  // QuickBooks and Zoho Books: what couldn't be sent goes again, once it's fixed in the books.
  const retry = useMutation({
    mutationFn: () => api.post<{ queued: number }>(`/apps/${app.id}/retry`),
    onSuccess: (res) => {
      if (res.queued) toast.success(res.queued === 1 ? "Trying 1 change again" : `Trying ${res.queued} changes again`);
      else toast.info("Nothing is waiting to be tried again.");
      onChanged();
    },
  });
  if (app.status === "disconnected") return null;
  const broken = app.status === "error";
  return (
    <Section title="Account">
      {app.last_error || broken ? (
        <div className={`callout ${broken ? "callout-danger" : "callout-warning"}`} role="alert">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>{broken ? `${app.name} needs to be reconnected` : app.last_error}</div>
            {broken ? app.last_error : null}
          </div>
          {app.last_error && app.status === "connected" && app.category === "Accounting" && (
            <Button size="sm" icon="refresh" loading={retry.isPending} onClick={() => retry.mutate()}>Try again</Button>
          )}
        </div>
      ) : null}
      <Facts>
        <Fact label="Account">{broken ? null : (app.account_label ?? "Connected")}</Fact>
        <Fact label="Last synced">{app.last_sync_at && !broken ? timeAgo(app.last_sync_at) : null}</Fact>
      </Facts>
    </Section>
  );
}

function NotAvailable({ app }: { app: AppRow }) {
  return (
    <section className="callout callout-info" aria-label="Not available yet">
      <Icon name="info" size={16} />
      <div className="grow">
        <div>Not available yet</div>
        Ask whoever set up Crewtavo to turn on {app.name}.
        <Fold summary="Setup details">
          <a href={app.docs} target="_blank" rel="noreferrer">Setup guide <Icon name="external" size={12} /></a>
          {app.redirect_uri && <span>Redirect address: <button type="button" className="link-btn small" onClick={() => copyText(app.redirect_uri!, "Copied")}>{app.redirect_uri}</button></span>}
        </Fold>
      </div>
    </section>
  );
}

/** Apps that use a key (a company's own Anthropic or OpenAI key, for example). The key is never shown again. */
export function KeyCard({ app, onSaved }: { app: AppRow; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const stripe = app.id === "stripe";
  // Stripe decides where clients' payments go: changing its key asks for the person's password too.
  const [password, setPassword] = useState("");
  const save = useMutation({
    meta: { inline: true, success: stripe ? "Stripe connected" : app.id === "chatgpt" ? "OpenAI key saved" : `${app.name} key saved` },
    mutationFn: () => api.put(`/apps/${app.id}/key`, stripe ? { api_key: key.trim(), password } : { api_key: key.trim() }),
    onSuccess: () => {
      setKey("");
      onSaved();
    },
    onSettled: () => setPassword(""),
  });
  const ready = key.trim().length >= 10 && (!stripe || password.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) save.mutate();
  };
  const saveButton = <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready} style={stripe ? { justifySelf: "start" } : undefined}>{stripe ? "Connect" : "Save"}</Button>;
  // Until the company's own Stripe key is in: how to get one from the form Stripe fills in.
  const stripeSteps = stripe && !app.stripe?.own;
  const fal = app.id === "fal";
  const falSteps = fal && app.status !== "connected";
  const openai = app.id === "chatgpt";
  const openaiSteps = openai && app.status !== "connected";
  // What happens to the key (and, for Stripe, its webhook): above the form, or under Connect while Stripe's setup waits on one.
  const note = (
    <p className={kit.note}>
      {app.id === "anthropic" ? "Crewtavo's writing help, answers from your guides and receipt reading use this key when you add one. " : null}
      {openai && !openaiSteps ? <>Crewtavo's writing help, answers from your guides and receipt reading use this key. <a href={OPENAI_BILLING} target="_blank" rel="noreferrer">Check your OpenAI credit</a>. </> : null}
      {fal && !falSteps ? <>Find paving is on the measuring map, next to the takeoff items. <a href={FAL_BILLING} target="_blank" rel="noreferrer">Check your fal.ai credit</a>. </> : null}
      {stripe ? "Crewtavo adds the webhook it needs to your Stripe account. " : null}
      {app.status === "connected" && app.account_label && (!stripe || app.stripe?.own) ? `Saved: ${app.account_label}.` : "It's stored encrypted and never shown again."}
      {stripe && app.stripe?.own ? <> To switch keys, <a href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">get a new one from Stripe</a>.</> : null}
    </p>
  );
  return (
    <Section className={kit.panel}
      id="app-setup"
      title={app.id === "anthropic" ? "Anthropic API key" : openai ? (openaiSteps ? "Use an OpenAI API key" : "OpenAI key") : stripe ? (app.stripe?.own ? "Stripe key" : app.stripe ? "Use your own Stripe account" : "Connect your Stripe account") : fal ? (falSteps ? "Connect your fal.ai account" : "fal.ai key") : `${app.name} key`}
    >
      {stripeSteps && (
        <>
          {/* The way to Stripe in the step it belongs to, quiet; Connect, which finishes it, is the green button. */}
          <Steps>
            <Step>
              <span>Open Stripe and sign in. The key comes set up for Crewtavo, so leave its settings as they are.</span>
              <a className="btn btn-sm" href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Get a key from Stripe</a>
            </Step>
            <Step>At the bottom of Stripe's page, click <strong>Create key</strong> and enter the code Stripe sends.</Step>
            <Step>Copy the key and paste it below.</Step>
          </Steps>
        </>
      )}
      {falSteps && (
        <>
          <p className={kit.note}>About two minutes. fal.ai bills you directly: Find paving costs about half a cent for each thing it looks for, so $5 of credit covers hundreds of lots.</p>
          <Steps>
            <Step>
              <span>Open fal.ai and sign in with Google or GitHub (or make an account).</span>
              <a className="btn btn-sm" href={FAL_KEYS} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Get a key from fal.ai</a>
            </Step>
            <Step>Click <strong>Create Key</strong>, name it Crewtavo, keep the <strong>API</strong> scope, and copy the key. fal.ai only shows it once.</Step>
            <Step>Add a few dollars of credit under <a href={FAL_BILLING} target="_blank" rel="noreferrer">Billing</a>.</Step>
            <Step>Paste the key below. Crewtavo checks it with fal.ai before saving, at no cost.</Step>
          </Steps>
        </>
      )}
      {openaiSteps && (
        <>
          <p className={kit.note}>For the whole company: everyone's drafts, answers from your guides and receipts use this key, and so does anything Crewtavo drafts by itself. OpenAI bills you directly for what's used.</p>
          <Steps>
            <Step>
              <span>Open OpenAI's API platform and sign in (it's separate from a ChatGPT plan).</span>
              <a className="btn btn-sm" href={OPENAI_KEYS} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Get a key from OpenAI</a>
            </Step>
            <Step>Click <strong>Create new secret key</strong>, name it Crewtavo, and copy the key. OpenAI only shows it once.</Step>
            <Step>Add credit under <a href={OPENAI_BILLING} target="_blank" rel="noreferrer">Billing</a> if the account has none.</Step>
            <Step>Paste the key below. Crewtavo checks it with OpenAI before saving, at no cost.</Step>
          </Steps>
        </>
      )}
      {!stripeSteps && note}
      <form className="stack-sm" onSubmit={submit}>
        <div className="row" style={{ gap: 8 }}>
          <div className="input-group grow">
            <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} placeholder={(stripe ? app.stripe?.own : app.status === "connected") ? "Paste a new key to replace it" : stripe ? "Paste the key from Stripe" : "Paste your key"} value={key} onChange={(e) => { setKey(e.target.value); save.reset(); }} aria-label={stripe ? "Key from Stripe" : openai ? "OpenAI API key" : `${app.name} API key`} style={{ paddingLeft: 12, paddingRight: 36 }} />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
          {!stripe && saveButton}
        </div>
        {stripe && isFullSecretKey(key) && (
          <span className="muted small">That's your full secret key, which can do anything in your Stripe account, including payouts. A restricted key can't: <a href={STRIPE_NEW_KEY} target="_blank" rel="noreferrer">get one from Stripe</a>.</span>
        )}
        {stripe && (
          <>
            <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
              <input className="input" type="password" value={password} onChange={(e) => { setPassword(e.target.value); save.reset(); }} autoComplete="current-password" maxLength={200} />
            </Field>
            {/* Owners hear about Stripe changes by email too, once the company's email or the server's is set up. */}
            {app.owners_emailed === false && (
              <span className="muted small">Owners won't be emailed about Stripe key changes until <Link to="/settings?tab=email">email is set up</Link>. They still see them on the bell.</span>
            )}
            {saveButton}
          </>
        )}
      </form>
      {save.error && <span className="field-error">{(save.error as Error).message}</span>}
      {stripeSteps && note}
    </Section>
  );
}
