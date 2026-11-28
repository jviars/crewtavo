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
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
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

/** Speech recognition's errors that another try won't mend: no signal for it, or not allowed. */
const SPEECH_STOPS = new Set(["network", "not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);
/** It's started again after it ends by itself, a little later each time, this many times at most. */
const SPEECH_RESTARTS = 20;

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
    again?: ReturnType<typeof setTimeout>;
    heard: string[];
    hearing: string;
    started: number;
    keep: boolean;
    /** Which start is the current one: a cancel, or leaving, moves it on, so a start still asking for the microphone stops there. */
    run: number;
  }>({ heard: [], hearing: "", started: 0, keep: true, run: 0 });

  const release = useCallback(() => {
    const p = parts.current;
    if (p.frame) cancelAnimationFrame(p.frame);
    clearInterval(p.timer);
    clearTimeout(p.again);
    p.stream?.getTracks().forEach((track) => track.stop());
    void p.audio?.close().catch(() => undefined);
    if (p.listener) {
      p.listener.onend = null;
      p.listener.onerror = null;
      try {
        p.listener.stop();
      } catch {
        // Already stopped.
      }
    }
    p.frame = undefined;
    p.timer = undefined;
    p.again = undefined;
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
    const p = parts.current;
    const run = ++p.run;
    setRecording({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (p.run === run) setRecording({ phase: "error", message: microphoneProblem(error) });
      return;
    }
    // Cancelled, or the screen left, while the phone asked for the microphone: let it go at once.
    if (p.run !== run) {
      stream.getTracks().forEach((track) => track.stop());
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
      if (!p.keep || !chunks.length || p.run !== run) return setRecording({ phase: "idle" });
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

    // The words, while the browser can hear them. It stops by itself after a quiet spell: started
    // again, a little later each time, and not after an error another try won't mend (no signal for
    // it, or not allowed), so it doesn't go round and round for the whole recording.
    const Speech = speechListener();
    if (Speech) {
      try {
        const listener = new Speech();
        let restarts = 0;
        let done = false;
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
        listener.onerror = (event) => {
          if (SPEECH_STOPS.has(event.error ?? "")) done = true;
        };
        listener.onend = () => {
          if (done || p.recorder !== recorder || recorder.state !== "recording" || restarts >= SPEECH_RESTARTS) return;
          const wait = restarts === 0 ? 0 : Math.min(10_000, 500 * 2 ** (restarts - 1));
          restarts += 1;
          p.again = setTimeout(() => {
            if (recorder.state !== "recording") return;
            try {
              listener.start();
            } catch {
              // It won't start again: the note goes without the rest of its words.
            }
          }, wait);
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

  /** Thrown away, while starting, recording or from the preview. */
  const discard = useCallback(() => {
    const p = parts.current;
    p.keep = false;
    p.run += 1;
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
      const p = parts.current;
      p.keep = false;
      p.run += 1;
      if (p.recorder?.state === "recording") p.recorder.stop();
      release();
    },
    [release],
  );

  return { recording, seconds, level, start, stop, discard, done };
}

/**
 * Stops a recording once its box is out of sight (on a phone, a thread opened over the channel
 * hides the channel's box): one being made goes to its preview, and one still starting is called off.
 */
export function useStopWhenHidden(box: RefObject<HTMLElement>, recorder: ReturnType<typeof useVoiceRecorder>) {
  const { phase } = recorder.recording;
  const { stop, discard } = recorder;
  useEffect(() => {
    const el = box.current;
    if (!el || (phase !== "recording" && phase !== "starting") || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth || el.offsetHeight) return;
      if (phase === "recording") stop();
      else discard();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, phase, stop, discard]);
}

const TOUCH = "(pointer: coarse)";
const touchNow = () => typeof window !== "undefined" && window.matchMedia(TOUCH).matches;
const watchTouch = (change: () => void) => {
  const query = window.matchMedia(TOUCH);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/**
 * Whether the screen is worked by touch (a phone, a tablet) rather than a mouse: the microphone in
 * Send's place while the box is empty, and Send later by a long press. A narrow window on a computer
 * keeps the computer's: the microphone beside the camera and the chevron beside Send.
 */
export const useTouch = () => useSyncExternalStore(watchTouch, touchNow, () => false);
