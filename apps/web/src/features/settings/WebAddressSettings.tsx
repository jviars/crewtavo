/**
 * Settings → Web address: move Crewtavo from its Railway address (something.up.railway.app) to the
 * business's own, like crm.greenlawn.com. The owner types their domain after crm. and adds the
 * records it needs where their domain is managed; Crewtavo checks them as they go in. With Railway
 * access (Log in with Railway, or a project token) Crewtavo adds the address on Railway and switches
 * over by itself, so the screen leads with that; otherwise the last step is setting APP_URL by hand.
 * GET /api/address says where it stands.
 */
import { ADDRESS_PREFIX, addressUrl, normalizeDomain, prefixedAddress, type AddressChange, type AddressCheck, type AddressOverview, type DnsProvider, type DnsRecordCheck } from "@crewtavo/core/address";
import { cloudflareTokenUrl, fillStep, GENERIC_DNS_PROVIDER, providerById } from "@crewtavo/core/dns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
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

export const WEB_ADDRESS_KEY = ["web-address"];

const bare = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const recordsIn = (change: AddressChange) => change.records.length > 0 && change.records.every((r) => r.status === "ok");
/** On Cloudflare, once Railway has said exactly what the records are, Crewtavo can add them itself. */
const cloudflareCanAdd = (change: AddressChange) =>
  change.provider === "cloudflare" && change.automatic && change.records.length > 0 && change.records.every((r) => r.value !== null) && !recordsIn(change);
/** The DNS host, when Crewtavo could tell who it is. */
const knownProvider = (id: string | null): DnsProvider | null => {
  const provider = providerById(id);
  return provider.id !== GENERIC_DNS_PROVIDER.id ? provider : null;
};

