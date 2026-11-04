/**
 * Coming from Jobber: the work still open there, read from the CSV files Jobber's reports export
 * (Insights → Reports → Export to CSV, all columns; help.getjobber.com, as of November 2026):
 *   - Quotes report: "Quote #", "Client name", "Client email address", "Service street"…, "Title",
 *     "Status", "Line items", "Subtotal ($)", "Total ($)", "Discount ($)", "Required deposit ($)",
 *     "Collected deposit ($)", "Drafted date", "Sent date", "Approved date", "Converted date"…;
 *   - Invoices report: "Invoice #", "Client name", "Client email", "Subject", "Created date",
 *     "Issued date", "Due date", "Status", "Line items", "Total ($)", "Balance ($)", "Tax (%)",
 *     "Tax amount ($)", "Discount ($)";
 *   - One-off jobs report: "Job #", "Client name", "Title", "Line items", "Total revenue ($)",
 *     "Schedule start date", "Closed date"…;
 *   - Recurring jobs report: "Job #", "Job title", "Billing type", "Line items", "Total ($)",
 *     "Schedule start date", "Schedule end date"…;
 *   - Visits report (optional): "Job #", "Date", "Visit completed", "Scheduled duration".
 * Headers match whatever their case and spacing. Only what's open comes in: quotes in draft,
 * awaiting response, changes requested or approved; invoices sent and not paid; jobs not closed.
 *
 * The reports have no client ID, so a client is found by email, then by name (and street when two
 * share a name). Jobber's numbers are kept as each record's source ID ("jobber:123"), so importing
 * the same file again adds nothing, and shown in a "Jobber quote #" (job, invoice) field; Crewtavo
 * gives each its own number, so its numbering carries on unbroken.
 *
 * Jobber's recurring jobs report doesn't say how a job repeats. A "Repeating" (or "Frequency")
 * column, as Jobber's own job import has, is read when it's there; otherwise the schedule is worked
 * out from the job's dates in the visits report, when they follow one rule exactly. Anything else
 * comes in without a schedule, for the office to set.
 *
 * A one-off job comes with its visits still to do: those in the visits report, or else one on the
 * one-off report's "Schedule start date". An invoice comes linked to its job when its "Job #s" names
 * one job that comes in (or came in before) for the same client; one that names several, or a job
 * that isn't here, comes in without one, saying so.
 *
 * Line items are read when they're written "Name (quantity, $total)" and add up to the total; then
 * the tax is worked out so the total matches Jobber's to the cent. Otherwise the total comes in as
 * one line, saying so.
 */
import { normalizeKey, sameStreet } from "./clientImport";
import { lineTotal, quoteTotals, taxRateFromPercent } from "./money";
import { occurrenceDates, parseRule, ruleDay } from "./recurrence";
import { isIsoDate } from "./time";

export type JobberFileKind = "clients" | "quotes" | "invoices" | "one_off_jobs" | "recurring_jobs" | "visits";

