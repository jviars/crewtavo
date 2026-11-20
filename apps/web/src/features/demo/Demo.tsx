/**
 * The public demo (CREWTAVO_DEMO=1 on the server: apps/api/src/services/demo.ts). There's no
 * sign-in: the start screen asks what trade the visitor is in and gives them their own sample
 * business in it, and the bar above the app lets them see it as the crew or as a client, start over,
 * or go get Crewtavo.
 */
import { DEMO_HOURS, DEMO_TRADES, demoTradeFromLink } from "@crewtavo/core/demo";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { AuthLayout } from "@/features/auth/LoginPage";
import { searchTrades } from "@/features/auth/OnboardingPage";
import { SOURCE_URL, TERMS_VERSION } from "@/features/legal/License";
import { api, supabase } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { getLocale, msg, pickAtSignIn, T, t } from "@/lib/i18n";
import { useTurnstile } from "@/lib/publicApi";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import authStyles from "@/features/auth/auth.module.css";
import styles from "./demo.module.css";
import { DemoTour, GET_CREWTAVO, useDemoTour } from "./Tour";
/** The Terms as this version has them (the app bundles them too: features/legal/License.tsx). */
const TERMS = `${SOURCE_URL}/blob/main/TERMS`;

interface DemoSession {
  access_token: string;
  refresh_token: string;
}
interface PresetSummary { id: string; name: string; description: string }

/**
 * The other trades' names and descriptions as the server sends them (/api/presets), marked for the
 * Spanish catalog: "Something else" lists them through t().
 */
export const PRESET_TEXT = [
  msg("Cleaning & Janitorial"), msg("Maid service and house cleaning, deep cleans, move-outs, and office and commercial cleaning."),
  msg("Electrical"), msg("Service calls, outlets and wiring, lighting, panel upgrades, EV chargers and generator hookups."),
  msg("General / Other"), msg("A simple starting point for any service business."),
  msg("Handyman & Home Repair"), msg("Small repairs, installs, drywall and paint, carpentry and to-do lists, by the hour or the job."),
  msg("HVAC"), msg("Heating and air conditioning: tune-ups, repairs, system installs, ductwork and maintenance plans."),
  msg("Landscaping & Hardscaping"), msg("Landscape design, planting, mulch and sod, patios and walls, irrigation, and bed care plans."),
  msg("Lawn & Exterior Maintenance"), msg("Recurring mowing, seasonal services (leaves, snow, holiday lights), exterior cleaning and commercial grounds plans."),
  msg("Paving & Sitework"), msg("Residential, commercial and municipal paving, sealcoating, striping, grading, stonework, and subcontract work for general contractors."),
  msg("Pest Control"), msg("Monthly and quarterly pest plans, one-time treatments, termites, rodents, mosquitoes and wildlife."),
  msg("Plumbing"), msg("Repairs, drains and sewer lines, water heaters, fixtures and repipes for homes and businesses."),
  msg("Pool & Spa Service"), msg("Weekly pool service plans, openings and closings, green-pool cleanups, repairs and equipment."),
  msg("Roofing & Exteriors"), msg("Shingle and metal roofing, repairs, gutters, siding, windows and decks, with insurance claim details on quotes and jobs."),
];

const TRADE_ICONS: Record<string, IconName> = { lawn_exterior: "lawn", roofing_exteriors: "roofing", paving: "paving" };
const FEATURED = new Set<string>(DEMO_TRADES.map((t) => t.preset));

async function signInAs(session: DemoSession) {
  const { error } = await supabase().auth.setSession(session);
  if (error) throw error;
}

/** The trade a link from the website names (crewtavo.com's trade pages link to …/?trade=lawn). */
const linkedTrade = (() => {
  try {
    return new URLSearchParams(window.location.search).get("trade");
  } catch {
    return null;
  }
})();

/** Off the address once used, so a reload doesn't start another. */
function forgetLinkedTrade() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("trade") && !url.searchParams.has("start")) return;
  url.searchParams.delete("trade");
  url.searchParams.delete("start");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

