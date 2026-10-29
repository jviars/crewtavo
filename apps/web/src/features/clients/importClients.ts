/**
 * Turning a spreadsheet of clients into clients and properties: the shared rules in
 * packages/core/src/clientImport.ts, which the AI assistants' import uses too. Built for Jobber's
 * exports (the Clients export and the Properties export) and most other tools' too: rows with the
 * same client ID, email or name are one client, and a client already here gets the properties
 * instead of a duplicate.
 */
import { planImport, type ExistingClient, type ImportClient } from "@crewtavo/core/clientImport";
import { api, supabase, unwrap } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { queryClient } from "@/lib/queryClient";
import { startTask } from "@/lib/tasks";

export {
  IMPORT_TARGETS as TARGETS,
  guessMapping,
  sameStreet,
  toClients,
  type ImportAddress as Address,
  type ImportClient,
  type ImportMapping as Mapping,
  type ImportTargetKey as TargetKey,
} from "@crewtavo/core/clientImport";

export interface ImportResult {
  created: number;
  matched: number;
  properties: number;
  statuses: number;
  /** Cancel was pressed: it stopped after the batch that was going. */
  stopped: boolean;
}

const BATCH = 200;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Brings the clients in, 200 at a time, as a background task (lib/tasks.ts): it carries on when the
 * dialog closes, and Cancel stops it after the batch that's going. Importing the same file again
 * finishes the job, since the clients already in are matched rather than added twice.
 */
export async function importClients(companyId: string, clients: ImportClient[], { fileName, onTask }: { fileName?: string; onTask?: (taskId: number) => void } = {}): Promise<ImportResult> {
  const control = { stopped: false };
  const task = startTask({
    label: `Importing ${plural(clients.length, "client", "clients")}`,
    detail: fileName,
    cancel: () => {
      control.stopped = true;
    },
  });
  onTask?.(task.id);
  let created = 0;
  const added: string[] = [];
  try {
    // Who's already here, and how they're matched: packages/core/src/clientImport.ts.
    const existing: ExistingClient[] = [];
    for (let from = 0; ; from += 1000) {
      const page = unwrap(await supabase().from("clients").select("id, email, display_name, status, custom_fields").eq("company_id", companyId).range(from, from + 999));
      existing.push(...page.map((c) => ({ id: c.id, display_name: c.display_name, email: c.email, status: c.status, source_id: ((c.custom_fields ?? {}) as { source_id?: string }).source_id ?? null })));
      if (page.length < 1000) break;
    }
    // The streets the clients it finds already have, so the same address isn't added twice.
    const found = [...new Set(planImport(clients, existing, new Map()).decisions.flatMap((d) => (d.client_id ? [d.client_id] : [])))];
    const streets = new Map<string, string[]>();
    for (let i = 0; i < found.length; i += BATCH) {
      for (const p of unwrap(await supabase().from("properties").select("client_id, line1").in("client_id", found.slice(i, i + BATCH)))) streets.set(p.client_id, [...(streets.get(p.client_id) ?? []), p.line1]);
    }
    const plan = planImport(clients, existing, streets);
    const byKey = new Map(clients.map((c) => [c.key, c]));
    const fresh = plan.decisions.filter((d) => d.action === "create").map((d) => ({ ...d, id: crypto.randomUUID(), client: byKey.get(d.key)! }));
    // Clients already here whose status the file changes (Inactive → archived, and back).
    const statusChanges = (["lead", "active", "archived"] as const).map((status) => ({ status, ids: plan.decisions.filter((d) => d.status_change?.to === status).map((d) => d.client_id!) }));
    const ids = new Map(fresh.map((f) => [f.key, f.id]));
    const properties = plan.decisions.flatMap((d) =>
      d.add_properties.map((p) => ({ label: p.label, line1: p.line1, line2: p.line2, city: p.city, region: p.region, postal_code: p.postal_code, notes: p.notes ?? null, client_id: d.client_id ?? ids.get(d.key)!, company_id: companyId })),
    );

    // Counted in rows: new clients, status changes, then properties.
    let done = 0;
    task.progress(0, fresh.length + statusChanges.reduce((n, s) => n + s.ids.length, 0) + properties.length || 1);
    for (let i = 0; i < fresh.length && !control.stopped; i += BATCH) {
      const chunk = fresh.slice(i, i + BATCH);
      unwrap(
        await supabase().from("clients").insert(
          chunk.map(({ id, status, client: c }) => ({
            id, company_id: companyId, display_name: c.display_name, company_name: c.company_name, email: c.email, phone: c.phone,
            lead_source: c.lead_source, tags: c.tags, notes: c.notes, billing_address: (c.billing ?? {}) as never, status: status ?? "active",
            custom_fields: (c.source_id ? { source_id: c.source_id } : {}) as never,
          })),
        ),
      );
      created += chunk.length;
      task.progress((done += chunk.length));
    }
    let statuses = 0;
    for (const { status, ids: changing } of statusChanges) {
      for (let i = 0; i < changing.length && !control.stopped; i += BATCH) {
        const chunk = changing.slice(i, i + BATCH);
        unwrap(await supabase().from("clients").update({ status }).in("id", chunk));
        statuses += chunk.length;
        task.progress((done += chunk.length));
      }
    }
    // Stopped among the clients, none of the properties go: some would belong to clients not in yet.
    for (let i = 0; i < properties.length && !control.stopped; i += BATCH) {
      const chunk = properties.slice(i, i + BATCH);
      added.push(...unwrap(await supabase().from("properties").insert(chunk).select("id")).map((p) => p.id));
      task.progress((done += chunk.length));
    }
    // On the map in the background, so routes and weather know where they are.
    if (added.length) await api.post("/properties/geocode", { ids: added }).catch(() => undefined);
    const result = { created, matched: plan.totals.match, properties: added.length, statuses, stopped: control.stopped };
    task.done(
      result.stopped
        ? `Stopped after ${plural(created, "new client", "new clients")}. Import the file again to add the rest.`
        : `Imported ${plural(created, "new client", "new clients")} and ${plural(added.length, "property", "properties")}`,
    );
    return result;
  } catch (error) {
    task.fail(created ? `The import stopped after ${plural(created, "new client", "new clients")}. ${errorMessage(error)}` : `Couldn't import the clients. ${errorMessage(error)}`);
    throw error;
  } finally {
    if (created || added.length || control.stopped) {
      void queryClient.invalidateQueries({ queryKey: ["clients", companyId] });
      void queryClient.invalidateQueries({ queryKey: ["client-tags", companyId] });
    }
  }
}
