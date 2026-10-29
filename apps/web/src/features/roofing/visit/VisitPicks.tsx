/**
 * "Add items" on the iPad's site visit (VisitPage): the package's quick adds and the price list by
 * category, each with its picture (the business's own, else a drawing: ServicePicture) and its
 * price, to tap onto the estimate.
 * One already on it shows how many, with − and +, or − to take a measured line off; the paper beside
 * shows each change as it lands. On an estimate with options they go where the line list's quick
 * adds go (rows.ts lineDestination): on every option, unless they're the option's own.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { takeoffVariables, type TakeoffRow } from "../../paving/data";
import type { EstimateEditor } from "../estimate/data";
import type { EstimateView } from "../estimate/EstimateList";
import { countText, estimateRows, isPendingLine, lineDestination, money, ownServices, quickAddPrice, searchServices, type EstimateRow } from "../estimate/rows";
import type { EstimateLine, EstimateQuote, EstimateService, QuickAddService } from "../estimate/types";
import { ServicePicture } from "./ServicePicture";
import styles from "./picks.module.css";

export interface VisitPicksProps {
  quote: EstimateQuote;
  editor: EstimateEditor;
  /** The package's quick adds, first under "For this roof". */
  quickAdds: readonly QuickAddService[];
  /** The price list (useActiveServices); null while it loads. */
  services: readonly EstimateService[] | null | undefined;
  takeoff: TakeoffRow | null;
  /** On an estimate with options: the option looked at. */
  view: EstimateView | null;
  /** Show a line that's already on where it is on the paper (a tap on its picture that can't add more). */
  onShow?: (line: EstimateLine) => void;
}

const QUICK = "quick";
const NO_SERVICES: ReadonlySet<string> = new Set();

