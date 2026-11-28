/**
 * ⌘K / Ctrl+K: search every client (by name, contacts, email, phone or tag), address, request, quote, job,
 * invoice, measurement, guide, campaign, automation, price list service, file, piece of equipment (the
 * company's or at a client's property), subcontractor, applicant, chat channel or message, promo code and app, jump to
 * any screen or section of Settings, or start something new. "/" also opens it when you're not typing in a field.
 *
 * Outside a field, G then a screen's key goes there and N then a Create item's key starts it (nav.ts
 * shortcutTarget); search shows each one's keys beside it.
 *
 * Opened empty, it starts on what you opened recently (lib/recent.ts), then a few things to start and
 * screens. Typing groups what it finds by kind, with the letters that matched in bold and, for a row
 * found by its hidden keywords, the words that found it (paletteMatch.ts).
 */
import { kindLabel } from "@crewtavo/core/equipment";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, searchTerm, supabase, unwrap } from "@/lib/api";
import { type AppsData, categoryName, infoFor } from "@/features/apps/catalog";
import { settingsGroups } from "@/features/settings/sections";
import { managesSubs } from "@/features/subs/subsData";
import { afterExit, announceTopLayer } from "@/lib/motion";
import { getRecents } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { Spinner } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { createItems, NAV_GROUPS, navVisible, OTHER_SCREENS, shortcutTarget } from "./nav";
import { keywordHint, marks } from "./paletteMatch";
import { english, getLocale, msg, t } from "@/lib/i18n";

let opener: (() => void) | null = null;
export const openPalette = () => opener?.();

interface Item {
  id: string;
  group: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  keywords?: string;
  /** The keys that do it from anywhere ("G then S"), shown on the right. */
  kbd?: string;
  run: () => void;
}

const KIND_ICON: Record<string, IconName> = {
  client: "clients", property: "pin", request: "requests", quote: "quote", job: "job", invoice: "invoice", equipment: "truck",
  measurement: "area", kb: "book", campaign: "marketing", rule: "bolt", service: "list", sub: "users", file: "file",
  applicant: "user", channel: "hash", asset: "wrench", promo: "tag", chat: "chat",
};
const KIND_PATH: Record<string, (r: { id: string; client_id: string | null; title: string; parent_id: string | null }) => string> = {
  client: (r) => `/clients/${r.id}`,
  property: (r) => `/clients/${r.client_id}`,
  request: (r) => `/requests/${r.id}`,
  quote: (r) => `/quotes/${r.id}`,
  job: (r) => `/jobs/${r.id}`,
  invoice: (r) => `/invoices/${r.id}`,
  equipment: (r) => `/equipment/${r.id}`,
  measurement: (r) => `/measure?measurement=${r.id}`,
  kb: (r) => `/kb/${r.id}`,
  campaign: (r) => `/marketing/campaigns/${r.id}`,
  rule: (r) => `/automations/${r.id}`,
  service: (r) => `/settings?tab=prices&q=${encodeURIComponent(r.title)}`,
  sub: (r) => `/subs/${r.id}`,
  // Opens in Drive's viewer.
  file: (r) => `/drive?file=${r.id}`,
  applicant: (r) => `/applicants/${r.id}`,
  channel: (r) => `/chat/${r.id}`,
  // A team chat message, in its channel.
  chat: (r) => `/chat/${r.parent_id}?message=${r.id}`,
  // Shown on the client's page, under its property.
  asset: (r) => `/clients/${r.client_id}`,
  promo: () => "/marketing?tab=promos",
};
/** The group each kind of record is listed under. */
const KIND_GROUP: Record<string, string> = {
  client: msg("Clients"), property: msg("Properties"), request: msg("Requests"), quote: msg("Quotes"), job: msg("Jobs"), invoice: msg("Invoices"), equipment: msg("Equipment"),
  measurement: msg("Measurements"), kb: msg("Guides"), campaign: msg("Campaigns"), rule: msg("Automations"), service: msg("Price list"), sub: msg("Subcontractors"), file: msg("Files"),
  applicant: msg("Applicants"), channel: msg("Team chat"), asset: msg("Property equipment"), promo: msg("Promo codes"), chat: msg("Chat messages"),
};
/** A two-key shortcut as it reads: "G then S". */
const keys = (first: string, second: string) => t("{first} then {second}", { first, second });
const SCREENS = [...NAV_GROUPS.flat(), ...OTHER_SCREENS];
/** Screens with single-key tools of their own (Measure's, the trade apps' maps), where G and N stay theirs. */
const OWN_KEYS = /^\/(measure|paving|roofing)(\/|$)/;
/** How long after G or N the second key still counts. */
const SEQUENCE_MS = 1500;

