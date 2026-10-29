/**
 * Import clients and properties from a spreadsheet, including Jobber's Clients and Properties
 * exports. See importClients.ts for how columns are matched and rows grouped. A big file keeps
 * importing if the dialog closes: the task island shows how far along it is.
 */
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { parseCsv } from "@/lib/csv";
import { useSession } from "@/lib/session";
import { cancelTask, taskFraction, useTasks } from "@/lib/tasks";
import { toast } from "@/lib/toast";
import { guessMapping, importClients, TARGETS, toClients, type ImportResult, type Mapping } from "./importClients";

export function ImportClientsDialog({ onClose }: { onClose: () => void }) {
  const { company } = useSession();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [over, setOver] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const task = useTasks().find((t) => t.id === taskId);
  const [parseError, setParseError] = useState<string | null>(null);
  // Closed while it imports, the import says how it went on the task island instead of here.
  const stillOpen = useRef(true);
  useEffect(() => {
    stillOpen.current = true;
    return () => {
      stillOpen.current = false;
    };
  }, []);
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
    mutationFn: () => importClients(company.id, clients, { fileName, onTask: setTaskId }),
    onSuccess: (r: ImportResult) => {
      if (!stillOpen.current) return;
      if (r.stopped) toast.info(`Import stopped after ${r.created} new ${r.created === 1 ? "client" : "clients"}`, { description: "Import the file again to add the rest. Clients already in aren't added twice." });
      else {
        toast.success(`Imported ${r.created} new ${r.created === 1 ? "client" : "clients"} and ${r.properties} ${r.properties === 1 ? "property" : "properties"}`, {
          description: r.matched ? `${r.matched} ${r.matched === 1 ? "was" : "were"} already in Crewtavo; new properties were added to them${r.statuses ? `, and ${r.statuses} got the file's status` : ""}.` : undefined,
        });
      }
      onClose();
    },
  });
  const progress = run.isPending ? Math.round((task ? (taskFraction(task) ?? 0) : 0) * 100) : 0;

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
              <Icon name="upload" size={24} />
              <strong>Drop your spreadsheet here, or click to choose</strong>
              <span className="small">A .csv file with column names in the first row.</span>
              <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
            </label>
            <div className="callout">
              <Icon name="info" size={20} />
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
                      <td>{c.email || <span className="muted">—</span>}</td>
                      <td>{c.phone || <span className="muted">—</span>}</td>
                      <td>{c.properties.map((p) => [p.line1, p.city].filter(Boolean).join(", ")).join("; ") || <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {clients.length} {clients.length === 1 ? "client" : "clients"} with {propertyCount} {propertyCount === 1 ? "property" : "properties"}. Rows without a name are skipped; clients already in Crewtavo get any new properties, and the file's status, instead of a duplicate. A status column says who's active: Inactive or Former clients come in archived.
            </p>
            {run.isPending && (
              <>
                <div className="progress"><span style={{ width: `${progress}%` }} /></div>
                <p className="muted small" style={{ margin: 0 }}>It keeps going if you close this.</p>
              </>
            )}
          </>
        )}
        <FormError error={parseError ?? run.error} />
        <div className="form-actions">
          {run.isPending && taskId !== null ? (
            <Button onClick={() => cancelTask(taskId)} disabled={task?.stopping}>{task?.stopping ? "Stopping…" : "Stop import"}</Button>
          ) : (
            <Button onClick={onClose}>Cancel</Button>
          )}
          <Button variant="primary" icon="upload" loading={run.isPending} slowHint={false} disabled={!clients.length} onClick={() => run.mutate()}>
            Import {clients.length || ""} {clients.length === 1 ? "client" : "clients"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
