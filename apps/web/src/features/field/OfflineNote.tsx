/** On field screens: no signal, and how many updates are waiting to send. */
import { onlineManager, useMutationState } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { Icon } from "@/components/ui/Icon";
import { OFFLINE_MUTATIONS } from "@/lib/offline";

export function OfflineNote() {
  const online = useSyncExternalStore(onlineManager.subscribe.bind(onlineManager), () => onlineManager.isOnline());
  const waiting = useMutationState({ filters: { predicate: (m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0])) } }).length;
  if (online && !waiting) return null;
  return (
    <div className="callout callout-info" role="status">
      <Icon name="wifiOff" size={18} />
      <div className="grow small" style={{ fontWeight: 400 }}>
        <div style={{ fontWeight: 700 }}>{online ? "Sending your updates…" : "No signal"}</div>
        {waiting ? `${waiting} ${waiting === 1 ? "update is" : "updates are"} saved on this phone and will send when you have signal.` : "You can keep working: your updates are saved on this phone and sent when you have signal."}
      </div>
    </div>
  );
}
