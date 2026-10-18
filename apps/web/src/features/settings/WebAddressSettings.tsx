/**
 * Settings → Web address: move Crewtavo from its Railway address (something.up.railway.app) to the
 * business's own, like app.greenlawn.com. The owner picks an address and adds the records it needs
 * where their domain is managed; Crewtavo checks them as they go in. With Railway access (Log in
 * with Railway, or a project token) Crewtavo adds the address on Railway and switches over by
 * itself; otherwise the last step is setting APP_URL by hand. GET /api/address says where it stands.
 */
import { addressUrl, normalizeDomain, type AddressChange, type AddressCheck, type AddressOverview, type DnsProvider, type DnsRecordCheck } from "@crewtavo/core/address";
import { cloudflareTokenUrl, fillStep, GENERIC_DNS_PROVIDER, providerById } from "@crewtavo/core/dns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import styles from "./WebAddressSettings.module.css";

const KEY = ["web-address"];

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const recordsIn = (change: AddressChange) => change.records.length > 0 && change.records.every((r) => r.status === "ok");
/** The DNS host, when Crewtavo could tell who it is. */
const knownProvider = (id: string | null): DnsProvider | null => {
  const provider = providerById(id);
  return provider.id !== GENERIC_DNS_PROVIDER.id ? provider : null;
};

export function WebAddressSettings() {
  const overview = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<AddressOverview>("/address"),
    staleTime: 5_000,
    // While records go in and Crewtavo switches over, keep checking so the page moves on by itself.
    refetchInterval: (query) => (["waiting", "switching"].includes(query.state.data?.change?.status ?? "") ? 15_000 : false),
    // Crewtavo restarts while it switches over; a missed check isn't worth a toast.
    meta: { silent: true },
  });
  const [choosing, setChoosing] = useState(false);
  useRailwayReturn();

  if (overview.isPending) return <CardSkeleton lines={4} />;
  if (!overview.data) return <div className="card"><ErrorState error={overview.error} onRetry={() => overview.refetch()} /></div>;
  const data = overview.data;
  const { change } = data;
  const settled = !change || change.status === "done";

  let body: ReactNode;
  if (choosing && settled) body = <ChooseAddress overview={data} onDone={() => setChoosing(false)} />;
  else if (!change || (change.status === "done" && normalizeDomain(data.current ?? "") !== change.domain)) body = <CurrentAddress overview={data} onChange={() => setChoosing(true)} />;
  else if (change.status === "done") body = <Done overview={data} change={change} onChange={() => setChoosing(true)} />;
  else if (change.status === "switching") body = <Switching change={change} />;
  else if (change.status === "failed") body = <Failed overview={data} change={change} />;
  else body = <Waiting overview={data} change={change} checking={overview.isFetching} onCheck={() => overview.refetch()} />;
  return <div className={`stack ${styles.page}`}>{body}</div>;
}

const RETURNS: Record<string, string> = {
  expired: "The Railway sign-in expired. Try again.",
  cancelled: "Railway sign-in was cancelled.",
  error: "Railway couldn't be connected. The reason is below.",
};

/** Back from Railway's consent screen (?railway=connected, expired, cancelled or error): say how it went, then tidy the address bar. */
function useRailwayReturn() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const result = params.get("railway");
  useEffect(() => {
    if (!result) return;
    if (result === "connected") toast.success("Connected to Railway", { description: "Crewtavo is adding your address there now." });
    else toast.error(RETURNS[result] ?? RETURNS.error!);
    queryClient.invalidateQueries({ queryKey: KEY });
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("railway");
        return next;
      },
      { replace: true },
    );
  }, [result, setParams, queryClient]);
}

/** An action that answers with the overview: the screen moves on to it. */
function useAddressAction<V = void>(action: (variables: V) => Promise<AddressOverview>, meta: { inline?: boolean; success?: string } = {}) {
  const queryClient = useQueryClient();
  return useMutation({ meta, mutationFn: action, onSuccess: (next) => queryClient.setQueryData(KEY, next) });
}

