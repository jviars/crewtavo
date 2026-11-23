/**
 * Roofing: a roof estimate from one place, once Roofing is installed. Start from an address
 * and a roof package, then each project walks through measuring the roof, the estimate, the price
 * range the homeowner is sent, the site visit, the schedule and the invoice (RoofingProjectPage).
 * The list groups the projects by what needs doing first (flow/projects.ts groupRoofProjects): each
 * row is the client, the estimate and its street, the roof and its package (or how many options it
 * offers), and the price: the range the homeowner was sent, the cheapest option until it's signed, or
 * the total. A business with no roof packages yet is offered the standard ones (Roofing → Packages
 * has the rest).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { PageHeader } from "@/components/ui/PageHeader";
import { InboxSkeleton, Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { FilterTabs, SearchField, Toolbar } from "@/components/ui/Toolbar";
import { formatMoney, formatNumber, timeAgo } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { NewTakeoffDialog } from "../paving/NewTakeoffDialog";
import { roofSummary } from "./data";
import { lowestOption, SIGNED } from "./flow/model";
import { groupRoofProjects, isOpenProject, matchesProject, projectPrice, stageNote, useRoofingProjects, type ProjectRow } from "./flow/projects";
import styles from "./flow/projects.module.css";
import { canSetUpRoofing, packagesKey, setUpRoofing, setupMessage, useRoofPackages } from "./packages";
import { RoofingTabs } from "./RoofingTabs";

type Which = "open" | "all";

export function RoofingPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [which, setWhich] = useState<Which>("open");
  const [search, setSearch] = useState("");
  const canSell = hasRole(session, "admin", "office", "estimator");
  const projects = useRoofingProjects();

  const all = projects.data ?? [];
  const open = all.filter((r) => isOpenProject(r.quote));
  const rows = (which === "all" ? all : open).filter((r) => matchesProject(r.quote, search));
  const groups = useMemo(() => groupRoofProjects(rows), [rows]);
  const start = () => setParams({ new: "1" });
  const dialog = <NewTakeoffDialog trade="roofing" open={params.get("new") === "1"} onClose={() => setParams({}, { replace: true })} />;

  const header = (
    <>
      <PageHeader
        title="Roofing"
        lede={<span className="hide-mobile">From address to signed: measure the roof on the aerial, price it from a package, send the homeowner a range, and set the exact price on site.</span>}
        actions={canSell && <Button variant="primary" icon="plus" onClick={start}>New roof estimate</Button>}
      />
      <RoofingTabs />
      <SetupPackages />
    </>
  );

  if (projects.isPending) {
    return (
      <>
        {header}
        <Loading label="Loading roofing projects">
          <div className="stack-lg">
            <div className="row-between"><Skeleton width={184} height={36} radius={10} /><Skeleton width={264} height={32} radius={8} className="hide-mobile" /></div>
            <InboxSkeleton rows={5} groups={2} />
          </div>
        </Loading>
        {dialog}
      </>
    );
  }

  return (
    <>
      {header}
      {projects.error ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : !all.length ? (
        <EmptyState icon="roofing" title="No roof estimates yet" action={canSell && <Button icon="plus" onClick={start}>Start a roof estimate</Button>}>
          Pick a client, an address and a roof package, then outline the roof on the aerial. The squares, edges and tear-off price themselves from the package.
        </EmptyState>
      ) : (
        <>
          <Toolbar
            filters={
              <FilterTabs<Which>
                label="Which projects"
                value={which}
                onChange={setWhich}
                options={[
                  { value: "open", label: "Open", count: open.length },
                  { value: "all", label: "All", count: all.length },
                ]}
              />
            }
            search={<SearchField value={search} onChange={setSearch} placeholder="Search client, street or #" label="Search roofing projects" />}
          />
          {!rows.length ? (
            search.trim() ? (
              <EmptyState icon="search" title="No projects match" action={<Button onClick={() => setSearch("")}>Clear search</Button>} />
            ) : (
              <EmptyState icon="roofing" title="No open projects" action={<Button onClick={() => setWhich("all")}>Show all {all.length}</Button>}>
                Every roof estimate here is signed and done, lost or archived.
              </EmptyState>
            )
          ) : (
            <InboxList
              label="Roofing projects"
              foot={<ListFoot>{rows.length === 1 ? "1 project" : `${rows.length} projects`}{which === "open" ? " open" : ""}</ListFoot>}
            >
              {groups.map((g) => (
                <InboxGroup key={g.key} label={g.label} count={g.rows.length} tone={g.tone} icon={g.icon}>
                  {g.rows.map((r) => <ProjectRowView key={r.quote.id} row={r} />)}
                </InboxGroup>
              ))}
            </InboxList>
          )}
        </>
      )}
      {dialog}
    </>
  );
}

/** One project: the client and estimate number, the estimate and its street, the roof and package, and its price. */
function ProjectRowView({ row }: { row: ProjectRow }) {
  const q = row.quote;
  const street = q.property?.line1?.trim();
  const subject = street && !q.title.toLowerCase().includes(street.toLowerCase()) ? `${q.title}, ${street}` : q.title;
  // Options not chosen yet: from the cheapest. Once signed, the total is the one chosen.
  const lowest = q.options?.length && !SIGNED.includes(q.status) ? lowestOption(q) : null;
  const price = projectPrice(q, lowest);
  return (
    <InboxRow
      to={`/roofing/${q.id}`}
      title={q.client?.display_name ?? q.title}
      number={q.number ?? undefined}
      subject={q.client ? subject : street}
      square
      meta={[
        stageNote(row),
        // "28.4 squares", "6/12": each its own part, so the dots between them all match.
        ...(row.takeoff ? roofSummary(row.takeoff, formatNumber).split(" · ") : [q.measure_on_site_at ? "Not from the air" : "Not measured yet"]),
        q.options?.length ? `${q.options.length} options` : q.package?.name,
        // How long since it was measured (or flagged), on a desktop: a phone's line keeps to the roof and its package.
        (row.takeoff?.updated_at ?? q.measure_on_site_at) && <span className={styles.age}>{timeAgo((row.takeoff?.updated_at ?? q.measure_on_site_at)!)}</span>,
      ]}
      aside={
        price?.kind === "range" ? (
          <>
            <span className="il-money" title="The price range the homeowner was sent">{formatMoney(price.low)}</span>
            <span className={`il-sub ${styles.to}`}><span aria-hidden="true">– </span><span className="sr-only">to </span>{formatMoney(price.high)}</span>
          </>
        ) : price?.kind === "from" ? (
          <span className="il-money" title="Its cheapest option">From {formatMoney(price.amount)}</span>
        ) : price ? (
          <span className="il-money">{formatMoney(price.amount)}</span>
        ) : undefined
      }
    />
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
    <section className="callout callout-info" aria-labelledby="roofing-setup">
      <Icon name="package" size={16} />
      <div className="grow">
        <h2 id="roofing-setup" className={styles.calloutTitle}>Set up your roof packages</h2>
        A package prices a whole roof in one tap: the shingles or metal by the square, the tear-off, edges and pipe boots, and quick adds for the extras.
        Start with Architectural shingle, Designer shingle and Standing-seam metal, made from your price list. You can change them any time.
      </div>
      <span className="row" style={{ gap: 12, flex: "none" }}>
        <Link to="/roofing/packages" className="link-btn small">See packages</Link>
        <Button size="sm" icon="package" loading={setup.isPending} onClick={() => setup.mutate()}>Set up the standard packages</Button>
      </span>
    </section>
  );
}
