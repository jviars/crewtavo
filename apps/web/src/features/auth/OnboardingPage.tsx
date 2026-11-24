/**
 * First run, one question at a time (Setup-Flow, Setup-Phone): the business's name, with the country,
 * time zone and currency it starts with; its trade, whose preset sets up services, forms and SOP
 * categories; then the Crewtavo Terms (features/legal/License.tsx). Creating it ticks off each part
 * once it's really there, then Home.
 */
import { countryChoices, countryFor, countryName, currencyForCountry } from "@crewtavo/core/countries";
import type { TradePreset } from "@crewtavo/core/presets";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { initials } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { TERMS_REQUIRED, TERMS_VERSION, TermsAgreement } from "@/features/legal/License";
import { api } from "@/lib/api";
import { CURRENCIES, formatDate, timeZoneChoices } from "@/lib/format";
import { SetupProgress } from "@/features/setup/SetupProgress";
import { AuthLayout } from "./LoginPage";
import styles from "./auth.module.css";

interface PresetSummary { id: string; name: string; description: string }
type Step = 1 | 2 | 3;

/**
 * The trades that match what was typed. A typed word matches a word of the trade's name or
 * description that starts like it (all but its last three letters, and at least four), so "plumber"
 * finds Plumbing and "electrician" Electrical. Only the trades matching the most words stay, so
 * "pool cleaning" is Pool, not Cleaning. Nothing typed keeps them all.
 */
export function searchTrades<T extends { name: string; description: string }>(trades: readonly T[], query: string): T[] {
  const words = (text: string) => text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const typed = words(query).map((w) => w.slice(0, Math.max(4, w.length - 3)));
  if (!typed.length) return [...trades];
  const scores = trades.map((t) => {
    const own = words(`${t.name} ${t.description}`);
    return typed.filter((w) => own.some((o) => o.startsWith(w))).length;
  });
  const best = Math.max(...scores);
  return best ? trades.filter((_, i) => scores[i] === best) : [];
}

/** The currency a business in this time zone most likely charges in, of the ones Crewtavo offers; US dollars otherwise. */
export const currencyFor = (timeZone: string): string => currencyForCountry(countryFor(timeZone));

/** "Eastern time (New York)": what the zone's called, and the city it's named for. */
export function zoneLabel(zone: string): string {
  const city = zone.split("/").pop()!.replace(/_/g, " ");
  let name = "";
  try {
    name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    // An old browser without generic names: the city alone.
  }
  return name && !name.startsWith("GMT") && name !== city ? `${name.replace(/ Time$/, " time")} (${city})` : city;
}

/** "US dollars", "Euros", "South African rand". */
const currencyLabel = (code: string) => {
  const name = CURRENCIES.find((c) => c.code === code)?.name ?? code;
  return name.endsWith("rand") ? name : `${name}s`;
};

/** A trade's own picture, on its tile. */
const TRADE_ICONS: Record<string, IconName> = {
  general: "apps", cleaning: "sparkle", electrical: "bolt", handyman: "wrench", hvac: "thermometer", landscaping: "tree",
  lawn_exterior: "plant", paving: "paving", pest_control: "bug", plumbing: "drop", pool_service: "waves", roofing_exteriors: "roofing",
};
function TradeIcon({ id, size = 18 }: { id: string; size?: number }) {
  return <Icon name={TRADE_ICONS[id] ?? "apps"} size={size} />;
}

/** The website's photos of these trades (the demo's start screen and crewtavo.com use the same), credited on the picture. */
const photo = (name: string, position: string, credit: string) => ({ src: `/demo-photos/${name}.jpg`, position, credit });
const TRADE_PHOTOS: Record<string, ReturnType<typeof photo>> = {
  // i18n-ignore below: photographers' names and where the photos are from.
  lawn_exterior: photo("lawn", "74% 50%", "Michael Smith / Unsplash"), // i18n-ignore
  roofing_exteriors: photo("roofing", "50% 40%", "Raze Solar / Unsplash"), // i18n-ignore
  paving: photo("paving", "64% 50%", "Brian J. Tromp / Unsplash"), // i18n-ignore
  cleaning: photo("cleaning", "50% 50%", "Tima Miroshnichenko / Pexels"), // i18n-ignore
  hvac: photo("hvac", "54% 30%", "Kathleen Austin Kuhn / Pexels"), // i18n-ignore
};

