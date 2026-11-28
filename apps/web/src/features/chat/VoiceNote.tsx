/**
 * A voice note in a message: play and pause, a bar to tap or drag to a place in it, the time, and
 * its speed (1×, 1.5×, 2×). Only one plays at a time: starting one pauses any other. Its words, the
 * phone's or the server's, show under it cut to two lines, with Show all.
 */
import { clockText, nextSpeed } from "@crewtavo/core/chatField";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import type { ChatAttachment } from "./data";
import f from "./field.module.css";

/** The one playing now, across every message on the page. */
let current: HTMLAudioElement | null = null;

export function VoiceNote({ attachment, url }: { attachment: ChatAttachment; url: string | undefined }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(attachment.duration ?? 0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const el = audio.current;
    return () => {
      if (current === el) current = null;
    };
  }, []);

  const toggle = async () => {
    const el = audio.current;
    if (!el || !url) return;
    if (!el.paused) return el.pause();
    if (current && current !== el) current.pause();
    current = el;
    el.playbackRate = speed;
    try {
      await el.play();
    } catch {
      setPlaying(false);
    }
  };

  // A recording from Chrome doesn't know its own length until it has played: the length it was recorded at stands in.
  const known = () => {
    const d = audio.current?.duration;
    return d && Number.isFinite(d) ? d : length;
  };
  const seek = (fraction: number) => {
    const el = audio.current;
    const total = known();
    if (!el || !total) return;
    el.currentTime = Math.min(total, Math.max(0, fraction * total));
    setAt(el.currentTime);
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    seek((e.clientX - box.left) / box.width);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const total = known();
    if (!total) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 5 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -5 : 0;
    if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(1);
    else if (step) seek((at + step) / total);
    else return;
    e.preventDefault();
  };
  const changeSpeed = () => {
    const next = nextSpeed(speed);
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  };

  const total = known();
  const done = total ? Math.min(100, (at / total) * 100) : 0;
  return (
    <div className={f.voiceNote}>
      <div className={f.player}>
        <button type="button" className={f.playBtn} onClick={() => void toggle()} disabled={!url} aria-label={playing ? t("Pause the voice note") : t("Play the voice note")}>
          <Icon name={playing ? "pause" : "play"} size={16} filled />
        </button>
        <div
          className={f.track}
          role="slider"
          tabIndex={0}
          aria-label={t("Where in the voice note")}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(at)}
          aria-valuetext={`${clockText(at)} / ${clockText(total)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            fromPointer(e);
          }}
          onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromPointer(e)}
          // On a phone a tap on a message shows its tools: a tap on the bar is a place in the note instead.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={keys}
        >
          <span className={f.trackFill} style={{ width: `${done}%` }} />
          <span className={f.trackKnob} style={{ left: `${done}%` }} />
        </div>
        <span className={f.voiceTime}>{clockText(playing || at > 0 ? at : total)}</span>
        <button type="button" className={f.speedBtn} onClick={changeSpeed} aria-label={t("Speed {speed}×", { speed: String(speed) })}>{speed}×</button>
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setAt(0);
          }}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0 && setLength(e.currentTarget.duration)}
        />
      </div>
      {attachment.words && <VoiceWords words={attachment.words} />}
    </div>
  );
}

/** A note's words: two lines, then all of them. */
function VoiceWords({ words }: { words: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [words, open]);
  return (
    <div className={f.voiceWords}>
      <p ref={box} data-open={open || undefined}>{words}</p>
      {(long || open) && (
        <button type="button" className={f.showAll} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("Show less") : t("Show all")}</button>
      )}
    </div>
  );
}
