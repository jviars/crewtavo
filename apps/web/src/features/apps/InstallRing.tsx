/**
 * What Install turns into once pressed, like an app store's: a ring that fills while the app
 * installs ("working"), then completes ("done") before Uninstall takes its place. While the setup
 * below waits on the person (a key, a calendar link, an assistant connecting) it spins instead
 * ("waiting"), with a square in the middle that stops installing.
 */
import { useEffect, useState } from "react";

export type InstallPhase = "working" | "waiting" | "done";

const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function InstallRing({ phase, name, onStop }: { phase: InstallPhase; name: string; onStop: () => void }) {
  // How far it's got isn't known, so it eases toward 90% until installing finishes.
  const [progress, setProgress] = useState(0.08);
  useEffect(() => {
    if (phase === "done") return setProgress(1);
    if (phase !== "working") return;
    const timer = setInterval(() => setProgress((p) => p + (0.9 - p) * 0.14), 120);
    return () => clearInterval(timer);
  }, [phase]);

  const ring = (
    <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
      <circle className="install-ring-track" cx="18" cy="18" r={RADIUS} />
      <circle
        className="install-ring-arc"
        cx="18"
        cy="18"
        r={RADIUS}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - (phase === "waiting" ? 0.25 : progress))}
      />
    </svg>
  );
  if (phase === "waiting") {
    return (
      <span className="install-ring-slot">
        <button type="button" className="install-ring" data-phase="waiting" aria-label={`Stop installing ${name}`} title="Stop installing" onClick={onStop}>
          {ring}
          <span className="install-ring-stop" aria-hidden="true" />
        </button>
      </span>
    );
  }
  return (
    <span className="install-ring-slot">
      <span className="install-ring" data-phase={phase} role="progressbar" aria-label={`Installing ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
        {ring}
      </span>
    </span>
  );
}
