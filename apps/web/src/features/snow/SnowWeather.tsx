/**
 * Snow → Weather: the weather in detail at the business's own shop, or at a snow customer picked
 * there, in a popup over the Snow page, laid out the
 * way phone weather apps are: a sky the color of the weather with the temperature large on it, then
 * cards for the hours, the snow piling up, the days ahead, and the wind and cold, each arriving a
 * beat after the last. What a plow run is planned by comes first: the snow from 6pm today through
 * tomorrow, which the alerts go by, against the customer's trigger (the shop has none). On a phone it's a sheet from the
 * bottom of the screen, a column of the same cards.
 *
 * The forecast comes through the API (GET /api/snow/weather, PlaceWeather), from whichever source
 * the business chose, and the popup credits it. The weather pictures are Meteocons
 * (assets/weather/README.md).
 */
import { WEATHER_SOURCE_LABELS, type PlaceWeather, type Sky } from "@crewtavo/core/weather";
import { useQuery } from "@tanstack/react-query";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import { CHART_MOTION, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/Chart";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Dialog } from "@/components/ui/Dialog";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { addDaysIso, addressLine, formatDay } from "@/lib/format";
import { shopPlace } from "@/lib/maps";
import { useSession } from "@/lib/session";
import { customer, inches, located, type Site } from "./snowData";
import styles from "./SnowWeather.module.css";

export type Weather = PlaceWeather & { tomorrow: string; snow_by_tomorrow_in: number | null };
type Hour = PlaceWeather["hours"][number];

const MOVING = import.meta.glob<string>("../../assets/weather/animated/*.svg", { eager: true, query: "?url", import: "default" });
const STILL = import.meta.glob<string>("../../assets/weather/static/*.svg", { eager: true, query: "?url", import: "default" });

/** Each sky in words, its picture by day and (where the night has its own) by night, and which backdrop it gets. */
export const SKY: Record<Sky, { label: string; art: string; night?: string; backdrop: keyof typeof BACKDROPS }> = {
  clear: { label: "Clear", art: "clear-day", night: "clear-night", backdrop: "clear" },
  partly_cloudy: { label: "Partly cloudy", art: "partly-cloudy-day", night: "partly-cloudy-night", backdrop: "clear" },
  cloudy: { label: "Cloudy", art: "overcast", backdrop: "cloudy" },
  fog: { label: "Fog", art: "fog", backdrop: "fog" },
  drizzle: { label: "Drizzle", art: "drizzle", backdrop: "rain" },
  rain: { label: "Rain", art: "rain", backdrop: "rain" },
  freezing_rain: { label: "Freezing rain", art: "sleet", backdrop: "snow" },
  snow: { label: "Snow", art: "snow", backdrop: "snow" },
  storm: { label: "Thunderstorms", art: "thunderstorms", backdrop: "storm" },
};
/**
 * The sky's colors by day and by night: top, bottom, and a glow in one corner that gives it some
 * depth. White type reads on all of them (4.5:1 or better, the glow included).
 */
export const BACKDROPS = {
  clear: { day: ["#1c5aa6", "#3378c4", "rgba(255, 255, 255, 0.1)"], night: ["#0b1440", "#2a3a80", "rgba(120, 150, 255, 0.22)"] },
  cloudy: { day: ["#44586f", "#5f758c", "rgba(255, 255, 255, 0.08)"], night: ["#1a2542", "#3a4c70", "rgba(130, 160, 235, 0.2)"] },
  snow: { day: ["#40587a", "#5d7898", "rgba(255, 255, 255, 0.08)"], night: ["#16264a", "#42598a", "rgba(150, 180, 255, 0.2)"] },
  rain: { day: ["#324a63", "#4f6a84", "rgba(255, 255, 255, 0.08)"], night: ["#141f33", "#31466a", "rgba(120, 150, 220, 0.18)"] },
  fog: { day: ["#4d5964", "#6a7682", "rgba(255, 255, 255, 0.06)"], night: ["#1c2229", "#3d4853", "rgba(180, 190, 200, 0.14)"] },
  storm: { day: ["#23263b", "#4a4f6c", "rgba(150, 140, 220, 0.18)"], night: ["#23263b", "#4a4f6c", "rgba(150, 140, 220, 0.18)"] },
} as const;
// A day's temperatures run cold to warm through freezing, the one that matters for snow and ice.
const COLD = "#6db6ff";
const FREEZING = "#eaf2fa";
const WARM = "#ffb54a";
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

const skyLabel = (sky: Sky, night = false) => (sky === "clear" && !night ? "Sunny" : SKY[sky].label);
const deg = (n: number | null) => (n == null ? "—" : `${Math.round(n)}°`);
const mph = (n: number | null) => (n == null ? "—" : `${Math.round(n)} mph`);
const hourOf = (time: string) => Number(time.slice(11, 13));
export const hourLabel = (time: string) => `${hourOf(time) % 12 || 12} ${hourOf(time) < 12 ? "AM" : "PM"}`;
const dayLabel = (date: string) => new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
export const when = (h: Hour) => `${dayLabel(h.time)} ${hourLabel(h.time)}`;
const sum = (numbers: number[]) => numbers.reduce((total, n) => total + n, 0);
/** The one with the most of something, or undefined for none. */
const most = <T,>(rows: T[], of: (row: T) => number | null) => rows.reduce<T | undefined>((best, row) => ((of(row) ?? -Infinity) > (best ? of(best) ?? -Infinity : -Infinity) ? row : best), undefined);

/** The sky as a picture. `moving` for the one large one; the many small ones stay still, as does it for someone who asked for less motion. */
export function SkyArt({ sky, night, size, moving, label }: { sky: Sky; night?: boolean; size: number; moving?: boolean; label?: string }) {
  const name = (night && SKY[sky].night) || SKY[sky].art;
  const still = STILL[`../../assets/weather/static/${name}.svg`];
  if (!moving) return <img src={still} width={size} height={size} alt={label ?? ""} loading="lazy" />;
  return (
    <picture>
      <source srcSet={still} media="(prefers-reduced-motion: reduce)" />
      <img src={MOVING[`../../assets/weather/animated/${name}.svg`]} width={size} height={size} alt={label ?? ""} />
    </picture>
  );
}

function Card({ icon, title, children, className }: { icon: IconName; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`${styles.glass}${className ? ` ${className}` : ""}`}>
      <h2 className={styles.head}><Icon name={icon} size={14} />{title}</h2>
      {children}
    </section>
  );
}

