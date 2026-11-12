/**
 * Settings → Your data → Database backups: Crewtavo saves its whole database every night
 * (apps/api/src/services/backups.ts). This shows when the last good backup was and whether the last
 * run worked (GET /api/backups), and, for the owner's password, the backups there are, a download of
 * each, and Back up now. Owners only, as the rest of the page.
 */
import { BACKUP_KEEP, type BackupEntry, type BackupStatus } from "@crewtavo/core/backups";
import { formatBytes } from "@crewtavo/core/storage";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, FormError } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { downloadBlob } from "@/lib/csv";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

export const BACKUPS_KEY = ["backups"] as const;
const PASSWORD_HINT = "To make sure it's you. No password yet? Set one under Settings → Profile.";

/** The file a backup downloads as: its date and time, so several sit side by side. */
export const backupFileName = (b: Pick<BackupEntry, "startedAt">) => `crewtavo-backup-${b.startedAt.slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.dump`;

/** One line on how the backups are doing. */
export function backupLine(status: BackupStatus): string {
  if (status.running && !status.lastGoodAt) return "The first backup is being made now.";
  if (!status.lastGoodAt) return status.lastRun ? "No backup has worked yet." : "No backup yet. The first one is made within the hour.";
  return `Last good backup: ${formatDateTime(status.lastGoodAt)}.${status.running ? " A new one is being made now." : ""}`;
}

/** What's wrong, when something is: the last run's own reason, or how long it's been. */
export function backupProblem(status: BackupStatus): string | null {
  if (status.warning === "failed") return `The last backup didn't work. ${status.lastRun?.error ?? ""}`.trim();
  if (status.warning === "stale") return "There's been no good backup for over two days.";
  return null;
}

export function BackupsCard() {
  const session = useSession();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [list, setList] = useState<BackupEntry[] | null>(null);
  const status = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api.get<BackupStatus>("/backups"),
    // While one is being made, look again every few seconds.
    refetchInterval: (query) => (query.state.data?.running ? 4000 : false),
  });
  const show = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ backups: BackupEntry[] }>("/backups/list", { password }),
    onSuccess: (data) => setList(data.backups),
  });
  const backUp = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ id: string }>("/backups", { password }),
    onSuccess: () => client.invalidateQueries({ queryKey: BACKUPS_KEY }),
  });
  const download = useMutation({
    meta: { inline: true },
    mutationFn: async (backup: BackupEntry) => downloadBlob(backupFileName(backup), await api.download(`/backups/${backup.id}/download`, { password })),
  });
  // A backup that was being made is done: the list on screen gets it.
  const running = status.data?.running ?? false;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && list) show.mutate();
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const place = session.config.platform === "railway" ? "the same Railway project as Crewtavo" : "the same server as Crewtavo";
  const s = status.data;
  const problem = s ? backupProblem(s) : null;
  return (
    <div className="card card-pad stack-sm" style={{ gap: 12 }}>
      <div className="stack-sm" style={{ gap: 2 }}>
        <strong>Database backups</strong>
        <span className="muted small">
          Every night Crewtavo saves a copy of its whole database: clients, quotes, jobs, invoices, payments, the team and everyone&apos;s sign-in. It keeps the last {BACKUP_KEEP.daily} days and the last {BACKUP_KEEP.weekly} weeks. A backup is what a new Crewtavo is restored from if this one is ever lost.
        </span>
      </div>
      {s && !s.available && <span className="muted small">{s.unavailable}</span>}
      {s?.available && <span>{backupLine(s)}</span>}
      {problem && <span className="form-error" role="alert">{problem}</span>}
      <ul className="app-steps">
        <li><strong>Photos and files aren&apos;t in it.</strong> Visit photos, receipts, plans and documents are only covered if the files volume or bucket is backed up separately. A restore without them shows them as missing.</li>
        <li><strong>Download one now and then.</strong> The backups are kept on {place}, so if that&apos;s lost, they go with it. A backup you&apos;ve downloaded and put somewhere else is your copy.</li>
      </ul>
      {s?.available && (
        <form
          className="stack-sm"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            show.mutate();
          }}
        >
          <Field label="Your Crewtavo password" hint={PASSWORD_HINT}>
            <input className="input" type="password" value={password} onChange={(e) => { setPassword(e.target.value); show.reset(); backUp.reset(); download.reset(); }} autoComplete="current-password" maxLength={200} style={{ maxWidth: 320 }} />
          </Field>
          <FormError error={show.error ?? backUp.error ?? download.error} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Button type="submit" variant="primary" disabled={!password} loading={show.isPending}>{list ? "Refresh the list" : "Show backups"}</Button>
            <Button icon="download" disabled={!password || running} loading={backUp.isPending || running} slowHint={false} onClick={() => backUp.mutate()}>
              {running ? "Making a backup…" : "Back up now"}
            </Button>
          </div>
        </form>
      )}
      {list && <BackupList backups={list} busy={download.isPending ? download.variables?.id ?? null : null} onDownload={(b) => download.mutate(b)} />}
      <span className="muted small">A backup holds everything, pay rates and clients&apos; details included, so keep a downloaded one somewhere safe. Restoring one into a new Crewtavo is in docs/deploy.md, under Restoring a backup.</span>
    </div>
  );
}

/** The backups there are, newest first: when, how big, and whether each worked. */
export function BackupList({ backups, busy, onDownload }: { backups: BackupEntry[]; busy: string | null; onDownload: (backup: BackupEntry) => void }) {
  if (!backups.length) return <span className="muted small">No backups yet.</span>;
  return (
    <ul className="stack-sm" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
      {backups.map((b) => (
        <li key={b.id} className="row-between" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="stack-sm" style={{ gap: 2 }}>
            <span>{formatDateTime(b.startedAt)}{b.kind === "manual" ? " (made by hand)" : ""}</span>
            <span className="muted small">
              {b.status === "ok" ? `Good, ${formatBytes(b.bytes ?? 0)}` : b.status === "running" ? "Being made…" : `Didn't work. ${b.error ?? ""}`}
            </span>
          </div>
          {b.status === "ok" && <Button size="sm" icon="download" loading={busy === b.id} slowHint={false} onClick={() => onDownload(b)}>Download</Button>}
        </li>
      ))}
    </ul>
  );
}
