/**
 * The options bar: an estimate that offers two or three options (quote_options), one tab each, with
 * its picture, tier, name and total. Looking at a tab changes nothing (the screen shows that
 * option's lines); the option shown first changes only on purpose: "Show this one first" in the
 * office, "They chose this one" with the homeowner on the iPad. From here options are added from
 * packages (the estimate as it is becoming option 1, or, with nothing on it yet, one package pricing
 * it), edited and taken off, or the estimate started over from packages. Once signed, it only shows
 * which one was chosen. The quote page, the roofing and paving estimate steps and the iPad visit put
 * it above their lines; its records and money are options.ts.
 */
import { STARTER_NOTE } from "@crewtavo/core/contracts";
import { isSiteAdjustment } from "@crewtavo/core/estimates";
import { isExampleWarranty, PACKAGE_LIMITS } from "@crewtavo/core/presets";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { Skeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { formatMoneyCents } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { cleanHighlights, isRoofingCompany, MAX_OPTIONS, packagesPath } from "../roofing/data";
import { HighlightsField, PackagePicker, PackagePicture, TierWords } from "../roofing/PackageCards";
import { canEditPackages, useRoofPackages } from "../roofing/packages";
import {
  addAction,
  addedMessage,
  addOptions,
  optionsOpen,
  optionsPlan,
  optionTabs,
  quoteLineCount,
  quoteOptionsKey,
  removeOption,
  saveOption,
  sharedAtFirst,
  showAsk,
  showOption,
  shownWords,
  viewedOption,
  type OptionsLine,
  type OptionsQuote,
  type QuoteOptionRow,
} from "./options";
import styles from "./QuoteOptions.module.css";

export interface QuoteOptionsProps {
  quote: OptionsQuote;
  /** The quote's options (useQuoteOptions), in any order. */
  options: QuoteOptionRow[];
  /** All of the quote's lines, every option's, with their option_id (and name, service_id, formula). */
  lines: readonly OptionsLine[];
  /** The option being looked at, kept by the screen; null for the one shown first. */
  viewing: string | null;
  onView: (id: string | null) => void;
  /** "office": the customer sees the shown option first. "visit": on the iPad, it's the one they chose. */
  mode: "office" | "visit";
  /** Options changed (added, taken off, shown, edited): read the quote and its lines again. */
  onChanged: () => void;
  /** The id of what shows the viewed option's lines, for the tabs to point at. */
  panelId?: string;
}

export function QuoteOptions({ quote, options, lines, viewing, onView, mode, onChanged, panelId }: QuoteOptionsProps) {
  const session = useSession();
  const queryClient = useQueryClient();
  const canSell = hasRole(session, "admin", "office", "estimator") && can(session, "sales");
  const open = canSell && optionsOpen(quote.status);
  const signed = quote.status === "approved" || quote.status === "converted";
  const tabs = optionTabs(options, lines, quote);
  const viewed = viewedOption(options, viewing, quote.option_id);
  const current = tabs.find((t) => t.option.id === viewed) ?? null;
  // "Add options" open, adding to the estimate or starting it over.
  const [adding, setAdding] = useState<"add" | "startOver" | null>(null);
  const [editing, setEditing] = useState<QuoteOptionRow | null>(null);

  const changed = () => {
    queryClient.invalidateQueries({ queryKey: quoteOptionsKey(quote.id) });
    onChanged();
  };
  const show = useMutation({
    meta: { success: mode === "visit" ? "Marked as their choice" : "Shown first now" },
    mutationFn: (optionId: string) => showOption(quote.id, optionId),
    // The tab stays on it, now the one shown.
    onSuccess: changed,
  });
  const remove = useMutation({
    meta: { success: (r: { options: unknown[] }) => (r.options.length ? "Option taken off" : "Back to a single estimate") },
    mutationFn: (optionId: string) => removeOption(quote.id, optionId),
    onSuccess: (_, optionId) => {
      if (viewing === optionId) onView(null);
      changed();
    },
  });

  const choose = async (option: QuoteOptionRow) => {
    const ask = showAsk(mode, quote, option.name);
    if (ask && !(await confirm(ask))) return;
    show.mutate(option.id);
  };
  const takeOff = async (option: QuoteOptionRow) => {
    const last = options.length <= 2;
    const ok = await confirm({
      title: `Take ${option.name} off this estimate?`,
      body: last ? "Its lines go with it, and the estimate goes back to a single one with the other option's lines." : "Its lines go with it.",
      confirmLabel: "Take it off",
      danger: true,
    });
    if (ok) remove.mutate(option.id);
  };

  // Arrow keys move between the tabs, as in any set of tabs.
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.findIndex((t) => t.option.id === viewed);
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? at + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (to === null || !tabs.length) return;
    e.preventDefault();
    const next = (to + tabs.length) % tabs.length;
    onView(tabs[next]!.option.id);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const addDialog = adding && (
    <AddOptionsDialog
      quote={quote}
      options={options}
      lines={lines}
      startOver={adding === "startOver"}
      mode={mode}
      onClose={() => setAdding(null)}
      onDone={() => {
        setAdding(null);
        onView(null);
        changed();
      }}
    />
  );

  if (!options.length) {
    if (!open) return null;
    return (
      <div className={styles.offer}>
        <Icon name="package" size={18} />
        {lines.length ? (
          <>
            <span className="grow">Offer two or three packages side by side, like Good, Better and Best.</span>
            <Button size="sm" icon="plus" onClick={() => setAdding("add")}>Offer options</Button>
          </>
        ) : (
          <>
            <span className="grow">Price it from a package, or offer two or three side by side, like Good, Better and Best.</span>
            <Button size="sm" icon="plus" onClick={() => setAdding("add")}>Pick packages</Button>
          </>
        )}
        {addDialog}
      </div>
    );
  }

  const words = shownWords(mode, signed);
  return (
    <section className={styles.bar} aria-label="Options">
      <div className={styles.tabs} role="tablist" aria-label="Options on this estimate" onKeyDown={onKeys}>
        {tabs.map(({ option, tier, total, shown }) => {
          const on = option.id === viewed;
          return (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={panelId}
              tabIndex={on ? 0 : -1}
              className={styles.tab}
              data-shown={shown || undefined}
              onClick={() => onView(option.id)}
            >
              <PackagePicture path={option.picture} style={option.style} className={styles.tabPicture} />
              <span className={styles.tabText}>
                {(tier || shown) && (
                  <span className={styles.tabChips}>
                    {tier && <span className="chip">{tier}</span>}
                    {shown && <span className="chip chip-green">{words.chip}</span>}
                  </span>
                )}
                <strong className={styles.tabName}>{option.name}</strong>
                <span className={styles.tabTotal}>{total === null ? "No lines yet" : formatMoneyCents(total)}</span>
                {/* Only in the office: the homeowner looks on at the iPad. */}
                {mode === "office" && isExampleWarranty(option.warranty) && (
                  <span className={styles.tabFlag}>
                    <Icon name="alert" size={13} />
                    Example warranty
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {open && current ? (
        <div className={styles.actions}>
          {current.shown ? (
            <span className={styles.note}>{words.note}</span>
          ) : (
            <Button size="sm" variant="primary" icon="check" loading={show.isPending} onClick={() => choose(current.option)}>
              {mode === "visit" ? "They chose this one" : "Show this one first"}
            </Button>
          )}
          <span className="grow" />
          {options.length < MAX_OPTIONS && <Button size="sm" icon="plus" onClick={() => setAdding("add")}>Add an option</Button>}
          <Menu
            label={`More for ${current.option.name}`}
            triggerClassName="btn btn-sm btn-icon"
            items={[
              { label: "Edit this option", icon: "edit", onSelect: () => setEditing(current.option) },
              { label: "Start over from packages", icon: "refresh", onSelect: () => setAdding("startOver") },
              { label: "Take this option off", icon: "trash", danger: true, disabled: remove.isPending, onSelect: () => void takeOff(current.option) },
            ]}
          />
        </div>
      ) : signed && tabs.some((t) => t.shown) ? (
        <p className={styles.note}>They chose {tabs.find((t) => t.shown)!.option.name}. {words.note}</p>
      ) : null}

      {addDialog}
      {editing && (
        <EditOptionDialog
          option={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
    </section>
  );
}

/**
 * Packages to offer as options. Added to the estimate, the packages already on it are picked and
 * locked: the options' own, and the estimate's package as its lines become option 1 (with the lines
 * that stay on every option ticked). On an estimate with nothing on it, one package prices it as a
 * single estimate. Starting over takes every option and line off first.
 */
function AddOptionsDialog({ quote, options, lines, startOver: startingOver, mode, onClose, onDone }: {
  quote: OptionsQuote;
  options: QuoteOptionRow[];
  lines: readonly OptionsLine[];
  startOver: boolean;
  /** In the office a package still on setup's example warranty says so; never on the iPad, where the homeowner is looking on. */
  mode: "office" | "visit";
  onClose: () => void;
  onDone: () => void;
}) {
  const session = useSession();
  const keepId = useId();
  const packages = useRoofPackages();
  const list = packages.data ?? [];
  const [startOver, setStartOver] = useState(startingOver);
  const [picked, setPicked] = useState<string[]>([]);
  // Lines ticked or unticked by hand under "On every option"; the rest follow the packages picked.
  const [ticked, setTicked] = useState<ReadonlyMap<string, boolean>>(new Map());
  const plan = optionsPlan(options, lines.length, quote.roof_package_id, list.map((p) => p.id));
  const locked = startOver ? [] : plan.locked;
  const max = startOver ? MAX_OPTIONS : plan.max;
  const fresh = picked.filter((id) => !locked.includes(id));
  const nameOf = (id: string) => list.find((p) => p.id === id)?.name ?? "the package";
  const action = addAction(plan, fresh, startOver, nameOf);
  const canStartOver = lines.length > 0 || options.length > 0;
  const current = plan.converting ? (list.find((p) => p.id === quote.roof_package_id) ?? null) : null;

  // The estimate becoming option 1: which of its lines stay on every option. A price set on site
  // always goes with option 1, so it isn't asked.
  const converting = plan.converting && !startOver;
  const keepable = converting ? lines.filter((l) => !(quote.priced_on_site_at && isSiteAdjustment(l))) : [];
  const atFirst = new Set(sharedAtFirst(keepable, current, list.filter((p) => fresh.includes(p.id))));
  const shared = keepable.filter((l) => ticked.get(l.id) ?? atFirst.has(l.id)).map((l) => l.id);
  const noneLeft = converting && shared.length === lines.length;
  const ready = action.ready && !noneLeft;

  const add = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const result = await addOptions(quote.id, fresh, startOver ? "replace" : "add", converting ? shared : undefined);
      return { result, lines: await quoteLineCount(quote.id).catch(() => null) };
    },
    onSuccess: ({ result, lines: count }) => {
      const message = addedMessage(result, { name: nameOf(fresh[0] ?? ""), startOver, lines: count, roofing: isRoofingCompany(session.company) });
      toast.success(message.title, { description: message.description ?? undefined });
      onDone();
    },
  });
  const submit = async () => {
    if (startOver && !(await confirm({ title: "Start the estimate over?", body: "Every line and option on it now goes, with any price set on site, and it starts over from the packages you picked.", confirmLabel: "Start over", danger: true }))) return;
    add.mutate();
  };

  const note = startOver
    ? "Pick one package, or two or three to offer as options."
    : plan.converting
      ? `The estimate as it is now becomes option 1${current ? ` (${current.name})` : ""}, and each package you pick becomes another option.`
      : options.length
        ? `Each package you pick becomes another option, up to ${MAX_OPTIONS}.`
        : "Pick one package to price the estimate from it, or two or three to offer as options.";

  return (
    <Dialog open onClose={onClose} title={startOver ? "Start over from packages" : plan.empty ? "Pick packages" : "Add options"} description={note} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void submit();
        }}
      >
        {canStartOver && (
          <div className="segmented" role="group" aria-label="How to add them" style={{ justifySelf: "start" }}>
            <button type="button" aria-pressed={!startOver} onClick={() => { setStartOver(false); setPicked([]); }}>Add to this estimate</button>
            <button type="button" aria-pressed={startOver} onClick={() => { setStartOver(true); setPicked([]); }}>Start over</button>
          </div>
        )}
        {packages.isPending ? (
          <div className="row" style={{ gap: 12 }} aria-hidden="true">
            <Skeleton height={180} radius={12} style={{ flex: 1 }} />
            <Skeleton height={180} radius={12} style={{ flex: 1 }} />
            <Skeleton height={180} radius={12} style={{ flex: 1 }} />
          </div>
        ) : packages.error ? (
          <ErrorState compact error={packages.error} onRetry={() => packages.refetch()} />
        ) : list.length ? (
          <PackagePicker packages={list} value={[...locked, ...fresh]} onChange={(ids) => setPicked(ids.filter((id) => !locked.includes(id)))} max={max} locked={locked} multi flagExamples={mode === "office"} />
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No packages yet.{" "}
            {canEditPackages(session) ? <>Set them up in <Link to={packagesPath(session.company)}>Packages</Link>.</> : "The office sets them up."}
          </p>
        )}
        {keepable.length > 0 && list.length > 0 && (
          <div className="field" role="group" aria-labelledby={keepId}>
            <span id={keepId} className="field-label">On every option</span>
            <span className="hint">Ticked lines count whichever option they pick, like extras found on the job. The rest stay on option 1 only.</span>
            <ul className={styles.keep}>
              {keepable.map((l) => (
                <li key={l.id}>
                  <label className="checkbox">
                    <input type="checkbox" checked={shared.includes(l.id)} onChange={(e) => setTicked(new Map(ticked).set(l.id, e.target.checked))} />
                    <span>{l.name.trim() || "A line without a name"}</span>
                  </label>
                </li>
              ))}
            </ul>
            {noneLeft && <span className="field-error">Leave at least one line on option 1.</span>}
          </div>
        )}
        <FormError error={add.error} />
        <div className="form-actions">
          {canEditPackages(session) && list.length > 0 && <Link to={packagesPath(session.company)} className="small strong" style={{ marginRight: "auto" }}>Edit packages</Link>}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={startOver ? "danger-solid" : "primary"} icon="package" loading={add.isPending} disabled={!ready}>{action.label}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The words on an option's card: its name, tier, highlights and warranty. Its lines are on the estimate. */
function EditOptionDialog({ option, onClose, onSaved }: { option: QuoteOptionRow; onClose: () => void; onSaved: () => void }) {
  const tiersId = useId();
  const [name, setName] = useState(option.name);
  const [tier, setTier] = useState(option.tier ?? "");
  const [highlights, setHighlights] = useState(option.highlights);
  const [warranty, setWarranty] = useState(option.warranty);
  const save = useMutation({
    meta: { inline: true, success: "Option saved" },
    mutationFn: () => saveOption(option.id, { name: name.trim(), tier: tier.trim() || null, highlights: cleanHighlights(highlights), warranty: warranty.trim() }),
    onSuccess: onSaved,
  });
  return (
    <Dialog open onClose={onClose} title="Edit this option" description="What the customer reads on its card. Its lines are changed on the estimate.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <div className={styles.nameRow}>
          <Field label="Name" className={styles.nameField}>
            <input className="input" required value={name} maxLength={PACKAGE_LIMITS.name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Tier" optional className={styles.tierField}>
            <input className="input" list={tiersId} value={tier} maxLength={PACKAGE_LIMITS.tier} placeholder="Good, Better…" onChange={(e) => setTier(e.target.value)} />
            <TierWords id={tiersId} />
          </Field>
        </div>
        <HighlightsField value={highlights} onChange={setHighlights} />
        <Field label="Warranty" optional hint="One line: what it covers, and for how long.">
          <textarea className="textarea" rows={2} style={{ minHeight: 0 }} value={warranty} maxLength={PACKAGE_LIMITS.warranty} onChange={(e) => setWarranty(e.target.value)} />
        </Field>
        {isExampleWarranty(warranty) && <p className="callout callout-info" style={{ margin: 0 }}>{STARTER_NOTE}</p>}
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!name.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
