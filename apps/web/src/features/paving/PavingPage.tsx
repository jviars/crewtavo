/**
 * Paving: the whole job from one place, once Paving is installed (App-Paving.dc.html). Start a
 * takeoff from an address, then each project walks through takeoff, estimate, proposal, schedule and
 * invoice (PavingProjectPage). Jobs priced on the paving calculator without a takeoff list here too,
 * and open on their quote. The projects are inbox rows grouped by what needs doing (data.ts
 * groupProjects): changes asked for first, then signed and ready to schedule, ready to send, sent,
 * and the ones still being measured or priced. A project that offers options is priced from its
 * cheapest until it's signed. The quiet line at the foot adds the standard paving services to a price
 * list that doesn't have them yet.
 */
import { pavingItem } from "@crewtavo/core/paving";
import { getPreset } from "@crewtavo/core/presets";
import type { TotalsPromo } from "@crewtavo/core/money";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatMoney, formatNumber, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { lowestOption, SIGNED } from "../roofing/flow/model";
import { groupProjects, isPaving, sectionsOf, stageLabel, STEPS, TAKEOFF_FIELDS, type TakeoffRow } from "./data";
import { NewTakeoffDialog } from "./NewTakeoffDialog";
import styles from "./paving.module.css";

const QUOTE_FIELDS = "id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), client:clients(display_name), property:properties(line1, city, region, postal_code), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id), jobs!jobs_company_id_quote_id_fkey(id, status)";