/** Where the forecasts come from, by source, for the credit under the sky. */
export const SOURCE_LINKS = { open_meteo: "https://open-meteo.com/", open_meteo_commercial: "https://open-meteo.com/", nws: "https://www.weather.gov/" } as const;

/** In place of a job: the business's own shop (Settings → Company). */
export const SHOP = "shop";
/** Whether the shop is on the map, so its weather can be had. */
export const hasShop = (company: Parameters<typeof shopPlace>[0]) => shopPlace(company)?.lat != null;
/** The weather at `place`, a job's or the shop's (GET /api/snow/weather), kept under one key wherever it's shown. */
export const weatherQuery = (companyId: string, place: string | null) => ({
  enabled: Boolean(place),
  queryKey: ["snow", companyId, "weather", place],
  staleTime: 15 * 60_000,
  queryFn: () => api.get<Weather>(place === SHOP ? "/snow/weather" : `/snow/weather?job=${place}`),
});

/**
 * The weather at the shop, or at one of the snow customers (`place`: its job, or SHOP), with the
 * others a pick away. With no shop on the map it's a customer's.
 */
export function WeatherDialog({ sites, place, onPick, onClose }: { sites: Site[]; place: string; onPick: (place: string) => void; onClose: () => void }) {
  const { company } = useSession();
  const shop = hasShop(company) ? shopPlace(company) : null;
  const places = sites.filter(located).sort((a, b) => customer(a).localeCompare(customer(b)));
  const site = places.find((s) => s.job_id === place) ?? (shop ? undefined : places[0]);
  const at = site ? site.job_id : shop ? SHOP : null;
  const weather = useQuery(weatherQuery(company.id, at));
  const w = weather.data;
  const backdrop = w ? BACKDROPS[SKY[w.now.sky].backdrop][w.now.night ? "night" : "day"] : null;
  return (
    <Dialog open onClose={onClose} title="Weather" size="xl" focusField={false} className={styles.dialog}>
      <div className={styles.body}>
        {places.length + (shop ? 1 : 0) > 1 && <PlacePicker shop={Boolean(shop)} places={places} at={at} onPick={onPick} />}
        {!at ? (
          <p className="muted">The weather is shown at your shop, once its address is in Settings → Company, and at a snow customer's property, once its address is on the map.</p>
        ) : weather.error && !w ? (
          <ErrorState error={weather.error} onRetry={() => weather.refetch()} />
        ) : !w || !backdrop ? (
          <div className={styles.loading}><Skeleton width="40%" /><Skeleton width="70%" /><Skeleton width="55%" /></div>
        ) : (
          <>
            {/* Keyed by the place, so picking another plays the arrival again. */}
            <div key={at} className={styles.sky} style={{ "--sky-top": backdrop[0], "--sky-bottom": backdrop[1], "--sky-glow": backdrop[2] } as CSSProperties}>
              <Now w={w} name={site ? customer(site) : "Your shop"} address={addressLine(site ? site.job.property : { line1: shop?.line1, city: shop?.city })} />
              <SnowComing w={w} trigger={site ? Number(site.trigger_in) : null} jobId={site?.job_id} />
              <div className={styles.columns}>
                <div className={styles.stack}>
                  <Hours w={w} />
                  <PilingUp w={w} trigger={site ? Number(site.trigger_in) : null} />
                </div>
                <Days w={w} />
              </div>
              <Tiles w={w} />
            </div>
            <p className="muted small" style={{ textAlign: "center", margin: 0 }}>
              Forecast by <a href={SOURCE_LINKS[w.source]} target="_blank" rel="noreferrer">{WEATHER_SOURCE_LABELS[w.source]}</a>, checked again every 15 minutes while this is open. Weather pictures by <a href="https://meteocons.com/" target="_blank" rel="noreferrer">Meteocons</a>.
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Whose weather: a quiet button with the place's name, opening a menu of the shop and each snow
 * customer with a check by the one shown (a sheet on a phone), and a search once there are many.
 */
function PlacePicker({ shop, places, at, onPick }: { shop: boolean; places: Site[]; at: string | null; onPick: (place: string) => void }) {
  const [query, setQuery] = useState("");
  const site = places.find((s) => s.job_id === at);
  const current = site ? customer(site) : "Your shop";
  const q = query.trim().toLowerCase();
  const found = places.filter((s) => !q || `${customer(s)} ${s.job.property?.city ?? ""}`.toLowerCase().includes(q));
  const many = places.length > 8;
  const items: MenuEntry[] = [
    ...(shop && (!q || "your shop".includes(q)) ? [{ label: "Your shop", icon: "home" as const, checked: at === SHOP, onSelect: () => onPick(SHOP) }, ...(found.length ? [{ separator: true as const }] : [])] : []),
    ...found.map((s) => ({ label: customer(s), description: s.job.property?.city ?? undefined, icon: "pin" as const, checked: s.job_id === at, onSelect: () => onPick(s.job_id) })),
  ];
  return (
    <Menu
      items={items}
      label={`Whose weather: ${current}`}
      title="Whose weather"
      align="start"
      triggerClassName={`btn btn-ghost ${styles.picker}`}
      trigger={<><Icon name={site ? "pin" : "home"} size={16} /><span>{current}</span><Icon name="chevronDown" size={14} /></>}
      search={many ? { value: query, onChange: setQuery, placeholder: "Find a customer" } : undefined}
    />
  );
}

/** What it's doing now, large. */
function Now({ w, name, address }: { w: Weather; name: string; address: string }) {
  const today = w.days[0];
  return (
    <div className={styles.hero}>
      <div className={styles.place}>{name}</div>
      {address && <div className={styles.address}>{address}</div>}
      <div className={styles.reading}>
        <SkyArt sky={w.now.sky} night={w.now.night} size={104} moving />
        <span className={styles.temp}>{deg(w.now.temp_f)}</span>
      </div>
      <div className={styles.condition}>{skyLabel(w.now.sky, w.now.night)}</div>
      <div className={styles.highLow}>{today ? `H:${deg(today.temp_max_f)}  L:${deg(today.temp_min_f)}  ·  ` : ""}Feels like {deg(w.now.feels_f)}</div>
    </div>
  );
}

/** The number the alerts go by, as a bar that reaches the customer's trigger or doesn't. The shop has no trigger (null), so no bar. */
function SnowComing({ w, trigger, jobId }: { w: Weather; trigger: number | null; jobId?: string }) {
  const coming = w.snow_by_tomorrow_in;
  // Today's snow, counted the same way (from 6pm last night): a storm that's here now was
  // yesterday's "by tomorrow night". Today is the business's, as tomorrow is.
  const today = w.snow_by_day[addDaysIso(w.tomorrow, -1)] ?? 0;
  const reached = trigger != null && coming != null && coming >= trigger;
  // Room past the trigger, so a bar that reaches it visibly passes the line.
  const full = Math.max((trigger ?? 0) * 1.6, (coming ?? 0) * 1.15, 0.5);
  return (
    <section className={`${styles.glass} ${styles.snow}`}>
      <div>
        <div className={styles.kicker}><Icon name="snow" size={14} />Snow by tomorrow night</div>
        <div className={styles.amount}>{coming == null ? "—" : inches(coming)}</div>
        <div className={styles.note}>6pm today through {formatDay(`${w.tomorrow}T12:00:00`)}</div>
        {(today >= 0.05 || Boolean(w.now.snow_depth_in)) && (
          <div className={styles.note}>{[today >= 0.05 && `Today's snow: ${inches(today)}`, w.now.snow_depth_in ? `about ${inches(w.now.snow_depth_in)} on the ground now` : null].filter(Boolean).join(" · ")}</div>
        )}
      </div>
      {trigger != null && (
      <div>
        <div className={styles.gauge} role="img" aria-label={coming == null ? "No forecast" : `${inches(coming)} forecast against a trigger of ${inches(trigger)}`}>
          {coming != null && coming > 0 && <span className={styles.gaugeFill} data-reached={reached || undefined} style={{ width: `${Math.min(100, (coming / full) * 100)}%` }} />}
          <span className={styles.gaugeMark} style={{ left: `${(trigger / full) * 100}%` }} />
        </div>
        <div className={styles.gaugeText}>
          <span className={styles.verdict}>{coming == null ? "No forecast right now" : reached ? "Reaches the trigger: the crew is told" : `${inches(trigger - coming)} under the trigger`}</span>
          <span>Trigger {inches(trigger)} · <Link to={`/snow?edit=${jobId}`} replace>Change</Link></span>
        </div>
      </div>
      )}
    </section>
  );
}

/** The next 48 hours' snow in a sentence: when it starts, when it's heaviest, and how much by when. */
export function snowStory(hours: Hour[]): string {
  const snowy = hours.filter((h) => h.snow_in > 0);
  const hardest = most(snowy, (h) => h.snow_in);
  if (!snowy.length || !hardest) return "No snow in the next 48 hours.";
  return `${snowy[0] === hours[0] ? "Snow is falling now" : `Snow starts around ${when(snowy[0]!)}`}, heaviest around ${when(hardest)} at ${inches(hardest.snow_in)} an hour. About ${inches(sum(snowy.map((h) => h.snow_in)))} by ${when(snowy[snowy.length - 1]!)}.`;
}

/** The next 48 hours in a row to scroll through: the sky, the snow that hour and the temperature. */
function Hours({ w }: { w: Weather }) {
  return (
    <Card icon="clock" title="Hourly forecast">
      <p className={styles.summary}>{snowStory(w.hours)}</p>
      <div className={styles.hours} role="list">
        {w.hours.map((h, i) => {
          const falling = h.snow_in >= 0.05 ? inches(h.snow_in) : "";
          return (
            <div key={h.time} role="listitem" className={styles.hour} data-new-day={(i > 0 && hourOf(h.time) === 0) || undefined} aria-label={`${i === 0 ? "Now" : when(h)}: ${deg(h.temp_f)}, ${skyLabel(h.sky, h.night)}${falling ? `, ${falling} of snow` : ""}`}>
              <span className={styles.when}>{i === 0 ? "Now" : hourOf(h.time) === 0 ? dayLabel(h.time) : hourLabel(h.time)}</span>
              <SkyArt sky={h.sky} night={h.night} size={36} />
              <span className={styles.falling}>{falling}</span>
              <span className={styles.hourTemp}>{deg(h.temp_f)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** The snow adding up from now, hour by hour, with the trigger (a customer's) as a line it crosses or stays under. */
function PilingUp({ w, trigger }: { w: Weather; trigger: number | null }) {
  let total = 0;
  const data = w.hours.map((h, i) => {
    total += h.snow_in;
    return { at: i === 0 ? "Now" : when(h), total: Math.round(total * 100) / 100 };
  });
  const crossed = trigger == null ? undefined : data.find((d) => d.total >= trigger);
  const top = Math.ceil(Math.max(total, trigger ?? 0) * 1.2 * 2) / 2;
  if (total <= 0) return null;
  return (
    <Card icon="snow" title="Snow piling up">
      <p className={styles.summary}>
        {trigger == null ? `From now, ${inches(total)} in 48 hours.` : crossed ? `From now, it passes the ${inches(trigger)} trigger ${crossed.at === "Now" ? "right away" : `around ${crossed.at}`} and reaches ${inches(total)} in 48 hours.` : `From now, ${inches(total)} in 48 hours: under the ${inches(trigger)} trigger.`}
      </p>
      <div className={styles.chart}>
        <ChartContainer config={{ total: { label: "Snow since now", color: "#fff" } }} label={`Snow adding up over the next 48 hours${trigger == null ? "" : ", against the trigger"}`} height={190}>
          <AreaChart data={data} margin={{ top: 14, right: 0, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="at" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={28} />
            <YAxis orientation="right" width={48} tickLine={false} axisLine={false} tickMargin={8} tickCount={4} domain={[0, top]} tickFormatter={(n: number) => `${n} in`} />
            <ChartTooltip cursor={{ stroke: "rgba(255, 255, 255, 0.5)" }} isAnimationActive={false} content={<ChartTooltipContent labelKey="at" format={inches} indicator="line" />} />
            {trigger != null && <ReferenceLine y={trigger} stroke="#ffcf70" strokeWidth={2} strokeDasharray="5 5" label={{ value: `Trigger ${inches(trigger)}`, position: "insideBottomLeft", fill: "rgba(255, 255, 255, 0.9)", fontSize: 11, fontWeight: 700 }} />}
            <Area type="monotone" dataKey="total" stroke="var(--color-total)" strokeWidth={2} fill="var(--color-total)" fillOpacity={0.14} dot={false} activeDot={{ r: 4, stroke: "rgba(8, 15, 30, 0.6)", strokeWidth: 2 }} {...CHART_MOTION} />
          </AreaChart>
        </ChartContainer>
      </div>
    </Card>
  );
}

/** Day by day: its sky, its snow, and its low and high on one scale for the whole stretch. */
function Days({ w }: { w: Weather }) {
  const lo = Math.min(...w.days.flatMap((d) => (d.temp_min_f == null ? [] : [d.temp_min_f])));
  const hi = Math.max(...w.days.flatMap((d) => (d.temp_max_f == null ? [] : [d.temp_max_f])));
  const at = (temp: number) => (hi > lo ? Math.min(100, Math.max(0, ((temp - lo) / (hi - lo)) * 100)) : 50);
  const colors = lo >= 32 ? `linear-gradient(90deg, ${FREEZING}, ${WARM})` : hi <= 32 ? `linear-gradient(90deg, ${COLD}, ${FREEZING})` : `linear-gradient(90deg, ${COLD}, ${FREEZING} ${at(32)}%, ${WARM})`;
  return (
    <Card icon="calendar" title={`${w.days.length}-day forecast`}>
      <div role="list">
        {w.days.map((d, i) => (
          <div key={d.date} role="listitem" className={styles.day}>
            <span>{i === 0 ? "Today" : dayLabel(d.date)}</span>
            <SkyArt sky={d.sky} size={32} label={skyLabel(d.sky)} />
            <span className={styles.daySnow}>{d.snow_in > 0 ? inches(d.snow_in) : ""}</span>
            <span className={styles.low}>{deg(d.temp_min_f)}</span>
            <span className={styles.track} aria-hidden="true">
              {d.temp_min_f != null && d.temp_max_f != null && <span className={styles.span} style={{ background: colors, clipPath: `inset(0 ${100 - at(d.temp_max_f)}% 0 ${at(d.temp_min_f)}% round 999px)` }} />}
              {i === 0 && w.now.temp_f != null && <span className={styles.nowDot} style={{ left: `${at(w.now.temp_f)}%` }} />}
            </span>
            <span className={styles.high}>{deg(d.temp_max_f)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** The wind, the cold and the long view, a tile each. */
function Tiles({ w }: { w: Weather }) {
  const day = w.hours.slice(0, 24);
  const gust = most(day, (h) => h.gust_mph);
  const freezing = day.filter((h) => h.temp_f != null && h.temp_f <= 32).length;
  const coldest = most(day, (h) => (h.temp_f == null ? null : -h.temp_f));
  const total = sum(w.days.map((d) => d.snow_in));
  const biggest = most(w.days, (d) => d.snow_in);
  const from = w.now.wind_from_deg;
  const chill = w.now.feels_f != null && w.now.temp_f != null ? w.now.feels_f - w.now.temp_f : 0;
  return (
    <div className={styles.tiles}>
      <Card icon="wind" title="Wind" className={styles.tile}>
        <div className={styles.windRow}>
          <div className={styles.tileValue}>{mph(w.now.wind_mph)}</div>
          {from != null && (
            <div className={styles.compass} role="img" aria-label={`From the ${COMPASS[Math.round(from / 45) % 8]}`}>
              {/* The arrow points the way the wind is going. */}
              <span className={styles.needle} style={{ transform: `rotate(${(from + 180) % 360}deg)` }}><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l6 18-6-4.5L6 20z" fill="currentColor" /></svg></span>
            </div>
          )}
        </div>
        <div className={styles.tileNote}>{from != null ? `From the ${COMPASS[Math.round(from / 45) % 8]}. ` : ""}{gust?.gust_mph != null ? `Gusts to ${mph(gust.gust_mph)} around ${hourLabel(gust.time)}.` : ""}</div>
      </Card>
      <Card icon="thermometer" title="Feels like" className={styles.tile}>
        <div className={styles.tileValue}>{deg(w.now.feels_f)}</div>
        <div className={styles.tileNote}>{chill <= -3 ? "The wind makes it feel colder." : chill >= 3 ? "It feels warmer than it is." : "About what the thermometer says."}</div>
      </Card>
      <Card icon="snow" title="Freezing" className={styles.tile}>
        <div className={styles.tileValue}>{freezing} {freezing === 1 ? "hour" : "hours"}</div>
        <div className={styles.tileNote}>Of the next {day.length}, at or below 32°.{coldest ? ` Coldest ${deg(coldest.temp_f)} around ${hourLabel(coldest.time)}.` : ""}</div>
      </Card>
      <Card icon="cloudSnow" title={`${w.days.length}-day snow`} className={styles.tile}>
        <div className={styles.tileValue}>{inches(total)}</div>
        <div className={styles.tileNote}>{biggest && biggest.snow_in > 0 ? `Most on ${formatDay(`${biggest.date}T12:00:00`)}: ${inches(biggest.snow_in)}.` : "None expected."}</div>
      </Card>
    </div>
  );
}
