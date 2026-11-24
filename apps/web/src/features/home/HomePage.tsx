/**
 * Home (Page-Home.dc.html, Mobile-Work.dc.html): the date over a greeting, the workflow as a flat strip
 * of figures, then what needs someone as inbox rows and today's visits, with setup and the money in
 * the side column. A business's first visit, before there's any work (Setup-Flow.dc.html, Home, first
 * visit), is the setup checklist instead.
 */
import { monthFirst } from "@crewtavo/core/regional";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { AnimatedNumber, MONEY } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { DetailColumns } from "@/components/ui/DetailPage";
import { InboxList, InboxRow } from "@/components/ui/InboxList";
import { Icon, type IconName } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { Loading, SectionSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill, statusLabel, statusText, visitTone } from "@/components/ui/StatusPill";
import { openHelp } from "@/components/shell/Help";
import { api, supabase, unwrap } from "@/lib/api";
import { companyCountry, dateLocale, formatMoney, formatMoneyCompact, formatTime, todayIn } from "@/lib/format";
import { installApp, useInstallHint } from "@/lib/install";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { groupByEquipment, managesEquipment, nextUp, useEquipmentDue, usePaperwork } from "../equipment/equipmentData";
import { seesWebsite } from "../marketing/website";
import { InstallAppCard } from "../field/InstallAppCard";
import { askedFor, changeLink, usePendingChanges } from "../schedule/changeRequests";
import { ChangeLine } from "./ChangeLine";
import { collectedHistory, collectedSince } from "./collected";
import styles from "./Home.module.css";
import { SetupChecklist, useSetup, type Setup } from "./SetupCard";
import type { Dashboard } from "./types";
import { WebsiteSection } from "./WebsiteCard";
import type { Week } from "./weeks";
import { WorkflowStrip } from "./WorkflowStrip";

function greeting(timeZone: string) {
  const h = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone }));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

type Attention = Dashboard["attention"][number];

const ATTENTION_ICON: Record<string, IconName> = { quote: "quote", visit: "cloud", invoice: "invoice", equipment: "truck", autopay_failed: "card", autopay_approval: "card", visit_change: "calendar", request: "requests", roof: "roofing" };

/**
 * What each item's icon says, in its color only (the circle stays quiet): money that didn't come in
 * (a late invoice, an automatic charge that failed) red; things to see to soon (machines coming due, a
 * lead nobody has picked up, a charge waiting for your OK, changes asked for) amber; an approved quote
 * ready to become a job green. The rest, like a weather hold, stay grey.
 */
export function attentionLook(item: Pick<Attention, "kind" | "title">): { icon: IconName; tone?: "danger" | "warning" | "good" } {
  if (item.kind === "invoice" || item.kind === "autopay_failed") return { icon: ATTENTION_ICON[item.kind]!, tone: "danger" };
  if (item.kind === "quote" && /approved/i.test(item.title)) return { icon: "check", tone: "good" };
  if (item.kind === "quote" && /changes requested|not signed/i.test(item.title)) return { icon: "quote", tone: "warning" };
  if (["equipment", "request", "roof", "autopay_approval", "visit_change"].includes(item.kind)) return { icon: ATTENTION_ICON[item.kind]!, tone: "warning" };
  return { icon: ATTENTION_ICON[item.kind] ?? "alert" };
}

/** Nothing going on yet: no requests, quotes, jobs or invoices, no visits today and nothing to see to. */
export function nothingYet(data: Pick<Dashboard, "workflow" | "today">, attention: number): boolean {
  const { requests, quotes, jobs, invoices } = data.workflow;
  const counts = [requests.new, requests.assessment_complete, quotes.awaiting, quotes.approved ?? 0, quotes.draft, jobs.active, jobs.to_invoice, invoices.awaiting, invoices.draft];
  return counts.every((n) => !n) && data.today.total === 0 && attention === 0;
}

/** Weeks of bars under the collected figure; fewer weeks of money than this and it's the figure alone. */
const WEEKS = 6;
const MIN_WEEKS = 4;

