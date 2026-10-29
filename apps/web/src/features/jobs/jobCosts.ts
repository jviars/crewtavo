/**
 * The job page's costs, counted the way Finance → Profit and AI assistants count them (jobProfit in
 * packages/core/src/reports.ts): line items at cost, labor (time at its rates), sub and crew pay
 * (agreed, done or paid: public.job_pay_costs) and expenses. Once a job has labor of its own that
 * costs something (time on it at a rate, or sub and crew pay), its line items count without the labor
 * estimate their cost has in it, so that labor isn't counted twice. Time that costs nothing yet (no
 * rate set, or a clock still running) leaves the estimate in.
 */
import { lineCosts, type CostedLine } from "@crewtavo/core/reports";
import { formatMoneyCents } from "@/lib/format";

/** Dollars and cents for an AnimatedNumber, the way formatMoneyCents writes them: "$1,250.00". */

export interface JobCostInput {
  contract: number;
  lines: readonly CostedLine[];
  /** Time on the job at its rates. */
  labor: number;
  expenses: number;
  /** public.job_pay_costs for the job: nothing when it has none. */
  crewPay: ReadonlyArray<{ amount: number | string | null; payees: number }>;
}

export function jobCosts(input: JobCostInput) {
  const crew = input.crewPay.reduce((s, p) => s + Number(p.amount ?? 0), 0);
  const actualLabor = input.labor > 0 || input.crewPay.length > 0;
  const lines = lineCosts(input.lines, actualLabor);
  const total = lines.materials + input.labor + crew + input.expenses;
  const profit = input.contract - total;
  return {
    materials: lines.materials,
    leftOut: lines.left_out,
    labor: input.labor,
    crew,
    expenses: input.expenses,
    total,
    profit,
    margin: input.contract > 0 ? Math.round((profit / input.contract) * 100) : null,
    actualLabor,
    /** The one line under the costs when line items count materials only. */
    note: actualLabor && lines.left_out > 0
      ? `Line item costs count materials only, since this job has its own labor: the ${formatMoneyCents(lines.left_out)} of labor estimated in them isn't counted twice.`
      : null,
  };
}
