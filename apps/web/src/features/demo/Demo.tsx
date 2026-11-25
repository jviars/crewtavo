/**
 * The public demo (CREWTAVO_DEMO=1 on the server: apps/api/src/services/demo.ts). There's no
 * sign-in: the start screen asks what trade the visitor is in and gives them their own sample
 * business in it, and the bar above the app lets them see it as the crew or as a client, start over,
 * or go get Crewtavo.
 */
import { DEMO_CLIENT, DEMO_CREW_LEAD, DEMO_HOURS, DEMO_OTHER_OWNER, DEMO_TRADES, demoOtherBusiness, demoTradeFromLink } from "@crewtavo/core/demo";
import { LOCALES } from "@crewtavo/core/i18n";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { BrandLockup } from "@/components/shell/BrandMark";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { searchTrades } from "@/features/auth/OnboardingPage";
import { SOURCE_URL, TERMS_VERSION } from "@/features/legal/License";
import { api, supabase } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { getLocale, languageChoice, LOCALE_NAMES, msg, pickAtSignIn, T, t } from "@/lib/i18n";
import { useTurnstile } from "@/lib/publicApi";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
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

const FEATURED = new Set<string>(DEMO_TRADES.map((d) => d.preset));
/** "Something else" itself, before a trade in its list is pointed at. */
const OTHER = "other";

/** The website's photos of these trades (crewtavo.com uses the same), credited on the picture. */
const photo = (name: string, position: string, credit: string) => ({ src: `/demo-photos/${name}.jpg`, thumb: `/demo-photos/${name}-thumb.jpg`, position, credit });
export const PHOTOS: Record<string, ReturnType<typeof photo>> = {
  // i18n-ignore below: photographers' names and where the photos are from.
  lawn_exterior: photo("lawn", "74% 50%", "Michael Smith / Unsplash"), // i18n-ignore
  roofing_exteriors: photo("roofing", "50% 40%", "Raze Solar / Unsplash"), // i18n-ignore
  paving: photo("paving", "64% 50%", "Brian J. Tromp / Unsplash"), // i18n-ignore
  cleaning: photo("cleaning", "50% 50%", "Tima Miroshnichenko / Pexels"), // i18n-ignore
  hvac: photo("hvac", "54% 30%", "Kathleen Austin Kuhn / Pexels"), // i18n-ignore
};

/** A line of what's in a sample business, dotted in its stage's color (requests, quotes, jobs, invoices). */
type Inside = readonly [stage: "" | "req" | "quote" | "job" | "invoice", text: string];
/**
 * What each sample business has in it, as apps/api/src/services/demoStories.ts makes it: change
 * one when its story changes. Every other trade gets the general story.
 */
export const INSIDE: Record<string, readonly Inside[]> = {
  lawn_exterior: [
    ["", msg("Mow crew, led by {lead}, and the Enhancements crew")],
    ["job", msg("Weekly mowing routes, filled in all season")],
    ["quote", msg("A fertilizer program quote waiting on {client}")],
    ["req", msg("New requests from the website form and a phone call")],
    ["", msg("Snow removal installed, with a storm already plowed")],
    ["invoice", msg("Invoices paid by card, check and bank, one overdue")],
  ],
  roofing_exteriors: [
    ["", msg("Install crew, led by {lead}, and the Repair and gutter crew")],
    ["quote", msg("A storm claim, measured on the aerial and quoted")],
    ["job", msg("A new roof for a builder, with 10% retainage")],
    ["quote", msg("Gutter guards for an HOA clubhouse, still a draft")],
    ["", msg("Crew guides, like the photos for an insurance claim")],
    ["invoice", msg("A deposit invoice, overdue")],
  ],
  paving: [
    ["", msg("Paving crew, led by {lead}, and the Sealcoat crew")],
    ["quote", msg("A driveway replacement quote waiting on {client}")],
    ["quote", msg("A parking lot taken off on the aerial, for sealcoat")],
    ["job", msg("Subdivision roads for a builder, with 10% retainage")],
    ["req", msg("A sealcoat and crack repair request by phone")],
    ["invoice", msg("A progress invoice for the builder, overdue")],
  ],
  general: [
    ["", msg("Crew 1, led by {lead}, and Crew 2")],
    ["", msg("Quotes and jobs from your trade's price list")],
    ["req", msg("An estimate request, with a visit today")],
    ["quote", msg("A quote waiting on {client}")],
    ["job", msg("This week's visits on the schedule")],
    ["invoice", msg("Invoices paid and one overdue")],
  ],
};
const STAGES = [["req", msg("Requests")], ["quote", msg("Quotes")], ["job", msg("Jobs")], ["invoice", msg("Invoices")]] as const;

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

