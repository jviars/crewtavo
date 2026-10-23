/**
 * The estimate step in the office: the estimate as one list (− and + on counts, − to take a measured
 * line off, the tear-off's layers, the package's quick adds and a search of the price list), the
 * materials from ABC Supply, the notes for whoever goes out, and beside it the range the homeowner
 * will see and the office's own numbers.
 *
 * A new roof estimate starts from its package: once the roof is measured, the package's lines go on
 * by themselves (once; the server keeps the lines an estimate already has). Without a package, the
 * office picks one and prices it. "Change" starts the estimate over from another package.
 */
import { lineChanges } from "@crewtavo/core/estimates";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Spinner } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import type { TakeoffRow } from "../../paving/data";
import {
  EstimateList,
  EstimateListSkeleton,
  EstimateNumbers,
  firstName,
  isEditableQuote,
  NotesThread,
  useActiveServices,
  useEstimateEditor,
  usePackageQuickAdds,
  type EstimateQuote,
} from "../estimate";
import { applyRoofPackage, canSetUpRoofing, packagesKey, setUpRoofing, setupMessage, useRoofPackages, type ApplyPackageResult, type RoofPackage } from "../packages";
import { PackagePicker } from "../RoofPackagesPage";
import { RoofMaterials } from "../RoofMaterials";
import { autoApplyKey, dayText, homeownerName, notesTitle, rangeState, skippedNote } from "./model";
import { RangeCard, type SendChannel, type SendMode } from "./RangeCard";
import styles from "./flow.module.css";

interface ApplyVars {
  packageId: string;
  replace: boolean;
  /** Put on by itself when the page opened, not by a tap. */
  auto?: boolean;
}

