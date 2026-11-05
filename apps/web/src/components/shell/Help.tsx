/**
 * The ? beside the bell. Crewtavo has no support desk, so this is where people help themselves:
 * ask Claude or ChatGPT with the docs page for this screen attached (the same prompt as the Ask
 * buttons on crewtavo.com/docs), open the docs, the company's own guides, or connect an assistant.
 * Owners and admins, who run the server, also get a bug report on GitHub with the version filled in.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { hasRole, isSub, useSession } from "@/lib/session";
import { Button } from "../ui/Button";
import { Icon, type IconName } from "../ui/Icon";

const DOCS = "https://crewtavo.com/docs/";

// The docs page for each screen, by the first part of its address.
const PAGES: Record<string, string> = {
  "": "getting-started/home-screen",
  schedule: "jobs/schedule-and-routes",
  clients: "clients/clients-and-properties",
  requests: "sales/requests",
  quotes: "sales/quotes",
  pipeline: "sales/sales-board",
  measure: "measuring/measure-yards-and-roofs",
  paving: "measuring/paving-takeoffs",
  roofing: "measuring/roofing-estimates",
  jobs: "jobs/jobs-and-recurring-service",
  invoices: "billing/invoices",
  payouts: "billing/invoices",
  finance: "billing/finance-and-metrics",
  metrics: "billing/finance-and-metrics",
  reports: "billing/finance-and-metrics",
  marketing: "clients/marketing",
  messages: "clients/messages",
  automations: "clients/automations",
  booking: "sales/booking-form-on-your-website",
  timesheets: "team/timesheets-and-pay",
  equipment: "jobs/equipment",
  kb: "team/knowledge-base",
  subs: "team/subcontractors",
  apps: "connections/apps",
  chat: "connections/team-chat",
  drive: "connections/drive",
  applicants: "connections/careers",
  website: "connections/sveltia-cms",
  field: "field/your-day-in-the-field",
};

// Settings, by tab.
const SETTINGS: Record<string, string> = {
  profile: "team/your-profile-and-phone",
  company: "getting-started/company-settings",
  hosting: "hosting/settings",
  storage: "hosting/storage",
  team: "team/invite-your-team",
  roles: "team/roles-and-permissions",
  crews: "jobs/crews-and-checklists",
  checklists: "jobs/crews-and-checklists",
  prices: "sales/price-list",
  templates: "sales/estimate-templates",
  contracts: "sales/contract-terms",
  email: "connections/email",
  calendars: "connections/google-calendar",
  assistants: "connections/claude-and-chatgpt",
  payments: "connections/stripe",
};

/** The docs page about this screen ("billing/invoices"), or null when there isn't one. */
export function docsPage(pathname: string, search: string, sub = false): string | null {
  const first = pathname.split("/")[1] ?? "";
  if (first === "field" && sub) return "field/subcontractor-guide";
  if (first === "settings") return SETTINGS[new URLSearchParams(search).get("tab") ?? ""] ?? null;
  return PAGES[first] ?? null;
}

/** What Ask Claude and Ask ChatGPT send: the docs page (or the index of them all) and the question. */
export function askUrl(ai: "claude" | "chatgpt", page: string | null, question: string): string {
  const docs = page ? `${DOCS}${page}.md` : "https://crewtavo.com/llms.txt";
  const q = encodeURIComponent(`Read ${docs} and help me with this question about Crewtavo: ${question}`);
  return ai === "claude" ? `https://claude.ai/new?q=${q}` : `https://chatgpt.com/?q=${q}`;
}

