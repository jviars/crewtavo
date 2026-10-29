/**
 * The estimate step in the office: the estimate as one list (− and + on counts, − to take a measured
 * line off, the tear-off's layers, the package's quick adds and a search of the price list), the
 * materials from ABC Supply, the contract it prints with, the notes for whoever goes out, and beside
 * it the range the homeowner will see and the office's own numbers.
 *
 * A new roof estimate starts from its package, or from two or three offered as options: once the
 * roof is measured, their lines go on by themselves (once; POST /quotes/:id/options/fill, which keeps
 * the lines an estimate already has). Without any, the office picks one, or two or three, and prices
 * it. On an estimate with options the options bar (quotes/QuoteOptions.tsx) picks the option the
 * list, the materials, the contract and the numbers are for; looking at one changes nothing. An
 * option left with nothing of its own says so, with a way to price it from its package (or to
 * measure the roof first). "Change" starts a single estimate over from other packages.
 */
import { lineChanges } from "@crewtavo/core/estimates";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Spinner, useJustDone } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import type { TakeoffRow } from "../../paving/data";
import { measureLinkFor } from "../../paving/ProjectFlow";
import { addedMessage, addOptions, depositNote, fillOptions, optionTabs, quoteLineCount, quoteOptionsKey, skippedText, viewedOption, type SkippedLine } from "../../quotes/options";
import { QuoteOptions } from "../../quotes/QuoteOptions";
import { QuoteSections } from "../../quotes/QuoteSections";
import {
  EstimateList,
  EstimateListSkeleton,
  EstimateNumbers,
  firstName,
  isEditableQuote,
  NotesThread,
  packageServices,
  useActiveServices,
  useEstimateEditor,
  usePackageQuickAdds,
  type EstimateQuote,
  type EstimateView,
} from "../estimate";
import { PackagePicker } from "../PackageCards";
import { canSetUpRoofing, packagesKey, setUpRoofing, setupMessage, useRoofPackages, type RoofPackage } from "../packages";
import { RoofMaterials } from "../RoofMaterials";
import { autoFillKey, dayText, emptyOptions, emptyOptionsText, hasFilledLines, homeownerName, notesTitle, rangeState } from "./model";
import { RangeCard, type SendChannel, type SendMode } from "./RangeCard";
import styles from "./flow.module.css";

interface AddVars {
  /** One package, or two or three to offer as options. */
  ids: string[];
  /** Start the estimate over from them: every line and option on it now goes. */
  startOver: boolean;
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
  const queryClient = useQueryClient();
  const panelId = useId();
  const editable = canSell && isEditableQuote(quote);
  const options = quote.options;
  const packages = useRoofPackages({ enabled: canSell });
  const pkg = packages.data?.find((p) => p.id === quote.roof_package_id) ?? null;
  const pkgName = pkg?.name ?? (quote.roof_package_id ? packageName : null);

  // The option looked at (kept here: looking changes nothing), with its tier word and its package's own services.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewed = viewedOption(options, viewing, quote.option_id);
  const tabs = useMemo(() => optionTabs(options, quote.lines, quote), [options, quote]);
  const tab = tabs.find((t) => t.option.id === viewed) ?? null;
  const viewedPkg = tab?.option.package_id ? (packages.data?.find((p) => p.id === tab.option.package_id) ?? null) : null;
  // In the office a pick from the price list goes on the option looked at, unless they say every option.
  const view = useMemo<EstimateView | null>(() => (tab ? { optionId: tab.option.id, label: tab.tier ?? tab.option.name, own: packageServices(viewedPkg), picks: "only" } : null), [tab, viewedPkg]);

