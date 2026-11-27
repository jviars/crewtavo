import { isPlaceholderEmail } from "@crewtavo/core/email";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useNavigation, useNavigationType, useViewTransitionState } from "react-router-dom";
import { supabase } from "@/lib/api";
import { logoUrl } from "@/lib/files";
import { announceTopLayer } from "@/lib/motion";
import { isSub, useSession } from "@/lib/session";
import { setTheme, useTheme } from "@/lib/theme";
import { prefetchScreens } from "@/routes";
import { Face, initials } from "../ui/Avatar";
import { Icon, type IconName } from "../ui/Icon";
import { confirm } from "../ui/Confirm";
import { Menu, type MenuEntry } from "../ui/Menu";
import { sheetDismissed } from "../ui/menuModel";
import { TaskIsland } from "../ui/TaskIsland";
import { topLayerProps, useSpace, useTopLayer } from "../ui/topLayer";
import { CommandPalette, openPalette } from "./CommandPalette";
import { useChatBadge, useChatLive } from "@/features/chat/data";
import { useWaitingCount } from "@/features/messages/done";
import { useMyJobs, waitingCount } from "@/features/field/myJobsData";
import { signOutNote, subCodeWays } from "@/features/auth/textCode";
import { inkOn } from "@/features/documents/words";
import { createItems, foldedGroups, mobileTabs, NAV_GROUP_LABELS, NAV_GROUPS, navVisible, saveFoldedGroups, settingsItem, subCanOpen, type NavItem } from "./nav";
import { flipSidebar, sidebarClosed } from "./sidebar";
import { HelpButton, openHelp } from "./Help";
import { NotificationsButton } from "./Notifications";
import { BrandLockup } from "./BrandMark";
import { RestartBanner } from "./RestartBanner";
import { getLocale, showScreenLang, t } from "@/lib/i18n";

/** The sidebar for this person: its groups, each under its name, and the links kept at its foot. */
function useVisibleNav(): { groups: Array<{ label: string | null; items: NavItem[] }>; foot: NavItem[] } {
  const session = useSession();
  const shown = NAV_GROUPS.map((group, i) => ({ label: NAV_GROUP_LABELS[i] ?? null, items: group.filter((item) => navVisible(session, item)) }));
  return {
    groups: shown.map((g) => ({ ...g, items: g.items.filter((item) => !item.foot) })).filter((g) => g.items.length),
    foot: shown.flatMap((g) => g.items.filter((item) => item.foot)),
  };
}

/**
 * The counts beside the sidebar's links: new requests waiting (which a sub doesn't have), and
 * invoices past due for whoever sees Invoices, the one count that's red.
 */
function useNavCounts() {
  const session = useSession();
  const { company } = session;
  const invoices = navVisible(session, NAV_GROUPS.flat().find((item) => item.to === "/invoices")!);
  return useQuery({
    queryKey: ["nav-counts", company.id, invoices],
    enabled: !isSub(session),
    queryFn: async () => {
      const [requests, overdue] = await Promise.all([
        supabase().from("requests").select("id", { count: "exact", head: true }).eq("company_id", company.id).eq("status", "new"),
        invoices ? supabase().from("invoices").select("id", { count: "exact", head: true }).eq("company_id", company.id).eq("status", "overdue") : Promise.resolve({ count: 0 }),
      ]);
      return { requests: requests.count ?? 0, overdue: overdue.count ?? 0 };
    },
    refetchInterval: 60_000,
    meta: { silent: true },
  });
}

/**
 * The business's logo on white, as clients see it, or its initials when it has none (or it can't
 * load), on the brand color it chose for its clients (Settings, Company) with words that read on it.
 */
