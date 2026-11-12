/**
 * On field screens: no signal, and how many updates are waiting to send. Photos count once the phone
 * has kept them (lib/offlinePhotos.ts); one it couldn't keep, or one the server turned down, is said
 * apart, so nothing is called saved that isn't. The same when the phone has no room left for the
 * updates themselves (lib/offline.ts): they're held by the open app, and it says to keep it open.
 */
import { onlineManager, useMutationState } from "@tanstack/react-query";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Icon } from "@/components/ui/Icon";
import { OFFLINE_MUTATIONS, subscribeUnsaved, unsavedFieldActions } from "@/lib/offline";
import { phonePhotos, removePhonePhoto, retryPhonePhotos, subscribePhonePhotos } from "@/lib/offlinePhotos";
import { useSession } from "@/lib/session";

/** Whether there's signal, as the app knows it: no signal, or requests that don't get through. */
export const useSignal = () => useSyncExternalStore(onlineManager.subscribe.bind(onlineManager), () => onlineManager.isOnline());

/** Saves made as the crew goes: each one has the whole checklist or all the notes, so each checklist and a visit's notes count once. */
const WHOLE = new Set(["checklist-save", "visit-notes"]);

/** With signal, how long updates wait before it says they're sending: one waiting its turn behind another goes in a moment. */
const LATE = 1_000;

const photoCount = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

export function OfflineNote() {
  const online = useSignal();
  const { userId } = useSession();
  const photos = useSyncExternalStore(subscribePhonePhotos, phonePhotos).filter((p) => p.userId === userId);
  const refused = photos.filter((p) => p.problem);
  // With signal a photo is on its way, and its visit's Photos card shows it going.
  const held = online ? [] : photos.filter((p) => !p.problem);
  const unsaved = held.filter((p) => !p.kept);
  const unsavedUpdates = useSyncExternalStore(subscribeUnsaved, unsavedFieldActions);
  const paused = useMutationState({
    filters: { predicate: (m) => m.state.isPaused && OFFLINE_MUTATIONS.has(String(m.options.mutationKey?.[0])) },
    select: (m) => {
      const key = String(m.options.mutationKey?.[0]);
      const v = m.state.variables as { visitId?: string; responseId?: string } | undefined;
      return { id: WHOLE.has(key) ? `${key}:${v?.visitId}:${v?.responseId ?? ""}` : String(m.mutationId), at: m.state.submittedAt };
    },
  });
  const updates = new Set(paused.map((p) => p.id)).size;
  const waiting = Math.max(0, updates - unsavedUpdates) + held.length - unsaved.length;
  const since = paused.length ? Math.min(...paused.map((p) => p.at)) : 0;
  const late = since > 0 && Date.now() - since >= LATE;
  // Looks again once the oldest has waited long enough.
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!online || !since || late) return;
    const timer = setTimeout(recheck, since + LATE - Date.now());
    return () => clearTimeout(timer);
  }, [online, since, late]);
  const removeRefused = async () => {
    const ok = await confirm({ title: refused.length === 1 ? "Remove this photo?" : `Remove ${refused.length} photos?`, body: refused.length === 1 ? "It hasn't uploaded, so it will be gone for good." : "They haven't uploaded, so they will be gone for good.", confirmLabel: "Remove", danger: true });
    if (ok) refused.forEach((p) => removePhonePhoto(p.id));
  };
  return (
    <>
      {(!online || (updates > 0 && late)) && (
        <div className="callout callout-info" role="status">
          <Icon name="wifiOff" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            <div>{online ? "Sending your updates…" : "No signal"}</div>
            {waiting ? `${waiting} ${waiting === 1 ? "update is" : "updates are"} saved on this phone and will send when you have signal.` : unsavedUpdates ? "Your updates send when you have signal." : "You can keep working: your updates are saved on this phone and sent when you have signal."}
          </div>
        </div>
      )}
      {unsavedUpdates > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            <div>This phone is out of room</div>
            Your last {unsavedUpdates === 1 ? "update isn't" : `${unsavedUpdates} updates aren't`} saved on it. Keep Crewtavo open until you have signal and {unsavedUpdates === 1 ? "it has" : "they have"} sent, or {unsavedUpdates === 1 ? "it" : "they"} will be lost.
          </div>
        </div>
      )}
      {unsaved.length > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={20} />
          <div className="grow small" style={{ fontWeight: 400 }}>
            <div>This phone couldn't save {photoCount(unsaved.length)}</div>
            Keep Crewtavo open until you have signal, or {unsaved.length === 1 ? "it" : "they"} will be lost.
          </div>
        </div>
      )}
      {refused.length > 0 && (
        <div className="callout callout-danger" role="status">
          <Icon name="alert" size={20} />
          <div className="grow small stack-sm" style={{ fontWeight: 400 }}>
            <div>{photoCount(refused.length)} didn't upload</div>
            <span>{refused[0]!.problem} The office may have changed the visit. {refused.length === 1 ? "It's" : "They're"} still on this phone.</span>
            <span className="row" style={{ gap: 8 }}>
              <Button size="sm" icon="refresh" onClick={() => retryPhonePhotos(userId)}>Try again</Button>
              <Button size="sm" variant="ghost" onClick={() => void removeRefused()}>Remove</Button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
