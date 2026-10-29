/**
 * The small pieces of packages that other screens show, kept apart from the Packages page
 * (RoofPackagesPage.tsx) so the quote page and the iPad visit don't load the whole editor: a
 * package's drawing and picture (PackageArt, PackagePicture), the cards a salesperson picks one
 * package from, or two or three to offer as options (PackagePicker), and the inputs for what's on a
 * package's or an option's card (TierWords, HighlightsField). Their pure parts are in data.ts.
 */
import { isExampleWarranty, PACKAGE_LIMITS, packagePictureSrc } from "@crewtavo/core/presets";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, cx } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { formatMoney, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import { highlightRoom, isRoofingCompany, MAX_OPTIONS, moveItem, packageExtras, packagePriceLine, pickPackage, sameList, TIER_WORDS, type PackageStyle } from "./data";
import styles from "./PackageCards.module.css";
import { canEditPackages, type RoofPackage } from "./packages";

const FORMAT = { whole: formatMoney, cents: formatMoneyCents };

/** The look of each style: a roof's color and the lines of its shingles or panels. */
const ART: Record<PackageStyle, { bg: string; line: string; w: number; h: number; d: string }> = {
  shingle: { bg: "#5b6770", line: "#4a555d", w: 30, h: 20, d: "M0 10h30M0 20h30M10 0v10M25 10v10" },
  designer: { bg: "#6e5a4b", line: "#5c4a3d", w: 36, h: 24, d: "M0 12h36M0 24h36M14 0l-4 12M32 12l-4 12" },
  metal: { bg: "#3f5566", line: "#5f7889", w: 12, h: 12, d: "M6 0v12" },
  other: { bg: "#66747a", line: "#5a676d", w: 14, h: 14, d: "M0 14L14 0" },
};

/**
 * A package's drawing, when it has no picture: a tile for lists, or (`fill`) as large as the box
 * it's in. The colors are the roofing material's own, so they're the same in dark mode.
 */
export function PackageArt({ style, size = 44, fill = false }: { style: string; size?: number; fill?: boolean }) {
  const id = `roof-art-${useId().replace(/:/g, "")}`;
  const art = ART[style as PackageStyle] ?? ART.other;
  return (
    <svg className={fill ? styles.artFill : styles.art} width={fill ? "100%" : size} height={fill ? "100%" : size} aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width={art.w} height={art.h} patternUnits="userSpaceOnUse">
          <path d={art.d} fill="none" stroke={art.line} strokeWidth="2" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={art.bg} />
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * A package's (or an option's) picture in a 4:3 box, cut to fill it: its photo, or the drawing of
 * its style when it has none (or the photo doesn't load). `className` sets the width and corners.
 */
export function PackagePicture({ path, style, className }: { path: string | null; style: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={cx(styles.picture, className)} aria-hidden="true">
      {path && failed !== path ? <img src={packagePictureSrc(path)} alt="" decoding="async" onError={() => setFailed(path)} /> : <PackageArt style={style} fill />}
    </span>
  );
}

type PickerBase = {
  packages: RoofPackage[];
  /**
   * Marks a package still on the example warranty setup gave it, for the people who can change it:
   * on the office's screens, never where the customer is looking on.
   */
  flagExamples?: boolean;
};
/**
 * Pick one package, or two or three to offer as options: `value` is in the order they were picked.
 * `multi`: a screen that only offers options, where every tap adds a package or takes it off.
 */
type PickMany = PickerBase & { value: string[]; onChange: (ids: string[]) => void; max?: number; locked?: string[]; multi?: boolean };
/** Pick one package (screens that don't offer options). */
type PickOne = PickerBase & { value: string | null; onChange: (id: string) => void };
export type PackagePickerProps = PickMany | PickOne;
const picksMany = (props: PackagePickerProps): props is PickMany => Array.isArray(props.value);

/**
 * The packages as big cards to pick from: the picture, the tier, the name, the price and what else
 * it has. A tap picks that package instead, as it always has. With `value` a list, "+ Offer as an
 * option" puts one beside the others, up to `max` (3), each numbered in the order picked; with two
 * or more (or `multi`), a tap adds one or takes it off. `locked` packages are already on the
 * estimate: picked, first, and staying. With `value` one id (or null) it only ever picks one.
 * With `flagExamples`, a package whose warranty is still setup's example wording says so.
 */
export function PackagePicker(props: PickMany): ReactNode;
export function PackagePicker(props: PickOne): ReactNode;
export function PackagePicker(props: PackagePickerProps) {
  const { packages } = props;
  const session = useSession();
  const roofing = isRoofingCompany(session.company);
  const flag = Boolean(props.flagExamples) && canEditPackages(session);
  const many = picksMany(props);
  const locked = many ? (props.locked ?? []) : [];
  const max = many ? (props.max ?? MAX_OPTIONS) : 1;
  const value = many ? [...locked, ...props.value.filter((id) => !locked.includes(id))] : props.value ? [props.value] : [];
  const multi = many && Boolean(props.multi);
  const numbered = many && (multi || value.length > 1 || locked.length > 0);
  const [full, setFull] = useState(false);
  const pick = (id: string, add = false) => {
    if (!picksMany(props)) return props.onChange(id);
    const next = pickPackage(value, id, { max, locked, add, toggle: multi });
    setFull(next.full);
    if (!sameList(next.value, value)) props.onChange(next.value);
  };
  return (
    <div className="stack-sm">
      <div className={styles.picker} role="group" aria-label="Packages">
        {packages.map((p) => {
          const order = value.indexOf(p.id);
          const on = order >= 0;
          const fixed = locked.includes(p.id);
          const extras = packageExtras(p, roofing);
          return (
            <div key={p.id} className={styles.pick} data-on={on || undefined}>
              <button type="button" className={styles.pickMain} aria-pressed={on} aria-disabled={fixed || undefined} onClick={() => pick(p.id)}>
                <PackagePicture path={p.picture} style={p.style} className={styles.pickPicture} />
                <span className={styles.pickText}>
                  {p.tier && <span className="chip">{p.tier}</span>}
                  <strong>{p.name}</strong>
                  <span className={styles.pickPrice}>{packagePriceLine(p, roofing, FORMAT)}</span>
                  {extras && <small>{extras}</small>}
                  {flag && isExampleWarranty(p.warranty) && (
                    <span className={styles.pickFlag}>
                      <Icon name="alert" size={14} />
                      Example warranty
                    </span>
                  )}
                </span>
                {on &&
                  (numbered ? (
                    <span className={styles.pickNumber}><span className="sr-only">Option </span>{order + 1}</span>
                  ) : (
                    <span className={styles.pickCheck} aria-hidden="true"><Icon name="check" size={14} strokeWidth={2} /></span>
                  ))}
              </button>
              {fixed ? (
                <span className={styles.pickFoot}>On the estimate now</span>
              ) : many && !on && !multi ? (
                <button type="button" className={styles.pickOffer} aria-label={`Offer ${p.name} as an option`} onClick={() => pick(p.id, true)}>
                  <Icon name="plus" size={14} />Offer as an option
                </button>
              ) : numbered && on ? (
                <button type="button" className={styles.pickOffer} aria-label={`Don't offer ${p.name}`} onClick={() => pick(p.id)}>
                  <Icon name="x" size={14} />Take it off
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {many && (
        <p className={styles.pickNote} role="status">
          {full ? `Up to ${MAX_OPTIONS} options. Take one off to offer another.` : value.length > 1 ? `${value.length} packages, each its own option on the estimate.` : ""}
        </p>
      )}
    </div>
  );
}

/** Good, Better and Best, offered as a tier input's suggestions (`<input list={id}>`). */
export function TierWords({ id }: { id: string }) {
  return (
    <datalist id={id}>
      {TIER_WORDS.map((t) => <option key={t} value={t} />)}
    </datalist>
  );
}

/**
 * A package's (or an option's) highlights: short lines the customer reads on its card, added, taken
 * off and moved up or down, within PACKAGE_LIMITS. `onCommit` runs when a line is left, taken off or
 * moved, to save as the person goes; lines are cleaned (cleanHighlights) when they're saved.
 */
export function HighlightsField({ value, onChange, onCommit, disabled }: { value: string[]; onChange: (lines: string[]) => void; onCommit?: (lines: string[]) => void; disabled?: boolean }) {
  const labelId = useId();
  const list = useRef<HTMLOListElement>(null);
  const [focusLast, setFocusLast] = useState(false);
  useEffect(() => {
    if (!focusLast) return;
    list.current?.querySelector<HTMLInputElement>("li:last-child input")?.focus();
    setFocusLast(false);
  }, [focusLast]);
  const used = value.reduce((sum, line) => sum + line.trim().length, 0);
  const canAdd = value.length < PACKAGE_LIMITS.highlights && used < PACKAGE_LIMITS.highlightChars;
  const change = (next: string[]) => {
    onChange(next);
    onCommit?.(next);
  };
  const add = () => {
    onChange([...value, ""]);
    setFocusLast(true);
  };
  return (
    <div className="field" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="field-label">Highlights <span className="optional">(optional)</span></span>
      {value.length > 0 && (
        <ol ref={list} className={styles.highlights}>
          {value.map((line, i) => (
            <li key={i} className={styles.highlight}>
              <input
                className="input"
                value={line}
                maxLength={highlightRoom(value, i)}
                aria-label={`Highlight ${i + 1}`}
                placeholder="A short line about it"
                disabled={disabled}
                onChange={(e) => onChange(value.map((l, j) => (j === i ? e.target.value : l)))}
                onBlur={() => onCommit?.(value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  if (canAdd && i === value.length - 1 && line.trim()) add();
                  else e.currentTarget.blur();
                }}
              />
              <Button size="sm" variant="ghost" icon="chevronUp" aria-label={`Move highlight ${i + 1} up`} disabled={disabled || i === 0} onClick={() => change(moveItem(value, i, i - 1))} />
              <Button size="sm" variant="ghost" icon="chevronDown" aria-label={`Move highlight ${i + 1} down`} disabled={disabled || i === value.length - 1} onClick={() => change(moveItem(value, i, i + 1))} />
              <Button size="sm" variant="ghost" icon="x" aria-label={`Take highlight ${i + 1} off`} disabled={disabled} onClick={() => change(value.filter((_, j) => j !== i))} />
            </li>
          ))}
        </ol>
      )}
      {canAdd ? (
        <button type="button" className="link-btn small" style={{ justifySelf: "start" }} disabled={disabled} onClick={add}>Add a highlight</button>
      ) : (
        <span className="hint">That's as many as fit on its card.</span>
      )}
    </div>
  );
}