/** Kinds that live in an app or area someone may not have: shown only to whoever sees that screen. */
const KIND_SCREEN: Record<string, string> = { applicant: "/applicants", channel: "/chat", chat: "/chat", promo: "/marketing?tab=promos", campaign: "/marketing" };

export function CommandPalette() {
  const session = useSession();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  // It keeps its last results on screen while it animates out, and starts afresh each time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open);
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }
  // The database search takes what was typed as it is ("joe@acme.com", "O'Brien", "(555) 123-4567");
  // the plain table lookups need it without the characters their filters use.
  const typed = useDeferredValue(query.trim());
  const term = searchTerm(typed);
  // Two letters before it looks, except a number: "#7" or "7" is job, quote or invoice 7, and a small
  // business's numbers start at 1.
  const searchable = term.length >= 2 || /^#?\d+$/.test(typed);
  // For the shortcuts, which listen from the first render on.
  const latest = useRef({ session, navigate });
  latest.current = { session, navigate };

  useEffect(() => {
    opener = () => setOpen(true);
    let pending: { key: string; at: number } | null = null;
    const somethingOpen = () => {
      try {
        // A dialog, or a menu or panel (not a toast or banner, which are popover="manual").
        return Boolean(document.querySelector('dialog[open], [popover="auto"]:popover-open'));
      } catch {
        return Boolean(document.querySelector("dialog[open]"));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      // Not when something on the screen already used it (⌘K adds a link in the guide editor).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.defaultPrevented) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setOpen(true);
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && !e.defaultPrevented && e.key.length === 1 && !somethingOpen() && !OWN_KEYS.test(window.location.pathname)) {
        // G S, N R: the second key within a moment of the first.
        const key = e.key.toLowerCase();
        if (pending && e.timeStamp - pending.at < SEQUENCE_MS) {
          const to = shortcutTarget(latest.current.session, pending.key, key);
          pending = null;
          if (to) {
            e.preventDefault();
            latest.current.navigate(to);
          }
          return;
        }
        pending = key === "g" || key === "n" ? { key, at: e.timeStamp } : null;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      opener = null;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      announceTopLayer();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!leaving || !dialog) return;
    return afterExit(dialog, () => {
      setLeaving(false);
      setQuery("");
      setIndex(0);
    });
  }, [leaving]);

  const results = useQuery({
    queryKey: ["global-search", session.company.id, typed],
    enabled: open && searchable,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    meta: { silent: true },
    queryFn: async () => {
      const [found, gear, subs] = await Promise.all([
        supabase().rpc("global_search", { p_company_id: session.company.id, p_query: typed, p_limit: 5 }),
        supabase().from("equipment").select("id, name, kind, make, model").eq("company_id", session.company.id).neq("status", "retired")
          .or(`name.ilike.%${term}%,make.ilike.%${term}%,model.ilike.%${term}%`).limit(3),
        // Only the office with the Subcontractors area can read subs at all.
        managesSubs(session)
          ? supabase().from("subcontractors").select("id, name, trade").eq("company_id", session.company.id).eq("active", true).ilike("name", `%${term}%`).limit(3)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const records = unwrap(found);
      const equipment: Array<Omit<(typeof records)[number], "number" | "client_id" | "parent_id"> & { number: number | null; client_id: string | null; parent_id: string | null }> = unwrap(gear).map((g) => ({
        kind: "equipment", id: g.id, title: g.name, subtitle: [kindLabel(g.kind), g.make, g.model].filter(Boolean).join(" "), status: "", number: null, client_id: null, parent_id: null,
      }));
      const subcontractors: typeof equipment = unwrap(subs).map((s) => ({ kind: "sub", id: s.id, title: s.name, subtitle: s.trade ?? "", status: "", number: null, client_id: null, parent_id: null }));
      // Files open in Drive, which is the office's: crews find theirs on their visits.
      const opensFiles = hasRole(session, "admin", "office", "estimator");
      const opens = (kind: string) => !KIND_SCREEN[kind] || SCREENS.some((n) => n.to === KIND_SCREEN[kind] && navVisible(session, n));
      return [...records.filter((r) => KIND_PATH[r.kind] && (r.kind !== "file" || opensFiles) && opens(r.kind)), ...equipment, ...subcontractors];
    },
  });

  // Apps by name ("quickbooks", "google calendar"), for whoever can set them up.
  const canConnectApps = hasRole(session, "admin") && can(session, "apps");
  const apps = useQuery({
    queryKey: ["apps", session.company.id],
    enabled: open && canConnectApps,
    queryFn: () => api.get<AppsData>("/apps"),
    staleTime: 60_000,
    meta: { silent: true },
  });

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);

  const items = useMemo<Item[]>(() => {
    const isOffice = hasRole(session, "admin", "office");
    // i18n-ignore: words to find it by, never shown
    const creates: Item[] = createItems(session).map((c) => ({ id: `new-${c.to}`, group: msg("Create"), icon: c.icon, title: c.newLabel, keywords: `add new ${english(c.label)} ${c.keywords}`, kbd: keys("N", c.key), run: () => go(c.to) }));
    const actions: Item[] = [
      ...creates,
      ...(isOffice && can(session, "kb_edit") ? [{ id: "new-guide", group: msg("Create"), icon: "book" as IconName, title: t("New guide"), keywords: "add knowledge base sop procedure page", run: () => go("/kb/new") }] : []),
      ...(isOffice && can(session, "automations") ? [{ id: "new-rule", group: msg("Create"), icon: "bolt" as IconName, title: t("New automation"), keywords: "add rule reminder follow up", run: () => go("/automations/new") }] : []),
      ...(managesSubs(session) ? [{ id: "new-sub", group: msg("Create"), icon: "users" as IconName, title: t("New subcontractor"), keywords: "add sub contractor vendor", run: () => go("/subs?new=1") }] : []),
    ];
    const screens: Item[] = SCREENS
      .filter((n) => navVisible(session, n))
      // Found by its name in either language ("agenda" or "schedule").
      .map((n) => ({ id: `go-${n.to}`, group: msg("Go to"), icon: n.icon, title: t(n.label), keywords: `${english(n.label)} ${n.to} ${n.keywords ?? ""}`, kbd: n.go ? keys("G", n.go) : undefined, run: () => go(n.to) }));
    screens.push({ id: "go-settings", group: msg("Go to"), icon: "settings", title: t("Settings"), keywords: "preferences options setup", run: () => go("/settings") });
    // Their section's name and "Settings" go last, after commas, so the words that found a row are its own (paletteMatch.ts).
    const settings: Item[] = settingsGroups(session).flatMap((g) =>
      g.items.map((s) => {
        const to = "tab" in s ? `/settings?tab=${s.tab}` : s.to;
        return { id: `go-${to}`, group: msg("Settings"), icon: s.icon, title: t(s.label), keywords: `${s.keywords}, ${g.title}, ${t("Settings")}`, run: () => go(to) };
      }),
    );
    const appItems: Item[] = (apps.data?.apps ?? []).map((a) => ({
      id: `app-${a.id}`, group: msg("Apps"), icon: "apps", title: a.name, subtitle: categoryName(a.category),
      // i18n-ignore: words to find it by, never shown
      keywords: `app integration ${a.id.replace(/_/g, " ")} ${infoFor(a).tagline}, ${t("Apps")}`, run: () => go(`/apps/${a.id}`),
    }));

    if (!q) {
      // What you opened lately first (up to 8, lib/recent.ts), then a few to start: the Create menu has them all.
      const recents: Item[] = getRecents(session.company.id).map((r) => ({
        id: `recent-${r.kind}-${r.id}`, group: msg("Recent"), icon: KIND_ICON[r.kind] ?? "file", title: r.title, subtitle: r.subtitle, run: () => go(r.path),
      }));
      return [...recents, ...creates.slice(0, 2), ...screens.slice(0, 3)];
    }
    // Every word has to appear somewhere; a screen or action whose name starts with what was typed
    // comes first, so "measure" or "price" opens the screen before records that mention it.
    const local = [...actions, ...screens, ...settings, ...appItems].filter((i) => {
      const text = `${i.title} ${i.subtitle ?? ""} ${i.keywords ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    // Out of its group, a section of Settings says so.
    const best = local.filter((i) => i.title.toLowerCase().startsWith(q)).map((i) => ({ ...i, group: msg("Best match"), subtitle: i.subtitle ?? (i.group === msg("Settings") ? t("Settings") : undefined) }));
    // Grouped by kind, the kinds in the order they were found.
    // What the last search found stays up while the next one runs, but not once too little is typed
    // to search at all (back to one letter): those results were for something else.
    const found = searchable ? (results.data ?? []) : [];
    const records: Item[] = [...new Set(found.map((r) => r.kind))].flatMap((kind) => found.filter((r) => r.kind === kind)).map((r) => ({
      id: `${r.kind}-${r.id}`,
      group: KIND_GROUP[r.kind],
      icon: KIND_ICON[r.kind] ?? "file",
      title: r.number ? `${r.title} · #${r.number}` : r.title,
      subtitle: r.subtitle,
      run: () => go(KIND_PATH[r.kind](r)),
    }));
    return [...best, ...records, ...local.filter((i) => !best.some((b) => b.id === i.id))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchable, results.data, apps.data, session.company.id, session.role, session.permissions]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[index]?.run();
    }
  };

  let lastGroup = "";
  const searching = searchable && results.isFetching;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  const bold = (text: string) => marks(text, words).map(([part, hit], k) => (hit ? <b key={k}>{part}</b> : part));

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label={t("Search and commands")}
      onClose={() => setOpen(false)}
      onCancel={(e) => {
        e.preventDefault();
        setOpen(false);
      }}
      onClick={(e) => e.target === ref.current && setOpen(false)}
    >
      {(open || leaving) && (
        <>
          <div className="palette-input">
            <label className="palette-field">
              {searching ? <Spinner size={16} /> : <Icon name="search" size={16} />}
              <input
                ref={input}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("Search anything: clients, jobs, files, apps, settings… or type a command")}
                aria-label={t("Search")}
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={items[index] ? `palette-${items[index].id}` : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button type="button" className="kbd palette-esc" onClick={() => setOpen(false)}>{t("Esc")}</button>
            <button type="button" className="palette-cancel" onClick={() => setOpen(false)}>{t("Cancel")}</button>
          </div>
          <div className="palette-list" id="palette-list" role="listbox" aria-label={t("Search")} ref={list}>
            {items.length === 0 && (
              <div className="palette-empty">
                {!searchable ? t("Keep typing…") : results.isFetching ? t("Searching…") : t("No results for “{query}”", { query: query.trim() })}
              </div>
            )}
            {items.map((item, i) => {
              const header = item.group !== lastGroup ? (
                <div className="palette-group" key={`g-${item.group}`} aria-hidden="true">
                  {t(item.group)}
                  {q && item.group !== msg("Best match") && item.group !== msg("Create") && <span className="p-count">{counts.get(item.group)}</span>}
                </div>
              ) : null;
              lastGroup = item.group;
              // The hidden search words are English, so the hint only shows in English.
              const hint = getLocale() === "en" ? keywordHint(`${item.title} ${item.subtitle ?? ""}`, item.keywords, words) : undefined;
              return (
                <div key={item.id} role="none">
                  {header}
                  <button
                    type="button"
                    id={`palette-${item.id}`}
                    className="palette-item"
                    role="option"
                    data-index={i}
                    aria-selected={i === index}
                    onMouseMove={() => i !== index && setIndex(i)}
                    onClick={item.run}
                  >
                    <span className="p-icon"><Icon name={item.icon} size={16} /></span>
                    <span className="p-text">
                      <span className="p-title">{bold(item.title)}</span>
                      {hint ? <span className="p-sub">{bold(hint)}</span> : item.subtitle && <span className="p-sub">{item.subtitle}</span>}
                    </span>
                    {item.kbd && <span className="p-keys" aria-hidden="true">{item.kbd}</span>}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="palette-foot hide-mobile" aria-hidden="true">
            <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd><span>{t("to move")}</span>
            <kbd className="kbd">↵</kbd><span>{t("to open")}</span>
            <kbd className="kbd">{t("Esc")}</kbd><span>{t("to close")}</span>
          </div>
        </>
      )}
    </dialog>
  );
}
