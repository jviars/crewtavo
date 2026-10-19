/**
 * When a file is bigger than this Crewtavo takes: say so, and on Railway let an owner or admin
 * raise the limit to 200 MB with one press (Crewtavo changes the storage service's FILE_SIZE_LIMIT
 * through its Railway connection and restarts storage; apps/api/src/services/uploads.ts). Elsewhere,
 * or for everyone else, the docs say how.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { Skeleton } from "@/components/ui/Skeleton";
import { api } from "@/lib/api";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { fileSize, PLAN_LIMIT_DOCS, type TooLargeError } from "./plans";

interface UploadLimit {
  connected: boolean;
  limit: number | null;
  target: number;
  raised?: boolean;
}

/** Tells someone a file was too big, with the way to raise the limit that fits them. */
export function useTooLarge() {
  const session = useSession();
  const [open, setOpen] = useState(false);
  const canRaise = session.config.platform === "railway" && hasRole(session, "admin") && can(session, "settings");
  const report = (error: TooLargeError) => {
    // Past 200 MB no setting helps: the file has to be split.
    if (!error.fromServer) return toast.error(error.message, { description: "Split it into smaller PDFs (most PDF readers can save a range of pages as their own file)." });
    toast.error(error.message, {
      description: canRaise
        ? "You can raise the limit to 200 MB from here, or split the plan set into smaller PDFs."
        : "Split the plan set into smaller PDFs, or ask whoever runs Crewtavo to raise the upload limit.",
      action: canRaise ? { label: "Raise the limit", onClick: () => setOpen(true) } : { label: "How", onClick: () => window.open(PLAN_LIMIT_DOCS, "_blank", "noopener") },
    });
  };
  return { report, dialog: open ? <UploadLimitDialog onClose={() => setOpen(false)} /> : null };
}

export function UploadLimitDialog({ onClose }: { onClose: () => void }) {
  const state = useQuery({ queryKey: ["upload-limit"], queryFn: () => api.get<UploadLimit>("/railway/uploads"), meta: { silent: true } });
  const raise = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<UploadLimit>("/railway/uploads"),
    onSuccess: (r) => r.raised && toast.success("Upload limit raised to 200 MB", { description: "File storage is restarting. Try the file again in a minute or two." }),
  });
  const s = raise.data ?? state.data;
  return (
    <Dialog open onClose={onClose} title="Take bigger files" size="sm">
      <div className="dialog-body stack">
        {state.isPending && <Skeleton height={60} />}
        {state.error && <FormError error={state.error} />}
        {s && !s.connected && (
          <>
            <p style={{ margin: 0 }}>Crewtavo can raise its upload limit to {fileSize(s.target)} for you once it's connected to your Railway project.</p>
            <p className="muted small" style={{ margin: 0 }}>Connect it under Settings → Web address (one press of Allow on Railway), then come back to the file. Or change it by hand on Railway.</p>
            <div className="form-actions">
              <a className="btn" href={PLAN_LIMIT_DOCS} target="_blank" rel="noreferrer">Do it by hand</a>
              <Link className="btn btn-primary" to="/settings?tab=address" onClick={onClose}>Connect Railway</Link>
            </div>
          </>
        )}
        {s?.connected && s.raised && (
          <>
            <div className="callout callout-good"><Icon name="check" size={18} /><div className="grow">Done. This Crewtavo now takes files up to {fileSize(s.target)}.</div></div>
            <p className="muted small" style={{ margin: 0 }}>File storage is restarting with the new limit, which takes about a minute. Then add the file again.</p>
            <div className="form-actions"><Button variant="primary" onClick={onClose}>Close</Button></div>
          </>
        )}
        {s?.connected && !s.raised && s.limit !== null && s.limit >= s.target && (
          <>
            <p style={{ margin: 0 }}>This Crewtavo already takes files up to {fileSize(s.limit)}. That file is bigger, so split it into smaller PDFs (most PDF readers can save a range of pages as their own file).</p>
            <div className="form-actions"><Button variant="primary" onClick={onClose}>Close</Button></div>
          </>
        )}
        {s?.connected && !s.raised && (s.limit === null || s.limit < s.target) && (
          <>
            <p style={{ margin: 0 }}>
              This Crewtavo takes files up to {s.limit ? fileSize(s.limit) : "a smaller size"}. Raise it to {fileSize(s.target)}, enough for most plan sets?
            </p>
            <p className="muted small" style={{ margin: 0 }}>Crewtavo changes the setting on Railway and restarts file storage. That takes about a minute, and uploads wait until it's back. Files you already have aren't touched.</p>
            <FormError error={raise.error} />
            <div className="form-actions">
              <Button onClick={onClose}>Not now</Button>
              <Button variant="primary" loading={raise.isPending} onClick={() => raise.mutate()}>Raise to {fileSize(s.target)}</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