export function WebAddressSettings() {
  const overview = useQuery({
    queryKey: WEB_ADDRESS_KEY,
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
  return (
    <div className={`stack ${styles.page}`}>
      <AddressScreen overview={overview.data} returnTo="settings" choosing={choosing} onChoosing={setChoosing} checking={overview.isFetching} onCheck={() => overview.refetch()} />
    </div>
  );
}

/** Where Railway's sign-in comes back to: the setup step, this screen, or Settings → Hosting. */
export type RailwayReturn = "setup" | "settings" | "hosting";

interface ScreenProps {
  overview: AddressOverview;
  /** Where Railway's sign-in comes back to. */
  returnTo: RailwayReturn;
  /** The owner asked to pick an address (again). */
  choosing: boolean;
  onChoosing: (choosing: boolean) => void;
  checking: boolean;
  onCheck: () => void;
}

/** Settings → Web address and the setup step: the screen for where the address stands. */
export function AddressScreen(props: ScreenProps) {
  const { overview, choosing, onChoosing, checking, onCheck } = props;
  const { change } = overview;
  const settled = !change || change.status === "done";
  if (change?.status === "done" && !choosing && normalizeDomain(overview.current ?? "") === change.domain) return <Done overview={overview} change={change} onChange={() => onChoosing(true)} />;
  if (guided(overview, choosing)) return <AddressSteps {...props} />;
  if (choosing && settled) return <ChooseAddress overview={overview} onDone={() => onChoosing(false)} />;
  if (settled) return <CurrentAddress overview={overview} onChange={() => onChoosing(true)} />;
  if (change.status === "switching") return <Switching change={change} />;
  if (change.status === "failed") return <Failed overview={overview} change={change} />;
  return <Waiting overview={overview} change={change} checking={checking} onCheck={onCheck} />;
}

const onRailwayAddress = (url: string | null) => /(^|\.)railway\.app$/.test(normalizeDomain(url ?? "") ?? "railway.app");

/**
 * On Railway the steps lead the way, until Crewtavo is on the business's own domain. An address
 * being set up without Railway access gets the full instructions instead (Waiting): the owner does
 * the Railway part by hand there.
 */
function guided(overview: AddressOverview, choosing: boolean): boolean {
  if (overview.platform !== "railway" || !overview.railway) return false;
  const { change } = overview;
  if (change && change.status !== "done") return overview.railway.connected;
  return choosing || onRailwayAddress(overview.current);
}

const RETURNS: Record<string, string> = {
  expired: "The Railway sign-in expired. Try again.",
  cancelled: "Railway sign-in was cancelled.",
  error: "Railway couldn't be connected. The reason is below.",
};

/** Back from Railway's consent screen (?railway=connected, expired, cancelled or error): say how it went, then tidy the address bar. */
export function useRailwayReturn() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const result = params.get("railway");
  useEffect(() => {
    if (!result) return;
    if (result === "connected") toast.success("Connected to Railway", { description: "Crewtavo can now warn you before Railway stops it, and set things up there for you." });
    else toast.error(RETURNS[result] ?? RETURNS.error!);
    queryClient.invalidateQueries({ queryKey: WEB_ADDRESS_KEY });
    // Settings → Hosting (HostingSettings.tsx) reads Railway through the same connection.
    queryClient.invalidateQueries({ queryKey: ["hosting"] });
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
  return useMutation({ meta, mutationFn: action, onSuccess: (next) => queryClient.setQueryData(WEB_ADDRESS_KEY, next) });
}

/** Crewtavo's address as it is, with a way to change it: on the business's own domain, or off Railway. */
function CurrentAddress({ overview, onChange }: { overview: AddressOverview; onChange: () => void }) {
  const own = Boolean(overview.current) && !onRailwayAddress(overview.current);
  return (
    <>
      <section className="card card-pad stack">
        <div className="stack-sm">
          <strong style={{ fontSize: 16 }}>Crewtavo's web address</strong>
          {overview.current ? <a className={styles.address} href={overview.current} target="_blank" rel="noreferrer">{bare(overview.current)}</a> : <span className="muted">Not set yet</span>}
          <span className="muted">It's the address in every link Crewtavo sends: invites, quotes, invoices and the client hub.{own ? "" : ` On your own domain, like ${ADDRESS_PREFIX}.yourbusiness.com, those links look like your business.`}</span>
        </div>
        <div className="row wrap">
          <Button variant="primary" icon="globe" onClick={onChange}>{own ? "Use a different address" : "Use your own address"}</Button>
        </div>
      </section>
      <RailwayAccess overview={overview} />
      <RailwayDomains overview={overview} />
    </>
  );
}

type Railway = NonNullable<AddressOverview["railway"]>;

const STEPS = [
  { title: "Log in with Railway", ahead: "So Crewtavo can set things up on Railway for you." },
  { title: "Choose your domain", ahead: "Use the one your website already has, or get a new one." },
  { title: "Connect your domain", ahead: "Add two records where you bought it. Crewtavo shows you how, or emails the steps to whoever looks after it. A domain bought on Railway skips this." },
  { title: "Crewtavo switches over", ahead: "By itself, once the new address works. Usually within an hour." },
];

/**
 * On Railway: the way to the business's own address as four steps, ticked off as they're done,
 * with what to do now opened up under the current one. Settings → Web address and the setup step
 * both show it.
 */
export function AddressSteps({ overview, returnTo, choosing, onChoosing, checking, onCheck }: ScreenProps) {
  const queryClient = useQueryClient();
  const railway = overview.railway!;
  const change = overview.change && overview.change.status !== "done" ? overview.change : null;
  const picking = choosing && !change;
  const [buying, setBuying] = useState(false);
  // The address being typed, shown at the top as it'll look.
  const [draft, setDraft] = useState<string | null>(null);
  // A domain bought on Railway turns up on the crewtavo service a minute or so later: keep looking.
  useEffect(() => {
    if (!buying) return;
    if (change) {
      setBuying(false);
      return;
    }
    const timer = setInterval(() => queryClient.invalidateQueries({ queryKey: WEB_ADDRESS_KEY }), 10_000);
    return () => clearInterval(timer);
  }, [buying, change, queryClient]);

  const done = [railway.connected, Boolean(change), Boolean(change && recordsIn(change)), false];
  const current = picking ? 1 : done.indexOf(false);
  const summaries = [`Crewtavo can make changes in ${railway.projectName ?? "your Railway project"}.`, change?.domain, "Your records are in.", null];
  const now = (step: number): ReactNode => {
    if (step === 0) return <LoginStep railway={railway} returnTo={returnTo} onByHand={() => onChoosing(true)} />;
    if (step === 1) return picking ? <ChooseAddress overview={overview} onDone={() => onChoosing(false)} onDraft={setDraft} bare /> : <DomainChoice railway={railway} buying={buying} onBuying={setBuying} onUseMine={() => onChoosing(true)} />;
    if (step === 2) return <ConnectStep overview={overview} change={change!} checking={checking} onCheck={onCheck} />;
    return <SwitchStep overview={overview} change={change!} checking={checking} onCheck={onCheck} />;
  };

  return (
    <section className="card card-pad stack" aria-labelledby="steps-title">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="steps-title" className={styles.title}>{change ? `Setting up ${change.domain}` : "Use your own web address"}</h2>
        <span className="muted">
          {change
            ? `Crewtavo stays at ${overview.current ? bare(overview.current) : "its current address"} until the new one works, so nothing changes for your team in the meantime.`
            : "It's the address in every link Crewtavo sends: invites, quotes, invoices and the client hub. On your own domain, those links look like your business, and your website stays just as it is."}
        </span>
      </div>
      <AddressMove from={overview.current} to={change?.domain ?? (picking ? draft : null)} />
      <ol className={styles.timeline}>
        {STEPS.map((step, i) => {
          const state = i === current ? "current" : done[i] ? "done" : "todo";
          return (
            <li key={step.title} data-state={state} aria-current={state === "current" ? "step" : undefined}>
              <span className={styles.dot} aria-hidden="true">{state === "done" ? <Icon name="check" size={14} strokeWidth={2} /> : i + 1}</span>
              <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
                <strong className={styles.stepTitle}>{step.title}{state === "done" && <span className="sr-only">: done</span>}</strong>
                {state === "current" ? <div className={styles.stepNow}>{now(i)}</div> : <span className="muted small" style={{ overflowWrap: "anywhere" }}>{state === "done" ? summaries[i] : step.ahead}</span>}
              </div>
            </li>
          );
        })}
      </ol>
      {change ? (
        <div className={`row wrap ${styles.divided}`} style={{ justifyContent: "space-between" }}>
          <StopButton overview={overview} domain={change.domain} />
          <RailwayAccess overview={overview} />
        </div>
      ) : railway.connected ? (
        <div className={styles.divided}><RailwayAccess overview={overview} /></div>
      ) : null}
    </section>
  );
}

/** Step 1: Railway's sign-in, with a sketch of the screen it opens. */
function LoginStep({ railway, returnTo, onByHand }: { railway: Railway; returnTo: RailwayReturn; onByHand: () => void }) {
  return (
    <div className="stack">
      {railway.error && <Problem title="Railway isn't connected">{railway.error}</Problem>}
      {railway.oauth ? (
        <div className={styles.split}>
          <div className="stack-sm">
            <span>Railway runs your Crewtavo. Once you log in, Crewtavo adds your address there and switches over by itself, so you never have to open Railway's settings.</span>
            <ConnectRailway returnTo={returnTo} projectName={railway.projectName} />
          </div>
          <RailwaySketch projectName={railway.projectName} />
        </div>
      ) : (
        <RailwayTokenForm tokensUrl={railway.tokensUrl} />
      )}
      <span className="row muted small" style={{ gap: 6, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span style={{ flex: "none", marginTop: 1 }}><Icon name="lock" size={14} /></span>
        Crewtavo only uses its own project, and you can take the access back any time in Settings.
      </span>
      <details className={styles.details}>
        <summary>Can't log in with Railway?</summary>
        <div className="stack-sm">
          {railway.oauth && <RailwayTokenForm tokensUrl={railway.tokensUrl} />}
          <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={onByHand}>Or set it all up by hand</button>
        </div>
      </details>
    </div>
  );
}

/** What Railway's sign-in asks, drawn small, so the real screen looks familiar. */
export function RailwaySketch({ projectName }: { projectName: string | null }) {
  return (
    <div className={styles.sketch} aria-hidden="true">
      <div className={styles.sketchTop}><i /><i /><i /><span>On Railway</span></div>
      <div className={styles.sketchBody}>
        <span className={styles.sketchRow}><b>1</b>Projects<span className={styles.sketchSelect}><span className={styles.barText}>{projectName ?? "your project"}</span><Icon name="chevronDown" size={13} /></span></span>
        <span className={styles.sketchRow}><b>2</b>Press<span className={styles.sketchAllow}>Authorize</span></span>
      </div>
    </div>
  );
}

/** Step 2: the domain they already have, or a new one bought on Railway (which needs no records). */
function DomainChoice({ railway, buying, onBuying, onUseMine }: { railway: Railway; buying: boolean; onBuying: (buying: boolean) => void; onUseMine: () => void }) {
  const { domains, settingsUrl } = railway;
  if (buying) {
    return (
      <div className="stack">
        {domains.length > 0 ? <RailwayDomainList domains={domains} /> : <span className="row"><Spinner size={14} />Waiting for your new domain. It shows up here a minute or so after you buy it.</span>}
        <ol className={styles.steps}>
          <li>On Railway, open the <strong>crewtavo</strong> service's <strong>Settings</strong> and find <strong>Networking</strong>.</li>
          <li>Press <strong>Buy a Domain</strong> and buy the one you want. Railway bills it to your Railway account.</li>
          <li>Back here, press <strong>Use this domain</strong> next to it.</li>
        </ol>
        <div className="row wrap" style={{ gap: 12 }}>
          {settingsUrl && <ExternalButton href={settingsUrl}>Open Railway again</ExternalButton>}
          <button type="button" className="link-btn small" onClick={() => onBuying(false)}>Back</button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      {domains.length > 0 && (
        <div className="stack-sm">
          <strong className="small">Already on Railway</strong>
          <RailwayDomainList domains={domains} />
        </div>
      )}
      <span>Do you already have a domain for your business?</span>
      <div className={styles.choices}>
        <button type="button" className={styles.choice} onClick={onUseMine}>
          <span className={styles.choiceIcon}><Icon name="globe" size={20} /></span>
          <strong>Yes, use mine</strong>
          <span className="muted small">The one your website or work email uses. Crewtavo goes on {ADDRESS_PREFIX}. in front of it, and you add two records where you bought it.</span>
        </button>
        {settingsUrl && (
          <button
            type="button"
            className={styles.choice}
            onClick={() => {
              window.open(settingsUrl, "_blank", "noopener");
              onBuying(true);
            }}
          >
            <span className={styles.choiceIcon}><Icon name="card" size={20} /></span>
            <strong>No, get me one</strong>
            <span className="muted small">Buy one on Railway, billed to your Railway account. Railway connects it for you.</span>
            <StatusPill label="Nothing to set up" tone="good" />
          </button>
        )}
      </div>
    </div>
  );
}

interface StepProps { overview: AddressOverview; change: AddressChange; checking: boolean; onCheck: () => void }

/** Step 3: the records to add where the domain is managed, or to send to whoever looks after it. */
function ConnectStep({ overview, change, checking, onCheck }: StepProps) {
  // When Crewtavo can add the records itself, that comes first; sending them on is the fallback.
  const quick = cloudflareCanAdd(change);
  return (
    <div className="stack">
      {change.error && <Problem>{change.error}</Problem>}
      {!quick && <SendSteps change={change} />}
      <RecordsCard overview={overview} change={change} bare />
      {quick && <SendSteps change={change} below={false} />}
      <span className="muted small">
        Once the records are in, you can close this page. Crewtavo finishes by itself and lets you know when it's done.{" "}
        <button type="button" className="link-btn small" disabled={checking} onClick={onCheck}>{checking ? "Checking…" : "Check now"}</button>
      </span>
    </div>
  );
}

/** Step 4: waiting for the address to work, then the switch. */
function SwitchStep({ overview, change, checking, onCheck }: StepProps) {
  const finish = useAddressAction(() => api.post<AddressOverview>("/address/finish"), { inline: true });
  if (change.status === "switching") {
    return (
      <div className="stack-sm" aria-live="polite">
        <span className="row"><Spinner size={16} />Crewtavo is restarting at {addressUrl(change.domain)}. This takes a couple of minutes.</span>
        <span className="muted small">This page keeps checking. If it stops updating, open <a href={addressUrl(change.domain)}>{change.domain}</a> and sign in there.</span>
      </div>
    );
  }
  const lastStep = !change.automatic && change.reachable && !change.live;
  return (
    <div className="stack">
      {change.status === "failed" ? <Problem title="Switching didn't finish">{change.error ?? "Something went wrong. Try again."}</Problem> : change.error && <Problem>{change.error}</Problem>}
      <span>{change.reachable ? "The new address works. Crewtavo is switching over to it." : "Your records are in. The new address usually starts working within a few minutes, sometimes up to an hour."}</span>
      <Progress overview={overview} change={change} />
      {lastStep ? (
        <LastStep overview={overview} domain={change.domain} />
      ) : change.status === "failed" ? (
        <div className="stack-sm">
          <FormError error={finish.error} />
          <div className="row wrap"><Button variant="primary" icon="refresh" loading={finish.isPending} onClick={() => finish.mutate()}>Try again</Button></div>
        </div>
      ) : (
        <span className="muted small">
          You can close this page. Crewtavo finishes by itself and lets you know when it's done.{" "}
          <button type="button" className="link-btn small" disabled={checking} onClick={onCheck}>{checking ? "Checking…" : "Check now"}</button>
        </span>
      )}
    </div>
  );
}

/** Where Crewtavo is now, and the address it's moving to. */
function AddressMove({ from, to }: { from: string | null; to: string | null }) {
  return (
    <div className={styles.move} aria-hidden="true">
      <span className={styles.moveSide}>
        <span className={styles.moveLabel}>Now</span>
        <BrowserBar address={from ? bare(from) : "Not set yet"} tone="old" />
      </span>
      <span className={styles.moveArrow}><Icon name="arrowRight" size={18} /></span>
      <span className={styles.moveSide}>
        <span className={styles.moveLabel}>Your own</span>
        <BrowserBar address={to ?? `${ADDRESS_PREFIX}.yourbusiness.com`} tone={to ? "new" : "example"} />
      </span>
    </div>
  );
}

/** An address as a browser's address bar shows it. */
function BrowserBar({ address, tone = "new" }: { address: string; tone?: "old" | "new" | "example" }) {
  return (
    <span className={styles.bar} data-tone={tone}>
      <Icon name="lock" size={12} />
      <span className={styles.barText}>{address}</span>
    </span>
  );
}

/** Log in with Railway: Railway's consent screen, then back to Settings or the setup step. */
export function ConnectRailway({ returnTo, projectName, label = "Log in with Railway" }: { returnTo: RailwayReturn; projectName: string | null; label?: string }) {
  const queryClient = useQueryClient();
  const connect = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ authorization_url: string }>("/railway/connect", { return_to: returnTo }),
    onSuccess: (r) => window.location.assign(r.authorization_url),
    // Railway may have refused to register this instance; the overview then offers the token instead.
    onError: () => queryClient.invalidateQueries({ queryKey: WEB_ADDRESS_KEY }),
  });
  return (
    <div className="stack-sm">
      <div className="row wrap">
        <Button variant="primary" icon="arrowRight" loading={connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>{label}</Button>
      </div>
      <span className="muted small">
        On Railway's screen, press Authorize. To give Crewtavo only {projectName ? <strong>{projectName}</strong> : "this project"}, choose Change, then Selected projects, first.
      </span>
      <FormError error={connect.error} />
    </div>
  );
}

/**
 * Domains already on the crewtavo service in Railway, such as one just bought there. Railway runs
 * their DNS, so switching to one needs no records at all.
 */
export function RailwayDomains({ overview }: { overview: AddressOverview }) {
  const railway = overview.railway;
  if (!railway?.connected) return null;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="railway-domains-title">
      <strong id="railway-domains-title" style={{ fontSize: 16 }}>Domains on Railway</strong>
      {railway.domains.length > 0 ? (
        <RailwayDomainList domains={railway.domains} />
      ) : (
        <span className="muted">Need a domain? Buy one on Railway and it shows here. Railway sets it up, so there's nothing to add.</span>
      )}
      {railway.settingsUrl && (
        <div className="stack-sm">
          <ExternalButton href={railway.settingsUrl}>Buy a domain on Railway</ExternalButton>
          <span className="muted small">On the crewtavo service's Settings, under Networking, press Buy a Domain.</span>
        </div>
      )}
    </section>
  );
}

function RailwayDomainList({ domains }: { domains: Railway["domains"] }) {
  const queryClient = useQueryClient();
  const use = useMutation({
    meta: { inline: true },
    mutationFn: (domain: string) => api.post<AddressOverview>("/address/start", { domain }),
    onSuccess: (next) => queryClient.setQueryData(WEB_ADDRESS_KEY, next),
  });
  return (
    <>
      <ul className={styles.records}>
        {domains.map((d) => (
          <li key={d.domain} className={`row-between wrap ${styles.record}`}>
            <span className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
              <strong style={{ overflowWrap: "anywhere" }}>{d.domain}</strong>
              <span className="muted small">{d.verified && d.certificate === "issued" ? "Ready to use" : "Railway is still setting it up. You can choose it now."}</span>
            </span>
            <Button size="sm" loading={use.isPending && use.variables === d.domain} onClick={() => use.mutate(d.domain)}>Use this domain</Button>
          </li>
        ))}
      </ul>
      <FormError error={use.error} />
    </>
  );
}

/** `bare`: inside the steps, which already say what this is. `onDraft` hears the address as it's typed. */
export function ChooseAddress({ overview, onDone, onDraft, bare = false }: { overview: AddressOverview; onDone: () => void; onDraft?: (domain: string | null) => void; bare?: boolean }) {
  const queryClient = useQueryClient();
  const currentDomain = normalizeDomain(overview.current ?? "");
  // crm. is filled in and they type the rest, so nobody puts in the bare domain (their website) by
  // mistake. `whole` is for anyone who wants a different name: they type the whole address.
  const [whole, setWhole] = useState(false);
  const suggested = overview.suggestion && overview.suggestion !== currentDomain ? overview.suggestion : "";
  const [text, setText] = useState(afterPrefix(suggested));
  // Check as they type, once they pause.
  const [settledText, setSettledText] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettledText(text), 500);
    return () => clearTimeout(timer);
  }, [text]);
  const addressOf = (value: string) => (whole ? normalizeDomain(value) : prefixedAddress(value));
  const domain = addressOf(text);
  const settled = addressOf(settledText);
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
    : !typing && text.trim() && !domain ? (whole ? `That doesn't look like a web address. Type it like ${ADDRESS_PREFIX}.yourbusiness.com.` : text.includes(".") ? "That doesn't look like a domain. Type it like yourbusiness.com." : "Type the whole domain, with its ending, like yourbusiness.com.")
    : result?.problem ?? null;
  const provider = knownProvider(result?.provider ?? null);
  // More than the domain after crm. (crm.www2.greenlawn.com): offer crm. right in front of the domain.
  const closer = !whole && result?.zone ? `${ADDRESS_PREFIX}.${result.zone}` : null;
  const better = closer && closer !== domain && closer !== currentDomain ? closer : null;
  useEffect(() => onDraft?.(domain && !problem ? domain : null), [domain, problem, onDraft]);
  const start = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<AddressOverview>("/address/start", { domain }),
    onSuccess: (next) => {
      queryClient.setQueryData(WEB_ADDRESS_KEY, next);
      onDone();
    },
  });
  const fill = (value: string) => {
    setText(value);
    setSettledText(value);
    start.reset();
  };
  const switchTo = (next: boolean) => {
    setWhole(next);
    fill(next ? domain ?? "" : afterPrefix(domain ?? ""));
  };
  const input = {
    value: text,
    onChange: (e: ChangeEvent<HTMLInputElement>) => { setText(e.target.value); start.reset(); },
    inputMode: "url" as const,
    autoCapitalize: "none",
    autoCorrect: "off",
    spellCheck: false,
    autoFocus: true,
    maxLength: 300,
  };

  return (
    <form className={bare ? "stack" : "card card-pad stack"} onSubmit={(e: FormEvent) => { e.preventDefault(); if (domain && !problem) start.mutate(); }}>
      {!bare && (
        <div className="stack-sm">
          <strong style={{ fontSize: 16 }}>Choose your address</strong>
          <span className="muted">Crewtavo goes on {ADDRESS_PREFIX}. in front of your business's domain, so your website and email stay just as they are. To finish, you'll sign in where the domain is managed, usually where you bought it.</span>
        </div>
      )}
      <div className="stack-sm">
        {whole ? (
          <Field label="Address" hint={`The whole address, like ${ADDRESS_PREFIX}.yourbusiness.com. Your domain on its own (yourbusiness.com) would replace your website.`} error={problem}>
            <input {...input} className="input" placeholder={`${ADDRESS_PREFIX}.yourbusiness.com`} />
          </Field>
        ) : (
          <Field label="Your address" hint={`${ADDRESS_PREFIX}. is filled in for you. Type the rest: your business's domain, the one your website or work email uses.`} error={problem}>
            <div className={`input ${styles.prefixed}`} onClick={(e) => e.currentTarget.querySelector("input")?.focus()}>
              <span className={styles.prefix} aria-hidden="true">{ADDRESS_PREFIX}.</span>
              {/* Tidy a pasted website or email down to the domain once they move on. */}
              <input {...input} placeholder="yourbusiness.com" onBlur={() => { if (domain && afterPrefix(domain) !== text) fill(afterPrefix(domain)); }} />
            </div>
          </Field>
        )}
        <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => switchTo(!whole)}>
          {whole ? `Put ${ADDRESS_PREFIX}. in front for me` : `Use a different name than ${ADDRESS_PREFIX}`}
        </button>
      </div>
      {domain && !problem && (
        <div className="stack-sm">
          {whole ? (
            domain !== text.trim().toLowerCase() && <span className="muted small">Crewtavo will use {domain}.</span>
          ) : (
            <div className={styles.preview}>
              <span className="small">Crewtavo will be at</span>
              <BrowserBar address={domain} />
              <span className="muted small">Your website stays at {result?.zone ?? afterPrefix(domain)}.</span>
            </div>
          )}
          {!result && !typing && check.isFetching && <span className="row muted small"><Spinner size={14} />Checking {domain}…</span>}
          {provider && <span className="row small"><Icon name="check" size={14} />Your domain's DNS is at {provider.label}.</span>}
          {better && (
            <div className="callout">
              <Icon name="info" size={18} />
              <div className="grow stack-sm">
                <span style={{ fontWeight: 400 }}>Your domain is {result!.zone}. Most businesses use {better}.</span>
                <Button size="sm" style={{ justifySelf: "start" }} onClick={() => fill(afterPrefix(better))}>Use {better}</Button>
              </div>
            </div>
          )}
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
        <Button onClick={onDone}>{bare ? "Back" : "Cancel"}</Button>
        <Button type="submit" variant="primary" icon="arrowRight" loading={start.isPending} disabled={!domain || Boolean(problem)}>Continue</Button>
      </div>
    </form>
  );
}

/** greenlawn.com for crm.greenlawn.com: what goes in the box after crm. */
const afterPrefix = (address: string) => address.replace(/^crm\./, "");

export function Waiting({ overview, change, checking, onCheck }: { overview: AddressOverview; change: AddressChange; checking: boolean; onCheck: () => void }) {
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
            <span className={styles.mark} aria-hidden="true">{item.done ? <Icon name="check" size={13} strokeWidth={2} /> : item.failed ? <Icon name="x" size={13} strokeWidth={2} /> : null}</span>
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
  const railway = overview.railway;
  const oauth = Boolean(railway?.oauth);
  const [pasting, setPasting] = useState(false);

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
          <ConnectRailway returnTo="settings" projectName={railway?.projectName ?? null} />
          <span className="muted small">Recommended. Crewtavo adds the address in Railway for you, then switches over by itself once it works.</span>
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

/** `intro`: what a token does where the form is shown (the address switch, unless it says otherwise). */
export function RailwayTokenForm({ tokensUrl, onLogin, intro }: { tokensUrl: string | null; onLogin?: () => void; intro?: ReactNode }) {
  const [token, setToken] = useState("");
  const save = useAddressAction((value: string) => api.post<AddressOverview>("/railway/token", { token: value }), { inline: true, success: "Connected to Railway" });
  return (
    <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (token.trim()) save.mutate(token.trim()); }}>
      <span className="muted small">{intro ?? "With a project token, Crewtavo adds the address in Railway for you, then switches over by itself once it works."}</span>
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
        <input className="input" type="password" value={token} onChange={(e) => { setToken(e.target.value); save.reset(); }} autoComplete="off" spellCheck={false} maxLength={500} required />
      </Field>
      <FormError error={save.error} />
      <div className="row wrap" style={{ gap: 12 }}>
        <Button type="submit" variant="primary" loading={save.isPending}>Connect</Button>
        {onLogin && <button type="button" className="link-btn small" onClick={onLogin}>Log in with Railway instead</button>}
      </div>
    </form>
  );
}

