/**
 * The messages waiting on this phone for signal (outbox.ts), at the bottom of their conversation:
 * dimmed, with a clock, under a line that says how many there are. Tapping one offers Send now and
 * Delete. One the server turned down when it was tried again says why.
 */
import { chatPlainText, type MessagePart } from "@crewtavo/core/chat";
import { clockText, isAudio } from "@crewtavo/core/chatField";
import { useEffect, useMemo } from "react";
import { Icon } from "@/components/ui/Icon";
import { Menu } from "@/components/ui/Menu";
import { t } from "@/lib/i18n";
import { deleteWaiting, sendWaitingNow, useWaiting, useWaitingCounts, type WaitingMessage } from "./outbox";
import f from "./field.module.css";

export function WaitingMessages({ me, companyId, channelId, name }: { me: string; companyId: string; channelId: string; name: (part: Exclude<MessagePart, { kind: "text" }>) => string }) {
  const list = useWaiting(me, companyId, channelId);
  if (!list.length) return null;
  return (
    <div className={f.waitingList} aria-label={t.plural(list.length, { one: "{count} message waiting for signal", other: "{count} messages waiting for signal" })} role="group">
      <div className={f.waitingLine} role="separator">
        <Icon name="clock" size={12} />
        <span>{t.plural(list.length, { one: "{count} message waiting for signal", other: "{count} messages waiting for signal" })}</span>
      </div>
      {list.map((m) => <Waiting key={m.id} message={m} name={name} />)}
    </div>
  );
}

function Waiting({ message, name }: { message: WaitingMessage; name: (part: Exclude<MessagePart, { kind: "text" }>) => string }) {
  // Its photos from the phone itself, while they haven't gone up.
  const previews = useMemo(() => message.attachments.map((a) => (a.body && !isAudio(a) ? URL.createObjectURL(a.body) : null)), [message.attachments]);
  useEffect(() => () => previews.forEach((url) => url && URL.revokeObjectURL(url)), [previews]);
  const words = chatPlainText(message.body, name);
  const voice = message.attachments.find(isAudio);
  return (
    <Menu
      label={t("A message waiting for signal")}
      title={t("Waiting for signal")}
      align="start"
      triggerClassName={f.waiting}
      trigger={
        <>
          <span className={f.waitingClock} aria-hidden="true"><Icon name={message.problem ? "alertCircle" : "clock"} size={16} /></span>
          <span className={f.waitingMain}>
            <span className={f.waitingState} data-problem={message.problem ? "" : undefined}>
              {message.sending ? t("Sending…") : message.problem ? t("Didn't send: {reason}", { reason: message.problem }) : t("Waiting for signal")}
            </span>
            {words && <span className={f.waitingText}>{words}</span>}
            {voice && <span className={f.waitingText}><Icon name="microphone" size={12} /> {t("Voice note")} · {clockText(voice.duration ?? 0)}</span>}
            {previews.some(Boolean) && (
              <span className={f.waitingPhotos}>
                {previews.map((url, i) => url && <img key={i} src={url} alt="" />)}
              </span>
            )}
          </span>
        </>
      }
      items={[
        { label: t("Send now"), icon: "send", onSelect: () => sendWaitingNow(message.id), disabled: message.sending },
        { separator: true },
        { label: t("Delete"), icon: "trash", danger: true, onSelect: () => deleteWaiting(message.id) },
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