export function EstimateStep({ quote, takeoff, packageName, salesperson, canSell, fetching, refresh, onSend }: {
  quote: EstimateQuote;
  /** The roof's newest measurement (an estimate made before measuring has none). */
  takeoff: TakeoffRow | null;
  /** The package's name as the quote has it, until the packages load. */
  packageName: string | null;
  salesperson: string | null;
  canSell: boolean;
  /** The estimate is loading again: wait before putting the package on. */
  fetching: boolean;
  refresh: () => void;
  onSend: (mode: SendMode, startWith?: SendChannel) => void;
}) {
  const { company } = useSession();
  const editable = canSell && isEditableQuote(quote);
  const editor = useEstimateEditor({ quote, measurementId: takeoff?.id ?? null });
  const services = useActiveServices();
  const quickAdds = usePackageQuickAdds(quote.roof_package_id);
  const packages = useRoofPackages({ enabled: canSell });
  const pkg = packages.data?.find((p) => p.id === quote.roof_package_id) ?? null;
  const pkgName = pkg?.name ?? (quote.roof_package_id ? packageName : null);
  const changes = useMemo(() => (quote.range_lines ? lineChanges(quote.range_lines, quote.lines) : null), [quote.range_lines, quote.lines]);
  const state = rangeState(quote);
  const signed = state === "signed";
  const [changing, setChanging] = useState(false);
  const [skipped, setSkipped] = useState<ApplyPackageResult["skipped"]>([]);

  const apply = useMutation({
    meta: { inline: true },
    mutationFn: ({ packageId, replace }: ApplyVars) => applyRoofPackage(quote.id, packageId, replace),
    onSuccess: (result, vars) => {
      setSkipped(result.applied ? result.skipped ?? [] : []);
      if (!result.applied && !vars.auto) toast.info("This estimate already had lines, so they were kept.");
      if (result.applied && !vars.auto) toast.success(vars.replace ? "The estimate starts over from the new package" : "Priced from the package");
      setChanging(false);
      refresh();
    },
  });

  // The package goes on by itself once: for an estimate that's had no lines on this screen.
  const hadLines = useRef(quote.lines.length > 0);
  useEffect(() => {
    if (quote.lines.length) hadLines.current = true;
  }, [quote.lines.length]);
  const autoKey = autoApplyKey(quote, takeoff, { editable, busy: editor.busy || apply.isPending || fetching, hadLines: hadLines.current });
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!autoKey || tried.current === autoKey) return;
    tried.current = autoKey;
    apply.mutate({ packageId: quote.roof_package_id!, replace: false, auto: true });
    // apply.mutate is stable; the key says when to try.
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const remeasure = useMutation({
    meta: { success: "The measured lines follow the roof now" },
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff!.id }),
    onSuccess: refresh,
  });

  const choose = async (choice: RoofPackage) => {
    if (quote.lines.length) {
      const ok = await confirm({
        title: `Replace the lines on this estimate with the ${choice.name} package?`,
        body: "Anything added or changed on this estimate goes. Notes and photos stay.",
        confirmLabel: "Replace the lines",
      });
      if (!ok) return;
    }
    apply.mutate({ packageId: choice.id, replace: quote.lines.length > 0 });
  };

  const rep = firstName(salesperson) || null;
  // About to put the package on (waiting for the estimate to load, or edits to save), putting it
  // on, or loading the lines it put on: show that, not the picker.
  const autoNext = editable && Boolean(quote.roof_package_id) && !quote.lines.length && !hadLines.current && apply.isIdle && !tried.current;
  const pricing = autoNext || apply.isPending || (apply.isSuccess && apply.data?.applied && !quote.lines.length && fetching);
  const lead = signed
    ? `Signed${quote.approved_at ? ` ${dayText(quote.approved_at, company.timezone)}` : ""}, so the lines are locked. Anything more goes on a change order.`
    : state === "closed"
      ? `This estimate was marked ${quote.status === "lost" ? "lost" : "archived"}. Reopen it from the quote to change it.`
      : `Your best guess from the photos. ${rep ?? "Whoever goes out"} gets this same list on the iPad and fixes it on site.`;

  let body: ReactNode;
  if (!quote.lines.length && pricing) {
    body = (
      <div className={styles.pricing} role="status" aria-live="polite">
        <p className={styles.pricingStatus}><Spinner size={16} /> Pricing the roof{pkgName ? ` from the ${pkgName} package` : ""}…</p>
        <EstimateListSkeleton rows={6} />
      </div>
    );
  } else if (!quote.lines.length && editable) {
    body = (
      <PickPackage
        quote={quote}
        packages={packages}
        error={apply.error}
        pending={apply.isPending}
        onPrice={(p) => apply.mutate({ packageId: p.id, replace: false })}
        byHand={
          <EstimateList quote={quote} editable editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} />
        }
      />
    );
  } else {
    const note = skippedNote(skipped);
    const measured = quote.lines.some((l) => l.formula);
    body = (
      <>
        <div className={styles.estimateHead}>
          <div>
            <h3>The estimate</h3>
            <p className={styles.lead}>{lead}</p>
          </div>
          {(pkgName || editable) && (
            <span className={styles.packageTag}>
              {pkgName ? <span><strong>{pkgName}</strong> package</span> : <span>No package</span>}
              {editable && (
                <>
                  <span aria-hidden="true">·</span>
                  <button type="button" className={styles.linkBtn} disabled={editor.busy || apply.isPending} onClick={() => setChanging(true)}>
                    {pkgName ? "Change" : "Pick one"}
                  </button>
                </>
              )}
            </span>
          )}
        </div>
        {note && <p className={styles.note} role="status">{note}</p>}
        {apply.error && !changing && <FormError error={apply.error} />}
        <EstimateList
          quote={quote}
          changes={changes}
          size="regular"
          editable={editable}
          editor={editable ? editor : null}
          quickAdds={quickAdds.data ?? []}
          services={editable ? services.data : undefined}
          takeoff={takeoff}
        />
        {editable && measured && takeoff && (
          <div className={styles.tools}>
            <Button size="sm" variant="ghost" icon="refresh" loading={remeasure.isPending} disabled={editor.busy} onClick={() => remeasure.mutate()}>
              Update from the roof
            </Button>
            <span className={styles.note}>Measured the roof again? This works the measured lines out from it.</span>
          </div>
        )}
        {quote.lines.length > 0 && (
          // Folded away until it's wanted; it still prices the materials again as the lines change.
          <details className={styles.materials}>
            <summary>
              <Icon name="truck" size={17} />
              Materials for this roof
              <small>ABC Supply</small>
              <Icon name="chevronDown" size={16} />
            </summary>
            <div className={styles.materialsBody}>
              <RoofMaterials quote={quote} editable={editable} onChanged={refresh} />
            </div>
          </details>
        )}
      </>
    );
  }

  return (
    <div className={styles.estimate}>
      <div className={styles.estimateGrid}>
        <div className={styles.main}>
          {body}
          {!signed && (
            <div className={styles.notesSection}>
              <NotesThread
                quoteId={quote.id}
                composer="office"
                title={notesTitle(salesperson)}
                placeholder={`Anything ${rep ?? "they"} should know: the gate code, the dog, what ${homeownerName(quote.client?.display_name)} mentioned…`}
                bare
              />
            </div>
          )}
        </div>
        <aside className={styles.aside} aria-label="The range and your numbers">
          <RangeCard quote={quote} salesperson={salesperson} canSell={canSell} busy={editor.busy || apply.isPending} onSend={onSend} />
          <EstimateNumbers quote={quote} clientName={quote.client?.display_name} />
        </aside>
      </div>
      {changing && (
        <ChangePackage
          packages={packages}
          current={quote.roof_package_id}
          hasLines={quote.lines.length > 0}
          pending={apply.isPending}
          error={apply.error}
          onClose={() => {
            setChanging(false);
            apply.reset();
          }}
          onChoose={choose}
        />
      )}
    </div>
  );
}

