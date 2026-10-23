/**
 * Roofing: a roof estimate from one place, for businesses set up for roofing. Start from an address
 * and a roof package, then each project walks through measuring the roof, the estimate, the price
 * range the homeowner is sent, the site visit, the schedule and the invoice (RoofingProjectPage).
 * The list shows where each one is. A business with no roof packages yet is offered the standard
 * ones (Roofing → Packages has the rest).
 */
import { inRangeMode } from "@crewtavo/core/estimates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { PageHeader } from "@/components/ui/PageHeader";
import { TableSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { StatusPill } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { addressLine, formatMoney, formatNumber, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { TAKEOFF_FIELDS, type TakeoffRow } from "../paving/data";
import { NewTakeoffDialog } from "../paving/NewTakeoffDialog";
import { isRoof, rangeText, roofStage, roofSummary } from "./data";
import { canSetUpRoofing, packagesKey, setUpRoofing, setupMessage, useRoofPackages } from "./packages";
import { RoofingTabs } from "./RoofPackagesPage";

interface ProjectRow extends TakeoffRow {
  quote: {
    id: string;
    number: number | null;
    title: string;
    status: string;
    total: number;
    range_low: number | null;
    range_high: number | null;
    range_sent_at: string | null;
    range_accepted_at: string | null;
    priced_on_site_at: string | null;
    exact_sent_at: string | null;
    client: { display_name: string } | null;
    property: { line1: string | null; city: string | null; region: string | null; postal_code: string | null } | null;
    package: { name: string } | null;
    lines: Array<{ id: string }>;
    jobs: Array<{ id: string; status: string }>;
  } | null;
}

const QUOTE_FIELDS =
  "id, number, title, status, total, range_low, range_high, range_sent_at, range_accepted_at, priced_on_site_at, exact_sent_at, client:clients(display_name), property:properties(line1, city, region, postal_code), package:roof_packages!quotes_roof_package_fkey(name), lines:quote_line_items(id), jobs!jobs_company_id_quote_id_fkey(id, status)";

export function RoofingPage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [showAll, setShowAll] = useState(false);
  const canSell = hasRole(session, "admin", "office", "estimator");

  const projects = useQuery({
    queryKey: ["roofing-projects", company.id],
    queryFn: async () => {
      const rows = unwrap(
        await supabase()
          .from("measurements")
          .select(`${TAKEOFF_FIELDS}, quote:quotes(${QUOTE_FIELDS})`)
          .not("quote_id", "is", null)
          .order("updated_at", { ascending: false })
          .limit(200),
      ) as unknown as ProjectRow[];
      // One row per project: its newest measurement, and only measurements of roofs.
      const seen = new Set<string>();
      return rows.filter((r) => r.quote && isRoof(r) && !seen.has(r.quote.id) && seen.add(r.quote.id));
    },
  });
  const open = (projects.data ?? []).filter((r) => !["lost", "archived"].includes(r.quote!.status) && !(r.quote!.jobs[0]?.status === "completed"));
  const rows = showAll ? projects.data ?? [] : open;

  return (
    <>
      <PageHeader title="Roofing" actions={canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>New roof estimate</Button>} />
      <p className="page-subtitle">From address to signed: measure the roof on the aerial, price it from a package, send the homeowner a range, and set the exact price on site.</p>
      <RoofingTabs />

      <SetupPackages />

      <section className="stack-sm" aria-labelledby="roofing-projects" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <h2 id="roofing-projects" className="section-title grow">Projects</h2>
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
            <EmptyState icon="roofing" title="No roof estimates yet" action={canSell && <Button variant="primary" icon="plus" onClick={() => setParams({ new: "1" })}>Start a roof estimate</Button>}>
              Pick a client, an address and a roof package, then outline the roof on the aerial. The squares, edges and tear-off price themselves from the package.
            </EmptyState>
          </div>
        ) : (
          <div className="card">
            <table className="table table-stack">
              <thead><tr><th>Project</th><th>Measured</th><th className="num">Price</th><th>Stage</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const q = r.quote!;
                  const stage = roofStage(q, true);
                  const ranged = inRangeMode(q) && q.range_high !== null;
                  return (
                    <tr key={q.id} className="row-link" onClick={() => navigate(`/roofing/${q.id}`)}>
                      <td>
                        <Link className="cell-link" to={`/roofing/${q.id}`} onClick={(e) => e.stopPropagation()}>{q.title}</Link>
                        <div className="muted small">{[q.client?.display_name, q.property ? addressLine(q.property) : null].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td>
                        <span className="small">{roofSummary(r, formatNumber)}</span>
                        <div className="muted small">{[q.package?.name, timeAgo(r.updated_at)].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="num">
                        {ranged ? (
                          <span title="The price range the homeowner was sent">{rangeText(Number(q.range_low), Number(q.range_high), formatMoney)}</span>
                        ) : q.lines.length ? (
                          formatMoney(q.total)
                        ) : (
                          <span className="muted">Not priced</span>
                        )}
                      </td>
                      <td><StatusPill label={stage.label} tone={stage.tone} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <NewTakeoffDialog trade="roofing" open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} />
    </>
  );
}

/**
 * For a business with no roof packages yet (and someone who can set them up): the standard three
 * from the price list, adding any standard roofing services it's missing on the way.
 */
function SetupPackages() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canSetUp = canSetUpRoofing(session);
  const packages = useRoofPackages({ enabled: canSetUp });
  const setup = useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: packagesKey(session.company.id) });
      queryClient.invalidateQueries({ queryKey: ["services", session.company.id] });
    },
  });
  if (!canSetUp || !packages.data || packages.data.length > 0) return null;
  return (
    <section className="card card-pad stack-sm" aria-labelledby="roofing-setup" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 10 }}>
        <Icon name="package" size={18} />
        <h2 id="roofing-setup" className="section-title grow" style={{ fontSize: 17 }}>Set up your roof packages</h2>
      </div>
      <span className="muted small">
        A package prices a whole roof in one tap: the shingles or metal by the square, the tear-off, edges and pipe boots, and quick adds for the extras.
        Start with Architectural shingle, Designer shingle and Standing-seam metal, made from your price list. You can change them any time.
      </span>
      <div className="row wrap" style={{ gap: 10 }}>
        <Button variant="primary" icon="package" loading={setup.isPending} onClick={() => setup.mutate()}>Set up the standard packages</Button>
        <Link to="/roofing/packages" className="link-btn small">See packages</Link>
      </div>
    </section>
  );
}
