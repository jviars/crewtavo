/** On field screens: no signal, and how many updates are waiting to send. */
import { onlineManager, useMutationState } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { OFFLINE_MUTATIONS } from "@/lib/offline";

/** Whether there's signal, as the app knows it: no signal, or requests that don't get through. */
export const useSignal = () => useSyncExternalStore(onlineManager.subscribe.bind(onlineManager), () => onlineManager.isOnline());

/** Saves made as the crew goes: each one has the whole checklist or all the notes, so a visit's count once. */
const WHOLE = new Set(["checklist-save", "visit-notes"]);

export function OfflineNote() {
  const online = useSignal();
  const waiting = new Set(
    useMutationState({
      filters: { predicate: (m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0])) },
      select: (m) => {
        const key = String(m.options.mutationKey?.[0]);
        return WHOLE.has(key) ? `${key}:${(m.state.variables as { visitId?: string } | undefined)?.visitId}` : m.mutationId;
      },
    }),
  ).size;
  if (online && !waiting) return null;
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