export function HelpButton() {
  const session = useSession();
  const location = useLocation();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sub = isSub(session);
  const admin = hasRole(session, "admin");
  const page = docsPage(location.pathname, location.search, sub);

  // The release this server runs, for the bug report (GitHub asks for it).
  const health = useQuery({
    queryKey: ["health"],
    enabled: open && admin,
    staleTime: Infinity,
    meta: { silent: true },
    queryFn: async () => ((await (await fetch("/api/health")).json()) as { version?: string }).version ?? "",
  });
  const report = `https://github.com/jviars/crewtavo/issues/new?${new URLSearchParams({ template: "bug_report.yml", ...(health.data ? { version: health.data } : {}) })}`;

  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      const isOpen = (e as Event & { newState: string }).newState === "open";
      setOpen(isOpen);
      if (isOpen && button.current) {
        const r = button.current.getBoundingClientRect();
        p.style.top = `${r.bottom + 8}px`;
        p.style.left = `${Math.max(12, Math.min(window.innerWidth - p.offsetWidth - 12, r.right - p.offsetWidth))}px`;
      }
    };
    p.addEventListener("toggle", onToggle);
    return () => p.removeEventListener("toggle", onToggle);
  }, []);

  const close = () => panel.current?.hidePopover();
  const ask = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const question = new FormData(e.currentTarget).get("question")!.toString().trim();
    const ai = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "chatgpt" ? "chatgpt" : "claude";
    window.open(askUrl(ai, page, question), "_blank", "noopener");
    close();
  };

  return (
    <>
      <button ref={button} type="button" className="icon-btn" aria-label="Help" title="Help" popovertarget={id} aria-expanded={open}>
        <Icon name="help" size={20} />
      </button>
      <div ref={panel} id={id} className="panel" popover="auto" role="dialog" aria-label="Help">
        <div className="panel-head">
          <h2>Help</h2>
        </div>
        <div className="panel-body">
          <form className="stack-sm" style={{ padding: "0 16px 14px" }} onSubmit={ask}>
            <label htmlFor={`${id}-q`} className="small" style={{ fontWeight: 600 }}>Ask AI about Crewtavo</label>
            <input id={`${id}-q`} name="question" className="input" required pattern=".*\S.*" placeholder="How do I send invoices in a batch?" autoComplete="off" />
            <div className="row">
              <Button type="submit" value="claude" icon="external" className="grow">Ask Claude</Button>
              <Button type="submit" value="chatgpt" icon="external" className="grow">Ask ChatGPT</Button>
            </div>
            <span className="muted small">It reads Crewtavo's docs to answer. Leave out client names.</span>
          </form>
          <HelpRow icon="book" title={page ? "Docs for this screen" : "Crewtavo docs"} body="crewtavo.com/docs" href={`${DOCS}${page ? `${page}/` : ""}`} onClick={close} />
          {!sub && <HelpRow icon="clipboard" title="Your company's guides" body="Knowledge base" to="/kb" onClick={close} />}
          {!sub && <HelpRow icon="sparkle" title="Connect Claude or ChatGPT" body="Have it do the work in Crewtavo" to="/settings?tab=assistants" onClick={close} />}
          {admin ? (
            <HelpRow icon="alert" title="Report a problem" body="Public on GitHub, with no promise of a reply. Leave out client details." href={report} onClick={close} />
          ) : (
            <p className="muted small" style={{ padding: "12px 16px", borderTop: "1px solid var(--row-divider)", margin: 0 }}>Stuck on something else? Ask someone at {session.company.name}.</p>
          )}
        </div>
      </div>
    </>
  );
}

function HelpRow({ icon, title, body, href, to, onClick }: { icon: IconName; title: string; body: string; href?: string; to?: string; onClick: () => void }) {
  const inside = (
    <>
      <span className="n-icon"><Icon name={icon} size={16} /></span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <div className="n-title">{title}</div>
        <div className="n-body">{body}</div>
      </span>
      {href && <Icon name="external" size={14} />}
    </>
  );
  return to ? (
    <Link className="notice" to={to} onClick={onClick}>{inside}</Link>
  ) : (
    <a className="notice" href={href} target="_blank" rel="noopener noreferrer" onClick={onClick}>{inside}</a>
  );
}