/** Setting a business up with the standard packages (and the roofing services they're made of). */
function useSetUp() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    meta: { success: setupMessage },
    mutationFn: setUpRoofing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: packagesKey(company.id) });
      queryClient.invalidateQueries({ queryKey: ["services", company.id] });
    },
  });
}

type PackagesQuery = ReturnType<typeof useRoofPackages>;

/** A new estimate with no package: pick the kind of roof and price it, or add lines by hand. */
function PickPackage({ quote, packages, error, pending, onPrice, byHand }: {
  quote: EstimateQuote;
  packages: PackagesQuery;
  error: unknown;
  pending: boolean;
  onPrice: (p: RoofPackage) => void;
  byHand: ReactNode;
}) {
  const session = useSession();
  const setup = useSetUp();
  const list = packages.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const chosen = list.find((p) => p.id === (picked ?? quote.roof_package_id)) ?? list.find((p) => p.is_default) ?? list[0] ?? null;
  const [manual, setManual] = useState(false);

  if (packages.isPending) {
    return (
      <div className={styles.pick} aria-hidden="true">
        <Skeleton width={260} height={14} />
        <div className="row" style={{ gap: 12 }}>
          <Skeleton height={150} radius={12} style={{ flex: 1 }} />
          <Skeleton height={150} radius={12} style={{ flex: 1 }} />
          <Skeleton height={150} radius={12} style={{ flex: 1 }} />
        </div>
      </div>
    );
  }
  if (packages.error) return <ErrorState compact error={packages.error} onRetry={() => packages.refetch()} />;
  if (!list.length) {
    return (
      <div className={styles.pick}>
        {canSetUpRoofing(session) ? (
          <div className="callout callout-info">
            <Icon name="package" size={18} />
            <span className="grow stack-sm" style={{ gap: 8, fontWeight: 400 }}>
              <span>Packages price a roof in one tap: Architectural shingle, Designer shingle and Standing-seam metal, from your price list.</span>
              <Button size="sm" variant="primary" icon="package" style={{ justifySelf: "start" }} loading={setup.isPending} onClick={() => setup.mutate()}>
                Set up the standard packages
              </Button>
            </span>
          </div>
        ) : (
          <p className={styles.note}>No roof packages yet, so add this roof's lines from your price list. The office can set packages up in Roofing → Packages.</p>
        )}
        {byHand}
      </div>
    );
  }
  return (
    <div className={styles.pick}>
      <div>
        <h3 style={{ margin: 0, fontSize: 17 }}>What kind of roof?</h3>
        <p className={styles.lead}>Its lines go on from the measurements. You can change any of them after.</p>
      </div>
      <PackagePicker packages={list} value={chosen?.id ?? null} onChange={setPicked} />
      <FormError error={error} />
      <div className={styles.pickActions}>
        <Button variant="primary" size="lg" icon="dollar" loading={pending} disabled={!chosen} onClick={() => chosen && onPrice(chosen)}>
          Price it{chosen ? ` as ${chosen.name}` : ""}
        </Button>
        <Link to="/roofing/packages" className="small strong">Edit packages</Link>
        {!manual && (
          <button type="button" className={styles.linkBtn} onClick={() => setManual(true)}>
            Or add lines by hand
          </button>
        )}
      </div>
      {manual && byHand}
    </div>
  );
}

/** Starting the estimate over from another package. */
function ChangePackage({ packages, current, hasLines, pending, error, onClose, onChoose }: {
  packages: PackagesQuery;
  current: string | null;
  hasLines: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onChoose: (p: RoofPackage) => void;
}) {
  const list = packages.data ?? [];
  const [picked, setPicked] = useState<string | null>(current ?? list.find((p) => p.is_default)?.id ?? list[0]?.id ?? null);
  const chosen = list.find((p) => p.id === picked) ?? null;
  return (
    <Dialog open onClose={onClose} title="Change the package" description="Pick the kind of roof. The estimate starts over from it, measured from this roof." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (chosen) onChoose(chosen); }}>
        {packages.isPending ? (
          <Skeleton height={150} radius={12} />
        ) : packages.error ? (
          <ErrorState compact error={packages.error} onRetry={() => packages.refetch()} />
        ) : list.length ? (
          <PackagePicker packages={list} value={picked} onChange={setPicked} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>No roof packages yet. Set them up in <Link to="/roofing/packages">Roofing → Packages</Link>.</p>
        )}
        {hasLines && <p className={styles.note}>The lines on the estimate now are replaced. Notes and photos stay.</p>}
        <FormError error={error} />
        <div className="form-actions">
          <Link to="/roofing/packages" className="small strong" style={{ marginRight: "auto" }}>Edit packages</Link>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="package" loading={pending} disabled={!chosen}>Use this package</Button>
        </div>
      </form>
    </Dialog>
  );
}
