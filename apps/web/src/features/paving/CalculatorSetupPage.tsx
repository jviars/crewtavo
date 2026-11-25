/**
 * Paving → Calculator → Set up: what a business's calculator prices and how, for an owner or admin.
 * Its items (named the way the business names them, each figured one of the BASES ways, with
 * dropdown choices where it has them), how it takes profit, what it adds for waste, and its job
 * types (made on the calculator with Save as a job type, renamed or taken out here). Saved to
 * companies.settings.paving_calculator; worksheets already made keep the setup they were priced with.
 */
import { isPavingWork, PAVING_WORK, PAVING_WORK_IDS } from "@crewtavo/core/paving";
import { useMutation } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { DetailHeader } from "@/components/ui/DetailPage";
import { Menu } from "@/components/ui/Menu";
import { BackLink } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { EmptyState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { currencySymbol } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { BASES, BASIS_IDS, DEFAULT_SETUP, DEFAULT_WEIGHT, fromArea, parseSetup, sectionsOf, setupFrom, type Basis, type CalcItem, type CalcSetup, type ProfitBy } from "./calculator";
import { NumberBox } from "./NumberBox";
import styles from "./paving.module.css";
import { loadSettings } from "@/lib/companySettings";
import { Select } from "@/components/ui/Select";

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
      const current = await loadSettings(company.id);
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
  const useStandard = async () => {
    if (await confirm({ title: "Start from the standard setup?", body: "Your items, prices and job types here go back to the standard ones. Nothing changes until you save.", confirmLabel: "Use the standard setup" })) setSetup(structuredClone(DEFAULT_SETUP));
  };

  return (
    <>
      <DetailHeader
        crumb={{ to: "/paving/calculator", label: "Paving calculator" }}
        title="Calculator setup"
        more={[{ label: "Use the standard setup", icon: "undo", description: "Its items, prices and job types, until you save", onSelect: useStandard }]}
        moreTitle="Calculator setup"
      >
        <p className={cx("page-lede", styles.headLede)}>What your calculator prices, what you call it and how each amount is figured. Worksheets already made keep the setup they were priced with.</p>
      </DetailHeader>
      {firstTime && (
        <div className={cx("callout callout-info", styles.callout)} role="note">
          <Icon name="info" size={16} />
          <div className="grow">
            <div>These are sample prices. Set your own.</div>
            Go down the list and put in what you pay per ton and per gallon, your crew's day rate, and trucking and mobilization if you charge them. Rename anything you call by another name, take out what you don't use, then save.
          </div>
        </div>
      )}

      <div className={styles.setup}>
        <Section title="Items" count={setup.items.length} action={<button type="button" onClick={add}><Icon name="plus" size={14} />Add an item</button>}>
          <datalist id={listId}>{sectionsOf(setup).map((s) => <option key={s} value={s} />)}</datalist>
          <div className={styles.itemHead} aria-hidden="true">
            <span>Name</span>
            <span>Section</span>
            <span>How it's figured</span>
            <span>Price</span>
            <span />
          </div>
          <ul className={styles.items} role="list">
            {setup.items.map((item, i) => {
              const called = item.name.trim() || "Item";
              return (
                <li key={item.id} className={styles.item}>
                  <div className={styles.itemRow}>
                    <label className={styles.cell}>
                      <span className={styles.cellLabel}>Name</span>
                      <input className="input" value={item.name} maxLength={80} placeholder="Crusher run" aria-label={`Item ${i + 1} name`} onChange={(e) => setItem(item.id, { name: e.target.value })} />
                    </label>
                    <label className={styles.cell}>
                      <span className={styles.cellLabel}>Section</span>
                      <input className="input" list={listId} value={item.section} maxLength={40} aria-label={`${called}: section`} onChange={(e) => setItem(item.id, { section: e.target.value })} />
                    </label>
                    <label className={styles.cell}>
                      <span className={styles.cellLabel}>How it's figured</span>
                      <Select className="select" value={item.basis} aria-label={`${called}: how it's figured`} onChange={(e) => setItem(item.id, { basis: e.target.value as Basis })}>
                        {BASIS_IDS.map((b) => <option key={b} value={b}>{BASES[b].label}</option>)}
                      </Select>
                    </label>
                    <div className={styles.cell}>
                      <span className={styles.cellLabel} aria-hidden="true">Price</span>
                      <span className={styles.inline}>
                        <NumberBox label={`${called} price`} value={item.price} onChange={(price) => setItem(item.id, { price })} prefix={currencySymbol()} width={110} />
                        <span className={styles.unit}>/{BASES[item.basis].unit}</span>
                      </span>
                    </div>
                    <div className={styles.itemTools}>
                      <Menu
                        label={`More for ${called}`}
                        title={called}
                        triggerClassName="btn btn-sm btn-ghost btn-icon"
                        items={[
                          { label: "Move up", icon: "chevronUp", disabled: i === 0, onSelect: () => move(i, -1) },
                          { label: "Move down", icon: "chevronDown", disabled: i === setup.items.length - 1, onSelect: () => move(i, 1) },
                          { separator: true },
                          { label: "Take out", icon: "trash", danger: true, onSelect: () => remove(item.id) },
                        ]}
                      />
                    </div>
                  </div>
                  <ItemExtras item={item} onChange={(change) => setItem(item.id, change)} />
                </li>
              );
            })}
          </ul>
        </Section>

        <Section title="Profit, minimum and waste">
          <div className={styles.setRows}>
            <div className={styles.setRow}>
              <span className={styles.setLabel} id={`${listId}-profit`}>Profit</span>
              <div className={styles.setControl}>
                <div className="segmented" role="group" aria-labelledby={`${listId}-profit`}>
                  {PROFIT_WAYS.map((w) => <button key={w.id} type="button" aria-pressed={setup.profit.by === w.id} onClick={() => setSetup((s) => ({ ...s, profit: { ...s.profit, by: w.id } }))}>{w.label}</button>)}
                </div>
                {setup.profit.by !== "none" ? (
                  <span className={styles.inline}>
                    <NumberBox label={setup.profit.by === "day" ? "Profit per day" : "Profit percent of cost"} value={setup.profit.amount} onChange={(amount) => setSetup((s) => ({ ...s, profit: { ...s.profit, amount } }))} prefix={setup.profit.by === "day" ? currencySymbol() : undefined} width={120} />
                    <span className={styles.unit}>{setup.profit.by === "day" ? "for each crew day" : "% of the cost"}</span>
                  </span>
                ) : (
                  <span className={styles.hint}>Your prices already have the profit in them.</span>
                )}
              </div>
            </div>
            <div className={styles.setRow}>
              <span className={styles.setLabel} aria-hidden="true">Minimum charge</span>
              <div className={styles.setControl}>
                <NumberBox label="Minimum charge" value={setup.minimum} onChange={(minimum) => setSetup((s) => ({ ...s, minimum }))} prefix={currencySymbol()} width={120} />
                <span className={styles.hint}>A smaller job is brought up to this (0 for none).</span>
              </div>
            </div>
            <div className={styles.setRow}>
              <span className={styles.setLabel} aria-hidden="true">Extra for waste</span>
              <div className={styles.setControl}>
                <span className={styles.inline}>
                  <NumberBox label="Extra for waste, percent" value={setup.waste} onChange={(waste) => setSetup((s) => ({ ...s, waste: Math.min(waste, 100) }))} width={72} />
                  <span className={styles.unit}>%</span>
                </span>
                <span className={styles.hint}>On tons and gallons, before they're rounded up to whole ones.</span>
              </div>
            </div>
          </div>
        </Section>

        <Section title="Job types" count={setup.jobs.length || undefined}>
          {setup.jobs.length > 0 && (
            <ul className={styles.jobTypes} role="list">
              {setup.jobs.map((job) => (
                <li key={job.id} className={styles.jobType}>
                  <input className="input" aria-label="Job type name" value={job.name} maxLength={80} onChange={(e) => setSetup((s) => ({ ...s, jobs: s.jobs.map((j) => (j.id === job.id ? { ...j, name: e.target.value } : j)) }))} />
                  <span className={styles.jobTypeValues}>
                    {Object.entries(job.values).map(([id, v]) => `${names.get(id)?.name ?? "Taken-out item"} ${v}`).join(" · ") || "Nothing filled in"}
                  </span>
                  <button type="button" className="btn btn-icon btn-sm btn-ghost" aria-label={`Take out ${job.name}`} title="Take out" onClick={() => setSetup((s) => ({ ...s, jobs: s.jobs.filter((j) => j.id !== job.id) }))}><Icon name="trash" size={15} /></button>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.hint}>To add one, set up a job on the calculator and pick <strong>Save as a job type</strong>.</p>
        </Section>

        <div className={styles.saveBar}>
          <span className={styles.saveNote} aria-live="polite">{save.isPending ? "Saving…" : changed ? (firstTime ? "Save to make these prices your own" : "Unsaved changes") : save.isSuccess ? "Saved" : ""}</span>
          <Button variant="primary" icon="check" disabled={!changed} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </div>
    </>
  );
}

/** The kind of work an item is, and what else its way of figuring takes: a weight per inch, a crew day, dropdown choices. */
function ItemExtras({ item, onChange }: { item: CalcItem; onChange: (change: Partial<CalcItem>) => void }) {
  const area = item.basis === "area_sqyd" || item.basis === "area_sqft";
  const choices = item.choices ?? [];
  const setChoice = (i: number, change: Partial<(typeof choices)[number]>) => onChange({ choices: choices.map((c, j) => (j === i ? { ...c, ...change } : c)) });
  // An area choice (a milling depth) is told apart by its value; a new one takes the next free number.
  const next = choices.reduce((m, c) => Math.max(m, c.value), 0) + 1;
  const per = BASES[item.basis].per;
  return (
    <div className={styles.extras2}>
      <label className={styles.inline}>
        <span className={styles.unit}>Weather rules and checklists treat it as</span>
        <Select className="select input-sm" style={{ width: "auto" }} aria-label={`${item.name || "Item"}: the kind of work it is`} value={item.work ?? ""} onChange={(e) => onChange({ work: isPavingWork(e.target.value) ? e.target.value : null })}>
          <option value="">Nothing in particular</option>
          {PAVING_WORK_IDS.map((w) => <option key={w} value={w}>{PAVING_WORK[w]}</option>)}
        </Select>
      </label>
      {item.basis === "depth" && (
        <span className={styles.inline}>
          <span className={styles.unit}>Weighs</span>
          <NumberBox label={`${item.name} pounds per square yard per inch`} value={item.weight ?? DEFAULT_WEIGHT} onChange={(weight) => onChange({ weight })} width={70} small />
          <span className={styles.unit}>lb per sq yd for each inch</span>
        </span>
      )}
      {item.basis === "days" && (
        <label className={styles.inline}>
          <input type="checkbox" checked={Boolean(item.crew)} onChange={(e) => onChange({ crew: e.target.checked })} />
          <span className={styles.unit}>A crew day (profit by the day counts it)</span>
        </label>
      )}
      {fromArea(item.basis) && (
        <div className={styles.choices}>
          {(choices.length > 0 || area) && (
            <span className={styles.hint}>{choices.length ? "Dropdown choices" : "On or off over the whole area. Add choices to pick from, like milling depths with their own prices."}</span>
          )}
          {choices.map((c, i) => (
            <span key={i} className={styles.inline}>
              <input className="input input-sm" style={{ width: 160 }} aria-label="Choice name" value={c.label} maxLength={40} placeholder={area ? '2"' : "Tack coat"} onChange={(e) => setChoice(i, { label: e.target.value })} />
              {area ? (
                <>
                  <NumberBox label={`${c.label} price`} value={c.price ?? 0} onChange={(price) => setChoice(i, { price })} prefix={currencySymbol()} width={100} />
                  <span className={styles.unit}>/{BASES[item.basis].unit}</span>
                </>
              ) : (
                <>
                  <NumberBox label={`${c.label}, ${per}`} value={c.value} onChange={(value) => setChoice(i, { value })} width={70} small />
                  <span className={styles.unit}>{per}</span>
                </>
              )}
              <button type="button" className="btn btn-icon btn-sm btn-ghost" aria-label={`Take out ${c.label || "choice"}`} onClick={() => onChange({ choices: choices.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
            </span>
          ))}
          <button type="button" className={styles.addLink} onClick={() => onChange({ choices: [...choices, area ? { label: "", value: next, price: 0 } : { label: "", value: 0 }] })}>
            <Icon name="plus" size={14} />
            {choices.length || area ? "Add a choice" : `Pick the ${item.basis === "depth" ? "depth" : per} from a list`}
          </button>
        </div>
      )}
    </div>
  );
}
