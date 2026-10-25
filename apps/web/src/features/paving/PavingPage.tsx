/**
 * Paving: the whole job from one place, for businesses set up for paving. Start a takeoff from an
 * address, then each project walks through takeoff, estimate, proposal, schedule and invoice
 * (PavingProjectPage). The list prices a project that offers options from its cheapest until it's
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
      const rows = unwrap(
        await supabase()
          .from("measurements")
          .select(`${TAKEOFF_FIELDS}, quote:quotes(id, number, title, status, total, tax_rate, discount_amount, promo:promo_codes(kind, value), client:clients(display_name), property:properties(line1, city, region, postal_code), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id), jobs!jobs_company_id_quote_id_fkey(id, status))`)
          .not("quote_id", "is", null)
          .order("updated_at", { ascending: false })
          .limit(200),
      ) as unknown as ProjectRow[];
      // One row per project: its newest takeoff, and only takeoffs with paving items.
      const seen = new Set<string>();
      return rows.filter((r) => r.quote && isPaving(r) && !seen.has(r.quote.id) && seen.add(r.quote.id));
    },
  });
  const open = (projects.data ?? []).filter((r) => !["lost", "archived"].includes(r.quote!.status) && !(r.quote!.jobs[0]?.status === "completed"));
  const rows = showAll ? projects.data ?? [] : open;

  return (
    <>
      <PageHeader title="Paving" actions={canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>New takeoff</Button>} />
      <p className="page-subtitle">From address to paid: measure the lot on the aerial, price it from your price book, send the proposal, then schedule and bill the job.</p>

      <ol className="paving-steps" aria-label="How a paving job goes">
        {STEPS.map((step, i) => (
          <li key={step.id}>
            <span className="paving-step-icon"><Icon name={step.icon} size={18} /></span>
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
            <EmptyState icon="area" title="No paving takeoffs yet" action={canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>Start a takeoff</Button>}>
              Pick a client and an address, outline the asphalt and mark the striping on the aerial, and the quantities price themselves into a proposal.
            </EmptyState>
          </div>
        ) : (
          <div className="card">
            <table className="table table-stack">
              <thead><tr><th>Project</th><th>Measured</th><th className="num">Price</th><th>Stage</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const q = r.quote!;
                  const stage = stageLabel(q, true);
                  // Options not chosen yet: from the cheapest. Once signed, the total is the one chosen.
                  const from = q.options?.length && !SIGNED.includes(q.status) ? lowestOption(q) : null;
                  return (
                    <tr key={q.id} className="row-link" onClick={() => navigate(`/paving/${q.id}`)}>
                      <td>
                        <Link className="cell-link" to={`/paving/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.title}</Link>
                        <div className="muted small">{[q.client?.display_name, q.property ? addressLine(q.property) : null].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>
                        <span className="small">{measuredSummary(r)}</span>
                        <div className="muted small">{[q.options?.length ? `${q.options.length} options` : null, timeAgo(r.updated_at)].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="num">{from !== null ? <span title="Its cheapest option">From {formatMoney(from)}</span> : q.lines.length ? formatMoney(q.total) : <span className="muted">Not priced</span>}</td>
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
      <h2 id="paving-price-book" className="section-title" style={{ fontSize: 17 }}>Price book</h2>
      <span className="muted small">
        Each takeoff item prices from a service in your price list with a formula, like sealcoat from <code>sealcoat_sqft</code> or striping from <code>stripe_ft</code>.
        Set your own prices and costs there, and the margin shows on every estimate.
      </span>
      {missing.length > 0 ? (
        <div className="row wrap" style={{ gap: 10 }}>
          <Button variant="primary" icon="plus" loading={add.isPending} onClick={() => add.mutate()}>Add {missing.length} standard paving {missing.length === 1 ? "service" : "services"}</Button>
          <span className="muted small">{missing.slice(0, 4).map((s) => s.name).join(", ")}{missing.length > 4 ? ` and ${missing.length - 4} more` : ""}</span>
        </div>
      ) : (
        <span className="small row" style={{ gap: 6 }}><Icon name="check" size={15} /> Your price list has every standard paving service.</span>
      )}
      <Link to="/settings?tab=prices" className="link-btn small" style={{ justifySelf: "start" }}>Open the price list</Link>
    </section>
  );
}