/** The records to add at the DNS host, each with its live status. */
/** `bare`: inside the steps, under their own title. */
function RecordsCard({ overview, change, bare = false }: { overview: AddressOverview; change: AddressChange; bare?: boolean }) {
  const [added, setAdded] = useState<number | null>(null);
  const provider = providerById(change.provider);
  const known = knownProvider(change.provider);
  const { records } = change;
  const them = records.length === 1 ? "it" : "them";
  // Without Railway access Crewtavo can't see Railway's exact records, only that one should point there.
  const byHand = overview.platform === "railway" && !change.automatic;
  // Crewtavo adding them comes first; doing it in Cloudflare yourself folds away underneath.
  const quick = cloudflareCanAdd(change) && added === null;

  const list = (steps: boolean) => (
    <ol className={styles.records}>
      {records.map((record, i) => <RecordItem key={`${record.type} ${record.name}`} record={record} provider={provider} number={records.length > 1 ? i + 1 : null} unknown={overview.platform === "railway" ? "the value Railway shows" : "your server's IP address"} steps={steps} />)}
    </ol>
  );
  const manual = (
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
      {list(true)}
    </>
  );

  return (
    <section className={bare ? "stack" : "card card-pad stack"} aria-labelledby={bare ? undefined : "records-title"}>
      <div className="stack-sm" style={{ gap: 4 }}>
        <strong id="records-title" style={{ fontSize: 16 }} hidden={bare}>{byHand ? "Add Railway's two records to your domain" : records.length === 1 ? "Add this record to your domain" : records.length ? `Add these ${records.length} records to your domain` : "Records for your domain"}</strong>
        {records.length > 0 && added === null && (
          <span className="muted">
            {quick
              ? `Your domain's DNS is at Cloudflare. Crewtavo can add ${records.length === 1 ? "the record" : `both records`} there for you.`
              : known ? `Your domain's DNS is at ${known.label}. Sign in there and add ${byHand ? "both" : them}.` : `Sign in where your domain is managed (usually where you bought it) and add ${byHand ? "both" : them}.`}
          </span>
        )}
        {byHand && <span className="muted small">Railway shows them once it has the address: the CNAME below, which points the address here, and a TXT record that proves the domain is yours. Crewtavo checks the CNAME; Railway shows a green check once both are in.</span>}
      </div>
      {added !== null && (
        <div className="callout callout-good" role="status">
          <Icon name="check" size={18} />
          <div className="grow">
            <div>{added === 1 ? "Added 1 record in Cloudflare" : `Added ${added} records in Cloudflare`}</div>
            <div style={{ fontWeight: 400 }}>They usually show up as Done below within a few minutes. You can delete the token in Cloudflare now: Crewtavo used it once and didn't keep it.</div>
          </div>
        </div>
      )}
      {!records.length ? (
        <span className="muted">
          {overview.platform !== "railway" ? "The record to add shows up here in a moment." : change.automatic ? "Crewtavo is adding the address on Railway. The records to add show up here in a moment." : "The records to add show up here once Railway has the address."}
        </span>
      ) : added !== null ? (
        list(false)
      ) : quick ? (
        <>
          <CloudflareAdd onAdded={setAdded} />
          <details className={styles.details}>
            <summary>Or add them yourself in Cloudflare</summary>
            <div className="stack">{manual}</div>
          </details>
        </>
      ) : (
        manual
      )}
    </section>
  );
}

