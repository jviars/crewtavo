/**
 * The composer while a voice note is made (voice.ts): recording shows the time, up to five minutes,
 * and how loud it hears you, with Stop; stopped, it can be played back, then sent or deleted.
 */
import { clockText, VOICE_MAX_SECONDS } from "@crewtavo/core/chatField";
import { useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import type { useVoiceRecorder } from "./voice";
import f from "./field.module.css";

type Recorder = ReturnType<typeof useVoiceRecorder>;
export type VoicePreview = Extract<Recorder["recording"], { phase: "preview" }>;

/** The microphone button: in the composer beside the camera on a computer, in the send button's place on a phone while the box is empty. */
export function MicButton({ onClick, round, disabled }: { onClick: () => void; round?: boolean; disabled?: boolean }) {
  return (
    <button type="button" className={round ? f.micRound : f.micBtn} aria-label={t("Record a voice note")} title={t("Record a voice note")} onClick={onClick} disabled={disabled}>
      <Icon name="microphone" size={19} />
    </button>
  );
}

export function VoiceRecorder({ recorder, onSend, sending }: { recorder: Recorder; onSend: (note: VoicePreview) => void; sending?: boolean }) {
  const { recording, seconds, level } = recorder;
  if (recording.phase === "error") {
    return (
      <div className={f.recorder} role="alert">
        <Icon name="alertCircle" size={18} />
        <span className={f.recorderNote}>{recording.message}</span>
        <button type="button" className={f.recorderBtn} aria-label={t("Close")} onClick={recorder.discard}><Icon name="x" size={18} /></button>
      </div>
    );
  }
  if (recording.phase === "preview") return <Preview note={recording} onDelete={recorder.discard} onSend={() => onSend(recording)} sending={sending} />;
  const left = VOICE_MAX_SECONDS - seconds;
  return (
    <div className={f.recorder}>
      <button type="button" className={f.recorderBtn} aria-label={t("Cancel the voice note")} onClick={recorder.discard}><Icon name="x" size={18} /></button>
      <span className={f.recDot} aria-hidden="true" />
      <span className={f.recTime} role="timer" aria-live="off">
        {recording.phase === "starting" ? t("Starting…") : clockText(seconds)}
        {left <= 30 && recording.phase === "recording" && <small>{t("{time} left", { time: clockText(left) })}</small>}
      </span>
      <span className={f.level} aria-hidden="true">
        {[0.15, 0.3, 0.5, 0.7, 0.9].map((step) => <i key={step} data-on={level >= step || undefined} />)}
      </span>
      <span className="sr-only" aria-live="polite">{recording.phase === "recording" ? t("Recording") : ""}</span>
      <button type="button" className={f.stopBtn} onClick={recorder.stop} disabled={recording.phase !== "recording"} aria-label={t("Stop recording")}>
        <Icon name="stop" size={16} filled />
        <span className={f.stopText}>{t("Stop")}</span>
      </button>
    </div>
  );
}

function Preview({ note, onDelete, onSend, sending }: { note: VoicePreview; onDelete: () => void; onSend: () => void; sending?: boolean }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setPlaying(false));
    else el.pause();
  };
  const done = note.seconds ? Math.min(100, (at / note.seconds) * 100) : 0;
  return (
    <div className={f.recorder}>
      <button type="button" className={f.recorderBtn} aria-label={t("Delete the voice note")} title={t("Delete")} onClick={onDelete}><Icon name="trash" size={18} /></button>
      <button type="button" className={f.playBtn} aria-label={playing ? t("Pause the voice note") : t("Play the voice note")} onClick={toggle}>
        <Icon name={playing ? "pause" : "play"} size={16} filled />
      </button>
      <span className={f.track} aria-hidden="true"><span className={f.trackFill} style={{ width: `${done}%` }} /></span>
      <span className={f.voiceTime}>{clockText(playing || at > 0 ? at : note.seconds)}</span>
      <button type="button" className={`btn btn-sm btn-primary ${f.voiceSend}`} onClick={onSend} disabled={sending} aria-label={t("Send the voice note")}>
        <Icon name="arrowUp" size={18} />
        <span className={f.stopText}>{t("Send")}</span>
      </button>
      <audio
        ref={audio}
        src={note.url}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setAt(0);
        }}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
    </div>
  );
}
