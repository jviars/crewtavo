/**
 * A PDF in the file viewer, in pdf.js's own viewer: every page, text that can be selected, links,
 * and form fields. Zooming is the viewer's own (buttons, pinch, ⌘/Ctrl and the wheel) since pinch
 * zoom is locked in the installed app.
 *
 * Editing turns on pdf.js's markup tools (Highlight, Text, Draw) and form filling. Saving writes
 * them into a copy of the PDF (pdfDocument.saveDocument), which becomes the file's next version.
 * The PDF loads from its signed link in pieces, so the first page of a big plan set shows quickly.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { planLink } from "@/features/plans/plans";
import { toast } from "@/lib/toast";
import type { FileEditor, ViewerFile } from "./files";
import { loadPdfViewer, type PdfKit } from "./pdfViewer";
import { StageError, StageLoading, StageMessage, ToolButton, ZoomControls } from "./ViewerParts";
import styles from "./files.module.css";

type Tool = "select" | "highlight" | "text" | "draw";
type LoadingTask = ReturnType<PdfKit["lib"]["getDocument"]>;
type PdfDocument = Awaited<LoadingTask["promise"]>;
type Viewer = InstanceType<PdfKit["viewer"]["PDFViewer"]>;
type LinkService = InstanceType<PdfKit["viewer"]["PDFLinkService"]>;
type Bus = InstanceType<PdfKit["viewer"]["EventBus"]>;

/** Colors for Text and Draw. Set outright: pdf.js's own default follows the page's text color, which is white in dark mode. */
const COLORS = [
  { name: "Black", value: "#000000" },
  { name: "Red", value: "#d4202c" },
  { name: "Blue", value: "#1d5bd6" },
  { name: "Green", value: "#2c7a1f" },
] as const;

const TOOLS = [
  { tool: "select", label: "Select", icon: "pointer" },
  { tool: "highlight", label: "Highlight", icon: "highlighter" },
  { tool: "text", label: "Text", icon: "type" },
  { tool: "draw", label: "Draw", icon: "pen" },
] as const;

/** Scales pdf.js works out from the screen, which it redoes when the screen changes size. */
const FITTED = new Set(["auto", "page-fit", "page-width"]);

export interface PdfViewProps {
  file: ViewerFile;
  editing: boolean;
  /** The page to open at (kept when switching between viewing and editing). */
  startPage?: number;
  onPage?(page: number): void;
  onDirty(dirty: boolean): void;
}

interface Open {
  kit: PdfKit;
  doc: PdfDocument;
  viewer: Viewer;
  bus: Bus;
}

