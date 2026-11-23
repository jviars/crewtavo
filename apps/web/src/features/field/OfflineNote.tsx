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
import { t } from "@/lib/i18n";

/** Whether there's signal, as the app knows it: no signal, or requests that don't get through. */
export const useSignal = () => useSyncExternalStore(onlineManager.subscribe.bind(onlineManager), () => onlineManager.isOnline());

/** Saves made as the crew goes: each one has the whole checklist or all the notes, so each checklist and a visit's notes count once. */
const WHOLE = new Set(["checklist-save", "visit-notes"]);

/** With signal, how long updates wait before it says they're sending: one waiting its turn behind another goes in a moment. */
const LATE = 1_000;


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
    const ok = await confirm({ title: refused.length === 1 ? t("Remove this photo?") : t("Remove {count} photos?", { count: refused.length }), body: refused.length === 1 ? t("It hasn't uploaded, so it will be gone for good.") : t("They haven't uploaded, so they will be gone for good."), confirmLabel: t("Remove"), danger: true });
    if (ok) refused.forEach((p) => removePhonePhoto(p.id));
  };
  return (
    <>
      {(!online || (updates > 0 && late)) && (
        <div className="callout callout-info" role="status">
          <Icon name="wifiOff" size={16} />
          <div className="grow">
            <div>{online ? t("Sending your updates…") : t("No signal")}</div>
            {waiting ? t.plural(waiting, { one: "{count} update is saved on this phone and will send when you have signal.", other: "{count} updates are saved on this phone and will send when you have signal." }) : unsavedUpdates ? t("Your updates send when you have signal.") : t("You can keep working: your updates are saved on this phone and sent when you have signal.")}
          </div>
        </div>
      )}
      {unsavedUpdates > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>{t("This phone is out of room")}</div>
            {t.plural(unsavedUpdates, {
              one: "Your last update isn't saved on it. Keep Crewtavo open until you have signal and it has sent, or it will be lost.",
              other: "Your last {count} updates aren't saved on it. Keep Crewtavo open until you have signal and they have sent, or they will be lost.",
            })}
          </div>
        </div>
      )}
      {unsaved.length > 0 && (
        <div className="callout callout-warning" role="status">
          <Icon name="alert" size={16} />
          <div className="grow">
            <div>{t.plural(unsaved.length, { one: "This phone couldn't save {count} photo", other: "This phone couldn't save {count} photos" })}</div>
            {unsaved.length === 1 ? t("Keep Crewtavo open until you have signal, or it will be lost.") : t("Keep Crewtavo open until you have signal, or they will be lost.")}
          </div>
        </div>
      )}
      {refused.length > 0 && (
        <div className="callout callout-danger" role="status">
          <Icon name="alert" size={16} />
          <div className="grow geofence-ask">
            <div>{t.plural(refused.length, { one: "{count} photo didn't upload", other: "{count} photos didn't upload" })}</div>
            <span>{refused[0]!.problem} {refused.length === 1 ? t("The office may have changed the visit. It's still on this phone.") : t("The office may have changed the visit. They're still on this phone.")}</span>
            <span className="field-ask-acts">
              <Button size="sm" icon="refresh" onClick={() => retryPhonePhotos(userId)}>{t("Try again")}</Button>
              <Button size="sm" variant="ghost" onClick={() => void removeRefused()}>{t("Remove")}</Button>
            </span>
          </div>
        </div>
      )}
    </>
  );
}
