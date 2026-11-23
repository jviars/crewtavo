/**
 * Snow → Storm: the storm, and what's left to do about it (App-Snow.dc.html). On top, the snow coming
 * from 6pm today through tomorrow on a sky the color of the weather (as the weather popup is,
 * SnowWeather.tsx): how much at the customers, when it falls hour by hour at the shop (or at a
 * customer picked there), and the official winter alerts in force. Then the storm in figures. Under
 * them, a storm that's here today: how far along each customer's visits are, and any customer it now
 * calls for that nobody scheduled, to schedule for today. Then the storm coming, as inbox rows piled
 * by what the office still has to do: to schedule, to check, scheduled, and (folded away) not this
 * storm (storm.ts), which the business can have Snow do by itself: the switch at the foot schedules
 * each storm as its people are told (set_snow_auto_schedule). A subcontractor's answer to "can you go
 * out?" sits beside their name on the customers they work. A customer's row opens it in a popup: its
 * address, notes, photos and files (SnowSiteDetails.tsx). On a phone the one thing to do, schedule
 * the storm, is pinned above the tab bar.
 */
import { snowPlan, type SnowPlan } from "@crewtavo/core/snow";
import { WEATHER_SOURCE_LABELS, type WeatherSource } from "@crewtavo/core/weather";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { ActionBar } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { InboxSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { SearchField } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { addDaysIso, addressLine, formatDateTime, formatDay, todayIn } from "@/lib/format";
import { can, useSession } from "@/lib/session";
import { autoKey, customer, inches, loadAuto, located, nameOf, rulesOf, type Member, type Site } from "./snowData";
import { BACKDROPS, SHOP, SKY, SOURCE_LINKS, hasShop, hourLabel, snowStory, weatherQuery, when } from "./SnowWeather";
import { answersTone, clearText, progressOf, standingOf, STORM_GROUPS, TODAY_GROUPS, todayGroup, triggersText, workText, type Standing, type StormGroup, type TodayGroup } from "./storm";
import page from "./snow.module.css";
import styles from "./StormBoard.module.css";

interface Alert { id: string; event: string; headline: string; area: string; severity: string; ends: string | null; description: string }
/** Tomorrow's storm at each customer by job (`inches`, for `date`), and today's own: what has fallen since 6pm last night and what's still coming by 6pm tonight. */
interface Forecast { date: string; source: WeatherSource; inches: Record<string, number | null>; alerts: Alert[]; today?: { date: string; inches: Record<string, number | null> } }

/** "Anchorage; Portage; Skilak Lake; ..." as its first two places and how many more: an alert can name a dozen. */
function areas(area: string): string {
  const places = area.split(";").map((p) => p.trim()).filter(Boolean);
  return places.length > 2 ? `${places.slice(0, 2).join(", ")} and ${places.length - 2} more` : places.join(", ");
}

const GROUP_TITLES: Record<StormGroup, string> = { schedule: "To schedule", check: "Needs a look", scheduled: "Scheduled", off: "Not this storm" };
const TODAY_TITLES: Record<TodayGroup, string> = { schedule: "To schedule today", late: "Late", going: "Under way", done: "Done" };
/** Who works a customer: its crew's lead and members, and the people listed on it. */
const workers = (s: Site) => new Set([s.job.crew?.lead_user_id, ...(s.job.crew?.members ?? []).map((m) => m.user_id), ...s.people.map((p) => p.user_id)].filter((id): id is string => Boolean(id)));
/** First priority first, then the earliest promise, then by name. */
const inOrder = (a: Site, b: Site) => a.priority - b.priority || (a.clear_by ?? "99").localeCompare(b.clear_by ?? "99") || customer(a).localeCompare(customer(b));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const TODAY_FIELDS = "job_id, kind, pushes, job:jobs!inner(title, client:clients(display_name), property:properties(line1, city)), visits:snow_visits(visit:visits(id, status))";

export function StormBoard({ sites: all, team, onWeather }: { sites: Site[]; team: Member[]; onWeather: (place: string) => void }) {
  const session = useSession();
  const { company } = session;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showOff, setShowOff] = useState(false);
  const term = useDeferredValue(search.trim().toLowerCase());
  const members = new Map(team.map((m) => [m.user_id, m]));
  const forecast = useQuery({ queryKey: ["snow", company.id, "forecast"], staleTime: 30 * 60_000, queryFn: () => api.get<Forecast>("/snow/forecast") });
  const date = forecast.data?.date;
  // The storm's visits for tomorrow, by job: they read Scheduled, and aren't scheduled twice.
  const booked = useQuery({
    enabled: Boolean(date),
    queryKey: ["snow", company.id, "booked", date],
    queryFn: async () => {
      const rows = unwrap(await supabase().from("snow_visits").select("job_id, visit:visits!inner(status)").eq("company_id", company.id).eq("snow_date", date!).neq("visit.status", "cancelled"));
      return rows.reduce<Record<string, number>>((count, r) => ({ ...count, [r.job_id]: (count[r.job_id] ?? 0) + 1 }), {});
    },
  });
  // The subcontractors asked whether they can go out tomorrow, and what each said.
  const asked = useQuery({
    enabled: Boolean(date),
    queryKey: ["snow", company.id, "availability", date],
    queryFn: async () => unwrap(await supabase().from("snow_availability").select("user_id, can").eq("company_id", company.id).eq("snow_date", date!)),
  });
  const answers = new Map((asked.data ?? []).map((a) => [a.user_id, a.can]));
  // Whether storms schedule themselves as people are told, and the switch for it.
  const auto = useQuery({ queryKey: autoKey(company.id), queryFn: () => loadAuto(company.id) });
  const setAuto = useMutation({
    meta: { success: (on: boolean) => (on ? "Storms schedule themselves from now on" : "Storms wait for you to schedule them") },
    mutationFn: async (on: boolean) => unwrap(await supabase().rpc("set_snow_auto_schedule", { p_company: company.id, p_on: on })),
    onSuccess: (on) => queryClient.setQueryData(autoKey(company.id), on),
  });
  const today = useToday(all, forecast.data?.today);

  const rows = all.map((site) => {
    const snow = forecast.data?.inches[site.job_id] ?? null;
    const visits = booked.data?.[site.job_id] ?? 0;
    return { site, snow, visits, standing: standingOf({ paused: Boolean(site.job.paused_at), located: located(site), rules: rulesOf(site), told: site.alerted_on === date }, snow, visits, auto.data) };
  });
  type Row = (typeof rows)[number];
  const pile = (group: StormGroup) => rows.filter((r) => r.standing.group === group);
  const toSchedule = pile("schedule");
  const shown = rows
    .filter(({ site: s }) => !term || [customer(s), s.job.title, addressLine(s.job.property), s.job.crew?.name].some((v) => v?.toLowerCase().includes(term)))
    .sort((a, b) => inOrder(a.site, b.site));

  const schedule = useMutation({
    meta: { success: (r: { created: number }) => (r.created ? `Scheduled ${r.created} ${r.created === 1 ? "visit" : "visits"} for tomorrow` : "They were scheduled already") },
    mutationFn: () => api.post<{ created: number }>("/snow/schedule", { job_ids: toSchedule.map((r) => r.site.job_id) }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      queryClient.invalidateQueries({ queryKey: ["snow", company.id] });
    },
  });
  const visitsToGo = toSchedule.reduce((n, r) => n + r.standing.plan!.pushes - r.visits, 0);
  const scheduleThem = async () => {
    const ok = await confirm({
      title: `Schedule ${toSchedule.length === 1 ? customer(toSchedule[0]!.site) : `${toSchedule.length} customers`} for tomorrow?`,
      body: `${visitsToGo === 1 ? "One visit" : `${visitsToGo} visits`} tomorrow, with each job's crew and people on them. They're told they're going out, and a customer set to be told hears it's coming.`,
      confirmLabel: "Schedule",
    });
    if (ok) schedule.mutate();
  };

  if (all.length === 0) {
    return (
      // Add snow customer is the page header's green button, so it isn't repeated here.
      <EmptyState icon="snow" title="No snow customers yet">
        Add a job as a snow customer with the inches of snow that call for it. The day before, its crew and anyone else on it are told when the forecast from 6pm through the next day reaches it.
      </EmptyState>
    );
  }

  const scheduled = pile("scheduled");
  const check = pile("check");
  const off = pile("off");
  const yes = [...answers.values()].filter((a) => a === true).length;
  const no = [...answers].filter(([, a]) => a === false).map(([id]) => nameOf(members.get(id)));
  const waiting = [...answers.values()].filter((a) => a == null).length;
  // One green button: today's storm, when it has someone nobody's scheduled, comes before tomorrow's.
  const todayFirst = today.toSchedule.length > 0;
  const canScheduleTomorrow = toSchedule.length > 0 && Boolean(booked.data) && !term;

  /** A sub's answer after their name; nothing for someone who wasn't asked. */
  const answer = (userId: string) => {
    if (!answers.has(userId)) return "";
    const said = answers.get(userId);
    return said == null ? " · no answer yet" : said ? " · can go" : " · can't go";
  };
  /** The crew, then the people listed and any sub on the crew who was asked, each with their answer, in one line colored by those answers. */
  const crewLine = (s: Site) => {
    const listed = s.people.map((p) => p.user_id);
    const people = [...listed, ...[...workers(s)].filter((id) => answers.has(id) && !listed.includes(id))];
    if (!s.job.crew && !people.length) return <span className={cx("il-sub", page.crew)} data-tone="danger">No one assigned</span>;
    // Their own names here, short enough for the row's edge; a sub's business is in the tooltip.
    const line = (name: (id: string) => string) => [s.job.crew?.name, people.map((id) => `${name(id)}${answer(id)}`).join(", ")].filter(Boolean).join(" · ");
    const tone = answersTone(people.filter((id) => answers.has(id)).map((id) => answers.get(id) ?? null));
    return <span className={cx("il-sub", page.crew)} data-tone={tone} title={line((id) => nameOf(members.get(id)))}>{line((id) => (members.has(id) ? members.get(id)!.profile?.full_name || "Someone" : nameOf(undefined)))}</span>;
  };
  /** The right edge: how soon it's cleared, then who works it. */
  const aside = (s: Site | undefined) => (
    <>
      {s && <ClearBy site={s} />}
      {s ? crewLine(s) : null}
    </>
  );

  /** What sets it apart on its first line: the work it calls for, or what's wrong. */
  const badge = (standing: Standing, paused: boolean) => {
    if (standing.label === "No map location") return <span className="il-note" data-tone="danger"><Icon name="pin" size={13} />{standing.label}</span>;
    if (standing.tone === "warning" && standing.group !== "schedule") return <span className="il-note" data-tone="warning"><Icon name="alert" size={13} />{standing.label}</span>;
    if (standing.group === "schedule" && standing.label !== "To schedule") return <span className="il-note" data-tone="warning">{standing.label}</span>;
    if (standing.plan) return <span className={cx("il-num", page.wideOnly)}>{workText(standing.plan)}</span>;
    return paused ? <span className="il-num">Paused</span> : null;
  };

  const row = ({ site: s, snow, standing }: Row) => {
    const rules = rulesOf(s);
    // Room past the plow's trigger, so a bar that reaches it visibly passes the line.
    const full = Math.max(rules.trigger_in * 1.25, (snow ?? 0) * 1.1, 0.5);
    const reading = snow == null ? (located(s) && !s.job.paused_at ? "No forecast" : null) : (
      <span className={styles.reading}>
        <span className={styles.gauge} aria-hidden="true">
          {snow > 0 && <span className={styles.fill} data-reached={standing.plan ? true : undefined} style={{ width: `${Math.min(100, (snow / full) * 100)}%` }} />}
          {rules.salt_trigger_in != null && <span className={styles.mark} data-salt style={{ left: `${(rules.salt_trigger_in / full) * 100}%` }} />}
          <span className={styles.mark} style={{ left: `${(rules.trigger_in / full) * 100}%` }} />
        </span>
        {/* The forecast opens the weather there. */}
        <Link className={styles.inches} data-reached={standing.plan ? true : undefined} to={`/snow?weather=${s.job_id}`} replace title="See the weather here">{inches(snow)}</Link>
      </span>
    );
    return (
      <InboxRow
        key={s.job_id}
        to={`/snow?open=${s.job_id}`}
        replace
        title={customer(s)}
        square
        badge={badge(standing, Boolean(s.job.paused_at))}
        subject={addressLine(s.job.property) || s.job.title}
        // On a phone the work it calls for follows the forecast, so the name has the first line.
        meta={[reading, standing.plan && <span className={page.phoneOnly}>{workText(standing.plan)}</span>, <span className={page.wideOnly}>{triggersText(rules)}</span>, standing.note && <span className={page.wideOnly}>{standing.note}</span>]}
        aside={aside(s)}
      />
    );
  };

  /** The button that schedules the storm coming, in its pile's heading (or, on a phone, pinned at the foot). */
  const scheduleTomorrow = (phone = false) => (
    <Button
      size="sm"
      variant={todayFirst && !phone ? "secondary" : "primary"}
      icon={phone ? "calendarCheck" : undefined}
      className={phone ? undefined : todayFirst ? styles.words : cx(styles.go, "hide-mobile")}
      loading={schedule.isPending}
      onClick={scheduleThem}
    >
      {toSchedule.length === 1 ? (phone ? "Schedule it for tomorrow" : "Schedule it") : phone ? `Schedule all ${toSchedule.length} for tomorrow` : `Schedule all ${toSchedule.length}`}
    </Button>
  );

  const piles = STORM_GROUPS.map((group) => ({ group, rows: shown.filter((r) => r.standing.group === group) })).filter((p) => p.rows.length);
  // Folded away unless asked for, or a search finds something there.
  const offOpen = showOff || Boolean(term);
  return (
    <>
      {forecast.error && !forecast.data ? (
        <div className="callout callout-danger">
          <Icon name="alert" size={16} />
          <div className="grow">Tomorrow's forecast couldn't be loaded, so this page can't say who it calls for. Their people are still told when it does.</div>
          <Button size="sm" onClick={() => forecast.refetch()} loading={forecast.isFetching}>Try again</Button>
        </div>
      ) : forecast.data ? (
        <Coming forecast={forecast.data} rows={rows} canChange={can(session, "settings")} onWeather={onWeather} />
      ) : (
        <div className={styles.skyLoading} aria-hidden="true"><Skeleton width="30%" height={11} /><Skeleton width="22%" height={34} /><Skeleton width="55%" height={11} /></div>
      )}
      {forecast.data && (
        <StatStrip label="The storm coming" className="hide-mobile">
          <Stat label="To schedule" value={toSchedule.length} tone={toSchedule.length ? "warning" : undefined} note={toSchedule.length ? `${plural(visitsToGo, "visit", "visits")} for tomorrow` : scheduled.length ? "Everyone it calls for is scheduled" : "Nothing reaches a trigger"} />
          <Stat label="Scheduled" value={scheduled.length} note={scheduled.length ? `${plural(scheduled.reduce((n, r) => n + r.visits, 0), "visit", "visits")} on tomorrow's schedule` : "No visits yet"} />
          {check.length > 0 && <Stat label="Needs a look" value={check.length} note={[...new Set(check.map((r) => r.standing.label))].join(", ")} />}
          <Stat label="Not this storm" value={off.length} note="Under their triggers, or paused" />
          {answers.size > 0 && (
            <Stat label="Subcontractors in" value={<>{yes} <span className={styles.of}>of {answers.size}</span></>} note={no.length ? `${no.join(", ")} can't go` : waiting ? `${waiting} yet to answer` : "All of them can go"} />
          )}
        </StatStrip>
      )}
      {forecast.data && (
        // A phone's three figures (Mobile-Apps.dc.html): the two to act on, then the subs' answers or what needs a look.
        <StatStrip label="The storm coming" className={cx("mobile-only", styles.phoneStrip)}>
          <Stat label="To schedule" value={toSchedule.length} tone={toSchedule.length ? "warning" : undefined} />
          <Stat label="Scheduled" value={scheduled.length} />
          {answers.size > 0 ? (
            <Stat label="Subs in" value={<>{yes}<span className={styles.of}> of {answers.size}</span></>} />
          ) : check.length > 0 ? (
            <Stat label="Needs a look" value={check.length} />
          ) : (
            <Stat label="Not this storm" value={off.length} />
          )}
        </StatStrip>
      )}

      <TodayList today={today} aside={aside} />

      <div className={page.listHead}>
        <div className={page.listTitle}>
          <h2>Tomorrow</h2>
          {date && <span>6pm today through {formatDay(`${date}T12:00:00`)}</span>}
        </div>
        <SearchField value={search} onChange={setSearch} placeholder="Customer, address or crew" label="Search snow customers" />
      </div>
      {forecast.isPending ? (
        <InboxSkeleton rows={4} groups={2} />
      ) : shown.length === 0 ? (
        <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
      ) : (
        <InboxList label="Snow customers" inset className={cx(page.rows, styles.rows)} foot={<ListFoot>{plural(shown.length, "snow customer", "snow customers")}</ListFoot>}>
          {!forecast.data ? (
            <InboxGroup label="Snow customers" count={shown.length}>{shown.map(row)}</InboxGroup>
          ) : (
            piles.map(({ group, rows: mine }) =>
              group === "off" ? (
                <section key={group} className={cx("il-group", styles.fold)} aria-labelledby="snow-off-head">
                  <h2 className={cx("il-head", styles.foldHead)} id="snow-off-head">
                    <button type="button" aria-expanded={offOpen} onClick={() => setShowOff(!showOff)} disabled={Boolean(term)}>
                      <Icon name="chevronRight" size={14} />
                      <span>{GROUP_TITLES.off}</span>
                      <span className="il-count">{mine.length}</span>
                      <span className={styles.foldNote}>Under their triggers, or paused</span>
                    </button>
                  </h2>
                  {offOpen && <InboxGroup>{mine.map(row)}</InboxGroup>}
                </section>
              ) : (
                <InboxGroup
                  key={group}
                  label={GROUP_TITLES[group]}
                  count={mine.length}
                  tone={group === "check" ? "warning" : undefined}
                  icon={group === "check" ? "alert" : undefined}
                  end={group === "schedule" && canScheduleTomorrow ? scheduleTomorrow() : undefined}
                >
                  {mine.map(row)}
                </InboxGroup>
              ),
            )
          )}
        </InboxList>
      )}

      <label className={styles.auto}>
        <input type="checkbox" className="switch" checked={auto.data ?? false} disabled={auto.isPending || setAuto.isPending} onChange={(e) => setAuto.mutate(e.target.checked)} />
        <span>
          <span className={styles.autoTitle}>Schedule storms automatically</span>
          <span className={styles.autoHint}>
            When the forecast calls for a customer, its visits go on the schedule as its crew is told: from 10am to 10pm the day before, and on the day for a storm that came up overnight. A customer set to be told hears it's coming. A visit you cancel isn't made again unless the storm grows. Off: you schedule each storm here.
          </span>
        </span>
      </label>
      <p className={styles.footnote}>A storm is the snow from 6pm today through tomorrow, so one that comes in overnight counts whole.</p>

      {/* On a phone the storm to schedule is the thing to do: pinned within reach, today's before tomorrow's. */}
      {todayFirst ? (
        <ActionBar label="Schedule the storm">{today.button(true)}</ActionBar>
      ) : canScheduleTomorrow ? (
        <ActionBar label="Schedule the storm">{scheduleTomorrow(true)}</ActionBar>
      ) : null}
    </>
  );
}

