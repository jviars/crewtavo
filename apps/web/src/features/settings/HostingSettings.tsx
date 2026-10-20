/**
 * Settings → Hosting: what Railway charges for this Crewtavo, from the owner's Railway connection
 * (GET /api/railway/usage, apps/api/src/services/hosting.ts). Warnings come first, each with what
 * fixes it; then the period so far against what the plan includes and Railway's forecast, what each
 * part of Crewtavo uses, the last week's memory and CPU, how full the volumes are, and the plan.
 *
 * Railway's API can't change a plan or take a payment, so upgrading, buying credit and updating the
 * card open Railway's own pages. The usage limit, Railway's "stop at this much a month", can be
 * changed right here (POST /api/railway/limit). Without a connection, the screen asks for one.
 */
import type { AddressOverview } from "@crewtavo/core/address";
import { RAILWAY_PLANS, serviceLabel, type HostingOverview, type HostingWarning } from "@crewtavo/core/hosting";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { CardSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { RailwayConnect } from "./RailwayConnect";
import { ConnectRailway, ExternalButton, RailwayAccess, useRailwayReturn, WEB_ADDRESS_KEY } from "./WebAddressSettings";
import styles from "./HostingSettings.module.css";

export const HOSTING_KEY = ["hosting"];

/** Railway bills in US dollars, whatever the business's own currency. */
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => dollars.format(n);
/** Railway's billing periods start and end at midnight UTC. */
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const gb = (n: number) => `${Number(n.toFixed(n < 10 ? 2 : 1))} GB`;
/** A limit a bit above the forecast, in steps of $5. */
const roomy = (forecast: number, limit: number) => Math.max(limit + 5, Math.ceil((forecast * 1.25) / 5) * 5);

export function HostingSettings() {
  const queryClient = useQueryClient();
  const address = useQuery({ queryKey: WEB_ADDRESS_KEY, queryFn: () => api.get<AddressOverview>("/address"), staleTime: 5_000, meta: { silent: true } });
  const railway = address.data?.railway ?? null;
  const ready = Boolean(railway?.connected && railway.current);
  const hosting = useQuery({ queryKey: HOSTING_KEY, queryFn: () => api.get<HostingOverview>("/railway/usage"), enabled: ready, staleTime: 60_000, retry: false });
  const check = useMutation({
    meta: { inline: true },
    mutationFn: () => api.get<HostingOverview>("/railway/usage?fresh=1"),
    onSuccess: (next) => queryClient.setQueryData(HOSTING_KEY, next),
  });
  // Opened by "Raise the limit" on a warning, with a suggestion filled in.
  const [limitDraft, setLimitDraft] = useState<number | null>(null);
  useRailwayReturn();

  if (address.isPending) return <CardSkeleton lines={4} />;
  if (!address.data) return <div className="card"><ErrorState error={address.error} onRetry={() => address.refetch()} /></div>;
  if (!railway) return <div className="card card-pad muted">This Crewtavo doesn't run on Railway, so there's nothing to show here.</div>;
  if (!ready) {
    return (
      <section className={`card card-pad stack ${styles.page}`} aria-labelledby="hosting-connect">
        <h2 id="hosting-connect" className={styles.title}>{railway.connected ? "Log in with Railway again" : "Connect Railway"}</h2>
        <RailwayConnect railway={railway} returnTo="hosting" />
      </section>
    );
  }
  if (hosting.isPending) return <CardSkeleton lines={6} />;
  if (!hosting.data) return <div className="card"><ErrorState error={hosting.error} onRetry={() => hosting.refetch()} /></div>;

  const o = hosting.data;
  const forecast = o.account?.forecast ?? o.project?.forecast ?? null;
  return (
    <div className={`stack ${styles.page}`}>
      {o.warnings.map((w) => (
        <Warning key={w.key} warning={w} links={o.links} onRaise={() => setLimitDraft(roomy(forecast ?? 0, o.account?.limit ?? 0))} />
      ))}
      <Summary o={o} />
      {o.project && o.project.services.length > 0 && <Services services={o.project.services} />}
      {o.week.length > 1 && <Week week={o.week} />}
      {o.disks.length > 0 && <Disks disks={o.disks} />}
      <Plan o={o} railway={railway} limitDraft={limitDraft} onLimitDraft={setLimitDraft} />
      <div className={`row wrap muted small ${styles.footer}`}>
        <span className="grow">
          From Railway, {new Date(o.checkedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Crewtavo works out what each part costs at Railway's prices, so those are close estimates; Railway's bill is the final word.
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={check.isPending} onClick={() => check.mutate()}>Check again</Button>
        <ExternalButton href={o.links.usage}>Railway's usage page</ExternalButton>
      </div>
      <FormError error={check.error} />
      <RailwayAccess overview={address.data} />
    </div>
  );
}

const ACTIONS: Record<Exclude<HostingWarning["action"], "limit" | null>, { label: string; link: keyof HostingOverview["links"] }> = {
  upgrade: { label: "Choose a plan on Railway", link: "upgrade" },
  plans: { label: "Choose a plan on Railway", link: "plans" },
  billing: { label: "Open Railway billing", link: "billing" },
  project: { label: "Open Railway", link: "project" },
};

function Warning({ warning, links, onRaise }: { warning: HostingWarning; links: HostingOverview["links"]; onRaise: () => void }) {
  const action = warning.action && warning.action !== "limit" ? ACTIONS[warning.action] : null;
  const href = action ? links[action.link] : null;
  return (
    <div className={`callout ${warning.level === "urgent" ? "callout-danger" : "callout-warning"}`} role={warning.level === "urgent" ? "alert" : undefined}>
      <Icon name="alert" size={18} />
      <div className="grow">
        <div>{warning.title}</div>
        <div style={{ fontWeight: 400 }}>{warning.body}</div>
        {href && action && <div style={{ marginTop: 10 }}><ExternalButton href={href} primary>{action.label}</ExternalButton></div>}
        {warning.action === "limit" && <div style={{ marginTop: 10 }}><Button size="sm" variant="primary" onClick={onRaise}>Raise the limit</Button></div>}
      </div>
    </div>
  );
}

/** The period so far against what the plan includes, Railway's forecast, and the usage limit. */
function Summary({ o }: { o: HostingOverview }) {
  const plan = o.plan ? RAILWAY_PLANS[o.plan] : null;
  const spent = o.account?.usage ?? o.project?.cost ?? 0;
  const forecast = o.account?.forecast ?? o.project?.forecast ?? null;
  // The trial's credit is a one-time amount, shown with the trial below rather than as a monthly line.
  const included = plan && o.plan !== "trial" ? plan.included : null;
  const limit = o.account?.limit ?? null;
  const over = included !== null && forecast !== null ? forecast - included : 0;
  return (
    <section className="card card-pad stack" aria-labelledby="hosting-summary">
      <div className="row-between" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <h2 id="hosting-summary" className={styles.title}>{o.account?.others ? "Your Railway account" : "Railway"}</h2>
          <span className="muted small">{o.period.billing ? `This billing period, ${day(o.period.start)} to ${day(o.period.end)}` : `This month so far, since ${day(o.period.start)}`}</span>
        </div>
        {plan && <span className={`chip ${o.plan === "trial" || o.plan === "free" ? "chip-amber" : "chip-green"}`}>{plan.name}</span>}
      </div>
      {o.missing.includes("usage") && !o.account ? (
        <span className="muted">Railway didn't share this project's usage just now. Check again in a few minutes.</span>
      ) : (
        <>
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="hero-number">{usd(spent)}</span>
            <span className="muted small">{forecast !== null ? `so far. About ${usd(forecast)} by ${day(o.period.end)}, at this rate.` : "so far."}</span>
          </div>
          <Meter spent={spent} forecast={forecast} included={included} limit={limit} />
          <div className={`row wrap small ${styles.legend}`}>
            <span><i className={styles.keySpent} />So far {usd(spent)}</span>
            {forecast !== null && <span><i className={over > 0 ? styles.keyOver : styles.keyForecast} />Forecast {usd(forecast)}</span>}
            {included !== null && plan && <span><i className={styles.keyMark} />{plan.name} includes {usd(included)}</span>}
            {limit !== null && <span><i className={styles.keyLimit} />Railway stops at {usd(limit)}</span>}
          </div>
        </>
      )}
      {plan && (o.plan === "hobby" || o.plan === "pro") && forecast !== null && (
        <span className="small">
          Railway's bill for the period: the {usd(plan.price)} plan{over >= 0.01 ? `, plus about ${usd(over)} of usage over what it includes` : ", with your usage included"}.
        </span>
      )}
      {o.plan === "trial" && o.account && (
        <span className="small">
          Trial: {o.account.trialDaysLeft != null ? `${o.account.trialDaysLeft} day${o.account.trialDaysLeft === 1 ? "" : "s"}` : "some time"}
          {o.account.credit != null ? ` and ${usd(o.account.credit)} of credit` : ""} left. Crewtavo stops when it ends, unless you choose a plan.
        </span>
      )}
      {o.account?.others && o.project && (
        <span className="small muted">
          Your Railway account runs other projects too. This Crewtavo: {usd(o.project.cost)} so far{o.project.forecast !== null ? `, about ${usd(o.project.forecast)} for the period` : ""}.
        </span>
      )}
    </section>
  );
}

function Meter({ spent, forecast, included, limit }: { spent: number; forecast: number | null; included: number | null; limit: number | null }) {
  const top = Math.max(spent, forecast ?? 0, included ?? 0, limit ?? 0) * 1.08 || 1;
  const at = (n: number) => `${Math.min(100, (n / top) * 100)}%`;
  const over = included !== null && (forecast ?? spent) > included;
  return (
    <div className={styles.meter} aria-hidden="true">
      {forecast !== null && <span className={over ? styles.over : styles.forecast} style={{ width: at(forecast) }} />}
      <span className={styles.spent} style={{ width: at(spent) }} />
      {included !== null && <i className={styles.mark} style={{ left: at(included) }} />}
      {limit !== null && <i className={`${styles.mark} ${styles.limit}`} style={{ left: at(limit) }} />}
    </div>
  );
}

function Services({ services }: { services: NonNullable<HostingOverview["project"]>["services"] }) {
  const most = Math.max(...services.map((s) => s.cost), 0.01);
  return (
    <section className="card card-pad stack-sm" aria-labelledby="hosting-services">
      <h2 id="hosting-services" className={styles.title}>What it's used for</h2>
      <span className="muted small">This Crewtavo's parts on Railway, so far this period.</span>
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
  trial: "Railway's free trial: $5 of credit for 30 days. Crewtavo stops when it ends, unless you choose a plan.",
  free: "$1 of usage a month, which is less than Crewtavo needs, so Railway stops it partway through the month.",
  hobby: "$5 a month, including $5 of usage. You only pay for usage above that.",
  pro: "$20 a month, including $20 of usage. You only pay for usage above that.",
};

/** The plan, with Railway's pages to change it or buy credit, and the usage limit (changed here). */
function Plan({ o, railway, limitDraft, onLimitDraft }: { o: HostingOverview; railway: NonNullable<AddressOverview["railway"]>; limitDraft: number | null; onLimitDraft: (n: number | null) => void }) {
  const upgradeFirst = o.plan === "trial" || o.plan === "free";
  return (
    <section className="card card-pad stack" aria-labelledby="hosting-plan">
      <div className="stack-sm" style={{ gap: 4 }}>
        <h2 id="hosting-plan" className={styles.title}>Plan{o.plan ? `: ${RAILWAY_PLANS[o.plan].name}` : ""}</h2>
        {o.plan && <span className="muted">{PLAN_WORDS[o.plan]}</span>}
        <span className="muted small">Plans, credit and your card are on Railway: these open Railway's pages.</span>
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        {upgradeFirst ? <ExternalButton href={o.links.upgrade} primary>Choose a plan on Railway</ExternalButton> : <ExternalButton href={o.links.plans}>Change plan</ExternalButton>}
        {o.plan !== "trial" && <ExternalButton href={o.links.billing}>{o.account?.prepaid ? "Buy credit" : "Billing and card"}</ExternalButton>}
      </div>
      {o.account?.credit != null && o.plan !== "trial" && <span className="small">Credit left: <strong>{usd(o.account.credit)}</strong>. Railway uses it before charging your card.</span>}
      <div className={styles.divided}>
        {o.account ? (
          <UsageLimit account={o.account} forecast={o.account.forecast ?? o.project?.forecast ?? null} draft={limitDraft} onDraft={onLimitDraft} />
        ) : (
          <div className="stack-sm">
            <strong className="small">Billing and warnings</strong>
            <span className="muted small">
              Railway didn't share your billing with this connection, so Crewtavo can't warn you about the trial, credit or card. That takes Login with Railway by an admin of
              your Railway workspace; a project token can't see billing.
            </span>
            {railway.oauth && <ConnectRailway returnTo="hosting" projectName={railway.projectName} label="Log in with Railway" />}
          </div>
        )}
      </div>
    </section>
  );
}

function UsageLimit({ account, forecast, draft, onDraft }: { account: NonNullable<HostingOverview["account"]>; forecast: number | null; draft: number | null; onDraft: (n: number | null) => void }) {
  const queryClient = useQueryClient();
  // null until the owner types: the field shows the suggestion.
  const [value, setValue] = useState<string | null>(null);
  const editing = draft !== null;
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (stopAt: number | null) => api.post<HostingOverview>("/railway/limit", { stop_at: stopAt }),
    onSuccess: (next, stopAt) => {
      queryClient.setQueryData(HOSTING_KEY, next);
      onDraft(null);
      toast.success(stopAt ? `Railway now stops at ${usd(stopAt)} a month` : "Usage limit removed");
    },
  });
  const open = (suggested: number) => {
    setValue(null);
    save.reset();
    onDraft(suggested);
  };
  const remove = async () => {
    if (await confirm({ title: "Remove the usage limit?", body: "Railway keeps Crewtavo running however much it uses, and bills all of it.", confirmLabel: "Remove limit" })) save.mutate(null);
  };
  const shown = value ?? String(draft ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Math.round(Number(shown));
    if (n >= 1) save.mutate(n);
  };

  let words: ReactNode;
  if (account.limit) {
    words = (
      <>
        Railway stops your projects, Crewtavo included, at <strong>{usd(account.limit)}</strong> of usage a month
        {account.alertAt ? `, and emails you at ${usd(account.alertAt)}` : ""}.{forecast !== null && forecast >= account.limit ? " At this rate it gets there before the period ends." : ""}
      </>
    );
  } else {
    words = "No limit: Railway keeps Crewtavo running however much it uses. A limit stops your projects when usage reaches it, so set it well above what Crewtavo normally uses.";
  }
  return (
    <div className="stack-sm">
      <strong className="small">Usage limit</strong>
      <span className="small">{words}</span>
      {editing ? (
        <form className="stack-sm" onSubmit={submit}>
          <Field label="Stop at, in dollars a month" hint={forecast !== null ? `Forecast for this period: ${usd(forecast)}.` : undefined}>
            <input className="input" type="number" inputMode="numeric" min={1} step={1} value={shown} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 160 }} />
          </Field>
          <FormError error={save.error} />
          <div className="row wrap" style={{ gap: 8 }}>
            <Button type="submit" size="sm" variant="primary" loading={save.isPending && save.variables !== null}>Save limit</Button>
            <Button size="sm" variant="ghost" onClick={() => onDraft(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="row wrap" style={{ gap: 8 }}>
          <Button size="sm" onClick={() => open(account.limit ? roomy(forecast ?? 0, account.limit) : Math.max(20, roomy(forecast ?? 0, 0)))}>{account.limit ? "Raise the limit" : "Set a limit"}</Button>
          {account.limit && <Button size="sm" variant="ghost" loading={save.isPending && save.variables === null} onClick={remove}>Remove limit</Button>}
        </div>
      )}
      {!editing && <FormError error={save.error} />}
    </div>
  );
}