function CurrentAddress({ overview, onChange }: { overview: AddressOverview; onChange: () => void }) {
  const host = normalizeDomain(overview.current ?? "");
  const own = Boolean(host && !/(^|\.)railway\.app$/.test(host));
  return (
    <>
      <section className="card card-pad stack">
        <div className="stack-sm">
          <strong style={{ fontSize: 16 }}>Crewtavo's web address</strong>
          {overview.current ? <a className={styles.address} href={overview.current} target="_blank" rel="noreferrer">{bare(overview.current)}</a> : <span className="muted">Not set yet</span>}
          <span className="muted">It's the address in every link Crewtavo sends: invites, quotes, invoices and the client hub.{own ? "" : " On your own domain, those links look like your business."}</span>
        </div>
        <div className="row wrap">
          <Button variant="primary" icon="globe" onClick={onChange}>{own ? "Use a different address" : "Use your own address"}</Button>
        </div>
      </section>
      <RailwayAccess overview={overview} />
    </>
  );
}

function ChooseAddress({ overview, onDone }: { overview: AddressOverview; onDone: () => void }) {
  const queryClient = useQueryClient();
  const currentDomain = normalizeDomain(overview.current ?? "");
  const [text, setText] = useState(overview.suggestion && overview.suggestion !== currentDomain ? overview.suggestion : "");
  // Check as they type, once they pause.
  const [settledText, setSettledText] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettledText(text), 500);
    return () => clearTimeout(timer);
  }, [text]);
  const domain = normalizeDomain(text);
  const settled = normalizeDomain(settledText);
  const typing = settledText !== text;
  const check = useQuery({
    queryKey: ["web-address-check", settled],
    queryFn: () => api.post<AddressCheck>("/address/check", { domain: settled }),
    enabled: Boolean(settled) && settled !== currentDomain,
    staleTime: 60_000,
    retry: false,
    meta: { silent: true },
  });
  const result = settled === domain ? check.data : undefined;
  const problem =
    domain && domain === currentDomain ? "That's already Crewtavo's address."
    : !typing && text.trim() && !domain ? "That doesn't look like a web address. Type it like app.yourbusiness.com."
    : result?.problem ?? null;
  const provider = knownProvider(result?.provider ?? null);
  const start = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<AddressOverview>("/address/start", { domain }),
    onSuccess: (next) => {
      queryClient.setQueryData(KEY, next);
      onDone();
    },
  });

  return (
    <form className="card card-pad stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (domain && !problem) start.mutate(); }}>
      <div className="stack-sm">
        <strong style={{ fontSize: 16 }}>Choose your address</strong>
        <span className="muted">Use a domain your business owns. To finish, you'll sign in where that domain is managed, usually where you bought it.</span>
      </div>
      <Field label="Address" hint="Most businesses put app. in front of the domain they already have, so their website keeps working." error={problem}>
        <input
          className="input"
          value={text}
          onChange={(e) => { setText(e.target.value); start.reset(); }}
          placeholder="app.yourbusiness.com"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          maxLength={300}
        />
      </Field>
      {domain && !problem && (
        <div className="stack-sm">
          {domain !== text.trim().toLowerCase() && <span className="muted small">Crewtavo will use {domain}.</span>}
          {!result && !typing && check.isFetching && <span className="row muted small"><Spinner size={14} />Checking {domain}…</span>}
          {provider && <span className="row small"><Icon name="check" size={14} />Your domain's DNS is at {provider.label}.</span>}
          {result && result.warnings.length > 0 && (
            <div className="callout">
              <Icon name="info" size={18} />
              <ul className={styles.list} style={{ flex: 1, minWidth: 0 }}>{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <FormError error={start.error} />
      <div className="form-actions">
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" icon="arrowRight" loading={start.isPending} disabled={!domain || Boolean(problem)}>Continue</Button>
      </div>
    </form>
  );
}

function Waiting({ overview, change, checking, onCheck }: { overview: AddressOverview; change: AddressChange; checking: boolean; onCheck: () => void }) {
  const lastStep = !change.automatic && change.reachable && !change.live;
  return (
    <>
      <section className="card card-pad stack" aria-labelledby="address-title">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 id="address-title" className={styles.title}>Setting up {change.domain}</h2>
          <span className="muted">{summary(overview, change)}</span>
        </div>
        {change.error && <Problem>{change.error}</Problem>}
        <Progress overview={overview} change={change} />
        {change.automatic && (
          <div className="callout callout-info">
            <Icon name="info" size={18} />
            <span className="grow">{recordsIn(change) ? "You can close this page." : "Once the records are in, you can close this page."} Crewtavo finishes by itself and lets you know when it's done.</span>
          </div>
        )}
        {lastStep ? (
          <LastStep overview={overview} domain={change.domain} />
        ) : (
          <span className="muted small">
            This page checks again every 15 seconds.{" "}
            <button type="button" className="link-btn small" disabled={checking} onClick={onCheck}>{checking ? "Checking…" : "Check now"}</button>
          </span>
        )}
      </section>
      {overview.platform === "railway" && !change.automatic && <RailwayStep overview={overview} domain={change.domain} />}
      <RecordsCard overview={overview} change={change} />
      {overview.platform !== "railway" && <ServerSteps domain={change.domain} />}
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <StopButton overview={overview} domain={change.domain} />
        <RailwayAccess overview={overview} />
      </div>
    </>
  );
}

function summary(overview: AddressOverview, change: AddressChange): string {
  if (change.reachable) return change.automatic || change.live ? "The new address works. Crewtavo is switching over to it." : "The new address works. One last step and Crewtavo switches over.";
  if (overview.platform !== "railway") {
    return recordsIn(change) ? "Your domain points at your server. Next, put HTTPS in front of Crewtavo (below)." : "Point your domain at your server, then put HTTPS in front of Crewtavo. This page checks each step as you go.";
  }
  if (recordsIn(change)) return "Your records are in. The new address usually starts working within a few minutes, sometimes up to an hour.";
  if (!change.automatic) return "Railway needs to know the new address, and your domain needs two records that point it here. This page checks each step as you go.";
  return "Add the records below where your domain is managed. This page checks them as you go.";
}

function Progress({ overview, change }: { overview: AddressOverview; change: AddressChange }) {
  const items: Array<{ label: string; done: boolean; failed?: boolean }> = [
    { label: "Records in place", done: recordsIn(change) },
    ...(change.certificate === null && overview.platform !== "railway" ? [] : [{ label: "Secure connection (HTTPS) ready", done: change.certificate === "issued" || change.reachable, failed: change.certificate === "failed" }]),
    { label: "The new address opens Crewtavo", done: change.reachable },
    { label: "Crewtavo switched over", done: change.live },
  ];
  const current = items.findIndex((i) => !i.done);
  return (
    <ol className={styles.progress} aria-label="Progress">
      {items.map((item, i) => {
        const state = item.done ? "done" : item.failed ? "failed" : i === current ? "current" : "todo";
        return (
          <li key={item.label} data-state={state}>
            <span className={styles.mark} aria-hidden="true">{item.done ? <Icon name="check" size={13} strokeWidth={3} /> : item.failed ? <Icon name="x" size={13} strokeWidth={3} /> : null}</span>
            {item.label}
            <span className="sr-only">{item.done ? ": done" : item.failed ? ": failed" : ": not yet"}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The address works but Crewtavo can't switch by itself: set APP_URL, then check. */
function LastStep({ overview, domain }: { overview: AddressOverview; domain: string }) {
  const finish = useAddressAction(() => api.post<AddressOverview>("/address/finish"), { inline: true });
  return (
    <div className={`stack-sm ${styles.panel}`}>
      <strong>One last step: tell Crewtavo its new address</strong>
      <ol className={styles.steps}>
        {overview.platform === "railway" ? <RailwayAppUrl overview={overview} domain={domain} /> : <ServerAppUrl domain={domain} />}
      </ol>
      <span className="muted small">Once it has restarted, check again.</span>
      <FormError error={finish.error} />
      <div className="row wrap">
        <Button variant="primary" icon="refresh" loading={finish.isPending} onClick={() => finish.mutate()}>Check again</Button>
      </div>
    </div>
  );
}

function RailwayAppUrl({ overview, domain }: { overview: AddressOverview; domain: string }) {
  return (
    <>
      <li>
        <div className="stack-sm">
          <span>Open the <strong>crewtavo</strong> service's <strong>Variables</strong>, set <code className={styles.inline}>APP_URL</code> to this, and press <strong>Deploy</strong>:</span>
          <Copyable value={addressUrl(domain)} what="APP_URL" />
          {overview.railway?.variablesUrl && <ExternalButton href={overview.railway.variablesUrl}>Open Variables</ExternalButton>}
        </div>
      </li>
      <li>Open the <strong>auth</strong> service and choose <strong>Redeploy</strong>, so sign-in emails use the new address too.</li>
    </>
  );
}

function ServerAppUrl({ domain }: { domain: string }) {
  return (
    <>
      <li>
        <div className="stack-sm">
          <span>In <code className={styles.inline}>.env.instance</code>, set:</span>
          <Copyable value={`APP_URL=${addressUrl(domain)}`} what="APP_URL" />
        </div>
      </li>
      <li>Run <code className={styles.inline}>npm run instance</code> again.</li>
    </>
  );
}

/** Railway has to know the address: Crewtavo adds it with Railway access, or the owner does it by hand. */
function RailwayStep({ overview, domain }: { overview: AddressOverview; domain: string }) {
  const queryClient = useQueryClient();
  const railway = overview.railway;
  const oauth = Boolean(railway?.oauth);
  const [pasting, setPasting] = useState(false);
  const connect = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ authorization_url: string }>("/address/railway/connect"),
    onSuccess: (r) => window.location.assign(r.authorization_url),
    // Railway may have refused to register this instance; the overview then offers the token instead.
    onError: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <section className="card card-pad stack" aria-labelledby="railway-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <strong id="railway-title" style={{ fontSize: 16 }}>Add the address on Railway</strong>
        <span className="muted">Railway runs Crewtavo, so it needs to know the new address too.</span>
      </div>
      {railway?.error && !railway.connected && <Problem title="Railway couldn't be connected">{railway.error}</Problem>}
      {railway?.connected ? (
        <span className="row"><Icon name="check" size={16} />Crewtavo is connected to Railway and is adding the address there. This page updates by itself.</span>
      ) : pasting || !oauth ? (
        <RailwayTokenForm tokensUrl={railway?.tokensUrl ?? null} onLogin={oauth ? () => setPasting(false) : undefined} />
      ) : (
        <div className="stack-sm">
          <div className="row wrap">
            <Button variant="primary" icon="arrowRight" loading={connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>Log in with Railway</Button>
          </div>
          <span className="muted small">Recommended. Crewtavo adds the address in Railway for you, then switches over by itself once it works.</span>
          <FormError error={connect.error} />
          <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setPasting(true)}>Or paste a Railway token instead</button>
        </div>
      )}
      <details className={styles.details}>
        <summary>Do it by hand instead</summary>
        <ol className={styles.steps}>
          <li>
            <div className="stack-sm">
              <span>Open the <strong>crewtavo</strong> service's <strong>Settings</strong>. Under <strong>Networking</strong>, choose <strong>+ Custom Domain</strong>.</span>
              {railway?.settingsUrl && <ExternalButton href={railway.settingsUrl}>Open Settings</ExternalButton>}
            </div>
          </li>
          <li>
            <div className="stack-sm">
              <span>Type this address, and choose port <strong>8080</strong>:</span>
              <Copyable value={domain} what="Address" />
            </div>
          </li>
          <li>Railway then shows two records to add. Add them where your domain is managed (the next step on this page).</li>
          <li>Wait for Railway to show a green check next to the address. Then:</li>
          <RailwayAppUrl overview={overview} domain={domain} />
        </ol>
      </details>
    </section>
  );
}

function RailwayTokenForm({ tokensUrl, onLogin }: { tokensUrl: string | null; onLogin?: () => void }) {
  const [token, setToken] = useState("");
  const save = useAddressAction((value: string) => api.post<AddressOverview>("/address/railway/token", { token: value }), { inline: true, success: "Connected to Railway" });
  return (
    <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (token.trim()) save.mutate(token.trim()); }}>
      <span className="muted small">With a project token, Crewtavo adds the address in Railway for you, then switches over by itself once it works.</span>
      <ol className={styles.steps}>
        <li>
          <div className="stack-sm">
            <span>In your Railway project, open <strong>Settings</strong>, then <strong>Tokens</strong>.</span>
            {tokensUrl && <ExternalButton href={tokensUrl}>Open Tokens</ExternalButton>}
          </div>
        </li>
        <li>Make a new token. Any name works, like Crewtavo. Pick the environment Crewtavo runs in (usually production).</li>
        <li>Copy the token and paste it here.</li>
      </ol>
      <Field label="Project token">
        <input className="input" type="password" value={token} onChange={(e) => { setToken(e.target.value); save.reset(); }} autoComplete="off" spellCheck={false} maxLength={500} />
      </Field>
      <FormError error={save.error} />
      <div className="row wrap" style={{ gap: 12 }}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!token.trim()}>Connect</Button>
        {onLogin && <button type="button" className="link-btn small" onClick={onLogin}>Log in with Railway instead</button>}
      </div>
    </form>
  );
}

/** The records to add at the DNS host, each with its live status. */
function RecordsCard({ overview, change }: { overview: AddressOverview; change: AddressChange }) {
  const [added, setAdded] = useState<number | null>(null);
  const provider = providerById(change.provider);
  const known = knownProvider(change.provider);
  const { records } = change;
  const them = records.length === 1 ? "it" : "them";
  // Without Railway access Crewtavo can't see Railway's exact records, only that one should point there.
  const byHand = overview.platform === "railway" && !change.automatic;
  const cloudflare = change.provider === "cloudflare" && change.automatic && records.length > 0 && records.every((r) => r.value !== null) && !recordsIn(change);

  return (
    <section className="card card-pad stack" aria-labelledby="records-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <strong id="records-title" style={{ fontSize: 16 }}>{byHand ? "Add Railway's two records to your domain" : records.length === 1 ? "Add this record to your domain" : records.length ? `Add these ${records.length} records to your domain` : "Records for your domain"}</strong>
        {records.length > 0 && (
          <span className="muted">{known ? `Your domain's DNS is at ${known.label}. Sign in there and add ${byHand ? "both" : them}.` : `Sign in where your domain is managed (usually where you bought it) and add ${byHand ? "both" : them}.`}</span>
        )}
        {byHand && <span className="muted small">Railway shows them once it has the address: the CNAME below, which points the address here, and a TXT record that proves the domain is yours. Crewtavo checks the CNAME; Railway shows a green check once both are in.</span>}
      </div>
      {!records.length ? (
        <span className="muted">
          {overview.platform !== "railway" ? "The record to add shows up here in a moment." : change.automatic ? "Crewtavo is adding the address on Railway. The records to add show up here in a moment." : "The records to add show up here once Railway has the address."}
        </span>
      ) : (
        <>
          {(provider.dnsUrl || provider.hostNote) && (
            <div className="stack-sm">
              {provider.dnsUrl && <ExternalButton href={provider.dnsUrl}>{known ? `Open ${known.label}` : "Open help"}</ExternalButton>}
              {provider.hostNote && <span className="muted small">{provider.hostNote}</span>}
            </div>
          )}
          {provider.note && (
            <div className="callout">
              <Icon name="info" size={18} />
              <span className="grow" style={{ fontWeight: 400 }}>{provider.note}</span>
            </div>
          )}
          <ol className={styles.records}>
            {records.map((record, i) => <RecordItem key={`${record.type} ${record.name}`} record={record} provider={provider} number={records.length > 1 ? i + 1 : null} unknown={overview.platform === "railway" ? "the value Railway shows" : "your server's IP address"} />)}
          </ol>
        </>
      )}
      {added !== null && (
        <div className="callout callout-good" role="status">
          <Icon name="check" size={18} />
          <div className="grow">
            <div>{added === 1 ? "Added 1 record in Cloudflare" : `Added ${added} records in Cloudflare`}</div>
            <div style={{ fontWeight: 400 }}>You can delete the token in Cloudflare now. Crewtavo used it once and didn't keep it.</div>
          </div>
        </div>
      )}
      {cloudflare && <CloudflareAdd onAdded={setAdded} />}
    </section>
  );
}

const STATUS = {
  ok: { label: "Done", tone: "good" },
  missing: { label: "Not there yet", tone: "muted" },
  wrong: { label: "Needs a fix", tone: "warning" },
} as const;

/** `unknown` names a value Crewtavo can't know: Railway's, or the server's address when self-hosted. */
function RecordItem({ record, provider, number, unknown }: { record: DnsRecordCheck; provider: DnsProvider; number: number | null; unknown: string }) {
  const status = STATUS[record.status];
  return (
    <li className={styles.record} data-status={record.status}>
      <div className="row-between wrap" style={{ gap: 8 }}>
        <strong>{number ? `${number}. ` : ""}{record.purpose === "route" ? "Points the address at Crewtavo" : "Shows Railway the domain is yours"}</strong>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <dl className={styles.fields}>
        <div><dt>Type</dt><dd><code className={styles.inline}>{record.type}</code></dd></div>
        <div><dt>Name</dt><dd><Copyable value={record.host} what="Name" /></dd></div>
        <div><dt>Value</dt><dd>{record.value ? <Copyable value={record.value} what="Value" /> : <span className="muted">{unknown[0]!.toUpperCase() + unknown.slice(1)}</span>}</dd></div>
      </dl>
      {record.status === "wrong" ? (
        <div className="callout callout-warning">
          <Icon name="alert" size={18} />
          <div className="grow">
            <div>{record.hint ?? "Something else is there. Change it to the value above."}</div>
            {record.found.length > 0 && <div className="small" style={{ fontWeight: 400, overflowWrap: "anywhere" }}>Right now it says: {record.found.join(", ")}</div>}
          </div>
        </div>
      ) : record.status === "missing" && record.hint ? (
        <span className="muted small">{record.hint}</span>
      ) : null}
      {record.status !== "ok" && provider.steps.length > 0 && (
        <ol className={styles.steps}>{provider.steps.map((step) => <li key={step}>{fillStep(step, { type: record.type, host: record.host, value: record.value }, unknown)}</li>)}</ol>
      )}
    </li>
  );
}

/** Cloudflare can take the records straight from Crewtavo, with a token used once. */
function CloudflareAdd({ onAdded }: { onAdded: (count: number) => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const add = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ added: number; overview: AddressOverview }>("/address/cloudflare", { token: token.trim() }),
    onSuccess: (r) => {
      setToken("");
      queryClient.setQueryData(KEY, r.overview);
      onAdded(r.added);
    },
  });
  return (
    <form className={`stack-sm ${styles.divided}`} onSubmit={(e: FormEvent) => { e.preventDefault(); if (token.trim()) add.mutate(); }}>
      <strong>Or let Crewtavo add them for you</strong>
      <ol className={styles.steps}>
        <li>
          <div className="stack-sm">
            <span>Make a token in Cloudflare. The link sets it up to change DNS records; create it and copy it.</span>
            <ExternalButton href={cloudflareTokenUrl()}>Make a Cloudflare token</ExternalButton>
          </div>
        </li>
        <li>Paste it here. Crewtavo uses it once to add the records and doesn't keep it.</li>
      </ol>
      <Field label="Cloudflare token">
        <input className="input" type="password" value={token} onChange={(e) => { setToken(e.target.value); add.reset(); }} autoComplete="off" spellCheck={false} maxLength={500} />
      </Field>
      <FormError error={add.error} />
      <div className="row wrap">
        <Button type="submit" variant="primary" icon="check" loading={add.isPending} disabled={!token.trim()}>Add them for me</Button>
      </div>
    </form>
  );
}

/** Self-hosted: HTTPS in front, then APP_URL. */
function ServerSteps({ domain }: { domain: string }) {
  const caddyfile = `${domain} {\n  reverse_proxy localhost:8080\n}`;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="server-title">
      <strong id="server-title" style={{ fontSize: 16 }}>Then, on your server</strong>
      <ol className={styles.steps}>
        <li>
          <div className="stack-sm">
            <span>Put HTTPS in front of Crewtavo. With Caddy, this Caddyfile does it, and Caddy gets the certificate by itself:</span>
            <pre className={styles.code}>{caddyfile}</pre>
            <Button size="sm" icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(caddyfile, "Caddyfile copied")}>Copy Caddyfile</Button>
          </div>
        </li>
        <li>Once the new address opens Crewtavo, tell Crewtavo about it:</li>
        <ServerAppUrl domain={domain} />
      </ol>
    </section>
  );
}

function Switching({ change }: { change: AddressChange }) {
  const url = addressUrl(change.domain);
  return (
    <section className="card card-pad stack" style={{ justifyItems: "center", textAlign: "center" }} aria-live="polite">
      <span style={{ color: "var(--green)" }}><Spinner size={28} /></span>
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 className={styles.title}>Switching to {url}</h2>
        <span className="muted">Crewtavo is restarting with the new address. This takes a couple of minutes.</span>
      </div>
      {change.error && <Problem>{change.error}</Problem>}
      <span className="muted small">This page keeps checking. If it stops updating, open <a href={url}>{change.domain}</a> and sign in there.</span>
    </section>
  );
}

function Done({ overview, change, onChange }: { overview: AddressOverview; change: AddressChange; onChange: () => void }) {
  const url = addressUrl(change.domain);
  return (
    <>
      <section className="card card-pad stack" style={{ justifyItems: "center", textAlign: "center" }}>
        <span className="success-mark"><Icon name="check" size={30} strokeWidth={2.5} /></span>
        <h2 className={styles.title}>Crewtavo is now at <a href={url}>{url}</a></h2>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          {window.location.origin !== url && <a className="btn btn-primary" href={url}>Open the new address</a>}
          <Button onClick={onChange}>Use a different address</Button>
        </div>
      </section>
      <section className="card card-pad stack-sm">
        <strong>Worth knowing</strong>
        <ul className={styles.list}>
          <li>Everyone signs in once on the new address.</li>
          <li>On phones: open the new address, add it to the Home Screen again, and turn notifications back on there.</li>
          <li>Links you already sent keep working. Pages on the old address forward to the new one.</li>
          <li>If you reconnect QuickBooks, Zoho or Google Calendar, the <Link to="/apps">Apps</Link> page shows the new redirect address to use.</li>
        </ul>
      </section>
      <RailwayAccess overview={overview} />
    </>
  );
}

function Failed({ overview, change }: { overview: AddressOverview; change: AddressChange }) {
  const finish = useAddressAction(() => api.post<AddressOverview>("/address/finish"), { inline: true });
  return (
    <>
      <section className="card card-pad stack">
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2 className={styles.title}>{change.domain} isn't working yet</h2>
          <span className="muted">{overview.current ? `Crewtavo is still at ${bare(overview.current)}, so nothing has changed for your team.` : "Nothing has changed for your team."}</span>
        </div>
        <Problem title="Switching didn't finish">{change.error ?? "Something went wrong. Try again."}</Problem>
        <FormError error={finish.error} />
        <div className="row wrap">
          <Button variant="primary" icon="refresh" loading={finish.isPending} onClick={() => finish.mutate()}>Try again</Button>
          <StopButton overview={overview} domain={change.domain} />
        </div>
      </section>
      <RailwayAccess overview={overview} />
    </>
  );
}

function StopButton({ overview, domain }: { overview: AddressOverview; domain: string }) {
  const stop = useAddressAction(() => api.delete<AddressOverview>("/address"), { success: "Stopped setting up the address" });
  const ask = async () => {
    const stays = overview.current ? `Crewtavo stays at ${bare(overview.current)}` : "Crewtavo keeps its address";
    if (await confirm({ title: `Stop setting up ${domain}?`, body: `${stays} and nothing changes for your team. You can start again any time.`, confirmLabel: "Stop setting it up", danger: true })) stop.mutate();
  };
  return <Button variant="ghost" loading={stop.isPending} onClick={ask}>Stop setting this up</Button>;
}

/** Crewtavo holds Railway access: say so, and let the owner take it back. */
function RailwayAccess({ overview }: { overview: AddressOverview }) {
  const forget = useAddressAction(() => api.delete<AddressOverview>("/address/railway"), { success: "Railway access removed" });
  if (!overview.railway?.connected) return null;
  const busy = overview.change?.status === "waiting" || overview.change?.status === "switching";
  const ask = async () => {
    const body = busy ? "Crewtavo won't be able to finish this by itself; you'd do the last steps on Railway by hand." : "You can connect again next time you change the address.";
    if (await confirm({ title: "Remove Crewtavo's Railway access?", body, confirmLabel: "Remove access", danger: true })) forget.mutate();
  };
  return (
    <span className="row muted small" style={{ gap: 6 }}>
      <Icon name="lock" size={14} />
      <span>Crewtavo has access to your Railway project{overview.railway.projectName ? ` ${overview.railway.projectName}` : ""}.</span>
      <button type="button" className="link-btn small" disabled={forget.isPending} onClick={ask}>Remove access</button>
    </span>
  );
}

function Problem({ title = "Something needs attention", children }: { title?: string; children: ReactNode }) {
  return (
    <div className="callout callout-danger" role="alert">
      <Icon name="alert" size={18} />
      <div className="grow">
        <div>{title}</div>
        <div style={{ fontWeight: 400 }}>{children}</div>
      </div>
    </div>
  );
}

function Copyable({ value, what }: { value: string; what: string }) {
  return (
    <span className={styles.copy}>
      <code className="code-pill grow">{value}</code>
      <Button size="sm" icon="copy" aria-label={`Copy ${what}`} onClick={() => copyText(value, `${what} copied`)}>Copy</Button>
    </span>
  );
}

const ExternalButton = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="btn btn-sm" style={{ justifySelf: "start" }} href={href} target="_blank" rel="noreferrer">
    <Icon name="external" size={14} />
    {children}
  </a>
);