/**
 * The trade picked (or pointed at) beside the list, as the demo's start screen shows a business:
 * its photo, or its picture large where it has none; what it's for, in full; and what it sets up.
 */
function TradePreview({ trade, full }: { trade: PresetSummary; full: TradePreset | undefined }) {
  const pic = TRADE_PHOTOS[trade.id];
  return (
    <div className={styles.preview} key={trade.id}>
      <div className={styles.previewPic} data-photo={pic ? "" : undefined}>
        {pic ? (
          <>
            <img src={pic.src} alt="" style={{ objectPosition: pic.position }} />
            <span className={styles.credit}>{pic.credit}</span>
          </>
        ) : (
          <span className={styles.previewIcon}><TradeIcon id={trade.id} size={34} /></span>
        )}
      </div>
      <p className={styles.previewName}>{trade.name}</p>
      <p className={styles.previewText}>{trade.description}</p>
      {full && (
        <>
          <p className={styles.asideHint} style={{ margin: "18px 0 12px" }}>Already in Crewtavo when you open it:</p>
          <ul className={styles.list}>
            <li><Icon name="check" size={16} /><span><b>{full.services.length} services with prices</b><br />{someOf(full.services.map((s) => s.name))}</span></li>
            {full.checklists.length > 0 && <li><Icon name="check" size={16} /><span><b>Checklists for the crew</b><br />{someOf(full.checklists.map((c) => c.name))}</span></li>}
            {full.intake_forms.length > 0 && <li><Icon name="check" size={16} /><span><b>Forms for your website</b><br />{someOf(full.intake_forms.map((f) => f.name))}</span></li>}
            {(full.packages?.length ?? 0) > 0 && <li><Icon name="check" size={16} /><span><b>Roof packages</b><br />{someOf(full.packages!.map((p) => p.name))}</span></li>}
            {full.weather_rules.length > 0 && <li><Icon name="check" size={16} /><span><b>Weather rules</b><br />For rain days and cold snaps, on the work they affect</span></li>}
          </ul>
        </>
      )}
    </div>
  );
}

/** "Weekly mow, Bi-weekly mow, Fertilizer application and 14 more": names as the business will see them. */
function someOf(names: string[], shown = 3) {
  const head = names.slice(0, shown);
  const rest = names.length - head.length;
  return rest > 0 ? `${head.join(", ")} and ${rest} more` : head.join(", ");
}

