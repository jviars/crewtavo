import { isPlaceholderEmail } from "@crewtavo/core/email";
import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useNavigation, useViewTransitionState } from "react-router-dom";
import { supabase } from "@/lib/api";
import { logoUrl } from "@/lib/files";
import { isSub, useSession } from "@/lib/session";
import { setTheme, useTheme } from "@/lib/theme";
import { prefetchScreens } from "@/routes";
import { Face, initials } from "../ui/Avatar";
import { Icon } from "../ui/Icon";
import { confirm } from "../ui/Confirm";
import { Menu } from "../ui/Menu";
import { TaskIsland } from "../ui/TaskIsland";
import { topLayerProps, useSpace, useTopLayer } from "../ui/topLayer";
import { CommandPalette, openPalette } from "./CommandPalette";
import { useChatBadge, useChatLive } from "@/features/chat/data";
import { useMyJobs, waitingCount } from "@/features/field/myJobsData";
import { signOutNote, subCodeWays } from "@/features/auth/textCode";
import { createItems, mobileTabs, NAV_GROUP_LABELS, NAV_GROUPS, navVisible, settingsItem, subCanOpen, type NavItem } from "./nav";
import { HelpButton } from "./Help";
import { NotificationsButton } from "./Notifications";
import { BrandLockup } from "./BrandMark";
import { DemoBar } from "@/features/demo/Demo";
import { RestartBanner } from "./RestartBanner";
import { getLocale, showScreenLang, t } from "@/lib/i18n";

const loadMoreSheet = () => import("./MoreSheet");
const MoreSheet = lazy(loadMoreSheet);

/** The sidebar for this person: its groups, each under its name, and the links kept at its foot. */
function useVisibleNav(): { groups: Array<{ label: string | null; items: NavItem[] }>; foot: NavItem[] } {
  const session = useSession();
  const shown = NAV_GROUPS.map((group, i) => ({ label: NAV_GROUP_LABELS[i] ?? null, items: group.filter((item) => navVisible(session, item)) }));
  return {
    groups: shown.map((g) => ({ ...g, items: g.items.filter((item) => !item.foot) })).filter((g) => g.items.length),
    foot: shown.flatMap((g) => g.items.filter((item) => item.foot)),
  };
}

/** New requests waiting, shown beside Requests in the sidebar (which a sub doesn't have). */
function useNewRequests() {
  const session = useSession();
  const { company } = session;
  return useQuery({
    queryKey: ["nav-counts", company.id],
    enabled: !isSub(session),
    queryFn: async () => {
      const { count } = await supabase().from("requests").select("id", { count: "exact", head: true }).eq("company_id", company.id).eq("status", "new");
      return { requests: count ?? 0 };
    },
    refetchInterval: 60_000,
    meta: { silent: true },
  });
}

/** The business's logo on white, as clients see it, or its initials when it has none (or it can't load). */
function BusinessTile({ name, settings }: { name: string; settings: Record<string, unknown> }) {
  const logo = logoUrl(settings);
  const [broken, setBroken] = useState<string | null>(null);
  if (!logo || broken === logo) return <span className="business-tile" aria-hidden="true">{initials(name)}</span>;
  return <span className="business-tile business-logo" aria-hidden="true"><img src={logo} alt="" draggable={false} onError={() => setBroken(logo)} /></span>;
}

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * In the top layer like the toasts, so an open dialog's backdrop doesn't cover it. The restart
 * banner sits below it (--offline-space).
 */
function OfflinePill() {
  const ref = useRef<HTMLDivElement>(null);
  useTopLayer(ref, true);
  useSpace(ref, "--offline-space", true, 8);
  return (
    <div ref={ref} className="offline-banner" role="status" {...topLayerProps}>
      <Icon name="wifiOff" size={16} />
      {t("You're offline. Visit updates are saved and sent when you reconnect; other changes need a connection.")}
    </div>
  );
}

// Fields that don't bring up the phone's keyboard (or a picker in its place).
const NO_KEYBOARD = new Set(["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image", "hidden"]);
const opensKeyboard = (el: Element | null) =>
  el instanceof HTMLInputElement ? !NO_KEYBOARD.has(el.type) && !el.readOnly : el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable);

