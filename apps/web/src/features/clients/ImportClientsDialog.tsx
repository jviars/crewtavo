/**
 * Import clients and properties from a spreadsheet, including Jobber's Clients and Properties
 * exports. See importClients.ts for how columns are matched and rows grouped.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { api, supabase, unwrap } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { planImport, type ExistingClient } from "@crewtavo/core/clientImport";
import { guessMapping, TARGETS, toClients, type Mapping } from "./importClients";


export function ImportClientsDialog({ onClose }: { onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [over, setOver] = useState(false);
  const [progress, setProgress] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const headers = rows[0] ?? [];
  const body = rows.slice(1);

  const load = async (file: File) => {
    setParseError(null);
    if (file.size > 10_000_000) return setParseError("That file is over 10 MB. Split it into smaller files.");
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) return setParseError("That file has no rows to import. The first row should be column names.");
    setFileName(file.name);
    setRows(parsed);
    setMapping(guessMapping(parsed[0]!));
  };

  const clients = useMemo(() => toClients(body, mapping), [body, mapping]);
  const propertyCount = clients.reduce((n, c) => n + c.properties.length, 0);

  const run = useMutation({
    meta: { inline: true },
    mutationFn: async () => {
      // Who's already here, and how they're matched: packages/core/src/clientImport.ts.
      const existing: ExistingClient[] = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(await supabase().from("clients").select("id, email, display_name, status, custom_fields").eq("company_id", company.id).range(from, from + 999));
        existing.push(...page.map((c) => ({ id: c.id, display_name: c.display_name, email: c.email, status: c.status, source_id: ((c.custom_fields ?? {}) as { source_id?: string }).source_id ?? null })));
        if (page.length < 1000) break;
      }
      // The streets the clients it finds already have, so the same address isn't added twice.
      const found = [...new Set(planImport(clients, existing, new Map()).decisions.flatMap((d) => (d.client_id ? [d.client_id] : [])))];
      const streets = new Map<string, string[]>();
      for (let i = 0; i < found.length; i += 200) {
        for (const p of unwrap(await supabase().from("properties").select("client_id, line1").in("client_id", found.slice(i, i + 200)))) streets.set(p.client_id, [...(streets.get(p.client_id) ?? []), p.line1]);
      }
      const plan = planImport(clients, existing, streets);
      const byKey = new Map(clients.map((c) => [c.key, c]));
      const fresh = plan.decisions.filter((d) => d.action === "create").map((d) => ({ ...d, id: crypto.randomUUID(), client: byKey.get(d.key)! }));

      let done = 0;
      const total = plan.decisions.length || 1;
      for (let i = 0; i < fresh.length; i += 200) {
        const chunk = fresh.slice(i, i + 200);
        unwrap(
          await supabase().from("clients").insert(
            chunk.map(({ id, status, client: c }) => ({
              id, company_id: company.id, display_name: c.display_name, company_name: c.company_name, email: c.email, phone: c.phone,
              lead_source: c.lead_source, tags: c.tags, notes: c.notes, billing_address: (c.billing ?? {}) as never, status: status ?? "active",
              custom_fields: (c.source_id ? { source_id: c.source_id } : {}) as never,
            })),
          ),
        );
        done += chunk.length;
        setProgress(Math.round((done / total) * 90));
      }
      // Clients already here whose status the file changes (Inactive → archived, and back).
      for (const status of ["lead", "active", "archived"] as const) {
        const ids = plan.decisions.filter((d) => d.status_change?.to === status).map((d) => d.client_id!);
        for (let i = 0; i < ids.length; i += 200) unwrap(await supabase().from("clients").update({ status }).in("id", ids.slice(i, i + 200)));
      }
      const ids = new Map(fresh.map((f) => [f.key, f.id]));
      const properties = plan.decisions.flatMap((d) =>
        d.add_properties.map((p) => ({ label: p.label, line1: p.line1, line2: p.line2, city: p.city, region: p.region, postal_code: p.postal_code, notes: p.notes ?? null, client_id: d.client_id ?? ids.get(d.key)!, company_id: company.id })),
      );
      const added: string[] = [];
      for (let i = 0; i < properties.length; i += 200) {
        added.push(...unwrap(await supabase().from("properties").insert(properties.slice(i, i + 200)).select("id")).map((p) => p.id));
      }
      // On the map in the background, so routes and weather know where they are.
      if (added.length) await api.post("/properties/geocode", { ids: added }).catch(() => undefined);
      setProgress(100);
      return { created: plan.totals.create, matched: plan.totals.match, properties: added.length, statuses: plan.totals.status_changes };
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
      queryClient.invalidateQueries({ queryKey: ["client-tags", company.id] });
      toast.success(`Imported ${r.created} new ${r.created === 1 ? "client" : "clients"} and ${r.properties} ${r.properties === 1 ? "property" : "properties"}`, {
        description: r.matched ? `${r.matched} ${r.matched === 1 ? "was" : "were"} already in Crewtavo; new properties were added to them${r.statuses ? `, and ${r.statuses} got the file's status` : ""}.` : undefined,
      });
      onClose();
    },
  });

  const shown = showAll ? TARGETS : TARGETS.filter((t) => mapping[t.key] !== undefined || ["display_name", "status", "email", "phone", "line1"].includes(t.key));

  return (
    <Dialog open onClose={onClose} title="Import clients and properties" size="lg">
      <div className="dialog-body">
        {!rows.length ? (
          <>
            <label
              className="dropzone"
              data-over={over || undefined}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) load(f); }}
            >
              <Icon name="upload" size={28} />
              <strong>Drop your spreadsheet here, or click to choose</strong>
              <span className="small">A .csv file with column names in the first row.</span>
              <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
            </label>
            <div className="callout">
              <Icon name="info" size={18} />
              <div className="grow small" style={{ fontWeight: 400 }}>
                <div style={{ fontWeight: 700 }}>Coming from Jobber?</div>
                In Jobber, open Clients, choose Export and download the CSV; import it here. Then export Properties the same way and import that file too: each property is added to its client. Clients already here aren't duplicated.
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="row-between">
              <span><strong>{fileName}</strong> <span className="muted">· {body.length} rows</span></span>
              <Button size="sm" variant="ghost" onClick={() => { setRows([]); setMapping({}); }}>Choose another file</Button>
            </div>
            <div className="form-grid">
              {shown.map((t) => (
                <label key={t.key} className="field">
                  <span>{t.label}</span>
                  <select className="select" value={mapping[t.key] ?? ""} onChange={(e) => setMapping({ ...mapping, [t.key]: e.target.value === "" ? undefined : Number(e.target.value) })}>
                    <option value="">Don't import</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                  </select>
                </label>
              ))}
            </div>
            {!showAll && <Button size="sm" variant="ghost" style={{ justifySelf: "start" }} onClick={() => setShowAll(true)}>Match more columns</Button>}
            <div className="card" style={{ overflow: "auto", boxShadow: "none" }}>
              <table className="table" style={{ fontSize: 13 }}>
                <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Properties</th></tr></thead>
                <tbody>
                  {clients.slice(0, 5).map((c) => (
                    <tr key={c.key}>
                      <td>{c.display_name}</td>
                      <td>{c.email}</td>
                      <td>{c.phone}</td>
                      <td>{c.properties.map((p) => [p.line1, p.city].filter(Boolean).join(", ")).join("; ") || <span className="muted">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {clients.length} {clients.length === 1 ? "client" : "clients"} with {propertyCount} {propertyCount === 1 ? "property" : "properties"}. Rows without a name are skipped; clients already in Crewtavo get any new properties, and the file's status, instead of a duplicate. A status column says who's active: Inactive or Former clients come in archived.
            </p>
            {run.isPending && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}
          </>
        )}
        <FormError error={parseError ?? run.error} />
        <div className="form-actions">
          <Button onClick={onClose} disabled={run.isPending}>Cancel</Button>
          <Button variant="primary" icon="upload" loading={run.isPending} disabled={!clients.length} onClick={() => run.mutate()}>
            Import {clients.length || ""} {clients.length === 1 ? "client" : "clients"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
