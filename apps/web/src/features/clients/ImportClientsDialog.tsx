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
import { supabase, unwrap } from "@/lib/api";
import { parseCsv } from "@/lib/csv";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { guessMapping, sameStreet, TARGETS, toClients, type Mapping } from "./importClients";

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

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
      // Who's already here: match by email, or by name for clients without one.
      const existing: Array<{ id: string; email: string | null; display_name: string }> = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(await supabase().from("clients").select("id, email, display_name").eq("company_id", company.id).range(from, from + 999));
        existing.push(...page);
        if (page.length < 1000) break;
      }
      const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.id]));
      const byName = new Map(existing.map((c) => [norm(c.display_name), c.id]));

      const fresh: Array<(typeof clients)[number] & { id: string }> = [];
      const known: Array<(typeof clients)[number] & { id: string }> = [];
      for (const c of clients) {
        const id = (c.email && byEmail.get(c.email)) || (!c.email ? byName.get(norm(c.display_name)) : undefined);
        if (id) known.push({ ...c, id });
        else fresh.push({ ...c, id: crypto.randomUUID() });
      }
      // Properties the known clients already have, so the same address isn't added twice.
      const have = new Map<string, string[]>();
      for (let i = 0; i < known.length; i += 200) {
        const ids = known.slice(i, i + 200).map((k) => k.id);
        for (const p of unwrap(await supabase().from("properties").select("client_id, line1").in("client_id", ids))) have.set(p.client_id, [...(have.get(p.client_id) ?? []), p.line1]);
      }

      let done = 0;
      const total = fresh.length + known.length || 1;
      for (let i = 0; i < fresh.length; i += 200) {
        const chunk = fresh.slice(i, i + 200);
        unwrap(
          await supabase().from("clients").insert(
            chunk.map((c) => ({
              id: c.id, company_id: company.id, display_name: c.display_name, company_name: c.company_name, email: c.email, phone: c.phone,
              lead_source: c.lead_source, tags: c.tags, notes: c.notes, billing_address: (c.billing ?? {}) as never, status: "active" as const,
            })),
          ),
        );
        done += chunk.length;
        setProgress(Math.round((done / total) * 100));
      }
      let added = 0;
      const properties = [...fresh, ...known].flatMap((c) =>
        c.properties.filter((p) => !(have.get(c.id) ?? []).some((line) => sameStreet(line, p.line1))).map((p) => ({ ...p, client_id: c.id, company_id: company.id })),
      );
      for (let i = 0; i < properties.length; i += 200) {
        unwrap(await supabase().from("properties").insert(properties.slice(i, i + 200)));
        added += Math.min(200, properties.length - i);
      }
      setProgress(100);
      return { created: fresh.length, matched: known.length, properties: added };
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["clients", company.id] });
      queryClient.invalidateQueries({ queryKey: ["client-tags", company.id] });
      toast.success(`Imported ${r.created} new ${r.created === 1 ? "client" : "clients"} and ${r.properties} ${r.properties === 1 ? "property" : "properties"}`, {
        description: r.matched ? `${r.matched} ${r.matched === 1 ? "was" : "were"} already in Crewtavo; new properties were added to them.` : undefined,
      });
      onClose();
    },
  });

  const shown = showAll ? TARGETS : TARGETS.filter((t) => mapping[t.key] !== undefined || ["display_name", "email", "phone", "line1"].includes(t.key));

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
              {clients.length} {clients.length === 1 ? "client" : "clients"} with {propertyCount} {propertyCount === 1 ? "property" : "properties"}. Rows without a name are skipped; clients already in Crewtavo get any new properties instead of a duplicate.
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