interface ProjectRow extends TakeoffRow {
  quote: {
    id: string;
    number: number | null;
    title: string;
    status: string;
    total: number;
    tax_rate: number;
    discount_amount: number;
    promo: TotalsPromo | null;
    client: { display_name: string } | null;
    property: { line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
    /** What each option's price is worked out from. */
    lines: Array<{ id: string; option_id: string | null; quantity: number; unit_price: number; taxable: boolean; optional: boolean; selected: boolean }>;
    /** Its options, when it offers two or three. */
    options: Array<{ id: string }>;
    jobs: Array<{ id: string; status: string }>;
  } | null;
}

/** A project in the list: measured on the map (its newest takeoff), or priced on the calculator (its area). */
interface ListRow {
  quote: NonNullable<ProjectRow["quote"]>;
  updated_at: string;
  takeoff: ProjectRow | null;
  sqft: number | null;
}

type Filter = "open" | "all";

/** Still being worked on: not lost or archived, and its job (if any) not finished. */
const isOpen = (r: ListRow) => !["lost", "archived"].includes(r.quote.status) && r.quote.jobs[0]?.status !== "completed";

/** Whether a project has the words typed: its name, client, street or quote number. */
const matches = (r: ListRow, term: string) => {
  const q = r.quote;
  const number = term.replace(/^#/, "");
  return (
    [q.title, q.client?.display_name, q.property?.line1, q.property?.city].some((v) => v?.toLowerCase().includes(term)) ||
    (/^\d+$/.test(number) && String(q.number ?? "") === number)
  );
};

export function PavingPage() {
  const session = useSession();
  const { company } = session;
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const term = useDeferredValue(search.trim().toLowerCase());
  const canSell = hasRole(session, "admin", "office", "estimator");

  const projects = useQuery({
    queryKey: ["paving-projects", company.id],
    queryFn: async () => {
      const db = supabase();
      const [takeoffs, worksheets] = await Promise.all([
        db.from("measurements").select(`${TAKEOFF_FIELDS}, quote:quotes(${QUOTE_FIELDS})`).not("quote_id", "is", null).order("updated_at", { ascending: false }).limit(200),
        db.from("paving_worksheets").select(`updated_at, sqft:data->input->sqft, quote:quotes(${QUOTE_FIELDS})`).order("updated_at", { ascending: false }).limit(200),
      ]);
      // One row per project: its newest takeoff, and only takeoffs with paving items.
      const seen = new Set<string>();
      const measured = (unwrap(takeoffs) as unknown as ProjectRow[]).filter((r) => r.quote && isPaving(r) && !seen.has(r.quote.id) && seen.add(r.quote.id));
      // And the ones priced on the calculator without a takeoff, which open on their quote.
      const priced = (unwrap(worksheets) as unknown as Array<{ updated_at: string; sqft: unknown; quote: ProjectRow["quote"] }>).filter((w) => w.quote && !seen.has(w.quote.id) && seen.add(w.quote.id));
      const rows: ListRow[] = [
        ...measured.map((r) => ({ quote: r.quote!, updated_at: r.updated_at, takeoff: r, sqft: null })),
        ...priced.map((w) => ({ quote: w.quote!, updated_at: w.updated_at, takeoff: null, sqft: typeof w.sqft === "number" ? w.sqft : null })),
      ];
      return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    },
  });
  const newTakeoff = () => setParams({ new: "1" });

  if (projects.isPending) return <InboxPageSkeleton tabs={2} groups={2} rows={4} />;
  const all = projects.data ?? [];
  const open = all.filter(isOpen);
  const shown = (filter === "all" ? all : open).filter((r) => !term || matches(r, term));

  return (
    <>
      <PageHeader
        title="Paving"
        lede={<span className={styles.ledeWide}>Measure the lot on the aerial, price it from your price book, send the proposal, then schedule and bill the job.</span>}
        actions={
          canSell && (
            <>
              <Link className="btn" to="/paving/calculator"><Icon name="calculator" size={16} />Calculator</Link>
              <Button variant="primary" icon="plus" onClick={newTakeoff}>New takeoff</Button>
            </>
          )
        }
      />

      <ol className={styles.steps} aria-label="How a paving job moves">
        {STEPS.map((step, i) => (
          <li key={step.id} className={styles.step}>
            <b className={styles.stepNumber} aria-hidden="true">{i + 1}</b>
            <span className={styles.stepText}>
              <span className={styles.stepLabel}>{step.label}</span>
              {step.text}
            </span>
            {i < STEPS.length - 1 && <span className={styles.stepChevron}><Icon name="chevronRight" size={14} /></span>}
          </li>
        ))}
      </ol>

      {projects.error ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : !all.length ? (
        <EmptyState icon="area" title="No paving takeoffs yet" action={canSell && <Button icon="plus" onClick={newTakeoff}>Start a takeoff</Button>}>
          Pick a client and an address, outline the asphalt and mark the striping on the aerial, and the quantities price themselves into a proposal.
        </EmptyState>
      ) : (
        <>
          <Toolbar
            filters={
              <FilterTabs
                label="Filter projects"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "open", label: "Open", count: open.length },
                  { value: "all", label: "All", count: all.length },
                ]}
              />
            }
            search={<SearchField value={search} onChange={setSearch} placeholder="Search projects" label="Search projects" />}
          />
          {!shown.length ? (
            term ? (
              <EmptyState icon="search" title="No projects match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
            ) : (
              <EmptyState icon="check" title="Nothing open" action={<Button onClick={() => setFilter("all")}>Show all projects</Button>}>
                Every project is done, lost or archived.
              </EmptyState>
            )
          ) : (
            <InboxList
              label="Paving projects"
              foot={<ListFoot>{`${shown.length} ${filter === "open" ? "open " : ""}${shown.length === 1 ? "project" : "projects"}`}</ListFoot>}
            >
              {groupProjects(shown).map((g) => (
                <InboxGroup key={g.key} label={g.label} count={g.rows.length} tone={"tone" in g ? g.tone : undefined} icon={"icon" in g ? g.icon : undefined}>
                  {g.rows.map((r) => <ProjectRowView key={r.quote.id} row={r} />)}
                </InboxGroup>
              ))}
            </InboxList>
          )}
        </>
      )}

      {hasRole(session, "admin") && <PriceBook />}

      <NewTakeoffDialog open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} />
    </>
  );
}

