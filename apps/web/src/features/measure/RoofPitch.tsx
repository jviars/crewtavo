/**
 * Roof pitch on the Measure page: pick it from the common ones (each with a little roof drawn at that
 * angle), read it from free USGS lidar (LidarPitch.tsx), or measure it on site. On the roof, a phone
 * laid on the shingles reads the slope from its tilt sensor. From the ground, a photo of a gable end
 * with one line along the roof edge and one along something level gives the angle between them.
 * Installs with a Google key can also ask Google's Solar API, which most customers won't have, so it's
 * the last choice and only shows when it works.
 */
import { isPitch, normalizePitch, pitchFactor, pitchSlope } from "@crewtavo/core/geo";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { LidarPitch, type NamedRoof } from "./LidarPitch";
import { photoAngle, pitchFromAngle, rad, startingHandles, tiltOf, type Handles, type Spot } from "./pitchMath";

/** The pitches roofers quote most, as rise per 12. */
const COMMON = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12];
/** Per 12: past here most crews need roof jacks and charge a steep fee. */
export const STEEP_FROM = 8;
/** Per 12: shingles under 4/12 need extra underlayment, and under 2/12 they aren't made for it. */
const LOW_BELOW = 4;


/** Rise per 12 for a pitch, or null while it doesn't read (or is blank). */
export function riseOf(pitch: string | null | undefined): number | null {
  if (!pitch?.trim() || !isPitch(pitch)) return null;
  return pitchSlope(pitch) * 12;
}


/** "6/12" as roofers say it, or "Flat". */
export const pitchLabel = (pitch: string) => (riseOf(pitch) === 0 ? "Flat" : isPitch(pitch) && pitch.trim() ? normalizePitch(pitch) : pitch);

/** A small gable at the pitch's angle (flat is a low box). */
export function RoofGlyph({ rise, size = 28 }: { rise: number; size?: number }) {
  const h = Math.min(12, Math.max(0, rise));
  return (
    <svg width={size} height={size / 2} viewBox="0 0 28 14" aria-hidden="true" className="roof-glyph">
      {h === 0 ? <rect x="2" y="9" width="24" height="4" rx="1" /> : <polygon points={`2,13 14,${13 - h} 26,13`} />}
    </svg>
  );
}

/** What a pitch means for the job: how much bigger the roof is than from above, and low or steep. */
export function PitchNote({ pitch }: { pitch: string }) {
  const rise = riseOf(pitch);
  if (rise === null) return null;
  const more = Math.round((pitchFactor(pitch) - 1) * 100);
  return (
    <div className="pitch-note">
      <span className="muted small">
        {rise === 0 ? "Flat: the roof is the size it looks from above." : `×${formatNumber(pitchFactor(pitch), 3)}: the roof is ${more}% bigger than it looks from above.`}
      </span>
      {rise >= STEEP_FROM && <span className="chip chip-amber">Steep</span>}
      {rise > 0 && rise < LOW_BELOW && <span className="chip chip-blue">Low slope</span>}
    </div>
  );
}

/**
 * Buttons for the common pitches and a box for any other. With `inherit`, a first button follows
 * the drawing's own pitch (for one roof section), which is the empty value.
 */
export function PitchPicker({ value, onChange, inherit, label = "Roof pitch" }: { value: string; onChange: (pitch: string) => void; inherit?: string; label?: string }) {
  const rise = riseOf(value);
  const isCommon = (r: number) => value.trim() !== "" && rise !== null && Math.abs(rise - r) < 0.01;
  const custom = value.trim() !== "" && !COMMON.some(isCommon);
  const [editing, setEditing] = useState(false);
  const [other, setOther] = useState("");
  return (
    <div className="pitch-picker">
      <div className="pitch-grid" role="group" aria-label={label}>
        {inherit !== undefined && (
          <button type="button" className="pitch-inherit" aria-pressed={value.trim() === ""} onClick={() => onChange("")}>
            <span>Same as the roof</span>
            <small>{inherit.trim() ? pitchLabel(inherit) : "not set"}</small>
          </button>
        )}
        {COMMON.map((r) => (
          <button key={r} type="button" aria-pressed={isCommon(r)} onClick={() => onChange(`${r}/12`)} aria-label={r === 0 ? "Flat" : `${r} in 12`}>
            <RoofGlyph rise={r} />
            <span>{r === 0 ? "Flat" : `${r}/12`}</span>
          </button>
        ))}
      </div>
      <label className="pitch-other">
        <span className="small strong">Other</span>
        <input
          className="input"
          value={editing ? other : custom ? value : ""}
          placeholder="e.g. 6.5/12 or 14/12"
          aria-invalid={custom && rise === null ? true : undefined}
          onFocus={() => {
            setOther(custom ? value : "");
            setEditing(true);
          }}
          onChange={(e) => {
            setOther(e.target.value);
            onChange(e.target.value);
          }}
          onBlur={() => {
            setEditing(false);
            // "6-12" and "6:12" are written the usual way once someone's done typing.
            if (other.trim() && isPitch(other)) onChange(normalizePitch(other));
          }}
        />
      </label>
      {custom && rise === null && <span className="field-error">Write it like 7/12, 7-12 or 30°.</span>}
      <PitchNote pitch={value} />
    </div>
  );
}

