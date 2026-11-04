/**
 * Coming from Jobber: one guided flow for the work still open there. Choose Jobber's exports, see
 * what comes in (with counts and what can't), then bring it in; the summary links the recurring
 * jobs that need their schedule set. See importJobber.ts for how.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { JobberPlanned, JobberWorkKind } from "@crewtavo/core/jobberImport";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { useSession } from "@/lib/session";
import { cancelTask, taskFraction, useTasks } from "@/lib/tasks";
import { FILE_LABELS, previewImport, readFile, runImport, type ChosenFile, type ImportSummary } from "./importJobber";

const KINDS: Array<{ kind: JobberWorkKind; label: string; one: string; path: string }> = [
  { kind: "quotes", label: "Open quotes", one: "quote", path: "/quotes/" },
  { kind: "invoices", label: "Unpaid invoices", one: "invoice", path: "/invoices/" },
  { kind: "jobs", label: "Active jobs", one: "job", path: "/jobs/" },
];
const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const leftOut = (left: Record<string, number>) => Object.entries(left).map(([why, n]) => `${n} ${why.toLowerCase()}`).join(", ");

export function ImportJobberDialog({ onClose }: { onClose: () => void }) {
  const { company } = useSession();
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [over, setOver] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const task = useTasks().find((t) => t.id === taskId);

  const preview = useMutation({ meta: { inline: true }, mutationFn: () => previewImport(company.id, company.timezone, files) });
  const run = useMutation({ meta: { inline: true }, mutationFn: () => runImport(company.id, company.timezone, files, setTaskId) });

  const add = async (list: FileList | null) => {
    setFileError(null);
    preview.reset();
    try {
      const read = await Promise.all([...(list ?? [])].map(readFile));
      // One of each kind (clients and properties exports aside): a newer one takes the place of the one before.
      setFiles((before) => [...before.filter((f) => !read.some((r) => r.name === f.name || (r.kind && r.kind !== "clients" && r.kind === f.kind))), ...read]);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : String(error));
    }
  };
  const remove = (file: ChosenFile) => {
    preview.reset();
    setFiles(files.filter((f) => f !== file));
  };
  const hasClients = files.some((f) => f.kind === "clients");
  const ready = files.some((f) => f.kind && f.kind !== "clients" && f.kind !== "visits");

  const chooser = (
    <label
      className="dropzone"
      data-over={over || undefined}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); }}
    >
      <Icon name="upload" size={24} />
      <strong>Drop Jobber&apos;s exports here, or click to choose</strong>
      <span className="small">The .csv files Jobber emailed you. Choose several at once.</span>
      <input type="file" multiple accept=".csv,text/csv" className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
    </label>
  );

  return (
    <Dialog open onClose={onClose} title="Bring your open work from Jobber" size="lg">
      <div className="dialog-body">
        {run.data ? (
          <Summary summary={run.data} />
        ) : preview.data ? (
          <>
            {preview.data.clients.length > 0 && (
              <p className="small" style={{ margin: 0 }}>
                <strong>Clients</strong>: {count(preview.data.newClients, "new client")} first, from the clients file. Clients already here aren&apos;t added twice.
              </p>
            )}
            {KINDS.map(({ kind, label, one }) => <PlanRow key={kind} label={label} one={one} planned={preview.data.plan[kind]} />)}
            {!hasClients && KINDS.some(({ kind }) => preview.data.plan[kind].missing_clients) && (
              <div className="callout callout-warning">
                <Icon name="info" size={20} />
                <div className="grow small" style={{ fontWeight: 400 }}>
                  <div>Some clients aren&apos;t in Crewtavo yet</div>
                  {count(KINDS.reduce((n, { kind }) => n + preview.data.plan[kind].missing_clients, 0), "row")} are for clients who aren&apos;t here, so they&apos;d be skipped. Add Jobber&apos;s clients export (Clients → More actions → Export clients, as CSV) and they come in first.
                  <label className="btn btn-sm" style={{ marginTop: 8, display: "inline-flex" }}>
                    <Icon name="upload" size={14} /> Add the clients file
                    <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
                  </label>
                </div>
              </div>
            )}
            {preview.data.plan.jobs.ready.some((r) => r.record.needs_schedule) && (
              <p className="muted small" style={{ margin: 0 }}>
                {count(preview.data.plan.jobs.ready.filter((r) => r.record.needs_schedule).length, "recurring job")} don&apos;t say how they repeat
                {files.some((f) => f.kind === "visits") ? <> in a way Crewtavo can follow: they come in </> : <>. Add Jobber&apos;s visits report and their schedule is worked out from their visits; otherwise they come in </>}
                without one, listed at the end for you to set.
              </p>
            )}
            <div className="callout">
              <Icon name="info" size={20} />
              <div className="grow small" style={{ fontWeight: 400 }}>
                <div>Nothing is sent or charged</div>
                No emails or texts go to clients as it comes in, and no trip charge, minimum charge or late fee is added: each invoice owes what it owed in Jobber, with what was paid there as one payment. Crewtavo gives each its own number and keeps Jobber&apos;s beside it. Importing the same files again adds nothing. After that they&apos;re like the rest: an invoice that falls past due later gets your usual reminder.
              </div>
            </div>
            {run.isPending && (
              <>
                <div className="progress"><span style={{ width: `${Math.round((task ? (taskFraction(task) ?? 0) : 0) * 100)}%` }} /></div>
                <p className="muted small" style={{ margin: 0 }}>It keeps going if you close this.</p>
              </>
            )}
          </>
        ) : (
          <>
            {chooser}
            {files.length > 0 && (
              <ul className="stack-sm" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {files.map((f) => (
                  <li key={f.name + f.kind} className="row-between small">
                    <span>
                      <strong>{f.name}</strong>{" "}
                      {f.kind ? <span className="muted">· {FILE_LABELS[f.kind]} · {count(Math.max(f.rows.length - 1, 0), "row")}</span> : <span className="text-danger">· Not one of Jobber&apos;s exports listed below</span>}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => remove(f)}>Remove</Button>
                  </li>
                ))}
              </ul>
            )}
            <ol className="app-steps">
              <li>In Jobber, go to <strong>Insights → Reports</strong>.</li>
              <li>Open the <strong>Quotes</strong>, <strong>Invoices</strong>, <strong>One-off jobs</strong> and <strong>Recurring jobs</strong> reports in turn, set the dates to All time, and choose <strong>Export to CSV</strong> with all columns.</li>
              <li>Export the <strong>Visits</strong> report too, for the next few months: recurring jobs keep their schedule when their visits show it, and one-off jobs come with their visits still to do.</li>
              <li>Clients not in Crewtavo yet? Add Jobber&apos;s Clients export (and its Properties export) as well, and they come in first.</li>
            </ol>
            <span className="muted small">Only what&apos;s still open comes in: quotes not yet won or lost, invoices not paid, and jobs not closed.</span>
          </>
        )}
        <FormError error={fileError ?? preview.error ?? run.error} />
        <div className="form-actions">
          {run.data ? (
            <Button variant="primary" onClick={onClose}>Done</Button>
          ) : preview.data ? (
            <>
              {run.isPending && taskId !== null ? (
                <Button onClick={() => cancelTask(taskId)} disabled={task?.stopping}>{task?.stopping ? "Stopping…" : "Stop import"}</Button>
              ) : (
                <Button onClick={() => preview.reset()}>Back</Button>
              )}
              <Button variant="primary" icon="upload" loading={run.isPending} slowHint={false} disabled={!KINDS.some(({ kind }) => preview.data.plan[kind].ready.length) && !preview.data.newClients} onClick={() => run.mutate()}>
                Bring it in
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" loading={preview.isPending} disabled={!ready} onClick={() => preview.mutate()}>See what comes in</Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** One kind: how many come in, are here already, are left out, and can't come in (and why). */
function PlanRow({ label, one, planned }: { label: string; one: string; planned: JobberPlanned<unknown> }) {
  const left = leftOut(planned.left_out);
  if (!planned.ready.length && !planned.already && !left && !planned.problems.length) return null;
  return (
    <div className="stack-sm" style={{ gap: 2 }}>
      <span><strong>{label}</strong>: {count(planned.ready.length, one)} to bring in</span>
      <span className="muted small">
        {[planned.already && `${count(planned.already, one)} already here`, left && `left out: ${left}`].filter(Boolean).join(" · ")}
      </span>
      {planned.problems.length > 0 && <Problems problems={planned.problems.map((p) => ({ number: p.number, reason: p.reason }))} one={one} />}
    </div>
  );
}