export default forwardRef<FileEditor, PdfViewProps>(function PdfView({ file, editing, startPage = 1, onPage, onDirty }, ref) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const open = useRef<Open | null>(null);
  const callbacks = useRef({ onPage, onDirty });
  callbacks.current = { onPage, onDirty };
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "password">("loading");
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(startPage);
  const [pageInput, setPageInput] = useState(String(startPage));
  const [pages, setPages] = useState(0);
  const [scale, setScale] = useState<number | null>(null);
  const [toolsReady, setToolsReady] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState<string>(COLORS[0].value);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const colorRef = useRef(color);
  colorRef.current = color;
  // A tool picked from the toolbar takes the chosen color once pdf.js has switched to it.
  const colorPending = useRef(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const pagesEl = pagesRef.current;
    if (!scroller || !pagesEl) return;
    const stop = new AbortController();
    let task: LoadingTask | null = null;
    let viewer: Viewer | null = null;
    let linkService: LinkService | null = null;
    let resize: ResizeObserver | null = null;
    setStatus("loading");
    setProgress(null);
    setToolsReady(false);

    (async () => {
      const [kit, link] = await Promise.all([loadPdfViewer(), planLink(file.path)]);
      if (stop.signal.aborted) return;
      const { lib, viewer: ui } = kit;
      // From the link, in pieces: a big plan set shows its first page before the rest arrives (which
      // keeps loading in the background, so later pages don't need the link once it expires).
      task = lib.getDocument({ url: link });
      task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
        if (total > 0) setProgress(Math.min(1, loaded / total));
      };
      const doc = await task.promise;
      if (stop.signal.aborted) return;

      const bus = new ui.EventBus();
      linkService = new ui.PDFLinkService({ eventBus: bus, externalLinkTarget: ui.LinkTarget.BLANK, externalLinkRel: "noopener noreferrer nofollow" });
      // abortSignal isn't in pdf.js's typings, but the viewer takes it: it stops its resize watcher.
      const options = {
        container: scroller,
        viewer: pagesEl,
        eventBus: bus,
        linkService,
        abortSignal: stop.signal,
        // Viewing draws form fields as they're filled in; editing makes them fillable.
        annotationMode: editing ? lib.AnnotationMode.ENABLE_FORMS : lib.AnnotationMode.ENABLE,
        annotationEditorMode: editing ? lib.AnnotationEditorType.NONE : lib.AnnotationEditorType.DISABLE,
      };
      const v = (viewer = new ui.PDFViewer(options));
      linkService.setViewer(v);

      bus.on("pagesinit", () => {
        v.currentScaleValue = "auto";
        if (startPage > 1 && startPage <= doc.numPages) v.currentPageNumber = startPage;
        setStatus("ready");
      });
      bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
        setPage(pageNumber);
        setPageInput(String(pageNumber));
        callbacks.current.onPage?.(pageNumber);
      });
      bus.on("scalechanging", ({ scale: next }: { scale: number }) => setScale(next));
      bus.on("annotationeditoruimanager", () => setToolsReady(true));
      bus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
        const T = lib.AnnotationEditorType;
        setTool(mode === T.HIGHLIGHT ? "highlight" : mode === T.FREETEXT ? "text" : mode === T.INK ? "draw" : "select");
        if (colorPending.current) {
          colorPending.current = false;
          applyColor(kit, bus, v, colorRef.current);
        }
      });
      // Double-tapping a note added here opens it again, in its own tool.
      bus.on("switchannotationeditormode", (params: { mode: number }) => {
        try {
          v.annotationEditorMode = params;
        } catch {
          // Not editing: nothing to switch to.
        }
      });
      // Unsaved: something in the document's annotation storage (filled-in fields, finished notes),
      // or something that can be undone (a drawing still being drawn isn't stored until it ends).
      let stored = false;
      let undoable = false;
      const report = () => callbacks.current.onDirty(stored || undoable);
      bus.on("editingstateschanged", ({ details }: { details: { hasSomethingToUndo?: boolean; hasSomethingToRedo?: boolean } }) => {
        setHistory({ undo: Boolean(details.hasSomethingToUndo), redo: Boolean(details.hasSomethingToRedo) });
        undoable = Boolean(details.hasSomethingToUndo);
        report();
      });
      const storage = doc.annotationStorage as unknown as { onSetModified: (() => void) | null; onResetModified: (() => void) | null };
      storage.onSetModified = () => {
        stored = true;
        report();
      };
      storage.onResetModified = () => {
        stored = false;
        report();
      };

      v.setDocument(doc);
      linkService.setDocument(doc, null);
      setPages(doc.numPages);
      open.current = { kit, doc, viewer: v, bus };

      // The screen changed size (an iPad turned): refit if it was fitted.
      resize = new ResizeObserver(() => {
        if (FITTED.has(v.currentScaleValue)) v.currentScaleValue = v.currentScaleValue;
      });
      resize.observe(scroller);
    })().catch((err: unknown) => {
      if (stop.signal.aborted) return;
      if ((err as { name?: string } | null)?.name === "PasswordException") setStatus("password");
      else {
        setError(friendly(err));
        setStatus("error");
      }
    });

    return () => {
      stop.abort();
      resize?.disconnect();
      open.current = null;
      try {
        viewer?.setDocument(null);
        linkService?.setDocument(null, null);
      } catch {
        // Already torn down.
      }
      void task?.destroy();
    };
  }, [file.path, editing, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pinch to zoom (one finger still scrolls, or draws with Draw), and ⌘/Ctrl with the wheel.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const o = open.current;
    if (status !== "ready" || !scroller || !o) return;
    const stop = new AbortController();
    let unused = 1; // zoom too small to show yet: the viewer rounds to whole percents
    const zoomBy = (factor: number, origin: [number, number], pan?: [number, number]) => {
      const before = o.viewer.currentScale;
      const scaleFactor = factor * unused;
      o.viewer.updateScale({ drawingDelay: 400, scaleFactor, origin, pan });
      unused = o.viewer.currentScale === before ? scaleFactor : 1;
    };
    new o.kit.lib.TouchManager({
      container: scroller,
      signal: stop.signal,
      onPinchStart: () => (unused = 1),
      onPinching: (origin: [number, number], prevDistance: number, distance: number, dx: number, dy: number) => zoomBy(distance / prevDistance, origin, [dx, dy]),
      onPinchEnd: () => (unused = 1),
      onPanning: (dx: number, dy: number) => o.viewer.panBy(dx, dy),
    });
    scroller.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY / 200), [e.clientX, e.clientY]);
      },
      { passive: false, signal: stop.signal },
    );
    return () => stop.abort();
  }, [status]);

  useImperativeHandle(ref, () => ({
    async save() {
      const o = open.current;
      if (!o) throw new Error("The PDF is still opening. Try again in a moment.");
      const { doc, viewer, bus, kit } = o;
      // A note being typed or a line being drawn goes into the document when its tool is put down:
      // back to Select first, and wait for pdf.js to finish switching.
      const NONE = kit.lib.AnnotationEditorType.NONE;
      if ((viewer.annotationEditorMode as unknown as number) > NONE) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          bus.on("annotationeditormodechanged", done, { once: true });
          setTimeout(done, 1500);
          viewer.annotationEditorMode = { mode: NONE };
        });
      }
      let bytes: Uint8Array;
      try {
        bytes = await doc.saveDocument();
      } catch {
        throw new Error("Couldn't save the changes into this PDF. It may be protected or damaged.");
      }
      return new Blob([bytes], { type: "application/pdf" });
    },
  }), []);

  const choose = (next: Tool) => {
    const o = open.current;
    if (!o) return;
    const T = o.kit.lib.AnnotationEditorType;
    const mode = { select: T.NONE, highlight: T.HIGHLIGHT, text: T.FREETEXT, draw: T.INK }[next];
    try {
      colorPending.current = next === "text" || next === "draw";
      o.viewer.annotationEditorMode = { mode };
      setTool(next);
    } catch {
      colorPending.current = false;
      toast.error("This PDF can't be marked up here.");
    }
  };

  const pickColor = (value: string) => {
    setColor(value);
    const o = open.current;
    if (o) applyColor(o.kit, o.bus, o.viewer, value);
  };

  const goTo = (n: number) => {
    const viewer = open.current?.viewer;
    if (!viewer || !Number.isFinite(n) || n < 1) return setPageInput(String(page));
    viewer.currentPageNumber = Math.min(Math.round(n), viewer.pagesCount);
    setPageInput(String(viewer.currentPageNumber));
  };

  const act = (name: "undo" | "redo") => {
    const o = open.current;
    o?.bus.dispatch("editingaction", { source: o.viewer, name });
  };

  const retry = () => {
    setStatus("loading");
    setAttempt((n) => n + 1);
  };

  const ready = status === "ready";
  const viewer = open.current?.viewer;
  return (
    <div className={styles.pane}>
      {(status === "loading" || ready) && (
        <div className={styles.toolbar} role="toolbar" aria-label="PDF">
          <div className={styles.group} role="group" aria-label="Pages">
            <ToolButton icon="chevronLeft" label="Previous page" onClick={() => viewer?.previousPage()} disabled={!ready || page <= 1} />
            <input
              className={`input ${styles.pageInput}`}
              inputMode="numeric"
              enterKeyHint="go"
              aria-label="Page number"
              value={pageInput}
              disabled={!ready}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, "").slice(0, 5))}
              onFocus={(e) => e.target.select()}
              onBlur={() => goTo(Number(pageInput))}
              onKeyDown={(e) => {
                if (e.key === "Enter") goTo(Number(pageInput));
              }}
            />
            <span className={styles.pageCount}>of {pages || "–"}</span>
            <ToolButton icon="chevronRight" label="Next page" onClick={() => viewer?.nextPage()} disabled={!ready || page >= pages} />
          </div>
          <ZoomControls
            percent={scale == null ? null : scale * 100}
            onOut={() => viewer?.decreaseScale()}
            onIn={() => viewer?.increaseScale()}
            onFit={() => {
              if (viewer) viewer.currentScaleValue = "auto";
            }}
            canOut={ready && (scale ?? 1) > 0.11}
            canIn={ready && (scale ?? 1) < 24.9}
          />
          {editing && (
            <>
              <div className={styles.group} role="group" aria-label="Markup tools">
                {TOOLS.map((t) => (
                  <ToolButton key={t.tool} icon={t.icon} label={t.label} showLabel pressed={tool === t.tool} disabled={!toolsReady} onClick={() => choose(t.tool)} />
                ))}
              </div>
              {(tool === "text" || tool === "draw") && (
                <div className={styles.group} role="group" aria-label="Color">
                  {COLORS.map((c) => (
                    <button key={c.value} type="button" className={styles.swatch} style={{ color: c.value }} aria-label={c.name} title={c.name} aria-pressed={color === c.value} onClick={() => pickColor(c.value)} />
                  ))}
                </div>
              )}
              <div className={styles.group} role="group" aria-label="Undo and redo">
                <ToolButton icon="undo" label="Undo" onClick={() => act("undo")} disabled={!history.undo} />
                <ToolButton icon="redo" label="Redo" onClick={() => act("redo")} disabled={!history.redo} />
              </div>
            </>
          )}
        </div>
      )}
      <div className={styles.paneBody}>
        <div ref={scrollerRef} className={styles.pdfScroller} tabIndex={0} aria-label={`${file.title}, PDF`}>
          <div ref={pagesRef} className="pdfViewer" />
        </div>
        {status === "loading" && <StageLoading progress={progress} />}
        {status === "error" && <StageError error={error} onRetry={retry} />}
        {status === "password" && (
          <StageMessage icon="lock" title="This PDF has a password">
            It can't be opened here. Download it, then open it with its password on your device.
          </StageMessage>
        )}
      </div>
    </div>
  );
});

/**
 * The chosen color for new notes and drawings (or the selected one), and a line thick enough to see
 * when drawn with a finger.
 */
function applyColor(kit: PdfKit, bus: Bus, viewer: Viewer, value: string) {
  const P = kit.lib.AnnotationEditorParamsType;
  for (const type of [P.FREETEXT_COLOR, P.INK_COLOR]) bus.dispatch("switchannotationeditorparams", { source: viewer, type, value });
  bus.dispatch("switchannotationeditorparams", { source: viewer, type: P.INK_THICKNESS, value: 2 });
}

/** pdf.js's own errors as sentences. */
function friendly(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name;
  if (name === "InvalidPDFException") return new Error("This PDF is damaged, or it isn't really a PDF. Download it to try another app.");
  if (name === "ResponseException" || name === "MissingPDFException") return new Error("This file couldn't be loaded. Its link may have expired. Try again.");
  return error instanceof Error ? error : new Error("Couldn't open this PDF. Try again.");
}