/**
 * The snow coming, on its sky: how much at the customers, hour by hour at the shop (with no shop on
 * the map, where it's deepest), and the alerts in force. The weather pop-up picks another place.
 */
function Coming({ forecast, rows, canChange, onWeather }: { forecast: Forecast; rows: Array<{ site: Site; snow: number | null }>; canChange: boolean; onWeather: (place: string) => void }) {
  const { company } = useSession();
  const checked = rows.filter((r) => r.snow != null && !r.site.job.paused_at);
  const amounts = checked.map((r) => r.snow!);
  const most = Math.max(0, ...amounts);
  // Whose hours the sentence and the bars are: the shop's.
  const shop = hasShop(company);
  const places = rows.map((r) => r.site).filter(located).sort((a, b) => customer(a).localeCompare(customer(b)));
  const site = shop ? undefined : [...checked].sort((a, b) => b.snow! - a.snow!)[0]?.site ?? places[0];
  const at = site ? site.job_id : shop ? SHOP : null;
  const name = site ? customer(site) : "your shop";
  const weather = useQuery(weatherQuery(company.id, at));
  const w = weather.data;
  const snowing = most >= 0.05;
  const sky = snowing ? "snow" : w?.now.sky ?? "cloudy";
  // A snowy sky is the storm's own slate blue; any other, the weather popup's colors for it.
  const [top, bottom] = snowing ? ["#26374f", "#3d5677"] : BACKDROPS[SKY[sky].backdrop][w?.now.night ? "night" : "day"];
  // The storm's own hours: from 6pm today (or from now, once that's passed) to the end of tomorrow.
  const hours = (w?.hours ?? []).filter((h) => h.time >= `${addDaysIso(forecast.date, -1)}T18:00` && h.time < `${addDaysIso(forecast.date, 1)}T00:00`);
  const data = hours.map((h) => ({ time: h.time, at: when(h), snow: h.snow_in }));
  const peak = Math.max(0, ...data.map((d) => d.snow));
  // Today's own storm there: what has fallen since 6pm last night and what's still coming by 6pm tonight
  // (at the shop, the forecast's own count of today, as the weather popup has it).
  const today = (site ? forecast.today?.inches[site.job_id] : w?.snow_by_day[addDaysIso(forecast.date, -1)]) || 0;
  return (
    <section className={styles.sky} style={{ "--sky-top": top, "--sky-bottom": bottom } as CSSProperties} aria-label="The snow coming">
      <div className={styles.kicker}>At your customers, 6pm today through {formatDay(`${forecast.date}T12:00:00`)}</div>
      <div className={styles.credit}>
        Forecast by <a href={SOURCE_LINKS[forecast.source]} target="_blank" rel="noreferrer">{WEATHER_SOURCE_LABELS[forecast.source]}</a>
        {canChange && <> · <Link to="/settings?tab=weather">Change</Link></>}
      </div>
      <div className={styles.amount}>{!amounts.length ? "No forecast" : !snowing ? "No snow" : Math.min(...amounts) > most - 0.05 ? inches(most) : `Up to ${inches(most)}`}</div>
      <p className={styles.story}>
        {at && `At ${name}: `}
        {w ? `${today >= 0.05 ? `Today's snow: ${inches(today)}. ` : ""}${snowStory(w.hours)} ` : weather.isPending && at ? <Skeleton width={220} height={11} className={styles.storySkeleton} /> : ""}
        {at && (w || weather.error) && (
          <button type="button" className={styles.more} onClick={() => onWeather(at)}>
            {peak > 0 ? `Each hour at ${name}` : "See the weather"}<Icon name="chevronRight" size={13} />
          </button>
        )}
      </p>
      {at && peak > 0 && (
        <div className={styles.hourly}>
          <div className={styles.bars} role="img" aria-label={`Snow each hour at ${name}, from 6pm today through tomorrow. Most around ${data.find((d) => d.snow === peak)!.at}, ${inches(peak)} that hour.`}>
            {data.map((d) => (
              <span key={d.time} className={styles.bar} data-peak={d.snow >= peak * 0.88 || undefined} data-none={d.snow <= 0 || undefined} style={{ height: `${Math.max(4, (d.snow / peak) * 100)}%` }} title={`${d.at}: ${d.snow > 0 ? inches(d.snow) : "no snow"}`} />
            ))}
          </div>
          <div className={styles.marks} aria-hidden="true">
            {data.map((d, i) => Number(d.time.slice(11, 13)) % 6 === 0 && (
              <span key={d.time} style={{ left: `${((i + 0.5) / data.length) * 100}%` }} data-edge={i < data.length * 0.06 ? "start" : i > data.length * 0.94 ? "end" : undefined}>{markLabel(d.time)}</span>
            ))}
          </div>
        </div>
      )}
      {forecast.alerts.map((a) => (
        <details key={a.id} className={styles.alert}>
          <summary>
            <Icon name="alert" size={14} />
            <span><b>{a.event}</b>{a.ends ? ` until ${formatDateTime(a.ends, company.timezone)}` : ""}{a.area ? ` · ${areas(a.area)}` : ""}</span>
          </summary>
          <div className={styles.alertBody}>
            <p className={styles.alertText}>{a.description || a.headline}</p>
            {a.area && <p className={styles.fine}>For {a.area}.</p>}
            <p className={styles.fine}>From the US National Weather Service.</p>
          </div>
        </details>
      ))}
    </section>
  );
}

/** How soon a customer is cleared, on its row's right edge; a phone's leaves the rank to the popup (Mobile-Apps.dc.html, Snow). */
export function ClearBy({ site }: { site: Site }) {
  const full = clearText(site.clear_by, site.priority);
  const short = site.clear_by ? clearText(site.clear_by, 2) : full;
  if (!full) return null;
  if (short === full) return <span className={page.clear}>{full}</span>;
  return (
    <span className={page.clear}>
      <span className={page.wideOnly}>{full}</span>
      <span className={page.phoneOnly}>{short}</span>
    </span>
  );
}

/** An hour mark under the bars: "6 PM", and midnight and noon by name. */
const markLabel = (time: string) => (time.slice(11, 13) === "00" ? "Midnight" : time.slice(11, 13) === "12" ? "Noon" : hourLabel(time));

/**
 * Today's own storm: each customer it was scheduled for, with how far along its visits are, and any
 * customer today's snow calls for that has fewer visits than that (it came up overnight, or grew),
 * to schedule for today in one click. Nothing with no storm today.
 */
function useToday(sites: Site[], snow: Forecast["today"]) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const today = todayIn(company.timezone);
  const storm = useQuery({
    queryKey: ["snow", company.id, "today", today],
    refetchInterval: 60_000,
    queryFn: async () => unwrap(await supabase().from("snow_events").select(TODAY_FIELDS).eq("company_id", company.id).eq("snow_date", today).limit(1000)),
  });
  const clock = new Date().toLocaleTimeString("en-GB", { timeZone: company.timezone, hour: "2-digit", minute: "2-digit" });
  const logged = new Map((storm.data ?? []).map((e) => [e.job_id, e]));
  const rows = storm.isPending ? [] : [...new Set([...logged.keys(), ...sites.map((s) => s.job_id)])].flatMap((jobId) => {
    const e = logged.get(jobId);
    const site = sites.find((s) => s.job_id === jobId);
    const visits = (e?.visits ?? []).flatMap((v) => (v.visit && v.visit.status !== "cancelled" ? [v.visit] : []));
    const fell = snow?.inches[jobId] ?? null;
    const plan = site && !site.job.paused_at ? snowPlan(rulesOf(site), fell) : null;
    // How many more visits today's snow calls for than it has.
    const more = plan ? Math.max(0, plan.pushes - visits.length) : 0;
    // A storm nobody was sent out for, and that calls for nothing now, isn't under way: it's in the season's log.
    if (!visits.length && !more) return [];
    const work: SnowPlan = more && plan ? plan : { kind: e?.kind === "salt" ? "salt" : "plow", pushes: e?.pushes ?? 1 };
    const progress = progressOf(visits, site?.clear_by ?? null, clock);
    return [{ jobId, site, visits, more, fell, work, name: site ? customer(site) : e?.job.client?.display_name ?? e?.job.title ?? "", address: addressLine(site?.job.property ?? e?.job.property) || (site ?? e)?.job.title, progress, group: todayGroup({ visits: visits.length, more, progress }) }];
  });
  const toSchedule = rows.filter((r) => r.more > 0);
  const visitsToGo = toSchedule.reduce((n, r) => n + r.more, 0);
  const schedule = useMutation({
    meta: { success: (r: { created: number }) => (r.created ? `Scheduled ${r.created} ${r.created === 1 ? "visit" : "visits"} for today` : "They were scheduled already") },
    mutationFn: () => api.post<{ created: number }>("/snow/schedule", { job_ids: toSchedule.map((r) => r.jobId), day: "today" }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["schedule"] });
      queryClient.invalidateQueries({ queryKey: ["snow", company.id] });
    },
  });
  const scheduleThem = async () => {
    const ok = await confirm({
      title: `Schedule ${toSchedule.length === 1 ? toSchedule[0]!.name : `${toSchedule.length} customers`} for today?`,
      body: `${visitsToGo === 1 ? "One visit" : `${visitsToGo} visits`} today, with each job's crew and people on them. They're told they're going out, and a customer set to be told hears it's coming.`,
      confirmLabel: "Schedule",
    });
    if (ok) schedule.mutate();
  };
  /** Schedules today's storm: in its pile's heading, or (`phone`) pinned at the foot. */
  const button = (phone = false) => (
    <Button size="sm" variant="primary" icon={phone ? "calendarCheck" : undefined} className={phone ? undefined : cx(styles.go, "hide-mobile")} loading={schedule.isPending} onClick={scheduleThem}>
      {toSchedule.length === 1 ? "Schedule it for today" : `Schedule ${toSchedule.length} for today`}
    </Button>
  );
  return { date: today, rows, toSchedule, button };
}

