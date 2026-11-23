/**
 * QuickBooks, Zoho Books, Google Business Profile and Facebook & Instagram with the business's own app
 * at Intuit, Zoho, Google or Meta: step by step to make one (every address it asks for, ready to
 * copy), then its Client ID and secret (Meta's App ID and secret) pasted here. Nobody has to set up
 * the server, and the keys stay on this business's own server, encrypted.
 */
import { GOOGLE_ACCESS_FORM } from "@crewtavo/core/reviews";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Fact, Facts, Section } from "@/components/ui/Section";
import { api, supabase, unwrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { AppRow } from "./catalog";
import { CodeRow, Fold, kit, Step, Steps } from "./PanelKit";
import { Select } from "@/components/ui/Select";

const INTUIT_DEVELOPER = "https://developer.intuit.com/";
const GOOGLE_CLOUD = "https://console.cloud.google.com/";
/** The three APIs Google Business Profile's reviews need turned on in the project. */
const GOOGLE_APIS = [
  { name: "My Business Account Management API", href: "https://console.cloud.google.com/apis/library/mybusinessaccountmanagement.googleapis.com" },
  { name: "My Business Business Information API", href: "https://console.cloud.google.com/apis/library/mybusinessbusinessinformation.googleapis.com" },
  { name: "Google My Business API", href: "https://console.cloud.google.com/apis/library/mybusiness.googleapis.com" },
];
export const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";
const META_DEVELOPERS = "https://developers.facebook.com/apps/";
/** The permissions to add for Facebook & Instagram, by the names Meta's dashboard gives them. */
export const META_PERMISSIONS = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"];

/** Zoho's data centers: an app made in one only signs in accounts there (registry.ts keeps the same list). */
const ZOHO_REGIONS = [
  { label: "United States", tld: "zoho.com" },
  { label: "Europe", tld: "zoho.eu" },
  { label: "United Kingdom", tld: "zoho.uk" },
  { label: "India", tld: "zoho.in" },
  { label: "Australia", tld: "zoho.com.au" },
  { label: "Japan", tld: "zoho.jp" },
  { label: "Canada", tld: "zohocloud.ca" },
  { label: "Saudi Arabia", tld: "zoho.sa" },
  { label: "China", tld: "zoho.com.cn" },
];
const accountsOf = (tld: string) => `https://accounts.${tld}`;
const regionOf = (accountsServer: string | null | undefined) => ZOHO_REGIONS.find((r) => accountsOf(r.tld) === accountsServer) ?? ZOHO_REGIONS[0]!;

/** One value to copy into the provider's form, with the name that form gives it: a quiet code row. */
export function CopyRow({ label, value }: { label: string; value: string }) {
  return <CodeRow label={label} value={value} />;
}

/**
 * `anchor` makes it the page's #app-setup; off when another card on the page already is (Google
 * Business Profile's Before you sign in, or its panel once installed).
 */
export function AppKeysCard({ app, onChanged, onConnect, connecting, anchor = true }: { app: AppRow; onChanged: () => void; onConnect: () => void; connecting: boolean; anchor?: boolean }) {
  const keys = app.app_keys ?? null;
  const setupId = anchor ? "app-setup" : undefined;
  const [editing, setEditing] = useState(false);
  const qbo = app.id === "quickbooks";
  const google = app.id === "google_business";
  const meta = app.id === "meta";
  const provider = qbo ? "Intuit" : google ? "Google" : meta ? "Meta" : "Zoho";
  const remove = useMutation({
    meta: { success: `${provider} app keys removed` },
    mutationFn: () => api.delete(`/apps/${app.id}/app-keys`),
    onSettled: onChanged,
  });
  const askRemove = async () => {
    const body = google
      ? `${app.name} is uninstalled, and installing it again uses this server's Google app, if it has one. The reviews already here stay.`
      : meta
        ? `${app.name} is uninstalled and signed out of your Page, and installing it again needs your Meta app's keys. Posts already made stay.`
        : `${app.name} is uninstalled, and installing it again needs your ${provider} app's keys. Nothing already synced is deleted.`;
    if (await confirm({ title: `Remove your ${provider} app keys?`, body, confirmLabel: "Remove keys", danger: true })) remove.mutate();
  };

  if (keys && !editing) {
    const end = keys.client_id.slice(-4);
    const more: MenuEntry[] = [
      { label: "Change keys", icon: "edit", kbd: "E", onSelect: () => setEditing(true) },
      { separator: true },
      { label: "Remove keys", icon: "trash", danger: true, disabled: remove.isPending, onSelect: askRemove },
    ];
    return (
      <Section id={setupId} title={`Your ${provider} app`} className={kit.panel} action={<Menu items={more} label={`Your ${provider} app keys`} title={`Your ${provider} app`} />}>
        {app.status === "disconnected" && (
          <div className="callout callout-info">
            <Icon name="info" size={16} />
            <div className={cx("grow", kit.calloutBody)}>
              <div>Last step: {google ? "sign in with Google and pick your location." : meta ? "sign in with Facebook as your Page's admin and pick your Page." : `sign in to ${app.name} and pick your company.`}</div>
              <div className={kit.actions}><Button size="sm" variant="primary" loading={connecting} onClick={onConnect}>{google ? "Sign in with Google" : meta ? "Sign in with Facebook" : `Sign in to ${app.name}`}</Button></div>
            </div>
          </div>
        )}
        <Facts label={`Your ${provider} app`}>
          <Fact label={meta ? "App ID" : "Client ID"}>Ending in <strong>{end}</strong></Fact>
          {qbo && <Fact label="Keys">{keys.sandbox ? "Development keys, for a sandbox company" : "Production keys"}</Fact>}
          {!qbo && !google && !meta && <Fact label="Zoho account">{regionOf(keys.accounts_server).label}</Fact>}
          {meta && keys.config_id && <Fact label="Sign-in">With a Facebook Login for Business configuration</Fact>}
          <Fact label="Secret">Stored encrypted on your server and never shown again</Fact>
        </Facts>
        {remove.isPending && <p className={kit.note} role="status">Removing your keys…</p>}
      </Section>
    );
  }

  return (
    <Section id={setupId} title={keys ? `Change your ${provider} app keys` : `Set up ${app.name}`} className={kit.panel}>
      <p className={kit.text}>
        {qbo
          ? "QuickBooks connects through an app you make at Intuit, for your business only. It's free, and these steps give you everything Intuit asks for."
          : google
            ? googleIntro(app)
            : meta
              ? "Facebook & Instagram connects through a Meta app you make for your business only. It's free, takes about ten minutes, and Meta doesn't need to review an app that only posts to your own Page."
              : "Zoho Books connects through an app you make in Zoho's API Console, for your business only. It's free and takes about five minutes."}
      </p>
      {qbo ? <IntuitSteps app={app} /> : google ? <GoogleSteps app={app} /> : meta ? <MetaSteps app={app} /> : null}
      <KeysForm app={app} initial={keys} onSaved={() => { setEditing(false); onChanged(); }} onCancel={keys ? () => setEditing(false) : undefined} />
    </Section>
  );
}

/**
 * Google Business Profile's own app: beside this server's when it has one (signed in with no keys of
 * the company's), otherwise the only way in, so it doesn't speak of a server's project there isn't.
 */
function googleIntro(app: AppRow): string {
  if (app.available && !app.app_keys) {
    return "Use your own Google Cloud project instead of this server's. It's free, but Google approves each project's access to reviews on its own, which takes about 2 weeks, even if this server's project is approved already.";
  }
  return "Google Business Profile connects through a Google Cloud project you make for your business. It's free, but Google approves each project's access to reviews first, which takes about 2 weeks.";
}

function IntuitSteps({ app }: { app: AppRow }) {
  const origin = app.redirect_uri ? new URL(app.redirect_uri).origin : window.location.origin;
  const page = `${origin}/apps/quickbooks`;
  return (
    <Steps>
      <Step>
        <span>Sign in to Intuit Developer with your Intuit account, then create an app for <strong>QuickBooks Online</strong>. Name it Crewtavo and give it the <strong>Accounting</strong> permission.</span>
        <a className="btn btn-sm" href={INTUIT_DEVELOPER} target="_blank" rel="noreferrer">Open Intuit Developer <Icon name="external" size={12} /></a>
      </Step>
      <Step>
        <span>In the app's <strong>production</strong> settings, fill in its details with these:</span>
        <CopyRow label="Host domain" value={new URL(origin).host} />
        <CopyRow label="Launch URL" value={page} />
        <CopyRow label="Disconnect URL" value={page} />
        <CopyRow label="Connect/Reconnect URL" value={page} />
        <CopyRow label="End-user license agreement URL" value={`${origin}/license`} />
        <span className={kit.note}>For <strong>Privacy policy URL</strong>, use your website's privacy page, or your website's address if it doesn't have one.</span>
      </Step>
      <Step>
        <span>Add this under <strong>Redirect URIs</strong> in the production settings:</span>
        {app.redirect_uri && <CopyRow label="Redirect URI" value={app.redirect_uri} />}
      </Step>
      <Step>Answer Intuit's <strong>app assessment questionnaire</strong>. Intuit asks it even of an app only your business uses, and your production keys unlock once it's reviewed, which can take a few days.</Step>
      <Step>Copy the production <strong>Client ID</strong> and <strong>Client Secret</strong> from <strong>Keys and credentials</strong>, and paste them below.</Step>
    </Steps>
  );
}

/** A Google Cloud project for the business's own Google app: Google's access request comes early, since it's the step that takes weeks. */
export function GoogleSteps({ app }: { app: AppRow }) {
  return (
    <Steps>
      <Step>
        <span>In Google Cloud, create a project for Crewtavo, signed in with a Google account that manages your Business Profile.</span>
        <a className="btn btn-sm" href={GOOGLE_CLOUD} target="_blank" rel="noreferrer">Open Google Cloud <Icon name="external" size={12} /></a>
      </Step>
      <Step>
        <span>
          Ask Google for access to the Business Profile APIs now: it takes about 2 weeks. Google's form asks for the project number (on the project's
          dashboard) and an email that manages your profile, which must have been verified for 60 days or more.
        </span>
        <a className="btn btn-sm" href={GOOGLE_ACCESS_FORM} target="_blank" rel="noreferrer">Google's access request form <Icon name="external" size={12} /></a>
      </Step>
      <Step>
        <span>Turn on these three APIs in the project:</span>
        <ul className={kit.bullets}>{GOOGLE_APIS.map((a) => <li key={a.name}><a href={a.href} target="_blank" rel="noreferrer">{a.name} <Icon name="external" size={12} /></a></li>)}</ul>
      </Step>
      <Step>
        <span>Under <strong>Google Auth Platform</strong>, set up the consent screen as <strong>External</strong>, add this scope under <strong>Data access</strong>, and publish the app so it says <strong>In production</strong>. An app left in Testing signs out after 7 days.</span>
        <CopyRow label="Scope" value={BUSINESS_SCOPE} />
        <span className={kit.note}>Google shows an "unverified app" screen at sign-in until it reviews the app. That's fine for your own business: click <strong>Advanced</strong>, then continue.</span>
      </Step>
      <Step>
        <span>Under <strong>Clients</strong>, create an OAuth client of type <strong>Web application</strong> with this redirect URI:</span>
        {app.redirect_uri && <CopyRow label="Authorized redirect URI" value={app.redirect_uri} />}
      </Step>
      <Step>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> Google shows, and paste them below.</Step>
    </Steps>
  );
}