/** The full presets (services, checklists, forms, weather rules), loaded apart from the app since only this page shows them. */
function usePresetDetails() {
  const [details, setDetails] = useState<Record<string, TradePreset> | null>(null);
  useEffect(() => {
    let live = true;
    import("@crewtavo/core/presets").then((m) => live && setDetails(m.PRESETS)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return details;
}

/** What a business starts with, as "17 services, checklists, forms". */
function startsWith(p: TradePreset) {
  return [`${p.services.length} services`, p.checklists.length && "checklists", p.intake_forms.length && "forms", p.weather_rules.length && "weather rules"].filter(Boolean) as string[];
}
const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "");

/** The parts of a new business, in the order they're made: what's being done, then what's done. */
function buildParts(p: TradePreset | undefined) {
  const n = p?.services.length;
  return [
    { doing: "Creating your business", done: "Created your business" },
    n ? { doing: `Adding ${n} services with prices`, done: `Added ${n} services with prices` } : { doing: "Adding your services and prices", done: "Added your services and prices" },
    { doing: "Setting up checklists and forms", done: "Set up checklists and forms" },
    ...(p?.weather_rules.length ? [{ doing: "Adding weather rules", done: "Added weather rules" }] : []),
  ];
}

/** `onSignOut` is the session's, which leaves nothing of theirs on the phone. */
export function OnboardingPage({ onCreated, onSignOut }: { onCreated: () => void; onSignOut: () => void }) {
  const presets = useQuery({ queryKey: ["presets"], queryFn: () => api.get<PresetSummary[]>("/presets") });
  const details = usePresetDetails();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("general");
  const [search, setSearch] = useState("");
  // The trade the pointer is on: the picture beside the list shows it until the pointer leaves.
  const [pointed, setPointed] = useState<string | null>(null);
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York");
  const [country, setCountry] = useState(() => countryFor(timezone));
  const [currency, setCurrency] = useState(() => currencyFor(timezone));
  const countries = useMemo(() => countryChoices(), []);
  // A country picked brings its currency, unless the currency was changed by hand; a time zone
  // picked brings its country the same way.
  const pickCountry = (next: string) => {
    if (currency === currencyForCountry(country)) setCurrency(currencyForCountry(next));
    setCountry(next);
  };
  const pickZone = (next: string) => {
    if (country === countryFor(timezone)) pickCountry(countryFor(next));
    setTimezone(next);
  };
  const [changing, setChanging] = useState(false);
  const [named, setNamed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [touched, setTouched] = useState(false);
  // Made: each part then ticks off in turn before Home.
  const [made, setMade] = useState(false);
  const [built, setBuilt] = useState(0);
  const zones = useMemo(() => timeZoneChoices(timezone), [timezone]);
  const heading = useRef<HTMLHeadingElement>(null);
  const zonePicker = useRef<HTMLSelectElement>(null);
  const moved = useRef(false);
  const done = useRef(onCreated);
  done.current = onCreated;

  const create = useMutation({
    meta: { inline: true, success: "Your business is ready" },
    mutationFn: () => {
      if (name.trim().length < 2) throw new Error("Enter your business name.");
      return api.post<{ id: string }>("/companies", { name: name.trim(), trade_preset: preset, timezone, currency, country, terms_version: TERMS_VERSION });
    },
    onSuccess: () => setMade(true),
  });

  const trade = presets.data?.find((p) => p.id === preset);
  const full = details?.[preset];
  const parts = buildParts(full);
  const business = name.trim();

  // Change hides its own button: focus goes on to the first of the two it shows.
  useEffect(() => {
    if (changing) zonePicker.current?.focus();
  }, [changing]);

  // The trades' photos, fetched once the trades show, so pointing at one shows its picture at once.
  useEffect(() => {
    if (step === 2) Object.values(TRADE_PHOTOS).forEach((pic) => void (new Image().src = pic.src));
  }, [step]);

  // A new step is a new question: say it (the first one's field has focus already).
  useEffect(() => {
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [step]);

  useEffect(() => {
    if (!made) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (built < parts.length && !still) {
      const timer = setTimeout(() => setBuilt((b) => b + 1), 320);
      return () => clearTimeout(timer);
    }
    if (still && built < parts.length) setBuilt(parts.length);
    const timer = setTimeout(() => done.current(), 600);
    return () => clearTimeout(timer);
  }, [made, built, parts.length]);

  const found = searchTrades(presets.data ?? [], search);
  // General / Other and the trade picked stay in the list whatever's typed.
  const shown = presets.data?.filter((p) => p.id === "general" || p.id === preset || found.includes(p));
  const status = !search.trim() || !presets.data ? ""
    : found.length ? `${found.length} ${found.length === 1 ? "trade matches" : "trades match"}`
    : "No trade matches. General / Other works for any business.";

  if (create.isPending || made) {
    return (
      <AuthLayout center step={4}>
        <span className={styles.tile} data-size="big" aria-hidden="true">{initials(business)}</span>
        <div role="status"><h1 className={styles.title} style={{ marginTop: 18 }}>Setting up {business}</h1></div>
        <ul className={styles.build}>
          {parts.map((part, i) => {
            const state = i < built ? "done" : i === built ? "doing" : "waiting";
            return (
              <li key={part.done} data-state={state}>
                <span className={styles.buildMark} aria-hidden="true">{state === "done" && <Icon name="check" size={14} bold />}</span>
                {state === "done" ? part.done : part.doing}
              </li>
            );
          })}
        </ul>
      </AuthLayout>
    );
  }

  const nameProblem = named && business.length < 2 ? "Enter your business name. It goes on your quotes and invoices." : null;
  const toStep = (next: Step) => (e?: FormEvent) => {
    e?.preventDefault();
    setStep(next);
  };

  if (step === 1) {
    return (
      <AuthLayout
        step={1}
        top={<SetupProgress at="name" />}
        onSignOut={onSignOut}
        caption="Its name and initials go on every quote. You can add a logo whenever you like."
        aside={
          <div className={styles.doc} aria-hidden="true">
            <div className={styles.letterhead}>
              <span className={styles.tile}>{business ? initials(business) : <Icon name="home" size={18} />}</span>
              <span className={styles.bizName} data-empty={!business || undefined}>{business || "Your business"}</span>
              <span className={styles.docMeta}>Quote #1<br />{formatDate(new Date())}</span>
            </div>
            <div className={styles.bars}>{[70, 92, 55, 80].map((w) => <span key={w} style={{ width: `${w}%` }} />)}</div>
            <div className={styles.total}><span>Total</span><span>{new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(0)}</span></div>
          </div>
        }
      >
        <form
          className={styles.flow}
          onSubmit={(e) => {
            e.preventDefault();
            setNamed(true);
            if (business.length >= 2) setStep(2);
          }}
        >
          <h1 ref={heading} tabIndex={-1} className={styles.title}>What's your business called?</h1>
          <p className={styles.sub}>It goes on your quotes, invoices and the page your clients see.</p>
          <div className={styles.form}>
            <Field label="Business name" requiredMessage="Enter your business name. It goes on your quotes and invoices." error={nameProblem}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ridgeline Outdoor" required maxLength={200} autoFocus autoComplete="organization" />
            </Field>
          </div>
          {!changing && (
            <div className={styles.prefLine}>
              <Icon name="clock" size={15} />
              <span>{countryName(country)} · {zoneLabel(timezone)} · {currencyLabel(currency)}</span>
              <button type="button" className="link-btn" onClick={() => setChanging(true)} aria-label="Change the country, time zone or currency">Change</button>
            </div>
          )}
          <div className={styles.prefs} data-open={changing || undefined}>
            <label className={styles.pref}>
              <span>Country</span>
              <span className={styles.prefValue} aria-hidden="true">{countryName(country)}</span>
              <span className={styles.prefChevron} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
              <select className="select" aria-label="Country" value={country} onChange={(e) => pickCountry(e.target.value)}>
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label className={styles.pref}>
              <span>Time zone</span>
              <span className={styles.prefValue} aria-hidden="true">{zoneLabel(timezone)}</span>
              <span className={styles.prefChevron} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
              <select ref={zonePicker} className="select" aria-label="Time zone" value={timezone} onChange={(e) => pickZone(e.target.value)}>
                {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
              </select>
            </label>
            <label className={styles.pref}>
              <span>Currency</span>
              <span className={styles.prefValue} aria-hidden="true">{currencyLabel(currency)}</span>
              <span className={styles.prefChevron} aria-hidden="true"><Icon name="chevronRight" size={16} /></span>
              <select className="select" aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
            </label>
          </div>
          <p className={styles.prefNote}>Picked from your phone. Change them if they're wrong.</p>
          <div className={styles.acts}>
            <Button type="submit" variant="primary">Continue<Icon name="arrowRight" size={18} /></Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  if (step === 2) {
    const sets = full ? listed(startsWith(full)) : "";
    const previewed = presets.data?.find((p) => p.id === pointed) ?? trade;
    return (
      <AuthLayout
        wide
        step={2}
        top={<SetupProgress at="trade" />}
        back={{ label: "Back", onClick: () => setStep(1) }}
        onSignOut={onSignOut}
        asideAlign="top"
        aside={previewed && <TradePreview trade={previewed} full={details?.[previewed.id]} />}
      >
        <form className={styles.flow} onSubmit={toStep(3)}>
          <h1 ref={heading} tabIndex={-1} className={styles.title}>What kind of work do you do?</h1>
          <p className={styles.sub}>We'll set up services, checklists and forms for your trade. You can change all of it later.</p>
          <div className={`input-group ${styles.tradeSearch}`}>
            <span className="addon"><Icon name="search" size={16} /></span>
            {/* Enter only searches; it doesn't go on. */}
            <input className="input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} placeholder="Search trades, like plumbing or pool" aria-label="Search trades" maxLength={80} />
          </div>
          <span className={styles.tradeStatus} role="status">{status}</span>
          <fieldset className={styles.trades}>
            <legend className="sr-only">Trade</legend>
            {presets.isPending && Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.tradeSkeleton}><Skeleton width="60%" height={14} /><Skeleton width="90%" height={10} /></div>)}
            {presets.error && <div className={styles.tradesError}><ErrorState compact error={presets.error} onRetry={() => presets.refetch()} /></div>}
            {shown?.map((p) => (
              <label key={p.id} className={styles.trade} data-on={p.id === preset || undefined} onPointerEnter={() => setPointed(p.id)} onPointerLeave={() => setPointed(null)}>
                <input type="radio" name="preset" value={p.id} checked={p.id === preset} onChange={() => setPreset(p.id)} />
                <span className={styles.tradeIcon}><TradeIcon id={p.id} /></span>
                <span className={styles.tradeName}>
                  <strong>{p.name}</strong>
                  {/* On a phone, with no picture beside the list, the one picked says what it's for. */}
                  <span className={styles.tradeText}>{p.description}</span>
                </span>
                <span className={styles.radio} aria-hidden="true"><Icon name="check" size={13} bold /></span>
              </label>
            ))}
          </fieldset>
          <div className={styles.acts} data-back="">
            {sets && <p className={styles.barHint}>Sets up {sets}</p>}
            <Button data-back="" onClick={() => setStep(1)}>Back</Button>
            <Button type="submit" variant="primary" disabled={!presets.data}>Continue<Icon name="arrowRight" size={18} /></Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      step={3}
      top={<SetupProgress at="terms" />}
      back={{ label: "Back", onClick: () => setStep(2) }}
      onSignOut={onSignOut}
      aside={
        <div className={styles.doc}>
          <div className={styles.letterhead} style={{ border: 0, paddingBottom: 6 }}>
            <span className={styles.tile} aria-hidden="true">{initials(business)}</span>
            <span style={{ minWidth: 0 }}><span className={styles.bizName}>{business}</span><br /><span className={styles.hint} style={{ fontSize: "var(--fs-13)" }}>Ready to create</span></span>
          </div>
          <dl style={{ margin: 0 }}>
            {trade && <div className={styles.sumRow}><dt>Trade</dt><dd>{trade.name}</dd></div>}
            <div className={styles.sumRow}><dt>Country</dt><dd>{countryName(country)}</dd></div>
            <div className={styles.sumRow}><dt>Time zone</dt><dd>{zoneLabel(timezone)}</dd></div>
            <div className={styles.sumRow}><dt>Currency</dt><dd>{currencyLabel(currency)}</dd></div>
            {full && <div className={styles.sumRow}><dt>Starts with</dt><dd>{startsWith(full).join(", ")}</dd></div>}
          </dl>
        </div>
      }
    >
      <form
        className={styles.flow}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          // The box says what's missing.
          if (agreed) create.mutate();
        }}
      >
        <h1 ref={heading} tabIndex={-1} className={styles.title}>The Crewtavo Terms</h1>
        <p className={styles.sub}>The short version. The full terms are one click away.</p>
        <TermsAgreement title={null} agreed={agreed} onChange={setAgreed} error={touched && !agreed ? TERMS_REQUIRED : null} />
        <div style={{ marginTop: 16 }}><FormError error={create.error} /></div>
        <div className={styles.acts} data-back="">
          <Button data-back="" onClick={() => setStep(2)}>Back</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!presets.data}>Create business</Button>
        </div>
      </form>
    </AuthLayout>
  );
}
