/**
 * Coming from Jobber (Settings → Your data): the open quotes, unpaid invoices and active jobs in
 * Jobber's report exports. packages/core/src/jobberImport.ts reads the files and finds each row's
 * client; import_jobber (20261105000300_jobber_import.sql) brings them in 100 at a time, quietly (no
 * emails, no charges, no trip, minimum or late fees) and once (a second import adds nothing). A
 * Jobber clients export among the files goes in first, through the client import, and jobs before
 * invoices, which link to theirs (20261106000510_jobber_import_visits_and_invoice_jobs.sql).
 */
import { planImport, streetKey, type ExistingClient } from "@crewtavo/core/clientImport";
import {
  jobberFileKind, jobberImportRow, planJobberImport, type FoundClient, type JobberFileKind, type JobberFiles, type JobberPlan, type JobberWorkKind,
  type KnownClient, type KnownProperty,
} from "@crewtavo/core/jobberImport";
import { localDate } from "@crewtavo/core/time";
import { api, supabase, unwrap } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import { everyRow } from "@/lib/paging";
import { queryClient } from "@/lib/queryClient";
import { startTask } from "@/lib/tasks";
import { customFieldsKey } from "../customFields/CustomFields";
import { guessMapping, importClients, toClients, type ImportClient } from "../clients/importClients";

export interface ChosenFile { name: string; kind: JobberFileKind | null; rows: string[][] }

export const FILE_LABELS: Record<JobberFileKind, string> = {
  clients: "Clients",
  quotes: "Quotes report",
  invoices: "Invoices report",
  one_off_jobs: "One-off jobs report",
  recurring_jobs: "Recurring jobs report",
  visits: "Visits report",
};

/** A file the office chose, and which of Jobber's exports it is (null: none we know). */
export async function readFile(file: File): Promise<ChosenFile> {
  if (file.size > 10_000_000) throw new Error(`${file.name} is over 10 MB. Export a shorter date range from Jobber.`);
  const rows = parseCsv(await file.text());
  // The headers, past any title lines above them.
  const start = Math.max(rows.slice(0, 5).findIndex((row) => jobberFileKind(row)), 0);
  return { name: file.name, kind: rows.length ? jobberFileKind(rows[start]!) : null, rows: rows.slice(start) };
}

interface Here { clients: Array<ExistingClient & KnownClient>; properties: KnownProperty[]; imported: { [K in JobberWorkKind]: Set<string> } }

/** An import is checked against everything already here, however much that is. */
const ALL = { most: Infinity };

/** The clients, properties and Jobber records already here. */
async function loadHere(companyId: string): Promise<Here> {
  const db = supabase();
  const [clients, properties, quotes, invoices, jobs] = await Promise.all([
    everyRow(() => db.from("clients").select("id, display_name, email, status, custom_fields").eq("company_id", companyId), ALL),
    everyRow(() => db.from("properties").select("id, client_id, line1, city").eq("company_id", companyId), ALL),
    everyRow(() => db.from("quotes").select("source_id").eq("company_id", companyId).not("source_id", "is", null), ALL),
    everyRow(() => db.from("invoices").select("source_id").eq("company_id", companyId).not("source_id", "is", null), ALL),
    everyRow(() => db.from("jobs").select("source_id").eq("company_id", companyId).not("source_id", "is", null), ALL),
  ]);
  const ids = (rows: Array<{ source_id: string | null }>) => new Set(rows.map((r) => r.source_id!));
  return {
    clients: clients.map((c) => ({ id: c.id, display_name: c.display_name, email: c.email, status: c.status, source_id: ((c.custom_fields ?? {}) as { source_id?: string }).source_id ?? null })),
    properties,
    imported: { quotes: ids(quotes), invoices: ids(invoices), jobs: ids(jobs) },
  };
}

export interface Preview {
  plan: JobberPlan;
  /** From a Jobber clients export among the files. */
  clients: ImportClient[];
  newClients: number;
}

const workFiles = (files: readonly ChosenFile[]): JobberFiles =>
  Object.fromEntries(files.filter((f) => f.kind && f.kind !== "clients").map((f) => [f.kind, f.rows]));