/** The privacy page Meta asks for before an app goes Live: the business's own, on its website. */
export function usePrivacyUrl(): string | null {
  const session = useSession();
  const company = useQuery({
    queryKey: ["company-website", session.company.id],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("companies").select("website").eq("id", session.company.id).maybeSingle()),
  });
  const site = company.data?.website?.trim();
  if (!site) return null;
  const base = /^https?:\/\//i.test(site) ? site : `https://${site}`;
  return `${base.replace(/\/+$/, "")}/privacy`;
}

/** The privacy page line: the website's /privacy with Copy, or what to do with no website on file. */
export function PrivacyLine() {
  const url = usePrivacyUrl();
  return url ? (
    <div className={kit.step}>
      <CopyRow label="Privacy policy URL" value={url} />
      <span className={kit.note}>Use your own privacy page if it's somewhere else. It has to load, and say how to ask for data to be deleted.</span>
    </div>
  ) : (
    <span className={kit.note}>Add a privacy page to your website first, saying how to ask for data to be deleted. Meta checks that it loads.</span>
  );
}

/**
 * A Meta app for the business's own Page, in about ten minutes: made with the use case for managing
 * a Page, Facebook Login for Business added, this server's redirect address pasted, the permissions
 * added, its keys pasted below, then signed in and switched to Live (until it's Live, only people
 * with a role on the app see its posts). Meta's dashboard changes its wording now and then: the steps
 * name its fields as it shows them in October 2026.
 */
