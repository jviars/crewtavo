/** On field screens: no signal, and how many updates are waiting to send. */
import { onlineManager, useMutationState } from "@tanstack/react-query";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { OFFLINE_MUTATIONS } from "@/lib/offline";

/** Whether there's signal, as the app knows it: no signal, or requests that don't get through. */
export const useSignal = () => useSyncExternalStore(onlineManager.subscribe.bind(onlineManager), () => onlineManager.isOnline());

/** Saves made as the crew goes: each one has the whole checklist or all the notes, so a visit's count once. */
const WHOLE = new Set(["checklist-save", "visit-notes"]);

/** With signal, how long updates wait before it says they're sending: one waiting its turn behind another goes in a moment. */
const LATE = 1_000;

export function OfflineNote() {
  const online = useSignal();
  const paused = useMutationState({
    filters: { predicate: (m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0])) },
    select: (m) => {
      const key = String(m.options.mutationKey?.[0]);
      return { id: WHOLE.has(key) ? `${key}:${(m.state.variables as { visitId?: string } | undefined)?.visitId}` : String(m.mutationId), at: m.state.submittedAt };
    },
  });
  const waiting = new Set(paused.map((p) => p.id)).size;
  const since = paused.length ? Math.min(...paused.map((p) => p.at)) : 0;
  const late = since > 0 && Date.now() - since >= LATE;
  // Looks again once the oldest has waited long enough.
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!online || !since || late) return;
    const timer = setTimeout(recheck, since + LATE - Date.now());
    return () => clearTimeout(timer);
  }, [online, since, late]);
  if (online && (!waiting || !late)) return null;
  return (
    <div className="callout callout-info" role="status">
      <Icon name="wifiOff" size={20} />
      <div className="grow small" style={{ fontWeight: 400 }}>
        <div>{online ? "Sending your updates…" : "No signal"}</div>
        {waiting ? `${waiting} ${waiting === 1 ? "update is" : "updates are"} saved on this phone and will send when you have signal.` : "You can keep working: your updates are saved on this phone and sent when you have signal."}
      </div>
    </div>
  );
}