/** One project: its name, who and where, what was measured, and its price and stage on the right. */
function ProjectRowView({ row: r }: { row: ListRow }) {
  const q = r.quote;
  const href = r.takeoff ? `/paving/${q.id}` : `/quotes/${q.id}`;
  const stage = stageLabel(q, true);
  // Options not chosen yet: from the cheapest. Once signed, the total is the one chosen.
  const from = q.options?.length && !SIGNED.includes(q.status) ? lowestOption(q) : null;
  const measured = r.takeoff ? measuredSummary(r.takeoff) : { lead: r.sqft ? `${formatNumber(r.sqft)} sq ft` : "Calculator", more: r.sqft ? " · calculator" : "" };
  const where = q.property ? addressLine(q.property) : null;
  return (
    <InboxRow
      to={href}
      title={q.title}
      number={q.number}
      avatar={q.client?.display_name ?? q.title}
      square
      // A phone shows who it's for; the address and the rest of what's measured are for a wider screen.
      subject={q.client ? <>{q.client.display_name}{where && <span className={styles.wide}> · {where}</span>}</> : where}
      meta={[
        <span key="m"><Icon name="area" size={13} /><span>{measured.lead}<span className={styles.wide}>{measured.more}{q.options?.length ? ` · ${q.options.length} options` : ""}</span></span></span>,
        timeAgo(r.updated_at),
      ]}
      aside={
        <>
          {from !== null ? (
            <span className="il-money" title="Its cheapest option">From {formatMoney(from)}</span>
          ) : q.lines.length ? (
            <span className="il-money">{formatMoney(q.total)}</span>
          ) : null}
          <span className={styles.wide}><StatusPill label={stage.label} tone={stage.tone} /></span>
        </>
      }
    />
  );
}

/** "24,310 sq ft asphalt", then " · 3 more items", for the list. */
function measuredSummary(r: TakeoffRow): { lead: string; more: string } {
  const sections = sectionsOf(r);
  const asphalt = sections.filter((s) => s.item === "asphalt").reduce((t, s) => t + Number(s.value), 0);
  const kinds = new Set(sections.map((s) => s.item).filter((i) => i && i !== "asphalt" && pavingItem(i)));
  const lead = asphalt ? `${formatNumber(asphalt)} sq ft asphalt` : `${formatNumber(r.total_area_sqft)} sq ft`;
  return { lead, more: kinds.size ? ` · ${kinds.size} more ${kinds.size === 1 ? "item" : "items"}` : "" };
}

/**
 * The paving services in the price list, as one quiet line under the projects: each takeoff item
 * prices from a service with a formula (sealcoat from sealcoat_sqft, striping from stripe_ft), and
 * this adds the standard ones the price list is missing.
 */
function PriceBook() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const standard = getPreset("paving").services;
  const services = useQuery({
    queryKey: ["services", company.id, "names"],
    queryFn: async () => unwrap(await supabase().from("services").select("name").eq("company_id", company.id)).map((s) => s.name.trim().toLowerCase()),
  });
  const missing = standard.filter((s) => services.data && !services.data.includes(s.name.toLowerCase()));
  const add = useMutation({
    meta: { success: (r: { added: string[] }) => (r.added.length ? `Added ${r.added.length} paving ${r.added.length === 1 ? "service" : "services"} to your price list` : "Your price list already has them") },
    mutationFn: () => api.post<{ added: string[] }>("/paving/services"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["services"] }),
  });
  if (!services.data) return null;
  const names = missing.slice(0, 3).map((m) => m.name).join(", ") + (missing.length > 3 ? ` and ${missing.length - 3} more` : "");
  return (
    <div className={styles.nudge} role="group" aria-label="Price book">
      <Icon name="book" size={15} />
      {missing.length > 0 ? (
        <>
          <span className={styles.nudgeText} title="Each takeoff item prices from a service in your price list with a formula, like sealcoat from sealcoat_sqft or striping from stripe_ft.">
            Your price list is missing {missing.length} standard paving {missing.length === 1 ? "service" : "services"}: {names}.
          </span>
          <button type="button" className={styles.nudgeAction} disabled={add.isPending} aria-busy={add.isPending || undefined} onClick={() => add.mutate()}>
            {add.isPending && <span className="spinner" style={{ width: 12, height: 12 }} aria-hidden="true" />}
            Add {missing.length === 1 ? "it" : "them"}
          </button>
          <Link className={styles.nudgeLink} to="/settings?tab=prices">Price list</Link>
        </>
      ) : (
        <>
          <span className={styles.nudgeText}>Your price list has every standard paving service.</span>
          <Link className={styles.nudgeAction} to="/settings?tab=prices">Open the price list</Link>
        </>
      )}
    </div>
  );
}
