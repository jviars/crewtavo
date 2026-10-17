/**
 * Line items, shared by quotes, jobs and invoices. They read like a simple table; clicking a row opens
 * it for editing (one at a time). Each field saves when it loses focus (or on Enter); totals are
 * recalculated by Postgres triggers, so the parent just refetches. Removing a line can be undone.
 */
import { lineTotal } from "@crewtavo/core/money";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { formatMoneyCents, formatNumber } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";

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
}

const COPY_FIELDS = ["name", "description", "quantity", "unit", "unit_price", "taxable", "service_id"] as const;

export function LineItems({
  table,
  parent,
  parentId,
  lines,
  editable,
  onChanged,
  withOptions = false,
}: {
  table: Table;
  parent: Parent;
  parentId: string;
  lines: Line[];
  editable: boolean;
  onChanged: () => void;
  withOptions?: boolean;
}) {
  const session = useSession();
  const { company } = session;
  const listRef = useListAnimation<HTMLDivElement>();
  const showCosts = hasRole(session, "admin", "office", "estimator") && can(session, "job_costs") && table !== "invoice_line_items";
  const services = useQuery({
    queryKey: ["services", company.id],
    enabled: editable,
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, description, unit, unit_price, unit_cost, taxable, formula, category").eq("company_id", company.id).eq("active", true).order("sort")),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const insert = async (rows: Array<Record<string, unknown>>) => {
    const base = (lines.at(-1)?.sort ?? -1) + 1;
    const created = unwrap(await supabase().from(table).insert(rows.map((row, i) => ({ ...row, company_id: company.id, [parent]: parentId, sort: base + i })) as never).select("id")) as Array<{ id: string }>;
    return created[0]?.id ?? null;
  };

  const add = useMutation({
    mutationFn: async (serviceId: string | null) => {
      const s = services.data?.find((x) => x.id === serviceId);
      const row: Record<string, unknown> = s
        ? { service_id: s.id, name: s.name, description: s.description, unit: s.unit, unit_price: s.unit_price, taxable: s.taxable, quantity: 1 }
        : { name: "New item", quantity: 1, unit: "ea", unit_price: 0 };
      if (table !== "invoice_line_items" && s) row.unit_cost = s.unit_cost;
      if (table === "quote_line_items" && s) row.formula = s.formula;
      return { id: await insert([row]), custom: !s };
    },
    // A custom item opens for editing right away; a price-list item is ready as it is.
    onSuccess: (r) => {
      if (r.custom) setOpenId(r.id);
      onChanged();
    },
  });

  const move = useMutation({
    mutationFn: async ({ id, dir }: { id: string; dir: -1 | 1 }) => {
      const index = lines.findIndex((l) => l.id === id);
      const other = lines[index + dir];
      if (!other) return;
      // Renumber so equal sort values (old data) can't block a move.
      const order = lines.map((l) => l.id);
      [order[index], order[index + dir]] = [order[index + dir], order[index]];
      await Promise.all(order.map((lineId, i) => supabase().from(table).update({ sort: i } as never).eq("id", lineId)));
    },
    onSuccess: onChanged,
  });

  const duplicate = useMutation({
    meta: { success: "Line duplicated" },
    mutationFn: async (line: Line) => {
      const row: Record<string, unknown> = Object.fromEntries(COPY_FIELDS.map((k) => [k, line[k] ?? null]));
      if (table !== "invoice_line_items") row.unit_cost = line.unit_cost ?? null;
      if (table === "quote_line_items") Object.assign(row, { optional: line.optional ?? false, selected: line.selected ?? true, formula: line.formula ?? null });
      setOpenId(await insert([row]));
    },
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: async (line: Line) => {
      unwrap(await supabase().from(table).delete().eq("id", line.id));
      return line;
    },
    onSuccess: (line) => {
      onChanged();
      toast.success(`Removed “${line.name}”`, {
        action: {
          label: "Undo",
          onClick: async () => {
            const { id: _id, ...rest } = line;
            const row: Record<string, unknown> = { ...rest, company_id: company.id, [parent]: parentId };
            if (table !== "quote_line_items") {
              delete row.optional;
              delete row.selected;
              delete row.formula;
            }
            if (table === "invoice_line_items") delete row.unit_cost;
            const { error } = await supabase().from(table).insert(row as never);
            if (error) toast.error("Couldn't restore that line.");
            onChanged();
          },
        },
      });
    },
  });

  const totals = useMemo(() => {
    const included = lines.filter((l) => !(withOptions && l.optional && !l.selected));
    const price = included.reduce((s, l) => s + lineTotal(l.quantity, l.unit_price), 0);
    const cost = included.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost ?? 0), 0);
    const costed = included.some((l) => l.unit_cost != null && Number(l.unit_cost) > 0);
    return { price, cost, costed };
  }, [lines, withOptions]);

  return (
    <div className="card">
      {editable ? (
        <div role="table" aria-label="Line items" ref={listRef}>
          <div className="lines-head" role="row">
            <span role="columnheader">Item</span>
            <span role="columnheader" className="num">Qty</span>
            <span role="columnheader">Unit</span>
            <span role="columnheader" className="num">Price</span>
            <span role="columnheader" className="num">Total</span>
            <span role="columnheader"><span className="sr-only">Actions</span></span>
          </div>
          {lines.length === 0 && <EmptyState compact icon="list" title="No line items yet" />}
          {lines.map((line, i) => {
            const actions = (
              <Menu
                triggerClassName="btn btn-sm btn-ghost btn-icon"
                label={`Actions for ${line.name}`}
                items={[
                  { label: "Edit", icon: "edit", hidden: openId === line.id, onSelect: () => setOpenId(line.id) },
                  { label: "Move up", icon: "chevronUp", disabled: i === 0, onSelect: () => move.mutate({ id: line.id, dir: -1 }) },
                  { label: "Move down", icon: "chevronDown", disabled: i === lines.length - 1, onSelect: () => move.mutate({ id: line.id, dir: 1 }) },
                  { label: "Duplicate", icon: "copy", onSelect: () => duplicate.mutate(line) },
                  { separator: true },
                  { label: "Remove", icon: "trash", danger: true, onSelect: () => remove.mutate(line) },
                ]}
              />
            );
            return openId === line.id ? (
              <LineRow key={line.id} table={table} line={line} editable withOptions={withOptions} showCosts={showCosts} onChanged={onChanged} onDone={() => setOpenId(null)} actions={actions} />
            ) : (
              <LineSummary key={line.id} line={line} withOptions={withOptions} onOpen={() => setOpenId(line.id)} actions={actions} />
            );
          })}
        </div>
      ) : (
        <table className="table table-stack">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num" style={{ width: 90 }}>Qty</th>
              <th style={{ width: 80 }}>Unit</th>
              <th className="num" style={{ width: 110 }}>Price</th>
              <th className="num" style={{ width: 120 }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={5} className="muted">No items.</td></tr>}
            {lines.map((line) => (
              <LineRow key={line.id} table={table} line={line} editable={false} withOptions={withOptions} showCosts={false} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="card-pad row wrap" style={{ borderTop: "1px solid var(--divider)", paddingTop: 14, paddingBottom: 14 }}>
          <ServicePicker services={services.data ?? []} loading={services.isPending || add.isPending} onPick={(id) => add.mutate(id)} />
          <Button icon="plus" onClick={() => add.mutate(null)} disabled={add.isPending}>Custom item</Button>
          {showCosts && totals.costed && (
            <span className="muted small" style={{ marginLeft: "auto" }}>
              Cost {formatMoneyCents(totals.cost)} · Margin <strong style={{ color: totals.price - totals.cost < 0 ? "var(--danger)" : "var(--ink)" }}>{totals.price > 0 ? `${Math.round(((totals.price - totals.cost) / totals.price) * 100)}%` : "—"}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** "Add from price list": a searchable list of services. */
function ServicePicker({ services, loading, onPick }: { services: Array<{ id: string; name: string; unit: string; unit_price: number; category: string | null }>; loading: boolean; onPick: (id: string) => void }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [index, setIndex] = useState(0);
  const matches = services.filter((s) => `${s.name} ${s.category ?? ""}`.toLowerCase().includes(term.trim().toLowerCase())).slice(0, 50);

  useEffect(() => {
    const p = panel.current;
    if (!p) return;
    const onToggle = (e: Event) => {
      if ((e as Event & { newState: string }).newState !== "open") return;
      const r = button.current!.getBoundingClientRect();
      const below = r.bottom + 6 + 340 < window.innerHeight;
      p.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8))}px`;
      // Opening upward: anchor the bottom edge so the panel stays next to the button as results shrink.
      p.style.top = below ? `${r.bottom + 6}px` : "auto";
      p.style.bottom = below ? "auto" : `${window.innerHeight - r.top + 6}px`;
      setTerm("");
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    };
    p.addEventListener("toggle", onToggle);
    return () => p.removeEventListener("toggle", onToggle);
  }, []);

  const pick = (serviceId: string) => {
    panel.current?.hidePopover();
    onPick(serviceId);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(matches.length - 1, i + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    if (e.key === "Enter" && matches[index]) { e.preventDefault(); pick(matches[index].id); }
  };

  return (
    <>
      <button ref={button} type="button" className="btn btn-primary" popovertarget={id} disabled={loading && !services.length}>
        {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : <Icon name="list" size={16} />}
        Add from price list
      </button>
      <div ref={panel} id={id} popover="auto" className="menu" style={{ width: 360, maxWidth: "calc(100vw - 16px)", padding: 0 }}>
        <div className="input-group" style={{ padding: 8, borderBottom: "1px solid var(--divider)" }}>
          <span className="addon" style={{ left: 18 }}><Icon name="search" size={15} /></span>
          <input ref={input} className="input input-sm" value={term} onChange={(e) => { setTerm(e.target.value); setIndex(0); }} onKeyDown={onKeyDown} placeholder="Search your services" aria-label="Search services" />
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto", padding: 4 }} role="listbox">
          {matches.length === 0 && <div className="empty" style={{ padding: 16 }}>{services.length ? "No services match." : "Your price list is empty. Add services in Settings."}</div>}
          {matches.map((s, i) => (
            <button key={s.id} type="button" role="option" aria-selected={i === index} className="menu-item" style={{ height: "auto", padding: "8px 10px", background: i === index ? "var(--fill-2)" : undefined }} onMouseMove={() => setIndex(i)} onClick={() => pick(s.id)}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: "block" }}>{s.name}</span>
                {s.category && <span className="muted small">{s.category}</span>}
              </span>
              <span className="muted small tabular">{formatMoneyCents(s.unit_price)}/{s.unit}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function NumberField({ value, onCommit, label, step = "any", align = "right", prefix }: { value: number; onCommit: (v: number) => void; label: string; step?: string; align?: "right" | "left"; prefix?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0) {
      setDraft(String(value));
      if (draft.trim() !== "") toast.error(`${label} must be zero or more.`);
      return;
    }
    const rounded = step === "0.01" ? Math.round(n * 100) / 100 : Math.round(n * 1000) / 1000;
    if (rounded !== Number(value)) onCommit(rounded);
    setDraft(String(rounded));
  };
  return (
    <span className={prefix ? "input-group" : undefined}>
      {prefix && <span className="addon">{prefix}</span>}
      <input
        className="input"
        aria-label={label}
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        onFocus={(e) => e.target.select()}
        style={{ textAlign: align, paddingLeft: prefix ? 22 : undefined }}
      />
    </span>
  );
}

/** A line as it reads to the office: click anywhere on it to edit. */
function LineSummary({ line, withOptions, onOpen, actions }: { line: Line; withOptions: boolean; onOpen: () => void; actions: React.ReactNode }) {
  const excluded = withOptions && line.optional && !line.selected;
  // Rounded to the cent as the database rounds it (1.5 × $0.35 is $0.53).
  const amount = lineTotal(line.quantity, line.unit_price);
  const qty = formatNumber(Number(line.quantity), Number(line.quantity) % 1 ? 2 : 0);
  return (
    <div className="line-view" role="row" data-excluded={excluded || undefined}>
      <div role="cell">
        <button type="button" className="line-open" onClick={onOpen} aria-label={`Edit ${line.name}`}>
          <span className="name-cell">
            <strong>{line.name}</strong>
            {line.optional && <span className="chip" style={{ marginLeft: 6 }}>{line.selected ? "Optional · chosen" : "Optional"}</span>}
            {!line.taxable && <span className="chip" style={{ marginLeft: 6 }}>No tax</span>}
            {line.description && <span className="muted small ellipsis-2" style={{ display: "block" }}>{line.description}</span>}
          </span>
          <span className="num">{qty}</span>
          <span>{line.unit}</span>
          <span className="num">{formatMoneyCents(line.unit_price)}</span>
          <span className="num total">{excluded ? <span className="muted">Not included</span> : formatMoneyCents(amount)}</span>
        </button>
      </div>
      <div role="cell">{actions}</div>
    </div>
  );
}

function LineRow({ table, line, editable, withOptions, showCosts, onChanged, onDone, actions }: { table: Table; line: Line; editable: boolean; withOptions: boolean; showCosts: boolean; onChanged: () => void; onDone?: () => void; actions?: React.ReactNode }) {
  const [draft, setDraft] = useState(line);
  useEffect(() => setDraft(line), [line]);
  const save = useMutation({
    mutationFn: async (patch: Partial<Line>) => unwrap(await supabase().from(table).update(patch as never).eq("id", line.id)),
    onSuccess: onChanged,
    onError: () => setDraft(line),
  });
  const set = (patch: Partial<Line>) => {
    setDraft({ ...draft, ...patch });
    save.mutate(patch);
  };
  const commitText = (key: "name" | "unit" | "description") => () => {
    const value = (draft[key] ?? "").toString().trim();
    if (key === "name" && !value) {
      setDraft({ ...draft, name: line.name });
      toast.error("A line item needs a name.");
      return;
    }
    if (key === "unit" && !value) return setDraft({ ...draft, unit: line.unit });
    if (value !== (line[key] ?? "")) save.mutate({ [key]: key === "description" ? value || null : value } as Partial<Line>);
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && e.currentTarget.blur();
  const excluded = withOptions && line.optional && !line.selected;
  const amount = lineTotal(draft.quantity, draft.unit_price);

  if (!editable) {
    return (
      <tr style={excluded ? { opacity: 0.55 } : undefined}>
        <td>
          <strong>{line.name}</strong>
          {line.optional && <span className="chip" style={{ marginLeft: 6 }}>{line.selected ? "Optional · chosen" : "Optional"}</span>}
          {line.description && <div className="muted small pre-wrap">{line.description}</div>}
        </td>
        <td className="num">{formatNumber(Number(line.quantity), Number(line.quantity) % 1 ? 2 : 0)}</td>
        <td>{line.unit}</td>
        <td className="num">{formatMoneyCents(line.unit_price)}</td>
        <td className="num">{excluded ? <span className="muted">—</span> : formatMoneyCents(amount)}</td>
      </tr>
    );
  }

  return (
    <div className="line-edit" role="row" data-excluded={excluded || undefined} data-saving={save.isPending || undefined}>
      <div className="name-cell" role="cell">
        <input className="input" aria-label="Item name" value={draft.name} maxLength={200} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onBlur={commitText("name")} onKeyDown={blurOnEnter} style={{ fontWeight: 700 }} autoFocus={Boolean(onDone)} onFocus={(e) => line.name === "New item" && e.target.select()} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Qty</span>
        <NumberField label="Quantity" value={Number(draft.quantity)} onCommit={(v) => set({ quantity: v })} />
      </div>
      <div role="cell"><span className="cell-label" aria-hidden="true">Unit</span>
        <input className="input" aria-label="Unit" value={draft.unit} maxLength={20} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} onBlur={commitText("unit")} onKeyDown={blurOnEnter} />
      </div>
      <div className="num" role="cell"><span className="cell-label" aria-hidden="true">Price</span>
        <NumberField label="Unit price" step="0.01" prefix="$" value={Number(draft.unit_price)} onCommit={(v) => set({ unit_price: v })} />
      </div>
      <div className="total" role="cell"><span className="cell-label">Total</span>{excluded ? <span className="muted">Not included</span> : formatMoneyCents(amount)}</div>
      <div role="cell" style={{ paddingTop: 3 }}>{actions}</div>
      <div className="wide-cell" role="cell">
        <textarea
          className="textarea"
          aria-label="Description"
          placeholder="Description the client will see (optional)"
          value={draft.description ?? ""}
          maxLength={4000}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          onBlur={commitText("description")}
          style={{ minHeight: 38, fontSize: 13 }}
          rows={1}
        />
        <div className="opts">
          {withOptions && (
            <label>
              <input type="checkbox" checked={Boolean(draft.optional)} onChange={(e) => set({ optional: e.target.checked, selected: !e.target.checked })} />
              Optional (client chooses)
            </label>
          )}
          <label>
            <input type="checkbox" checked={draft.taxable} onChange={(e) => set({ taxable: e.target.checked })} />
            Taxable
          </label>
          {showCosts && (
            <label style={{ gap: 6 }}>
              Unit cost
              <span style={{ width: 96 }}><NumberField label="Unit cost" step="0.01" prefix="$" value={Number(draft.unit_cost ?? 0)} onCommit={(v) => set({ unit_cost: v })} /></span>
            </label>
          )}
          {draft.formula && <span className="muted" title="Fills from a measurement">Formula: {draft.formula}</span>}
          {onDone && <Button size="sm" variant="primary" style={{ marginLeft: "auto" }} onClick={onDone}>Done</Button>}
        </div>
      </div>
    </div>
  );
}
