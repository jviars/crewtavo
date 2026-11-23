/**
 * Settings → Hosting: what Railway charges for this Crewtavo, from the owner's Railway connection
 * (GET /api/railway/usage, apps/api/src/services/hosting.ts). Warnings come first, each with the
 * Railway page that fixes it; then the month so far against what the plan includes and a forecast
 * at the last day's rate, the trial's days and credit, what each part of Crewtavo uses, the last
 * week's memory and CPU, how full the volumes are (and what a bucket holds, with the way to the
 * storage limit in Settings → Storage), where photos and files are kept, and the plan.
 *
 * Files storage moves photos and files from the storage service's volume into a Railway bucket and
 * back (GET/POST /api/railway/storage, apps/api/src/services/storageBucket.ts), with what that does
 * and costs first, and the move's progress as it goes.
 *
 * The connection reaches the project, not the account's billing, so plans, credit, the card and
 * the usage limit open Railway's own pages. Without a connection, the screen asks for one. Because
 * only Railway can stop the bill, owners on a paid plan are asked to set Railway's hard usage limit
 * until they say they have (companies.settings.railway_usage_limit). A volume half full on a plan
 * with buckets brings a tip that leads to Files storage, and the month's data sent out is shown with
 * the rest, since Railway charges for it.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import {
  RAILWAY_PLANS,
  RAILWAY_TRIAL,
  serviceLabel,
  STORAGE_PRICES,
  storageMoving,
  type HostingOverview,
  type HostingWarning,
  type RailwayPlan,
  type StorageByHand,
  type StorageMove,
  type StorageOverview,
} from "@crewtavo/core/hosting";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useSession, type Session } from "@/lib/session";
import { RailwayConnect } from "./RailwayConnect";
import { bucketTipDismissed, dismissBucketTip, managesStorage, STORAGE_SETTINGS } from "./storage";
import { ExternalButton, RailwayAccess, useRailwayReturn, WEB_ADDRESS_KEY } from "./WebAddressSettings";
import styles from "./HostingSettings.module.css";
import { loadSettings } from "@/lib/companySettings";

export const HOSTING_KEY = ["hosting"];
export const FILES_STORAGE_KEY = ["hosting", "files-storage"];

/** Railway bills in US dollars, whatever the business's own currency. */
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => dollars.format(n);
/** The month's start and end are midnight UTC. */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const gb = (n: number) => `${Number(n.toFixed(n < 10 ? 2 : 1))} GB`;
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function HostingSettings() {
  const session = useSession();
  const queryClient = useQueryClient();
  const address = useQuery({ queryKey: WEB_ADDRESS_KEY, queryFn: () => api.get<AddressOverview>("/address"), staleTime: 5_000, meta: { silent: true } });
  const railway = address.data?.railway ?? null;
  const connected = Boolean(railway?.connected);
  const hosting = useQuery({ queryKey: HOSTING_KEY, queryFn: () => api.get<HostingOverview>("/railway/usage"), enabled: connected, staleTime: 60_000, retry: false });
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.get<HostingOverview>("/railway/usage?fresh=1"),
    onSuccess: (next) => queryClient.setQueryData(HOSTING_KEY, next),
  });
  // "Not now" on the suggestion to move files to a bucket: put aside for good (the bell sends it once).
  const aside = useMutation({
    meta: { inline: true },
    mutationFn: () => dismissBucketTip(session),
    onSuccess: () => session.refresh(),
  });
  useRailwayReturn();

  if (address.isPending) return <Loading label="Loading hosting"><SectionSkeleton rows={4} /></Loading>;
  if (!address.data) return <ErrorState error={address.error} onRetry={() => address.refetch()} />;
  if (!railway) return <EmptyState inline icon="cloud" title="Nothing to show here">This Crewtavo doesn't run on Railway, so there's nothing to show here.</EmptyState>;
  if (!connected) {
    return (
      <Section level={3} title={railway.error ? "Connect Railway again" : "Connect Railway"}>
        <RailwayConnect railway={railway} returnTo="hosting" />
      </Section>
    );
  }
  if (hosting.isPending) return <Loading label="Loading what Railway charges"><div className="settings-body"><SectionSkeleton rows={3} /><SectionSkeleton rows={4} /></div></Loading>;
  if (!hosting.data) return <ErrorState error={hosting.error} onRetry={() => hosting.refetch()} />;

  const o = hosting.data;
  return (
    <>
      {o.warnings.filter((w) => w.level !== "tip").map((w) => <Warning key={w.key} warning={w} links={o.links} />)}
      <SpendingLimit o={o} />
      {o.warnings.filter((w) => w.level === "tip" && !(w.key === "bucket" && bucketTipDismissed(session.company.settings))).map((w) => (
        <Warning key={w.key} warning={w} links={o.links} onAside={w.key === "bucket" ? () => aside.mutate() : undefined} asiding={aside.isPending} />
      ))}
      <Summary o={o} />
      {o.project && o.project.services.length > 0 && <Services services={o.project.services} />}
      {o.week.length > 1 && <Week week={o.week} />}
      {o.disks.length > 0 && <Disks disks={o.disks} />}
      <FilesStorage plan={o.plan} />
      <Plan o={o} />
      <div className={styles.footer}>
        <span className={styles.footerText}>
          From Railway, {new Date(o.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Crewtavo works out the cost at Railway's prices, so these are close estimates;
          Railway's bill is the final word.
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
        <ExternalButton href={o.links.usage}>Railway's usage page</ExternalButton>
      </div>
      <FormError error={check.error} />
      <RailwayAccess overview={address.data} />
    </>
  );
}

const ACTIONS: Record<Exclude<HostingWarning["action"], "files" | null>, { label: string; link: keyof HostingOverview["links"] }> = {
  upgrade: { label: "Choose a plan on Railway", link: "upgrade" },
  project: { label: "Open Railway", link: "project" },
};

/** Files storage, further down this page. */
const toFilesStorage = () => document.getElementById("hosting-files")?.scrollIntoView({ behavior: "smooth", block: "start" });

/** `onAside`: a "Not now" that puts a tip aside for good (the bucket suggestion). */
export function Warning({ warning, links, onAside, asiding }: { warning: HostingWarning; links: HostingOverview["links"]; onAside?: () => void; asiding?: boolean }) {
  const action = warning.action && warning.action !== "files" ? ACTIONS[warning.action] : null;
  const href = action ? links[action.link] : null;
  const tone = warning.level === "urgent" ? "callout-danger" : warning.level === "tip" ? "callout-info" : "callout-warning";
  return (
    <div className={`callout ${tone}`} role={warning.level === "urgent" ? "alert" : undefined}>
      <Icon name={warning.level === "tip" ? "info" : "alert"} size={16} />
      <div className="grow">
        <div>{warning.title}</div>
        <div>{warning.body}</div>
        {href && action && <div style={{ marginTop: 10 }}><ExternalButton href={href} primary>{action.label}</ExternalButton></div>}
        {(warning.action === "files" || onAside) && (
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            {warning.action === "files" && <Button size="sm" icon="cloud" onClick={toFilesStorage}>Go to Files storage</Button>}
            {onAside && <Button size="sm" variant="ghost" loading={asiding} onClick={onAside}>Not now</Button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Railway's own spending limit
// ---------------------------------------------------------------------------------------------

/** When an owner said they've set Railway's hard limit (companies.settings.railway_usage_limit), or null. */
export function usageLimitSetAt(settings: Record<string, unknown> | null | undefined): string | null {
  const kept = settings?.railway_usage_limit as { set_at?: unknown } | null | undefined;
  return typeof kept?.set_at === "string" ? kept.set_at : null;
}

/**
 * A hard limit to suggest: about twice a normal month (the forecast, or what the plan includes),
 * rounded up to $5, and never under Railway's lowest, $10.
 */
export function suggestedLimit(o: Pick<HostingOverview, "plan" | "project">): number {
  const usual = Math.max(o.project?.forecast ?? 0, o.plan ? RAILWAY_PLANS[o.plan].included : 0);
  return Math.max(10, Math.ceil((usual * 2) / 5) * 5);
}

/** Notes that the owner set Railway's hard limit, reading the settings fresh so every other setting stays as it is now. */
async function noteUsageLimit(session: Pick<Session, "company" | "userId">) {
  const current = await loadSettings(session.company.id);
  const next = { ...current, railway_usage_limit: { set_at: new Date().toISOString(), set_by: session.userId } };
  unwrap(await supabase().from("companies").update({ settings: next as never }).eq("id", session.company.id));
}

/**
 * For owners on a paid plan, until they say it's done: Railway's hard usage limit is the one thing
 * that stops the bill, and only the owner can set it (Crewtavo's Railway sign-in doesn't reach
 * billing). Hitting it stops Crewtavo too, so the amount suggested is well above a normal month.
 */
export function SpendingLimit({ o }: { o: HostingOverview }) {
  const session = useSession();
  const done = useMutation({
    meta: { inline: true, success: () => "Noted. Thanks for setting it." },
    mutationFn: () => noteUsageLimit(session),
    onSuccess: () => session.refresh(),
  });
  if (session.role !== "owner" || (o.plan !== "hobby" && o.plan !== "pro") || usageLimitSetAt(session.company.settings)) return null;
  return (
    <div className="callout callout-info">
      <Icon name="dollar" size={16} />
      <div className="grow stack-sm">
        <div>Set a spending limit in Railway</div>
        <span>
          Crewtavo warns you when usage climbs, but only Railway can stop the bill: its hard limit takes your project offline once the month reaches an amount you choose, so nothing can run
          it past that. Crewtavo can't set it for you, since it never sees your Railway billing.
        </span>
        <ol className={styles.steps}>
          <li>Open Railway's usage page and press <strong>Set Usage Limits</strong>.</li>
          <li>
            Under compute usage, set a <strong>Hard limit</strong> well above a normal month, like ${suggestedLimit(o)}: Crewtavo stops too when it's reached. Railway's lowest is $10. Add an
            email alert a little below it, if you like.
          </li>
        </ol>
        <div className="row wrap" style={{ gap: 8 }}>
          <ExternalButton href={o.links.usage} primary>Set a limit on Railway</ExternalButton>
          <Button size="sm" loading={done.isPending} onClick={() => done.mutate()}>I've set it</Button>
        </div>
        <FormError error={done.error} />
      </div>
    </div>
  );
}

/** The month so far against what the plan includes, the forecast, and the trial. */
function Summary({ o }: { o: HostingOverview }) {
  const plan = o.plan ? RAILWAY_PLANS[o.plan] : null;
  const spent = o.project?.cost ?? 0;
  const forecast = o.project?.forecast ?? null;
  // The trial's credit is a one-time amount, shown with the trial below rather than as a monthly line.
  const included = plan && o.plan !== "trial" ? plan.included : null;
  const over = included !== null && forecast !== null ? forecast - included : 0;
  return (
    <Section level={3} title="This month" action={plan ? <StatusPill label={plan.name} tone={o.plan === "trial" || o.plan === "free" ? "pending" : "good"} /> : undefined}>
      <p className="set-note">On Railway, so far, since {day(o.period.start)}</p>
      {!o.project ? (
        <p className={`set-note ${styles.gap}`}>Railway didn't share this project's usage just now. Check again in a few minutes.</p>
      ) : (
        <>
          <div className={styles.figure}>
            <span className={styles.big}>{usd(spent)}</span>
            <span className={styles.of}>
              so far{o.project.perDay !== null ? `, about ${usd(o.project.perDay)} a day lately` : ""}.{forecast !== null ? ` About ${usd(forecast)} by ${day(o.period.end)} at that rate.` : ""}
            </span>
          </div>
          <Meter spent={spent} forecast={forecast} included={included} />
          <div className={`row wrap small ${styles.legend}`}>
            <span><i className={styles.keySpent} />So far {usd(spent)}</span>
            {forecast !== null && <span><i className={over > 0 ? styles.keyOver : styles.keyForecast} />Forecast {usd(forecast)}</span>}
            {included !== null && plan && <span><i className={styles.keyMark} />{plan.name} includes {usd(included)}</span>}
          </div>
        </>
      )}
      {plan && (o.plan === "hobby" || o.plan === "pro") && forecast !== null && (
        <span className={`set-note ${styles.line}`}>
          Railway's bill for the month: the {usd(plan.price)} plan{over >= 0.01 ? `, plus about ${usd(over)} of usage over what it includes` : ", with your usage included"}.
        </span>
      )}
      {o.sent && o.sent.soFar > 0 && <span className={`set-note ${styles.line}`}>{sentLine(o.sent)}</span>}
      {o.trial && (
        <div className={styles.trial}>
          <span className={styles.lead}>
            Railway's trial: about <strong>{days(o.trial.daysLeft)}</strong> or <strong>{usd(o.trial.creditLeft)}</strong> of its {usd(RAILWAY_TRIAL.credit)} credit left, whichever runs out first. Crewtavo
            stops then, unless you choose a plan.
          </span>
          <div className="progress" role="img" aria-label={`${usd(o.trial.creditLeft)} of ${usd(RAILWAY_TRIAL.credit)} left`}>
            <span style={{ width: `${(o.trial.creditLeft / RAILWAY_TRIAL.credit) * 100}%` }} />
          </div>
          <span className="set-note">Counted from when this Crewtavo was set up. Railway's dashboard has the exact figures.</span>
        </div>
      )}
    </Section>
  );
}

/** "Sent to people's phones and browsers: 3.2 GB so far ($0.16), about 5 GB by the month's end." */
function sentLine(sent: NonNullable<HostingOverview["sent"]>): string {
  const price = STORAGE_PRICES.network;
  const forecast = sent.forecast !== null && sent.forecast > sent.soFar ? `, about ${gb(sent.forecast)} by the month's end` : "";
  return `Data sent to people's phones and browsers, at ${usd(price)} a GB: ${gb(sent.soFar)} so far (${usd(sent.soFar * price)})${forecast}. Photos, plans and videos people open count, and so do pictures on links shared outside the team.`;
}

function Meter({ spent, forecast, included }: { spent: number; forecast: number | null; included: number | null }) {
  const top = Math.max(spent, forecast ?? 0, included ?? 0) * 1.08 || 1;
  const at = (n: number) => `${Math.min(100, (n / top) * 100)}%`;
  const over = included !== null && (forecast ?? spent) > included;
  return (
    <div className={styles.meter} aria-hidden="true">
      {forecast !== null && <span className={over ? styles.over : styles.forecast} style={{ width: at(forecast) }} />}
      <span className={styles.spent} style={{ width: at(spent) }} />
      {included !== null && <i className={styles.mark} style={{ left: at(included) }} />}
    </div>
  );
}

function Services({ services }: { services: NonNullable<HostingOverview["project"]>["services"] }) {
  const most = Math.max(...services.map((s) => s.cost), 0.01);
  return (
    <Section level={3} title="What it's used for">
      <p className="set-note">This Crewtavo's parts on Railway, so far this month.</p>
      <ul className={styles.services}>
        {services.map((s) => (
          <li key={s.id}>
            <span className={styles.service}>
              <strong>{serviceLabel(s.name)}</strong>
              {serviceLabel(s.name) !== s.name && <span>{s.name}</span>}
            </span>
            <span className={styles.bar}><span style={{ width: `${(s.cost / most) * 100}%` }} /></span>
            <span className={styles.amount}>{usd(s.cost)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Week({ week }: { week: HostingOverview["week"] }) {
  const rows = week.map((p) => ({ label: new Date(p.at).toLocaleString(undefined, { weekday: "short", hour: "numeric" }), memory: p.memory, cpu: p.cpu }));
  const last = week[week.length - 1]!;
  const average = (key: "memory" | "cpu") => week.reduce((sum, p) => sum + p[key], 0) / week.length;
  return (
    <Section level={3} title="The last 7 days">
      <div className={styles.figures}>
        <div className={styles.figureBlock}>
          <span className={styles.label}>Memory</span>
          <span className={styles.value}>{gb(last.memory)}</span>
          <span className={styles.note}>Averaged {gb(average("memory"))}. Railway charges $10 per GB a month.</span>
          <LazySparkline data={rows} height={48} format={gb} config={{ memory: { label: "Memory", color: "var(--green)" } }} />
        </div>
        <div className={styles.figureBlock}>
          <span className={styles.label}>Processor</span>
          <span className={styles.value}>{last.cpu.toFixed(2)} vCPU</span>
          <span className={styles.note}>Averaged {average("cpu").toFixed(2)} vCPU. Railway charges $20 per vCPU a month.</span>
          <LazySparkline data={rows} height={48} format={(n) => `${n.toFixed(2)} vCPU`} config={{ cpu: { label: "Processor", color: "var(--info)" } }} />
        </div>
      </div>
    </Section>
  );
}

function Disks({ disks }: { disks: HostingOverview["disks"] }) {
  const session = useSession();
  return (
    <Section level={3} title="Storage" action={managesStorage(session) ? <Link to={STORAGE_SETTINGS}>Storage limit and who's using it</Link> : undefined}>
      <ul className={styles.disks}>
      {disks.map((d) => {
        // A bucket grows as it fills: what it holds, and what keeping that costs.
        if (d.kind === "bucket" || d.sizeGb === null) {
          return (
            <li key={`bucket:${d.service}`} className={styles.disk}>
              <strong>{serviceLabel(d.service)}</strong>
              <span className={styles.diskSize}>
                {gb(d.usedGb)}
                {d.objects !== undefined ? ` in ${d.objects.toLocaleString()} file${d.objects === 1 ? "" : "s"}` : ""}
                {d.monthly !== undefined ? `, ${d.monthly >= 0.01 ? `about ${usd(d.monthly)}` : "under a cent"} a month` : ""}
              </span>
            </li>
          );
        }
        const full = d.sizeGb > 0 ? d.usedGb / d.sizeGb : 0;
        return (
          <li key={d.service} className={styles.disk}>
            <strong>{serviceLabel(d.service)}</strong>
            <span className={styles.diskSize}>{gb(d.usedGb)} of {gb(d.sizeGb)}</span>
            <div className={`progress ${styles.diskBar}`} role="img" aria-label={`${Math.round(full * 100)}% full`}>
              <span style={{ width: `${Math.min(100, full * 100)}%`, background: full >= 0.95 ? "var(--danger)" : full >= 0.85 ? "var(--warning)" : undefined }} />
            </div>
          </li>
        );
      })}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------
// Files storage: the volume or a Railway bucket, and moving between them
// ---------------------------------------------------------------------------------------------

const MOVE_PATH: Record<StorageMove["direction"], string> = { to_bucket: "/railway/storage/move", to_volume: "/railway/storage/move-back" };
const count = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const bytesGb = (n: number) => gb(n / 1e9);
const on = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function FilesStorage({ plan }: { plan: RailwayPlan | null }) {
  const queryClient = useQueryClient();
  const storage = useQuery({
    queryKey: FILES_STORAGE_KEY,
    queryFn: () => api.get<StorageOverview>("/railway/storage"),
    // Every few seconds while files move, so the page follows along.
    refetchInterval: (query) => (storageMoving(query.state.data?.move) ? 3_000 : false),
    retry: false,
    meta: { silent: true },
  });
  const [asking, setAsking] = useState<StorageMove["direction"] | null>(null);
  const start = useMutation({
    meta: { inline: true },
    mutationFn: (direction: StorageMove["direction"]) => api.post<StorageOverview>(MOVE_PATH[direction]),
    onSuccess: (next) => {
      queryClient.setQueryData(FILES_STORAGE_KEY, next);
      setAsking(null);
    },
  });
  // Once a move is done, the storage and costs above change with it.
  const step = storage.data?.move?.step;
  useEffect(() => {
    if (step === "done") void queryClient.invalidateQueries({ queryKey: HOSTING_KEY, exact: true });
  }, [step, queryClient]);

  if (storage.isPending) return <SectionSkeleton rows={2} />;
  if (!storage.data) return <ErrorState error={storage.error} onRetry={() => storage.refetch()} />;
  const s = storage.data;
  const move = s.move;
  const moving = storageMoving(move);
  // Storage went back to the volume, but not every file came back yet.
  const unfinished = move?.direction === "to_volume" && move.step === "failed" && Boolean(move.switchedAt);
  const ready = !moving && !s.unavailable;

  return (
    <Section level={3} title="Files storage" id="hosting-files" action={s.backend ? <span className={styles.where}>{s.backend === "bucket" ? "Bucket" : "Volume"}</span> : undefined}>
      <div className={styles.body}>
      <p className="set-note">{whereFiles(s)}</p>
      {move && <MoveState move={move} storage={s} carrying={start.isPending} onCarryOn={() => start.mutate(move.direction)} />}
      {s.unavailable && !moving && <p className="set-note">{s.unavailable}</p>}
      {ready && s.backend === "volume" && !unfinished && (
        <div className={styles.body}>
          <span className={styles.lead}>
            A Railway bucket costs a tenth of what the volume does for each GB, and grows as it fills, so it never runs out of room. Railway doesn't back buckets up, though.
          </span>
          <div className={styles.actions}><Button icon="cloud" onClick={() => setAsking("to_bucket")}>Move files to a bucket</Button></div>
        </div>
      )}
      {ready && unfinished && (
        <div className={styles.actions}><Button variant="primary" icon="refresh" loading={start.isPending} onClick={() => start.mutate("to_volume")}>Finish moving back</Button></div>
      )}
      {ready && s.backend === "bucket" && (
        <div className={styles.actions}><Button icon="hardDrive" onClick={() => setAsking("to_volume")}>Move back to the volume</Button></div>
      )}
      {!asking && <FormError error={start.error} />}
      {asking === "to_bucket" && <MoveToBucket storage={s} plan={plan} busy={start.isPending} error={start.error} onMove={() => start.mutate("to_bucket")} onClose={() => setAsking(null)} />}
      {asking === "to_volume" && <MoveBack storage={s} busy={start.isPending} error={start.error} onMove={() => start.mutate("to_volume")} onClose={() => setAsking(null)} />}
      </div>
    </Section>
  );
}

function whereFiles(s: StorageOverview): string {
  if (s.backend === "bucket") {
    const held = s.bucket?.usedGb != null ? `: ${gb(s.bucket.usedGb)}${s.bucket.objects != null ? ` in ${count(s.bucket.objects, "file")}` : ""}` : "";
    return `Photos and files are in a Railway bucket${s.bucket ? ` (${s.bucket.name})` : ""}${held}.`;
  }
  if (s.backend === "volume") return `Photos and files are on the storage service's volume${s.volume ? `: ${gb(s.volume.usedGb)} of ${gb(s.volume.sizeGb)}` : ""}.`;
  return "Railway didn't say where storage keeps files just now.";
}

const STEPS: Record<StorageMove["step"], (m: StorageMove) => string> = {
  preparing: () => "Getting ready",
  bucket: () => "Making the bucket",
  copying: (m) => (m.direction === "to_bucket" ? "Copying files to the bucket" : "Copying back files added since the move"),
  switching: (m) => (m.direction === "to_bucket" ? "Switching storage to the bucket" : "Switching storage back to the volume"),
  checking: (m) => (m.direction === "to_bucket" ? "Checking files open from the bucket" : "Checking files open from the volume"),
  done: () => "Done",
  failed: () => "The move stopped",
  by_hand: () => "Waiting for a step in Railway",
};

/** A move in progress (step, files copied, steps to do in Railway), or how the last one went. */
function MoveState({ move, storage, carrying, onCarryOn }: { move: StorageMove; storage: StorageOverview; carrying: boolean; onCarryOn: () => void }) {
  const moving = storageMoving(move);
  const toBucket = move.direction === "to_bucket";
  const share = move.files > 0 ? Math.min(1, move.copied / move.files) : 0;
  return (
    <div className="stack-sm" aria-live="polite">
      {moving && (
        <div className={styles.panel}>
          <strong className={styles.minor}>{STEPS[move.step](move)}…</strong>
          {move.files > 0 && (
            <>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={move.files} aria-valuenow={move.copied} aria-label="Files copied">
                <span style={{ width: `${share * 100}%` }} />
              </div>
              <span className="set-note">
                {move.copied.toLocaleString()} of {count(move.files, "file")}
                {move.bytes > 0 ? ` (${bytesGb(move.copiedBytes)} of ${bytesGb(move.bytes)})` : ""}
              </span>
            </>
          )}
          {move.step === "switching" && !move.byHand && (
            <span className="set-note">
              {toBucket ? "Storage restarts with the bucket's settings, which takes about a minute. Anyone uploading then is asked to try again in a minute." : "Storage restarts on the volume, which takes about a minute."}
            </span>
          )}
          <span className="set-note">You can leave this page: Crewtavo carries on by itself.</span>
        </div>
      )}
      {move.byHand && <ByHand byHand={move.byHand} carrying={carrying} onCarryOn={move.step === "by_hand" ? onCarryOn : undefined} />}
      {move.step === "failed" && (
        <div className="callout callout-danger" role="alert">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>{toBucket ? "Files didn't move to the bucket" : "Files didn't all move back"}</div>
            <div>{move.error}</div>
            {toBucket && storage.backend === "volume" && !storage.unavailable && (
              <div style={{ marginTop: 10 }}><Button size="sm" icon="refresh" loading={carrying} onClick={onCarryOn}>Try again</Button></div>
            )}
          </div>
        </div>
      )}
      {move.step === "done" && (
        <div className="callout callout-good">
          <Icon name="check" size={16} />
          <div className="grow">
            <div>{toBucket ? `Files moved to the bucket${move.finishedAt ? ` on ${on(move.finishedAt)}` : ""}` : `Files moved back to the volume${move.finishedAt ? ` on ${on(move.finishedAt)}` : ""}`}</div>
            <div>
              {toBucket
                ? "The volume still has every file from before the move, so you can move back from here any time."
                : "The bucket still has its copy. Once you're sure everything opens, delete the bucket in Railway to stop paying for it."}
            </div>
          </div>
        </div>
      )}
      {move.stranded > 0 && move.step === "done" && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>{count(move.stranded, "file")} didn't make it to the bucket</div>
            <div>
              {move.stranded === 1 ? "It was" : "They were"} uploaded while storage switched over, so {move.stranded === 1 ? "it's" : "they're"} still on the volume and won't open now. Moving back to the volume brings {move.stranded === 1 ? "it" : "them"} back.
            </div>
          </div>
        </div>
      )}
      {move.missing > 0 && (
        <span className="set-note">
          {count(move.missing, "file")} {move.missing === 1 ? "was" : "were"} already missing from {toBucket ? "the volume" : "the bucket"}, so there was nothing to copy. {move.missing === 1 ? "It didn't" : "They didn't"} open before the move either.
        </span>
      )}
      {move.problems.length > 0 && move.step !== "done" && (
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className={styles.minor}>Files that didn't copy:</span>
          <ul className={styles.problems}>{move.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

/** A step to do in Railway: Crewtavo watches for it, or carries on when the owner says so. */
function ByHand({ byHand, carrying, onCarryOn }: { byHand: StorageByHand; carrying: boolean; onCarryOn?: () => void }) {
  const lines = byHand.lines?.join("\n") ?? "";
  return (
    <div className="callout callout-info">
      <Icon name="info" size={16} />
      <div className="grow stack-sm">
        <div>{byHand.title}</div>
        <span>Railway didn't let Crewtavo do this step itself, so it's yours to do in Railway:</span>
        <ol className={styles.steps}>{byHand.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        {lines && (
          <div className="stack-sm">
            <pre className={styles.code}>{lines}</pre>
            <Button size="sm" icon="copy" style={{ justifySelf: "start" }} onClick={() => copyText(lines, "Variables copied")}>Copy the variables</Button>
          </div>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          {byHand.link && <ExternalButton href={byHand.link} primary={!onCarryOn}>Open Railway</ExternalButton>}
          {onCarryOn && <Button size="sm" variant="primary" loading={carrying} onClick={onCarryOn}>Carry on</Button>}
        </div>
        {byHand.watching && <span>Crewtavo checks for the change every few seconds and carries on by itself.</span>}
      </div>
    </div>
  );
}

function MoveToBucket({ storage, plan, busy, error, onMove, onClose }: { storage: StorageOverview; plan: RailwayPlan | null; busy: boolean; error: unknown; onMove: () => void; onClose: () => void }) {
  const used = storage.volume?.usedGb ?? null;
  return (
    <Dialog open onClose={onClose} title="Move files to a Railway bucket" size="sm">
      <div className="dialog-body stack">
        <p className={styles.lead} style={{ margin: 0 }}>
          Crewtavo makes a bucket called <strong>files</strong> in your Railway project and copies every photo and file into it{used !== null ? ` (${gb(used)})` : ""}. Once they're all there and
          checked, it switches storage over and restarts it, which takes about a minute; uploads pause for that minute, and files still open. Copying takes a while for a lot of files, and you can leave the page.
        </p>
        <div className="stack-sm" style={{ gap: 4 }}>
          <strong className={styles.minor}>What it costs</strong>
          <span className="set-note">
            A bucket costs {usd(STORAGE_PRICES.bucket)} per GB a month, a tenth of the volume's {usd(STORAGE_PRICES.volume)}
            {used !== null && used > 0 ? `: about ${usd(used * STORAGE_PRICES.bucket)} a month for your ${gb(used)}, instead of about ${usd(used * STORAGE_PRICES.volume)}` : ""}. Railway counts
            files sent into the bucket as outbound traffic, {usd(STORAGE_PRICES.network)} per GB{used !== null && used > 0 ? `, so copying costs about ${usd(used * STORAGE_PRICES.network)} once` : ""}, and
            new uploads count the same way.
          </span>
        </div>
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>Railway doesn't back up buckets</div>
            <div>
              A volume can have backups on Railway's Pro plan; a bucket has none, and a file deleted from it is gone for good. Crewtavo's <Link to="/drive/trash" onClick={onClose}>Trash</Link> keeps deleted
              files for 30 days, so mistakes can be undone; for anything you can't lose, keep a copy of your own too.
            </div>
          </div>
        </div>
        {plan === "trial" && (
          <span className="set-note">
            Railway's Limited Trial doesn't include buckets. If Railway says no, choose a plan on Railway first, then try again.
          </span>
        )}
        <span className="set-note">The volume stays exactly as it is, with every file from before the move, so you can move back from here any time.</span>
        <FormError error={error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button variant="primary" icon="cloud" loading={busy} onClick={onMove}>Move files</Button>
        </div>
      </div>
    </Dialog>
  );
}

function MoveBack({ storage, busy, error, onMove, onClose }: { storage: StorageOverview; busy: boolean; error: unknown; onMove: () => void; onClose: () => void }) {
  const volume = storage.volume;
  const held = storage.bucket?.usedGb ?? null;
  const tight = volume && held !== null && volume.usedGb + held > volume.sizeGb;
  return (
    <Dialog open onClose={onClose} title="Move files back to the volume" size="sm">
      <div className="dialog-body stack">
        <p className={styles.lead} style={{ margin: 0 }}>
          Crewtavo switches storage back to the volume, which still has every file from before the move, and restarts it (about a minute). Then it copies back the files added since the move;
          until each is back, it doesn't open.
        </p>
        {volume && (
          <span className="set-note">
            The volume holds {gb(volume.usedGb)} of {gb(volume.sizeGb)}{held !== null ? `, and the bucket ${gb(held)}` : ""}.
            {tight ? " The files added since might not fit: make the volume bigger in Railway first." : ""}
          </span>
        )}
        <span className="set-note">The bucket keeps its copy. Delete it in Railway once you're sure, to stop paying for it.</span>
        <FormError error={error} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Not now</Button>
          <Button variant="primary" icon="hardDrive" loading={busy} onClick={onMove}>Move back</Button>
        </div>
      </div>
    </Dialog>
  );
}

const PLAN_WORDS: Record<string, string> = {
  trial: "Railway's free trial: 30 days or $5 of credit, whichever runs out first. Crewtavo stops when it ends, unless you choose a plan.",
  free: "$1 of usage a month, which is less than Crewtavo needs, so Railway stops it partway through the month.",
  hobby: "$5 a month, including $5 of usage. You only pay for usage above that.",
  pro: "$20 a month, including $20 of usage. You only pay for usage above that.",
};

/** The plan, with Railway's pages to change it, pay, and set a usage limit. */
function Plan({ o }: { o: HostingOverview }) {
  const session = useSession();
  const setAt = usageLimitSetAt(session.company.settings);
  const upgradeFirst = o.plan === "trial" || o.plan === "free";
  return (
    <Section level={3} title={`Plan${o.plan ? `: ${RAILWAY_PLANS[o.plan].name}` : ""}`}>
      <div className={styles.body}>
      {o.plan && <p className="set-note">{PLAN_WORDS[o.plan]}</p>}
      <div className={styles.actions}>
        {upgradeFirst ? <ExternalButton href={o.links.upgrade} primary>Choose a plan on Railway</ExternalButton> : <ExternalButton href={o.links.plans}>Change plan</ExternalButton>}
        {o.plan !== "trial" && <ExternalButton href={o.links.billing}>Card and credit</ExternalButton>}
      </div>
      <div className={`${styles.body} ${styles.divided}`}>
        <strong className={styles.minor}>Usage limit</strong>
        <span className="set-note">
          Railway can stop your projects when usage reaches an amount you choose, so a busy month never surprises you. Set it well above what Crewtavo normally uses: when it's reached, Crewtavo
          stops too.{setAt ? ` You noted setting one on ${on(setAt)}.` : ""}
        </span>
        <ExternalButton href={o.links.usage}>{setAt ? "Change the limit on Railway" : "Set a limit on Railway"}</ExternalButton>
      </div>
      <span className="set-note">Railway takes payments and changes plans itself, so these open Railway's pages.</span>
      </div>
    </Section>
  );
}