/**
 * Ways to find the pitch: lidar for the roofs drawn, phone on the roof, a photo from the ground, or
 * Google when it's set up. `onPickSection` takes lidar's pitch for each section when there are several.
 */
export function MeasurePitch({
  onPick, near, roofs, onPickSection,
}: {
  onPick: (pitch: string) => void;
  near: { lat: number; lng: number } | null;
  roofs?: NamedRoof[];
  onPickSection?: (id: string, pitch: string) => void;
}) {
  const { config } = useSession();
  const [open, setOpen] = useState<"lidar" | "phone" | "photo" | "google" | null>(null);
  const use = (pitch: string) => {
    onPick(pitch);
    setOpen(null);
  };
  return (
    <div className="stack-sm">
      <span className="small strong">Measure it</span>
      <div className="row wrap" style={{ gap: 6 }}>
        {roofs && <Button size="sm" icon="layers" onClick={() => setOpen("lidar")}>From lidar (free)</Button>}
        <Button size="sm" icon="smartphone" onClick={() => setOpen("phone")}>Phone on the roof</Button>
        <Button size="sm" icon="camera" onClick={() => setOpen("photo")}>From a photo</Button>
        {config.features.roofInsights && near && <Button size="sm" icon="sparkle" onClick={() => setOpen("google")}>Ask Google</Button>}
      </div>
      {open === "lidar" && roofs && (
        roofs.length ? (
          <LidarPitch roofs={roofs} onUse={onPick} onUseSection={onPickSection} onClose={() => setOpen(null)} />
        ) : (
          <Dialog open onClose={() => setOpen(null)} title="Roof pitch from lidar" size="sm">
            <div className="dialog-body stack">
              <div className="callout"><Icon name="info" size={18} /><span className="grow">Draw the roof with Area first (or choose Outline the building in the middle), then try again. Lidar reads the pitch inside what you draw.</span></div>
              <div className="form-actions"><Button variant="primary" onClick={() => setOpen(null)}>OK</Button></div>
            </div>
          </Dialog>
        )
      )}
      {open === "phone" && <PhoneGauge onUse={use} onClose={() => setOpen(null)} />}
      {open === "photo" && <PhotoGauge onUse={use} onClose={() => setOpen(null)} />}
      {open === "google" && near && <GoogleRoof at={near} onUse={use} onClose={() => setOpen(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Phone on the roof: the tilt sensor
// ---------------------------------------------------------------------------------------------

type Orientation = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };


function PhoneGauge({ onUse, onClose }: { onUse: (pitch: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<"start" | "reading" | "denied" | "none" | "insecure">(() => (window.isSecureContext ? "start" : "insecure"));
  const [reading, setReading] = useState<{ tilt: number; steady: boolean } | null>(null);
  const samples = useRef<Array<{ at: number; tilt: number }>>([]);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);

  const start = async () => {
    const Sensor = (window as { DeviceOrientationEvent?: Orientation }).DeviceOrientationEvent;
    if (!Sensor) return setStatus("none");
    // iPhones ask once, and only from a tap. Some desktop browsers have the same question and
    // always say no; there it's the missing sensor worth explaining, not a setting.
    const refused = () => setStatus(window.matchMedia("(pointer: coarse)").matches ? "denied" : "none");
    if (typeof Sensor.requestPermission === "function") {
      try {
        if ((await Sensor.requestPermission()) !== "granted") return refused();
      } catch {
        return refused();
      }
    }
    let heard = false;
    let frame = 0;
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      heard = true;
      const now = performance.now();
      const list = samples.current.filter((s) => now - s.at < 1500);
      list.push({ at: now, tilt: tiltOf(e.beta, e.gamma) });
      samples.current = list;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const tilts = list.map((s) => s.tilt);
        const tilt = tilts.reduce((a, b) => a + b, 0) / tilts.length;
        // Steady: a good second of readings within half a degree of each other.
        setReading({ tilt, steady: tilts.length >= 10 && Math.max(...tilts) - Math.min(...tilts) < 0.5 });
      });
    };
    window.addEventListener("deviceorientation", onTilt);
    // Laptops and desktops have no sensor: the event never comes, or comes empty.
    const quiet = setTimeout(() => !heard && setStatus("none"), 2500);
    stop.current = () => {
      window.removeEventListener("deviceorientation", onTilt);
      clearTimeout(quiet);
      cancelAnimationFrame(frame);
    };
    setStatus("reading");
  };

  const rise = reading ? Math.tan(rad(reading.tilt)) * 12 : null;
  const suggestion = reading ? pitchFromAngle(reading.tilt) : null;
  return (
    <Dialog open onClose={onClose} title="Measure the pitch with your phone" description="Lay the phone flat on the shingles. It reads the slope from its tilt sensor." size="sm">
      <div className="dialog-body stack">
        {status === "start" && (
          <>
            <ol className="measure-help-tips">
              <li>Set the phone on a flat stretch of roof, away from the ridge and edges. Any direction works.</li>
              <li>A thick case or camera bump can tip it a little. Lay it on a straight board, or take the case off, for the best reading.</li>
              <li>Wait for it to say Steady, then use the reading.</li>
            </ol>
            <div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="smartphone" onClick={start}>Start</Button></div>
          </>
        )}
        {status === "reading" && (
          <>
            <div className="pitch-reading" role="status" aria-live="polite">
              {rise === null ? (
                <span className="muted">Waiting for the sensor…</span>
              ) : (
                <>
                  <RoofGlyph rise={rise} size={72} />
                  <strong className="num">{formatNumber(rise, 1)}/12</strong>
                  <span className="muted small">{formatNumber(reading!.tilt, 1)}° · {reading!.steady ? "Steady" : "Hold still…"}</span>
                </>
              )}
            </div>
            <div className="form-actions">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!suggestion || !reading?.steady} onClick={() => suggestion && onUse(suggestion)}>{suggestion ? `Use ${suggestion}` : "Use it"}</Button>
            </div>
          </>
        )}
        {status === "none" && <Unavailable onClose={onClose}>This device doesn't have a tilt sensor, or the browser isn't sharing it. Open this page on your phone, or measure from a photo instead.</Unavailable>}
        {status === "denied" && <Unavailable onClose={onClose}>Motion access is off for this site. On an iPhone, close Safari's tab and open the page again to be asked, or measure from a photo instead.</Unavailable>}
        {status === "insecure" && <Unavailable onClose={onClose}>Phones only share their tilt sensor with secure (https://) addresses. Open Crewtavo at its https address, or measure from a photo instead.</Unavailable>}
      </div>
    </Dialog>
  );
}

function Unavailable({ children, onClose }: { children: string; onClose: () => void }) {
  return (
    <>
      <div className="callout"><Icon name="info" size={18} /><span className="grow">{children}</span></div>
      <div className="form-actions"><Button variant="primary" onClick={onClose}>OK</Button></div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// From a photo: two lines on a picture of the gable end
// ---------------------------------------------------------------------------------------------


function PhotoGauge({ onUse, onClose }: { onUse: (pitch: string) => void; onClose: () => void }) {
  const [photo, setPhoto] = useState<{ url: string; width: number; height: number } | null>(null);
  const [handles, setHandles] = useState<Handles | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ line: keyof Handles; end: 0 | 1 } | null>(null);
  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url);
  }, [photo]);

  const choose = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setPhoto({ url, width: img.naturalWidth, height: img.naturalHeight });
      setHandles(startingHandles(img.naturalWidth, img.naturalHeight));
    };
    img.src = url;
  };
  const move = (e: ReactPointerEvent) => {
    const at = dragging.current;
    const rect = box.current?.getBoundingClientRect();
    if (!at || !rect || !handles) return;
    const spot: Spot = [Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))];
    const line = [...handles[at.line]] as [Spot, Spot];
    line[at.end] = spot;
    setHandles({ ...handles, [at.line]: line });
  };

  const angle = photo && handles ? photoAngle(handles, photo.width, photo.height) : null;
  const rise = angle === null ? null : Math.tan(rad(angle)) * 12;
  const suggestion = angle === null ? null : pitchFromAngle(angle);
  return (
    <Dialog open onClose={onClose} title="Measure the pitch from a photo" description="Take the picture straight at a gable end, then line up the two lines." size="lg">
      <div className="dialog-body stack">
        {!photo ? (
          <>
            <ol className="measure-help-tips">
              <li>Stand square to a gable end (the triangle at the end of the roof). Standing off to the side makes it read steeper than it is.</li>
              <li>Step back and zoom in rather than shooting up from close by.</li>
              <li>Then drag the orange line along the roof edge and the blue line along something level: the gutter, the fascia, or a row of siding.</li>
            </ol>
            <label className="btn btn-primary" style={{ justifySelf: "start" }}>
              <Icon name="camera" size={16} />Take or choose a photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => choose(e.target.files?.[0])} />
            </label>
            <div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
          </>
        ) : (
          <>
            <div
              ref={box}
              className="pitch-photo"
              // As big as fits: the dialog's width, or most of the screen's height for a tall photo.
              style={{ aspectRatio: `${photo.width} / ${photo.height}`, width: `min(100%, calc(60vh * ${photo.width / photo.height}))` }}
              onPointerMove={move}
              onPointerUp={() => (dragging.current = null)}
              onPointerCancel={() => (dragging.current = null)}
            >
              <img src={photo.url} alt="The roof to measure" draggable={false} />
              {handles && (
                <>
                  <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                    <line x1={handles.level[0][0]} y1={handles.level[0][1]} x2={handles.level[1][0]} y2={handles.level[1][1]} data-line="level" />
                    <line x1={handles.roof[0][0]} y1={handles.roof[0][1]} x2={handles.roof[1][0]} y2={handles.roof[1][1]} data-line="roof" />
                  </svg>
                  {(["level", "roof"] as const).flatMap((line) =>
                    ([0, 1] as const).map((end) => (
                      <button
                        key={`${line}${end}`}
                        type="button"
                        className="pitch-handle"
                        data-line={line}
                        style={{ left: `${handles[line][end][0] * 100}%`, top: `${handles[line][end][1] * 100}%` }}
                        aria-label={`${line === "roof" ? "Roof edge" : "Level line"}, ${end ? "second" : "first"} end`}
                        onPointerDown={(e) => {
                          // The photo follows the finger from here, even past the handle.
                          box.current?.setPointerCapture?.(e.pointerId);
                          dragging.current = { line, end };
                        }}
                      />
                    )),
                  )}
                </>
              )}
            </div>
            <div className="row wrap" style={{ gap: 12, alignItems: "center" }}>
              <span className="chip" style={{ background: "#f97316", color: "#fff" }}>Roof edge</span>
              <span className="chip" style={{ background: "#2563eb", color: "#fff" }}>Level line</span>
              <span className="grow" />
              {rise !== null && <strong className="num" role="status">{formatNumber(rise, 1)}/12 · {formatNumber(angle!, 1)}°</strong>}
            </div>
            <div className="form-actions">
              <label className="btn btn-ghost">
                Another photo
                <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => choose(e.target.files?.[0])} />
              </label>
              <span className="spacer" />
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!suggestion} onClick={() => suggestion && onUse(suggestion)}>{suggestion ? `Use ${suggestion}` : "Use it"}</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Google's Solar API (only where the server has a key for it)
// ---------------------------------------------------------------------------------------------

