import type { ReactNode } from "react";
import { ApiError, errorMessage, isNotFound, isRestarting } from "@/lib/errors";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { PageHeader } from "./PageHeader";

/**
 * Friendly "nothing here yet" with an optional next step. The full one, with its icon, is for a whole
 * list page. `inline` is for an empty section in a card: one muted line under the card's heading, the
 * action after it as a link, e.g. <EmptyState inline title="No notes yet" action={<Button>Add a note</Button>} />.
 * A title never ends with a period; sentences in `children` do.
 */
export function EmptyState({ icon = "inbox", title, children, action, compact, inline }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean; inline?: boolean }) {
  if (inline) {
    return (
      <div className="empty-inline">
        <span>{title}{children ? <>. {children}</> : null}</span>
        {action}
      </div>
    );
  }
  return (
    <div className={compact ? "empty-state empty-state-sm" : "empty-state"}>
      <span className="empty-icon"><Icon name={icon} size={compact ? 20 : 24} /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

/** A load that failed: what happened and a way to try again. */
export function ErrorState({ error, onRetry, title, compact }: { error: unknown; onRetry?: () => void; title?: string; compact?: boolean }) {
  // A malformed id in a link means there's nothing to load, not that loading failed.
  const badLink = error instanceof ApiError && error.code === "22P02";
  const notFound = isNotFound(error) || badLink;
  // While Crewtavo restarts, the shell's banner explains it and tries again for every screen at once.
  if (error instanceof ApiError && isRestarting(error.status)) {
    return (
      <div className={compact ? "empty-state empty-state-sm" : "empty-state"} role="status">
        <span className="empty-icon"><Icon name="refresh" size={compact ? 20 : 24} /></span>
        <h3>{title ?? "Crewtavo is restarting"}</h3>
        <p>This loads again on its own in a moment.</p>
        {onRetry && <div className="actions"><Button icon="refresh" onClick={onRetry}>Try again</Button></div>}
      </div>
    );
  }
  return (
    <div className={`${compact ? "empty-state empty-state-sm" : "empty-state"} error-state`} role="alert">
      <span className="empty-icon"><Icon name={notFound ? "search" : "alert"} size={compact ? 20 : 24} /></span>
      <h3>{title ?? (notFound ? "Not found" : "Couldn't load this")}</h3>
      <p>{badLink ? "That link isn't valid. It may be incomplete or mistyped." : errorMessage(error)}</p>
      {onRetry && !notFound && <div className="actions"><Button icon="refresh" onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

/** Card-wrapped error for whole-screen failures. */
export function PageError({ error, onRetry, back }: { error: unknown; onRetry?: () => void; back?: ReactNode }) {
  return (
    <>
      {back}
      <div className="card"><ErrorState error={error} onRetry={onRetry} /></div>
    </>
  );
}

/** A whole screen the person's role doesn't include. */
export function NoAccess({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="card"><EmptyState icon="lock" title="You don't have access to this">Ask an admin if you need it.</EmptyState></div>
    </>
  );
}