const STATUS = {
  ok: { label: "Done", tone: "good" },
  missing: { label: "Not there yet", tone: "muted" },
  wrong: { label: "Needs a fix", tone: "warning" },
} as const;

/** `unknown` names a value Crewtavo can't know: Railway's, or the server's address when self-hosted. */
/** `steps`: how to add it at the provider, while it isn't in yet. */
function RecordItem({ record, provider, number, unknown, steps = true }: { record: DnsRecordCheck; provider: DnsProvider; number: number | null; unknown: string; steps?: boolean }) {
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
      {steps && record.status !== "ok" && provider.steps.length > 0 && (
        <ol className={styles.steps}>{provider.steps.map((step) => <li key={step}>{fillStep(step, { type: record.type, host: record.host, value: record.value }, unknown)}</li>)}</ol>
      )}
    </li>
  );
}

/**
 * Many owners have someone who set up their website and looks after the domain: send them the
 * records from the owner's own mail app, or copy them into a text.
 */
/** `below`: the records follow, so the owner can add them there instead. */
function SendSteps({ change, below = true }: { change: AddressChange; below?: boolean }) {
  const todo = change.records.filter((r) => r.status !== "ok");
  if (!todo.length) return null;
  const message = recordsMessage(change, todo);
  const mailto = `mailto:?subject=${encodeURIComponent(`DNS records for ${change.domain}`)}&body=${encodeURIComponent(message)}`;
  return (
    <div className={`stack-sm ${styles.send}`}>
      <span className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <span className={styles.choiceIcon} style={{ flex: "none" }}><Icon name="users" size={18} /></span>
        <span className="stack-sm" style={{ gap: 2 }}>
          <strong>Someone else looks after your domain?</strong>
          <span className="muted small">Send the steps to whoever set up your website. It takes them a couple of minutes, and Crewtavo notices when they're done.{below && " Or add the records yourself, below."}</span>
        </span>
      </span>
      <div className="row wrap">
        <a className="btn btn-sm btn-primary" href={mailto}><Icon name="mail" size={14} />Email the steps</a>
        <Button size="sm" icon="copy" onClick={() => copyText(message, "Steps copied")}>Copy the steps</Button>
      </div>
    </div>
  );
}

