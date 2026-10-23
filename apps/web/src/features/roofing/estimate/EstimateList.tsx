/**
 * The estimate as one list, the same in the office and on the iPad (size "large"): what's on the roof
 * (worked out from the measurements) and everything else. Counts have − and +, measured lines a − to
 * take them off, and the tear-off its layers. Lines added, changed or taken off since the range say
 * so, and one taken off stays crossed out with Put back. Under it, the package's quick adds and a
 * search of the price list.
 */
import type { LineChange } from "@crewtavo/core/estimates";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { Spinner } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { formatNumber } from "@/lib/format";
import { takeoffVariables, type TakeoffRow } from "../../paving/data";
import type { EstimateEditor } from "./data";
import { counts, estimateRows, isPendingLine, money, quickAddPrice, searchServices, serviceDetail, type EstimateRow, type RowTag } from "./rows";
import type { EstimateQuote, EstimateService, QuickAddService } from "./types";
import styles from "./estimate.module.css";

const TAGS: Record<RowTag, string> = { added: "Added", changed: "Changed", removed: "Taken off" };

export interface EstimateListProps {
  quote: EstimateQuote;
  /** What changed since the range (lineChanges(quote.range_lines, quote.lines)), to tag and cross out. */
  changes?: readonly LineChange[] | null;
  /** "large" on the iPad: bigger rows and buttons for a finger. */
  size?: "regular" | "large";
  /** Whether the lines can change here (the quote isn't signed, and this person sells). */
  editable: boolean;
  editor?: EstimateEditor | null;
  /** The package's quick adds; the ones already on the estimate aren't offered. */
  quickAdds?: readonly QuickAddService[];
  /** The price list, to search (useActiveServices). Leave it out while it loads. */
  services?: readonly EstimateService[] | null;
  /** The roof's measurement, for "with 10% waste" and what a measured quick add comes to. */
  takeoff?: TakeoffRow | null;
}