/** A header as a key: lowercase letters, digits, # and %, so "Service ZIP/postal code" and "service zip / postal code" read alike. */
export const jobberHeader = (header: string) => header.toLowerCase().replace(/\(\$\)/g, "").replace(/[^a-z0-9#%]/g, "");

/** Each column a file is read for, by the names Jobber's reports (and its import files) give it. */
const COLUMNS = {
  quote: ["quote#", "quotenumber", "quoteno"],
  invoice: ["invoice#", "invoicenumber", "invoiceno"],
  job: ["job#", "jobnumber", "jobno"],
  jobs: ["job#s", "jobnumbers"],
  client: ["clientname", "client", "clientfullnamedisplayonly", "name"],
  email: ["clientemailaddress", "clientemail", "email"],
  street: ["servicestreet", "servicestreet1", "propertystreet1", "propertystreet", "street1", "street"],
  city: ["servicecity", "propertycity", "city"],
  region: ["servicestateprovince", "propertystateprovince", "stateprovince", "state"],
  postal: ["servicezippostalcode", "propertyzippostalcode", "zippostalcode", "zip"],
  title: ["title", "quotetitle", "jobtitle", "subject", "invoicesubject"],
  status: ["status", "quotestatus", "invoicestatus", "jobstatus"],
  lines: ["lineitems"],
  subtotal: ["subtotal"],
  total: ["total", "totalrevenue", "totalprice", "invoicetotal"],
  balance: ["balance", "balancedue"],
  discount: ["discount", "quotediscount"],
  taxPercent: ["tax%"],
  taxAmount: ["taxamount"],
  deposit: ["requireddeposit"],
  collected: ["collecteddeposit"],
  created: ["drafteddate", "createddate"],
  sent: ["sentdate"],
  approved: ["approveddate"],
  changes: ["changesrequesteddate"],
  converted: ["converteddate"],
  archived: ["archiveddate"],
  issued: ["issueddate", "invoiceissueddate"],
  due: ["duedate", "invoiceduedate"],
  start: ["schedulestartdate", "startdate"],
  end: ["scheduleenddate", "enddate"],
  closed: ["closeddate"],
  billing: ["billingtype"],
  repeats: ["repeating", "repeats", "frequency", "visitfrequency", "recurrence"],
  date: ["date", "visitdate"],
  completed: ["visitcompleted"],
  duration: ["scheduledduration"],
} as const;
type Column = keyof typeof COLUMNS;

/** Which of Jobber's exports a file is, from its headers; null for one it isn't. The clients export is the client import's (clientImport.ts). */
export function jobberFileKind(headers: readonly string[]): JobberFileKind | null {
  const keys = new Set(headers.map(jobberHeader));
  const has = (column: Column) => COLUMNS[column].some((name) => keys.has(name));
  // The jobs reports list "Quote #" and "Invoice #s" too, and the quotes and invoices reports "Job #s".
  if (has("invoice")) return "invoices";
  if (has("job")) {
    if (has("date") && (keys.has("visittitle") || has("completed"))) return "visits";
    if (has("billing") || has("end") || keys.has("automaticinvoicing") || keys.has("completedvisits")) return "recurring_jobs";
    return "one_off_jobs";
  }
  if (has("quote")) return "quotes";
  if (["jid", "displayname", "firstname", "clientfirstname", "companyname"].some((k) => keys.has(k))) return "clients";
  return null;
}

/** A file's cells by column: the first header Jobber might give it. */
function reader(headers: readonly string[]) {
  const keys = headers.map(jobberHeader);
  const index = Object.fromEntries(
    (Object.keys(COLUMNS) as Column[]).map((column) => {
      for (const name of COLUMNS[column]) {
        const i = keys.indexOf(name);
        if (i >= 0) return [column, i];
      }
      return [column, -1];
    }),
  ) as Record<Column, number>;
  return {
    has: (column: Column) => index[column] >= 0,
    get: (row: readonly string[], column: Column) => (index[column] >= 0 ? (row[index[column]] ?? "").trim() : ""),
  };
}

// ---------------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------------

/** "$1,234.50", "8.875%", "(12.00)" or "-$5" as a number; null when empty or not a number. */
export function jobberNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text.replace(/^\$/, ""));
  const digits = text.replace(/[()$%,\s-]/g, "");
  if (!/^\d*\.?\d+$/.test(digits)) return null;
  return Number(digits) * (negative ? -1 : 1);
}

/** An amount of money (jobberNumber) in whole cents. */
export function jobberMoney(value: string): number | null {
  const n = jobberNumber(value);
  return n === null ? null : Math.round(n * 100) / 100;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => {
  const date = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isIsoDate(date) ? date : null;
};

/**
 * A date as Jobber may write it: "2026-10-03", "Oct 3, 2026", "October 3 2026", "3 Oct 2026" or
 * "10/03/2026" (month first, as in the US, unless the first number can't be a month). A time after
 * it is left off. Null when it isn't a date.
 */
export function jobberDate(value: string): string | null {
  const text = value.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!text) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})/.exec(text);
  if (m && MONTHS.includes(m[1])) return iso(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  m = /^(\d{1,2}) ([a-z]{3})[a-z]*\.? (\d{4})/.exec(text);
  if (m && MONTHS.includes(m[2])) return iso(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(text);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return +m[1] > 12 ? iso(year, +m[2], +m[1]) : iso(year, +m[1], +m[2]);
  }
  return null;
}

/** "Yes", "true", "1", "Completed": whether a visit was done. */
const yes = (value: string) => /^(y|yes|true|1|complete|completed|done)$/i.test(value.trim());

// ---------------------------------------------------------------------------------------------
// Lines and totals
// ---------------------------------------------------------------------------------------------

export interface JobberImportLine { name: string; description: string | null; quantity: number; unit_price: number; taxable: boolean }

/**
 * The "Line items" cell as lines, when it's written "Name (quantity, $total)" item after item
 * (separated by commas, semicolons or new lines); null when it isn't, or something is left over.
 */