export function HomePage() {
  const session = useSession();
  const tz = session.company.timezone;
  const isOffice = hasRole(session, "admin", "office", "estimator");
  const seesMoney = hasRole(session, "admin", "office") && can(session, "invoices");
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ["dashboard", session.company.id],
    queryFn: () => api.get<Dashboard>("/dashboard"),
    refetchInterval: 60_000,
  });
  const collected = useCollectedHistory(seesMoney);
  const setup = useSetup();
  const page = useRef<HTMLDivElement>(null);
  // Equipment overdue or coming due (maintenance, tags, inspection) joins the list for the people who look after it.
  const gear = useEquipmentDue(session.company.id, { enabled: managesEquipment(session) });
  const gearPapers = usePaperwork(session.company.id, { enabled: managesEquipment(session) });
  // Clients asking to move or cancel a visit, for whoever schedules (the database shows only those).
  const changes = usePendingChanges(hasRole(session, "admin", "office", "estimator", "crew_lead"));
  const attention = useMemo(() => {
    // Each machine's most urgent maintenance, and every piece of paperwork running out, overdue first.
    const plans = groupByEquipment(gear.data?.filter((r) => r.equipment_status === "active" && r.state !== "ok"));
    const papers = (gearPapers.data ?? []).filter((p) => p.equipment_status === "active" && p.state !== "ok").map((p) => ({ id: p.equipment_id, n: nextUp([], [p])!, machine: p.equipment_name }));
    const rows = [...papers, ...[...plans.values()].map((r) => ({ id: r[0].equipment_id, n: nextUp(r, [])!, machine: r[0].equipment_name }))].sort(
      (a, b) => Number(a.n.state !== "overdue") - Number(b.n.state !== "overdue"),
    );
    const items: Dashboard["attention"] = rows.slice(0, 3).map(({ id, n, machine }) => ({
      kind: "equipment",
      title: `${n.name} ${n.paper ? (n.state === "overdue" ? "expired" : "expiring") : n.state === "overdue" ? "overdue" : "coming due"}`,
      detail: `${machine} · ${n.summary}`,
      link: `/equipment/${id}`,
    }));
    if (rows.length > 3) items.push({ kind: "equipment", title: `${rows.length - 3} more equipment ${rows.length === 4 ? "reminder" : "reminders"}`, detail: null, link: "/equipment?show=due" });
    const asks: Dashboard["attention"] = (changes.data ?? []).slice(0, 5).map((r) => ({
      kind: "visit_change",
      title: `${r.client?.display_name ?? "A client"} asked ${askedFor(r, tz, session.company.settings)}`,
      detail: r.visit?.title ?? null,
      link: changeLink(r),
    }));
    return [...asks, ...(data?.attention ?? []), ...items];
  }, [data?.attention, gear.data, gearPapers.data, changes.data, tz, session.company.settings]);
  const firstName = session.profile.full_name.split(" ")[0] || "there";
  const today = new Date().toLocaleDateString(dateLocale(), { weekday: "long", month: "long", day: "numeric", timeZone: tz });

  // A first visit: setup is still to do and there's nothing else to show yet. While setup's own read
  // is under way on such a quiet Home, the page waits for it rather than changing under the person.
  const quiet = Boolean(data) && nothingYet(data!, attention.length);
  const fresh = quiet && setup.state === "ready";
  const waiting = isPending || (quiet && setup.state === "loading");
  useFirstArrival(page, Boolean(data) && !waiting);

  return (
    <>
      {fresh && setup.state === "ready" ? (
        <PageHeader
          title={`Welcome, ${firstName}`}
          documentTitle="Home"
          lede="A few things make Crewtavo yours. Most take a couple of minutes."
          actions={<Button icon="x" onClick={setup.hide}>Hide checklist</Button>}
        />
      ) : (
        <PageHeader
          title={`${greeting(tz)}, ${firstName}`}
          documentTitle="Home"
          actions={
            isOffice && (
              <>
                <Link className="btn" to="/requests?new=1"><Icon name="requests" size={16} />New request</Link>
                <Link className="btn btn-primary" to="/quotes?new=1"><Icon name="plus" size={16} />New quote</Link>
              </>
            )
          }
        >
          <p className={styles.date}>{today}</p>
        </PageHeader>
      )}

      {/* The crew's phones: Crewtavo as an app. The office isn't asked here (Settings has it). */}
      {!isOffice && <InstallAppCard />}

      {waiting && <HomeSkeleton office={isOffice} figures={seesMoney ? 4 : 3} />}
      {error && <ErrorState error={error} onRetry={() => refetch()} title="Couldn't load your dashboard" />}

      {data && !waiting && (
        <div ref={page} className={styles.contents}>
          {fresh && setup.state === "ready" ? (
            <FirstVisit setup={setup} />
          ) : (
            <>
              {isOffice && <WorkflowStrip workflow={data.workflow} showInvoices={seesMoney} />}
              <DetailColumns
                grouped
                className={isOffice ? undefined : styles.narrow}
                side={
                  (setup.state === "ready" || seesMoney || seesWebsite(session)) && (
                    <>
                      {setup.state === "ready" && <SetupSection setup={setup} />}
                      {seesMoney && <CollectedSection month={data.month} history={collected.data} />}
                      {seesMoney && <ReceivablesSection receivables={data.receivables} />}
                      {seesWebsite(session) && <WebsiteSection />}
                    </>
                  )
                }
              >
                {/* The office sees what needs someone first; a crew, their day. */}
                {isOffice && <AttentionSection items={attention} />}
                <TodaySection today={data.today} office={isOffice} />
                {!isOffice && attention.length > 0 && <AttentionSection items={attention} />}
              </DetailColumns>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** How many things Needs attention shows before Show all, so today's visits stay near the top (Page-Home.dc.html shows four). */
const ATTENTION_SHOWN = 6;

/** The first six things to see to, or every one once Show all is pressed (or when one more isn't worth a click). */
export function shownAttention<T>(items: readonly T[], all: boolean): { shown: readonly T[]; folds: boolean } {
  const folds = items.length > ATTENTION_SHOWN + 1;
  return { shown: folds && !all ? items.slice(0, ATTENTION_SHOWN) : items, folds };
}

/** Needs attention: one row each, the whole row opening the thing to see to; past six, Show all opens the rest. */
function AttentionSection({ items }: { items: Attention[] }) {
  const rows = useListAnimation<HTMLUListElement>();
  const [all, setAll] = useState(false);
  const { shown, folds } = shownAttention(items, all);
  return (
    <Section
      title="Needs attention"
      count={items.length || undefined}
      flush={items.length > 0}
      action={folds && <button type="button" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${items.length}`}</button>}
    >
      {items.length === 0 ? (
        <EmptyState inline title="All clear" />
      ) : (
        // Things handled elsewhere leave the list as it refreshes.
        <InboxList label="Needs attention" inset className={styles.attention}>
          <ul className="il-rows" role="list" aria-label="Needs attention" ref={rows}>
            {shown.map((item, i) => {
              const look = attentionLook(item);
              return (
                <InboxRow
                  key={`${item.link}-${i}`}
                  to={item.link}
                  title={item.title}
                  meta={item.detail ? [item.detail] : undefined}
                  avatar={<span className="rel-icon" data-tone={look.tone}><Icon name={look.icon} size={16} /></span>}
                  aside={<span className={styles.go} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>}
                />
              );
            })}
          </ul>
        </InboxList>
      )}
    </Section>
  );
}

/** Today's visits: the time and crew, the visit and where, its status. */
function TodaySection({ today, office }: { today: Dashboard["today"]; office: boolean }) {
  const { company } = useSession();
  const time = (iso: string) => formatTime(iso, company.timezone);
  const done = today.by_status.completed ?? 0;
  const going = today.by_status.in_progress ?? 0;
  const count = today.total > 0 ? `${done} of ${today.total} done${going ? ` · ${going} ${statusText("visit", "in_progress").toLowerCase()}` : ""}` : undefined;
  return (
    <Section
      title={<>Today<span className="hide-mobile">'s appointments</span></>}
      count={count}
      action={<Link to={office ? "/schedule" : "/field"}>{office ? "View schedule" : "My day"}</Link>}
      className={styles.today}
    >
      {today.visits.length === 0 ? (
        <EmptyState inline title="Nothing on the schedule today" action={office ? <Link className="btn" to="/schedule?new=1">Schedule a visit</Link> : undefined} />
      ) : (
        <RelatedList label="Today's appointments">
          {today.visits.map((v) => {
            const where = [v.client, v.address, v.crew].filter(Boolean);
            return (
              <RelatedRow
                key={v.id}
                to={office && v.job_id ? `/jobs/${v.job_id}` : `/field/visits/${v.id}`}
                lead={
                  <>
                    <span className="tabular">{v.starts_at ? time(v.starts_at) : "Anytime"}</span>
                    <span className={styles.crew} style={v.crew_color ? { background: v.crew_color } : undefined} aria-hidden="true" />
                  </>
                }
                title={v.title}
                sub={[
                  v.hold_reason && <span className={styles.hold}><Icon name="cloud" size={13} />Weather: {v.hold_reason.split(";")[0]}</span>,
                  ...(where.length ? where : [statusLabel(v.kind)]),
                ]}
                end={<StatusPill label={statusText("visit", v.status)} tone={visitTone(v.status)} />}
              />
            );
          })}
        </RelatedList>
      )}
    </Section>
  );
}

/** The checklist at the top of the side column, once there's work to show beside it. */
function SetupSection({ setup }: { setup: Extract<Setup, { state: "ready" }> }) {
  return (
    // Its check usually lands after the rest of Home, so it fades in rather than popping in.
    <Section
      title="Set up Crewtavo"
      count={`${setup.done} of ${setup.steps.length} done`}
      action={<button type="button" onClick={setup.hide}>Hide</button>}
      className={styles.fadeIn}
      flush
    >
      <SetupChecklist steps={setup.steps} done={setup.done} />
    </Section>
  );
}

/** A business's first visit (Setup-Flow.dc.html, Setup-Phone.dc.html): the checklist, and ways to bring work over. */
function FirstVisit({ setup }: { setup: Extract<Setup, { state: "ready" }> }) {
  const session = useSession();
  const install = useInstallHint();
  return (
    <DetailColumns
      grouped
      side={
        <Section title="Bring your work over">
          <RelatedList>
            <RelatedRow to="/clients" title="Import clients" sub="From a spreadsheet, or add them one at a time" />
            {session.role === "owner" && <RelatedRow to="/settings?tab=data" title="Bring your open work from Jobber" sub="Clients, quotes, jobs and invoices" />}
            {install === "prompt" && <RelatedRow onClick={() => void installApp().catch(() => undefined)} title="Get the app" sub="Crewtavo on this device, opened like any other app" />}
            <RelatedRow onClick={openHelp} title="Ask about Crewtavo" sub="Claude or ChatGPT, from Help" />
          </RelatedList>
        </Section>
      }
    >
      <SetupChecklist steps={setup.steps} done={setup.done} full />
    </DetailColumns>
  );
}

/** Collected this month against the same days of last month, a bar a week, and what was invoiced and won. */
function CollectedSection({ month, history }: { month: Dashboard["month"]; history?: { sameDaysLastMonth: number; weeks: Week[] } }) {
  const session = useSession();
  const seesFinance = hasRole(session, "admin", "office") && can(session, "reports") && can(session, "invoices");
  return (
    <Section title="Collected this month" action={seesFinance ? <Link to="/finance">Finance</Link> : undefined}>
      <div className={styles.panel}>
        <div className={styles.figure}><AnimatedNumber value={month.collected} format={MONEY} className={styles.big} /></div>
        {history && (
          <ChangeLine now={month.collected} before={history.sameDaysLastMonth} compared="the same days last month" same="Same as last month" vs={sameDaysLastMonth(todayIn(session.company.timezone))} />
        )}
        {history && history.weeks.length >= MIN_WEEKS && <WeekBars weeks={history.weeks} />}
        <dl className={styles.lines}>
          <div><dt>Invoiced this month</dt><dd><AnimatedNumber value={month.invoiced} format={MONEY} /></dd></div>
          <div><dt>Quotes won, {month.won_count}</dt><dd><AnimatedNumber value={month.won} format={MONEY} /></dd></div>
        </dl>
      </div>
    </Section>
  );
}

/** The days of last month this month so far is compared with: "Oct 1–21", "Feb 1–28" on the 31st, "Oct 1" on the 1st ("1–21 Oct" where the day comes first). */
export function sameDaysLastMonth(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m - 2, 1));
  const days = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
  const name = last.toLocaleDateString(dateLocale(), { month: "short", timeZone: "UTC" });
  const end = Math.min(d, days);
  const span = end === 1 ? "1" : `1–${end}`;
  return monthFirst(companyCountry()) ? `${name} ${span}` : `${span} ${name}`;
}

/** Who owes money, most first, and how much in all. */
function ReceivablesSection({ receivables }: { receivables: Dashboard["receivables"] }) {
  const owing = receivables.clients_owing;
  return (
    <Section
      title="Receivables"
      count={owing > 0 ? `${owing} ${owing === 1 ? "client owes" : "clients owe"} you ${formatMoney(receivables.total)}` : undefined}
      action={<Link to="/invoices">All invoices</Link>}
    >
      {receivables.top.length === 0 ? (
        <EmptyState inline title="Nobody owes you anything" />
      ) : (
        <RelatedList label="Clients who owe you" className={styles.owing}>
          {receivables.top.map((row) => (
            <RelatedRow key={row.client_id} to={`/clients/${row.client_id}`} title={row.client} end={<b>{formatMoney(row.owed)}</b>} />
          ))}
        </RelatedList>
      )}
    </Section>
  );
}

/** Home's sections have risen into place once this session, so later visits and refreshes don't repeat it. */
let arrived = false;

/**
 * The first time Home loads in a session, its figures and sections fade and rise 6px into place,
 * 30ms apart, in page order (only fade with Reduce Motion). Never on a refresh or on coming back.
 */
function useFirstArrival(ref: RefObject<HTMLElement | null>, ready: boolean) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!ready || arrived || !root) return;
    arrived = true;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frames = still ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }];
    // A section inside another moves with it.
    const items = [...root.querySelectorAll<HTMLElement>("[data-rise], .strip-item, .sec")].filter((el) => !el.parentElement?.closest("[data-rise], .sec"));
    // --dur-enter and --ease-enter.
    items.forEach((el, i) => el.animate?.(frames, { duration: 300, delay: i * 30, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "backwards" }));
  }, [ref, ready]);
}

/**
 * Payments since the earlier of the 1st of last month and the start of the bars' first week: this
 * month so far against the same days of last month, and the weeks for the bars.
 */
function useCollectedHistory(enabled: boolean) {
  const { company } = useSession();
  const tz = company.timezone;
  const today = todayIn(tz);
  return useQuery({
    queryKey: ["dashboard", company.id, "collected", today],
    enabled,
    refetchInterval: 60_000,
    meta: { silent: true },
    // Each day's total comes added up from the database (collected_by_day): there can be more payments than one request hands over.
    queryFn: async () =>
      collectedHistory(unwrap(await supabase().rpc("collected_by_day", { p_company: company.id, p_from: collectedSince(today, WEEKS), p_to: today })), today, tz, WEEKS),
  });
}

/** A bar a week, its date under it; the latest week's amount over its green bar, another week's on hover. */
function WeekBars({ weeks }: { weeks: Week[] }) {
  const max = Math.max(0, ...weeks.map((w) => w.total));
  const said = weeks.map((w, i) => `${i === weeks.length - 1 ? "this week so far" : `week of ${w.label}`} ${formatMoney(w.total)}`).join(", ");
  return (
    <figure className={styles.bars} role="img" aria-label={`Collected by week: ${said}`}>
      {weeks.map((w, i) => (
        <div key={w.from} className={styles.week} data-latest={i === weeks.length - 1 || undefined} aria-hidden="true">
          <span className={styles.track}>
            <span className={styles.amount}>{formatMoneyCompact(w.total)}</span>
            <span className={styles.bar} style={{ ["--h" as string]: max > 0 ? Math.max(0, w.total) / max : 0 }} />
          </span>
          <span className={styles.label}>{w.label}</span>
        </div>
      ))}
    </figure>
  );
}

/** The page's shape while the dashboard loads: the figures, then the sections, flat like the page. */
function HomeSkeleton({ office, figures }: { office: boolean; figures: number }) {
  return (
    <Loading label="Loading your day" className={styles.skeleton}>
      {office && <StatsSkeleton count={figures} />}
      <div className={office ? "detail-cols m-grouped" : `detail-cols detail-cols-one m-grouped ${styles.narrow}`}>
        <div className="detail-main">
          <SectionSkeleton rows={4} />
          <SectionSkeleton rows={3} />
        </div>
        {office && (
          <div className="detail-side">
            <SectionSkeleton rows={4} />
            <div className="sec" aria-hidden="true">
              <div className="sec-head"><Skeleton width="48%" height={13} /></div>
              <div className="sec-body"><Skeleton width={120} height={28} /></div>
            </div>
          </div>
        )}
      </div>
    </Loading>
  );
}
