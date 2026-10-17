import { dueSummary } from "@crewtavo/core/equipment";
import { zonedTimeToUtc } from "@crewtavo/core/time";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { LazySparkline } from "@/components/ui/LazySparkline";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { CardSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, statusLabel, visitTone } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { formatMoney, formatMoneyCompact, todayIn } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { monthToDate } from "@/lib/trends";
import { managesEquipment, useEquipmentDue } from "../equipment/equipmentData";
import type { Dashboard } from "./types";
import { WorkflowStrip } from "./WorkflowStrip";

function greeting(timeZone: string) {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

const ATTENTION_ICON: Record<string, IconName> = { quote: "quote", visit: "cloud", invoice: "invoice", equipment: "truck" };

export function HomePage() {
  const session = useSession();
  const navigate = useNavigate();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  useDocumentTitle("Home");
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["dashboard", session.company.id],
    queryFn: () => api.get<Dashboard>("/dashboard"),
    refetchInterval: 60_000,
  });
  const collected = useCollectedTrend(seesMoney);
  // Equipment overdue or coming due joins the list for the people who look after it.
  const gear = useEquipmentDue(session.company.id, { enabled: managesEquipment(session) });
  const attention = useMemo(() => {
    const worst = new Map<string, NonNullable<typeof gear.data>[number]>();
    for (const row of gear.data ?? []) if (row.equipment_status === "active" && row.state !== "ok" && !worst.has(row.equipment_id)) worst.set(row.equipment_id, row);
    const rows = [...worst.values()];
    const items: Dashboard["attention"] = rows.slice(0, 3).map((r) => ({
      kind: "equipment",
      title: `${r.name} ${r.state === "overdue" ? "overdue" : "coming due"}`,
      detail: `${r.equipment_name} · ${dueSummary(r)}`,
      link: `/equipment/${r.equipment_id}`,
    }));
    if (rows.length > 3) items.push({ kind: "equipment", title: `${rows.length - 3} more machines need maintenance`, detail: null, link: "/equipment?show=due" });
    return [...(data?.attention ?? []), ...items];
  }, [data?.attention, gear.data]);
  const firstName = session.profile.full_name.split(" ")[0] || "there";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });

  return (
    <>
      <div className="row-between wrap" style={{ alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-2)" }}>{today}</div>
          <h1 style={{ marginTop: 6, fontSize: "clamp(30px, 4vw, 40px)", fontWeight: 800, letterSpacing: "-0.025em", lineHeight: 1.1 }}>
            {greeting(tz)}, {firstName}
          </h1>
        </div>
        {isOffice && (
          <div className="page-actions">
            <Link className="btn" to="/requests?new=1"><Icon name="requests" size={16} />New request</Link>
            <Link className="btn btn-primary" to="/quotes?new=1"><Icon name="plus" size={16} />New quote</Link>
          </div>
        )}
      </div>

      {isPending && <HomeSkeleton office={isOffice} />}
      {error && <div className="card"><ErrorState error={error} onRetry={() => refetch()} title="Couldn't load your dashboard" /></div>}

      {data && (
        <>
          {isOffice && <WorkflowStrip workflow={data.workflow} showInvoices={seesMoney} />}

          <div className="two-col">
            <section className="wide stack" aria-labelledby="today-title">
              <div className="section-head">
                <h2 id="today-title" className="section-title">Today's appointments</h2>
                <Link className="btn btn-sm" to={isOffice ? "/schedule" : "/field"}>{isOffice ? "View schedule" : "My day"}</Link>
              </div>
              <div className="card">
                {data.today.total > 0 && (
                  <div className="card-pad stack-sm" style={{ paddingBottom: 14 }}>
                    <div className="row-between">
                      <span className="muted text-sm">
                        <strong style={{ color: "var(--ink)" }}>{data.today.by_status.completed ?? 0}</strong> of {data.today.total} complete
                        {data.today.by_status.in_progress ? ` · ${data.today.by_status.in_progress} in progress` : ""}
                      </span>
                    </div>
                    <div className="progress" aria-hidden="true"><span style={{ width: `${((data.today.by_status.completed ?? 0) / data.today.total) * 100}%` }} /></div>
                  </div>
                )}
                {data.today.visits.length === 0 ? (
                  <EmptyState icon="calendar" title="Nothing on the schedule today" compact action={isOffice ? <Link className="btn btn-sm" to="/schedule?new=1"><Icon name="plus" size={14} />Schedule a visit</Link> : undefined} />
                ) : (
                  data.today.visits.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className="card-row"
                      onClick={() => navigate(isOffice && v.job_id ? `/jobs/${v.job_id}` : `/field/visits/${v.id}`)}
                    >
                      <span style={{ width: 4, alignSelf: "stretch", borderRadius: 4, background: v.crew_color || "var(--fill-3)" }} aria-hidden="true" />
                      <span className="tabular" style={{ width: 76, fontWeight: 700, fontSize: 13 }}>{v.starts_at ? time(v.starts_at) : "Anytime"}</span>
                      <span className="grow">
                        <span className="strong ellipsis" style={{ display: "block" }}>{v.title}</span>
                        <span className="muted small ellipsis" style={{ display: "block" }}>
                          {[v.client, v.address, v.crew].filter(Boolean).join(" · ") || statusLabel(v.kind)}
                        </span>
                        {v.hold_reason && <span className="small" style={{ color: "var(--warning)", fontWeight: 700 }}>Weather: {v.hold_reason.split(";")[0]}</span>}
                      </span>
                      <StatusPill label={statusLabel(v.status)} tone={visitTone(v.status)} />
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="narrow stack" aria-labelledby="perf-title">
              <h2 id="perf-title" className="section-title">{seesMoney ? "Business performance" : "Needs attention"}</h2>
              {seesMoney && (
                <div className="card card-pad stack-sm">
                  <div className="muted small strong">Collected this month</div>
                  <div className="row" style={{ alignItems: "baseline", gap: 10 }}>
                    <AnimatedNumber value={data.month.collected} format={MONEY} className="hero-number" />
                    <Trend now={data.month.collected} before={data.month.collected_last} />
                  </div>
                  {collected.data && (
                    <div className="stack-sm" style={{ gap: 4, margin: "2px 0 6px" }}>
                      <LazySparkline
                        data={collected.data}
                        height={56}
                        format={formatMoney}
                        config={{ now: { label: "This month", color: "var(--green)" }, before: { label: "Last month", color: "var(--text-4)", dashed: true } }}
                      />
                      <div className="spark-legend" aria-hidden="true"><span><i />This month</span><span><i className="dashed" />Last month</span></div>
                    </div>
                  )}
                  <div className="row-between small muted"><span>Invoiced this month</span><AnimatedNumber value={data.month.invoiced} format={MONEY} className="strong ink" /></div>
                  <div className="row-between small muted"><span>Quotes won ({data.month.won_count})</span><AnimatedNumber value={data.month.won} format={MONEY} className="strong ink" /></div>
                </div>
              )}
              {seesMoney && (
                <div className="card">
                  <div className="card-pad" style={{ paddingBottom: 8 }}>
                    <div className="row-between">
                      <strong>Receivables</strong>
                      <Link to="/invoices" className="small strong">All invoices</Link>
                    </div>
                    <div className="muted small" style={{ marginTop: 10 }}>{data.receivables.clients_owing} {data.receivables.clients_owing === 1 ? "client owes" : "clients owe"} you</div>
                    <AnimatedNumber value={data.receivables.total} format={MONEY} className="hero-number" />
                  </div>
                  {data.receivables.top.map((row) => (
                    <Link key={row.client_id} to={`/clients/${row.client_id}`} className="card-row" style={{ padding: "10px 20px", fontSize: 13 }}>
                      <span className="grow ellipsis">{row.client}</span>
                      <span className="tabular strong">{formatMoneyCompact(row.owed)}</span>
                    </Link>
                  ))}
                </div>
              )}
              <div className="card">
                <div className="card-head"><strong>Needs attention</strong>{attention.length > 0 && <span className="badge">{attention.length}</span>}</div>
                {attention.length === 0 ? (
                  <EmptyState icon="check" title="All clear" compact />
                ) : (
                  attention.map((item, i) => (
                    <Link key={`${item.link}-${i}`} to={item.link} className="card-row">
                      <span className="n-icon" style={{ width: 30, height: 30, borderRadius: 9, display: "grid", placeItems: "center", background: item.kind === "invoice" ? "var(--danger-tint)" : item.kind === "equipment" ? "var(--warning-tint)" : "var(--fill-2)", color: item.kind === "invoice" ? "var(--danger)" : item.kind === "equipment" ? "var(--warning)" : "var(--text-2)", flex: "none" }}>
                        <Icon name={ATTENTION_ICON[item.kind] ?? "alert"} size={15} />
                      </span>
                      <span className="grow">
                        <span className="strong text-sm" style={{ display: "block" }}>{item.title}</span>
                        {item.detail && <span className="muted small ellipsis" style={{ display: "block" }}>{item.detail}</span>}
                      </span>
                      <Icon name="chevronRight" size={16} />
                    </Link>
                  ))
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}

/** Running total collected this month, day by day, beside last month's. */
function useCollectedTrend(enabled: boolean) {
  const { company } = useSession();
  const tz = company.timezone;
  const today = todayIn(tz);
  return useQuery({
    queryKey: ["dashboard", company.id, "collected", today],
    enabled,
    refetchInterval: 60_000,
    meta: { silent: true },
    queryFn: async () => {
      const [y, m] = today.split("-").map(Number) as [number, number];
      const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      const rows = unwrap(await supabase().from("payments").select("amount, received_at").eq("company_id", company.id).gte("received_at", zonedTimeToUtc(lastMonth, "00:00", tz).toISOString()).limit(5000));
      return monthToDate(rows, today, tz);
    },
  });
}

function Trend({ now, before }: { now: number; before: number }) {
  if (!before) return null;
  const change = Math.round(((now - before) / before) * 100);
  const up = change >= 0;
  return (
    <span className={`chip ${up ? "chip-green" : "chip-red"}`} title="Compared with all of last month">
      {up ? "▲" : "▼"} {Math.abs(change)}% vs last month
    </span>
  );
}

function HomeSkeleton({ office }: { office: boolean }) {
  return (
    <Loading label="Loading your day">
      <div className="stack-lg">
        {office && (
          <div className="stack">
            <Skeleton width={120} height={20} />
            <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 24, padding: 24 }}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="stack-sm">
                  <Skeleton width={90} height={12} />
                  <Skeleton width={60} height={30} />
                  <Skeleton width="70%" height={12} />
                  <Skeleton width="85%" height={10} />
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="two-col">
          <div className="wide stack">
            <Skeleton width={220} height={20} />
            <div className="card">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="card-row">
                  <Skeleton width={60} height={12} />
                  <span className="grow stack-sm"><Skeleton width="55%" height={13} /><Skeleton width="35%" height={10} /></span>
                  <Skeleton width={84} height={22} radius={999} />
                </div>
              ))}
            </div>
          </div>
          <div className="narrow stack">
            <Skeleton width={200} height={20} />
            <CardSkeleton lines={3} />
            <CardSkeleton lines={4} />
          </div>
        </div>
      </div>
    </Loading>
  );
}