export function jobberLineItems(text: string): JobberImportLine[] | null {
  const pattern = /([^,;\n(][^(\n]*?)\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(-?\s*\$?\s*-?[\d,]*\.?\d+)\s*\)\s*(?:[,;\n]+|$)/gy;
  const lines: JobberImportLine[] = [];
  const body = text.trim();
  if (!body) return null;
  let at = 0;
  for (let m = pattern.exec(body); m; m = pattern.exec(body)) {
    const quantity = Number(m[2]);
    const total = jobberMoney(m[3].replace(/\s/g, ""));
    if (total === null || !(quantity > 0)) return null;
    const unit = Math.round((total / quantity) * 100) / 100;
    // A unit price that doesn't come out in whole cents keeps the total, as one of them.
    const exact = lineTotal(quantity, unit) === total;
    lines.push({ name: m[1].trim().slice(0, 200), description: exact ? null : `Quantity ${quantity}`, quantity: exact ? quantity : 1, unit_price: exact ? unit : total, taxable: false });
    at = pattern.lastIndex;
    // Leading separators and spaces before the next item.
    while (at < body.length && /[\s,;]/.test(body[at])) at++;
    pattern.lastIndex = at;
  }
  return lines.length && at >= body.length ? lines : null;
}

export interface FittedTotal {
  lines: JobberImportLine[];
  discount_amount: number;
  /** A fraction, as quotes.tax_rate and invoices.tax_rate keep it. */
  tax_rate: number;
  /** The lines are Jobber's own; false when they came in as one line of the total. */
  itemized: boolean;
}

const cents = (n: number) => Math.round(n * 100);
const sameMoney = (a: number, b: number) => cents(a) === cents(b);
const withTax = (lines: JobberImportLine[], taxable: boolean) => lines.map((l) => ({ ...l, taxable }));

/**
 * Lines, discount and tax rate that come to Jobber's `total` the way Crewtavo adds a quote or
 * invoice up (money.ts quoteTotals, as the database does): the lines taxed at Jobber's rate (or the
 * rate the total implies), or untaxed with Jobber's tax amount as a line of its own. When nothing
 * adds up, one untaxed line of the total, named `name`, with the cell's text as its description.
 */
export function fitJobberTotal(
  lines: JobberImportLine[] | null,
  o: { total: number | null; subtotal?: number | null; discount?: number | null; taxPercent?: number | null; taxAmount?: number | null; name: string; text?: string },
): FittedTotal {
  const discount = Math.max(o.discount ?? 0, 0);
  const total = o.total ?? o.subtotal ?? (lines ? lines.reduce((n, l) => n + lineTotal(l.quantity, l.unit_price), 0) - discount : 0);
  const single = (): FittedTotal => ({
    lines: total ? [{ name: o.name.slice(0, 200), description: o.text?.trim() ? o.text.trim().slice(0, 1000) : null, quantity: 1, unit_price: total, taxable: false }] : [],
    discount_amount: 0,
    tax_rate: 0,
    itemized: false,
  });
  // A total of the lines and no more: the lines, or one line of the subtotal when they aren't readable.
  const items = lines ?? (o.subtotal != null && o.subtotal > 0 ? [{ name: o.name.slice(0, 200), description: o.text?.trim() ? o.text.trim().slice(0, 1000) : null, quantity: 1, unit_price: o.subtotal, taxable: false }] : null);
  if (!items) return single();
  const sum = items.reduce((n, l) => n + lineTotal(l.quantity, l.unit_price), 0);
  if (o.subtotal != null && !sameMoney(sum, o.subtotal)) return single();
  const fits = (candidate: JobberImportLine[], rate: number) => sameMoney(quoteTotals(candidate, { taxRate: rate, discountAmount: discount }).total, total);
  // No tax: the lines stay taxable, so a rate the office adds later taxes them as it would any.
  const taxed = withTax(items, true);
  if (fits(taxed, 0)) return { lines: taxed, discount_amount: discount, tax_rate: 0, itemized: Boolean(lines) };
  // Jobber's quotes report gives its total before the discount.
  if (discount > 0 && sameMoney(sum, total) && o.taxPercent == null) return { lines: taxed, discount_amount: discount, tax_rate: 0, itemized: Boolean(lines) };
  const before = Math.max(sum - discount, 0);
  // Jobber's rate when the file gives one, else the one the total implies.
  const rate = o.taxPercent != null ? taxRateFromPercent(o.taxPercent) : before > 0 ? taxRateFromPercent(Math.round(((total - before) / before) * 100 * 10_000) / 10_000) : 0;
  if (rate > 0 && rate < 1 && fits(taxed, rate)) return { lines: taxed, discount_amount: discount, tax_rate: rate, itemized: Boolean(lines) };
  // Some lines weren't taxed: the tax Jobber charged as a line of its own keeps the total right.
  if (o.taxAmount != null && o.taxAmount > 0 && sameMoney(before + o.taxAmount, total)) {
    return { lines: [...withTax(items, false), { name: "Tax", description: "Charged in Jobber", quantity: 1, unit_price: o.taxAmount, taxable: false }], discount_amount: discount, tax_rate: 0, itemized: Boolean(lines) };
  }
  return single();
}

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, other: 2 };
const DAY_NAMES: Record<string, string> = { mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" };
const WEEK_ORDER = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** A rule the repeat engine reads (recurrence.ts parseRule), or null. */
const checked = (rule: string) => {
  try {
    return parseRule(rule);
  } catch {
    return null;
  }
};

/**
 * How a job repeats, as Jobber writes it ("Weekly", "Every 2 weeks on Tuesday", "BiWeekly",
 * "Monthly on the 15th", "Every 3 months", "Yearly"), as a rule from `start` (whose weekday or day
 * of the month it takes when the text names none). Null for anything else ("As needed", "Custom").
 */
export function jobberRepeatRule(text: string, start: string): string | null {
  const t = text.trim().toLowerCase();
  if (!t || !isIsoDate(start) || /as needed|custom|none|never|one[- ]?off/.test(t)) return null;
  const count = (word: string | undefined) => (word === undefined ? 1 : /^\d+$/.test(word) ? Number(word) : (NUMBERS[word] ?? NaN));
  const every = /every (\d+|[a-z]+)?\s*(day|week|month|year)s?/.exec(t);
  let freq: string | null = null;
  let interval = 1;
  if (/bi-?weekly|fortnight/.test(t)) [freq, interval] = ["WEEKLY", 2];
  else if (/quarterly/.test(t)) [freq, interval] = ["MONTHLY", 3];
  else if (/semi-?annual|twice a year/.test(t)) [freq, interval] = ["MONTHLY", 6];
  else if (every) [freq, interval] = [`${every[2] === "day" ? "DAI" : every[2].toUpperCase()}LY`, count(every[1])];
  else if (/\bdaily\b/.test(t)) freq = "DAILY";
  else if (/\bweekly\b/.test(t)) freq = "WEEKLY";
  else if (/\bmonthly\b/.test(t)) freq = "MONTHLY";
  else if (/\b(yearly|annually|annual)\b/.test(t)) freq = "YEARLY";
  if (!freq || !(interval >= 1)) return null;
  if (freq === "WEEKLY") {
    const days = [...new Set([...t.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*/g)].map((m) => DAY_NAMES[m[1]]))].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
    return checked(`FREQ=WEEKLY;INTERVAL=${interval};BYDAY=${(days.length ? days : [ruleDay(start)]).join(",")}`);
  }
  if (freq === "MONTHLY") {
    const day = Number(/\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(t)?.[1] ?? start.slice(8, 10));
    // The 29th to 31st aren't in every month: the office says what it should be.
    return day >= 1 && day <= 28 ? checked(`FREQ=MONTHLY;INTERVAL=${interval};BYMONTHDAY=${day}`) : null;
  }
  return checked(`FREQ=${freq};INTERVAL=${interval}`);
}