interface RoofInsights {
  segments: Array<{ pitch: string; pitch_degrees: number; azimuth_degrees: number; sloped_area_sqft: number; plan_area_sqft: number }>;
  imagery_date?: string;
}

function GoogleRoof({ at, onUse, onClose }: { at: { lat: number; lng: number }; onUse: (pitch: string) => void; onClose: () => void }) {
  const insights = useQuery({ queryKey: ["roof-insights", at.lat.toFixed(5), at.lng.toFixed(5)], queryFn: () => api.post<RoofInsights>("/roof-insights", at), retry: false, meta: { silent: true } });
  // The same pitch on several planes (both sides of a gable) is one choice, biggest first.
  const pitches = [...(insights.data?.segments ?? []).reduce((m, s) => m.set(s.pitch, (m.get(s.pitch) ?? 0) + s.plan_area_sqft), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  return (
    <Dialog open onClose={onClose} title="Roof pitch from Google" description="Google's Solar API looks at the building nearest the middle of the map." size="sm">
      <div className="dialog-body stack">
        {insights.isPending ? (
          <span className="muted">Asking Google…</span>
        ) : insights.error ? (
          <div className="callout"><Icon name="info" size={18} /><span className="grow">{(insights.error as Error).message}</span></div>
        ) : !pitches.length ? (
          <span className="muted">Google found the building but no sloped roof on it.</span>
        ) : (
          <div className="stack-sm">
            {pitches.map(([pitch, sqft]) => (
              <div key={pitch} className="row" style={{ gap: 10 }}>
                <RoofGlyph rise={riseOf(pitch) ?? 0} />
                <strong className="grow">{pitch}</strong>
                <span className="muted small">{formatNumber(sqft)} sq ft from above</span>
                <Button size="sm" onClick={() => onUse(pitch)}>Use</Button>
              </div>
            ))}
            {insights.data?.imagery_date && <span className="muted small">From Google imagery taken {insights.data.imagery_date}.</span>}
          </div>
        )}
        <div className="form-actions"><Button variant="ghost" onClick={onClose}>Close</Button></div>
      </div>
    </Dialog>
  );
}
