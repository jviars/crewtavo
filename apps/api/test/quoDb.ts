/**
 * An in-memory stand-in for the database, as far as Quo's code uses it (quo.test.ts): tables of
 * rows, the PostgREST filters it reads with, the unique rules a second write runs into (the
 * migration's primary keys and messages_call_once), Storage, the sign-in emails and the RPCs.
 */
import type { Db } from "../src/lib/supabase";

export type Row = Record<string, any>;

/** The columns that make a row unique in each table (what an upsert replaces, an insert runs into). */
const UNIQUE: Record<string, (row: Row) => string | null> = {
  integrations: (r) => `${r.company_id}|${r.provider}`,
  integration_secrets: (r) => `${r.company_id}|${r.provider}`,
  quo_events: (r) => `${r.company_id}|${r.event_id}`,
  quo_sent: (r) => `${r.company_id}|${r.message_id}`,
  conversations_done: (r) => `${r.client_id}`,
  messages: (r) => (r.channel === "call" && r.external_id ? `${r.company_id}|${r.client_id}|${r.external_id}` : null),
  unknown_texts: (r) => (r.channel === "call" && r.external_id ? `${r.company_id}|${r.external_id}` : null),
};

let ids = 0;

export interface MemoryDb {
  db: Db;
  tables: Record<string, Row[]>;
  /** Files put in Storage, by path. */
  files: Map<string, { bytes: Uint8Array; contentType?: string }>;
  rpcs: Array<{ name: string; args: Row }>;
}

export function memoryDb(seed: Record<string, Row[]> = {}, emails: Record<string, string> = {}): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const files = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const rpcs: Array<{ name: string; args: Row }> = [];
  const table = (name: string) => (tables[name] ??= []);

  const from = (name: string) => {
    let op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: Row[] = [];
    let patch: Row = {};
    let columns = "*";
    let counting = false;
    let head = false;
    let returning = false;
    let one: "single" | "maybe" | null = null;
    let limit = Infinity;
    let order: { column: string; ascending: boolean } | null = null;
    const tests: Array<(row: Row) => boolean> = [];

    const matches = (row: Row) => tests.every((test) => test(row));
    /** A column, or a JSON field in one ("call->>rev", read as text as PostgREST does). */
    const read = (row: Row, column: string) => {
      const [col, field] = column.split("->>");
      if (field === undefined) return row[col!];
      const value = (row[col!] ?? null)?.[field];
      return value === undefined || value === null ? null : String(value);
    };
    const embed = (row: Row): Row => {
      const out = { ...row };
      // client:clients(display_name): the client the row belongs to.
      if (/client:clients\(/.test(columns)) out.client = table("clients").find((c) => c.id === row.client_id) ?? null;
      return out;
    };
    const run = (): { data: unknown; error: { message: string; code?: string } | null; count?: number } => {
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const unique = UNIQUE[name];
        const added: Row[] = [];
        for (const input of payload) {
          const row: Row = { id: input.id ?? `${name}-${++ids}`, created_at: input.created_at ?? new Date().toISOString(), ...input };
          const key = unique?.(row) ?? null;
          const at = key === null ? -1 : rows.findIndex((r) => unique!(r) === key);
          if (at >= 0) {
            if (op === "insert") return { data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } };
            rows[at] = { ...rows[at], ...input };
            added.push(rows[at]!);
          } else {
            rows.push(row);
            added.push(row);
          }
        }
        const data = returning ? added.map(embed) : null;
        return { data: one ? (data as Row[] | null)?.[0] ?? null : data, error: null };
      }
      let found = rows.filter(matches);
      if (op === "update") {
        for (const row of found) Object.assign(row, patch);
        return { data: returning ? found.map(embed) : null, error: null };
      }
      if (op === "delete") {
        tables[name] = rows.filter((r) => !found.includes(r));
        return { data: returning ? found : null, error: null };
      }
      if (order) {
        const { column, ascending } = order;
        found = [...found].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
      }
      found = found.slice(0, limit);
      if (counting && head) return { data: null, error: null, count: found.length };
      const data = found.map(embed);
      if (one) {
        if (one === "single" && data.length !== 1) return { data: null, error: { message: "not one row" } };
        return { data: data[0] ?? null, error: null };
      }
      return { data, error: null, ...(counting ? { count: data.length } : {}) };
    };

    const builder: any = {
      select(cols = "*", options: { count?: string; head?: boolean } = {}) {
        if (op === "select") columns = cols;
        else returning = true;
        counting = Boolean(options.count);
        head = Boolean(options.head);
        return builder;
      },
      insert(rows: Row | Row[]) {
        op = "insert";
        payload = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      upsert(rows: Row | Row[]) {
        op = "upsert";
        payload = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      update(values: Row) {
        op = "update";
        patch = values;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq: (c: string, v: unknown) => (tests.push((r) => r[c] === v), builder),
      neq: (c: string, v: unknown) => (tests.push((r) => r[c] !== v), builder),
      in: (c: string, vs: unknown[]) => (tests.push((r) => vs.includes(r[c])), builder),
      is: (c: string, v: unknown) => (tests.push((r) => (r[c] ?? null) === v), builder),
      not: (c: string, operator: string, v: unknown) => (tests.push((r) => (operator === "is" ? (r[c] ?? null) !== v : r[c] !== v)), builder),
      lt: (c: string, v: unknown) => (tests.push((r) => r[c] < (v as never)), builder),
      lte: (c: string, v: unknown) => (tests.push((r) => r[c] <= (v as never)), builder),
      gt: (c: string, v: unknown) => (tests.push((r) => r[c] > (v as never)), builder),
      gte: (c: string, v: unknown) => (tests.push((r) => r[c] >= (v as never)), builder),
      match: (values: Row) => (tests.push((r) => Object.entries(values).every(([k, v]) => r[k] === v)), builder),
      filter: (c: string, operator: string, v: string | null) => {
        if (operator === "match") tests.push((r) => typeof r[c] === "string" && new RegExp(v!).test(r[c]));
        if (operator === "eq") tests.push((r) => read(r, c) === v);
        if (operator === "is") tests.push((r) => read(r, c) === v);
        return builder;
      },
      order: (column: string, options: { ascending?: boolean } = {}) => ((order = { column, ascending: options.ascending !== false }), builder),
      limit: (n: number) => ((limit = n), builder),
      maybeSingle: () => ((one = "maybe"), builder),
      single: () => ((one = "single"), builder),
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return builder;
  };

  const db = {
    from,
    rpc: async (name: string, args: Row) => {
      rpcs.push({ name, args });
      // The rate limiter: always room in these tests.
      if (name === "rate_limit_hit") return { data: true, error: null };
      return { data: null, error: null };
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array, options: { contentType?: string } = {}) => {
          files.set(path, { bytes, contentType: options.contentType });
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => {
          for (const p of paths) files.delete(p);
          return { data: null, error: null };
        },
      }),
    },
    auth: {
      // Whoever signs in is the first user with an email given (the tests' owner).
      getClaims: async () => ({ data: { claims: { sub: Object.keys(emails)[0] ?? "user" } }, error: null }),
      admin: {
        getUserById: async (id: string) => ({ data: { user: emails[id] ? { id, email: emails[id] } : null }, error: emails[id] ? null : { message: "not found" } }),
      },
    },
  };
  return { db: db as unknown as Db, tables, files, rpcs };
}
