/**
 * Paving → Calculator: a paving bid on one page, no map or client needed to start. Its items are
 * the business's own setup (calculator.ts; Paving → Calculator → Set up): pick a job type, type the
 * area, and each item's tons, gallons and price work themselves out. Any amount or price can be
 * typed over for this job; an owner or admin can keep the prices, or the job as a new job type.
 *
 * Turn into quote makes a draft quote with one line for the whole job, and keeps the worksheet
 * behind it (public.paving_worksheets): the setup, amounts, prices, profit and the estimator's notes,
 * for the office only. The client sees the line: the work and the amounts of material, never the
 * prices or profit. Opened from a paving project (?quote=), the area comes from its takeoff and the
 * line goes on its estimate; with &as=option, the job becomes another option on that quote (up to
 * three, through public.apply_quote_options, which makes the quote's own estimate option 1 first).
 * Opened from a worksheet (?worksheet=), it updates that quote's line.
 *
 * Until an owner or admin saves the business's own setup, the prices are a sample and the page says so.
 */
import { pavingQuantities } from "@crewtavo/core/paving";
import chipPhoto from "@/assets/paving/chip.webp";
import gravelPhoto from "@/assets/paving/gravel.webp";
import overlayPhoto from "@/assets/paving/overlay.webp";
import pavePhoto from "@/assets/paving/pave.webp";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatedNumber, MONEY_CENTS } from "@/components/ui/AnimatedNumber";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { DetailSkeleton } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ui/States";
import { supabase, unwrap } from "@/lib/api";
import { addDaysIso, formatMoney, formatMoneyCents, formatNumber, todayIn } from "@/lib/format";
import { hasRole, useSession } from "@/lib/session";
import { ClientPicker, PropertySelect, type PickedClient } from "../clients/ClientForm";
import { PropertyDialog } from "../clients/PropertyDialog";
import {
  applyJob,
  BASES,
  calculate,
  workedOut,
  jobFrom,
  jobName,
  keptOverrides,
  newInput,
  parseSetup,
  parseWorksheet,
  pricesDiffer,
  scopeText,
  sectionsOf,
  setupFrom,
  withPrices,
  type Calc,
  type CalcInput,
  type CalcLine,
  type CalcSetup,
  type Overrides,
  type ProfitBy,
  type Side,
  type WorksheetData,
} from "./calculator";
import { sectionsOf as takeoffSections } from "./data";
import { NumberBox } from "./NumberBox";
import { EDITABLE } from "./ProjectFlow";
import { quoteOptionsKey } from "../quotes/options";
import { worksheetsKey } from "./WorksheetsCard";

const UNIT_WORDS: Record<string, string> = { gal: "gal", ton: "tons", "sq yd": "sq yd", "sq ft": "sq ft", ft: "ft", day: "days", ea: "each" };
/** The standard job types' photos (assets/paving/README.md); one a business adds shows an icon. */
const JOB_PHOTOS: Record<string, string> = { overlay: overlayPhoto, pave: pavePhoto, chip: chipPhoto, gravel: gravelPhoto };
const PROFIT_WAYS: Array<{ id: ProfitBy; label: string }> = [
  { id: "day", label: "By the day" },
  { id: "percent", label: "% of cost" },
  { id: "none", label: "None" },
];

/** A worksheet as the calculator reopens it, with the quote it's on. */
interface OpenWorksheet {
  id: string;
  quote_id: string;
  line_id: string | null;
  notes: string | null;
  data: unknown;
  quote: { id: string; title: string; status: string } | null;
}