/** English · Español, as on the sign-in page: the page reloads in it, and the demo's people get it. */
function Languages() {
  const current = getLocale();
  return (
    <nav className={styles.languages} aria-label={t("Language")}>
      {LOCALES.map((locale) =>
        locale === current ? (
          <strong key={locale} lang={locale} aria-current="true">{LOCALE_NAMES[locale]}</strong>
        ) : (
          <button key={locale} type="button" lang={locale} onClick={() => pickAtSignIn(locale)}>{LOCALE_NAMES[locale]}</button>
        ),
      )}
    </nav>
  );
}

/**
 * In place of the sign-in page: "What kind of work do you do?" Lawn care, roofing, paving, or
 * something else (any other trade preset), set large and read down like a menu. Pointing at one
 * shows the business it makes; picking one makes it and signs the visitor in.
 * `ended`: they were signed in to a demo that has since been deleted.
 */
export function DemoStart({ ended = false }: { ended?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState("");
  const [pointed, setPointed] = useState<string>(DEMO_TRADES[0].preset);
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<PresetSummary[]>("/presets"), staleTime: Infinity });
  // The check's box in the start screen's language, whatever the browser's is, and dark like the page.
  const turnstile = useTurnstile(true, getLocale() === "en" ? undefined : getLocale(), "dark");
  const started = useRef(false);
  /** A trade picked before the bot check was done: it starts once it is. */
  const [waiting, setWaiting] = useState<string | null>(null);
  /** Starts that failed: each asks the bot check for a new answer once its box is back on screen. */
  const [failures, setFailures] = useState(0);
  /** The website's ?trade= starts once, not again with every new answer from the check. */
  const linkTried = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  async function start(trade: string) {
    if (started.current) return;
    setPointed(trade);
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
      setFailures((n) => n + 1);
    }
  }

  // A check is good once: after a failed start, ask for a new one, now that its box is showing again,
  // and put the keyboard on what went wrong rather than back at the top of the page.
  useEffect(() => {
    if (!failures) return;
    turnstile.reset();
    errorRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failures]);
  // The search takes the keyboard when the other trades open, not each time the list comes back.
  useEffect(() => {
    if (more) searchRef.current?.focus();
  }, [more]);

  // Arriving from a trade's page on the website starts that trade's demo, and a trade picked before
  // the check was done starts as soon as it is.
  const linked = presets.data ? demoTradeFromLink(linkedTrade, presets.data.map((p) => p.id)) : null;
  useEffect(() => {
    const trade = waiting ?? (ended || linkTried.current ? null : linked);
    if (!trade || (turnstile.required && !turnstile.token)) return;
    if (trade === linked && !waiting) linkTried.current = true;
    void start(trade);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, waiting, turnstile.token]);

  const others = (presets.data ?? []).filter((p) => !FEATURED.has(p.id));
  const shown = search.trim() ? searchTrades(others, search) : others;
  const isOther = (id: string | null) => id === OTHER || others.some((p) => p.id === id);
  const label = (id: string) => {
    const featured = DEMO_TRADES.find((d) => d.preset === id);
    return (featured ? t(featured.label) : t(presets.data?.find((p) => p.id === id)?.name ?? "")).toLowerCase();
  };
  const point = (id: string) => {
    if (!busy) setPointed(id);
  };

  // The business behind what's pointed at: a featured trade's own, another trade's from its price
  // list, or "Something else" as the cleaning and HVAC businesses its photos show.
  const shownId = busy ?? pointed;
  const featured = DEMO_TRADES.find((d) => d.preset === shownId);
  const preset = others.find((p) => p.id === shownId);
  const business = featured
    ? featured.business
    : preset
      ? demoOtherBusiness(preset)
      : t("{first}, {second} and {count} more", {
          first: demoOtherBusiness({ id: "cleaning", name: "Cleaning" }),
          second: demoOtherBusiness({ id: "hvac", name: "HVAC" }),
          count: Math.max(others.length - 2, 0) || 7,
        });
  const owner = featured?.owner ?? DEMO_OTHER_OWNER;
  // A trade with no photo of its own shows its name, never another trade's workers.
  const picture = featured || preset ? (PHOTOS[shownId] ? shownId : "plate") : "pair";
  const credit = picture === "pair" ? `${PHOTOS.cleaning!.credit.split(" / ")[0]}, ${PHOTOS.hvac!.credit}` : PHOTOS[picture]?.credit;
  const inside = INSIDE[featured ? shownId : "general"]!;
  const people = { lead: DEMO_CREW_LEAD, client: DEMO_CLIENT };
  const bold = (s: ReactNode) => <b>{s}</b>;

  return (
    <div className={styles.start} data-busy={busy ? "" : undefined} data-waiting={waiting ? "" : undefined}>
      <header className={styles.top}>
        <a className={styles.lockup} href="https://crewtavo.com/"><BrandLockup size={30} /></a>
        <div className={styles.topEnd}>
          {languageChoice() && getLocale() !== "en" && <p className={styles.langNote}>{t("Your crew's screens are in Spanish; the office's are still in English.")}</p>}
          <span className={styles.live}><i aria-hidden="true" />{t("Live demo")}</span>
          {languageChoice() && <Languages />}
        </div>
      </header>

      <main className={styles.stage} aria-label={t("Try Crewtavo")}>
        <section className={styles.ask}>
          {busy ? (
            <div role="status" aria-live="polite">
              <h1 className={`${styles.question} ${styles.setting}`}>{t("Setting up your {trade} business", { trade: label(busy) })}</h1>
              <p className={styles.sub}>{t("Clients, quotes, this week's jobs and invoices, ready to click around in. It takes a few seconds.")}</p>
              <div className={styles.progress} aria-hidden="true"><i /></div>
              <ul className={styles.roles}>
                <li><Icon name="home" size={22} /><span><T text="You start as <b>{name}</b>, the owner." b={bold} name={owner} /></span></li>
                <li><Icon name="smartphone" size={22} /><span><T text="<b>Crew's phone</b> shows the day as {lead}, the crew lead." b={bold} lead={DEMO_CREW_LEAD} /></span></li>
                <li><Icon name="user" size={22} /><span><T text="<b>Client's view</b> opens {client}'s portal, with a quote to approve." b={bold} client={DEMO_CLIENT} /></span></li>
              </ul>
            </div>
          ) : (
            <>
              <h1 id="demo-question" className={styles.question}>{t("What kind of work do you do?")}</h1>
              <p className={styles.sub}>
                {ended
                  ? t("That demo has ended: demos are deleted after a day. Pick a trade and you'll get a fresh sample business to change however you like.")
                  : t("You'll get your own sample business in that trade, with clients, quotes, a week of jobs and invoices, to change however you like.")}
              </p>

              <div className={styles.answers} role="group" aria-labelledby="demo-question">
                {DEMO_TRADES.map((d) => (
                  <button
                    key={d.preset}
                    type="button"
                    className={styles.answer}
                    data-pointed={pointed === d.preset || undefined}
                    data-waiting={waiting === d.preset || undefined}
                    onPointerEnter={() => point(d.preset)}
                    onFocus={() => point(d.preset)}
                    onClick={() => void start(d.preset)}
                  >
                    <img className={styles.thumb} src={PHOTOS[d.preset]!.thumb} alt="" />
                    <span className={styles.words}>
                      <span className={styles.name}>{t(d.label)}</span>
                      <span className={styles.blurb}>{t(d.blurb)}</span>
                    </span>
                    <span className={styles.arrow}><Icon name="arrowRight" size={28} /></span>
                  </button>
                ))}
                <button
                  type="button"
                  className={styles.answer}
                  aria-expanded={more}
                  aria-controls={more ? "demo-more" : undefined}
                  data-pointed={isOther(pointed) || undefined}
                  data-waiting={(waiting !== null && isOther(waiting)) || undefined}
                  onPointerEnter={() => point(OTHER)}
                  onFocus={() => point(OTHER)}
                  onClick={() => setMore((m) => !m)}
                >
                  <span className={`${styles.thumb} ${styles.pair}`}><img src={PHOTOS.cleaning!.thumb} alt="" /><img src={PHOTOS.hvac!.thumb} alt="" /></span>
                  <span className={styles.words}>
                    <span className={styles.name}>{t("Something else", { context: "Your trade" })}</span>
                    <span className={styles.blurb}>{t("Cleaning, HVAC, plumbing, pest control, pools and more.")}</span>
                  </span>
                  <span className={`${styles.arrow} ${styles.plus}`}><Icon name="plus" size={28} /></span>
                </button>
              </div>

              {more && (
                <fieldset id="demo-more" className={styles.more}>
                  <legend className="sr-only">{t("Pick your trade")}</legend>
                  <label className={styles.search}>
                    <Icon name="search" size={22} />
                    <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Search trades, like plumbing or pool")} aria-label={t("Search trades")} maxLength={80} ref={searchRef} />
                  </label>
                  <div className={styles.others}>
                    {presets.isPending && [0, 1, 2, 3].map((i) => <div key={i} className={styles.otherTrade}><Skeleton width="60%" height={18} /><Skeleton width="90%" height={12} /></div>)}
                    {shown.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={styles.otherTrade}
                        data-pointed={pointed === p.id || undefined}
                        data-waiting={waiting === p.id || undefined}
                        onPointerEnter={() => point(p.id)}
                        onFocus={() => point(p.id)}
                        onClick={() => void start(p.id)}
                      >
                        <strong>{t(p.name)}</strong>
                        <span>{t(p.description)}</span>
                      </button>
                    ))}
                  </div>
                  {presets.data && !shown.length && <p className={styles.none}>{t("No trade matches. General / Other works for any business.")}</p>}
                </fieldset>
              )}
            </>
          )}

          {/* Kept, not unmounted, while the business is made: the bot check keeps its box for a start that fails. */}
          <div className={styles.gate} hidden={Boolean(busy)}>
            {turnstile.required && <div ref={turnstile.ref} className={styles.check} />}
            <div className={styles.gateSide}>
              {waiting && (
                <p role="status" className={styles.waitingNote}>
                  <Icon name="shieldCheck" size={18} />
                  <span>{t("One more step: tick the box to show you're not a robot, and your {trade} demo starts.", { trade: label(waiting) })}</span>
                </p>
              )}
              {error && <p ref={errorRef} tabIndex={-1} role="alert" className={styles.error}><Icon name="alert" size={18} /><span>{error}</span></p>}
              <p className={styles.terms}>
                <T
                  text="By starting a demo you agree to the <terms>Crewtavo Terms</terms>. Ready for your own? <get>Get Crewtavo free</get>"
                  terms={(s) => <a href={TERMS} target="_blank" rel="noreferrer">{s}</a>}
                  get={(s) => <a className={styles.get} href={GET_CREWTAVO}>{s}</a>}
                />
              </p>
            </div>
          </div>
        </section>

        <aside className={styles.preview} aria-labelledby="demo-business">
          <div className={styles.photos}>
            {Object.entries(PHOTOS).map(([id, p]) => (
              <img key={id} src={p.src} alt="" loading="lazy" style={{ objectPosition: p.position }} data-shown={picture === id || undefined} />
            ))}
            <span className={styles.pairPhoto} data-shown={picture === "pair" || undefined}>
              <img src={PHOTOS.cleaning!.src} alt="" loading="lazy" style={{ objectPosition: "45% 50%" }} />
              <img src={PHOTOS.hvac!.src} alt="" loading="lazy" style={{ objectPosition: PHOTOS.hvac!.position }} />
            </span>
            <span className={styles.plate} data-shown={picture === "plate" || undefined}>{preset ? t(preset.name) : ""}</span>
            {credit && <span className={styles.credit}>{t("Photo: {credit}", { credit })}</span>}
          </div>
          <div className={styles.about} key={shownId}>
            <h2 id="demo-business" className={styles.business}>{business}</h2>
            <p className={styles.owner}>{t("Rocky Mount, Virginia · You're {name}, the owner", { name: owner })}</p>
            <ul className={styles.inside}>
              {inside.map(([stage, text]) => <li key={text} data-stage={stage || undefined}>{t(text, people)}</li>)}
            </ul>
            <p className={styles.legend} aria-hidden="true">
              {STAGES.map(([stage, name]) => <span key={stage} data-stage={stage}>{t(name)}</span>)}
            </p>
          </div>
        </aside>
      </main>

      <footer className={styles.band}>
        <ul className={styles.promises}>
          <li><Icon name="check" size={16} />{t("No sign-up. It's yours alone, and deleted after {hours} hours.", { hours: DEMO_HOURS })}</li>
          <li><Icon name="check" size={16} />{t("See it as the owner, as a crew on their phone, and as a client.")}</li>
          <li><Icon name="check" size={16} />{t("Nothing is really emailed or texted, so send away.")}</li>
        </ul>
        {languageChoice() && getLocale() !== "en" && <p className={styles.bandNote}><Icon name="globe" size={16} />{t("Your crew's screens are in Spanish; the office's are still in English.")}</p>}
      </footer>
    </div>
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
  // Pages as tall as the window take the bar off too (--page-top in base.css), however many lines it wraps to.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const root = document.documentElement.style;
    const measure = () => root.setProperty("--demo-bar-height", `${el.offsetHeight}px`);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => {
      watch.disconnect();
      root.removeProperty("--demo-bar-height");
    };
  }, []);

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
    <div ref={bar} className={styles.bar} role="region" aria-label={t("Demo")}>
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