  const editor = useEstimateEditor({ quote, measurementId: takeoff?.id ?? null, optionId: viewed, own: view?.own });
  const services = useActiveServices();
  const quickAdds = usePackageQuickAdds(tab ? tab.option.package_id : quote.roof_package_id);
  const changes = useMemo(() => (quote.range_lines ? lineChanges(quote.range_lines, quote.lines, viewed) : null), [quote.range_lines, quote.lines, viewed]);
  const state = rangeState(quote);
  const signed = state === "signed";
  const [changing, setChanging] = useState(false);
  const [skipped, setSkipped] = useState<SkippedLine[]>([]);

  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: quoteOptionsKey(quote.id) });
    refresh();
  };
  // Once the roof is measured: the options (or the one package) picked before get their lines. It
  // often starts as this screen first draws (the effect below), and React's StrictMode subscribing
  // the screen again then leaves useMutation's own copy at pending after it's done, so whether it's
  // running comes from the mutation cache, and how it went from its callbacks.
  const fillKey = useMemo(() => ["fill-options", quote.id], [quote.id]);
  const [fillOutcome, setFillOutcome] = useState<{ done: boolean; error: Error | null }>({ done: false, error: null });
  const fill = useMutation({
    mutationKey: fillKey,
    meta: { inline: true },
    mutationFn: () => fillOptions(quote.id),
    onMutate: () => setFillOutcome({ done: false, error: null }),
    onError: (error) => setFillOutcome({ done: false, error }),
    onSuccess: (result) => {
      setFillOutcome({ done: true, error: null });
      setSkipped(result.skipped);
      // A cheaper option, now priced, can lower the deposit: say so.
      const deposit = depositNote(result);
      if (deposit) toast.success("Deposit lowered", { description: deposit });
      changed();
    },
  });
  // Pricing it from packages: one on its own, or two or three as options; or starting it over.
  const add = useMutation({
    meta: { inline: true },
    mutationFn: async ({ ids, startOver }: AddVars) => {
      const result = await addOptions(quote.id, ids, startOver ? "replace" : "add");
      return { result, lines: await quoteLineCount(quote.id).catch(() => null) };
    },
    onSuccess: ({ result, lines }, { ids, startOver }) => {
      setSkipped(result.skipped);
      const name = packages.data?.find((p) => p.id === ids[0])?.name ?? "The package";
      const message = addedMessage(result, { name, startOver, lines, roofing: true });
      // What was left off stays in a note on the estimate; the toast only says when the lines wait for the roof.
      toast.success(message.title, { description: lines === 0 ? (message.description ?? undefined) : undefined });
      setChanging(false);
      setViewing(null);
      changed();
    },
  });

  // The packages' lines go on by themselves once: for options none of which has lines yet, or an
  // estimate that's had none, on this screen (what's taken off by hand stays off).
  const filled = hasFilledLines(quote);
  const hadLines = useRef(filled);
  useEffect(() => {
    if (filled) hadLines.current = true;
  }, [filled]);
  const filling = useIsMutating({ mutationKey: fillKey }) > 0;
  const fillError = fillOutcome.error;
  const due = autoFillKey(quote, takeoff, { editable, busy: false, hadLines: hadLines.current });
  const autoKey = editor.busy || filling || add.isPending || fetching ? null : due;
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!autoKey || tried.current === autoKey) return;
    tried.current = autoKey;
    fill.mutate();
    // fill.mutate is stable; the key says when to try.
  }, [autoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The lines change in place, and the button says Updated.
  const remeasure = useMutation({
    mutationFn: () => api.post(`/quotes/${quote.id}/apply-measurement`, { measurement_id: takeoff!.id }),
    onSuccess: refresh,
  });
  const remeasured = useJustDone(remeasure);

  const choose = async (ids: string[]) => {
    const startOver = quote.lines.length > 0 || options.length > 0;
    if (startOver) {
      const one = ids.length === 1 ? packages.data?.find((p) => p.id === ids[0]) : null;
      const ok = await confirm({
        title: one ? `Replace the lines on this estimate with the ${one.name} package?` : `Start this estimate over with ${ids.length} options?`,
        body: "Anything added or changed on this estimate goes. Notes and photos stay.",
        confirmLabel: one ? "Replace the lines" : "Start over",
      });
      if (!ok) return;
    }
    add.mutate({ ids, startOver });
  };

  const rep = firstName(salesperson) || null;
  // About to fill it in (waiting for the estimate to load, or edits to save), filling it in, or
  // loading the lines it put on: show that, not the picker.
  const pricing = (due !== null && !filling && !fillOutcome.done && !fillError && tried.current !== due) || filling || (fillOutcome.done && !quote.lines.length && fetching);
  const pricingText = options.length ? "Pricing each option from its package…" : `Pricing the roof${pkgName ? ` from the ${pkgName} package` : ""}…`;
  const lead = signed
    ? `Signed${quote.approved_at ? ` ${dayText(quote.approved_at, company.timezone)}` : ""}, so the lines are locked. Anything more goes on a change order.`
    : state === "closed"
      ? `This estimate was marked ${quote.status === "lost" ? "lost" : "archived"}. Reopen it from the quote to change it.`
      : `Your best guess from the photos. ${rep ?? "Whoever goes out"} gets this same list on the iPad and fixes it on site.`;

  let body: ReactNode;
  if (!quote.lines.length && pricing) {
    body = (
      <div className={styles.pricing} role="status" aria-live="polite">
        <p className={styles.pricingStatus}><Spinner size={16} /> {pricingText}</p>
        <EstimateListSkeleton rows={6} />
      </div>
    );
  } else if (!quote.lines.length && editable && !options.length) {
    body = (
      <PickPackage
        quote={quote}
        packages={packages}
        error={add.error ?? fillError}
        pending={add.isPending}
        onPrice={(ids) => add.mutate({ ids, startOver: false })}
        byHand={
          <EstimateList quote={quote} editable editor={editor} quickAdds={quickAdds.data ?? []} services={services.data} takeoff={takeoff} />
        }
      />
    );
  } else {
    const note = skippedText(skipped);
    const measured = quote.lines.some((l) => l.formula);
    // Options with nothing of their own: priced once the roof is measured, or from their packages now
    // (after a fill that failed, its error has the way to try again).
    const empty = editable && !pricing && !fillError ? emptyOptions(options, quote.lines) : [];
    const emptyNote = emptyOptionsText(
      empty.map((o) => tabs.find((t) => t.option.id === o.id)?.tier ?? o.name),
      options.length,
      { measured: Boolean(takeoff), fromPackages: empty.some((o) => o.package_id !== null) },
    );
    body = (
      <>
        <div className={styles.estimateHead}>
          <div>
            <h3>The estimate</h3>
            <p className={styles.lead}>{lead}</p>
          </div>
          {options.length > 0 ? (
            <span className={styles.packageTag}><strong>{options.length} options</strong></span>
          ) : (
            (pkgName || editable) && (
              <span className={styles.packageTag}>
                {pkgName ? <span><strong>{pkgName}</strong> package</span> : <span>No package</span>}
                {editable && (
                  <>
                    <span aria-hidden="true">·</span>
                    <button type="button" className={styles.linkBtn} disabled={editor.busy || add.isPending} onClick={() => setChanging(true)}>
                      {pkgName ? "Change" : "Pick one"}
                    </button>
                  </>
                )}
              </span>
            )
          )}
        </div>
        {(editable || options.length > 0) && (
          <QuoteOptions quote={quote} options={options} lines={quote.lines} viewing={viewing} onView={setViewing} mode="office" onChanged={changed} panelId={panelId} />
        )}
        {pricing && (
          <p className={styles.pricingStatus} role="status"><Spinner size={16} /> {pricingText}</p>
        )}
        {note && <p className={styles.note} role="status">{note}</p>}
        {emptyNote && (
          <div className={styles.emptyOptions}>
            <span className={styles.note}>{emptyNote.text}</span>
            {emptyNote.action && !takeoff && <Link className="btn btn-sm" to={measureLinkFor({ id: "roofing" }, quote, null)}><Icon name="ruler" size={14} />{emptyNote.action}</Link>}
            {emptyNote.action && takeoff && (
              <Button size="sm" icon="package" loading={filling} disabled={editor.busy || add.isPending} onClick={() => fill.mutate()}>{emptyNote.action}</Button>
            )}
          </div>
        )}
        {(add.error || fillError) && !changing && (
          <div className="stack-sm">
            <FormError error={add.error ?? fillError} />
            {fillError && takeoff && (
              <Button size="sm" icon="refresh" style={{ justifySelf: "start" }} loading={filling} onClick={() => fill.mutate()}>Try again</Button>
            )}
          </div>
        )}
        <div id={panelId} role={view ? "tabpanel" : undefined} aria-label={view ? `${view.label}'s lines and the ones on every option` : undefined}>
          <EstimateList
            quote={quote}
            changes={changes}
            size="regular"
            editable={editable}
            editor={editable ? editor : null}
            quickAdds={quickAdds.data ?? []}
            services={editable ? services.data : undefined}
            takeoff={takeoff}
            view={view}
          />
        </div>
        {editable && measured && takeoff && (
          <div className={styles.tools}>
            <Button size="sm" variant="ghost" icon="refresh" loading={remeasure.isPending} done={remeasured} doneLabel="Updated" disabled={editor.busy} onClick={() => remeasure.mutate()}>
              Update from the roof
            </Button>
            <span className={styles.note}>Measured the roof again? This works the measured lines out from it{options.length ? ", on every option" : ""}.</span>
          </div>
        )}
        {quote.lines.length > 0 && (
          // Folded away until it's wanted; it still prices the materials again as the lines change.
          <details className={styles.materials}>
            <summary>
              <Icon name="truck" size={16} />
              Materials for this roof{view ? `, ${view.label}` : ""}
              <small>ABC Supply</small>
              <Icon name="chevronDown" size={16} />
            </summary>
            <div className={styles.materialsBody}>
              <RoofMaterials quote={quote} editable={editable} onChanged={refresh} optionId={viewed} />
            </div>
          </details>
        )}
        <QuoteSections quote={quote} optionSectionIds={tab ? tab.option.section_ids : null} approval={quote.approval} onChanged={refresh} />
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
          <RangeCard quote={quote} salesperson={salesperson} canSell={canSell} busy={editor.busy || add.isPending || filling} onSend={onSend} />
          <EstimateNumbers quote={quote} clientName={quote.client?.display_name} optionId={viewed} optionLabel={view?.label ?? null} />
        </aside>
      </div>
      {changing && (
        <ChangePackage
          packages={packages}
          current={quote.roof_package_id}
          hasLines={quote.lines.length > 0}
          pending={add.isPending}
          error={add.error}
          onClose={() => {
            setChanging(false);
            add.reset();
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

/** The picks a package picker starts with: the estimate's package, else the default one, else the first. */
function firstPick(list: readonly RoofPackage[], current: string | null): string[] {
  const id = list.find((p) => p.id === current)?.id ?? list.find((p) => p.is_default)?.id ?? list[0]?.id;
  return id ? [id] : [];
}

/** The button that prices it: from one package, or with two or three as options. */
const priceLabel = (picked: readonly RoofPackage[], one: (name: string) => string) => (picked.length > 1 ? `Offer ${picked.length} options` : picked[0] ? one(picked[0].name) : "Pick a package");

/** A new estimate with no package: pick the kind of roof (or two or three to offer) and price it, or add lines by hand. */
function PickPackage({ quote, packages, error, pending, onPrice, byHand }: {
  quote: EstimateQuote;
  packages: PackagesQuery;
  error: unknown;
  pending: boolean;
  onPrice: (ids: string[]) => void;
  byHand: ReactNode;
}) {
  const session = useSession();
  const setup = useSetUp();
  const list = packages.data ?? [];
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = (picked ?? firstPick(list, quote.roof_package_id)).flatMap((id) => list.filter((p) => p.id === id));
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
            <Icon name="package" size={20} />
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
        <h3 style={{ margin: 0, fontSize: 16 }}>What kind of roof?</h3>
        <p className={styles.lead}>Pick one, or offer two or three side by side. Their lines go on from the measurements, and you can change any of them after.</p>
      </div>
      <PackagePicker packages={list} value={chosen.map((p) => p.id)} onChange={setPicked} flagExamples />
      <FormError error={error} />
      <div className={styles.pickActions}>
        <Button variant="primary" size="lg" icon="dollar" loading={pending} disabled={!chosen.length} onClick={() => onPrice(chosen.map((p) => p.id))}>
          {priceLabel(chosen, (name) => `Price it as ${name}`)}
        </Button>
        <Link to="/roofing/packages" className="small strong">Edit packages</Link>
        {!manual && (
          <button type="button" className={styles.linkBtn} onClick={() => setManual(true)}>
            Add lines by hand
          </button>
        )}
      </div>
      {manual && byHand}
    </div>
  );
}

/** Starting a single estimate over from another package, or from two or three offered as options. */
function ChangePackage({ packages, current, hasLines, pending, error, onClose, onChoose }: {
  packages: PackagesQuery;
  current: string | null;
  hasLines: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onChoose: (ids: string[]) => void;
}) {
  const list = packages.data ?? [];
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = (picked ?? firstPick(list, current)).flatMap((id) => list.filter((p) => p.id === id));
  return (
    <Dialog open onClose={onClose} title="Change the package" description="Pick the kind of roof, or two or three to offer as options. The estimate starts over from them, measured from this roof." size="lg">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); if (chosen.length) onChoose(chosen.map((p) => p.id)); }}>
        {packages.isPending ? (
          <Skeleton height={150} radius={12} />
        ) : packages.error ? (
          <ErrorState compact error={packages.error} onRetry={() => packages.refetch()} />
        ) : list.length ? (
          <PackagePicker packages={list} value={chosen.map((p) => p.id)} onChange={setPicked} flagExamples />
        ) : (
          <EmptyState inline title="No roof packages yet">Set them up in <Link to="/roofing/packages">Roofing → Packages</Link>.</EmptyState>
        )}
        {hasLines && <p className={styles.note}>The lines on the estimate now are replaced. Notes and photos stay.</p>}
        <FormError error={error} />
        <div className="form-actions">
          <Link to="/roofing/packages" className="small strong" style={{ marginRight: "auto" }}>Edit packages</Link>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="package" loading={pending} disabled={!chosen.length}>
            {priceLabel(chosen, () => "Use this package")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
