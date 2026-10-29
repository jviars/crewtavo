/**
 * A picture in the file viewer: fitted to the screen, then zoomed with the buttons, a pinch, the
 * keyboard (+, −, 0) or ⌘/Ctrl and the scroll wheel, and dragged around with a finger or the mouse.
 * Pinch zoom is locked in the installed app, so the pinch here is the viewer's own.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { planLink } from "@/features/plans/plans";
import { clampView, fitView, minScale, ZOOM_MAX, ZOOM_STEP, zoomAt, type Size, type View, type ViewerFile } from "./files";
import { StageError, StageLoading, StageMessage, ZoomControls } from "./ViewerParts";
import styles from "./files.module.css";

type Point = { x: number; y: number };

export default function ImageView({ file, download }: { file: ViewerFile; download: ReactNode }) {
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [view, setView] = useState<View | null>(null);
  const fitted = useRef(true); // still fitted to the screen: it refits when the screen turns
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; mid: Point } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(null);
    planLink(file.path).then((url) => live && setLink(url)).catch((error) => live && setFailed(error));
    return () => {
      live = false;
    };
  }, [file.path, attempt]);

  const stageSize = (): Size => {
    const el = stageRef.current;
    return el ? { width: el.clientWidth, height: el.clientHeight } : { width: 0, height: 0 };
  };
  const toStage = (clientX: number, clientY: number): Point => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const fit = () => {
    if (!natural) return;
    fitted.current = true;
    setView(fitView(stageSize(), natural));
  };
  const zoom = (factor: number, point?: Point) => {
    if (!natural || !view) return;
    const stage = stageSize();
    fitted.current = false;
    setView(zoomAt(view, factor, point ?? { x: stage.width / 2, y: stage.height / 2 }, stage, natural));
  };

  // Refit when the screen changes size (an iPad turned), or keep the picture in reach.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    const observer = new ResizeObserver(() => {
      setView((v) => (fitted.current || !v ? fitView(stageSize(), natural) : clampView(v, stageSize(), natural)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [natural]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!view || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, toStage(e.clientX, e.clientY));
    if (pointers.current.size === 2) pinch.current = measure();
    setDragging(true);
  };

  const measure = () => {
    const [a, b] = [...pointers.current.values()] as [Point, Point];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(e.pointerId);
    if (!before || !view || !natural) return;
    const now = toStage(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, now);
    const stage = stageSize();
    fitted.current = false;
    if (pointers.current.size >= 2 && pinch.current) {
      // Two fingers: zoom around the point between them, and follow them as they move.
      const next = measure();
      const factor = pinch.current.distance > 0 ? next.distance / pinch.current.distance : 1;
      const zoomed = zoomAt(view, factor, pinch.current.mid, stage, natural);
      setView(clampView({ ...zoomed, x: zoomed.x + next.mid.x - pinch.current.mid.x, y: zoomed.y + next.mid.y - pinch.current.mid.y }, stage, natural));
      pinch.current = next;
    } else if (pointers.current.size === 1) {
      setView(clampView({ ...view, x: view.x + now.x - before.x, y: view.y + now.y - before.y }, stage, natural));
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const start = pointers.current.get(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) setDragging(false);
    // A double tap zooms in on that spot, or back out to fit (a mouse has dblclick).
    if (e.pointerType !== "touch" || !start || e.type !== "pointerup") return;
    const point = toStage(e.clientX, e.clientY);
    const last = lastTap.current;
    if (last && e.timeStamp - last.at < 320 && Math.hypot(point.x - last.point.x, point.y - last.point.y) < 30) {
      lastTap.current = null;
      toggleZoom(point);
    } else lastTap.current = { at: e.timeStamp, point };
  };

  const toggleZoom = (point: Point) => {
    if (!natural || !view) return;
    const fitScale = fitView(stageSize(), natural).scale;
    if (view.scale > fitScale * 1.05) fit();
    else zoom(Math.max(fitScale * 2, 1) / view.scale, point);
  };

  // The wheel moves the picture, and with ⌘/Ctrl (how a trackpad pinch arrives) zooms it. Listened
  // to directly: React's wheel listener can't stop the browser zooming the whole page.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !natural) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const stage = stageSize();
      const point = toStage(e.clientX, e.clientY);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.height : 1;
      fitted.current = false;
      setView((v) => {
        if (!v) return v;
        if (e.ctrlKey || e.metaKey) return zoomAt(v, Math.exp((-e.deltaY * unit) / 200), point, stage, natural);
        return clampView({ ...v, x: v.x - e.deltaX * unit, y: v.y - e.deltaY * unit }, stage, natural);
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [natural]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!view || !natural) return;
    const step = 60;
    const moves: Record<string, Point> = { ArrowLeft: { x: step, y: 0 }, ArrowRight: { x: -step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } };
    if (e.key === "+" || e.key === "=") zoom(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoom(1 / ZOOM_STEP);
    else if (e.key === "0") fit();
    else if (moves[e.key]) setView(clampView({ ...view, x: view.x + moves[e.key]!.x, y: view.y + moves[e.key]!.y }, stageSize(), natural));
    else return;
    e.preventDefault();
  };

  if (failed) return <StageError error={failed} onRetry={() => setAttempt((n) => n + 1)} />;
  if (unreadable) {
    return (
      <StageMessage icon="image" title="This picture can't be shown here" action={download}>
        This browser can't open this kind of picture. Download it to see it on your device.
      </StageMessage>
    );
  }

  const stage = natural ? stageSize() : null;
  return (
    <div className={styles.pane}>
      <div className={styles.toolbar} role="toolbar" aria-label="Picture">
        <ZoomControls
          percent={view ? view.scale * 100 : null}
          onOut={() => zoom(1 / ZOOM_STEP)}
          onIn={() => zoom(ZOOM_STEP)}
          onFit={fit}
          canOut={Boolean(view && natural && stage && view.scale > minScale(stage, natural) + 0.001)}
          canIn={Boolean(view && view.scale < ZOOM_MAX - 0.001)}
        />
      </div>
      <div
        ref={stageRef}
        className={styles.imageStage}
        data-dragging={dragging || undefined}
        tabIndex={0}
        aria-label={`${file.title}. Drag to move around; use the zoom buttons or the plus and minus keys to zoom.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => toggleZoom(toStage(e.clientX, e.clientY))}
        onKeyDown={onKeyDown}
      >
        {link && (
          <img
            className={styles.image}
            src={link}
            alt={file.title}
            draggable={false}
            style={view && natural ? { width: natural.width, height: natural.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : { visibility: "hidden" }}
            onLoad={(e) => {
              const img = e.currentTarget;
              const size = { width: img.naturalWidth || 1, height: img.naturalHeight || 1 };
              setNatural(size);
              fitted.current = true;
              setView(fitView(stageSize(), size));
            }}
            onError={() => setUnreadable(true)}
          />
        )}
        {!view && <StageLoading />}
      </div>
    </div>
  );
}
