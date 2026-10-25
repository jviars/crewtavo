/**
 * Timesheets → Pay's download: one row per person with hours, hourly pay, piece pay (job pay done in
 * the period, per square, per job or per day) and the two together, and how they were paid. Kept
 * apart from the screen so it's tested on its own (test/jobPay.test.ts).
 */
export interface PayPerson {
  user_id: string;
  name: string;
  hours: number;
  break_hours: number;
  overtime_hours: number;
  hourly_amount: number;
  piece_amount: number;
  amount: number;
  unapproved_hours: number;
  running: boolean;
  piece: Array<{ id: string; job_id: string; job_number: number | null; job_title: string; total: number; status: string; earned_on: string | null }>;
  paid: { paid_amount: number | null; piece_amount?: number | null; method: string | null; reference: string | null; paid_at: string | null } | null;
}

export const PAY_COLUMNS = [
  { key: "person", label: "Person" },
  { key: "hours", label: "Approved hours" },
  { key: "overtime", label: "Hours over 40 a week" },
  { key: "breaks", label: "Breaks (unpaid)" },
  { key: "hourly", label: "Hourly pay at their rate" },
  { key: "piece", label: "Piece pay" },
  { key: "amount", label: "Total pay" },
  { key: "paid", label: "Paid" },
  { key: "method", label: "How" },
  { key: "reference", label: "Reference" },
  { key: "not_approved", label: "Hours not approved" },
] as const;

export function payRows(people: readonly PayPerson[], methodLabel: (m: string | null) => string) {
  return people.map((p) => ({
    person: p.name,
    hours: p.hours.toFixed(2),
    overtime: p.overtime_hours.toFixed(2),
    breaks: p.break_hours.toFixed(2),
    hourly: p.hourly_amount.toFixed(2),
    piece: p.piece_amount.toFixed(2),
    amount: p.amount.toFixed(2),
    paid: p.paid?.paid_amount?.toFixed(2) ?? "",
    method: methodLabel(p.paid?.method ?? null),
    reference: p.paid?.reference ?? "",
    not_approved: p.unapproved_hours.toFixed(2),
  }));
}

/** Someone with hours or piece pay in the period: what marking it paid covers. */
export const owedFor = (p: Pick<PayPerson, "hours" | "piece_amount">) => p.hours > 0 || p.piece_amount > 0;

/**
 * Of the people being marked paid, who still has time that isn't approved or a clock running (the
 * server refuses the lot until it is), including someone owed only piece pay so far.
 */
export const waitingFor = <T extends Pick<PayPerson, "unapproved_hours" | "running">>(people: readonly T[]) => people.filter((p) => p.unapproved_hours > 0 || p.running);

/** "Job #12 Smith roof, $234.80" for each job someone's piece pay is from. */
export const pieceJobs = (p: Pick<PayPerson, "piece">, money: (n: number) => string) =>
  p.piece.map((x) => `${x.job_number ? `Job #${x.job_number} ` : ""}${x.job_title}, ${money(x.total)}`).join(" · ");
