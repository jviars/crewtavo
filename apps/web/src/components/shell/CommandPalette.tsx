/**
 * ⌘K / Ctrl+K: search every client, address, request, quote, job, invoice, measurement, guide, campaign,
 * automation, price list service, file, piece of equipment and subcontractor, jump to any screen or section of
 * Settings, or start something new. "/" also opens it when you're not typing in a field.
 */
import { kindLabel } from "@crewtavo/core/equipment";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { settingsGroups } from "@/features/settings/sections";
import { managesSubs } from "@/features/subs/subsData";
import { afterExit, announceTopLayer } from "@/lib/motion";
import { getRecents } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { Spinner } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { createItems, NAV_GROUPS, navVisible, OTHER_SCREENS } from "./nav";

let opener: (() => void) | null = null;
export const openPalette = () => opener?.();

interface Item {
  id: string;
  group: string;
  icon: IconName;
  title: string;
  subtitle?: string;
  keywords?: string;
  run: () => void;
}

const KIND_ICON: Record<string, IconName> = {
  client: "clients", property: "pin", request: "requests", quote: "quote", job: "job", invoice: "invoice", equipment: "truck",
  measurement: "area", kb: "book", campaign: "marketing", rule: "bolt", service: "list", sub: "users", file: "file",
};
const KIND_PATH: Record<string, (r: { id: string; client_id: string | null; title: string }) => string> = {
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
};
const KIND_LABEL: Record<string, string> = {
  client: "Client", property: "Property", request: "Request", quote: "Quote", job: "Job", invoice: "Invoice", equipment: "Equipment",
  measurement: "Measurement", kb: "Guide", campaign: "Campaign", rule: "Automation", service: "Price list", sub: "Subcontractor", file: "File",
};

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
  const term = useDeferredValue(searchTerm(query));

  useEffect(() => {
    opener = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "/" && !typing && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setOpen(true);
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
    queryKey: ["global-search", session.company.id, term],
    enabled: open && term.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    meta: { silent: true },
    queryFn: async () => {
      const [found, gear, subs] = await Promise.all([
        supabase().rpc("global_search", { p_company_id: session.company.id, p_query: term, p_limit: 5 }),
        supabase().from("equipment").select("id, name, kind, make, model").eq("company_id", session.company.id).neq("status", "retired").ilike("name", `%${term}%`).limit(3),
        // Only the office with the Subcontractors area can read subs at all.
        managesSubs(session)
          ? supabase().from("subcontractors").select("id, name, trade").eq("company_id", session.company.id).eq("active", true).ilike("name", `%${term}%`).limit(3)
          : Promise.resolve({ data: [], error: null }),
      ]);
      const records = unwrap(found);
      const equipment: Array<Omit<(typeof records)[number], "number" | "client_id"> & { number: number | null; client_id: string | null }> = unwrap(gear).map((g) => ({
        kind: "equipment", id: g.id, title: g.name, subtitle: [kindLabel(g.kind), g.make, g.model].filter(Boolean).join(" "), status: "", number: null, client_id: null,
      }));
      const subcontractors: typeof equipment = unwrap(subs).map((s) => ({ kind: "sub", id: s.id, title: s.name, subtitle: s.trade ?? "", status: "", number: null, client_id: null }));
      // Files open in Drive, which is the office's: crews find theirs on their visits.
      const opensFiles = hasRole(session, "admin", "office", "estimator");
      return [...records.filter((r) => KIND_PATH[r.kind] && (r.kind !== "file" || opensFiles)), ...equipment, ...subcontractors];
    },
  });

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const isOffice = hasRole(session, "admin", "office");
    const creates: Item[] = createItems(session).map((c) => ({ id: `new-${c.to}`, group: "Create", icon: c.icon, title: `New ${c.label.toLowerCase()}`, keywords: `add ${c.keywords}`, run: () => go(c.to) }));
    const actions: Item[] = [
      ...creates,
      ...(isOffice && can(session, "kb_edit") ? [{ id: "new-guide", group: "Create", icon: "book" as IconName, title: "New guide", keywords: "add knowledge base sop procedure page", run: () => go("/kb/new") }] : []),
      ...(isOffice && can(session, "automations") ? [{ id: "new-rule", group: "Create", icon: "bolt" as IconName, title: "New automation", keywords: "add rule reminder follow up", run: () => go("/automations/new") }] : []),
      ...(managesSubs(session) ? [{ id: "new-sub", group: "Create", icon: "users" as IconName, title: "New subcontractor", keywords: "add sub contractor vendor", run: () => go("/subs?new=1") }] : []),
    ];
    const screens: Item[] = [...NAV_GROUPS.flat(), ...OTHER_SCREENS]
      .filter((n) => navVisible(session, n))
      .map((n) => ({ id: `go-${n.to}`, group: "Go to", icon: n.icon, title: n.label, keywords: `${n.to} ${n.keywords ?? ""}`, run: () => go(n.to) }));
    screens.push({ id: "go-settings", group: "Go to", icon: "settings", title: "Settings", keywords: "preferences options setup", run: () => go("/settings") });
    const settings: Item[] = settingsGroups(session).flatMap((g) =>
      g.items.map((s) => {
        const to = "tab" in s ? `/settings?tab=${s.tab}` : s.to;
        return { id: `go-${to}`, group: "Go to", icon: s.icon, title: s.label, subtitle: "Settings", keywords: `${g.title} ${s.keywords}`, run: () => go(to) };
      }),
    );

    const q = query.trim().toLowerCase();
    if (!q) {
      const recents: Item[] = getRecents(session.company.id).map((r) => ({
        id: `recent-${r.kind}-${r.id}`, group: "Recent", icon: KIND_ICON[r.kind] ?? "file", title: r.title, subtitle: r.subtitle, run: () => go(r.path),
      }));
      return [...creates, ...recents, ...screens.slice(0, 6)];
    }
    // Every word has to appear somewhere; a screen or action whose name starts with what was typed
    // comes first, so "measure" or "price" opens the screen before records that mention it.
    const words = q.split(/\s+/);
    const local = [...actions, ...screens, ...settings].filter((i) => {
      const text = `${i.title} ${i.subtitle ?? ""} ${i.keywords ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    const best = local.filter((i) => i.title.toLowerCase().startsWith(q)).map((i) => ({ ...i, group: "Best match" }));
    const records: Item[] = (results.data ?? []).map((r) => ({
      id: `${r.kind}-${r.id}`,
      group: "Results",
      icon: KIND_ICON[r.kind] ?? "file",
      title: r.number ? `${r.title} · #${r.number}` : r.title,
      subtitle: [KIND_LABEL[r.kind], r.subtitle].filter(Boolean).join(" · "),
      run: () => go(KIND_PATH[r.kind](r)),
    }));
    return [...best, ...records, ...local.filter((i) => !best.some((b) => b.id === i.id))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, results.data, session.company.id, session.role, session.permissions]);

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
  const searching = term.length >= 2 && results.isFetching;

  return (
    <dialog
      ref={ref}
      className="dialog palette"
      aria-label="Search and commands"
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
            {searching ? <Spinner size={20} /> : <Icon name="search" size={20} />}
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search anything: clients, jobs, measurements, settings… or type a command"
              aria-label="Search"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={items[index] ? `palette-${items[index].id}` : undefined}
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="kbd" onClick={() => setOpen(false)} style={{ cursor: "pointer" }}>Esc</button>
          </div>
          <div className="palette-list" id="palette-list" role="listbox" ref={list}>
            {items.length === 0 && (
              <div className="empty-state empty-state-sm">
                <span className="empty-icon"><Icon name="search" size={20} /></span>
                <h3>{term.length < 2 ? "Keep typing…" : results.isFetching ? "Searching…" : `No results for “${query.trim()}”`}</h3>
                
              </div>
            )}
            {items.map((item, i) => {
              const header = item.group !== lastGroup ? <div className="palette-group" key={`g-${item.group}`}>{item.group}</div> : null;
              lastGroup = item.group;
              return (
                <div key={item.id}>
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
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span className="p-title ellipsis" style={{ display: "block" }}>{item.title}</span>
                      {item.subtitle && <span className="p-sub ellipsis" style={{ display: "block" }}>{item.subtitle}</span>}
                    </span>
                    {i === index && <Icon name="arrowRight" size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="palette-foot hide-mobile">
            <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move</span>
            <span><kbd className="kbd">Enter</kbd> to open</span>
            <span><kbd className="kbd">Esc</kbd> to close</span>
          </div>
        </>
      )}
    </dialog>
  );
}