function recordsMessage(change: AddressChange, records: DnsRecordCheck[]): string {
  const provider = providerById(change.provider);
  const known = knownProvider(change.provider);
  const them = records.length === 1 ? "this DNS record" : `these ${records.length} DNS records`;
  return [
    "Hi,",
    "",
    `Could you add ${them} to ${change.zone ?? change.domain}${known ? ` (its DNS is at ${known.label})` : ""}? They point ${change.domain} at our Crewtavo.`,
    "",
    ...records.flatMap((r, i) => [`${i + 1}. Type: ${r.type}`, `   Name: ${r.host}`, `   Value: ${r.value ?? "the value Railway shows for it"}`, ""]),
    ...(provider.hostNote ? [provider.hostNote, ""] : []),
    "Crewtavo checks them by itself and switches over once they're in. Thanks.",
  ].join("\n");
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
      queryClient.setQueryData(WEB_ADDRESS_KEY, r.overview);
      onAdded(r.added);
    },
  });
  return (
    <form className="stack-sm" onSubmit={(e: FormEvent) => { e.preventDefault(); if (token.trim()) add.mutate(); }}>
      <ol className={styles.steps}>
        <li>
          <div className="stack-sm">
            <span>Make a token in Cloudflare. The link opens Cloudflare's token page with everything filled in: press <strong>Continue to summary</strong>, then <strong>Create Token</strong>, and copy it.</span>
            <ExternalButton href={cloudflareTokenUrl()}>Make a Cloudflare token</ExternalButton>
          </div>
        </li>
        <li>Paste it here. Crewtavo uses it once to add the records, set to DNS only, and doesn't keep it.</li>
      </ol>
      <Field label="Cloudflare token">
        <input className="input" type="password" value={token} onChange={(e) => { setToken(e.target.value); add.reset(); }} autoComplete="off" spellCheck={false} maxLength={500} required />
      </Field>
      <FormError error={add.error} />
      <div className="row wrap">
        <Button type="submit" variant="primary" icon="check" loading={add.isPending}>Add them for me</Button>
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

export function Switching({ change }: { change: AddressChange }) {
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

export function Done({ overview, change, onChange }: { overview: AddressOverview; change: AddressChange; onChange: () => void }) {
  const url = addressUrl(change.domain);
  return (
    <>
      <section className="card card-pad stack" style={{ justifyItems: "center", textAlign: "center" }}>
        <span className="success-mark"><Icon name="check" size={30} strokeWidth={3} /></span>
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
      {overview.railway?.domains.length ? <RailwayDomains overview={overview} /> : null}
    </>
  );
}

export function Failed({ overview, change }: { overview: AddressOverview; change: AddressChange }) {
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
export function RailwayAccess({ overview }: { overview: AddressOverview }) {
  const forget = useAddressAction(() => api.delete<AddressOverview>("/railway"), { success: "Railway access removed" });
  if (!overview.railway?.connected) return null;
  const busy = overview.change?.status === "waiting" || overview.change?.status === "switching";
  const ask = async () => {
    const body = `${busy ? "Crewtavo won't be able to finish the new address by itself; you'd do the last steps on Railway by hand. " : ""}Crewtavo also stops warning you before Railway's trial runs out or the bill goes over your plan, and the owner is asked to connect again when they next open Crewtavo.`;
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

export const ExternalButton = ({ href, children, primary = false }: { href: string; children: ReactNode; primary?: boolean }) => (
  <a className={`btn btn-sm${primary ? " btn-primary" : ""}`} style={{ justifySelf: "start" }} href={href} target="_blank" rel="noreferrer">
    <Icon name="external" size={14} />
    {children}
  </a>
);
