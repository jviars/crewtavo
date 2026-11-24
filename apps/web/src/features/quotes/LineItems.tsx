/**
 * Line items, shared by quotes, jobs and invoices. They read like a simple table; clicking a row opens
 * it for editing (one at a time). Each field saves when it loses focus (or on Enter), and says so in
 * the page header's save status when the page passes one; totals are recalculated by Postgres
 * triggers, so the parent just refetches. Removing a line can be undone.
 *
 * On a quote that offers options (quote_options), `lines` is every line on the quote and the list
 * shows the ones on every option with the option being looked at (`optionId`). New lines go on that
 * option, or on every option, and a line can be moved between them; the money counts as core money.ts
 * counts it for that option. Jobs and invoices have no options.
 *
 * A line from a price-list item with a rule that reads only an area (Weekly mow at
 * max(45, area_sqft / 1000 * 4.5)) is priced by its size: square feet typed on the line, or the area
 * of a drawing saved for the property (`propertyId`). The rule sets what a drawing would on a quote.
 */
import { evaluateFormula, formulaVariables } from "@crewtavo/core/formulas";
import { countsOn, lineTotal, optionLabels, optionLines, toCents } from "@crewtavo/core/money";
import { promoCodeOf, removedPromoWords } from "@crewtavo/core/promos";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button, cx } from "@/components/ui/Button";
import { DecimalInput } from "@/components/ui/DecimalInput";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { NumberInput } from "@/components/ui/NumberInput";
import type { SaveStatusHandle } from "@/components/ui/SaveStatus";
import { Select } from "@/components/ui/Select";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { ApiError, errorMessage, isAuthError, isNetworkError, isRestarting } from "@/lib/errors";
import { currencySymbol, formatMoneyCents, formatNumber } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast, type ToastTone } from "@/lib/toast";
import { readJobDiscounts } from "../jobs/JobDiscountNote";
import { followedPriceOf } from "../roofing/packages";
import styles from "./LineItems.module.css";

type Table = "quote_line_items" | "job_line_items" | "invoice_line_items";
type Parent = "quote_id" | "job_id" | "invoice_id";

export interface Line {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  unit_cost?: number | null;
  taxable: boolean;
  sort: number;
  optional?: boolean;
  selected?: boolean;
  formula?: string | null;
  service_id?: string | null;
  /** A quote line's option; null (or left out) for a line on every option. */
  option_id?: string | null;
  /** Add-ons that share one are a single choice: the client picks one of them. */
  option_group?: string | null;
  /** An invoice line that's a job's promo code discount (supabase/migrations/20261031000600_promo_once_per_job.sql). */
  discount_quote_id?: string | null;
  /** A job line that's a promo code's discount: the quote it's from. */
  discount_key?: string | null;
}

/**
 * A promo code's discount line on a job or an invoice. It stays the code's: its price and quantity
 * aren't typed (a price can't be typed below zero, and the database keeps it money off), and it isn't
 * duplicated, or the copy would come off every visit as a plain discount.
 */
export const isPromoLine = (table: Table, line: Pick<Line, "discount_quote_id" | "discount_key">) =>
  (table === "job_line_items" && Boolean(line.discount_key)) || (table === "invoice_line_items" && Boolean(line.discount_quote_id));

const COPY_FIELDS = ["name", "description", "quantity", "unit", "unit_price", "taxable", "service_id"] as const;
/**
 * What the line editor reads of the price list. An item's cost is only asked for by someone who
 * may see costs (Job costs and profit). Without it, a line they add from the price list goes on
 * with no cost and the database gives it the item's (20261112000420_rates_behind_job_costs.sql).
 */
const PRICE_LIST_COLUMNS = "id, name, description, unit, unit_price, taxable, formula, formula_target, category";
export const priceListColumns = (seesCosts: boolean) => (seesCosts ? (`${PRICE_LIST_COLUMNS}, unit_cost` as const) : PRICE_LIST_COLUMNS);
interface PriceListItem { id: string; name: string; description: string | null; unit: string; unit_price: number; unit_cost?: number | null; taxable: boolean; formula: string | null; formula_target: string; category: string | null }

/** A price-list rule on a line: its formula, and whether it sets the line's price or its quantity. */
export interface SizeRule { formula: string; target: string | null | undefined }

/**
 * Whether a typed area is all a rule needs: it reads the area and nothing else.
 * shortcut: a rule that reads a length, a count, a depth or a roof's or paving's own values is still
 * filled from a drawing on a quote; give those their own fields here if a trade needs them typed.
 */