/**
 * In place of the sign-in page: "What kind of work do you do?" Lawn care, roofing, paving, or
 * something else (any other trade preset). Picking one makes the visitor's business and signs them in.
 * `ended`: they were signed in to a demo that has since been deleted.
 */
export function DemoStart({ ended = false }: { ended?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<PresetSummary[]>("/presets"), staleTime: Infinity });
  const turnstile = useTurnstile(true);
  const started = useRef(false);
  /** A trade picked before the bot check was done: it starts once it is. */
  const [waiting, setWaiting] = useState<string | null>(null);

  async function start(trade: string) {
    if (started.current) return;
    if (turnstile.required && !turnstile.token) {
      setWaiting(trade);
      setError(null);
      return;
    }
    setWaiting(null);
    started.current = true;
    setBusy(trade);
    setError(null);
    try {
      const session = await api.post<DemoSession>("/demo/start", { trade, terms_version: TERMS_VERSION, turnstile_token: turnstile.token || undefined, locale: getLocale() });
      forgetLinkedTrade();
      // SessionProvider takes over once the session is set.
      await signInAs(session);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
      started.current = false;
      // A check is good once: ask for a new one.
      turnstile.reset();
    }
  }

  // Arriving from a trade's page on the website starts that trade's demo, and a trade picked before
  // the check was done starts as soon as it is.
  const linked = presets.data ? demoTradeFromLink(linkedTrade, presets.data.map((p) => p.id)) : null;
  useEffect(() => {
    const trade = waiting ?? (ended ? null : linked);
    if (trade && (!turnstile.required || turnstile.token)) void start(trade);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, waiting, turnstile.token]);

  const label = (id: string) => {
    const featured = DEMO_TRADES.find((d) => d.preset === id);
    return (featured ? t(featured.label) : t(presets.data?.find((p) => p.id === id)?.name ?? "")).toLowerCase();
  };
  const others = (presets.data ?? []).filter((p) => !FEATURED.has(p.id));
  const shown = search.trim() ? searchTrades(others, search) : others;

  return (
    <AuthLayout>
      {busy && (
        <div className={`card card-pad ${authStyles.card} ${styles.building}`} role="status" aria-live="polite">
          <span className={styles.spinner} aria-hidden="true" />
          <h1 className={authStyles.title}>{t("Setting up your {trade} business", { trade: label(busy) })}</h1>
          <p className="muted" style={{ margin: 0 }}>{t("Clients, quotes, this week's jobs and invoices, ready to click around in. It takes a few seconds.")}</p>
        </div>
      )}
      {/* Hidden, not gone, while the business is made: the bot check in it keeps its box for a start that fails. */}
      <div className={`card card-pad ${authStyles.card} ${authStyles.wide}`} style={{ padding: 28, gap: 18 }} hidden={Boolean(busy)}>
        <span className={styles.tag}>{t("Live demo")}</span>
        <div style={{ display: "grid", gap: 6 }}>
          <h1 className={authStyles.title}>{ended ? t("That demo has ended") : t("Try Crewtavo")}</h1>
          <p style={{ margin: 0 }}>
            {ended ? `${t("Demos are deleted after a day.")} ` : ""}
            {t("What kind of work do you do? You'll get your own sample business in that trade, with clients, quotes, a week of jobs and invoices, to change however you like.")}
          </p>
        </div>

        <div className={styles.trades} role="group" aria-label={t("Your trade")}>
          {DEMO_TRADES.map((d) => (
            <button key={d.preset} type="button" className={styles.trade} data-waiting={waiting === d.preset || undefined} onClick={() => void start(d.preset)}>
              <span className={styles.tradeIcon}><Icon name={TRADE_ICONS[d.preset] ?? "wrench"} size={24} /></span>
              <strong>{t(d.label)}</strong>
              <span>{t(d.blurb)}</span>
            </button>
          ))}
          <button type="button" className={styles.trade} aria-expanded={more} aria-controls="demo-more" data-open={more || undefined} onClick={() => setMore((m) => !m)}>
            <span className={styles.tradeIcon}><Icon name="apps" size={24} /></span>
            <strong>{t("Something else")}</strong>
            <span>{t("Cleaning, HVAC, plumbing, pest control, pools and more.")}</span>
          </button>
        </div>

        {more && (
          <fieldset id="demo-more" className={authStyles.presets}>
            <legend>{t("Pick your trade")}</legend>
            <div className={authStyles.presetSearch}>
              <div className="input-group">
                <span className="addon"><Icon name="search" size={16} /></span>
                <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search trades, like plumbing or pool")} aria-label={t("Search trades")} maxLength={80} autoFocus />
              </div>
            </div>
            {presets.isPending && [0, 1, 2, 3].map((i) => <div key={i} className={authStyles.preset}><Skeleton width="60%" height={14} /><Skeleton width="90%" height={10} /></div>)}
            {shown.map((p) => (
              <button key={p.id} type="button" className={`${authStyles.preset} ${styles.other}`} data-waiting={waiting === p.id || undefined} onClick={() => void start(p.id)}>
                <strong>{t(p.name)}</strong>
                <span className={authStyles.presetText}>{t(p.description)}</span>
              </button>
            ))}
            {presets.data && !shown.length && <p className="muted small" style={{ gridColumn: "1 / -1", margin: 0 }}>{t("No trade matches. General / Other works for any business.")}</p>}
          </fieldset>
        )}

        {/* The bot check, right by the choices: a trade picked first starts as soon as it's done. */}
        {turnstile.required && <div ref={turnstile.ref} className={styles.check} />}
        {waiting && <p role="status" className={styles.waiting}>{t("One more step: tick the box above to show you're not a robot, and your {trade} demo starts.", { trade: label(waiting) })}</p>}
        {error && <p role="alert" className="field-error" style={{ margin: 0 }}>{error}</p>}

        {getLocale() !== "en" && (
          <p className={`muted small ${styles.language}`}>
            {t("In Spanish, your crew's screens are in Spanish: My day, the schedule, timesheets, chat and guides. Office screens are still in English.")}
          </p>
        )}
        <ul className={styles.points}>
          <li><Icon name="check" size={16} />{t("No sign-up. It's yours alone, and deleted after {hours} hours.", { hours: DEMO_HOURS })}</li>
          <li><Icon name="check" size={16} />{t("See it as the owner, as a crew on their phone, and as a client.")}</li>
          <li><Icon name="check" size={16} />{t("Nothing is really emailed or texted, so send away.")}</li>
        </ul>
        <p className="muted small" style={{ margin: 0 }}>
          <T
            text="By starting a demo you agree to the <terms>Crewtavo Terms</terms>. Ready for your own? <get>Get Crewtavo free</get>"
            terms={(s) => <a href={TERMS} target="_blank" rel="noreferrer">{s}</a>}
            get={(s) => <a href={GET_CREWTAVO}>{s}</a>}
          />
        </p>
      </div>
    </AuthLayout>
  );
}

