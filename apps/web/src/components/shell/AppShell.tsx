import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigation, useViewTransitionState } from "react-router-dom";
import { supabase } from "@/lib/api";
import { useSession } from "@/lib/session";
import { prefetchScreens } from "@/routes";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { CommandPalette, openPalette } from "./CommandPalette";
import { createItems, MOBILE_TABS, NAV_GROUPS, navVisible, SETTINGS_ITEM, type NavItem } from "./nav";
import { NotificationsButton } from "./Notifications";
import { BrandLockup } from "./BrandMark";

export function initials(name: string | null | undefined) {
  return (name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function useVisibleGroups(): NavItem[][] {
  const session = useSession();
  return NAV_GROUPS.map((group) => group.filter((item) => navVisible(session, item))).filter((g) => g.length);
}

/** New requests waiting, shown beside Requests in the sidebar. */
function useNewRequests() {
  const { company } = useSession();
  return useQuery({
    queryKey: ["nav-counts", company.id],
    queryFn: async () => {
      const { count } = await supabase().from("requests").select("id", { count: "exact", head: true }).eq("company_id", company.id).eq("status", "new");
      return { requests: count ?? 0 };
    },
    refetchInterval: 60_000,
    meta: { silent: true },
  });
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

export function AppShell() {
  const session = useSession();
  const groups = useVisibleGroups();
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const online = useOnline();
  const counts = useNewRequests();

  useEffect(() => {
    prefetchScreens();
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

  const badge = (item: NavItem) => (item.to === "/requests" && counts.data?.requests ? <span className="badge badge-green nav-badge">{counts.data.requests}</span> : null);
  // A section stays highlighted on its related screens (Settings while in Automations, and so on).
  const within = (item: NavItem) => (item.also ?? []).some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));
  const navClass = (item: NavItem) => ({ isActive }: { isActive: boolean }) => `nav-link${isActive || within(item) ? " active" : ""}`;

  return (
    <div className="shell">
      <div className="route-progress" data-active={navigation.state !== "idle" || undefined} aria-hidden="true" />
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="wifiOff" size={16} />
          You're offline. Visit updates are saved and sent when you reconnect; other changes need a connection.
        </div>
      )}

      <aside className="sidebar" aria-label="Primary">
        <Link to="/" className="brand" aria-label="Crewtavo home" viewTransition>
          <BrandLockup size={30} />
        </Link>
        <nav className="nav">
          <CreateMenu />
          {groups.map((group, i) => (
            <div key={i} className="nav">
              {i > 0 && <span className="nav-divider" />}
              {group.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass(item)} viewTransition>
                  <Icon name={item.icon} />
                  {item.label}
                  {badge(item)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <nav className="nav nav-bottom" aria-label="Settings">
          <NavLink to={SETTINGS_ITEM.to} className={navClass(SETTINGS_ITEM)} viewTransition>
            <Icon name={SETTINGS_ITEM.icon} />
            {SETTINGS_ITEM.label}
          </NavLink>
        </nav>
      </aside>

      <div className="main">
        <header className="topbar" data-scrolled={scrolled || undefined}>
          <div className="business">
            <span className="business-tile" aria-hidden="true">{initials(session.company.name)}</span>
            {session.companies.length > 1 ? (
              <select className="business-name" aria-label="Switch business" value={session.company.id} onChange={(e) => session.switchCompany(e.target.value)}>
                {session.companies.map((m) => (
                  <option key={m.company.id} value={m.company.id}>{m.company.name}</option>
                ))}
              </select>
            ) : (
              <span className="business-name">{session.company.name}</span>
            )}
          </div>
          <button type="button" className="search" onClick={openPalette} aria-label="Search (⌘K)">
            <Icon name="search" size={16} />
            <span>Search</span>
            <kbd className="kbd">{navigator.platform.toLowerCase().includes("mac") ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <button type="button" className="icon-btn mobile-only" onClick={openPalette} aria-label="Search"><Icon name="search" size={20} /></button>
          <Link className="icon-btn hide-mobile" to="/messages" aria-label="Messages" title="Messages"><Icon name="messages" size={20} /></Link>
          <NotificationsButton />
          <Menu
            label="Account"
            triggerClassName="icon-btn"
            trigger={<span className="avatar" style={{ width: 30, height: 30, fontSize: 11, background: session.profile.color || "var(--avatar)" }}>{initials(session.profile.full_name || session.profile.email)}</span>}
            items={[
              { heading: session.profile.full_name || session.profile.email || "Account" },
              { label: "Your profile", icon: "user", onSelect: () => navigate("/settings?tab=profile") },
              { label: "Settings", icon: "settings", onSelect: () => navigate("/settings") },
              { separator: true },
              { label: "Sign out", icon: "logout", onSelect: () => session.signOut() },
            ]}
          />
        </header>

        <Screen key={location.pathname} />
      </div>

      <nav className="mobile-nav" aria-label="Primary">
        {MOBILE_TABS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} viewTransition>
            <Icon name={item.icon} size={22} />
            {item.label}
          </NavLink>
        ))}
        <button type="button" onClick={() => setMoreOpen(true)} aria-haspopup="dialog" aria-expanded={moreOpen}>
          <Icon name="menu" size={22} />
          More
        </button>
      </nav>

      {moreOpen && (
        <>
          <div className="sheet-backdrop" onClick={() => setMoreOpen(false)} />
          <div className="sheet" role="dialog" aria-label="All sections">
            <MobileCreate onDone={() => setMoreOpen(false)} />
            <nav className="nav">
              {[...groups.flat(), SETTINGS_ITEM].map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"} className={navClass(item)} onClick={() => setMoreOpen(false)} viewTransition>
                  <Icon name={item.icon} />
                  {item.label}
                  {badge(item)}
                </NavLink>
              ))}
            </nav>
          </div>
        </>
      )}

      <CommandPalette />
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
  const transitioning = useViewTransitionState(location.pathname);
  const [crossFaded] = useState(transitioning);
  return (
    <main className="content" data-crossfade={crossFaded || undefined}>
      <Outlet />
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
      label="Create"
      align="start"
      triggerClassName="nav-link create-trigger"
      trigger={
        <>
          <span className="nav-create-dot"><Icon name="plus" size={12} /></span>
          Create
        </>
      }
      items={items.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => navigate(item.to) }))}
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
          <Icon name={item.icon} size={18} />
          New {item.label.toLowerCase()}
        </button>
      ))}
    </div>
  );
}