export function VisitPicks({ quote, editor, quickAdds, services, takeoff, view, onShow }: VisitPicksProps) {
  const optionId = view?.optionId ?? null;
  const vars = useMemo(() => (takeoff ? takeoffVariables(takeoff, null) : null), [takeoff]);
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<string | null>(null);

  // How many a quick add starts at (6 sheets of decking), by service.
  const starts = useMemo(() => new Map(quickAdds.map((s) => [s.id, s.quantity])), [quickAdds]);
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: EstimateService[] }> = [];
    if (quickAdds.length) out.push({ key: QUICK, label: "For this roof", items: [...quickAdds] });
    const byCategory = new Map<string, EstimateService[]>();
    for (const s of services ?? []) {
      const category = s.category?.trim() || "Everything else";
      byCategory.set(category, [...(byCategory.get(category) ?? []), s]);
    }
    for (const [category, items] of byCategory) out.push({ key: `category:${category}`, label: category, items });
    return out;
  }, [quickAdds, services]);
  const group = groups.find((g) => g.key === picked) ?? groups[0] ?? null;
  const searching = term.trim() !== "";
  const shown = searching ? searchServices(services ?? [], term).slice(0, 60) : (group?.items ?? []);

  // What's on the estimate now, by service: its row, with what − and + do.
  const rows = useMemo(() => {
    const { roof, other } = estimateRows(quote.lines, { optionId, added: editor.added, changed: editor.changed, removed: editor.removed });
    const byService = new Map<string, EstimateRow>();
    for (const row of [...roof, ...other]) if (row.line?.service_id && !byService.has(row.line.service_id)) byService.set(row.line.service_id, row);
    return byService;
  }, [quote.lines, optionId, editor.added, editor.changed, editor.removed]);
  const own = useMemo(() => (view ? ownServices(view.own, view.optionId, [...(quote.range_lines ?? []), ...editor.removed]) : NO_SERVICES), [view, quote.range_lines, editor.removed]);
  const add = (s: EstimateService) => editor.addService(s, starts.get(s.id) ?? undefined, lineDestination(s, optionId, { own, lines: quote.lines, place: "every" }));

  if (services && services.length === 0 && !quickAdds.length) {
    return <p className={styles.note}>Your price list is empty. Add services in <Link to="/settings?tab=prices">Settings → Price list</Link>.</p>;
  }
  return (
    <div className={styles.picks}>
      <div className={styles.search}>
        <span className={styles.searchIcon} aria-hidden="true"><Icon name="search" size={17} /></span>
        <input
          className={`input ${styles.searchInput}`}
          type="search"
          aria-label="Search your price list"
          placeholder="Search your price list"
          autoComplete="off"
          enterKeyHint="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      {groups.length > 1 && (
        <div className={styles.groups} role="group" aria-label="Kinds of work">
          {groups.map((g) => {
            const on = g.items.filter((s) => rows.has(s.id)).length;
            return (
              <button
                key={g.key}
                type="button"
                className={styles.group}
                aria-pressed={!searching && g.key === group?.key}
                onClick={() => {
                  setPicked(g.key);
                  setTerm("");
                }}
              >
                {g.label}
                {on > 0 && <span className={styles.groupCount} aria-label={`${on} on the estimate`}>{on}</span>}
              </button>
            );
          })}
        </div>
      )}
      {view && <p className={styles.note}>They go on every option, unless they're part of {view.label}'s package.</p>}
      {!searching && group?.key === QUICK && <p className={styles.caption}>From the package</p>}
      {searching && <p className={styles.caption}>{shown.length ? `${shown.length === 60 ? "The first 60" : shown.length} for “${term.trim()}”` : `Nothing in your price list matches “${term.trim()}”.`}</p>}

      {!services && !quickAdds.length ? (
        <div className={styles.grid} aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={230} radius={14} />)}
        </div>
      ) : (
        <div className={styles.grid}>
          {shown.map((s) => (
            <Tile key={s.id} service={s} row={rows.get(s.id) ?? null} start={starts.get(s.id) ?? null} price={quickAddPrice(s, vars)} editor={editor} onAdd={() => add(s)} onShow={onShow} />
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ service, row, start, price, editor, onAdd, onShow }: { service: EstimateService; row: EstimateRow | null; start: number | null; price: string; editor: EstimateEditor; onAdd: () => void; onShow?: (line: EstimateLine) => void }) {
  const line = row?.line ?? null;
  const adding = editor.adding.includes(service.id);
  // Still saving: its buttons work once it's saved.
  const saving = Boolean(line && isPendingLine(line));
  const stepper = Boolean(row && line && (row.kind === "count" || row.kind === "layers"));
  // "3" of "3 boots", "2" of "2 layers".
  const howMany = stepper ? (row!.quantity?.split(" ")[0] ?? null) : null;
  const tap = () => {
    if (!line) return onAdd();
    if (stepper && row!.more && !saving) return editor.inc(line);
    onShow?.(line);
  };
  const tapLabel = !line ? `Add ${service.name}` : stepper && row!.more ? row!.moreLabel : `Show ${service.name} on the estimate`;

  return (
    <article className={styles.tile} data-on={line ? "" : undefined}>
      <button type="button" className={styles.pic} aria-label={tapLabel} disabled={adding} onClick={tap}>
        <ServicePicture name={service.name} picture={service.picture} />
        {line && <span className={styles.badge}>{howMany ?? <Icon name="check" size={16} strokeWidth={2.25} />}</span>}
      </button>
      <div className={styles.body}>
        <span className={styles.text}>
          <span className={styles.name}>{service.name}</span>
          <span className={styles.price}>{price}</span>
        </span>
        {!line ? (
          <button type="button" className={styles.add} disabled={adding} aria-busy={adding || undefined} onClick={onAdd}>
            {adding ? <Spinner size={16} /> : <Icon name="plus" size={16} strokeWidth={2} />}
            {start && start > 1 ? `Add ${countText(start)}` : "Add"}
          </button>
        ) : stepper ? (
          <div className={styles.stepper}>
            <button type="button" className={styles.step} aria-label={row!.lessLabel} disabled={saving} onClick={() => editor.dec(line)}>
              <Icon name="minus" size={18} strokeWidth={2} />
            </button>
            <span className={styles.count} aria-live="polite" aria-label={row!.quantity ?? undefined}>{howMany}</span>
            <button type="button" className={styles.step} aria-label={row!.moreLabel} disabled={saving || !row!.more} onClick={() => editor.inc(line)}>
              <Icon name="plus" size={18} strokeWidth={2} />
            </button>
          </div>
        ) : (
          <div className={styles.onIt}>
            <span className={styles.onText}>
              <Icon name="check" size={16} strokeWidth={2.25} />
              {money(row!.amount)}
            </span>
            {row!.less && (
              <button type="button" className={styles.step} aria-label={row!.lessLabel} disabled={saving} onClick={() => editor.dec(line)}>
                <Icon name="minus" size={18} strokeWidth={2} />
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