export function PavingCalculatorPage() {
  const session = useSession();
  const { company } = session;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const projectId = params.get("quote");
  const worksheetId = params.get("worksheet");
  const asOption = Boolean(projectId) && params.get("as") === "option";
  const canSell = hasRole(session, "admin", "office", "estimator");
  const isAdmin = hasRole(session, "admin");

  const companySetup = useMemo(() => setupFrom(company.settings), [company.settings]);
  const [setup, setSetup] = useState<CalcSetup>(companySetup);
  const [input, setInput] = useState<CalcInput>(() => newInput(companySetup));
  const [overrides, setOverrides] = useState<Overrides>({});
  const [notes, setNotes] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [namingJob, setNamingJob] = useState(false);
  const calc = useMemo(() => calculate(setup, input, overrides), [setup, input, overrides]);

  // A change to what an amount is worked out from puts it back to the worked-out one; new crew days do the same for profit days.
  const update = (next: CalcInput) => {
    const before = calculate(setup, input);
    const after = calculate(setup, next);
    setOverrides((o) => keptOverrides(before, after, o));
    setInput(before.crewDays !== after.crewDays ? { ...next, profitDays: null } : next);
  };
  const setValue = (id: string, value: number) => update({ ...input, values: { ...input.values, [id]: value } });
  const setSides = (sides: Side[] | null) => update({ ...input, sides, sqft: sides ? Math.round(sides.reduce((t, s) => t + s.length * s.width, 0) * 100) / 100 : input.sqft });

  // Reopened: the worksheet as it was saved, with the prices it was priced at.
  const worksheet = useQuery({
    queryKey: ["paving-worksheet", worksheetId],
    enabled: Boolean(worksheetId),
    queryFn: async () => {
      const row = unwrap(await supabase().from("paving_worksheets").select("id, quote_id, line_id, notes, data, quote:quotes(id, title, status)").eq("id", worksheetId!).maybeSingle()) as OpenWorksheet | null;
      if (!row) throw new Error("That worksheet wasn't found. Its quote may have been deleted.");
      return row;
    },
  });
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    const row = worksheet.data;
    if (!row || loaded.current === row.id) return;
    loaded.current = row.id;
    const saved = parseWorksheet(row.data);
    if (saved) {
      setSetup(saved.setup);
      setInput(saved.input);
      setOverrides(saved.overrides);
    }
    setNotes(row.notes ?? "");
  }, [worksheet.data]);

  // Opened from a paving project: its name, and the asphalt on its takeoff as the area.
  const project = useQuery({
    queryKey: ["paving-calculator-project", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const db = supabase();
      const [quote, takeoff, worksheets] = await Promise.all([
        db.from("quotes").select("id, title, status, options:quote_options!quote_options_quote_fkey(id)").eq("id", projectId!).maybeSingle(),
        db.from("measurements").select("sections").eq("quote_id", projectId!).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("paving_worksheets").select("name, data").eq("quote_id", projectId!).order("created_at").limit(1),
      ]);
      const q = unwrap(quote);
      if (!q) throw new Error("That quote wasn't found. It may have been deleted.");
      const t = unwrap(takeoff);
      // A quote without options becomes option 1 when another is added, named for the job on it.
      const first = unwrap(worksheets)[0];
      return { quote: q, options: q.options.length, firstJob: first?.name ?? null, firstArea: parseWorksheet(first?.data)?.input ?? null, asphaltSqft: t ? pavingQuantities(takeoffSections(t)).asphalt_sqft : 0 };
    },
  });
  const fromTakeoff = project.data?.asphaltSqft ?? 0;
  // Another option for the same quote: the same area as the job already priced on it, unless its takeoff says.
  const firstArea = asOption && !fromTakeoff ? project.data?.firstArea ?? null : null;
  useEffect(() => {
    if (fromTakeoff > 0) setInput((i) => (i.sqft ? i : { ...i, sqft: fromTakeoff }));
    else if (firstArea?.sqft) setInput((i) => (i.sqft ? i : { ...i, sqft: firstArea.sqft, sides: firstArea.sides }));
  }, [fromTakeoff, firstArea]);

  // Owner or admin: the business's setup, read fresh so a change someone made meanwhile isn't undone.
  const saveSetup = async (change: (current: CalcSetup) => CalcSetup) => {
    const current = (unwrap(await supabase().from("companies").select("settings").eq("id", company.id).single()).settings ?? {}) as Record<string, unknown>;
    const next = change(parseSetup(current.paving_calculator));
    unwrap(await supabase().from("companies").update({ settings: { ...current, paving_calculator: next } as never }).eq("id", company.id));
    await session.refresh();
    return next;
  };
  const keepPrices = useMutation({
    meta: { success: "Saved. Every new estimate starts from these prices." },
    mutationFn: () => saveSetup((current) => withPrices(current, priced)),
  });
  const keepJob = useMutation({
    meta: { success: (j: { name: string }) => `Saved "${j.name}" as a job type.` },
    mutationFn: async (name: string) => {
      const job = jobFrom(input, name, `job-${crypto.randomUUID().slice(0, 8)}`);
      await saveSetup((current) => ({ ...current, jobs: [...current.jobs, job] }));
      setSetup((s) => ({ ...s, jobs: [...s.jobs, job] }));
      setInput((i) => ({ ...i, job: job.id }));
      setNamingJob(false);
      return job;
    },
  });

  const data: WorksheetData = { v: 1, setup, input, overrides };
  // This job's prices, with its profit and minimum, as "Save these prices for every job" keeps them.
  const priced: CalcSetup = { ...setup, profit: input.profit, minimum: input.minimum };
  // The quote, its paving project and its worksheets show the new line and working.
  const refreshQuote = (quoteId: string) => {
    for (const key of [worksheetsKey(quoteId), quoteOptionsKey(quoteId), ["quote", quoteId], ["paving-project", quoteId], ["paving-projects", company.id], ["paving-worksheet"], ["paving-calculator-project", quoteId]]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const putOnProject = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      await addToQuote(company.id, projectId!, setup, input, calc, data, notes);
      return projectId!;
    },
    onSuccess: (id) => {
      refreshQuote(id);
      navigate(`/paving/${id}#estimate`);
    },
  });
  const addOption = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const db = supabase();
      const quoteId = projectId!;
      const line = lineFields(setup, input, calc);
      const before = new Set(unwrap(await db.from("quote_line_items").select("id").eq("quote_id", quoteId)).map((l) => l.id));
      const first = project.data?.firstJob;
      unwrap(await db.rpc("apply_quote_options", { p_quote: quoteId, p_options: [{ name: line.name, lines: [{ ...line, sort: 0 }] }], p_mode: "add", ...(first ? { p_current: { name: first } } : {}) }));
      const added = unwrap(await db.from("quote_line_items").select("id, option_id").eq("quote_id", quoteId)).find((l) => !before.has(l.id));
      if (!added?.option_id) throw new Error("The option was added, but its line wasn't found. Open the quote to check it.");
      const kept = await db.from("paving_worksheets").insert({ company_id: company.id, quote_id: quoteId, line_id: added.id, name: line.name, notes: notes.trim() || null, data: data as never });
      if (kept.error) {
        // Without its worksheet, the option comes back off (and a quote left with one goes back to a single estimate).
        await db.rpc("remove_quote_option", { p_quote: quoteId, p_option: added.option_id });
        unwrap(kept);
      }
      return quoteId;
    },
    onSuccess: (id) => {
      refreshQuote(id);
      navigate(`/quotes/${id}`);
    },
  });
  const updateQuote = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const ws = worksheet.data!;
      const db = supabase();
      const line = lineFields(setup, input, calc);
      let lineId = ws.line_id;
      if (lineId) unwrap(await db.from("quote_line_items").update(line).eq("id", lineId));
      else lineId = await addLine(company.id, ws.quote_id, line);
      unwrap(await db.from("paving_worksheets").update({ line_id: lineId, name: line.name, notes: notes.trim() || null, data: data as never }).eq("id", ws.id));
      return ws.quote_id;
    },
    onSuccess: (id) => {
      refreshQuote(id);
      navigate(`/quotes/${id}`);
    },
  });

  const startOver = () => {
    setSetup(companySetup);
    setInput({ ...newInput(companySetup), sqft: fromTakeoff });
    setOverrides({});
    setNotes("");
  };

  if (worksheetId && worksheet.isPending) return <DetailSkeleton />;
  if (worksheetId && worksheet.error) return <><BackLink to="/paving">Paving</BackLink><ErrorState error={worksheet.error} onRetry={() => worksheet.refetch()} /></>;

  const target = worksheet.data?.quote ?? project.data?.quote ?? null;
  const targetOpen = target ? EDITABLE.includes(target.status) : false;
  const backTo = worksheet.data ? `/quotes/${worksheet.data.quote_id}` : asOption ? `/quotes/${projectId}` : projectId ? `/paving/${projectId}` : "/paving";
  const optionNumber = Math.max(project.data?.options ?? 0, 1) + 1;
  // Prices nobody in the business has set yet: the standard setup's sample.
  const sample = !worksheet.data && (company.settings as Record<string, unknown> | null)?.paving_calculator === undefined;
  const sections = sectionsOf(setup);

  return (
    <>
      <BackLink to={backTo}>{target?.title ?? "Paving"}</BackLink>
      <PageHeader
        title={worksheet.data ? "Worksheet" : "Paving calculator"}
        actions={isAdmin && <Link className="btn" to="/paving/calculator/setup"><Icon name="settings" size={16} />Set up</Link>}
      />
      <p className="page-subtitle">
        {worksheet.data ? "The working behind this quote, at the prices it was priced at. Change anything, then update the quote." : "Pick the job, type the area, and the tons, gallons and price work themselves out. Change any amount or price as you go."}
      </p>

      {sample && (
        <div className="callout callout-info calc-first" role="note">
          <Icon name="dollar" size={20} />
          <span className="grow stack-sm" style={{ gap: 4 }}>
            <strong>These are sample prices. Set your own.</strong>
            <span className="small">
              {isAdmin
                ? "It only takes a few minutes: what you call each material, what you pay for it, your crew's day rate and how you take profit. Every estimate uses them after that."
                : "An owner or admin sets your business's prices in Set up. Until then, change any price here for this job."}
            </span>
          </span>
          {isAdmin && <Link className="btn btn-primary" to="/paving/calculator/setup">Set your prices</Link>}
        </div>
      )}

      <div className="calc">
        <div className="stack" style={{ gap: 16 }}>
          <Section n={1} title="The job">
            <div className="calc-pad stack" style={{ gap: 18 }}>
              {setup.jobs.length > 0 && (
                <div className="stack-sm">
                  <div className="row wrap" style={{ gap: 10 }}>
                    <span className="small strong grow" id="calc-job">What kind of job?</span>
                    {isAdmin && <button type="button" className="link-btn small" onClick={() => setNamingJob(true)}>Save as a job type</button>}
                  </div>
                  <div className="calc-jobs" role="group" aria-labelledby="calc-job">
                    {setup.jobs.map((j) => (
                      <button key={j.id} type="button" className="calc-job" aria-pressed={input.job === j.id} onClick={() => update(applyJob(setup, input, j.id))}>
                        <span className="calc-job-picture">
                          {JOB_PHOTOS[j.id] ? <img src={JOB_PHOTOS[j.id]} alt="" loading="lazy" decoding="async" /> : <Icon name="paving" size={26} />}
                          {input.job === j.id && <span className="calc-job-check"><Icon name="check" size={14} /></span>}
                        </span>
                        <span className="calc-job-name">{j.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Area input={input} calc={calc} fromTakeoff={fromTakeoff} autoFocus={!projectId && !worksheetId} onSqft={(sqft) => update({ ...input, sqft })} onSides={setSides} />
            </div>
          </Section>

          {sections.map((section, i) => (
            <Section key={section} n={i + 2} title={section} head>
              {calc.lines
                .filter((l) => l.item.section === section)
                .map((line) => (
                  <LineRow
                    key={line.item.id}
                    line={line}
                    typed={overrides[line.item.id] !== undefined}
                    onValue={(v) => setValue(line.item.id, v)}
                    onAmount={(v) => setOverrides((o) => (v === undefined ? Object.fromEntries(Object.entries(o).filter(([id]) => id !== line.item.id)) : { ...o, [line.item.id]: v }))}
                    onPrice={(v) => setSetup((s) => priceSet(s, line, v))}
                  />
                ))}
            </Section>
          ))}

          <Section n={sections.length + 2} title="Profit">
            <ProfitPicker input={input} calc={calc} onChange={setInput} />
          </Section>
          {!setup.items.length && (
            <div className="callout">
              <Icon name="info" size={18} />
              <span>There's nothing to price yet. {isAdmin ? <Link to="/paving/calculator/setup">Add your items</Link> : "An owner or admin can add the items in Set up."}</span>
            </div>
          )}
        </div>

        <aside className="card calc-summary" aria-label="The estimate">
          <Summary calc={calc} />
          <div className="calc-pad stack-sm" style={{ gap: 10, paddingTop: 0 }}>
            <label className="field">
              <span>Notes for you <span className="optional">· never on the quote</span></span>
              <textarea className="textarea" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Quote 2 · entire driveway, including the circle" />
            </label>
            {canSell &&
              (worksheet.data ? (
                <>
                  <Button variant="primary" size="lg" block icon="check" disabled={!calc.total || !targetOpen} loading={updateQuote.isPending} onClick={() => updateQuote.mutate()}>Update the quote</Button>
                  {!targetOpen && <span className="muted small">This quote is signed, so its price can't change.</span>}
                  <Link className="btn btn-block" to={`/paving/worksheets/${worksheet.data.id}`}><Icon name="printer" size={16} />Print worksheet</Link>
                  <FormError error={updateQuote.error} />
                </>
              ) : asOption ? (
                <>
                  <Button variant="primary" size="lg" block icon="plus" disabled={!calc.total || !targetOpen || optionNumber > 3} loading={addOption.isPending} onClick={() => addOption.mutate()}>
                    Add as option {Math.min(optionNumber, 3)}
                  </Button>
                  {project.data && !targetOpen && <span className="muted small">This quote is signed, so its options can't change.</span>}
                  {project.data && targetOpen && optionNumber > 3 && <span className="muted small">This quote already offers 3 options, the most it can. Take one off on the quote first.</span>}
                  {project.data && targetOpen && optionNumber === 2 && <span className="muted small">What's on the quote now becomes option 1{project.data.firstJob ? `, ${project.data.firstJob}` : ""}. The client picks one.</span>}
                  <FormError error={addOption.error ?? project.error} />
                </>
              ) : projectId ? (
                <>
                  <Button variant="primary" size="lg" block icon="plus" disabled={!calc.total || !targetOpen} loading={putOnProject.isPending} onClick={() => putOnProject.mutate()}>Put on the estimate</Button>
                  {project.data && !targetOpen && <span className="muted small">Its proposal is already signed, so the estimate can't change.</span>}
                  <FormError error={putOnProject.error ?? project.error} />
                </>
              ) : (
                <Button variant="primary" size="lg" block icon="send" disabled={!calc.total} onClick={() => setQuoting(true)}>Turn into quote</Button>
              ))}
            {pricesDiffer(companySetup, priced) &&
              (isAdmin ? (
                <Button block icon="check" loading={keepPrices.isPending} onClick={() => keepPrices.mutate()}>Save these prices for every job</Button>
              ) : (
                <span className="muted small">These prices are for this job. An owner or admin can save them for every job.</span>
              ))}
            {!worksheet.data && <button type="button" className="link-btn small" style={{ justifySelf: "center" }} onClick={startOver}>Start over</button>}
          </div>
        </aside>
      </div>

      <div className="calc-bar-mobile" aria-hidden="true">
        <span className="muted small">Estimate</span>
        <strong>{formatMoney(calc.total)}</strong>
      </div>

      {quoting && <QuoteDialog setup={setup} input={input} calc={calc} data={data} notes={notes} onClose={() => setQuoting(false)} />}
      {namingJob && <JobTypeDialog pending={keepJob.isPending} error={keepJob.error} onClose={() => setNamingJob(false)} onSave={(name) => keepJob.mutate(name)} />}
    </>
  );
}

/** The setup with this line's price changed: its choice's own price, when its choice has one. */
function priceSet(setup: CalcSetup, line: CalcLine, price: number): CalcSetup {
  return {
    ...setup,
    items: setup.items.map((item) => {
      if (item.id !== line.item.id) return item;
      const choice = item.choices?.find((c) => c.value === line.value);
      if (choice?.price !== undefined) return { ...item, choices: item.choices!.map((c) => (c === choice ? { ...c, price } : c)) };
      return { ...item, price };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Onto a quote: one line for the job, and the worksheet behind it
// ---------------------------------------------------------------------------------------------

/** The quote line for the whole job: priced at the bid, costed at the bid before profit. */
const lineFields = (setup: CalcSetup, input: CalcInput, calc: Calc) => ({
  name: jobName(setup, input),
  description: scopeText(calc),
  quantity: 1,
  unit: "job",
  unit_price: calc.total,
  unit_cost: calc.cost,
});

/** A line after the quote's others; its id. */
async function addLine(companyId: string, quoteId: string, line: ReturnType<typeof lineFields>): Promise<string> {
  const db = supabase();
  const last = unwrap(await db.from("quote_line_items").select("sort").eq("quote_id", quoteId).order("sort", { ascending: false }).limit(1).maybeSingle());
  return unwrap(await db.from("quote_line_items").insert({ company_id: companyId, quote_id: quoteId, ...line, sort: (last?.sort ?? 0) + 1 }).select("id").single()).id;
}

/** The job onto a quote with its worksheet. Without the worksheet, the line comes back off. */
async function addToQuote(companyId: string, quoteId: string, setup: CalcSetup, input: CalcInput, calc: Calc, data: WorksheetData, notes: string) {
  const line = lineFields(setup, input, calc);
  const lineId = await addLine(companyId, quoteId, line);
  const kept = await supabase().from("paving_worksheets").insert({ company_id: companyId, quote_id: quoteId, line_id: lineId, name: line.name, notes: notes.trim() || null, data: data as never });
  if (kept.error) {
    await supabase().from("quote_line_items").delete().eq("id", lineId);
    unwrap(kept);
  }
}

// ---------------------------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------------------------

function Area({ input, calc, fromTakeoff, autoFocus, onSqft, onSides }: { input: CalcInput; calc: Calc; fromTakeoff: number; autoFocus: boolean; onSqft: (v: number) => void; onSides: (sides: Side[] | null) => void }) {
  const bySides = input.sides !== null;
  const sides = input.sides ?? [];
  const setSide = (i: number, change: Partial<Side>) => onSides(sides.map((s, j) => (j === i ? { ...s, ...change } : s)));
  const whole = (n: number) => formatNumber(n, Number.isInteger(n) ? 0 : 2);
  return (
    <div className="stack-sm">
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="small strong grow">How big is it?</span>
        <div className="segmented" role="group" aria-label="How to enter the area">
          <button type="button" aria-pressed={!bySides} onClick={() => onSides(null)}>Total sq ft</button>
          <button type="button" aria-pressed={bySides} onClick={() => !bySides && onSides([{ length: 0, width: 0 }])}>Length × width</button>
        </div>
      </div>
      {!bySides ? (
        <div className="row wrap" style={{ gap: 12 }}>
          <NumberBox label="Area in square feet" value={input.sqft} onChange={onSqft} width={160} big autoFocus={autoFocus} />
          <span className="muted">sq ft</span>
          {fromTakeoff > 0 && input.sqft === fromTakeoff && <span className="calc-chip"><Icon name="area" size={14} />From the takeoff</span>}
        </div>
      ) : (
        <div className="stack-sm">
          {sides.map((s, i) => (
            <div key={i} className="row wrap" style={{ gap: 8 }}>
              <NumberBox label={`Area ${i + 1} length in feet`} value={s.length} onChange={(v) => setSide(i, { length: v })} width={100} />
              <span className="muted">ft ×</span>
              <NumberBox label={`Area ${i + 1} width in feet`} value={s.width} onChange={(v) => setSide(i, { width: v })} width={100} />
              <span className="muted">ft =</span>
              <strong className="num">{formatNumber(s.length * s.width)} sq ft</strong>
              {sides.length > 1 && (
                <button type="button" className="icon-btn" aria-label={`Remove area ${i + 1}`} onClick={() => onSides(sides.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
              )}
            </div>
          ))}
          <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => onSides([...sides, { length: 0, width: 0 }])}>Add another area</button>
        </div>
      )}
      <span className="muted small">
        {calc.sqft ? <>{whole(calc.sqft)} sq ft is <strong>{whole(calc.sqyd)} sq yd</strong>, which is what the amounts below work from.</> : "Everything below works from the area."}
      </span>
    </div>
  );
}

/** The total, what it's per sq ft, and how it splits into materials, the rest and profit. */
function Summary({ calc }: { calc: Calc }) {
  const parts = [
    { key: "materials", label: "Materials", value: calc.materials },
    { key: "work", label: "Labor, milling and trucks", value: calc.work },
    { key: "profit", label: "Profit", value: calc.profit },
    ...(calc.toMinimum > 0 ? [{ key: "minimum", label: "Up to your minimum", value: calc.toMinimum }] : []),
  ];
  return (
    <div className="calc-pad stack" style={{ gap: 14 }}>
      <div className="stack-sm" style={{ gap: 2 }}>
        <span className="muted small strong">Estimate</span>
        <AnimatedNumber value={calc.total} format={MONEY_CENTS} className="calc-total" />
        <span className="muted small">{calc.sqft && calc.total ? `${formatMoneyCents(calc.perSqft)} per sq ft · ${formatMoneyCents(calc.total / calc.sqyd)} per sq yd` : "Type the area and the days to see the price."}</span>
      </div>
      <div className="calc-split" aria-hidden="true">
        {parts.map((p) => p.value > 0 && <span key={p.key} data-part={p.key} style={{ flexGrow: p.value }} />)}
      </div>
      <dl className="calc-sums">
        {parts.map((p) => (
          <div key={p.key}>
            <dt><i data-part={p.key} />{p.label}</dt>
            <dd className="num">
              {formatMoney(p.value)}
              {p.key === "profit" && calc.total > 0 && <span className="muted"> · {Math.round((calc.profit / calc.total) * 100)}%</span>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Section({ n, title, head, children }: { n: number; title: string; head?: boolean; children: ReactNode }) {
  return (
    <section className="card calc-section" aria-labelledby={`calc-section-${n}`}>
      <div className="calc-section-title">
        <span className="calc-step">{n}</span>
        <h2 id={`calc-section-${n}`}>{title}</h2>
      </div>
      {head && (
        <div className="calc-line calc-line-head" aria-hidden="true">
          <span />
          <span>Amount</span>
          <span>Price</span>
          <span className="num">Total</span>
        </div>
      )}
      {children}
    </section>
  );
}

/** One line of the bid: what it's worked out from, its amount, its price and its total. */
function LineRow({ line, typed, onValue, onAmount, onPrice }: { line: CalcLine; typed: boolean; onValue: (v: number) => void; onAmount: (v: number | undefined) => void; onPrice: (v: number) => void }) {
  const { item, value } = line;
  const basis = BASES[item.basis];
  const unit = UNIT_WORDS[line.unit] ?? line.unit;
  const choice = item.choices?.find((c) => c.value === value) ?? null;
  // A dropdown whose choices carry their own prices has nothing to price until one is picked.
  const noPrice = !choice && Boolean(item.choices?.some((c) => c.price !== undefined));
  const needsPrice = line.quantity > 0 && line.price === 0 && !noPrice;
  const area = item.basis === "area_sqyd" || item.basis === "area_sqft";
  return (
    <div className="calc-line" data-off={line.total === 0 || undefined}>
      <div className="calc-line-what">
        <strong>{item.name}</strong>
        {item.choices?.length ? (
          <select className="select input-sm" aria-label={`${item.name}: which`} value={String(value)} onChange={(e) => onValue(Number(e.target.value))}>
            <option value="0">None</option>
            {item.choices.map((c) => (
              <option key={c.value} value={String(c.value)}>
                {c.label}
                {basis.per ? ` · ${c.value} ${basis.per}` : c.price !== undefined ? ` · ${c.price ? `${formatMoneyCents(c.price)}/${line.unit}` : "no price yet"}` : ""}
              </option>
            ))}
            {value > 0 && !choice && <option value={String(value)}>Other: {value}</option>}
          </select>
        ) : area || item.basis === "haul" ? (
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={value > 0} onChange={(e) => onValue(e.target.checked ? 1 : 0)} />
            {area ? "Over the whole area" : "Every ton on the job"}
          </label>
        ) : basis.per ? (
          <span className="row small" style={{ gap: 6 }}>
            <NumberBox label={`${item.name}, ${basis.per}`} value={value} onChange={onValue} width={64} small />
            <span className="muted">{basis.per}</span>
          </span>
        ) : null}
      </div>
      <div className="calc-line-amount">
        <span className="row" style={{ gap: 6 }}>
          {workedOut(item.basis) ? <NumberBox label={`${item.name}, ${unit}`} value={line.quantity} onChange={onAmount} /> : <NumberBox label={`${item.name}, ${unit}`} value={value} onChange={onValue} />}
          <span className="muted small">{unit}</span>
        </span>
        {typed && line.quantity !== line.worked && (
          <button type="button" className="link-btn small" onClick={() => onAmount(undefined)} title="Go back to the amount the calculator worked out">
            Worked out: {formatNumber(line.worked, Number.isInteger(line.worked) ? 0 : 2)}
          </button>
        )}
      </div>
      <div className="calc-line-price">
        {!noPrice && (
          <span className="row" style={{ gap: 6 }}>
            <NumberBox label={`${item.name} price per ${line.unit}${choice ? `, ${choice.label}` : ""}`} value={line.price} onChange={onPrice} prefix="$" invalid={needsPrice} />
            <span className="muted small">/{line.unit}</span>
          </span>
        )}
        {needsPrice && <span className="calc-warn">Needs a price</span>}
      </div>
      <strong className="num calc-line-total">{formatMoney(line.total)}</strong>
    </div>
  );
}

/** Profit by the day the crew is out, as a percent of the cost, or none (it's in the prices). */
function ProfitPicker({ input, calc, onChange }: { input: CalcInput; calc: Calc; onChange: (next: CalcInput) => void }) {
  const { profit } = input;
  const set = (change: Partial<CalcInput["profit"]>) => onChange({ ...input, profit: { ...profit, ...change } });
  return (
    <div className="calc-pad stack" style={{ gap: 12 }}>
      <div className="segmented" role="group" aria-label="How to take profit" style={{ justifySelf: "start" }}>
        {PROFIT_WAYS.map((w) => <button key={w.id} type="button" aria-pressed={profit.by === w.id} onClick={() => set({ by: w.id })}>{w.label}</button>)}
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        {profit.by === "day" ? (
          <>
            <NumberBox label="Profit days" value={calc.profitDays} onChange={(v) => onChange({ ...input, profitDays: v })} width={72} />
            <span className="muted">days ×</span>
            <NumberBox label="Profit per day" value={profit.amount} onChange={(v) => set({ amount: v })} prefix="$" width={120} />
            <span className="muted small grow">/day</span>
            {input.profitDays !== null && input.profitDays !== calc.crewDays && (
              <button type="button" className="link-btn small" onClick={() => onChange({ ...input, profitDays: null })}>Crew days: {formatNumber(calc.crewDays)}</button>
            )}
          </>
        ) : profit.by === "percent" ? (
          <>
            <NumberBox label="Profit percent of cost" value={profit.amount} onChange={(v) => set({ amount: v })} width={72} />
            <span className="muted grow">% of {formatMoney(calc.cost)}</span>
          </>
        ) : (
          <span className="muted small grow">
            No profit line: it's in your prices, where Crewtavo can't see it. So this quote and its job show a 0% margin (or just what the minimum charge adds). That's expected, not a mistake.
          </span>
        )}
        <strong className="num calc-line-total">{formatMoney(calc.profit)}</strong>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <span className="small strong">Minimum charge</span>
        <NumberBox label="Minimum charge" value={input.minimum} onChange={(minimum) => onChange({ ...input, minimum })} prefix="$" width={120} />
        <span className="muted small grow">{calc.toMinimum > 0 ? `This job comes up ${formatMoney(calc.toMinimum)} to reach it.` : "A smaller job is brought up to this."}</span>
      </div>
    </div>
  );
}

/** Who it's for and where, then a draft quote with the job and its worksheet on it, opened to send. */
function QuoteDialog({ setup, input, calc, data, notes, onClose }: { setup: CalcSetup; input: CalcInput; calc: Calc; data: WorksheetData; notes: string; onClose: () => void }) {
  const { company } = useSession();
  const navigate = useNavigate();
  const [client, setClient] = useState<PickedClient>(null);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [addingAddress, setAddingAddress] = useState(false);
  const [noClient, setNoClient] = useState(false);
  useEffect(() => setPropertyId(null), [client?.id]);
  const job = jobName(setup, input);

  const create = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      const db = supabase();
      const street = propertyId ? unwrap(await db.from("properties").select("line1").eq("id", propertyId).maybeSingle())?.line1 : null;
      const settings = company.settings as { default_tax_rate?: number; quote_valid_days?: number };
      const quote = unwrap(
        await db
          .from("quotes")
          .insert({
            company_id: company.id,
            client_id: client!.id,
            property_id: propertyId,
            title: title.trim() || (street ? `${job} at ${street}` : job),
            work_kind: "paving",
            tax_rate: Number(settings.default_tax_rate ?? 0),
            valid_until: addDaysIso(todayIn(company.timezone), Number(settings.quote_valid_days ?? 30)),
          })
          .select("id")
          .single(),
      );
      try {
        await addToQuote(company.id, quote.id, setup, input, calc, data, notes);
      } catch (error) {
        // No empty draft left behind.
        await db.from("quotes").delete().eq("id", quote.id);
        throw error;
      }
      return quote.id;
    },
    onSuccess: (id) => navigate(`/quotes/${id}`),
  });

  return (
    <>
      <Dialog open onClose={onClose} title="Turn into quote" description={`${job} for ${formatMoneyCents(calc.total)}. Pick who it's for, and the quote opens ready to send.`}>
        <form
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (client) return create.mutate();
            setNoClient(true);
          }}
        >
          <Field label="Client" error={noClient && !client ? "Pick who it's for, or type a name to add them." : null}>
            <ClientPicker value={client} onChange={setClient} />
          </Field>
          {client && (
            <Field label="Property">
              <div className="stack-sm">
                <PropertySelect clientId={client.id} value={propertyId} onChange={setPropertyId} />
                <button type="button" className="link-btn small" style={{ justifySelf: "start" }} onClick={() => setAddingAddress(true)}>Add an address</button>
              </div>
            </Field>
          )}
          <Field label="Project name" optional hint={`For example: ${job} at 12 Main St.`}>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={job} />
          </Field>
          <div className="callout" style={{ fontWeight: 400 }}>
            <Icon name="lock" size={18} />
            <span className="small">The client sees one line, <strong>{job}</strong>, with the area and the material amounts. Your worksheet, with its prices, crew days and profit, stays with your office on the quote and its job.</span>
          </div>
          <FormError error={create.error} />
          <div className="form-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="send" loading={create.isPending}>Make the quote</Button>
          </div>
        </form>
      </Dialog>
      {addingAddress && client && <PropertyDialog clientId={client.id} onClose={() => setAddingAddress(false)} />}
    </>
  );
}

/** Names the job as it's set up now, to start the next one like it. */
function JobTypeDialog({ pending, error, onClose, onSave }: { pending: boolean; error: unknown; onClose: () => void; onSave: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Dialog open onClose={onClose} title="Save as a job type" description="Its depths, rates and days fill in when someone picks it, for everyone in your business." size="sm">
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
        }}
      >
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Driveway with a circle" />
        </Field>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" icon="check" loading={pending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
