/**
 * Sign with a finger, stylus or mouse. Gives back a PNG data URL (small: a signature is a few
 * kilobytes) when a stroke ends, or null once cleared.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/Button";

export function SignaturePad({ value, onChange, label = "Sign here", disabled = false }: { value: string | null; onChange: (dataUrl: string | null) => void; label?: string; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(!value);
  const [redo, setRedo] = useState(!value);

  // Size the drawing surface to the element at the screen's pixel density, so lines stay crisp.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !redo) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const { width, height } = el.getBoundingClientRect();
    el.width = Math.round(width * ratio);
    el.height = Math.round(height * ratio);
    const ctx = el.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f2a35";
  }, [redo]);

  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(last.current.x, last.current.y, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = "#0f2a35";
    ctx.fill();
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const p = point(e);
    const ctx = e.currentTarget.getContext("2d")!;
    const mid = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.quadraticCurveTo(last.current.x, last.current.y, mid.x, mid.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setEmpty(false);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    onChange(canvas.current!.toDataURL("image/png"));
  };
  const clear = () => {
    const el = canvas.current;
    if (el) el.getContext("2d")!.clearRect(0, 0, el.width, el.height);
    setEmpty(true);
    setRedo(true);
    onChange(null);
  };

  if (value && !redo) {
    return (
      <div className="stack-sm">
        <img src={value} alt="Signature" style={{ width: "100%", maxWidth: 420, height: 140, objectFit: "contain", background: "#fff", border: "1px solid var(--border)", borderRadius: 10 }} />
        {!disabled && <Button size="sm" variant="ghost" icon="undo" style={{ justifySelf: "start" }} onClick={clear}>Sign again</Button>}
      </div>
    );
  }
  return (
    <div className="stack-sm">
      <div style={{ position: "relative", maxWidth: 420 }}>
        <canvas
          ref={canvas}
          aria-label={label}
          role="img"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{ display: "block", width: "100%", height: 140, background: "#fff", border: "1px solid var(--border)", borderRadius: 10, touchAction: "none", cursor: disabled ? "not-allowed" : "crosshair" }}
        />
        {empty && <span aria-hidden="true" style={{ position: "absolute", left: 14, bottom: 12, right: 14, borderTop: "1px solid #c9c7c0", paddingTop: 4, color: "#8a8780", fontSize: 12, pointerEvents: "none" }}>{label}</span>}
      </div>
      {!empty && <Button size="sm" variant="ghost" icon="x" style={{ justifySelf: "start" }} onClick={clear}>Clear</Button>}
    </div>
  );
}