/**
 * A schedule from a job's visit dates (YYYY-MM-DD) when they follow one exactly: weekly or every few
 * weeks on the same weekdays, or monthly or every few months on the same day. At least three dates;
 * a visit moved or skipped makes it no rule (null), so the office sets it.
 */
export function ruleFromVisits(dates: readonly string[]): { rule: string; starts_on: string } | null {
  const days = [...new Set(dates.filter(isIsoDate))].sort();
  if (days.length < 3) return null;
  const first = days[0];
  const last = days[days.length - 1];
  const same = (rule: string) => {
    const got = occurrenceDates({ starts_on: first, recurrence_rule: rule }, first, last);
    return got.length === days.length && got.every((d, i) => d === days[i]);
  };
  const weekdays = [...new Set(days.map(ruleDay))].sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
  for (let weeks = 1; weeks <= 8; weeks++) {
    const rule = `FREQ=WEEKLY;INTERVAL=${weeks};BYDAY=${weekdays.join(",")}`;
    if (same(rule)) return { rule, starts_on: first };
  }
  const day = Number(first.slice(8, 10));
  if (day <= 28 && days.every((d) => Number(d.slice(8, 10)) === day)) {
    for (const months of [1, 2, 3, 4, 6, 12]) {
      const rule = `FREQ=MONTHLY;INTERVAL=${months};BYMONTHDAY=${day}`;
      if (same(rule)) return { rule, starts_on: first };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading the files
// ---------------------------------------------------------------------------------------------

/** Who a row is for, as Jobber writes it, to find among the clients here. */
export interface JobberClientRef { name: string; email: string | null; street: string | null; city: string | null; region: string | null; postal_code: string | null }

interface JobberRecord {
  /** The row in the file (1 is the first after the headers). */
  row: number;
  /** Jobber's number. */
  number: string;
  /** "jobber:" and Jobber's number: found again on a second import. */
  source_id: string;
  client: JobberClientRef;
  lines: JobberImportLine[];
  /** Jobber's line items came in as one line of the total. */
  one_line: boolean;
  created_on: string | null;
  /** What the office should know about it (a deposit Jobber took, lines that didn't add up). */
  notes: string[];
}
export interface JobberOpenQuote extends JobberRecord {
  title: string;
  status: "draft" | "sent" | "changes_requested" | "approved";
  discount_amount: number;
  tax_rate: number;
  deposit_amount: number;
  sent_on: string | null;
  approved_on: string | null;
}
export interface JobberOpenInvoice extends JobberRecord {
  subject: string | null;
  issued_on: string;
  due_on: string;
  discount_amount: number;
  tax_rate: number;
  /** Jobber's total: the invoice comes to this, and what's been paid of it is `paid`. */
  total: number;
  paid: number;
  /** The Jobber job it's for, when it names just one. */
  job_number: string | null;
}
export interface JobberOpenJob extends JobberRecord {
  title: string;
  kind: "one_off" | "recurring";
  /** A recurring job's schedule; null for a one-off, or a recurring job that needs one set. */
  recurrence_rule: string | null;
  starts_on: string | null;
  ends_on: string | null;
  visit_duration_min: number | null;
  /** A recurring job's billing: per visit or a fixed price (Jobber's "Billing type"). */
  pricing: "per_visit" | "fixed" | null;
  /** Recurring in Jobber, but its schedule couldn't be read. */
  needs_schedule: boolean;
  /** A one-off's visits still to do (YYYY-MM-DD), made with it; a recurring job's come from its schedule. */
  visit_dates: string[];
}

export interface JobberProblem { row: number; number: string | null; reason: string }
export interface JobberRead<T> {
  records: T[];
  /** Rows that aren't open work, by why: "Converted", "Paid", "Closed"… */
  left_out: Record<string, number>;
  problems: JobberProblem[];
}

/** A visit in Jobber's visits report, by its job's number. */
export interface JobberVisit { date: string; completed: boolean; duration_min: number | null }

/** The parts every kind shares; null (with a problem) for a row without a number or client. */
function base(get: (column: Column) => string, row: number, number: string, problems: JobberProblem[], seen: Set<string>): Omit<JobberRecord, "lines" | "one_line" | "notes"> | null {
  if (!number) {
    problems.push({ row, number: null, reason: "No number, so it can't be told from the others." });
    return null;
  }
  if (seen.has(number)) {
    problems.push({ row, number, reason: "It's in the file twice: the first one comes in." });
    return null;
  }
  seen.add(number);
  const name = get("client");
  if (!name && !get("email")) {
    problems.push({ row, number, reason: "No client name or email." });
    return null;
  }
  return {
    row,
    number,
    source_id: `jobber:${number}`,
    client: { name, email: get("email").split(/[,;\s]+/)[0]?.toLowerCase() || null, street: get("street") || null, city: get("city") || null, region: get("region") || null, postal_code: get("postal") || null },
    created_on: jobberDate(get("created")),
  };
}

const leave = (left: Record<string, number>, why: string) => {
  left[why] = (left[why] ?? 0) + 1;
};

/** Jobber's quote statuses in Crewtavo's words; "closed" for those that aren't open (with why), null for one it doesn't know. */
function quoteStatus(status: string, dates: { converted: string; archived: string; approved: string; changes: string; sent: string }): JobberOpenQuote["status"] | { closed: string } | null {
  const s = status.trim().toLowerCase();
  if (!s) {
    if (dates.converted) return { closed: "Converted" };
    if (dates.archived) return { closed: "Archived" };
    return dates.approved ? "approved" : dates.changes ? "changes_requested" : dates.sent ? "sent" : "draft";
  }
  if (/^draft/.test(s)) return "draft";
  if (/awaiting|sent|pending/.test(s)) return "sent";
  if (/change/.test(s)) return "changes_requested";
  if (/^approved/.test(s)) return "approved";
  if (/convert/.test(s)) return { closed: "Converted" };
  if (/archiv/.test(s)) return { closed: "Archived" };
  if (/lost|declin|reject|expired/.test(s)) return { closed: "Lost" };
  return null;
}

/** Jobber's quotes report: its open quotes. `rows` has the headers first. */
export function readJobberQuotes(rows: readonly string[][]): JobberRead<JobberOpenQuote> {
  const col = reader(rows[0] ?? []);
  const out: JobberRead<JobberOpenQuote> = { records: [], left_out: {}, problems: [] };
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, i) => {
    const get = (column: Column) => col.get(cells, column);
    const row = i + 1;
    const number = get("quote");
    const status = quoteStatus(get("status"), { converted: get("converted"), archived: get("archived"), approved: get("approved"), changes: get("changes"), sent: get("sent") });
    if (status && typeof status === "object") return leave(out.left_out, status.closed);
    if (!status) return out.problems.push({ row, number: number || null, reason: `Its status "${get("status")}" isn't one of Jobber's.` });
    const b = base(get, row, number, out.problems, seen);
    if (!b) return;
    const title = get("title") || `Quote #${number} from Jobber`;
    const fitted = fitJobberTotal(jobberLineItems(get("lines")), { total: jobberMoney(get("total")), subtotal: jobberMoney(get("subtotal")), discount: jobberMoney(get("discount")), name: title, text: get("lines") });
    const notes: string[] = [];
    if (!fitted.itemized && fitted.lines.length) notes.push("Its line items came in as one line of the total.");
    const collected = jobberMoney(get("collected")) ?? 0;
    if (collected > 0) notes.push(`Jobber collected a $${collected.toFixed(2)} deposit on it: take it off the invoice.`);
    out.records.push({
      ...b, title: title.slice(0, 200), status, lines: fitted.lines, one_line: !fitted.itemized, notes,
      discount_amount: fitted.discount_amount, tax_rate: fitted.tax_rate, deposit_amount: Math.max(jobberMoney(get("deposit")) ?? 0, 0),
      sent_on: jobberDate(get("sent")), approved_on: jobberDate(get("approved")),
    });
  });
  return out;
}

/** Jobber's invoices report: the ones sent and not yet paid, with what's owed. `today` is the company's (YYYY-MM-DD). */
export function readJobberInvoices(rows: readonly string[][], today: string): JobberRead<JobberOpenInvoice> {
  const col = reader(rows[0] ?? []);
  const out: JobberRead<JobberOpenInvoice> = { records: [], left_out: {}, problems: [] };
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, i) => {
    const get = (column: Column) => col.get(cells, column);
    const row = i + 1;
    const number = get("invoice");
    const status = get("status").toLowerCase();
    if (/^draft/.test(status)) return leave(out.left_out, "Draft");
    if (/void/.test(status)) return leave(out.left_out, "Void");
    if (/bad debt|written|uncollect/.test(status)) return leave(out.left_out, "Bad debt");
    const balance = jobberMoney(get("balance"));
    if (/^paid/.test(status) || (balance !== null && balance <= 0)) return leave(out.left_out, "Paid");
    if (balance === null) return out.problems.push({ row, number: number || null, reason: "No balance, so what's owed isn't known." });
    const b = base(get, row, number, out.problems, seen);
    if (!b) return;
    const notes: string[] = [];
    let total = jobberMoney(get("total")) ?? balance;
    if (balance > total + 0.005) {
      notes.push(`Jobber says $${balance.toFixed(2)} is owed, more than its $${total.toFixed(2)} total: it came in owing the balance.`);
      total = balance;
    }
    const subject = get("title") || null;
    const lines = cents(total) === cents(jobberMoney(get("total")) ?? NaN) ? jobberLineItems(get("lines")) : null;
    const fitted = fitJobberTotal(lines, { total, discount: jobberMoney(get("discount")), taxPercent: jobberNumber(get("taxPercent")), taxAmount: jobberMoney(get("taxAmount")), name: subject ?? `Invoice #${number} from Jobber`, text: get("lines") });
    if (!fitted.itemized && fitted.lines.length) notes.push("Its line items came in as one line of the total.");
    const issued = jobberDate(get("issued")) ?? b.created_on ?? today;
    const due = jobberDate(get("due"));
    if (!due) notes.push("No due date in the file: it's due the day it was issued.");
    // An invoice here is for one job at most, so one Jobber made for several comes in without.
    const jobs = [...new Set((get("jobs") || get("job")).split(/[,;\s]+/).map((n) => n.replace(/^#/, "")).filter(Boolean))];
    if (jobs.length > 1) notes.push(`It's for Jobber jobs ${jobs.map((n) => `#${n}`).join(", ")}, and an invoice here is for one job: it came in without one.`);
    out.records.push({
      ...b, subject: subject?.slice(0, 200) ?? null, lines: fitted.lines, one_line: !fitted.itemized, notes,
      issued_on: issued, due_on: due ?? issued, discount_amount: fitted.discount_amount, tax_rate: fitted.tax_rate,
      total, paid: Math.max(Math.round((total - balance) * 100) / 100, 0), job_number: jobs.length === 1 ? jobs[0]! : null,
    });
  });
  return out;
}

/** Jobber's visits report: each job's visits, by its number. */
export function readJobberVisits(rows: readonly string[][]): Map<string, JobberVisit[]> {
  const col = reader(rows[0] ?? []);
  const visits = new Map<string, JobberVisit[]>();
  for (const cells of rows.slice(1)) {
    const job = col.get(cells, "job");
    const date = jobberDate(col.get(cells, "date"));
    if (!job || !date) continue;
    const hours = Number(col.get(cells, "duration"));
    visits.set(job, [...(visits.get(job) ?? []), { date, completed: yes(col.get(cells, "completed")), duration_min: hours > 0 ? Math.round(hours * 60) : null }]);
  }
  return visits;
}

/**
 * Jobber's one-off or recurring jobs report: the jobs not closed. A recurring job's schedule comes
 * from a "Repeating" column, else from its dates in the visits report (`visits`), else it has none
 * and needs_schedule says so. A one-off's visits are its ones in the visits report not done yet, or
 * else its schedule start date. `today` is the company's (YYYY-MM-DD).
 */
export function readJobberJobs(rows: readonly string[][], kind: JobberOpenJob["kind"], today: string, visits: ReadonlyMap<string, JobberVisit[]> = new Map()): JobberRead<JobberOpenJob> {
  const col = reader(rows[0] ?? []);
  const out: JobberRead<JobberOpenJob> = { records: [], left_out: {}, problems: [] };
  const seen = new Set<string>();
  rows.slice(1).forEach((cells, i) => {
    const get = (column: Column) => col.get(cells, column);
    const row = i + 1;
    const number = get("job");
    const status = get("status").toLowerCase();
    const ends = jobberDate(get("end"));
    if (get("closed") || /closed|archiv|complete|cancel/.test(status)) return leave(out.left_out, "Closed");
    if (kind === "recurring" && ends && ends < today) return leave(out.left_out, "Ended");
    const b = base(get, row, number, out.problems, seen);
    if (!b) return;
    const title = (get("title") || `Job #${number} from Jobber`).slice(0, 200);
    const lines = jobberLineItems(get("lines"));
    const notes: string[] = [];
    let fitted: Pick<FittedTotal, "lines" | "itemized">;
    if (kind === "recurring") {
      // A recurring job's total is all its visits', not one visit's: only its own line items are worth keeping.
      fitted = { lines: withTax(lines ?? [], true), itemized: Boolean(lines) };
      if (!lines) notes.push("Its line items couldn't be read: add them to the job.");
    } else {
      const f = fitJobberTotal(lines, { total: jobberMoney(get("total")), name: title, text: get("lines") });
      fitted = { lines: withTax(f.lines, true), itemized: f.itemized };
      if (!f.itemized && f.lines.length) notes.push("Its line items came in as one line of the total.");
    }
    const own = visits.get(number) ?? [];
    const starts = jobberDate(get("start")) ?? own.map((v) => v.date).sort()[0] ?? null;
    let rule: string | null = null;
    let startsOn = kind === "recurring" ? starts : null;
    if (kind === "recurring") {
      if (get("repeats") && starts) rule = jobberRepeatRule(get("repeats"), starts);
      if (!rule) {
        // Visits still to come, when there are enough: past ones were often moved for rain.
        const upcoming = own.filter((v) => v.date >= today).map((v) => v.date);
        const found = ruleFromVisits(upcoming.length >= 3 ? upcoming : own.map((v) => v.date));
        if (found) [rule, startsOn] = [found.rule, found.starts_on];
      }
    }
    let visitDates: string[] = [];
    if (kind === "one_off") {
      if (own.length) visitDates = [...new Set(own.filter((v) => !v.completed).map((v) => v.date))].sort();
      else if (starts && (starts >= today || /late/.test(status))) visitDates = [starts];
      // A day gone by may have had its visit: Jobber's report doesn't say, unless it's late or done.
      else if (starts && !/invoic/.test(status)) notes.push(`Jobber had it scheduled for ${starts}: schedule its visit if the work's still to do.`);
    }
    const durations = own.map((v) => v.duration_min).filter((d): d is number => d !== null);
    const billing = get("billing").toLowerCase();
    out.records.push({
      ...b, title, lines: fitted.lines, one_line: !fitted.itemized, notes, kind,
      recurrence_rule: rule, starts_on: startsOn, ends_on: kind === "recurring" ? ends : null,
      visit_duration_min: durations.length ? durations[0] : null,
      pricing: kind === "recurring" ? (/fixed/.test(billing) ? "fixed" : "per_visit") : null,
      needs_schedule: kind === "recurring" && !rule,
      visit_dates: visitDates,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Finding each one's client
// ---------------------------------------------------------------------------------------------

export interface KnownClient { id: string; display_name: string; email: string | null }
export interface KnownProperty { id: string; client_id: string; line1: string; city: string | null }
export interface FoundClient {
  client_id: string;
  property_id: string | null;
  /** The street isn't one of the client's properties yet: add it, then use it. */
  new_property: { line1: string; city: string | null; region: string | null; postal_code: string | null } | null;
}

/**
 * The client a row is for: the one with its email (and its name, when several share the email),
 * else the only one with its name, or of several, the one at its street. With the client found,
 * the property at that street, or the client's only one when the row gives none.
 */
export function findJobberClient(ref: JobberClientRef, clients: readonly KnownClient[], properties: readonly KnownProperty[]): FoundClient | { problem: string; missing: boolean } {
  const name = normalizeKey(ref.name);
  const named = (list: readonly KnownClient[]) => list.filter((c) => normalizeKey(c.display_name) === name);
  const atStreet = (list: readonly KnownClient[]) => (ref.street ? list.filter((c) => properties.some((p) => p.client_id === c.id && sameStreet(p.line1, ref.street!))) : []);
  // Of several, the one with its name, else the one at its street.
  const narrow = (list: readonly KnownClient[]) => (list.length < 2 ? list : named(list).length === 1 ? named(list) : atStreet(named(list).length ? named(list) : list));
  const withEmail = ref.email ? clients.filter((c) => c.email?.trim().toLowerCase() === ref.email) : [];
  const candidates = withEmail.length ? withEmail : name ? named(clients) : [];
  const found = narrow(candidates);
  if (candidates.length > 1 && found.length !== 1) return { problem: `${candidates.length} clients here could be ${ref.name || ref.email}, and none is the one at its street.`, missing: false };
  if (found.length !== 1) return { problem: `${ref.name || ref.email} isn't a client here yet.`, missing: true };
  const client = found[0];
  const theirs = properties.filter((p) => p.client_id === client.id);
  const property = ref.street ? theirs.find((p) => sameStreet(p.line1, ref.street!)) : theirs.length === 1 ? theirs[0] : undefined;
  return {
    client_id: client.id,
    property_id: property?.id ?? null,
    new_property: !property && ref.street ? { line1: ref.street.slice(0, 200), city: ref.city, region: ref.region, postal_code: ref.postal_code } : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The whole import
// ---------------------------------------------------------------------------------------------

export type JobberWorkKind = "quotes" | "invoices" | "jobs";
type Open = { quotes: JobberOpenQuote; invoices: JobberOpenInvoice; jobs: JobberOpenJob };

export interface JobberPlanned<T> {
  /** Ready to come in, each with the client (and property) it's for. */
  ready: Array<{ record: T; found: FoundClient }>;
  /** Brought in before: left as they are. */
  already: number;
  left_out: Record<string, number>;
  problems: JobberProblem[];
  /** Rows whose client isn't here yet (Jobber's clients export brings them). */
  missing_clients: number;
}
export type JobberPlan = { [K in JobberWorkKind]: JobberPlanned<Open[K]> };

/** Jobber's exports by kind, each with its headers first. */
export type JobberFiles = Partial<Record<Exclude<JobberFileKind, "clients">, readonly string[][]>>;

/**
 * What an import of these files would do, against the clients and properties here and the source
 * IDs already brought in (by kind). The two jobs reports are one list, as Jobber numbers its jobs
 * once. `today` is the company's (YYYY-MM-DD).
 */
export function planJobberImport(
  files: JobberFiles,
  here: { clients: readonly KnownClient[]; properties: readonly KnownProperty[]; imported: { [K in JobberWorkKind]: ReadonlySet<string> }; today: string },
): JobberPlan {
  const visits = files.visits ? readJobberVisits(files.visits) : new Map<string, JobberVisit[]>();
  const empty = <T>(): JobberRead<T> => ({ records: [], left_out: {}, problems: [] });
  const oneOff = files.one_off_jobs ? readJobberJobs(files.one_off_jobs, "one_off", here.today, visits) : empty<JobberOpenJob>();
  const recurring = files.recurring_jobs ? readJobberJobs(files.recurring_jobs, "recurring", here.today, visits) : empty<JobberOpenJob>();
  const jobs: JobberRead<JobberOpenJob> = { records: [...recurring.records], left_out: { ...oneOff.left_out }, problems: [...recurring.problems, ...oneOff.problems] };
  for (const [why, n] of Object.entries(recurring.left_out)) jobs.left_out[why] = (jobs.left_out[why] ?? 0) + n;
  for (const job of oneOff.records) {
    if (jobs.records.some((j) => j.number === job.number)) jobs.problems.push({ row: job.row, number: job.number, reason: "It's in both jobs files: the recurring one comes in." });
    else jobs.records.push(job);
  }
  const plan = <K extends JobberWorkKind>(kind: K, read: JobberRead<Open[K]>): JobberPlanned<Open[K]> => {
    const out: JobberPlanned<Open[K]> = { ready: [], already: 0, left_out: read.left_out, problems: [...read.problems], missing_clients: 0 };
    for (const record of read.records) {
      if (here.imported[kind].has(record.source_id)) {
        out.already++;
        continue;
      }
      const found = findJobberClient(record.client, here.clients, here.properties);
      if ("problem" in found) {
        out.problems.push({ row: record.row, number: record.number, reason: found.problem });
        if (found.missing) out.missing_clients++;
      } else out.ready.push({ record, found });
    }
    return out;
  };
  return {
    quotes: plan("quotes", files.quotes ? readJobberQuotes(files.quotes) : empty()),
    invoices: plan("invoices", files.invoices ? readJobberInvoices(files.invoices, here.today) : empty()),
    jobs: plan("jobs", jobs),
  };
}

/** A record as import_jobber takes it (20261105000300_jobber_import.sql), for its client and property. */
export function jobberImportRow(kind: JobberWorkKind, record: JobberOpenQuote | JobberOpenInvoice | JobberOpenJob, client_id: string, property_id: string | null): Record<string, unknown> {
  const shared = { source_id: record.source_id, number: record.number, client_id, lines: record.lines, created_on: record.created_on };
  if (kind === "quotes") {
    const q = record as JobberOpenQuote;
    return { ...shared, property_id, title: q.title, status: q.status, discount_amount: q.discount_amount, tax_rate: q.tax_rate, deposit_amount: q.deposit_amount, sent_on: q.sent_on, approved_on: q.approved_on };
  }
  if (kind === "invoices") {
    const i = record as JobberOpenInvoice;
    return { ...shared, subject: i.subject, issued_on: i.issued_on, due_on: i.due_on, discount_amount: i.discount_amount, tax_rate: i.tax_rate, total: i.total, paid: i.paid, job_source_id: i.job_number ? `jobber:${i.job_number}` : null };
  }
  const j = record as JobberOpenJob;
  return { ...shared, property_id, title: j.title, kind: j.kind, recurrence_rule: j.recurrence_rule, starts_on: j.starts_on, ends_on: j.ends_on, visit_duration_min: j.visit_duration_min, pricing: j.pricing, visit_dates: j.visit_dates };
}
