import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "./Button";
import { Icon } from "./Icon";

export type SaveState = "idle" | "edited" | "saving" | "saved" | "error";

export interface SaveStatusHandle {
  status: SaveState;
  /** Something was changed and not saved yet (call it from onChange). */
  edited: () => void;
  /** Follows a save: "Saving…" while it runs, then "Saved" or "Couldn't save". Returns the same promise. */
  track: <T>(promise: Promise<T>) => Promise<T>;
  reset: () => void;
}

/** How long "Saved" stays before it fades. */
const SAVED_FOR = 3000;

/**
 * The save status of a page whose fields save when they lose focus, for <SaveStatus /> in its header:
 * onChange={() => save.edited()} onBlur={() => save.track(update.mutateAsync({ notes }))}.
 * Several saves can run at once; it says "Saved" once they've all finished, unless one failed.
 */
export function useSaveStatus(): SaveStatusHandle {
  const [status, setStatus] = useState<SaveState>("idle");
  const running = useRef(0);
  const failed = useRef(false);
  const dirty = useRef(false);

  const edited = useCallback(() => {
    dirty.current = true;
    if (!running.current) setStatus("edited");
  }, []);

  const track = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    if (!running.current) failed.current = false;
    running.current += 1;
    dirty.current = false;
    setStatus("saving");
    const settle = (ok: boolean) => {
      running.current -= 1;
      if (!ok) failed.current = true;
      if (running.current) return;
      setStatus(failed.current ? "error" : dirty.current ? "edited" : "saved");
    };
    // The handlers count as handling a failure, so a caller that doesn't catch it isn't warned about one.
    promise.then(() => settle(true), () => settle(false));
    return promise;
  }, []);

  const reset = useCallback(() => {
    dirty.current = false;
    failed.current = false;
    setStatus("idle");
  }, []);

  useEffect(() => {
    if (status !== "saved") return;
    const timer = setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), SAVED_FOR);
    return () => clearTimeout(timer);
  }, [status]);

  return useMemo(() => ({ status, edited, track, reset }), [status, edited, track, reset]);
}

/**
 * "Edited", "Saving…", "Saved" or "Couldn't save. Try again." for the page header's meta line
 * (.page-meta), next to the status pill: <SaveStatus status={save.status} />. "Saved" fades away.
 */
export function SaveStatus({ status }: { status: SaveState }) {
  // The last thing said stays while it fades out, rather than vanishing.
  const [last, setLast] = useState<SaveState>(status);
  useEffect(() => {
    if (status !== "idle") setLast(status);
  }, [status]);
  const shown = status === "idle" ? last : status;
  return (
    <span className="save-status" data-state={shown} data-hidden={status === "idle" || undefined} aria-live="polite">
      {shown === "edited" && "Edited"}
      {shown === "saving" && (
        <>
          <Spinner size={12} />
          Saving…
        </>
      )}
      {shown === "saved" && (
        <>
          <Icon name="check" size={14} strokeWidth={2} />
          Saved
        </>
      )}
      {shown === "error" && (
        <>
          <Icon name="alert" size={14} />
          Couldn't save. Try again.
        </>
      )}
    </span>
  );
}
