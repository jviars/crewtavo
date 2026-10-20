/**
 * Settings → Hosting: what Railway charges for this Crewtavo, from the owner's Railway connection
 * (GET /api/railway/usage, apps/api/src/services/hosting.ts). Warnings come first, each with the
 * Railway page that fixes it; then the month so far against what the plan includes and a forecast
 * at the last day's rate, the trial's days and credit, what each part of Crewtavo uses, the last
 * week's memory and CPU, how full the volumes are, and the plan.
 *
 * The connection reaches the project, not the account's billing, so plans, credit, the card and
 * the usage limit open Railway's own pages. Without a connection, the screen asks for one.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { RAILWAY_PLANS, RAILWAY_TRIAL, serviceLabel, type HostingOverview, type HostingWarning } from "@crewtavo/core/hosting";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { RailwayConnect } from "./RailwayConnect";
import { ExternalButton, RailwayAccess, useRailwayReturn, WEB_ADDRESS_KEY } from "./WebAddressSettings";
import styles from "./HostingSettings.module.css";

export const HOSTING_KEY = ["hosting"];

/** Railway bills in US dollars, whatever the business's own currency. */
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => dollars.format(n);
/** The month's start and end are midnight UTC. */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const gb = (n: number) => `${Number(n.toFixed(n < 10 ? 2 : 1))} GB`;
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function HostingSettings() {
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
  useRailwayReturn();

  if (address.isPending) return <CardSkeleton lines={4} />;
  if (!address.data) return <div className="card"><ErrorState error={address.error} onRetry={() => address.refetch()} /></div>;
  if (!railway) return <div className="card card-pad muted">This Crewtavo doesn't run on Railway, so there's nothing to show here.</div>;
  if (!connected) {
    return (
      <section className={`card card-pad stack ${styles.page}`} aria-labelledby="hosting-connect">
        <h2 id="hosting-connect" className={styles.title}>{railway.error ? "Connect Railway again" : "Connect Railway"}</h2>
        <RailwayConnect railway={railway} returnTo="hosting" />
      </section>
    );
  }
  if (hosting.isPending) return <CardSkeleton lines={6} />;
  if (!hosting.data) return <div className="card"><ErrorState error={hosting.error} onRetry={() => hosting.refetch()} /></div>;

  const o = hosting.data;
  return (
    <div className={`stack ${styles.page}`}>
      {o.warnings.map((w) => <Warning key={w.key} warning={w} links={o.links} />)}
      <Summary o={o} />
      {o.project && o.project.services.length > 0 && <Services services={o.project.services} />}
      {o.week.length > 1 && <Week week={o.week} />}
      {o.disks.length > 0 && <Disks disks={o.disks} />}
      <Plan o={o} />
      <div className={`row wrap muted small ${styles.footer}`}>
        <span className="grow">
          From Railway, {new Date(o.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Crewtavo works out the cost at Railway's prices, so these are close estimates;
          Railway's bill is the final word.
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
        <ExternalButton href={o.links.usage}>Railway's usage page</ExternalButton>
      </div>
      <FormError error={check.error} />
      <RailwayAccess overview={address.data} />
    </div>
  );
}

const ACTIONS: Record<NonNullable<HostingWarning["action"]>, { label: string; link: keyof HostingOverview["links"] }> = {
  upgrade: { label: "Choose a plan on Railway", link: "upgrade" },
  project: { label: "Open Railway", link: "project" },
};

function Warning({ warning, links }: { warning: HostingWarning; links: HostingOverview["links"] }) {
  const action = warning.action ? ACTIONS[warning.action] : null;
  const href = action ? links[action.link] : null;
  return (
    <div className={`callout ${warning.level === "urgent" ? "callout-danger" : "callout-warning"}`} role={warning.level === "urgent" ? "alert" : undefined}>
      <Icon name="alert" size={18} />
      <div className="grow">
        <div>{warning.title}</div>
        <div style={{ fontWeight: 400 }}>{warning.body}</div>
        {href && action && <div style={{ marginTop: 10 }}><ExternalButton href={href} primary>{action.label}</ExternalButton></div>}
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
    <section className="card card-pad stack" aria-labelledby="hosting-summary">
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <h2 id="hosting-summary" className={styles.title}>Railway</h2>
          <span className="muted small">This month so far, since {day(o.period.start)}</span>
        </div>
        {plan && <span className={`chip ${o.plan === "trial" || o.plan === "free" ? "chip-amber" : "chip-green"}`}>{plan.name}</span>}
      </div>
      {!o.project ? (
        <span className="muted">Railway didn't share this project's usage just now. Check again in a few minutes.</span>
      ) : (
        <>
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="hero-number">{usd(spent)}</span>
            <span className="muted small">
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
        <span className="small">
          Railway's bill for the month: the {usd(plan.price)} plan{over >= 0.01 ? `, plus about ${usd(over)} of usage over what it includes` : ", with your usage included"}.
        </span>
      )}
      {o.trial && (
        <div className="stack-sm" style={{ gap: 6 }}>
          <span className="small">
            Railway's trial: about <strong>{days(o.trial.daysLeft)}</strong> or <strong>{usd(o.trial.creditLeft)}</strong> of its {usd(RAILWAY_TRIAL.credit)} credit left, whichever runs out first. Crewtavo
            stops then, unless you choose a plan.
          </span>
          <div className="progress" role="img" aria-label={`${usd(o.trial.creditLeft)} of ${usd(RAILWAY_TRIAL.credit)} left`}>
            <span style={{ width: `${(o.trial.creditLeft / RAILWAY_TRIAL.credit) * 100}%` }} />
          </div>
          <span className="muted small">Counted from when this Crewtavo was set up. Railway's dashboard has the exact figures.</span>
        </div>
      )}
    </section>
  );
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
    <section className="card card-pad stack-sm" aria-labelledby="hosting-services">
      <h2 id="hosting-services" className={styles.title}>What it's used for</h2>
      <span className="muted small">This Crewtavo's parts on Railway, so far this month.</span>
      <ul className={styles.services}>
        {services.map((s) => (
          <li key={s.id}>
            <span className="stack-sm" style={{ gap: 0, minWidth: 0 }}>
              <strong className="small">{serviceLabel(s.name)}</strong>
              {serviceLabel(s.name) !== s.name && <span className="muted small">{s.name}</span>}
            </span>
            <span className={styles.bar}><span style={{ width: `${(s.cost / most) * 100}%` }} /></span>
            <span className={styles.amount}>{usd(s.cost)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Week({ week }: { week: HostingOverview["week"] }) {
  const rows = week.map((p) => ({ label: new Date(p.at).toLocaleString(undefined, { weekday: "short", hour: "numeric" }), memory: p.memory, cpu: p.cpu }));
  const last = week[week.length - 1]!;
  const average = (key: "memory" | "cpu") => week.reduce((sum, p) => sum + p[key], 0) / week.length;
  return (
    <section className="stack-sm" aria-labelledby="hosting-week">
      <h2 id="hosting-week" className={styles.title}>The last 7 days</h2>
      <div className="stat-row">
        <div className="card stat">
          <div className="label">Memory</div>
          <div className="value">{gb(last.memory)}</div>
          <div className="hint">Averaged {gb(average("memory"))}. Railway charges $10 per GB a month.</div>
          <LazySparkline data={rows} height={48} format={gb} config={{ memory: { label: "Memory", color: "var(--green)" } }} />
        </div>
        <div className="card stat">
          <div className="label">Processor</div>
          <div className="value">{last.cpu.toFixed(2)} vCPU</div>
          <div className="hint">Averaged {average("cpu").toFixed(2)} vCPU. Railway charges $20 per vCPU a month.</div>
          <LazySparkline data={rows} height={48} format={(n) => `${n.toFixed(2)} vCPU`} config={{ cpu: { label: "Processor", color: "var(--info)" } }} />
        </div>
      </div>
    </section>
  );
}

function Disks({ disks }: { disks: HostingOverview["disks"] }) {
  return (
    <section className="card card-pad stack-sm" aria-labelledby="hosting-disks">
      <h2 id="hosting-disks" className={styles.title}>Storage</h2>
      {disks.map((d) => {
        const full = d.sizeGb > 0 ? d.usedGb / d.sizeGb : 0;
        return (
          <div key={d.service} className="stack-sm" style={{ gap: 4 }}>
            <div className="row-between small">
              <strong>{serviceLabel(d.service)}</strong>
              <span className="muted">{gb(d.usedGb)} of {gb(d.sizeGb)}</span>
            </div>
            <div className="progress" role="img" aria-label={`${Math.round(full * 100)}% full`}>
              <span style={{ width: `${Math.min(100, full * 100)}%`, background: full >= 0.95 ? "var(--danger)" : full >= 0.85 ? "var(--warning)" : undefined }} />
            </div>
          </div>
        );
      })}
    </section>
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
  const upgradeFirst = o.plan === "trial" || o.plan === "free";
  return (
    <section className="card card-pad stack" aria-labelledby="hosting-plan">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="hosting-plan" className={styles.title}>Plan{o.plan ? `: ${RAILWAY_PLANS[o.plan].name}` : ""}</h2>
        {o.plan && <span className="muted">{PLAN_WORDS[o.plan]}</span>}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {upgradeFirst ? <ExternalButton href={o.links.upgrade} primary>Choose a plan on Railway</ExternalButton> : <ExternalButton href={o.links.plans}>Change plan</ExternalButton>}
        {o.plan !== "trial" && <ExternalButton href={o.links.billing}>Card and credit</ExternalButton>}
      </div>
      <div className={`stack-sm ${styles.divided}`}>
        <strong className="small">Usage limit</strong>
        <span className="muted small">
          Railway can stop your projects when usage reaches an amount you choose, so a busy month never surprises you. Set it well above what Crewtavo normally uses: when it's reached, Crewtavo
          stops too.
        </span>
        <ExternalButton href={o.links.usage}>Set a limit on Railway</ExternalButton>
      </div>
      <span className="muted small">Railway takes payments and changes plans itself, so these open Railway's pages.</span>
    </section>
  );
}
