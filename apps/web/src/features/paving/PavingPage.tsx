/**
 * Paving: the whole job from one place, once Paving is installed. Start a takeoff from an
 * address, then each project walks through takeoff, estimate, proposal, schedule and invoice
 * (PavingProjectPage). Jobs priced on the paving calculator without a takeoff list here too, and open
 * on their quote. The list prices a project that offers options from its cheapest until it's
 * signed. The price book card adds the standard paving services to a price list that doesn't have
 * them yet.
 */
import { pavingItem } from "@crewtavo/core/paving";
import type { TotalsPromo } from "@crewtavo/core/money";
import { getPreset } from "@crewtavo/core/presets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { api, supabase, unwrap } from "@/lib/api";
import { addressLine, formatMoney, formatNumber, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { lowestOption, SIGNED } from "../roofing/flow/model";
import { isPaving, sectionsOf, stageLabel, STEPS, TAKEOFF_FIELDS, type TakeoffRow } from "./data";
import { NewTakeoffDialog } from "./NewTakeoffDialog";

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

export function PavingPage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [showAll, setShowAll] = useState(false);
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
  const open = (projects.data ?? []).filter((r) => !["lost", "archived"].includes(r.quote.status) && !(r.quote.jobs[0]?.status === "completed"));
  const rows = showAll ? projects.data ?? [] : open;

  return (
    <>
      <PageHeader
        title="Paving"
        actions={
          canSell && (
            <>
              <Link className="btn" to="/paving/calculator"><Icon name="calculator" size={16} />Calculator</Link>
              <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>New takeoff</Button>
            </>
          )
        }
      />
      <p className="page-subtitle">From address to paid: measure the lot on the aerial, price it from your price book, send the proposal, then schedule and bill the job.</p>

      {canSell && (
        <Link to="/paving/calculator" className="card card-link calc-promo">
          <span className="paving-step-icon"><Icon name="calculator" size={22} /></span>
          <span className="grow stack-sm" style={{ gap: 2 }}>
            <strong>Price a job in a minute</strong>
            <span className="muted small">Already measured it? The calculator works out the tons, crew and profit from the area. No map or client needed to start.</span>
          </span>
          <span className="btn btn-primary hide-mobile">Open the calculator</span>
          <Icon name="chevronRight" size={18} />
        </Link>
      )}

      <ol className="paving-steps" aria-label="How a paving job goes">
        {STEPS.map((step, i) => (
          <li key={step.id}>
            <span className="paving-step-icon"><Icon name={step.icon} size={20} /></span>
            <span className="paving-step-text">
              <strong>{i + 1}. {step.label}</strong>
              <span className="muted small">{step.text}</span>
            </span>
          </li>
        ))}
      </ol>

      <section className="stack-sm" aria-labelledby="paving-projects" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <h2 id="paving-projects" className="section-title grow">Projects</h2>
          {(projects.data?.length ?? 0) > open.length && (
            <div className="segmented" role="group" aria-label="Which projects">
              <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)}>Open</button>
              <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)}>All</button>
            </div>
          )}
        </div>
        {projects.isPending ? (
          <div className="card"><TableSkeleton rows={4} /></div>
        ) : projects.error ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : !rows.length ? (
          <div className="card">
            <EmptyState icon="area" title="No paving takeoffs yet" action={canSell && <Button icon="plus" onClick={() => setParams({ new: "1" })}>Start a takeoff</Button>}>
              Pick a client and an address, outline the asphalt and mark the striping on the aerial, and the quantities price themselves into a proposal.
            </EmptyState>
          </div>
        ) : (
          <div className="card">
            <table className="table table-stack">
              <thead><tr><th>Project</th><th>Measured</th><th className="num">Price</th><th>Stage</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const q = r.quote;
                  const href = r.takeoff ? `/paving/${q.id}` : `/quotes/${q.id}`;
                  const stage = stageLabel(q, true);
                  // Options not chosen yet: from the cheapest. Once signed, the total is the one chosen.
                  const from = q.options?.length && !SIGNED.includes(q.status) ? lowestOption(q) : null;
                  return (
                    <tr key={q.id} className="row-link" onClick={() => navigate(href)}>
                      <td>
                        <Link className="cell-link" to={href} onClick={(e) => e.stopPropagation()}>{q.title}</Link>
                        <div className="muted small">{[q.client?.display_name, q.property ? addressLine(q.property) : null].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>
                        <span className="small">{r.takeoff ? measuredSummary(r.takeoff) : r.sqft ? `${formatNumber(r.sqft)} sq ft · calculator` : "Calculator"}</span>
                        <div className="muted small">{[q.options?.length ? `${q.options.length} options` : null, timeAgo(r.updated_at)].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="num">{from !== null ? <span title="Its cheapest option">From {formatMoney(from)}</span> : q.lines.length ? formatMoney(q.total) : <span className="muted" title="Not priced yet">—</span>}</td>
                      <td><StatusPill label={stage.label} tone={stage.tone} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hasRole(session, "admin") && <PriceBook />}

      <NewTakeoffDialog open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} />
    </>
  );
}

/** "24,310 sq ft asphalt · 3 items more" for the list. */
function measuredSummary(r: TakeoffRow): string {
  const sections = sectionsOf(r);
  const asphalt = sections.filter((s) => s.item === "asphalt").reduce((t, s) => t + Number(s.value), 0);
  const kinds = new Set(sections.map((s) => s.item).filter((i) => i && i !== "asphalt" && pavingItem(i)));
  const lead = asphalt ? `${formatNumber(asphalt)} sq ft asphalt` : `${formatNumber(r.total_area_sqft)} sq ft`;
  return kinds.size ? `${lead} · ${kinds.size} more ${kinds.size === 1 ? "item" : "items"}` : lead;
}

/** The paving services in the price list, and adding the standard ones it's missing. */
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
  return (
    <section className="card card-pad stack-sm" aria-labelledby="paving-price-book" style={{ gap: 10 }}>
      <h2 id="paving-price-book" className="section-title" style={{ fontSize: 16 }}>Price book</h2>
      <span className="muted small">
        Each takeoff item prices from a service in your price list with a formula, like sealcoat from <code>sealcoat_sqft</code> or striping from <code>stripe_ft</code>.
        Set your own prices and costs there, and the margin shows on every estimate.
      </span>
      {missing.length > 0 ? (
        <div className="row wrap" style={{ gap: 10 }}>
          <Button icon="plus" loading={add.isPending} onClick={() => add.mutate()}>Add {missing.length} standard {missing.length === 1 ? "service" : "services"}</Button>
          <span className="muted small">{missing.slice(0, 4).map((s) => s.name).join(", ")}{missing.length > 4 ? ` and ${missing.length - 4} more` : ""}</span>
        </div>
      ) : (
        <span className="small row" style={{ gap: 6 }}><Icon name="check" size={14} /> Your price list has every standard paving service.</span>
      )}
      <Link to="/settings?tab=prices" className="link-btn small" style={{ justifySelf: "start" }}>Open the price list</Link>
    </section>
  );
}