function Problems({ problems, one }: { problems: Array<{ number: string | null; reason: string }>; one: string }) {
  return (
    <details className="small">
      <summary>{count(problems.length, one)} can&apos;t come in</summary>
      <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
        {problems.slice(0, 50).map((p, i) => <li key={i}>{p.number ? `#${p.number}: ` : ""}{p.reason}</li>)}
        {problems.length > 50 && <li>and {problems.length - 50} more</li>}
      </ul>
    </details>
  );
}

function Summary({ summary }: { summary: ImportSummary }) {
  const made = KINDS.filter(({ kind }) => summary.created[kind]).map(({ kind, one }) => count(summary.created[kind], one));
  const already = KINDS.filter(({ kind }) => summary.already[kind]).map(({ kind, one }) => count(summary.already[kind], one));
  return (
    <>
      <div className={summary.stopped ? "callout callout-warning" : "callout callout-good"}>
        <Icon name={summary.stopped ? "info" : "check"} size={20} />
        <div className="grow small" style={{ fontWeight: 400 }}>
          <div>{made.length || summary.clients ? `Brought in ${[summary.clients && count(summary.clients, "client"), ...made].filter(Boolean).join(", ")}` : "Nothing new to bring in"}</div>
          {summary.stopped ? "Stopped before the end. Import the files again to bring in the rest: nothing comes in twice." : already.length ? `Already here from before: ${already.join(", ")}.` : null}
        </div>
      </div>
      {summary.needsSchedule.length > 0 && (
        <div className="stack-sm" style={{ gap: 4 }}>
          <strong>Needs a schedule</strong>
          <span className="muted small">Recurring in Jobber, but how they repeat wasn&apos;t in the files. Open each, choose Edit details, then Recurring job, and set it.</span>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {summary.needsSchedule.map((j) => <li key={j.id}><Link to={`/jobs/${j.id}`}>Job #{j.number} · {j.title}</Link> <span className="muted small">(Jobber #{j.jobber})</span></li>)}
          </ul>
        </div>
      )}
      {summary.notes.length > 0 && (
        <div className="stack-sm" style={{ gap: 4 }}>
          <strong>Worth a look</strong>
          <ul style={{ margin: 0, paddingLeft: 20 }} className="small">
            {summary.notes.map((n, i) => (
              <li key={i}><Link to={`${KINDS.find((k) => k.kind === n.kind)!.path}${n.id}`}>{n.title}</Link> <span className="muted">(Jobber #{n.jobber})</span>: {n.note}</li>
            ))}
          </ul>
        </div>
      )}
      {summary.skipped.length > 0 && <Problems problems={summary.skipped} one="row" />}
    </>
  );
}