/** Each Jobber clients (or properties) export among the files, as the client import reads it. */
const clientFiles = (files: readonly ChosenFile[]) => files.filter((f) => f.kind === "clients").map((f) => ({ name: f.name, clients: toClients(f.rows.slice(1), guessMapping(f.rows[0]!)) }));

/** The clients of every clients file as one list: the same client in two (Clients, then Properties) once, with all their properties. */
function fileClients(files: readonly ChosenFile[]): ImportClient[] {
  const merged = new Map<string, ImportClient>();
  for (const c of clientFiles(files).flatMap((f) => f.clients)) {
    const had = merged.get(c.key);
    if (had) had.properties.push(...c.properties);
    else merged.set(c.key, { ...c, properties: [...c.properties] });
  }
  return [...merged.values()];
}

/**
 * What would come in. Clients the clients file would add count as here already (with stand-in
 * ids), so their work shows as ready rather than missing.
 */
export async function previewImport(companyId: string, timeZone: string, files: readonly ChosenFile[]): Promise<Preview> {
  const here = await loadHere(companyId);
  const clients = fileClients(files);
  const decisions = planImport(clients, here.clients, new Map()).decisions;
  const byKey = new Map(clients.map((c) => [c.key, c]));
  const coming = decisions.map((d) => ({ id: d.client_id ?? `new:${d.key}`, client: byKey.get(d.key)!, isNew: !d.client_id }));
  const plan = planJobberImport(workFiles(files), {
    clients: [...here.clients, ...coming.filter((c) => c.isNew).map((c) => ({ id: c.id, display_name: c.client.display_name, email: c.client.email }))],
    properties: [...here.properties, ...coming.flatMap((c) => c.client.properties.map((p, i) => ({ id: `${c.id}:${i}`, client_id: c.id, line1: p.line1, city: p.city })))],
    imported: here.imported,
    today: localDate(new Date(), timeZone),
  });
  return { plan, clients, newClients: coming.filter((c) => c.isNew).length };
}

export interface Brought { id: string; number: number | null; jobber: string; title: string }
export interface ImportSummary {
  clients: number;
  created: { [K in JobberWorkKind]: number };
  already: { [K in JobberWorkKind]: number };
  /** Recurring in Jobber, made without a schedule: the office sets it. */
  needsSchedule: Brought[];
  /** What the office should know about ones brought in (a deposit Jobber took). */
  notes: Array<Brought & { kind: JobberWorkKind; note: string }>;
  /** Rows that didn't come in, and why. */
  skipped: Array<{ kind: JobberWorkKind; number: string | null; reason: string }>;
  stopped: boolean;
}

const BATCH = 100;
// Jobs before invoices, so an invoice finds the job it's for.
const KINDS: JobberWorkKind[] = ["quotes", "jobs", "invoices"];
const ONE: Record<JobberWorkKind, string> = { quotes: "quote", invoices: "invoice", jobs: "job" };
const plural = (n: number, kind: JobberWorkKind) => `${n} ${n === 1 ? ONE[kind] : kind}`;

/**
 * Brings it all in as a background task (lib/tasks.ts): the clients file first, then each kind,
 * matched again against the clients now here. A street a client doesn't have yet becomes their
 * property first. Cancel stops after the batch that's going; importing again finishes the job.
 */
