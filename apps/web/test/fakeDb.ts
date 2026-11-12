/**
 * For the tests: a database that answers supabase-js the way PostgREST does where it matters for
 * long results. It sends at most 1,000 rows a request whatever limit or range is asked for
 * (PGRST_DB_MAX_ROWS), and rows the query's order doesn't tell apart come back in a different order
 * on every request, as Postgres is free to send them. So a read that asks once for everything, or
 * pages without an order, or with an order that has ties, loses rows here as it does there.
 * Filters it doesn't know throw, rather than letting a test pass on rows that were never filtered.
 */
export const MAX_ROWS = 1000;

export type Row = Record<string, unknown>;
/** One request as the database got it: `order` as PostgREST's own parameter ("day.desc,id.asc"). */
export interface FakeRequest { table: string; order: string; from: number | null; to: number | null; limit: number | null; sent: number }
interface Answer { data: Row[] | null; error: { message: string; code: string } | null; count: number | null; status: number }

/** Rows in another order for each `seed`, the same every run. */
function shuffled<T>(rows: readonly T[], seed: number): T[] {
  const out = [...rows];
  let state = seed * 2654435761;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const compare = (a: unknown, b: unknown) => (a === b ? 0 : (a as number | string) < (b as number | string) ? -1 : 1);

class FakeQuery implements PromiseLike<Answer> {
  private tests: Array<(row: Row) => boolean> = [];
  private sorts: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];
  private window: { from: number; to: number } | null = null;
  private max: number | null = null;
  private counting = false;

  constructor(private db: FakeDb, private table: string) {}

  private where(column: string, test: (value: unknown) => boolean) {
    if (column.includes(".")) throw new Error(`The fake database can't filter on ${column}`);
    this.tests.push((row) => test(row[column]));
    return this;
  }

  select(_columns?: string, options: { count?: "exact" } = {}) {
    this.counting = options.count === "exact";
    return this;
  }
  eq(column: string, value: unknown) { return this.where(column, (v) => v === value); }
  neq(column: string, value: unknown) { return this.where(column, (v) => v !== value); }
  gt(column: string, value: unknown) { return this.where(column, (v) => v != null && compare(v, value) > 0); }
  gte(column: string, value: unknown) { return this.where(column, (v) => v != null && compare(v, value) >= 0); }
  lt(column: string, value: unknown) { return this.where(column, (v) => v != null && compare(v, value) < 0); }
  lte(column: string, value: unknown) { return this.where(column, (v) => v != null && compare(v, value) <= 0); }
  in(column: string, values: readonly unknown[]) { return this.where(column, (v) => values.includes(v)); }
  is(column: string, value: null) { return this.where(column, (v) => (v ?? null) === value); }
  contains(column: string, values: readonly unknown[]) { return this.where(column, (v) => values.every((x) => (v as unknown[]).includes(x))); }
  not(column: string, operator: string, value: unknown) {
    if (operator === "is" && value === null) return this.where(column, (v) => v != null);
    if (operator === "in") return this.where(column, (v) => !String(value).slice(1, -1).split(",").includes(String(v)));
    throw new Error(`The fake database doesn't know not.${operator}`);
  }
  order(column: string, { ascending = true, nullsFirst = !ascending }: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.sorts.push({ column, ascending, nullsFirst });
    return this;
  }
  range(from: number, to: number) {
    this.window = { from, to };
    return this;
  }
  limit(count: number) {
    this.max = count;
    return this;
  }

  private answer(): Answer {
    const stored = this.db.tables[this.table];
    if (!stored) return { data: null, error: { message: `relation "public.${this.table}" does not exist`, code: "42P01" }, count: null, status: 404 };
    const unknown = this.sorts.find((s) => stored.length > 0 && !(s.column in stored[0]!));
    if (unknown) return { data: null, error: { message: `column ${this.table}.${unknown.column} does not exist`, code: "42703" }, count: null, status: 400 };
    const found = shuffled(stored.filter((row) => this.tests.every((test) => test(row))), this.db.requests.length + 1);
    found.sort((a, b) => {
      for (const { column, ascending, nullsFirst } of this.sorts) {
        const [x, y] = [a[column] ?? null, b[column] ?? null];
        if (x === y) continue;
        if (x === null || y === null) return (x === null) === nullsFirst ? -1 : 1;
        return ascending ? compare(x, y) : compare(y, x);
      }
      return 0;
    });
    const from = this.window?.from ?? 0;
    // Asked to start past the last row while counting them: PostgREST refuses (416).
    if (this.counting && from > found.length) return { data: null, error: { message: "Requested range not satisfiable", code: "PGRST103" }, count: null, status: 416 };
    const asked = Math.min(this.window ? this.window.to - from + 1 : Infinity, this.max ?? Infinity);
    const data = found.slice(from, from + Math.min(asked, MAX_ROWS));
    this.db.requests.push({
      table: this.table,
      order: this.sorts.map((s) => `${s.column}.${s.ascending ? "asc" : "desc"}`).join(","),
      from: this.window?.from ?? null,
      to: this.window?.to ?? null,
      limit: this.max,
      sent: data.length,
    });
    return { data, error: null, count: this.counting ? found.length : null, status: 200 };
  }

  then<A = Answer, B = never>(resolve?: ((answer: Answer) => A | PromiseLike<A>) | null, reject?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return new Promise<Answer>((done) => {
      this.db.beforeAnswer?.(this.db.requests.length);
      done(this.db.failing ? { data: null, error: this.db.failing, count: null, status: 500 } : this.answer());
    }).then(resolve, reject);
  }
}

/** A supabase client over tables kept in memory: `from(table)` reads, and `rpc(name)` calls `functions[name]`. */
export class FakeDb {
  /** Every read answered so far, in order. */
  readonly requests: FakeRequest[] = [];
  /** Function calls answered so far: the name and what it was given. */
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Set to make every request fail with this error. */
  failing: { message: string; code: string } | null = null;
  /** Called before each read is answered with how many were answered before it, to change rows between pages. */
  beforeAnswer: ((answered: number) => void) | null = null;

  constructor(public tables: Record<string, Row[]>, private functions: Record<string, (args: never) => Row[]> = {}) {}

  from(table: string) {
    return new FakeQuery(this, table);
  }

  /** A database function's rows, cut at 1,000 as a table's are. */
  rpc(name: string, args: Record<string, unknown> = {}): Promise<Answer> {
    this.calls.push({ name, args });
    const run = this.functions[name];
    if (!run) return Promise.resolve({ data: null, error: { message: `function ${name} does not exist`, code: "PGRST202" }, count: null, status: 404 });
    return Promise.resolve({ data: run(args as never).slice(0, MAX_ROWS), error: null, count: null, status: 200 });
  }
}