/** How long a demo has left, from when its accounts were made. */
function useTimeLeft(): string {
  const [left, setLeft] = useState("");
  useEffect(() => {
    let live = true;
    const update = async () => {
      const { data } = await supabase().auth.getSession();
      const made = Date.parse(data.session?.user.created_at ?? "");
      if (!live || Number.isNaN(made)) return;
      const hours = Math.max(0, (made + DEMO_HOURS * 3_600_000 - Date.now()) / 3_600_000);
      setLeft(hours >= 1.5 ? t("Deleted in about {hours} hours.", { hours: Math.round(hours) }) : hours >= 1 ? t("Deleted in about an hour.") : t("Deleted in under an hour."));
    };
    void update();
    const timer = setInterval(update, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return left;
}

/** Above the app in the demo: who you're seeing it as, ways to see the other sides, and starting over. */
export function DemoBar() {
  const session = useSession();
  const [busy, setBusy] = useState<null | "switch" | "portal" | "over">(null);
  const owner = session.role === "owner";
  const left = useTimeLeft();
  const tour = useDemoTour();

  async function switchTo(as: "owner" | "crew") {
    setBusy("switch");
    try {
      await signInAs(await api.post<DemoSession>("/demo/switch", { as }));
      // A fresh start, so nothing from the other person's view lingers.
      window.location.assign(as === "crew" ? "/field" : "/");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(null);
    }
  }

  async function openPortal() {
    // Opened now, filled in when the link arrives, so the browser doesn't block it as a pop-up.
    const tab = window.open("", "_blank");
    setBusy("portal");
    try {
      // The client with the quote sent most lately: they have something to say yes to.
      const { data: quoted } = await supabase().from("quotes").select("client_id").eq("company_id", session.company.id).eq("status", "sent").order("sent_at", { ascending: false }).limit(1).maybeSingle();
      const id = quoted?.client_id ?? (await supabase().from("clients").select("id").eq("company_id", session.company.id).limit(1).maybeSingle()).data?.id;
      if (!id) throw new Error(t("Add a client first, then open their portal from the client's page."));
      const { link } = await api.get<{ link: string }>(`/clients/${id}/hub-link`);
      if (tab) tab.location.href = link;
      else window.location.assign(link);
    } catch (err) {
      tab?.close();
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function startOver() {
    setBusy("over");
    try {
      await api.post("/demo/end");
    } catch {
      // Gone already, or it will be: either way, on to a new one.
    }
    // Signed out as any sign-out is (lib/session.tsx): nothing of theirs is left on the phone. The
    // language they were using stays picked for the next demo, as the start screen's switch would.
    const locale = getLocale();
    if (!(await session.signOut())) {
      setBusy(null);
      return;
    }
    if (locale !== "en") pickAtSignIn(locale);
    else window.location.assign("/");
  }

  // On a phone the buttons are their icons, so the bar stays one line under the status bar.
  return (
    <div className={styles.bar} role="region" aria-label={t("Demo")}>
      <span className={styles.label}>
        <span className={styles.tag}>{t("Demo")}</span>
        <span className={styles.who}>
          <T text={owner ? "You're <b>{name}</b>, the owner." : "You're <b>{name}</b>, the crew lead."} b={(s) => <strong>{s}</strong>} name={session.profile.full_name ?? ""} />{" "}
          <span className={styles.note}>{left}</span>
        </span>
      </span>
      <span className={styles.actions}>
        {owner ? (
          <>
            <Button size="sm" variant="ghost" icon="play" aria-label={t("Tour")} title={t("A one-minute tour of your sample business")} onClick={tour.start}><span className={styles.text}>{t("Tour")}</span></Button>
            <Button data-tour="crew" size="sm" variant="ghost" icon="smartphone" aria-label={t("Crew's phone")} title={t("See it as the crew lead, on their phone")} loading={busy === "switch"} disabled={Boolean(busy)} onClick={() => switchTo("crew")}><span className={styles.text}>{t("Crew's phone")}</span></Button>
            <Button data-tour="client" size="sm" variant="ghost" icon="user" aria-label={t("Client's view")} title={t("Open a client's portal, as they see it")} loading={busy === "portal"} disabled={Boolean(busy)} onClick={openPortal}><span className={styles.text}>{t("Client's view")}</span></Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon="arrowLeft" aria-label={t("Owner's view")} title={t("Back to the owner")} loading={busy === "switch"} disabled={Boolean(busy)} onClick={() => switchTo("owner")}><span className={styles.text}>{t("Owner's view")}</span></Button>
        )}
        <Button size="sm" variant="ghost" icon="refresh" aria-label={t("Start over")} title={t("Delete this business and pick a trade again")} loading={busy === "over"} disabled={Boolean(busy)} onClick={startOver}><span className={styles.text}>{t("Start over")}</span></Button>
        <a data-tour="get" className="btn btn-sm btn-primary" href={GET_CREWTAVO}>{t("Get Crewtavo")}<span className={styles.text}>{t("free", { context: "Get Crewtavo free" })}</span></a>
      </span>
      {tour.owner && <DemoTour step={tour.step} go={tour.go} />}
    </div>
  );
}
