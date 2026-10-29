/**
 * While Crewtavo restarts (a deploy, or Railway bringing it back), the proxy in front of it answers
 * 502, 503 or 504 (isRestarting). Rather than every card shimmering and then failing on its own, one
 * banner says so, counts down, loads what's on the screen again, and says when it's back. A request
 * that gets no answer at all (status 0) is the offline pill's to explain, not this banner's.
 */
import { useQueryClient, type Query } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, isRestarting } from "@/lib/errors";
import { Spinner } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { motion, play, topLayerProps, useTopLayer } from "../ui/topLayer";

/** Seconds before it tries again by itself. */
const COUNTDOWN = 8;
/** How long "Crewtavo is back" stays up. */
const BACK_FOR = 1500;

/** Answered for Crewtavo while it restarts: the restart banner explains it, so a screen needn't. */
export const isRestartError = (error: unknown) => error instanceof ApiError && isRestarting(error.status);
/** Why a query last failed: the error it's trying again after, or the one it gave up on. */
const lastError = (q: Query) => q.state.fetchFailureReason ?? (q.state.status === "error" ? q.state.error : null);

type Phase = "idle" | "restarting" | "back";

const HIDDEN: Keyframe = { opacity: 0, transform: "translateY(-8px) scale(0.97)" };
const SHOWN: Keyframe = { opacity: 1, transform: "none" };

export function RestartBanner() {
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  /** The queries on the screen that Crewtavo's restart turned away, by queryHash, until they load. */
  const waitingFor = useRef(new Set<string>());
  const phaseRef = useRef<Phase>("idle");
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(COUNTDOWN);
  const [trying, setTrying] = useState(false);
  // In the top layer from the moment it's needed until its exit has played.
  const [shown, setShown] = useState(false);
  const go = (next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      scheduled = undefined;
      for (const q of cache.getAll()) if (q.isActive() && isRestartError(lastError(q))) waitingFor.current.add(q.queryHash);
      let waiting = 0;
      let recovered = 0;
      for (const hash of waitingFor.current) {
        const q = cache.get(hash);
        // Off the screen now: no longer this banner's to wait for.
        if (!q?.isActive()) waitingFor.current.delete(hash);
        else if (isRestartError(lastError(q)) || q.state.status === "pending") waiting++;
        else if (q.state.status === "success") recovered++;
        // Failed some other way (no signal, a refusal): the screen and the offline pill say how.
        else waitingFor.current.delete(hash);
      }
      if (waiting) {
        if (phaseRef.current !== "restarting") {
          setSeconds(COUNTDOWN);
          go("restarting");
        }
        return;
      }
      if (phaseRef.current === "restarting") go(recovered ? "back" : "idle");
      waitingFor.current.clear();
    };
    // The cache reports every fetch and every observer; once per turn is plenty.
    const unsubscribe = cache.subscribe(() => {
      scheduled ??= setTimeout(check);
    });
    check();
    return () => {
      unsubscribe();
      clearTimeout(scheduled);
    };
  }, [queryClient]);

  const tryNow = useCallback(async () => {
    setTrying(true);
    await queryClient.refetchQueries({ predicate: (q) => waitingFor.current.has(q.queryHash) }).catch(() => undefined);
    setTrying(false);
    setSeconds(COUNTDOWN);
  }, [queryClient]);

  // Counting down, then trying again (and counting down again if it's still restarting).
  useEffect(() => {
    if (phase !== "restarting" || trying) return;
    if (seconds <= 0) return void tryNow();
    const tick = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(tick);
  }, [phase, seconds, trying, tryNow]);

  useEffect(() => {
    if (phase !== "back") return;
    const leave = setTimeout(() => go("idle"), BACK_FOR);
    return () => clearTimeout(leave);
  }, [phase]);

  // What it says while it leaves: the last thing it said.
  const said = useRef<Exclude<Phase, "idle">>("restarting");
  if (phase !== "idle") said.current = phase;
  const visible = phase !== "idle";

  useEffect(() => {
    if (visible) return setShown(true);
    if (!shown) return;
    let current = true;
    void play(ref.current, [SHOWN, HIDDEN], { ...motion("exit"), fill: "forwards" }).then((done) => done && current && setShown(false));
    return () => {
      current = false;
    };
  }, [visible, shown]);
  useTopLayer(ref, shown);
  // After useTopLayer has put it up; again if it's needed while it leaves.
  useLayoutEffect(() => {
    if (visible && shown) void play(ref.current, [HIDDEN, SHOWN], motion("enter"));
  }, [visible, shown]);

  const back = said.current === "back";
  return (
    <div ref={ref} className="restart-banner" data-back={back || undefined} data-shown={shown || undefined} role="status" aria-live="polite" {...topLayerProps}>
      {back ? (
        <>
          <Icon name="check" size={16} strokeWidth={2} />
          Crewtavo is back
        </>
      ) : (
        <>
          <Spinner size={14} />
          <span>
            Crewtavo is restarting. <span aria-hidden="true">{trying ? "Trying again…" : `Trying again in ${seconds}s`}</span>
            <span className="sr-only">It tries again by itself.</span>
          </span>
          {/* While it tries it ignores presses but keeps focus (aria-disabled, not disabled). */}
          <button type="button" className="restart-banner-try" aria-disabled={trying || undefined} onClick={() => !trying && void tryNow()}>Try now</button>
        </>
      )}
    </div>
  );
}