function TodayList({ today, aside }: { today: ReturnType<typeof useToday>; aside: (s: Site | undefined) => ReactNode }) {
  const { rows } = today;
  if (!rows.length) return null;
  // Within a pile: first priority first, then the earliest promise.
  const ordered = [...rows].sort((a, b) => (a.site?.priority ?? 2) - (b.site?.priority ?? 2) || (a.site?.clear_by ?? "99").localeCompare(b.site?.clear_by ?? "99"));
  const out = rows.filter((r) => r.visits.length);
  return (
    <>
      <div className={page.listHead}>
        <div className={page.listTitle}>
          <h2>Today</h2>
          <span>{out.length ? `${out.filter((r) => r.progress.status === "completed").length} of ${out.length} done · ` : ""}{formatDay(`${today.date}T12:00:00`)}</span>
        </div>
      </div>
      <InboxList label="Today's storm" inset className={cx(page.rows, styles.rows)}>
        {TODAY_GROUPS.map((group) => {
          const mine = ordered.filter((r) => r.group === group);
          if (!mine.length) return null;
          return (
            <InboxGroup
              key={group}
              label={TODAY_TITLES[group]}
              count={mine.length}
              tone={group === "schedule" ? "warning" : group === "late" ? "danger" : undefined}
              icon={group === "late" ? "clock" : undefined}
              end={group === "schedule" ? today.button() : undefined}
            >
              {mine.map(({ jobId, site, visits, more, fell, work, name, address, progress }) => (
                <InboxRow
                  key={jobId}
                  // One that's still a snow customer opens in its popup; one that isn't any more goes to its job.
                  to={site ? `/snow?open=${jobId}` : `/jobs/${jobId}`}
                  replace={Boolean(site)}
                  title={name}
                  square
                  badge={<span className={cx("il-num", page.wideOnly)}>{workText(work)}</span>}
                  subject={address}
                  meta={[
                    // On a phone the work it calls for leads this line, so the name has the first one.
                    <span className={page.phoneOnly}>{workText(work)}</span>,
                    // The pile says to schedule, late or done; under way, where it's got to.
                    group === "going" && <EntityStatus kind="visit" status={progress.status} />,
                    !visits.length
                      ? fell != null && `${inches(fell)} today, and nobody's scheduled`
                      : (progress.late || progress.note) && [progress.late && (progress.status === "scheduled" ? "Not started" : statusText("visit", progress.status)), progress.note].filter(Boolean).join(" · "),
                    visits.length > 0 && more > 0 && <span className={styles.grew}>The storm grew: {more} more to schedule</span>,
                    ...visits.flatMap((v, i) => (v.status === "completed" ? [<Link key={v.id} className={styles.report} to={`/snow/report/${v.id}`}>{visits.length > 1 ? `Report ${i + 1}` : "Service report"}</Link>] : [])),
                  ]}
                  aside={aside(site)}
                />
              ))}
            </InboxGroup>
          );
        })}
      </InboxList>
    </>
  );
}