export function MetaSteps({ app }: { app: AppRow }) {
  return (
    <Steps>
      <Step>
        <span><strong>Before you start:</strong> Meta asks for a privacy page before your app can go Live.</span>
        <PrivacyLine />
      </Step>
      <Step>
        <span>At Meta for Developers, signed in as your Page's admin, click <strong>Create app</strong>. Name it after your business, pick the use case for managing everything on your Page, and choose your business portfolio, or none.</span>
        <a className="btn btn-sm" href={META_DEVELOPERS} target="_blank" rel="noreferrer">Open Meta for Developers <Icon name="external" size={12} /></a>
      </Step>
      <Step>Add the <strong>Facebook Login for Business</strong> product, if the app doesn't have it.</Step>
      <Step>
        <span>Under <strong>Facebook Login for Business → Settings</strong>, paste this under <strong>Valid OAuth Redirect URIs</strong> and save. Leave <strong>Strict mode</strong> on.</span>
        {app.redirect_uri && <CopyRow label="Valid OAuth Redirect URI" value={app.redirect_uri} />}
      </Step>
      <Step>
        <span>In the use case's <strong>Permissions</strong>, click <strong>Add</strong> for each of these. If Instagram's two aren't offered there, add the Instagram use case too, and add them from it.</span>
        <ul className={kit.bullets}>{META_PERMISSIONS.map((p) => <li key={p}><strong>{p}</strong></li>)}</ul>
      </Step>
      <Step>Under <strong>App settings → Basic</strong>, copy the <strong>App ID</strong> and the <strong>App secret</strong> (click <strong>Show</strong>), and paste them below. Fill in the <strong>Privacy policy URL</strong> and the <strong>User data deletion</strong> instructions URL there too, with the same privacy page.</Step>
      <Step>Save the keys, then sign in with Facebook and pick your Page and its Instagram account.</Step>
      <Step>Switch the app to <strong>Live</strong> with the <strong>App mode</strong> switch at the top of the dashboard. Until it's Live, only you can see the posts. Meta's API can't tell Crewtavo when it's Live, so tick the box once you've switched it.</Step>
    </Steps>
  );
}