export async function runImport(companyId: string, timeZone: string, files: readonly ChosenFile[], onTask?: (id: number) => void): Promise<ImportSummary> {
  const control = { stopped: false };
  const task = startTask({ label: "Bringing work over from Jobber", cancel: () => (control.stopped = true) });
  onTask?.(task.id);
  const summary: ImportSummary = { clients: 0, created: { quotes: 0, invoices: 0, jobs: 0 }, already: { quotes: 0, invoices: 0, jobs: 0 }, needsSchedule: [], notes: [], skipped: [], stopped: false };
  try {
    // One file after another, as the client import is used: a client the first brought in gets the second's properties.
    for (const file of clientFiles(files)) {
      if (control.stopped || !file.clients.length) continue;
      task.rename("Bringing work over from Jobber", "Clients");
      summary.clients += (await importClients(companyId, file.clients, { fileName: file.name })).created;
    }
    const here = await loadHere(companyId);
    const plan = planJobberImport(workFiles(files), { ...here, today: localDate(new Date(), timeZone) });
    let done = 0;
    task.progress(0, KINDS.reduce((n, k) => n + plan[k].ready.length, 0) || 1);

    // New properties first, one per client and street, then on the map.
    const added = new Map<string, string>();
    const wanted = new Map<string, NonNullable<FoundClient["new_property"]> & { client_id: string }>();
    for (const kind of ["quotes", "jobs"] as const) {
      for (const { found } of plan[kind].ready) if (found.new_property) wanted.set(`${found.client_id}|${streetKey(found.new_property.line1)}`, { ...found.new_property, client_id: found.client_id });
    }
    const places = [...wanted.entries()].map(([key, p]) => ({ key, row: { ...p, id: crypto.randomUUID(), company_id: companyId } }));
    for (let i = 0; i < places.length; i += 200) {
      const chunk = places.slice(i, i + 200);
      unwrap(await supabase().from("properties").insert(chunk.map((p) => p.row)));
      for (const p of chunk) added.set(p.key, p.row.id);
    }
    if (added.size) await api.post("/properties/geocode", { ids: [...added.values()] }).catch(() => undefined);

    const repeating: string[] = [];
    for (const kind of KINDS) {
      const { ready, already, problems } = plan[kind];
      summary.already[kind] = already;
      summary.skipped.push(...problems.map((p) => ({ kind, number: p.number, reason: p.reason })));
      for (let i = 0; i < ready.length && !control.stopped; i += BATCH) {
        const chunk = ready.slice(i, i + BATCH);
        task.rename("Bringing work over from Jobber", kind[0]!.toUpperCase() + kind.slice(1));
        const rows = chunk.map(({ record, found }) => {
          const property = found.property_id ?? (found.new_property ? (added.get(`${found.client_id}|${streetKey(found.new_property.line1)}`) ?? null) : null);
          return jobberImportRow(kind, record, found.client_id, property);
        });
        const result = unwrap(await supabase().rpc("import_jobber", { p_company: companyId, p_kind: kind, p_rows: rows as never })) as unknown as Array<{ source_id: string; id: string; number: number | null; new: boolean; job_id?: string | null }>;
        const bySource = new Map(result.map((r) => [r.source_id, r]));
        for (const { record } of chunk) {
          const made = bySource.get(record.source_id);
          if (!made) continue;
          if (!made.new) {
            summary.already[kind]++;
            continue;
          }
          summary.created[kind]++;
          const brought = { id: made.id, number: made.number, jobber: record.number, title: "title" in record ? record.title : (record.subject ?? `Invoice #${record.number}`) };
          if ("needs_schedule" in record && record.needs_schedule) summary.needsSchedule.push(brought);
          if ("recurrence_rule" in record && record.recurrence_rule) repeating.push(made.id);
          summary.notes.push(...record.notes.map((note) => ({ ...brought, kind, note })));
          if ("job_number" in record && record.job_number && !made.job_id) {
            summary.notes.push({ ...brought, kind, note: `Its Jobber job #${record.job_number} isn't here (closed in Jobber, not in the jobs files, or another client's), so it came in without a job.` });
          }
        }
        task.progress((done += chunk.length));
      }
    }
    // A recurring job's next 60 days of visits now, rather than at the next hourly run.
    for (const id of repeating) {
      if (control.stopped) break;
      await api.post(`/jobs/${id}/generate-visits`).catch(() => undefined);
    }
    summary.stopped = control.stopped;
    const made = KINDS.filter((k) => summary.created[k]).map((k) => plural(summary.created[k], k));
    task.done(summary.stopped ? "Stopped. Import the files again to bring in the rest." : made.length ? `Brought in ${made.join(", ")}` : "Nothing new to bring in");
    return summary;
  } catch (error) {
    task.fail(`The import stopped. ${errorMessage(error)} Import the files again to finish: nothing comes in twice.`);
    throw error;
  } finally {
    for (const key of [["quotes", companyId], ["invoices", companyId], ["jobs", companyId], ["clients", companyId], customFieldsKey(companyId)]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }
}