export function EstimateList({ quote, changes, size = "regular", editable, editor, quickAdds = [], services, takeoff }: EstimateListProps) {
  const canEdit = editable && Boolean(editor);
  const vars = useMemo(() => (takeoff ? takeoffVariables(takeoff, null) : null), [takeoff]);
  const { roof, other } = useMemo(
    () =>
      estimateRows(quote.lines, {
        changes,
        rangeLines: quote.range_lines,
        added: editor?.added,
        changed: editor?.changed,
        removed: editor?.removed,
        wastePct: takeoff ? Number(takeoff.waste_pct) : null,
      }),
    [quote.lines, quote.range_lines, changes, editor?.added, editor?.changed, editor?.removed, takeoff],
  );
  const onEstimate = useMemo(() => new Set(quote.lines.filter(counts).flatMap((l) => (l.service_id ? [l.service_id] : []))), [quote.lines]);
  const chips = quickAdds.filter((s) => !onEstimate.has(s.id));
  const squares = vars?.roof_squares ?? null;
  const pitch = takeoff?.roof_pitch ? (takeoff.roof_pitch === "0/12" ? "flat" : `at ${takeoff.roof_pitch}`) : null;
  const roofTitle = size === "large" && squares ? `The roof · ${formatNumber(squares, 1)} squares${pitch ? ` ${pitch}` : ""}` : "The roof · from the measurements";

  return (
    <div className={styles.list} data-size={size}>
      {canEdit && (
        <span className={styles.saving} role="status" aria-live="polite">
          {editor?.busy && <><Spinner size={12} /> Saving…</>}
        </span>
      )}
      {!roof.length && !other.length && <p className={styles.empty}>Nothing on the estimate yet.{canEdit ? " Add something below." : ""}</p>}
      {roof.length > 0 && <Section title={roofTitle} rows={roof} canEdit={canEdit} editor={editor} />}
      {other.length > 0 && <Section title="Everything else" rows={other} canEdit={canEdit} editor={editor} />}

      {canEdit && editor && (
        <div className={styles.add}>
          <h3 className={styles.addTitle}>{size === "large" ? "Found something else?" : "Add to the estimate"}</h3>
          {chips.length > 0 && (
            <div className={styles.chips}>
              {chips.map((s) => {
                const adding = editor.adding.includes(s.id);
                const price = quickAddPrice(s, vars);
                return (
                  <button key={s.id} type="button" className={styles.chip} disabled={adding} aria-busy={adding || undefined} aria-label={`Add ${s.name}, ${price}`} onClick={() => editor.addService(s, s.quantity)}>
                    {adding ? <Spinner size={size === "large" ? 17 : 15} /> : <Icon name="plus" size={size === "large" ? 17 : 15} strokeWidth={2.8} />}
                    {s.name}
                    <small>{price}</small>
                  </button>
                );
              })}
            </div>
          )}
          {!services ? (
            <div className={styles.search} aria-hidden="true">
              <span className={styles.searchIcon}><Icon name="search" size={16} /></span>
              <input className={`input ${styles.searchInput}`} disabled placeholder="Loading your price list…" tabIndex={-1} />
            </div>
          ) : services.length > 0 ? (
            <ServiceSearch services={services} onEstimate={onEstimate} onPick={(s) => editor.addService(s)} />
          ) : (
            <p className={styles.hint}>Your price list is empty. Add services in <Link to="/settings?tab=prices">Settings → Price list</Link>.</p>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, rows, canEdit, editor }: { title: string; rows: EstimateRow[]; canEdit: boolean; editor?: EstimateEditor | null }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>{title}</h3>
      <ul className={styles.rows}>
        {rows.map((row) => <Row key={row.key} row={row} editor={canEdit ? editor : null} />)}
      </ul>
    </section>
  );
}

function Row({ row, editor }: { row: EstimateRow; editor?: EstimateEditor | null }) {
  const removed = row.tag === "removed";
  const line = row.line;
  // Still saving (just put back or added): its buttons work once it's saved.
  const saving = Boolean(line && isPendingLine(line));
  return (
    <li className={styles.row} data-removed={removed || undefined}>
      <span className={styles.what}>
        <span className={styles.nameLine}>
          <span className={styles.name}>{row.name}</span>
          {row.tag && <span className={styles.tag} data-tag={row.tag}>{TAGS[row.tag]}</span>}
        </span>
        {row.detail && <span className={styles.detail}>{row.detail}</span>}
      </span>
      <span className={styles.controls}>
        {editor && line && row.less && (
          <button type="button" className={styles.round} aria-label={row.lessLabel} disabled={saving} onClick={() => editor.dec(line)}>
            <Icon name="minus" size={16} strokeWidth={2.5} />
          </button>
        )}
        {editor && line && row.quantity !== null && <span className={styles.qty} aria-live="polite">{row.quantity}</span>}
        {editor && line && (row.kind === "count" || row.kind === "layers") && (
          <button type="button" className={styles.round} aria-label={row.moreLabel} disabled={saving || !row.more} onClick={() => editor.inc(line)}>
            <Icon name="plus" size={16} strokeWidth={2.5} />
          </button>
        )}
        {!editor && row.quantity !== null && !removed && <span className={styles.qty}>{row.quantity}</span>}
        {editor && removed && row.removed && (
          <button type="button" className={styles.putBack} aria-label={`Put ${row.name} back`} onClick={() => editor.putBack(row.removed!)}>Put back</button>
        )}
      </span>
      <span className={styles.amount}>{money(row.amount)}</span>
    </li>
  );
}

/** "Something else? Search your price list": type, pick with a tap or the arrow keys and Enter. */
function ServiceSearch({ services, onEstimate, onPick }: { services: readonly EstimateService[]; onEstimate: Set<string>; onPick: (service: EstimateService) => void }) {
  const id = useId();
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => searchServices(services, term).slice(0, 40), [services, term]);
  const pick = (service: EstimateService) => {
    onPick(service);
    setTerm("");
    setActive(0);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && open && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  };
  const showing = open && (matches.length > 0 || term.trim() !== "");
  return (
    <div className={styles.search}>
      <span className={styles.searchIcon} aria-hidden="true"><Icon name="search" size={16} /></span>
      <input
        className={`input ${styles.searchInput}`}
        role="combobox"
        aria-label="Search your price list"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={`${id}-list`}
        aria-activedescendant={showing && matches[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        enterKeyHint="search"
        placeholder="Something else? Search your price list"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {showing && (
        <ul id={`${id}-list`} role="listbox" aria-label="Your price list" className={styles.options}>
          {matches.length === 0 && <li role="presentation" className={styles.noMatch}>Nothing in your price list matches “{term.trim()}”.</li>}
          {matches.map((s, i) => (
            <li
              key={s.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className={styles.option}
              // Keep the focus in the box, so the tap picks it before the list closes.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(s)}
            >
              <span className={styles.optionText}>
                <span className={styles.optionName}>{s.name}</span>
                <span className={styles.optionDetail}>{serviceDetail(s)}</span>
              </span>
              {onEstimate.has(s.id) && <span className="chip chip-green">On it</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The list's shape while the estimate loads. */
export function EstimateListSkeleton({ rows = 6, size = "regular" }: { rows?: number; size?: "regular" | "large" }) {
  return (
    <Loading label="Loading the estimate">
      <div className={styles.list} data-size={size}>
        <Skeleton width={190} height={10} style={{ margin: "8px 0 6px" }} />
        <ul className={styles.rows}>
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className={styles.row}>
              <span className={styles.what}>
                <Skeleton width={["58%", "44%", "52%", "38%", "48%", "62%"][i % 6]} height={size === "large" ? 15 : 13} />
                <Skeleton width={["40%", "30%", "36%", "26%"][i % 4]} height={10} />
              </span>
              <span />
              <Skeleton width={64} height={size === "large" ? 15 : 13} style={{ justifySelf: "end" }} />
            </li>
          ))}
        </ul>
      </div>
    </Loading>
  );
}