function KeysForm({ app, initial, onSaved, onCancel }: { app: AppRow; initial: NonNullable<AppRow["app_keys"]> | null; onSaved: () => void; onCancel?: () => void }) {
  const qbo = app.id === "quickbooks";
  const zohoBooks = app.id === "zoho_books";
  const meta = app.id === "meta";
  const [clientId, setClientId] = useState(initial?.client_id ?? "");
  const [configId, setConfigId] = useState(initial?.config_id ?? "");
  const [secret, setSecret] = useState("");
  const [show, setShow] = useState(false);
  const [sandbox, setSandbox] = useState(initial?.sandbox ?? false);
  const [region, setRegion] = useState(regionOf(initial?.accounts_server).tld);
  const zoho = ZOHO_REGIONS.find((r) => r.tld === region)!;
  const origin = app.redirect_uri ? new URL(app.redirect_uri).origin : window.location.origin;
  const save = useMutation({
    meta: { inline: true, success: `${qbo ? "Intuit" : zohoBooks ? "Zoho" : meta ? "Meta" : "Google"} app keys saved` },
    mutationFn: () => api.put(`/apps/${app.id}/app-keys`, { client_id: clientId.trim(), client_secret: secret.trim(), ...(qbo ? { sandbox } : zohoBooks ? { accounts_server: accountsOf(region) } : meta ? { config_id: configId.trim() } : {}) }),
    onSuccess: () => {
      setSecret("");
      onSaved();
    },
  });
  const ready = clientId.trim().length >= 8 && secret.trim().length >= 8;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    // Tokens belong to the app that issued them, so new keys sign out of the old app.
    if (app.status !== "disconnected" && !(await confirm({ title: `Use these keys instead?`, body: meta ? `${app.name} signs out, and you sign in again with the new app, pick your Page and switch the new app to Live. Posts already made stay.` : `${app.name} signs out, and you sign in again with the new app. Nothing already synced is deleted.`, confirmLabel: "Use new keys" }))) return;
    save.mutate();
  };

  return (
    <form className={kit.form} onSubmit={submit}>
      {zohoBooks && (
        <Steps>
          <Step>
            <span>Pick where your Zoho account is. When you're in Zoho Books, the address shows it: <strong>books.zoho.eu</strong> is Europe.</span>
            <Select className="select" style={{ maxWidth: 280 }} value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Where your Zoho account is">
              {ZOHO_REGIONS.map((r) => <option key={r.tld} value={r.tld}>{r.label} (books.{r.tld})</option>)}
            </Select>
          </Step>
          <Step>
            <span>Open Zoho's API Console, click <strong>Add Client</strong> (or <strong>Get Started</strong>) and choose <strong>Server-based Applications</strong>.</span>
            <a className="btn btn-sm" href={`https://api-console.${zoho.tld}/`} target="_blank" rel="noreferrer">Open Zoho API Console <Icon name="external" size={12} /></a>
          </Step>
          <Step>
            <span>Fill it in with these, then click <strong>Create</strong>:</span>
            <CopyRow label="Client Name" value="Crewtavo" />
            <CopyRow label="Homepage URL" value={origin} />
            {app.redirect_uri && <CopyRow label="Authorized Redirect URIs" value={app.redirect_uri} />}
          </Step>
          <Step>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> Zoho shows, and paste them below.</Step>
        </Steps>
      )}
      <div className={kit.fields}>
        <Field label={meta ? "App ID" : "Client ID"}>
          <input className="input" autoComplete="off" spellCheck={false} inputMode={meta ? "numeric" : undefined} value={clientId} onChange={(e) => { setClientId(e.target.value); save.reset(); }} />
        </Field>
        <Field label={meta ? "App secret" : "Client Secret"} hint={initial ? `Paste the secret again, even if only the ${meta ? "App ID" : "Client ID"} changed.` : undefined}>
          <div className="input-group">
            <input className="input" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={secret} onChange={(e) => { setSecret(e.target.value); save.reset(); }} style={{ paddingLeft: 12, paddingRight: 36 }} />
            <button type="button" className="icon-btn addon-right" style={{ position: "absolute", right: 2, pointerEvents: "auto" }} aria-label={show ? "Hide secret" : "Show secret"} onClick={() => setShow(!show)}><Icon name={show ? "eye" : "lock"} size={14} /></button>
          </div>
        </Field>
      </div>
      {qbo && (
        <label className="checkbox">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
          <span>
            These are development keys
            <span className={kit.hint} style={{ display: "block" }}>They work right away, but only with a QuickBooks sandbox company, so they're for trying it out. Add the Redirect URI to the development settings too.</span>
          </span>
        </label>
      )}
      {meta && (
        <Fold summary="More options" open={Boolean(initial?.config_id)}>
          <Field label="Configuration ID" optional hint="Only if you made a Facebook Login for Business configuration. Leave it empty and Crewtavo asks for the permissions itself.">
            <input className="input" autoComplete="off" spellCheck={false} inputMode="numeric" value={configId} onChange={(e) => { setConfigId(e.target.value); save.reset(); }} />
          </Field>
        </Fold>
      )}
      <FormError error={save.error} />
      <div className={kit.actions}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>Save keys</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
