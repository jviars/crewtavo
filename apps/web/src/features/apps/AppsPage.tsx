/**
 * Apps, laid out like an app store (App-Directory.dc.html; Mobbin: Canva's and Typeform's app
 * directories, Apple's App Store). Discover opens on one featured app with its screenshot, three
 * collections of apps that go together, then the apps built into Crewtavo and the ones it connects to,
 * as cards. A rail on the left browses by category, what's installed and what needs attention; on a
 * phone it's a row of chips. Opening a card shows the app's own page (AppDetailPage) to install it.
 */
import { useMemo, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { SearchField } from "@/components/ui/Toolbar";
import { AppCard, AppIcon, appState, shortName } from "./AppIcon";
import { CATEGORY_LABELS, infoFor, useApps, type AppRow } from "./catalog";
import { useIsInstalled } from "./installed";
import { SCREENSHOTS } from "./screenshots";

type Show = "all" | "installed" | "attention";
const SHOWS: Show[] = ["all", "installed", "attention"];

/** Apps that go together, each on its own tinted card under the featured app. */
const COLLECTIONS = [
  { key: "paid", tone: "invoice", title: "Get paid on time", text: "Card and bank payments on every invoice, and books that keep themselves.", apps: ["stripe", "quickbooks", "zoho_books"] },
  { key: "calendars", tone: "job", title: "Every calendar on one schedule", text: "Your team's other appointments beside their visits, so nobody gets double-booked.", apps: ["google_calendar", "outlook_calendar", "apple_calendar", "zoho_calendar", "ics_calendar"] },
  { key: "grow", tone: "req", title: "Win more work", text: "Google reviews, social posts, postcards and your website's own request form.", apps: ["marketing", "google_business", "meta", "lob", "website_forms"] },
] as const;
type CollectionKey = (typeof COLLECTIONS)[number]["key"];

/** The apps Discover features, first one first; it shows the first one this business doesn't have yet. */
const FEATURED = ["stripe", "twilio", "quickbooks", "google_calendar", "meta", "abc_supply", "snow", "team_chat"];

/** Whether an app matches what was typed: its name, what it does, its category, or who makes it. */
export function appMatches(app: AppRow, term: string): boolean {
  const q = term.trim().toLowerCase();
  if (!q) return true;
  const info = infoFor(app);
  return [app.name, info.tagline, app.description, CATEGORY_LABELS[app.category], info.developer].some((s) => s?.toLowerCase().includes(q));
}

/** The app Discover features: the first of FEATURED with screenshots that isn't installed, else the first. */
export function featuredApp(apps: AppRow[], isInstalled: (app: AppRow) => boolean): AppRow | undefined {
  const candidates = FEATURED.map((id) => apps.find((a) => a.id === id && a.available && SCREENSHOTS[id]?.length)).filter((a): a is AppRow => Boolean(a));
  return candidates.find((a) => !isInstalled(a)) ?? candidates[0];
}

export function AppsPage() {
  const apps = useApps();
  const { isInstalled } = useIsInstalled();
  const [params, setParams] = useSearchParams();
  const shown = params.get("show");
  const show: Show = SHOWS.includes(shown as Show) ? (shown as Show) : "all";
  const category = params.get("cat") as AppRow["category"] | null;
  const collection = COLLECTIONS.find((c) => c.key === params.get("set"));
  const term = params.get("q") ?? "";
  // Kept in the address, so coming back from an app's page finds the list as it was left. Picking a
  // view in the rail clears the others; typing keeps the view it searches in.
  const browse = (next: { show?: Show; cat?: string; set?: CollectionKey } = {}) =>
    setParams(
      (p) => {
        const out = new URLSearchParams();
        if (next.show && next.show !== "all") out.set("show", next.show);
        if (next.cat) out.set("cat", next.cat);
        if (next.set) out.set("set", next.set);
        const q = p.get("q");
        if (q) out.set("q", q);
        return out;
      },
      { replace: true },
    );
  const search = (value: string) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p);
        if (value) out.set("q", value);
        else out.delete("q");
        return out;
      },
      { replace: true },
    );

  const all = apps.data?.apps;
  const counts = useMemo(() => {
    const list = all ?? [];
    const byCategory = new Map<AppRow["category"], number>();
    for (const a of list) byCategory.set(a.category, (byCategory.get(a.category) ?? 0) + 1);
    return {
      all: list.length,
      installed: list.filter((a) => isInstalled(a)).length,
      attention: list.filter((a) => appState(a, isInstalled(a))?.tone === "danger").length,
      byCategory,
    };
  }, [all, isInstalled]);

  // Sign-in links from before app pages existed came back to /apps?app=...
  const legacy = params.get("app");
  if (legacy) return <Navigate to={`/apps/${encodeURIComponent(legacy)}?${new URLSearchParams([...params].filter(([k]) => k !== "app"))}`} replace />;
  if (!apps.allowed) return <NoAccess title="Apps" />;

  // A phone hides it (Mobile-Apps: the large title, then the search), while loading and when nothing matches too.
  const lede = <span className="app-dir-lede">Turn on what's built into Crewtavo, and bring in the calendars, books and tools you already use.</span>;
  const searchField = <SearchField value={term} onChange={search} placeholder="Search apps" label="Search apps" />;
  if (apps.isPending) {
    return (
      <>
        <PageHeader title="Apps" lede={lede} />
        <div className="app-store" aria-busy="true" aria-label="Loading apps">
          <div className="app-rail" />
          <div className="app-store-main">
            <Skeleton height={260} radius={18} />
            <ul className="app-grid">{Array.from({ length: 9 }, (_, i) => <li key={i}><Skeleton height={118} radius={14} /></li>)}</ul>
          </div>
        </div>
      </>
    );
  }

  const list = all ?? [];
  const discover = show === "all" && !category && !collection && !term.trim();
  const inView = (a: AppRow) =>
    appMatches(a, term) &&
    (collection ? (collection.apps as readonly string[]).includes(a.id) : true) &&
    (category ? a.category === category : true) &&
    (show === "all" || (show === "installed" ? isInstalled(a) : appState(a, isInstalled(a))?.tone === "danger"));
  const rows = collection ? collection.apps.map((id) => list.find((a) => a.id === id)).filter((a): a is AppRow => Boolean(a) && inView(a!)) : list.filter(inView);
  const card = (a: AppRow) => <li key={a.id}><AppCard app={a} installed={isInstalled(a)} /></li>;
  const categories = Object.keys(CATEGORY_LABELS).filter((c) => counts.byCategory.get(c as AppRow["category"])) as AppRow["category"][];
  const viewTitle = collection?.title ?? (category ? CATEGORY_LABELS[category] : show === "installed" ? "Installed" : show === "attention" ? "Needs attention" : "All apps");

  const rail = (
    <nav className="app-rail" aria-label="Browse apps">
      <RailItem current={discover || (show === "all" && !category && !collection)} onClick={() => browse()}>Discover</RailItem>
      <RailItem current={show === "installed" && !category} count={counts.installed} onClick={() => browse({ show: "installed" })}>Installed</RailItem>
      {(counts.attention > 0 || show === "attention") && <RailItem current={show === "attention"} count={counts.attention} tone="danger" onClick={() => browse({ show: "attention" })}>Needs attention</RailItem>}
      <span className="app-rail-label">Categories</span>
      {categories.map((c) => <RailItem key={c} current={category === c} count={counts.byCategory.get(c)} onClick={() => browse({ cat: c })}>{CATEGORY_LABELS[c]}</RailItem>)}
    </nav>
  );

  return (
    <>
      <PageHeader title="Apps" lede={lede} actions={searchField} />

      {apps.error ? (
        <ErrorState error={apps.error} onRetry={() => apps.refetch()} />
      ) : (
        <div className="app-store">
          {rail}
          <div className="app-store-main">
            {discover ? (
              <Discover apps={list} isInstalled={isInstalled} onCollection={(set) => browse({ set })} card={card} />
            ) : (
              <section className="app-shelf" aria-labelledby="app-view-title">
                <div className="app-shelf-head">
                  <h2 id="app-view-title">{term.trim() && !collection && !category && show === "all" ? `Results for “${term.trim()}”` : viewTitle}</h2>
                  {(collection || category || show !== "all") && <button type="button" className="link-btn" onClick={() => browse()}>Back to Discover</button>}
                </div>
                {collection && <p className="app-shelf-lede">{collection.text}</p>}
                {rows.length === 0 ? (
                  term.trim() ? (
                    <EmptyState icon="search" title={`No apps match “${term.trim()}”`} action={<Button onClick={() => search("")}>Clear search</Button>}>
                      Try what it does, like “calendar” or “texts”.
                    </EmptyState>
                  ) : show === "installed" ? (
                    <EmptyState icon="apps" title="No apps installed yet" action={<Button onClick={() => browse()}>Discover apps</Button>}>
                      Install one to turn it on for your team.
                    </EmptyState>
                  ) : (
                    <EmptyState icon="check" title="Nothing needs attention" action={<Button onClick={() => browse()}>Discover apps</Button>} />
                  )
                ) : (
                  <ul className="app-grid">{rows.map(card)}</ul>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function RailItem({ current, count, tone, onClick, children }: { current: boolean; count?: number; tone?: "danger"; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="app-rail-item" aria-current={current ? "page" : undefined} onClick={onClick}>
      <span>{children}</span>
      {count ? <span className="app-rail-count" data-tone={tone}>{count}</span> : null}
    </button>
  );
}

/** Discover: the featured app, the collections, then the built-in apps and the ones Crewtavo connects to. */
function Discover({ apps, isInstalled, onCollection, card }: { apps: AppRow[]; isInstalled: (app: AppRow) => boolean; onCollection: (key: CollectionKey) => void; card: (app: AppRow) => ReactNode }) {
  const featured = featuredApp(apps, isInstalled);
  const own = apps.filter((a) => a.category === "Team");
  const order = Object.keys(CATEGORY_LABELS);
  const others = apps.filter((a) => a.category !== "Team").sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  return (
    <>
      {featured && <Featured app={featured} installed={isInstalled(featured)} />}

      <section className="app-shelf" aria-labelledby="app-collections">
        <div className="app-shelf-head"><h2 id="app-collections">Collections</h2></div>
        <ul className="app-collections">
          {COLLECTIONS.map((c) => {
            const members = c.apps.map((id) => apps.find((a) => a.id === id)).filter((a): a is AppRow => Boolean(a));
            if (members.length === 0) return null;
            return (
              <li key={c.key}>
                <button type="button" className="app-collection" data-tone={c.tone} onClick={() => onCollection(c.key)}>
                  <span className="app-collection-title">{c.title}</span>
                  <span className="app-collection-text">{c.text}</span>
                  <span className="app-collection-icons" aria-hidden="true">
                    {members.slice(0, 5).map((a) => <AppIcon key={a.id} id={a.id} name={a.name} size="sm" />)}
                  </span>
                  <span className="sr-only">{members.map((a) => shortName(a)).join(", ")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {own.length > 0 && (
        <section className="app-shelf" aria-labelledby="app-own">
          <div className="app-shelf-head"><h2 id="app-own">Built by Crewtavo</h2><span className="app-shelf-note">Turn on, nothing to connect</span></div>
          <ul className="app-grid">{own.map(card)}</ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="app-shelf" aria-labelledby="app-others">
          <div className="app-shelf-head"><h2 id="app-others">Connect your tools</h2><span className="app-shelf-note">Calendars, books, payments and more</span></div>
          <ul className="app-grid">{others.map(card)}</ul>
        </section>
      )}
    </>
  );
}

/** The featured app: what it is and does on the left, its first screenshot running off the card's edge on the right. */
function Featured({ app, installed }: { app: AppRow; installed: boolean }) {
  const shot = SCREENSHOTS[app.id]?.[0];
  const state = appState(app, installed);
  return (
    <Link to={`/apps/${app.id}`} className="app-feature">
      <span className="app-feature-text">
        <span className="app-feature-eyebrow">{app.category === "Team" ? "Built by Crewtavo" : `Featured · ${CATEGORY_LABELS[app.category]}`}</span>
        <span className="app-feature-name">
          <AppIcon id={app.id} name={app.name} size="lg" />
          <span className="app-feature-title">{shortName(app)}</span>
        </span>
        <span className="app-feature-tag">{infoFor(app).about.split(/(?<=\.)\s/)[0]}</span>
        <span className="app-get app-get-lg" data-tone={state?.tone}>{state ? state.label : "Get"}</span>
      </span>
      {shot && (
        <span className="app-feature-shot" aria-hidden="true">
          <img className="app-shot-light" src={shot.light} alt="" />
          <img className="app-shot-dark" src={shot.dark} alt="" />
        </span>
      )}
    </Link>
  );
}