export function sizedBy(formula: string | null | undefined): boolean {
  if (!formula) return false;
  try {
    const reads = [...formulaVariables(formula)];
    return reads.length > 0 && reads.every((name) => name === "area_sqft" || name === "area_sqyd");
  } catch {
    return false;
  }
}

/**
 * What a rule sets on a line for an area in square feet: its price to the cent, or its quantity to 3
 * decimals, as a drawing fills them (applyMeasurement in apps/api/src/services/measurements.ts).
 * Throws for a formula that doesn't work out, or comes to less than zero.
 */
export function sizedPatch(rule: SizeRule, sqft: number): Pick<Line, "unit_price"> | Pick<Line, "quantity"> {
  const value = evaluateFormula(rule.formula, { area_sqft: sqft, area_sqyd: sqft / 9 });
  if (value < 0) throw new Error("That size comes to less than zero. Check the item's formula in Settings.");
  return rule.target === "unit_price" ? { unit_price: Math.round(value * 100) / 100 } : { quantity: Math.round(value * 1000) / 1000 };
}
/** The workflow color of the record the lines are on, for their toasts. */
const TONES: Record<Table, ToastTone> = { quote_line_items: "quote", job_line_items: "job", invoice_line_items: "invoice" };

/** The lines a list shows: on a quote with options, the ones on every option and the option looked at's. */
export function visibleLines<T extends { option_id?: string | null }>(lines: readonly T[], optionId: string | null | undefined): T[] {
  return optionId ? lines.filter((l) => l.option_id == null || l.option_id === optionId) : [...lines];
}

/** The sort number for a new line: after every line there is, shown or not (another option's too). */
export const nextSort = (lines: ReadonlyArray<{ sort: number }>) => lines.reduce((top, l) => Math.max(top, Number(l.sort)), -1) + 1;

/**
 * A line moved up or down past the next line shown: it goes just before (or after) that line among all
 * the lines, the others keep their order (so another option's list stays as it was), and they're
 * numbered again from 0, so equal sort values (old data) can't block a move. Only the lines whose
 * number changes, to save.
 */
export function movedSorts(lines: ReadonlyArray<{ id: string; sort: number }>, shownIds: readonly string[], id: string, dir: -1 | 1): Array<{ id: string; sort: number }> {
  const neighbor = shownIds[shownIds.indexOf(id) + dir];
  if (!shownIds.includes(id) || !neighbor) return [];
  const order = lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => Number(a.line.sort) - Number(b.line.sort) || a.i - b.i)
    .map(({ line }) => line.id)
    .filter((lineId) => lineId !== id);
  order.splice(order.indexOf(neighbor) + (dir === 1 ? 1 : 0), 0, id);
  const before = new Map(lines.map((l) => [l.id, Number(l.sort)]));
  return order.map((lineId, sort) => ({ id: lineId, sort })).filter((l) => before.get(l.id) !== l.sort);
}

/**
 * What the lines shown come to before any discount and tax, and what they cost: the lines that count
 * with the option looked at, as they would once it's the one shown (core optionLines and countsOn), so
 * the price is that option's subtotal. `withOptions`: quote lines, where an add-on the client left off
 * doesn't count; on a job or an invoice every line does.
 */
export function lineSums(lines: readonly Line[], { optionId = null, shownOptionId = null, withOptions = false }: { optionId?: string | null; shownOptionId?: string | null; withOptions?: boolean } = {}) {
  const counted = withOptions
    ? optionLines(lines.map((l) => ({ ...l, option_id: l.option_id ?? null })), optionId, shownOptionId).filter((l) => countsOn(l, optionId))
    : lines;
  const price = counted.reduce((s, l) => s + toCents(lineTotal(l.quantity, l.unit_price)), 0) / 100;
  const cost = counted.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost ?? 0), 0);
  const costed = counted.some((l) => l.unit_cost != null && Number(l.unit_cost) > 0);
  return { price, cost, costed };
}

/** Where a line is, on a quote that offers options: "On every option", or "Only on Better". */
export const placeName = (optionId: string | null | undefined, options: ReadonlyArray<{ id: string; name: string }>) =>
  optionId ? `Only on ${options.find((o) => o.id === optionId)?.name ?? "one option"}` : "On every option";

