/**
 * ⌘K / Ctrl+K: search every client, address, request, quote, job, invoice and piece of equipment, jump to any screen,
 * or start something new. "/" also opens it when you're not typing in a field.
 */
import { kindLabel } from "@crewtavo/core/equipment";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchTerm, supabase, unwrap } from "@/lib/api";
import { getRecents } from "@/lib/recent";
import { can, hasRole, useSession } from "@/lib/session";
import { Spinner } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";
import { NAV_GROUPS, navVisible } from "./nav";

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

const KIND_ICON: Record<string, IconName> = { client: "clients", property: "pin", request: "requests", quote: "quote", job: "job", invoice: "invoice", equipment: "truck" };
const KIND_PATH: Record<string, (id: string, clientId: string | null) => string> = {
  client: (id) => `/clients/${id}`,
  property: (_id, clientId) => `/clients/${clientId}`,
  request: (id) => `/requests/${id}`,
  quote: (id) => `/quotes/${id}`,
  job: (id) => `/jobs/${id}`,
  invoice: (id) => `/invoices/${id}`,
  equipment: (id) => `/equipment/${id}`,
};
const KIND_LABEL: Record<string, string> = { client: "Client", property: "Property", request: "Request", quote: "Quote", job: "Job", invoice: "Invoice", equipment: "Equipment" };

export function CommandPalette() {
  const session = useSession();
  const navigate = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
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
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
    if (!open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const results = useQuery({
    queryKey: ["global-search", session.company.id, term],
    enabled: open && term.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    meta: { silent: true },
    queryFn: async () => {
      const [found, gear] = await Promise.all([
        supabase().rpc("global_search", { p_company_id: session.company.id, p_query: term, p_limit: 5 }),
        supabase().from("equipment").select("id, name, kind, make, model").eq("company_id", session.company.id).neq("status", "retired").ilike("name", `%${term}%`).limit(3),
      ]);
      const records = unwrap(found);
      const equipment: Array<Omit<(typeof records)[number], "number" | "client_id"> & { number: number | null; client_id: string | null }> = unwrap(gear).map((g) => ({
        kind: "equipment", id: g.id, title: g.name, subtitle: [kindLabel(g.kind), g.make, g.model].filter(Boolean).join(" "), status: "", number: null, client_id: null,
      }));
      return [...records, ...equipment];
    },
  });

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const canSell = hasRole(session, "admin", "office", "estimator");
    const isOffice = hasRole(session, "admin", "office");
    const actions: Item[] = [
      ...(canSell
        ? [
            { id: "new-client", group: "Create", icon: "clients" as IconName, title: "New client", keywords: "add customer lead", run: () => go("/clients?new=1") },
            { id: "new-request", group: "Create", icon: "requests" as IconName, title: "New request", keywords: "inquiry lead", run: () => go("/requests?new=1") },
            ...(can(session, "sales") ? [{ id: "new-quote", group: "Create", icon: "quote" as IconName, title: "New quote", keywords: "estimate proposal", run: () => go("/quotes?new=1") }] : []),
          ]
        : []),
      ...(isOffice && can(session, "invoices") ? [{ id: "new-invoice", group: "Create", icon: "invoice" as IconName, title: "New invoice", keywords: "bill", run: () => go("/invoices?new=1") }] : []),
      ...(hasRole(session, "admin", "office", "estimator", "crew_lead") && can(session, "schedule")
        ? [{ id: "new-visit", group: "Create", icon: "calendar" as IconName, title: "New visit or task", keywords: "schedule appointment", run: () => go("/schedule?new=1") }]
        : []),
    ];
    const screens: Item[] = NAV_GROUPS.flat()
      .filter((n) => navVisible(session, n))
      .map((n) => ({ id: `go-${n.to}`, group: "Go to", icon: n.icon, title: n.label, keywords: n.to, run: () => go(n.to) }));
    screens.push({ id: "go-settings", group: "Go to", icon: "settings", title: "Settings", keywords: "company team crews price list profile", run: () => go("/settings") });

    const q = query.trim().toLowerCase();
    if (!q) {
      const recents: Item[] = getRecents(session.company.id).map((r) => ({
        id: `recent-${r.kind}-${r.id}`, group: "Recent", icon: KIND_ICON[r.kind] ?? "file", title: r.title, subtitle: r.subtitle, run: () => go(r.path),
      }));
      return [...actions, ...recents, ...screens.slice(0, 6)];
    }
    const match = (i: Item) => `${i.title} ${i.keywords ?? ""}`.toLowerCase().includes(q);
    const records: Item[] = (results.data ?? []).map((r) => ({
      id: `${r.kind}-${r.id}`,
      group: "Results",
      icon: KIND_ICON[r.kind] ?? "file",
      title: r.number ? `${r.title} · #${r.number}` : r.title,
      subtitle: [KIND_LABEL[r.kind], r.subtitle].filter(Boolean).join(" · "),
      run: () => go(KIND_PATH[r.kind](r.id, r.client_id)),
    }));
    return [...records, ...actions.filter(match), ...screens.filter(match)];
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
      {open && (
        <>
          <div className="palette-input">
            {searching ? <Spinner size={18} /> : <Icon name="search" size={18} />}
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search clients, addresses, quotes, jobs, invoices… or type a command"
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
