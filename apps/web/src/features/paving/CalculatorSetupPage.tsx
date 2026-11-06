/**
 * Paving → Calculator → Set up: what a business's calculator prices and how, for an owner or admin.
 * Its items (named the way the business names them, each figured one of the BASES ways, with
 * dropdown choices where it has them), how it takes profit, what it adds for waste, and its job
 * types (made on the calculator with Save as a job type, renamed or taken out here). Saved to
 * companies.settings.paving_calculator; worksheets already made keep the setup they were priced with.
 */
import { useMutation } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { hasRole, useSession } from "@/lib/session";
import { BASES, BASIS_IDS, DEFAULT_SETUP, DEFAULT_WEIGHT, fromArea, parseSetup, sectionsOf, setupFrom, type Basis, type CalcItem, type CalcSetup, type ProfitBy } from "./calculator";
import { NumberBox } from "./NumberBox";

const PROFIT_WAYS: Array<{ id: ProfitBy; label: string }> = [
  { id: "day", label: "By the day" },
  { id: "percent", label: "% of cost" },
  { id: "none", label: "None" },
];

/** An item after its way of figuring changed: only the extras that way uses. */
function normalized(item: CalcItem): CalcItem {
  const { weight, choices, crew, ...rest } = item;
  return {
    ...rest,
    ...(item.basis === "depth" ? { weight: weight || DEFAULT_WEIGHT } : {}),
    ...(fromArea(item.basis) && choices?.length ? { choices } : {}),
    ...(item.basis === "days" && crew ? { crew } : {}),
  };
}

