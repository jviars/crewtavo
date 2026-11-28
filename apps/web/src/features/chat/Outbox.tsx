/**
 * The messages waiting on this phone for signal (outbox.ts), at the bottom of their conversation,
 * or of their thread for a thread's reply: dimmed, with a clock, under a line that says how many
 * there are. Tapping one offers Send now and Delete. One the server turned down when it was tried
 * again says why. One just sent from the box shows only once its answer is slow in coming.
 */
import { chatPlainText, type MessagePart } from "@crewtavo/core/chat";
import { chatDocumentType, chatFileKind } from "@crewtavo/core/chatContent";
import { clockText, isAudio } from "@crewtavo/core/chatField";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { t } from "@/lib/i18n";
import { DOCUMENT_ICONS } from "./ChatFiles";
import { deleteWaiting, sendWaitingNow, useWaiting, useWaitingCounts, type WaitingMessage } from "./outbox";
import f from "./field.module.css";

/** How long a send from the box goes unshown: most are answered well within it. */
const SLOW_MS = 2_000;

type Namer = (part: Exclude<MessagePart, { kind: "text" }>) => string;

export function WaitingMessages({ me, companyId, channelId, threadRoot = null, name }: { me: string; companyId: string; channelId: string; threadRoot?: string | null; name: Namer }) {
  const all = useWaiting(me, companyId, channelId, threadRoot);
  const [now, setNow] = useState(() => Date.now());
  // A send from the box shows once it's slow: look again when the first such one would be.
  const soon = all.filter((m) => m.direct && now - m.createdAt <= SLOW_MS).map((m) => m.createdAt + SLOW_MS + 50);
  const next = soon.length ? Math.min(...soon) : null;
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [next]);
  const list = all.filter((m) => !m.direct || now - m.createdAt > SLOW_MS);
  if (!list.length) return null;
  const count = t.plural(list.length, { one: "{count} message waiting for signal", other: "{count} messages waiting for signal" });
  return (
    <div className={f.waitingList} aria-label={count} role="group">
      <div className={f.waitingLine} role="separator">
        <Icon name="clock" size={12} />
        <span>{count}</span>
      </div>
      {list.map((m) => <Waiting key={m.id} message={m} name={name} />)}
    </div>
  );
}

function Waiting({ message, name }: { message: WaitingMessage; name: Namer }) {
  // Its photos from the phone itself while they haven't gone up; documents by their icon and name.
  const photos = useMemo(() => message.attachments.map((a) => (a.body && chatFileKind(a) === "photo" ? URL.createObjectURL(a.body) : null)), [message.attachments]);
  useEffect(() => () => photos.forEach((url) => url && URL.revokeObjectURL(url)), [photos]);
  const words = chatPlainText(message.body, name);
  const voice = message.attachments.find(isAudio);
  const documents = message.attachments.filter((a) => chatFileKind(a) === "document");
  const photoCount = message.attachments.filter((a) => chatFileKind(a) === "photo").length;
  const stored = photoCount - photos.filter(Boolean).length;
  const state = message.sending ? t("Sending…") : message.problem ? t("Didn't send: {reason}", { reason: message.problem }) : t("Waiting for signal");
  // What a screen reader hears on the button: its state, then what the message says and carries.
  const label = [
    state,
    words,
    voice ? `${t("Voice note")} ${clockText(voice.duration ?? 0)}` : "",
    ...documents.map((d) => d.name ?? ""),
    photoCount ? t.plural(photoCount, { one: "{count} photo", other: "{count} photos" }) : "",
  ].filter(Boolean).join(". ");
  return (
    <Menu
      label={label}
      title={t("Waiting for signal")}
      align="start"
      triggerClassName={f.waiting}
      trigger={
        <>
          <span className={f.waitingClock} aria-hidden="true"><Icon name={message.problem ? "alertCircle" : "clock"} size={16} /></span>
          <span className={f.waitingMain} aria-hidden="true">
            <span className={f.waitingState} data-problem={message.problem ? "" : undefined}>{state}</span>
            {words && <span className={f.waitingText}>{words}</span>}
            {voice && <span className={f.waitingText}><Icon name="microphone" size={12} /> {t("Voice note")} · {clockText(voice.duration ?? 0)}</span>}
            {documents.map((d) => (
              <span key={d.path} className={f.waitingText}><Icon name={DOCUMENT_ICONS[chatDocumentType(d)]} size={14} /> {d.name}</span>
            ))}
            {photoCount > 0 && (
              <span className={f.waitingPhotos}>
                {photos.map((url, i) => url && <img key={i} src={url} alt="" />)}
                {stored > 0 && <span className={f.waitingText}><Icon name="image" size={14} /> {t.plural(stored, { one: "{count} photo", other: "{count} photos" })}</span>}
              </span>
            )}
          </span>
        </>
      }
      items={[
        { label: t("Send now"), icon: "send", onSelect: () => sendWaitingNow(message.id), disabled: message.sending },
        { separator: true },
        { label: t("Delete"), icon: "trash", danger: true, onSelect: () => deleteWaiting(message.id), disabled: message.sending },
      ]}
    />
  );
}

/** For the channel list: how many of my messages wait in each channel. */
export function useWaitingByChannel(me: string, companyId: string) {
  return useWaitingCounts(me, companyId);
}

export function WaitingCount({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className={f.waitingCount} title={t.plural(count, { one: "{count} message waiting for signal", other: "{count} messages waiting for signal" })} aria-hidden="true">
      <Icon name="clock" size={12} />
      {count}
    </span>
  );
}
