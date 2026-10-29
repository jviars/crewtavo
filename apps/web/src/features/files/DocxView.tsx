/**
 * A Word document in the file viewer, laid out as pages by docx-preview.
 *
 * It's drawn inside a sandboxed frame with no scripts and no network: the document's own styles and
 * fonts become CSS, and a document made to break out of that (or to call home with a picture link)
 * stays inside the frame and can't reach Crewtavo. Links in it open in a new tab; links within it
 * scroll to the spot.
 */
import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { clamp, ZOOM_STEP } from "./files";
import { StageError, StageLoading, ZoomControls } from "./ViewerParts";
import styles from "./files.module.css";

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3;

// No scripts (the sandbox) and nothing fetched (the policy): only the pictures and fonts inside the
// document itself, which docx-preview hands over as data: links.
const FRAME = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light; --zoom: 1; }
  html, body { margin: 0; background: var(--backdrop, #e9e8e3); }
  body { -webkit-text-size-adjust: 100%; }
  .docx-wrapper { background: transparent !important; padding: 16px 12px 32px !important; zoom: var(--zoom); }
  .docx-wrapper > section.docx { box-shadow: 0 1px 3px rgba(15, 42, 53, 0.16), 0 8px 24px -12px rgba(15, 42, 53, 0.25) !important; margin-bottom: 16px !important; }
  a { cursor: pointer; }
</style></head><body></body></html>`;

export default function DocxView({ data, onEscape }: { data: ArrayBuffer; onEscape?: () => void }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const pageWidth = useRef(0);
  const fitted = useRef(true);
  const escape = useRef(onEscape);
  escape.current = onEscape;

  const fitZoom = () => {
    const frame = frameRef.current;
    if (!frame || !pageWidth.current) return 1;
    return clamp((frame.clientWidth - 24) / pageWidth.current, ZOOM_MIN, 1);
  };

  useEffect(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frameReady || !frame || !doc) return;
    let cancelled = false;
    setStatus("loading");
    // The page behind the paper, in the app's colors (light or dark).
    doc.documentElement.style.setProperty("--backdrop", getComputedStyle(frame.parentElement!).backgroundColor);
    doc.documentElement.style.setProperty("--zoom", "1");

    (async () => {
      await renderAsync(data.slice(0), doc.body, undefined, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        ignoreLastRenderedPageBreak: false,
        useBase64URL: true,
        // An "alt chunk" is HTML inside the document, shown in a frame of its own: never.
        renderAltChunks: false,
        renderComments: false,
        renderChanges: false,
        experimental: false,
      });
      if (cancelled) return;
      const first = doc.querySelector<HTMLElement>("section.docx");
      pageWidth.current = first?.offsetWidth ?? 0;
      fitted.current = true;
      setZoom(fitZoom());
      setStatus("ready");
    })().catch((err: unknown) => {
      if (cancelled) return;
      setError(new Error("This Word document couldn't be shown. It may be damaged, or saved in an older format. Download it to open it."));
      console.warn("docx-preview failed", err);
      setStatus("error");
    });

    // Links: out to a new tab (web, email and phone only), or to a bookmark in the document.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const anchor = typeof target?.closest === "function" ? target.closest("a[href]") : null;
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        const id = decodeURIComponent(href.slice(1));
        (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView({ block: "start" });
        return;
      }
      try {
        const url = new URL(href);
        if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) window.open(url.href, "_blank", "noopener,noreferrer");
      } catch {
        // Not a link anyone can follow.
      }
    };
    // Keys pressed inside the frame don't reach the viewer: pass Escape along.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") escape.current?.();
    };
    doc.addEventListener("click", onClick);
    doc.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKey);
    };
  }, [data, frameReady, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply the zoom inside the frame.
  useEffect(() => {
    frameRef.current?.contentDocument?.documentElement.style.setProperty("--zoom", String(zoom ?? 1));
  }, [zoom]);

  // Refit when the screen changes size (an iPad turned), if it was fitted.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || status !== "ready") return;
    const observer = new ResizeObserver(() => fitted.current && setZoom(fitZoom()));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomBy = (factor: number) => {
    fitted.current = false;
    setZoom((z) => clamp(Math.round((z ?? 1) * factor * 100) / 100, ZOOM_MIN, ZOOM_MAX));
  };

  return (
    <div className={styles.pane}>
      <div className={styles.toolbar} role="toolbar" aria-label="Document">
        <ZoomControls
          percent={status === "ready" && zoom != null ? zoom * 100 : null}
          onOut={() => zoomBy(1 / ZOOM_STEP)}
          onIn={() => zoomBy(ZOOM_STEP)}
          onFit={() => {
            fitted.current = true;
            setZoom(fitZoom());
          }}
          canOut={status === "ready" && (zoom ?? 1) > ZOOM_MIN}
          canIn={status === "ready" && (zoom ?? 1) < ZOOM_MAX}
        />
      </div>
      <div className={styles.paneBody}>
        {/* iPhones and iPads may grow a frame to its content instead of scrolling it: this scrolls then. */}
        <div className={styles.frameScroller}>
          <iframe
            ref={frameRef}
            key={attempt}
            className={styles.frame}
            title="Document preview"
            sandbox="allow-same-origin"
            srcDoc={FRAME}
            onLoad={() => setFrameReady(true)}
          />
        </div>
        {status === "loading" && <StageLoading />}
        {status === "error" && (
          <StageError
            error={error}
            onRetry={() => {
              setFrameReady(false);
              setAttempt((n) => n + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}