export function CalculatorSetupPage() {
  const session = useSession();
  const { company } = session;
  const listId = useId();
  const saved = useMemo(() => setupFrom(company.settings), [company.settings]);
  const [setup, setSetup] = useState<CalcSetup>(saved);
  // Never saved: the sample is what's showing, and saving it as it is makes it the business's own.
  const firstTime = (company.settings as Record<string, unknown> | null)?.paving_calculator === undefined;
  const changed = firstTime || JSON.stringify(setup) !== JSON.stringify(saved);

  const save = useMutation({
    meta: { success: "Saved. New estimates use this setup." },
    mutationFn: async () => {
      // Read the settings fresh, so a change someone made meanwhile isn't undone.
      const current = (unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings ?? {}) as Record<string, unknown>;
      // Through the same reading the calculator does, so what's saved is what it prices.
      const clean = parseSetup({ ...setup, items: setup.items.map((i) => ({ ...i, name: i.name.trim() || "Item", section: i.section.trim() || "Other" })) });
      unwrap(await supabase().from("companies").update({ settings: { ...current, paving_calculator: clean } as never }).eq("id", company.id));
      await session.refresh();
      setSetup(clean);
    },
  });

  if (!hasRole(session, "admin")) {
    return (
      <>
        <BackLink to="/paving/calculator">Paving calculator</BackLink>
        <EmptyState icon="lock" title="An owner or admin sets up the calculator">Ask them to add or change its items and prices.</EmptyState>
      </>
    );
  }

  const setItem = (id: string, change: Partial<CalcItem>) => setSetup((s) => ({ ...s, items: s.items.map((i) => (i.id === id ? normalized({ ...i, ...change }) : i)) }));
  const move = (index: number, by: -1 | 1) =>
    setSetup((s) => {
      const items = [...s.items];
      const to = index + by;
      if (to < 0 || to >= items.length) return s;
      [items[index], items[to]] = [items[to], items[index]];
      return { ...s, items };
    });
  const remove = (id: string) =>
    setSetup((s) => ({
      ...s,
      items: s.items.filter((i) => i.id !== id),
      jobs: s.jobs.map((j) => ({ ...j, values: Object.fromEntries(Object.entries(j.values).filter(([key]) => key !== id)) })),
    }));
  const add = () =>
    setSetup((s) => ({
      ...s,
      items: [...s.items, { id: `item-${crypto.randomUUID().slice(0, 8)}`, name: "", section: sectionsOf(s).at(-1) ?? "Materials", basis: "depth", price: 0, weight: DEFAULT_WEIGHT }],
    }));
  const names = new Map(setup.items.map((i) => [i.id, i]));

  return (
    <>
      <BackLink to="/paving/calculator">Paving calculator</BackLink>
      <PageHeader title="Calculator setup" actions={<Button variant="primary" icon="check" disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <p className="page-subtitle">What your calculator prices, what you call it and how each amount is figured. Worksheets already made keep the setup they were priced with.</p>
      {firstTime && (
        <div className="callout callout-info calc-first" role="note">
          <Icon name="info" size={20} />
          <span className="grow small" style={{ color: "var(--ink)" }}>
            <strong>These are sample prices. Set your own.</strong> Go down the list and put in what you pay per ton and per gallon, your crew's day rate, and trucking and mobilization if you charge them. Rename anything you call by another name, take out what you don't use, then save.
          </span>
        </div>
      )}

      <div className="stack" style={{ gap: 16, maxWidth: 1080 }}>
        <section className="card" aria-labelledby="setup-items">
          <div className="card-head"><h2 id="setup-items">Items</h2><span className="muted small">{setup.items.length} items</span></div>
          <datalist id={listId}>{sectionsOf(setup).map((s) => <option key={s} value={s} />)}</datalist>
          {setup.items.map((item, i) => (
            <div key={item.id} className="calc-setup-item">
              <label className="field">
                <span>Name</span>
                <input className="input" value={item.name} maxLength={80} placeholder="Crusher run" onChange={(e) => setItem(item.id, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>Section</span>
                <input className="input" list={listId} value={item.section} maxLength={40} onChange={(e) => setItem(item.id, { section: e.target.value })} />
              </label>
              <label className="field">
                <span>How it's figured</span>
                <select className="select" value={item.basis} onChange={(e) => setItem(item.id, { basis: e.target.value as Basis })}>
                  {BASIS_IDS.map((b) => <option key={b} value={b}>{BASES[b].label}</option>)}
                </select>
              </label>
              <div className="field">
                <span>Price</span>
                <span className="row" style={{ gap: 6 }}>
                  <NumberBox label={`${item.name || "Item"} price`} value={item.price} onChange={(price) => setItem(item.id, { price })} prefix="$" width={110} />
                  <span className="muted small">/{BASES[item.basis].unit}</span>
                </span>
              </div>
              <div className="row calc-setup-tools">
                <button type="button" className="icon-btn" aria-label={`Move ${item.name || "item"} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronUp" size={16} /></button>
                <button type="button" className="icon-btn" aria-label={`Move ${item.name || "item"} down`} disabled={i === setup.items.length - 1} onClick={() => move(i, 1)}><Icon name="chevronDown" size={16} /></button>
                <button type="button" className="icon-btn" aria-label={`Take out ${item.name || "item"}`} onClick={() => remove(item.id)}><Icon name="trash" size={16} /></button>
              </div>
              <ItemExtras item={item} onChange={(change) => setItem(item.id, change)} />
            </div>
          ))}
          <div className="card-pad"><Button icon="plus" onClick={add}>Add an item</Button></div>
        </section>

        <section className="card card-pad stack" aria-labelledby="setup-profit" style={{ gap: 14 }}>
          <h2 id="setup-profit" className="section-title" style={{ fontSize: 16 }}>Profit, minimum and waste</h2>
          <div className="row wrap" style={{ gap: 12 }}>
            <div className="segmented" role="group" aria-label="How to take profit">
              {PROFIT_WAYS.map((w) => <button key={w.id} type="button" aria-pressed={setup.profit.by === w.id} onClick={() => setSetup((s) => ({ ...s, profit: { ...s.profit, by: w.id } }))}>{w.label}</button>)}
            </div>
            {setup.profit.by !== "none" && (
              <span className="row" style={{ gap: 6 }}>
                <NumberBox label={setup.profit.by === "day" ? "Profit per day" : "Profit percent of cost"} value={setup.profit.amount} onChange={(amount) => setSetup((s) => ({ ...s, profit: { ...s.profit, amount } }))} prefix={setup.profit.by === "day" ? "$" : undefined} width={120} />
                <span className="muted small">{setup.profit.by === "day" ? "for each crew day" : "% of the cost"}</span>
              </span>
            )}
            {setup.profit.by === "none" && <span className="muted small">Your prices already have the profit in them.</span>}
          </div>
          <span className="row wrap" style={{ gap: 8 }}>
            <NumberBox label="Minimum charge" value={setup.minimum} onChange={(minimum) => setSetup((s) => ({ ...s, minimum }))} prefix="$" width={120} />
            <span className="muted small">minimum charge: a smaller job is brought up to this (0 for none)</span>
          </span>
          <span className="row wrap" style={{ gap: 8 }}>
            <NumberBox label="Extra for waste, percent" value={setup.waste} onChange={(waste) => setSetup((s) => ({ ...s, waste: Math.min(waste, 100) }))} width={72} />
            <span className="muted small">% extra on tons and gallons, before they're rounded up to whole ones</span>
          </span>
        </section>

        <section className="card" aria-labelledby="setup-jobs">
          <div className="card-head"><h2 id="setup-jobs">Job types</h2></div>
          {setup.jobs.map((job) => (
            <div key={job.id} className="card-row" style={{ gap: 12 }}>
              <input className="input" style={{ maxWidth: 260 }} aria-label="Job type name" value={job.name} maxLength={80} onChange={(e) => setSetup((s) => ({ ...s, jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, name: e.target.value } : j)) }))} />
              <span className="muted small grow">
                {Object.entries(job.values).map(([id, v]) => `${names.get(id)?.name ?? "Taken-out item"} ${v}`).join(" · ") || "Nothing filled in"}
              </span>
              <button type="button" className="icon-btn" aria-label={`Take out ${job.name}`} onClick={() => setSetup((s) => ({ ...s, jobs: s.jobs.filter((j) => j.id !== job.id) }))}><Icon name="trash" size={16} /></button>
            </div>
          ))}
          <div className="card-pad"><span className="muted small">To add one, set up a job on the calculator and pick <strong>Save as a job type</strong>.</span></div>
        </section>

        <div className="row wrap" style={{ gap: 10 }}>
          <Button
            icon="undo"
            onClick={async () => {
              if (await confirm({ title: "Start from the standard setup?", body: "Your items, prices and job types here go back to the standard ones. Nothing changes until you save.", confirmLabel: "Use the standard setup" })) setSetup(structuredClone(DEFAULT_SETUP));
            }}
          >
            Use the standard setup
          </Button>
          <span className="spacer grow" />
          <Button variant="primary" icon="check" disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </div>
    </>
  );
}

/** What else an item's way of figuring takes: a weight per inch, a crew day, dropdown choices. */
function ItemExtras({ item, onChange }: { item: CalcItem; onChange: (change: Partial<CalcItem>) => void }) {
  const area = item.basis === "area_sqyd" || item.basis === "area_sqft";
  const choices = item.choices ?? [];
  const setChoice = (i: number, change: Partial<(typeof choices)[number]>) => onChange({ choices: choices.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  // An area choice (a milling depth) is told apart by its value; a new one takes the next free number.
  const next = choices.reduce((m, c) => Math.max(m, c.value), 0) + 1;
  const per = BASES[item.basis].per;
  if (!fromArea(item.basis) && item.basis !== "days") return null;
  return (
    <div className="calc-setup-extras">
      {item.basis === "depth" && (
        <span className="row small" style={{ gap: 6 }}>
          Weighs
          <NumberBox label={`${item.name} pounds per square yard per inch`} value={item.weight ?? DEFAULT_WEIGHT} onChange={(weight) => onChange({ weight })} width={70} small />
          lb per sq yd for each inch
        </span>
      )}
      {item.basis === "days" && (
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={Boolean(item.crew)} onChange={(e) => onChange({ crew: e.target.checked })} />
          A crew day (profit by the day counts it)
        </label>
      )}
      {fromArea(item.basis) && (
        <div className="stack-sm" style={{ gap: 6 }}>
          {(choices.length > 0 || area) && (
            <span className="small muted">{choices.length ? "Dropdown choices" : "On or off over the whole area. Add choices to pick from, like milling depths with their own prices."}</span>
          )}
          {choices.map((c, i) => (
            <span key={i} className="row wrap small" style={{ gap: 6 }}>
              <input className="input input-sm" style={{ width: 160 }} aria-label="Choice name" value={c.label} maxLength={40} placeholder={area ? '2"' : "Tack coat"} onChange={(e) => setChoice(i, { label: e.target.value })} />
              {area ? (
                <>
                  <NumberBox label={`${c.label} price`} value={c.price ?? 0} onChange={(price) => setChoice(i, { price })} prefix="$" width={100} />
                  <span className="muted">/{BASES[item.basis].unit}</span>
                </>
              ) : (
                <>
                  <NumberBox label={`${c.label}, ${per}`} value={c.value} onChange={(value) => setChoice(i, { value })} width={70} small />
                  <span className="muted">{per}</span>
                </>
              )}
              <button type="button" className="icon-btn" aria-label={`Take out ${c.label || "choice"}`} onClick={() => onChange({ choices: choices.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
            </span>
          ))}
          <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => onChange({ choices: [...choices, area ? { label: "", value: next, price: 0 } : { label: "", value: 0 }] })}>
            {choices.length || area ? "Add a choice" : `Pick the ${item.basis === "depth" ? "depth" : per} from a list`}
          </button>
        </div>
      )}
    </div>
  );
}