function BusinessTile({ name, settings }: { name: string; settings: Record<string, unknown> }) {
  const logo = logoUrl(settings);
  const [broken, setBroken] = useState<string | null>(null);
  const brand = (settings.branding as { color?: unknown } | undefined)?.color;
  const color = typeof brand === "string" && /^#[0-9a-f]{6}$/i.test(brand) ? brand : null;
  if (!logo || broken === logo) return <span className="business-tile" style={color ? { background: color, color: inkOn(color) } : undefined} aria-hidden="true">{initials(name)}</span>;
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

/** How far down each screen in this tab's history was scrolled, by its history entry (location.key). */
const scrolledTo = new Map<string, number>();

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
  const navigationType = useNavigationType();
  const online = useOnline();
  const typing = useTyping();
  const counts = useNavCounts();
  const chat = useChatBadge();
  const waiting = useWaitingCount().data ?? 0;
  const theme = useTheme();
  useChatLive();
  // A sub's job offers waiting for their answer, beside My jobs.
  const offers = waitingCount(useMyJobs(session).data);
  const tabs = mobileTabs(session);
  // A sub has My day, My jobs, My paperwork and their profile: no search, Create, messages or More.
  const sub = isSub(session);
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
  // The sidebar's groups this person folded (all open until they fold one), remembered per person.
  const [folded, setFolded] = useState(() => foldedGroups(session.userId));
  const toggleGroup = (label: string) =>
    setFolded((was) => {
      const next = was.includes(label) ? was.filter((g) => g !== label) : [...was, label];
      saveFoldedGroups(session.userId, next);
      return next;
    });
  // The sidebar closed to its icons (the « in the top bar, or ⌘\), so a laptop or an iPad has the room.
  const [closed, setClosed] = useState(sidebarClosed);
  const mac = navigator.platform.toLowerCase().includes("mac");
  const sidebarWords = `${closed ? t("Open sidebar") : t("Close sidebar")} (${mac ? "⌘\\" : t("Ctrl \\")})`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key !== "\\" || e.defaultPrevented) return;
      // A phone or narrow window has no sidebar, only the tabs: nothing there to open or close.
      if (window.matchMedia("(max-width: 900px)").matches) return;
      e.preventDefault();
      setClosed(flipSidebar);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const shownEmail = isPlaceholderEmail(session.profile.email) ? null : session.profile.email;
  const myName = session.profile.full_name || shownEmail || t("Account");

  useEffect(() => {
    prefetchScreens();
    try {
      sessionStorage.removeItem("crewtavo.chunk-reload");
    } catch {
      // ignore
    }
  }, []);

  // Where this history entry is scrolled to, kept for coming Back to it.
  const entry = useRef(location.key);
  entry.current = location.key;
  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 4);
      scrolledTo.set(entry.current, window.scrollY);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The raised pill behind the current page slides to the next one; the first placing doesn't move.
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pill = navRef.current?.querySelector<HTMLElement>(".nav-pill");
    const link = navRef.current?.querySelector<HTMLElement>(".nav-link.active");
    if (!pill) return;
    if (!link) return void pill.removeAttribute("data-placed");
    pill.toggleAttribute("data-moving", pill.hasAttribute("data-placed"));
    pill.style.transform = `translateY(${link.offsetTop}px)`;
    pill.setAttribute("data-placed", "");
  });

  // New screen: start at the top and close the phone menu. Back (or Forward) to a screen returns to
  // where it was scrolled, so a client opened from far down the list comes back to that spot.
  useLayoutEffect(() => {
    setMoreOpen(false);
    const y = navigationType === "POP" ? scrolledTo.get(location.key) : undefined;
    if (!y) return void window.scrollTo({ top: 0, behavior: "instant" });
    // The list may still be drawing its rows: keep trying for a moment until it's tall enough. Someone
    // scrolling meanwhile wins.
    const until = performance.now() + 1000;
    let frame = 0;
    const restore = () => {
      window.scrollTo({ top: y, behavior: "instant" });
      if (Math.abs(window.scrollY - y) > 1 && performance.now() < until) frame = requestAnimationFrame(restore);
    };
    const stop = () => cancelAnimationFrame(frame);
    restore();
    window.addEventListener("wheel", stop, { once: true, passive: true });
    window.addEventListener("touchstart", stop, { once: true, passive: true });
    return () => {
      stop();
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
    };
    // Only a new screen: a filter or tab changing the address keeps the page where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  /**
   * The count beside a link: a quiet number; new requests in a request-amber pill; a red pill only
   * where someone's waiting on you (a mention, an invoice past due). Team chat with something unread
   * and no mention has a small dot. Keyed on the number, so a count pops once when it changes.
   */
  const badge = (item: NavItem) => {
    if (item.to === "/field/jobs" && offers) return <span key={offers} className="nav-count" aria-label={t.plural(offers, { one: "{count} waiting for your answer", other: "{count} waiting for your answer" })}>{offers}</span>;
    if (item.to === "/requests" && counts.data?.requests) return <span key={counts.data.requests} className="nav-count nav-count-new">{counts.data.requests}</span>;
    if (item.to === "/invoices" && counts.data?.overdue) return <span key={counts.data.overdue} className="nav-count nav-count-alert" aria-label={t.plural(counts.data.overdue, { one: "{count} past due", other: "{count} past due" })}>{counts.data.overdue}</span>;
    if (item.to === "/chat" && chat.mentions) return <span key={chat.mentions} className="nav-count nav-count-alert" aria-label={t.plural(chat.mentions, { one: "{count} mention", other: "{count} mentions" })}>{chat.mentions}</span>;
    if (item.to === "/chat" && chat.unread) return <span className="nav-dot" role="img" aria-label={t("New messages")} />;
    return null;
  };
  // A section stays highlighted on its related screens (Settings while in Automations, and so on).
  const under = (paths: string[] | undefined) => (paths ?? []).some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
  const within = (item: NavItem) => under(item.also);
  // ...and steps aside for a screen under it that has its own link (My paperwork under My day).
  const active = (item: NavItem, isActive: boolean) => (isActive && !under(item.except)) || within(item);
  const navClass = (item: NavItem) => ({ isActive }: { isActive: boolean }) => `nav-link${active(item, isActive) ? " active" : ""}`;
  const current = (item: NavItem) => (under(item.except) ? "false" : "page");
  // On a phone, a screen none of the tabs is for (Invoices, Settings) is one of More's.
  const tabPath = (item: NavItem) => item.to.split("?")[0]!;
  const here = (item: NavItem) => {
    const path = tabPath(item);
    return active(item, path === "/" ? location.pathname === "/" : under([path]));
  };
  const onTab = tabs.some(here);

  const themeChoices: Array<{ value: "light" | "dark" | "system"; label: string; icon: IconName }> = [
    { value: "light", label: t("Light"), icon: "sun" },
    { value: "dark", label: t("Dark"), icon: "moon" },
    { value: "system", label: t("Match device"), icon: "monitor" },
  ];
  const accountItems: MenuEntry[] = [
    // Who's signed in, and where (Menus.dc.html). A menu's row is something to pick, so it opens their profile too.
    {
      label: myName,
      lead: <span className="avatar account-face" style={{ background: session.profile.color || "var(--avatar)" }}><Face name={session.profile.full_name || shownEmail} photo={session.profile.avatar_url} /></span>,
      description: [session.roleName, session.company.name].filter(Boolean).join(" · "),
      title: t("Your profile"),
      onSelect: () => navigate("/settings?tab=profile"),
    },
    { separator: true },
    { label: t("Your profile"), icon: "user", onSelect: () => navigate("/settings?tab=profile") },
    { label: t("Settings"), icon: "settings", kbd: ",", hidden: sub, onSelect: () => navigate("/settings") },
    {
      label: t("Appearance"),
      icon: theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor",
      end: themeChoices.find((c) => c.value === theme)?.label,
      items: themeChoices.map((c) => ({ label: c.label, icon: c.icon, checked: theme === c.value, onSelect: () => setTheme(c.value) })),
    },
    { separator: true },
    { label: t("Sign out"), icon: "logout", onSelect: () => void signOut() },
  ];

  return (
    <div className="shell" data-sidebar={closed ? "closed" : undefined}>
      <div className="route-progress" data-active={navigation.state !== "idle" || undefined} aria-hidden="true" />
      {!online && <OfflinePill />}
      <RestartBanner />

      {/* Closed, each icon names itself on hover, beside it (Tooltips). */}
      <aside className="sidebar" id="sidebar" aria-label={t("Primary")} lang={shellLang} data-tip={closed ? "right" : undefined}>
        <Link to={sub ? "/field" : "/"} className="brand" aria-label={t("Crewtavo home")} viewTransition>
          <BrandLockup size={30} />
        </Link>
        <CreateMenu />
        <nav className="nav nav-scroll" ref={navRef}>
          <span className="nav-pill" aria-hidden="true" />
          {groups.map((group, i) => (
            <div key={i} className="nav" role={group.label ? "group" : undefined} aria-labelledby={group.label ? `nav-group-${i}` : undefined}>
              {group.label ? (
                // Closed, a group's name turns into a short line and can't fold it: every link shows, as icons.
                <button type="button" className="nav-label" id={`nav-group-${i}`} aria-expanded={!folded.includes(group.label)} aria-controls={`nav-rows-${i}`} onClick={() => toggleGroup(group.label!)} tabIndex={closed ? -1 : undefined} aria-hidden={closed || undefined}>
                  {t(group.label)}
                  <Icon name={folded.includes(group.label) ? "chevronRight" : "chevronDown"} size={12} />
                </button>
              ) : (
                i > 0 && <span className="nav-divider" />
              )}
              <div className="nav" id={`nav-rows-${i}`}>
                {/* A folded group still shows the page you're on, so you can see where you are. */}
                {group.items.filter((item) => closed || !group.label || !folded.includes(group.label) || here(item)).map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass(item)} aria-current={current(item)} title={closed ? t(item.label) : undefined} viewTransition>
                    {({ isActive }) => (
                      <>
                        <Icon name={item.icon} size={18} filled={active(item, isActive)} />
                        <span className="nav-text">{t(item.label)}</span>
                        {badge(item)}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <nav className="nav nav-bottom" aria-label={t("Settings")}>
          {[...foot, settings].map((item) => (
            <NavLink key={item.to} to={item.to} className={navClass(item)} title={closed ? t(item.label) : undefined} viewTransition>
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} size={18} filled={active(item, isActive)} />
                  <span className="nav-text">{t(item.label)}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar" data-scrolled={scrolled || undefined} lang={shellLang}>
          <button type="button" className="icon-btn hide-mobile sidebar-toggle" onClick={() => setClosed(flipSidebar)} aria-controls="sidebar" aria-expanded={!closed} aria-label={closed ? t("Open sidebar") : t("Close sidebar")} title={sidebarWords}>
            <Icon name="chevronsLeft" size={18} />
          </button>
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
          <span className="topbar-gap" />
          {!sub && (
            <button type="button" className="search" onClick={openPalette} aria-label={t("Search (⌘K)")}>
              <Icon name="search" size={16} />
              <span>{t("Search")}</span>
              <kbd className="kbd">{mac ? "⌘K" : t("Ctrl K")}</kbd>
            </button>
          )}
          {!sub && (
            <>
              <button type="button" className="icon-btn mobile-only" onClick={openPalette} aria-label={t("Search")}><Icon name="search" size={20} /></button>
              <Link className="icon-btn hide-mobile" to="/messages" aria-label={waiting ? t.plural(waiting, { one: "Messages, {count} waiting on a reply", other: "Messages, {count} waiting on a reply" }) : t("Messages")} title={t("Messages")}>
                <Icon name="messages" size={20} />
                {/* A client's message waits on the office: as the bell's dot, until it's answered or marked done. */}
                {waiting > 0 && <span className="notif-dot" aria-hidden="true" />}
              </Link>
            </>
          )}
          {/* On a phone the team finds Help in More; a sub, who has no More, keeps it here. */}
          <HelpButton buttonClassName={sub ? "icon-btn" : "icon-btn hide-mobile"} />
          <NotificationsButton />
          <Menu
            label={t("Account")}
            triggerClassName="icon-btn account-trigger"
            trigger={<span className="avatar account-avatar" style={{ background: session.profile.color || "var(--avatar)" }}><Face name={session.profile.full_name || shownEmail} photo={session.profile.avatar_url} /></span>}
            items={accountItems}
          />
        </header>

        <Screen key={location.pathname} />
      </div>

      <nav className="mobile-nav" aria-label={t("Primary")} lang={shellLang} data-typing={typing || undefined} style={{ gridTemplateColumns: `repeat(${tabs.length + (sub ? 0 : 1)}, minmax(0, 1fr))` }}>
        {tabs.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (active(item, isActive) ? "active" : "")} aria-current={current(item)} viewTransition>
            {({ isActive }) => (
              <>
                <span className="mobile-tab-icon">
                  <Icon name={item.icon} size={24} filled={active(item, isActive)} />
                  {item.to === "/field/jobs" && offers > 0 && <span className="tab-count tab-count-green" aria-label={t.plural(offers, { one: "{count} waiting for your answer", other: "{count} waiting for your answer" })}>{offers}</span>}
                  {item.to === "/chat" && (chat.mentions ? <span className="tab-count" aria-label={t.plural(chat.mentions, { one: "{count} mention", other: "{count} mentions" })}>{chat.mentions}</span> : chat.unread ? <span className="tab-dot" role="img" aria-label={t("New messages")} /> : null)}
                </span>
                {t(item.label)}
              </>
            )}
          </NavLink>
        ))}
        {!sub && (
          <button type="button" className={moreOpen || !onTab ? "active" : undefined} onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
            <span className="mobile-tab-icon"><Icon name="apps" size={24} /></span>
            {t("More")}
          </button>
        )}
      </nav>

      {!sub && (
        <MoreSheet
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          groups={groups.map((g) => ({ ...g, items: g.items.filter((item) => !tabs.some((tab) => tab.to === item.to)) })).filter((g) => g.items.length)}
          foot={[...foot, settings]}
          badge={badge}
          isCurrent={active}
          lang={shellLang}
        />
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

/**
 * "Create" in the sidebar: the things people start most often, the tools below a line. Each shows the
 * shortcut that works from anywhere (N, then its letter); in the open menu the letter alone picks it.
 */
function CreateMenu() {
  const navigate = useNavigate();
  const items = useCreateItems();
  if (!items.length) return null;
  const entry = (item: (typeof items)[number]): MenuEntry => ({ label: t(item.label), icon: item.icon, kbd: item.key, kbdLabel: `N ${item.key}`, onSelect: () => navigate(item.to) });
  return (
    <Menu
      label={t("Create")}
      align="start"
      triggerClassName="nav-link create-trigger"
      trigger={
        <>
          <span className="nav-create-dot"><Icon name="plus" size={12} bold /></span>
          <span className="nav-text">{t("Create")}</span>
        </>
      }
      items={[...items.filter((item) => !item.tool).map(entry), { separator: true }, ...items.filter((item) => item.tool).map(entry)]}
    />
  );
}

/**
 * The phone's More tab: a bottom sheet with the things to start (three to a row), then every section
 * this person can open that isn't a tab, under the sidebar's group names, and Apps, Settings and
 * Help at the end. A modal dialog, so the screen behind is out of reach and Escape puts it away; the
 * handle drags it down.
 */
function MoreSheet({
  open,
  onClose,
  groups,
  foot,
  badge,
  isCurrent,
  lang,
}: {
  open: boolean;
  onClose: () => void;
  groups: Array<{ label: string | null; items: NavItem[] }>;
  foot: NavItem[];
  badge: (item: NavItem) => ReactNode;
  isCurrent: (item: NavItem, isActive: boolean) => boolean;
  lang: string | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const navigate = useNavigate();
  const creates = useCreateItems();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      announceTopLayer();
      // Not the first link: a sheet opened by a tap shouldn't show a focus ring on what's under the thumb.
      dialog.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <dialog
      ref={ref}
      className="more-sheet"
      aria-label={t("All sections")}
      lang={lang}
      tabIndex={-1}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <span className="sheet-grab" aria-hidden="true" onPointerDown={(e) => dragSheet(e, ref.current, onClose)} />
      {creates.length > 0 && (
        <section aria-labelledby="more-create">
          <h2 className="more-label" id="more-create">{t("Create")}</h2>
          <div className="more-tiles">
            {creates.map((item) => (
              <button key={item.to} type="button" className="more-tile" aria-label={item.newLabel} onClick={() => go(item.to)}>
                <Icon name={item.icon} size={22} />
                {t(item.label)}
              </button>
            ))}
          </div>
        </section>
      )}
      {groups.map((group, i) => (
        <div key={group.label ?? i} className="more-group" role={group.label ? "group" : undefined} aria-labelledby={group.label ? `more-group-${i}` : undefined}>
          {group.label && <h2 className="more-label" id={`more-group-${i}`}>{t(group.label)}</h2>}
          {group.items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `more-item${isCurrent(item, isActive) ? " active" : ""}`} onClick={onClose} viewTransition>
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} size={22} filled={isCurrent(item, isActive)} />
                  <span className="more-text">{t(item.label)}</span>
                  <span className="more-end">
                    {badge(item)}
                    <Icon name="chevronRight" size={17} />
                  </span>
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}
      <div className="more-group more-foot" role="group" aria-label={t("Settings")}>
        {foot.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `more-item${isCurrent(item, isActive) ? " active" : ""}`} onClick={onClose} viewTransition>
            {({ isActive }) => (
              <>
                <Icon name={item.icon} size={22} filled={isCurrent(item, isActive)} />
                <span className="more-text">{t(item.label)}</span>
                <span className="more-end"><Icon name="chevronRight" size={17} /></span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          className="more-item"
          aria-haspopup="dialog"
          onClick={() => {
            onClose();
            openHelp();
          }}
        >
          <Icon name="help" size={22} />
          <span className="more-text">{t("Help")}</span>
        </button>
      </div>
    </dialog>
  );
}

/** Dragging the sheet's handle: it follows the finger down, and goes away if pulled far or flicked. */
function dragSheet(e: ReactPointerEvent<HTMLElement>, sheet: HTMLElement | null, close: () => void) {
  if (!sheet || e.button !== 0) return;
  const grab = e.currentTarget;
  const startY = e.clientY;
  let lastY = startY;
  let lastTime = e.timeStamp;
  let velocity = 0;
  grab.setPointerCapture?.(e.pointerId);
  sheet.dataset.dragging = "";
  const move = (ev: PointerEvent) => {
    velocity = (ev.clientY - lastY) / Math.max(1, ev.timeStamp - lastTime);
    lastY = ev.clientY;
    lastTime = ev.timeStamp;
    sheet.style.transform = `translateY(${Math.max(0, ev.clientY - startY)}px)`;
  };
  const end = (ev: PointerEvent) => {
    grab.removeEventListener("pointermove", move);
    grab.removeEventListener("pointerup", end);
    grab.removeEventListener("pointercancel", end);
    delete sheet.dataset.dragging;
    sheet.style.transform = "";
    if (ev.type === "pointerup" && sheetDismissed(Math.max(0, ev.clientY - startY), velocity)) close();
  };
  grab.addEventListener("pointermove", move);
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
}