/**
 * Whether the phone's keyboard is up: something you type in has focus on a touch screen. iOS keeps
 * the bottom bar pinned to the page behind the keyboard, so it floats over the form as you scroll;
 * the bar steps aside until you're done typing.
 */
function useTyping() {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const touch = window.matchMedia("(pointer: coarse)");
    const check = () => setTyping(touch.matches && opensKeyboard(document.activeElement));
    // Moving to the next field blurs this one first, so look once focus has landed.
    const later = () => setTimeout(check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", later);
    // The keyboard closing resizes the visible area, even when the field vanished without a blur.
    window.visualViewport?.addEventListener("resize", later);
    return () => {
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", later);
      window.visualViewport?.removeEventListener("resize", later);
    };
  }, []);
  return typing;
}

export function AppShell() {
  const session = useSession();
  const { groups, foot } = useVisibleNav();
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  // The page says which language this screen is in, for screen readers: Spanish on the crew's
  // screens for someone using Spanish, English on the office's (lib/i18n.tsx screenLang).
  useEffect(() => {
    showScreenLang(location.pathname, location.search);
  }, [location.pathname, location.search]);
  // The navigation is in the person's language on every screen: on an English one it says so itself.
  const shellLang = getLocale() === "es" ? "es" : undefined;
  const navigate = useNavigate();
  const navigation = useNavigation();
  const online = useOnline();
  const typing = useTyping();
  const counts = useNewRequests();
  const chat = useChatBadge();
  useChatLive();
  // A sub's job offers waiting for their answer, beside My jobs.
  const offers = waitingCount(useMyJobs(session).data);
  const tabs = mobileTabs(session);
  // A sub has My day, My jobs, My paperwork and their profile: no search, Create, messages or More.
  const sub = isSub(session);
  const moreVisible = moreOpen && !sub;
  // The More sheet is only put in the page once it's been opened, and its code fetched when the
  // phone is idle (or as the button is touched), so the first tap opens it straight away.
  const [moreUsed, setMoreUsed] = useState(false);
  if (moreVisible && !moreUsed) setMoreUsed(true);
  // A sub on a sign-in Crewtavo made for them has no password: to get back in they ask for a code by
  // text or email, or, when neither goes out or their record has nothing to send it to, a new link
  // from the office. So they're asked first, and told how. (Someone's own account has its password.)
  const signOut = async () => {
    if (sub && session.subcontractor?.own_sign_in !== false) {
      const ok = await confirm({
        title: t("Sign out?"),
        body: signOutNote(session.company.name, subCodeWays(session.config.features, session.subcontractor)),
        confirmLabel: t("Sign out"),
        cancelLabel: t("Stay signed in"),
      });
      if (!ok) return;
    }
    await session.signOut();
  };
  const settings = settingsItem(session);
  const shownEmail = isPlaceholderEmail(session.profile.email) ? null : session.profile.email;
  // Light or dark from the account menu too, as in Settings → Profile (where it's explained).
  const theme = useTheme();

  useEffect(() => {
    prefetchScreens();
    if (!sub && window.matchMedia("(max-width: 900px)").matches) {
      const fetchSheet = () => void loadMoreSheet().catch(() => undefined);
      if ("requestIdleCallback" in window) window.requestIdleCallback(fetchSheet, { timeout: 4000 });
      else setTimeout(fetchSheet, 1500);
    }
    try {
      sessionStorage.removeItem("crewtavo.chunk-reload");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // New screen: start at the top and close the phone menu.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    setMoreOpen(false);
  }, [location.pathname]);

  const badge = (item: NavItem) => {
    if (item.to === "/field/jobs" && offers) return <span className="badge badge-green nav-badge" aria-label={t.plural(offers, { one: "{count} waiting for your answer", other: "{count} waiting for your answer" })}>{offers}</span>;
    if (item.to === "/requests" && counts.data?.requests) return <span className="badge badge-green nav-badge">{counts.data.requests}</span>;
    if (item.to === "/chat" && chat.mentions) return <span className="badge badge-red nav-badge" aria-label={t.plural(chat.mentions, { one: "{count} mention", other: "{count} mentions" })}>{chat.mentions}</span>;
    if (item.to === "/chat" && chat.unread) return <span className="nav-badge nav-dot" aria-label={t("New messages")} />;
    return null;
  };
  // A section stays highlighted on its related screens (Settings while in Automations, and so on).
  const under = (paths: string[] | undefined) => (paths ?? []).some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
  const within = (item: NavItem) => under(item.also);
  // ...and steps aside for a screen under it that has its own link (My paperwork under My day).
  const active = (item: NavItem, isActive: boolean) => (isActive && !under(item.except)) || within(item);
  const navClass = (item: NavItem) => ({ isActive }: { isActive: boolean }) => `nav-link${active(item, isActive) ? " active" : ""}`;
  const current = (item: NavItem) => (under(item.except) ? "false" : "page");

  return (
    <div className="shell">
      <div className="route-progress" data-active={navigation.state !== "idle" || undefined} aria-hidden="true" />
      {!online && <OfflinePill />}
      <RestartBanner />

      <aside className="sidebar" aria-label={t("Primary")} lang={shellLang}>
        <Link to={sub ? "/field" : "/"} className="brand" aria-label={t("Crewtavo home")} viewTransition>
          <BrandLockup size={30} />
        </Link>
        <nav className="nav nav-scroll">
          <CreateMenu />
          {groups.map((group, i) => (
            <div key={i} className="nav" role={group.label ? "group" : undefined} aria-labelledby={group.label ? `nav-group-${i}` : undefined}>
              {group.label ? <span className="nav-label" id={`nav-group-${i}`}>{t(group.label)}</span> : i > 0 && <span className="nav-divider" />}
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass(item)} aria-current={current(item)} viewTransition>
                  {({ isActive }) => (
                    <>
                      <Icon name={item.icon} filled={active(item, isActive)} />
                      {t(item.label)}
                      {badge(item)}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <nav className="nav nav-bottom" aria-label={t("Settings")}>
          {[...foot, settings].map((item) => (
            <NavLink key={item.to} to={item.to} className={navClass(item)} viewTransition>
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} filled={active(item, isActive)} />
                  {t(item.label)}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        {session.config.demo && <DemoBar />}
        <header className="topbar" data-scrolled={scrolled || undefined} lang={shellLang}>
          <div className="business">
            <BusinessTile name={session.company.name} settings={session.company.settings} />
            {session.companies.length > 1 ? (
              <select className="business-name" aria-label={t("Switch business")} value={session.company.id} onChange={(e) => session.switchCompany(e.target.value)}>
                {session.companies.map((m) => (
                  <option key={m.company.id} value={m.company.id}>{m.company.name}</option>
                ))}
              </select>
            ) : (
              <span className="business-name">{session.company.name}</span>
            )}
          </div>
          {!sub && (
            <>
              <button type="button" className="search" onClick={openPalette} aria-label={t("Search (⌘K)")}>
                <Icon name="search" size={16} />
                <span>{t("Search")}</span>
                <kbd className="kbd">{navigator.platform.toLowerCase().includes("mac") ? "⌘K" : t("Ctrl K")}</kbd>
              </button>
              <button type="button" className="icon-btn mobile-only" onClick={openPalette} aria-label={t("Search")}><Icon name="search" size={20} /></button>
              <Link className="icon-btn hide-mobile" to="/messages" aria-label={t("Messages")} title={t("Messages")}><Icon name="messages" size={20} /></Link>
            </>
          )}
          <HelpButton />
          <NotificationsButton />
          <Menu
            label={t("Account")}
            triggerClassName="icon-btn"
            trigger={<span className="avatar" style={{ width: 30, height: 30, fontSize: 11, background: session.profile.color || "var(--avatar)" }}><Face name={session.profile.full_name || shownEmail} photo={session.profile.avatar_url} /></span>}
            items={[
              { heading: session.profile.full_name || shownEmail || t("Account") },
              { label: t("Your profile"), icon: "user", onSelect: () => navigate("/settings?tab=profile") },
              { label: t("Settings"), icon: "settings", hidden: sub, onSelect: () => navigate("/settings") },
              {
                label: t("Appearance"),
                icon: theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor",
                items: (["light", "dark", "system"] as const).map((choice) => ({
                  label: choice === "light" ? t("Light") : choice === "dark" ? t("Dark") : t("System"),
                  checked: theme === choice,
                  onCheckedChange: () => setTheme(choice),
                })),
              },
              { separator: true },
              { label: t("Sign out"), icon: "logout", onSelect: () => void signOut() },
            ]}
          />
        </header>

        <Screen key={location.pathname} />
      </div>

      <nav className="mobile-nav" aria-label={t("Primary")} lang={shellLang} data-typing={typing || undefined} style={{ gridTemplateColumns: `repeat(${tabs.length + (sub ? 0 : 1)}, 1fr)` }}>
        {tabs.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (active(item, isActive) ? "active" : "")} aria-current={current(item)} viewTransition>
            {({ isActive }) => (
              <>
                <span className="mobile-tab-icon">
                  <Icon name={item.icon} size={20} filled={active(item, isActive)} />
                  {item.to === "/field/jobs" && offers > 0 && <span className="badge badge-green mobile-tab-badge" aria-label={t.plural(offers, { one: "{count} waiting for your answer", other: "{count} waiting for your answer" })}>{offers}</span>}
                  {item.to === "/chat" && (chat.mentions ? <span className="badge badge-red mobile-tab-badge">{chat.mentions}</span> : chat.unread ? <span className="nav-dot mobile-tab-badge" /> : null)}
                </span>
                {t(item.label)}
              </>
            )}
          </NavLink>
        ))}
        {!sub && (
          <button type="button" onPointerDown={() => void loadMoreSheet().catch(() => undefined)} onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
            <Icon name="menu" size={20} />
            {t("More")}
          </button>
        )}
      </nav>

      {moreUsed && (
        <Suspense fallback={null}>
          <MoreSheet open={moreVisible} onOpenChange={setMoreOpen} label={t("All sections")}>
            <MobileCreate onDone={() => setMoreOpen(false)} />
            <nav className="nav">
              {[...groups.flatMap((g) => g.items), ...foot, settings].map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass(item)} onClick={() => setMoreOpen(false)} viewTransition>
                  {({ isActive }) => (
                    <>
                      <Icon name={item.icon} filled={active(item, isActive)} />
                      {t(item.label)}
                      {badge(item)}
                    </>
                  )}
                </NavLink>
              ))}
            </nav>
          </MoreSheet>
        </Suspense>
      )}

      {!sub && <CommandPalette />}
      <TaskIsland />
    </div>
  );
}

/**
 * The current screen. Main-navigation links cross-fade between screens with a view transition; the
 * screen's own slide-in is skipped then. Whether it arrived that way is fixed when it mounts, so the
 * slide-in doesn't start once the transition ends.
 */
function Screen() {
  const location = useLocation();
  const session = useSession();
  const transitioning = useViewTransitionState(location.pathname);
  const [crossFaded] = useState(transitioning);
  // Team chat fills the screen edge to edge, like a messaging app (its settings are a normal page),
  // and so does the website's editor.
  // Screens that fill the space under the top bar themselves: team chat, the website, and Measure's map.
  const flush = (/^\/chat(\/|$)/.test(location.pathname) && !location.pathname.startsWith("/chat/settings")) || /^\/(website|measure)\/?$/.test(location.pathname);
  return (
    <main className={flush ? "content content-flush" : "content"} data-crossfade={crossFaded || undefined}>
      {/* A sub opening any other screen by its address (or Home) lands on My day. */}
      {isSub(session) && !subCanOpen(location.pathname) ? <Navigate to="/field" replace /> : <Outlet />}
    </main>
  );
}

function useCreateItems() {
  return createItems(useSession());
}

/** "Create" in the sidebar: the things people start most often. */
function CreateMenu() {
  const navigate = useNavigate();
  const items = useCreateItems();
  if (!items.length) return null;
  return (
    <Menu
      label={t("Create")}
      align="start"
      triggerClassName="nav-link create-trigger"
      trigger={
        <>
          <span className="nav-create-dot"><Icon name="plus" size={12} /></span>
          {t("Create")}
        </>
      }
      items={items.map((item) => ({ label: t(item.label), icon: item.icon, onSelect: () => navigate(item.to) }))}
    />
  );
}

function MobileCreate({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const items = useCreateItems();
  if (!items.length) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginBottom: 12 }}>
      {items.map((item) => (
        <button
          key={item.to}
          type="button"
          className="btn"
          style={{ height: 64, flexDirection: "column", gap: 4, fontSize: 12 }}
          onClick={() => {
            onDone();
            navigate(item.to);
          }}
        >
          <Icon name={item.icon} size={20} />
          {item.newLabel}
        </button>
      ))}
    </div>
  );
}
