/**
 * Recording a voice note: tap to start (no holding, so it works in gloves), a level to show it's
 * hearing you, up to five minutes, then a preview to play, send or delete. MediaRecorder makes the
 * best kind the browser has (core recordingType: WebM with Opus on Chrome, Android and Firefox; MP4
 * on Safari and iPhones). Where the browser has speech recognition of its own, it listens too, in
 * the person's language, and its words go with the note; it costs nothing and nothing leaves the
 * phone for it but what the browser itself sends. iPhones are left out: their speech recognition
 * and a recording can't share the microphone.
 */
import { recordedFile, recordingType, VOICE_MAX_SECONDS } from "@crewtavo/core/chatField";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { browserOrSpanish, t } from "@/lib/i18n";

export type Recording =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "recording" }
  | { phase: "preview"; blob: Blob; url: string; type: string; ext: string; seconds: number; words: string }
  | { phase: "error"; message: string };

interface Listener {
  start(): void;
  stop(): void;
  abort(): void;
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
type ListenerClass = new () => Listener;

const isIPhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** The browser's own speech recognition, where it has one that can run beside a recording. */
function speechListener(): ListenerClass | null {
  if (typeof window === "undefined" || isIPhone()) return null;
  const w = window as unknown as { SpeechRecognition?: ListenerClass; webkitSpeechRecognition?: ListenerClass };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Why the microphone couldn't be used, in words that say how to fix it. */
export function microphoneProblem(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return isIPhone()
      ? t("Crewtavo isn't allowed to use the microphone. On an iPhone, open Settings → Safari → Microphone (or the aA menu → Website settings) and choose Allow, then try again.")
      : t("Crewtavo isn't allowed to use the microphone. Tap the lock or the settings icon by the address bar, allow the microphone for this site, then try again.");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("No microphone was found on this device.");
  if (name === "NotReadableError") return t("Another app is using the microphone. Close it and try again.");
  return t("The microphone couldn't start. Try again.");
}

/** Records one voice note at a time. `seconds` and `level` (0 to 1) change while recording. */
export function useVoiceRecorder() {
  const [recording, setRecording] = useState<Recording>({ phase: "idle" });
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const parts = useRef<{
    recorder?: MediaRecorder;
    stream?: MediaStream;
    audio?: AudioContext;
    frame?: number;
    timer?: ReturnType<typeof setInterval>;
    listener?: Listener;
    heard: string[];
    hearing: string;
    started: number;
    keep: boolean;
  }>({ heard: [], hearing: "", started: 0, keep: true });

  const release = useCallback(() => {
    const p = parts.current;
    if (p.frame) cancelAnimationFrame(p.frame);
    clearInterval(p.timer);
    p.stream?.getTracks().forEach((track) => track.stop());
    void p.audio?.close().catch(() => undefined);
    if (p.listener) {
      p.listener.onend = null;
      try {
        p.listener.stop();
      } catch {
        // Already stopped.
      }
    }
    p.frame = undefined;
    p.timer = undefined;
    p.stream = undefined;
    p.audio = undefined;
    p.listener = undefined;
    setLevel(0);
  }, []);

  const start = useCallback(async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecording({ phase: "error", message: t("This browser can't record voice notes. Try Chrome, Safari or Firefox.") });
      return;
    }
    setRecording({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      setRecording({ phase: "error", message: microphoneProblem(error) });
      return;
    }
    const kind = recordingType((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, kind.mimeType ? { mimeType: kind.mimeType, audioBitsPerSecond: 32_000 } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setRecording({ phase: "error", message: t("This browser can't record voice notes. Try Chrome, Safari or Firefox.") });
      return;
    }
    const p = parts.current;
    const chunks: Blob[] = [];
    p.recorder = recorder;
    p.stream = stream;
    p.heard = [];
    p.hearing = "";
    p.keep = true;
    p.started = Date.now();
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const took = Math.min(VOICE_MAX_SECONDS, (Date.now() - p.started) / 1000);
      const words = [...p.heard, p.hearing].join(" ").replace(/\s+/g, " ").trim();
      release();
      if (!p.keep || !chunks.length) return setRecording({ phase: "idle" });
      const file = recordedFile(recorder.mimeType, kind);
      const blob = new Blob(chunks, { type: file.type });
      setRecording({ phase: "preview", blob, url: URL.createObjectURL(blob), type: file.type, ext: file.ext, seconds: Math.max(1, Math.round(took)), words });
    };
    recorder.start(1000);
    setSeconds(0);
    setRecording({ phase: "recording" });

    // The level: how loud it is now, from the microphone itself.
    try {
      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      p.audio = audio;
      const tick = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 3));
        p.frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // No level, still recording.
    }
    p.timer = setInterval(() => {
      const now = (Date.now() - p.started) / 1000;
      setSeconds(Math.floor(now));
      if (now >= VOICE_MAX_SECONDS && recorder.state === "recording") recorder.stop();
    }, 250);

    // The words, while the browser can hear them. It stops by itself after a quiet spell: started again.
    const Speech = speechListener();
    if (Speech) {
      try {
        const listener = new Speech();
        listener.lang = browserOrSpanish() ?? navigator.language ?? "en-US";
        listener.continuous = true;
        listener.interimResults = true;
        listener.onresult = (event) => {
          let hearing = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i]!;
            if (result.isFinal) p.heard.push(result[0].transcript.trim());
            else hearing += result[0].transcript;
          }
          p.hearing = hearing.trim();
        };
        listener.onerror = () => undefined;
        listener.onend = () => {
          if (p.recorder?.state !== "recording") return;
          try {
            listener.start();
          } catch {
            // It won't start again: the note goes without the rest of its words.
          }
        };
        listener.start();
        p.listener = listener;
      } catch {
        // No words this time.
      }
    }
  }, [release]);

  /** Done: on to the preview. */
  const stop = useCallback(() => {
    const recorder = parts.current.recorder;
    if (recorder?.state === "recording") recorder.stop();
  }, []);

  /** Thrown away, while recording or from the preview. */
  const discard = useCallback(() => {
    const p = parts.current;
    p.keep = false;
    if (p.recorder?.state === "recording") p.recorder.stop();
    else release();
    setRecording((current) => {
      if (current.phase === "preview") URL.revokeObjectURL(current.url);
      return { phase: "idle" };
    });
  }, [release]);

  /** Sent: the preview's link is let go (the note itself goes on with the message). */
  const done = useCallback(() => {
    setRecording((current) => {
      if (current.phase === "preview") URL.revokeObjectURL(current.url);
      return { phase: "idle" };
    });
  }, []);

  useEffect(
    () => () => {
      parts.current.keep = false;
      if (parts.current.recorder?.state === "recording") parts.current.recorder.stop();
      release();
    },
    [release],
  );

  return { recording, seconds, level, start, stop, discard, done };
}

const PHONE = "(max-width: 900px)";
const phoneNow = () => typeof window !== "undefined" && window.matchMedia(PHONE).matches;
const watchPhone = (change: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Whether chat is laid out for a phone now (its phone rules in chat.module.css). */
export const usePhone = () => useSyncExternalStore(watchPhone, phoneNow, () => false);