export function LineItems({
  table,
  parent,
  parentId,
  lines,
  editable,
  onChanged,
  withOptions = false,
  optionId = null,
  shownOptionId = null,
  options = [],
  saveStatus,
  onOfferOptions,
  promoJob = null,
  followMarkup = null,
  propertyId = null,
}: {
  table: Table;
  parent: Parent;
  parentId: string;
  lines: Line[];
  editable: boolean;
  onChanged: () => void;
  withOptions?: boolean;
  /** On a quote that offers options: the option being looked at. Its lines show with the shared ones, and new lines go on it. */
  optionId?: string | null;
  /** The option shown first (quotes.option_id), whose add-on picks count. */
  shownOptionId?: string | null;
  /** The quote's options, for where each line is ("On every option", "Only on Better"). */
  options?: ReadonlyArray<{ id: string; name: string }>;
  /** The page header's save status (useSaveStatus): each field's save shows there, and its failure too; a toast only says why one was turned down. */
  saveStatus?: SaveStatusHandle;
  /** On a quote that offers no options yet: "Offer options" in the add row, beside "Custom item". */
  onOfferOptions?: () => void;
  /** A roof estimate whose package follows ABC Supply: its markup, so a price-list item with ABC materials goes on at today's ABC price. */
  followMarkup?: number | null;
  /** An invoice's job, for what the toast says when one of its promo lines is removed: where the discount went. */
  promoJob?: { id: string; repeats: boolean } | null;
  /** The property the work is at: its drawings' areas are offered on a line priced by size. */
  propertyId?: string | null;
}) {
  const session = useSession();
  const { company } = session;
  const tone = TONES[table];
  const listRef = useListAnimation<HTMLDivElement>();
  const seesCosts = hasRole(session, "admin", "office", "estimator") && can(session, "job_costs");
  const showCosts = seesCosts && table !== "invoice_line_items";
  // Only a quote's lines are ever on an option.
  const offers = table === "quote_line_items" && options.length > 0 && optionId !== null;
  const viewing = offers ? optionId : null;
  const shown = useMemo(() => visibleLines(lines, viewing), [lines, viewing]);
  const viewingName = options.find((o) => o.id === viewing)?.name ?? "this option";
  // Where a new line goes: the option looked at, or every option.
  const [addToEvery, setAddToEvery] = useState(false);
  const services = useQuery({
    queryKey: ["services", company.id, seesCosts ? "with-costs" : "without-costs"],
    enabled: editable,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("services").select(priceListColumns(seesCosts)).eq("company_id", company.id).eq("active", true).order("sort")) as unknown as PriceListItem[],
  });
  // A job's line has no formula of its own: its price-list item's is its rule. A quote's keeps the one it was added with.
  const ruleOf = (line: Line): SizeRule | null => {
    const item = services.data?.find((s) => s.id === line.service_id);
    const formula = line.formula ?? item?.formula;
    return formula && sizedBy(formula) ? { formula, target: item?.formula_target } : null;
  };
  const drawings = useQuery({
    queryKey: ["measurements", "areas", propertyId],
    enabled: editable && Boolean(propertyId),
    staleTime: 60_000,
    queryFn: async () => unwrap(await supabase().from("measurements").select("id, title, total_area_sqft").eq("property_id", propertyId!).gt("total_area_sqft", 0).order("created_at", { ascending: false }).limit(3)),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  // Numbered after every line, another option's too, so a new line never shares a place with one.
  const insert = async (rows: Array<Record<string, unknown>>) => {
    const base = nextSort(lines);
    const created = unwrap(await supabase().from(table).insert(rows.map((row, i) => ({ ...row, company_id: company.id, [parent]: parentId, sort: base + i })) as never).select("id")) as Array<{ id: string }>;
    return created[0]?.id ?? null;
  };

  const add = useMutation({
    mutationFn: async (serviceId: string | null) => {
      const s = services.data?.find((x) => x.id === serviceId);
      const row: Record<string, unknown> = s
        ? { service_id: s.id, name: s.name, description: s.description, unit: s.unit, unit_price: s.unit_price, taxable: s.taxable, quantity: 1 }
        : { name: "New item", quantity: 1, unit: "ea", unit_price: 0 };
      // Sent only when this person was given it; otherwise the database fills it in from the item.
      if (table !== "invoice_line_items" && s && s.unit_cost !== undefined) row.unit_cost = s.unit_cost;
      if (table === "quote_line_items" && s) row.formula = s.formula;
      const followed = table === "quote_line_items" && s && followMarkup !== null ? await followedPriceOf(s.id, followMarkup) : null;
      if (followed !== null) row.unit_price = followed;
      if (offers) row.option_id = addToEvery ? null : viewing;
      return { id: await insert([row]), open: !s || sizedBy(s.formula) };
    },
    // A custom item opens for editing right away, and so does one priced by its size, to ask for it; any other price-list item is ready as it is.
    onSuccess: (r) => {
      if (r.open) setOpenId(r.id);
      onChanged();
    },
  });

  const move = useMutation({
    mutationFn: async ({ id, dir }: { id: string; dir: -1 | 1 }) => {
      const changes = movedSorts(lines, shown.map((l) => l.id), id, dir);
      await Promise.all(changes.map((c) => supabase().from(table).update({ sort: c.sort } as never).eq("id", c.id)));
    },
    onSuccess: onChanged,
  });

  const duplicate = useMutation({
    meta: { success: "Line duplicated", tone },
    mutationFn: async (line: Line) => {
      const row: Record<string, unknown> = Object.fromEntries(COPY_FIELDS.map((k) => [k, line[k] ?? null]));
      if (table !== "invoice_line_items") row.unit_cost = line.unit_cost ?? null;
      if (table === "quote_line_items") Object.assign(row, { optional: line.optional ?? false, selected: line.selected ?? true, formula: line.formula ?? null });
      // The copy is where the line is: on every option, or on the one looked at.
      if (offers) row.option_id = line.option_id ?? null;
      setOpenId(await insert([row]));
    },
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: async (line: Line) => {
      // A job's promo line on a draft: where its discount goes is read before and after (the database
      // moves it as the line comes off), so the toast can say. The draft's other lines say whether it
      // still takes the code off (an every-visit code has a copy on each visit).
      const key = table === "invoice_line_items" && promoJob ? line.discount_quote_id : null;
      const before = key && promoJob ? await readJobDiscounts(promoJob.id) : null;
      unwrap(await supabase().from(table).delete().eq("id", line.id));
      const after = key && promoJob ? await readJobDiscounts(promoJob.id) : null;
      const rest = lines.filter((l) => l.id !== line.id);
      return { line, note: key && promoJob ? removedPromoWords(key, parentId, before, after, promoJob.repeats, rest) : null };
    },
    // Gone at once (the totals follow), and put back from the toast: a new row with the same fields.
    onSuccess: ({ line, note }) => {
      onChanged();
      toast.success("Line removed", {
        description: note ?? line.name,
        tone,
        countdown: true,
        action: {
          label: "Undo",
          onClick: async () => {
            const { id: _id, ...rest } = line;
            const row: Record<string, unknown> = { ...rest, company_id: company.id, [parent]: parentId };
            if (table !== "quote_line_items") {
              delete row.optional;
              delete row.selected;
              delete row.formula;
              delete row.option_id;
              delete row.option_group;
            }
            if (table === "invoice_line_items") delete row.unit_cost;
            // Back on the option it was on (that option may have gone since: then it can't come back).
            const { error } = await supabase().from(table).insert(row as never);
            // A promo line comes back off the draft its discount moved to, but not off an invoice sent since: the database says which.
            if (error) toast.error("Couldn't put the line back", error.code === "22023" ? { description: error.message } : undefined);
            onChanged();
          },
        },
      });
    },
  });

  const totals = useMemo(() => lineSums(shown, { optionId: viewing, shownOptionId, withOptions }), [shown, viewing, shownOptionId, withOptions]);
  const place = offers ? options : null;
  // Without options, a line group's add-ons have the tier words the Client Hub and the paper give them.
  const tiers = useMemo(() => (table === "quote_line_items" && !offers ? optionLabels(lines) : null), [table, offers, lines]);
  const chipOf = (line: Line) => addOnLabel(line, { offers, tier: tiers?.get(line.id) });

  return (
    <div className="lines">
      {editable ? (
        <div role="table" aria-label="Line items" ref={listRef}>
          {/* No column heads over nothing: the empty line below says there are none yet. */}
          {shown.length > 0 && <div className="lines-head" role="row">
            <span role="columnheader">Item</span>
            <span role="columnheader" className="num">Qty</span>
            <span role="columnheader">Unit</span>
            <span role="columnheader" className="num">Price</span>
            <span role="columnheader" className="num">Total</span>
            <span role="columnheader"><span className="sr-only">Actions</span></span>
          </div>}
          {shown.map((line, i) => {
            const actions = (
              <Menu
                triggerClassName="btn btn-sm btn-ghost btn-icon line-more"
                label={`Actions for ${line.name}`}
                title={line.name}
                items={[
                  { label: "Edit", icon: "edit", kbd: "E", hidden: openId === line.id, onSelect: () => setOpenId(line.id) },
                  { label: "Duplicate", icon: "copy", hidden: isPromoLine(table, line), kbd: "D", onSelect: () => duplicate.mutate(line) },
                  { separator: true },
                  { label: "Move up", icon: "chevronUp", disabled: i === 0, onSelect: () => move.mutate({ id: line.id, dir: -1 }) },
                  { label: "Move down", icon: "chevronDown", disabled: i === shown.length - 1, onSelect: () => move.mutate({ id: line.id, dir: 1 }) },
                  { separator: true },
                  { label: "Remove", icon: "trash", danger: true, onSelect: () => remove.mutate(line) },
                ]}
              />
            );
            return openId === line.id ? (
              <LineRow key={line.id} table={table} line={line} withOptions={withOptions} showCosts={showCosts} place={place} viewing={viewing} saveStatus={saveStatus} onChanged={onChanged} onDone={() => setOpenId(null)} actions={actions} rule={ruleOf(line)} drawings={drawings.data} />
            ) : (
              <LineSummary key={line.id} line={line} withOptions={withOptions} shared={offers && line.option_id == null} addOn={chipOf(line)} onOpen={() => setOpenId(line.id)} actions={actions} />
            );
          })}
        </div>
      ) : (
        // As the editable list reads, without a way in: a signed quote, a paid invoice.
        <div role="table" aria-label="Line items">
          {shown.length > 0 && <div className="lines-head lines-head-static" role="row">
            <span role="columnheader">Item</span>
            <span role="columnheader" className="num">Qty</span>
            <span role="columnheader">Unit</span>
            <span role="columnheader" className="num">Price</span>
            <span role="columnheader" className="num">Total</span>
          </div>}
          {shown.map((line) => (
            <LineSummary key={line.id} line={line} withOptions={withOptions} shared={Boolean(place) && line.option_id == null} addOn={chipOf(line)} />
          ))}
        </div>
      )}
      {/* One quiet line (outside the table, which has no row for it), right above the ways to add one. */}
      {shown.length === 0 && <EmptyState inline title={!editable ? "No line items" : offers ? `Nothing on ${viewingName} yet` : "No line items yet"} />}
      {editable && (
        <div className="lines-add">
          <ServicePicker services={services.data ?? []} loading={services.isPending || add.isPending} pending={services.isPending} onPick={(id) => add.mutate(id)} />
          <Button size="sm" variant="ghost" icon="plus" onClick={() => add.mutate(null)} disabled={add.isPending}>Custom item</Button>
          {/* What the options bar offered before there were any: one package to price it from, or two or three side by side. */}
          {onOfferOptions && <Button size="sm" variant="ghost" icon="package" onClick={onOfferOptions}>{lines.length ? "Offer options" : "Pick packages"}</Button>}
          {offers && (
            <div className={`segmented ${styles.addTo}`} role="group" aria-label="New lines go">
              <button type="button" aria-pressed={!addToEvery} onClick={() => setAddToEvery(false)}><span>Only on {viewingName}</span></button>
              <button type="button" aria-pressed={addToEvery} onClick={() => setAddToEvery(true)}><span>On every option</span></button>
            </div>
          )}
          {showCosts && totals.costed && (
            <span className="lines-cost">
              Cost {formatMoneyCents(totals.cost)}
              {totals.price > 0 && (
                <>
                  {" · "}Margin <strong data-tone={totals.price - totals.cost < 0 ? "danger" : undefined}>{Math.round(((totals.price - totals.cost) / totals.price) * 100)}%</strong>
                </>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Add from price list": the price list as a menu with a search field (a sheet on a phone), each
 * service with its category under it and its price on the right. Typing narrows it; the arrow keys
 * go from the field to the services.
 */
function ServicePicker({ services, loading, pending, onPick }: { services: Array<{ id: string; name: string; unit: string; unit_price: number; category: string | null }>; loading: boolean; pending: boolean; onPick: (id: string) => void }) {
  const [term, setTerm] = useState("");
  const words = term.trim().toLowerCase();
  const matches = services.filter((s) => `${s.name} ${s.category ?? ""}`.toLowerCase().includes(words)).slice(0, 50);
  return (
    // Outlined like the other ways to add: the page's next step is its only solid button.
    <Menu
      align="start"
      label="Add from price list"
      title="Price list"
      triggerClassName="btn btn-sm lines-price-list"
      trigger={<>{loading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="list" size={14} />}Add from price list</>}
      search={{ value: term, onChange: setTerm, placeholder: "Search your services", label: "Search services" }}
      footer={pending ? { text: "Loading your price list…" } : !services.length ? { text: "Your price list is empty. Add services in Settings." } : undefined}
      items={matches.map((s) => ({
        label: s.name,
        description: s.category ?? undefined,
        end: `${formatMoneyCents(s.unit_price)}/${s.unit}`,
        onSelect: () => {
          setTerm("");
          onPick(s.id);
        },
      }))}
    />
  );
}

function NumberField({ value, onCommit, onEdit, onUnchanged, label, step = "any", align = "right", prefix, disabled = false, describedBy }: { value: number; onCommit: (v: number) => void; onEdit?: () => void; onUnchanged?: () => void; label: string; step?: string; align?: "right" | "left"; prefix?: string; disabled?: boolean; describedBy?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      onUnchanged?.();
      if (draft.trim() !== "") toast.error(`${label} must be zero or more`);
      return;
    }
    const rounded = step === "0.01" ? Math.round(n * 100) / 100 : Math.round(n * 1000) / 1000;
    if (rounded !== Number(value)) onCommit(rounded);
    else onUnchanged?.();
    setDraft(String(rounded));
  };
  return (
    <span className={prefix ? "input-group" : undefined}>
      {prefix && <span className="addon">{prefix}</span>}
      {/* A quantity has up and down buttons; a price, like MoneyInput, is typed (its column is too narrow for both). */}
      <NumberInput
        steppers={!prefix}
        step="any"
        min={0}
        // How it's shown once left; commit does the rounding that's saved.
        decimals={step === "0.01" ? 2 : 3}
        aria-label={label}
        aria-describedby={describedBy}
        inputMode="decimal"
        disabled={disabled}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value.replace(/[^0-9.]/g, ""));
          onEdit?.();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          // Never below zero, so a minus sign isn't typed at all.
          if (e.key === "-") e.preventDefault();
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        onFocus={(e) => e.target.select()}
        style={{ textAlign: align, paddingLeft: prefix ? 22 : undefined }}
      />
    </span>
  );
}

/**
 * The chip on an add-on, and whether it's picked. On a quote that offers options (`offers`), add-ons
 * the client picks one of (a line group) say "Pick one": Good, Better and Best are the options there.
 * Otherwise a group's add-on has the tier word the Client Hub and the paper give it (`tier`, core
 * optionLabels), and any other add-on is "Optional".
 */
export const addOnLabel = (line: Pick<Line, "optional" | "selected" | "option_group">, { offers = false, tier }: { offers?: boolean; tier?: string | null } = {}) =>
  line.optional ? `${offers && line.option_group ? "Pick one" : (tier ?? "Optional")}${line.selected ? " · chosen" : ""}` : null;

/** A line as it reads to the office: click anywhere on it to edit. `shared`: on every option of a quote that offers options. `addOn`: its add-on chip (addOnLabel). */
function LineSummary({ line, withOptions, shared, addOn, onOpen, actions }: { line: Line; withOptions: boolean; shared: boolean; addOn: string | null; onOpen?: () => void; actions?: React.ReactNode }) {
  const excluded = withOptions && line.optional && !line.selected;
  // Rounded to the cent as the database rounds it (1.5 × $0.35 is $0.53).
  const amount = lineTotal(line.quantity, line.unit_price);
  const qty = formatNumber(Number(line.quantity), Number(line.quantity) % 1 ? 2 : 0);
  // Read only, each part is a cell of its own; to edit, the whole line is one button.
  const cell = onOpen ? undefined : "cell";
  const parts = (
    <>
      <span className="name-cell" role={cell}>
        <strong>{line.name}</strong>
        {(addOn || shared || !line.taxable) && (
          <span className="line-tags">
            {addOn && <span className="tag">{addOn}</span>}
            {shared && <span className="tag">On every option</span>}
            {!line.taxable && <span className="tag">No tax</span>}
          </span>
        )}
        {line.description && <span className={cx("line-desc", onOpen ? "ellipsis-2" : "pre-wrap")}>{line.description}</span>}
      </span>
      <span className="num line-qty" role={cell}>{qty}</span>
      <span className="line-unit" role={cell}>{line.unit}</span>
      <span className="num line-price" role={cell}>{formatMoneyCents(line.unit_price)}</span>
      <span className="num total" role={cell}>{excluded ? <span className="line-out">Not included</span> : formatMoneyCents(amount)}</span>
    </>
  );
  if (!onOpen) {
    return (
      <div className="line-view line-static" role="row" data-excluded={excluded || undefined}>
        <div className="line-open" role="none">{parts}</div>
      </div>
    );
  }
  return (
    <div className="line-view" role="row" data-excluded={excluded || undefined}>
      <div role="cell">
        <button type="button" className="line-open" onClick={onOpen} aria-label={`Edit ${line.name}`}>{parts}</button>
      </div>
      <div role="cell">{actions}</div>
    </div>
  );
}

/**
 * A line open for editing, its fields in a row. `place`: the quote's options,
 * when it offers them, for where the line is; `viewing` is the option looked at. `saveStatus`: the
 * page header's, which each save reports to.
 */
function LineRow({ table, line, withOptions, showCosts, place, viewing, saveStatus, onChanged, onDone, actions, rule = null, drawings = [] }: {
  table: Table;
  line: Line;
  withOptions: boolean;
  showCosts: boolean;
  place: ReadonlyArray<{ id: string; name: string }> | null;
  viewing: string | null;
  saveStatus?: SaveStatusHandle;
  onChanged: () => void;
  onDone?: () => void;
  actions?: React.ReactNode;
  /** Its price-list rule, when a size is all it needs (sizedBy). */
  rule?: SizeRule | null;
  /** The property's drawings with an area, to price it from. */
  drawings?: ReadonlyArray<{ id: string; title: string; total_area_sqft: number }>;
}) {
  const [draft, setDraft] = useState(line);
  useEffect(() => setDraft(line), [line]);
  const promoHint = useId();
  const promo = isPromoLine(table, line);
  const save = useMutation({
    // With a save status in the header, a failure says so there instead of in a toast, unless it
    // was turned down (an approved quote's lines, say): then the toast says why, as trying again won't help.
    meta: { inline: Boolean(saveStatus) },
    mutationFn: async (patch: Partial<Line>) => unwrap(await supabase().from(table).update(patch as never).eq("id", line.id)),
    onSuccess: onChanged,
    onError: (error) => {
      setDraft(line);
      if (saveStatus && !isNetworkError(error) && !isAuthError(error) && !(error instanceof ApiError && isRestarting(error.status))) toast.error(errorMessage(error));
    },
  });
  // Moved onto another option, the line leaves this list: the toast says where it went.
  const moveTo = useMutation({
    meta: { success: (_: unknown, optionId: string | null) => (optionId && optionId !== viewing ? `Moved to ${place?.find((o) => o.id === optionId)?.name ?? "the other option"}` : null), tone: TONES[table] },
    mutationFn: async (optionId: string | null) => unwrap(await supabase().from(table).update({ option_id: optionId } as never).eq("id", line.id)),
    onSuccess: onChanged,
    onError: () => setDraft(line),
  });
  const persist = (patch: Partial<Line>) => (saveStatus ? void saveStatus.track(save.mutateAsync(patch)) : save.mutate(patch));
  const edited = () => saveStatus?.edited();
  // A field left as it was takes back its "Edited".
  const unchanged = () => saveStatus?.status === "edited" && saveStatus.reset();
  const set = (patch: Partial<Line>) => {
    setDraft({ ...draft, ...patch });
    persist(patch);
  };
  const commitText = (key: "name" | "unit" | "description") => () => {
    const value = (draft[key] ?? "").toString().trim();
    if (key === "name" && !value) {
      setDraft({ ...draft, name: line.name });
      unchanged();
      toast.error("A line item needs a name");
      return;
    }
    if (key === "unit" && !value) {
      unchanged();
      return setDraft({ ...draft, unit: line.unit });
    }
    if (value !== (line[key] ?? "")) persist({ [key]: key === "description" ? value || null : value } as Partial<Line>);
    else unchanged();
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  // Priced by its size: the rule's price (or quantity) for that many square feet, saved like one typed.
  const [size, setSize] = useState("");
  const sized = useRef("");
  const bySize = (text: string) => {
    sized.current = text;
    if (!(Number(text) > 0)) return;
    try {
      set(sizedPatch(rule!, Number(text)));
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  const excluded = withOptions && line.optional && !line.selected;
  const amount = lineTotal(draft.quantity, draft.unit_price);


  return (
    <div className="line-edit" role="row" data-excluded={excluded || undefined} data-saving={save.isPending || undefined}>
      <div className="name-cell" role="cell">
        <input className="input" aria-label="Item name" value={draft.name} maxLength={200} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); edited(); }} onBlur={commitText("name")} onKeyDown={blurOnEnter} autoFocus={Boolean(onDone)} onFocus={(e) => line.name === "New item" && e.target.select()} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Qty</span>
        <NumberField label="Quantity" value={Number(draft.quantity)} disabled={promo} describedBy={promo ? promoHint : undefined} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ quantity: v })} />
      </div>
      <div role="cell"><span className="cell-label" aria-hidden="true">Unit</span>
        <input className="input" aria-label="Unit" value={draft.unit} maxLength={20} onChange={(e) => { setDraft({ ...draft, unit: e.target.value }); edited(); }} onBlur={commitText("unit")} onKeyDown={blurOnEnter} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Price</span>
        <NumberField label="Unit price" step="0.01" prefix={currencySymbol()} value={Number(draft.unit_price)} disabled={promo} describedBy={promo ? promoHint : undefined} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ unit_price: v })} />
      </div>
      <div className="total" role="cell"><span className="cell-label">Total</span>{excluded ? <span className="line-out">Not included</span> : formatMoneyCents(amount)}</div>
      <div role="cell" className="line-edit-actions">{actions}</div>
      <div className="wide-cell" role="cell">
        <textarea
          className="textarea"
          aria-label="Description"
          placeholder="Description the client will see (optional)"
          value={draft.description ?? ""}
          maxLength={4000}
          onChange={(e) => {
            setDraft({ ...draft, description: e.target.value });
            edited();
          }}
          onBlur={commitText("description")}
          style={{ minHeight: 38, fontSize: 13 }}
          rows={1}
        />
        <div className="opts">
          {promo && <span id={promoHint} className="muted">{promoCodeOf(line.name) ? `Set by promo code ${promoCodeOf(line.name)}.` : "Set by a promo code."} To take it off, remove the line.</span>}
          {place && (
            <Select
              className="select input-sm"
              style={{ width: "auto", maxWidth: "100%", fontSize: 12 }}
              aria-label="Which options it's on"
              value={draft.option_id ?? ""}
              disabled={moveTo.isPending}
              onChange={(e) => {
                const optionId = e.target.value || null;
                setDraft({ ...draft, option_id: optionId });
                moveTo.mutate(optionId);
              }}
            >
              <option value="">On every option</option>
              {place.map((o) => <option key={o.id} value={o.id}>{placeName(o.id, place)}</option>)}
            </Select>
          )}
          {withOptions && (
            <label>
              <input type="checkbox" checked={Boolean(draft.optional)} onChange={(e) => set({ optional: e.target.checked, selected: !e.target.checked })} />
              {draft.option_group ? "Optional (client picks one)" : "Optional (client chooses)"}
            </label>
          )}
          <label>
            <input type="checkbox" checked={draft.taxable} onChange={(e) => set({ taxable: e.target.checked })} />
            Taxable
          </label>
          {showCosts && (
            <label style={{ gap: 6 }}>
              Unit cost
              <span style={{ width: 96 }}><NumberField label="Unit cost" step="0.01" prefix={currencySymbol()} value={Number(draft.unit_cost ?? 0)} onEdit={edited} onUnchanged={unchanged} onCommit={(v) => set({ unit_cost: v })} /></span>
            </label>
          )}
          {rule && !promo ? (
            <>
              <label style={{ gap: 6 }} title={`${rule.target === "unit_price" ? "Price" : "Quantity"} = ${rule.formula}`}>
                {rule.target === "unit_price" ? "Price by size" : "Quantity by size"}
                <span className="input-group" style={{ width: 132 }}>
                  <DecimalInput className="input input-sm" aria-label="Size in square feet" inputMode="decimal" value={size} onChange={(e) => setSize(e.target.value.replace(/[^0-9.]/g, ""))} onBlur={() => size !== sized.current && bySize(size)} onKeyDown={blurOnEnter} />
                  <span className="addon addon-right addon-unit">sq ft</span>
                </span>
              </label>
              {drawings.map((d) => (
                <Button key={d.id} size="sm" onClick={() => { setSize(String(Number(d.total_area_sqft))); bySize(String(Number(d.total_area_sqft))); }}>
                  {d.title}: {formatNumber(Number(d.total_area_sqft), 0)} sq ft
                </Button>
              ))}
            </>
          ) : (
            draft.formula && <span className="muted" title="Fills from a measurement">Formula: {draft.formula}</span>
          )}
          {onDone && <Button size="sm" style={{ marginLeft: "auto" }} onClick={onDone}>Done</Button>}
        </div>
      </div>
    </div>
  );
}
