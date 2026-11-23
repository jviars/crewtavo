/**
 * Draw and write on a photo: a pen, an arrow, a circle, a box and words, in a few colours and two
 * line widths, with undo, redo and clear. Full screen (a phone is where it's mostly used), with a
 * finger, a stylus or a mouse (pointer events), and the keyboard for the buttons, undo (Ctrl+Z),
 * redo (Ctrl+Shift+Z or Ctrl+Y) and words, which are typed and placed where the photo was last
 * tapped (the middle until then).
 *
 * The marks are data (core/photoMarkup.ts) drawn over the picture on a canvas the size the copy is
 * saved at: never larger than the photo, and no longer than 2000 pixels on its long side, as an
 * upload is. Saving gives back that copy as a JPEG, and the marks to keep with it; what becomes of
 * them is the caller's (a photo being added keeps them beside the original through the phone's
 * queue; one already up saves them beside the original: lib/photoMarkup.ts).
 *
 * A photo drawn on before opens as it was taken with its earlier marks on it, each still its own
 * (core unpackMarks), when those were kept; else it opens the drawing itself and adds to that.
 */
import {
  addMark,
  canRedo,
  canUndo,
  clearMarks,
  drawMark,
  drawMarks,
  emptyHistory,
  exportSize,
  extendStroke,
  fitInside,
  historyFrom,
  leaveAnswer,
  leaveQuestion,
  MARKUP_COLORS,
  MARKUP_TOOLS,
  packMarks,
  redo,
  toPicture,
  undo,
  unpackMarks,
  type Mark,
  type MarkupHistory,
  type MarkupTool,
  type MarkupWidth,
  type Point,
  type SavedMarks,
} from "@crewtavo/core/photoMarkup";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { announceTopLayer } from "@/lib/motion";
import { errorMessage } from "@/lib/errors";
import { choose, confirm } from "./ui/Confirm";
import { Button, cx, Spinner } from "./ui/Button";
import { Icon, type IconName } from "./ui/Icon";
import { Menu } from "./ui/Menu";
import styles from "./PhotoEditor.module.css";
import { t } from "@/lib/i18n";

const TOOL_ICONS: Record<MarkupTool, IconName> = { pen: "pen", arrow: "arrowUpRight", ellipse: "circle", box: "square", text: "type" };

type Picture = ImageBitmap | HTMLImageElement;

/**
 * A stored photo to draw on. `original`: the photo as taken (with `marks`, what was drawn on it
 * before and the drawing that made: attachments.marks, marked_path), so its marks can be kept.
 * Not `original`: a drawing from before marks were kept, which can only be added to.
 */
export interface PictureToDrawOn {
  picture: Blob;
  original: boolean;
  marks?: { saved: unknown; path: string };
}
/** Given the path the drawing is saved at: the marks to keep with it, or null when they can't be kept. */
export type MarksFor = (path: string) => SavedMarks | null;

/** Opens a picture to draw on: the way that turns it upright as the camera took it, else an <img>. */
async function openPicture(blob: Blob): Promise<Picture> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
/** Hands a decoded picture's memory back (a phone's photo is tens of megabytes opened up). */
const closePicture = (p: Picture) => {
  if ("close" in p) p.close();
};
const naturalSize = (p: Picture) => ("naturalWidth" in p ? { width: p.naturalWidth, height: p.naturalHeight } : { width: p.width, height: p.height });

/** The photo with its marks, as a JPEG at the size it's saved at. */
function render(picture: Picture, marks: readonly Mark[], size: { width: number; height: number }): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d")!;
  // A see-through picture would turn black as a JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, 0, 0, size.width, size.height);
  drawMarks(ctx, marks, size);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      canvas.width = canvas.height = 0; // hand the memory back
      if (blob) resolve(blob);
      else reject(new Error(t("This phone couldn't save the drawing. Try again.")));
    }, "image/jpeg", 0.85),
  );
}

export function PhotoEditor({
  picture: source,
  title,
  saveLabel,
  keepsBlank = false,
  onSave,
  onCancel,
  onRemoveDrawing,
}: {
  /** The photo, or how to fetch it (a stored one, with what was drawn on it before). */
  picture: Blob | (() => Promise<PictureToDrawOn>);
  title?: string;
  saveLabel?: string;
  /** Save with nothing drawn: a photo being added goes in as it was taken (onSave gets null). */
  keepsBlank?: boolean;
  /** Given the drawing and its marks to keep, or null when nothing was drawn (only with keepsBlank). Closes on its own once this resolves. */
  onSave: (drawn: Blob | null, marks: MarksFor) => Promise<void> | void;
  onCancel: () => void;
  /** For a photo drawn on before: back to the original, the drawing off. */
  onRemoveDrawing?: () => Promise<void> | void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [history, setHistory] = useState<MarkupHistory>(emptyHistory);
  // What was drawn on it before, when the editor started from that; and whether the marks can be kept (the picture is the photo as taken).
  const [earlier, setEarlier] = useState<Mark[] | null>(null);
  const [keepsMarks, setKeepsMarks] = useState(true);
  const [tool, setTool] = useState<MarkupTool>("pen");
  const [color, setColor] = useState(MARKUP_COLORS[0]!.color);
  const [width, setWidth] = useState<MarkupWidth>("thin");
  const [words, setWords] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The mark being drawn, and the finger drawing it (a second finger is ignored).
  const draft = useRef<{ mark: Mark; pointer: number } | null>(null);
  const tapped = useRef<Point | null>(null);
  const [, redraw] = useState(0);
  const size = picture ? exportSize(naturalSize(picture).width, naturalSize(picture).height) : null;

  useEffect(() => {
    let gone = false;
    (async () => {
      try {
        const from: PictureToDrawOn = typeof source === "function" ? await source() : { picture: source, original: true };
        const opened = await openPicture(from.picture);
        if (gone) return closePicture(opened);
        const before = from.original && from.marks ? unpackMarks(from.marks.saved, from.marks.path, exportSize(naturalSize(opened).width, naturalSize(opened).height)) : null;
        if (before) {
          setEarlier(before);
          setHistory(historyFrom(before));
        }
        // Marks that weren't kept, or can't be read: the photo as taken would lose them, so the loader gives the drawing instead (not `original`).
        setKeepsMarks(from.original && (!from.marks || Boolean(before)));
        setPicture(opened);
      } catch (error) {
        if (!gone) setFailed(error instanceof Error && /couldn't be opened/.test(error.message) ? t(error.message) : t("This photo can't be drawn on in this browser."));
      }
    })();
    return () => {
      gone = true;
    };
    // The photo is fixed for as long as the editor is open.
  }, []);

  useLayoutEffect(() => {
    const el = dialog.current;
    if (el && !el.open) {
      el.showModal();
      announceTopLayer();
    }
  }, []);

  // How much room the photo has: what the bars leave, measured again whenever that changes (the
  // tool bar wrapping, the phone turned, the keyboard up).
  const stage = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRoom((was) => (was && was.width === el.clientWidth && was.height === el.clientHeight ? was : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const shown = size && room ? fitInside(size, room) : null;

  // Closed: the opened picture and the canvas give their memory back, rather than waiting for the browser to notice.
  const drawnOn = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!picture) return;
    return () => {
      closePicture(picture);
      if (drawnOn.current) drawnOn.current.width = drawnOn.current.height = 0;
    };
  }, [picture]);

  // The picture and every mark, the one being drawn last.
  useEffect(() => {
    const el = canvas.current;
    if (!el || !picture || !size) return;
    drawnOn.current = el;
    const ctx = el.getContext("2d")!;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.drawImage(picture, 0, 0, size.width, size.height);
    drawMarks(ctx, history.marks, size);
    if (draft.current) drawMark(ctx, draft.current.mark, size);
  });

  const at = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return toPicture({ x: e.clientX, y: e.clientY }, r, size!);
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!size || draft.current || busy) return;
    const p = at(e);
    if (tool === "text") {
      tapped.current = p;
      if (words.trim()) addWords(p);
      else document.getElementById("photo-editor-words")?.focus();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    draft.current = { pointer: e.pointerId, mark: tool === "pen" ? { kind: "pen", color, width, points: [p] } : { kind: tool, color, width, from: p, to: p } };
    redraw((n) => n + 1);
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = draft.current;
    if (!d || d.pointer !== e.pointerId) return;
    const p = at(e);
    d.mark = d.mark.kind === "pen" ? { ...d.mark, points: extendStroke(d.mark.points, p) } : d.mark.kind === "text" ? d.mark : { ...d.mark, to: p };
    redraw((n) => n + 1);
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = draft.current;
    if (!d || d.pointer !== e.pointerId) return;
    draft.current = null;
    setHistory((h) => addMark(h, d.mark));
  };
  const addWords = (where = tapped.current) => {
    if (!size || !words.trim()) return;
    const point = where ?? { x: size.width / 2, y: size.height / 2 };
    setHistory((h) => addMark(h, { kind: "text", color, width, at: point, text: words.trim().slice(0, 120) }));
    setWords("");
  };

  // Something to save: a mark made, or the earlier marks changed.
  const drawn = earlier ? history.marks !== earlier : history.marks.length > 0;
  const leave = async () => {
    if (busy) return;
    // A photo being added isn't anywhere yet: leaving asks whether it goes on as it was taken, so it's never lost quietly.
    const question = leaveQuestion({ adding: keepsBlank, drawn });
    const answer =
      question === "add-without-drawing"
        ? await choose({
            title: t("Add the photo without drawing?"),
            body: drawn ? t("What you drew won't be saved. The photo can still be added as it was taken.") : t("The photo hasn't been added yet."),
            confirmLabel: t("Add without drawing"),
            cancelLabel: t("Don't add it"),
          })
        : question === "throw-away-drawing"
          ? await confirm({ title: t("Throw away the drawing?"), body: t("What you drew on this photo won't be saved."), confirmLabel: t("Throw it away"), cancelLabel: t("Keep drawing"), danger: true })
          : null;
    const next = leaveAnswer(question, answer);
    if (next === "close") return onCancel();
    if (next === "stay") return;
    setBusy("save");
    setProblem(null);
    try {
      await onSave(null, () => null);
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(null);
    }
  };
  const save = async () => {
    if (!picture || !size || busy) return;
    setBusy("save");
    setProblem(null);
    try {
      // Every earlier mark cleared: the same as taking the drawing off.
      if (earlier && !history.marks.length && onRemoveDrawing) await onRemoveDrawing();
      else await onSave(history.marks.length ? await render(picture, history.marks, size) : null, (path) => (keepsMarks ? packMarks(history.marks, size, path) : null));
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(null);
    }
  };
  const removeDrawing = async () => {
    if (!onRemoveDrawing || busy) return;
    if (!(await confirm({ title: t("Take the drawing off?"), body: t("The photo shows as it was taken. The drawing goes to the Trash."), confirmLabel: t("Take it off") }))) return;
    setBusy("remove");
    setProblem(null);
    try {
      await onRemoveDrawing();
    } catch (error) {
      setProblem(errorMessage(error));
      setBusy(null);
    }
  };
  const keys = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).tagName === "INPUT") return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) setHistory(undo);
    else if ((key === "z" && e.shiftKey) || key === "y") setHistory(redo);
    else return;
    e.preventDefault();
  };

  const nothing = !drawn && !keepsBlank;
  return (
    <dialog
      ref={dialog}
      className="photo-editor"
      aria-label={title ?? t("Draw on the photo")}
      onKeyDown={keys}
      // Escape asks first when something's drawn, or when the photo is still to be added.
      onCancel={(e) => {
        e.preventDefault();
        void leave();
      }}
    >
      {/* Photos' own markup (iOS, Android): Cancel and Save at the top, undo and redo between, the tools at the foot. */}
      <div className={cx("photo-editor-bar", styles.head)}>
        <Button variant="ghost" className={styles.cancel} disabled={Boolean(busy)} onClick={() => void leave()}>{t("Cancel")}</Button>
        <strong className={styles.title}>{title ?? t("Draw on the photo")}</strong>
        <div className={styles.history}>
          <button type="button" className="photo-editor-tool" aria-label={t("Undo")} title={t("Undo (Ctrl+Z)")} disabled={!canUndo(history) || Boolean(busy)} onClick={() => setHistory(undo)}><Icon name="undo" size={20} /></button>
          <button type="button" className="photo-editor-tool" aria-label={t("Redo")} title={t("Redo (Ctrl+Shift+Z)")} disabled={!canRedo(history) || Boolean(busy)} onClick={() => setHistory(redo)}><Icon name="redo" size={20} /></button>
          <Menu
            label={t("More actions")}
            title={title ?? t("Draw on the photo")}
            triggerClassName={cx("photo-editor-tool", styles.more)}
            trigger={<Icon name="more" size={20} />}
            items={[
              { label: t("Clear"), icon: "trash", disabled: !history.marks.length || Boolean(busy), onSelect: () => setHistory(clearMarks) },
              ...(onRemoveDrawing ? [{ separator: true as const }, { label: t("Take the drawing off"), icon: "undo" as const, danger: true, disabled: Boolean(busy), onSelect: () => void removeDrawing() }] : []),
            ]}
          />
        </div>
        <Button variant="primary" className={styles.save} loading={busy === "save" || busy === "remove"} disabled={(nothing || !picture) && !(keepsBlank && failed) || Boolean(busy)} onClick={() => (failed && keepsBlank ? void onSave(null, () => null) : void save())}>
          {saveLabel ?? t("Save")}
        </Button>
      </div>

      <div className="photo-editor-stage" ref={stage}>
        {failed ? (
          // Read out as it appears: the photo didn't open, and what can still be done.
          <div className="stack-sm" role="alert" style={{ textAlign: "center", padding: 16 }}>
            <span>{failed}</span>
            {keepsBlank && <span className="small">{t("You can still add it as it is.")}</span>}
          </div>
        ) : !picture ? (
          // A status, so its label is read (a bare span's isn't).
          <Spinner size={28} label={t("Opening the photo")} />
        ) : (
          <canvas
            ref={canvas}
            width={size!.width}
            height={size!.height}
            role="img"
            aria-label={history.marks.length ? t.plural(history.marks.length, { one: "The photo, with {count} mark", other: "The photo, with {count} marks" }) : t("The photo")}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            // All of the photo, whatever its shape and however much the bars take (core fitInside).
            style={{ cursor: tool === "text" ? "text" : "crosshair", ...(shown && { width: shown.width, height: shown.height }) }}
          />
        )}
      </div>

      {problem && <div className={cx("photo-editor-bar", styles.problem)}><span className="grow small photo-editor-problem" role="alert">{problem}</span></div>}
      {tool === "text" && (
        <div className={cx("photo-editor-bar", styles.words)}>
          <form
            className="row grow"
            style={{ gap: 6 }}
            onSubmit={(e) => {
              e.preventDefault();
              addWords();
            }}
          >
            <input id="photo-editor-words" className="input grow" aria-label={t("Words to add")} placeholder={t("Type, then tap where it goes")} value={words} maxLength={120} onChange={(e) => setWords(e.target.value)} />
            <Button size="sm" type="submit" disabled={!words.trim()}>{t("Add")}</Button>
          </form>
        </div>
      )}
      <div className={cx("photo-editor-bar photo-editor-tools", styles.tools)}>
        <div className={styles.track} role="group" aria-label={t("Draw with")}>
          {MARKUP_TOOLS.map((m) => (
            <button key={m.tool} type="button" className="photo-editor-tool" aria-pressed={tool === m.tool} aria-label={t(m.label)} title={t(m.label)} onClick={() => setTool(m.tool)}>
              <Icon name={TOOL_ICONS[m.tool]} size={20} />
            </button>
          ))}
        </div>
        <div className={styles.swatches} role="group" aria-label={t("Colour")}>
          {MARKUP_COLORS.map((c) => (
            <button key={c.color} type="button" className="photo-editor-swatch" aria-pressed={color === c.color} aria-label={t(c.label)} title={t(c.label)} style={{ background: c.color }} onClick={() => setColor(c.color)} />
          ))}
        </div>
        <div className={styles.track} role="group" aria-label={t("Line")}>
          {(["thin", "thick"] as const).map((w) => (
            <button key={w} type="button" className="photo-editor-tool" aria-pressed={width === w} aria-label={w === "thin" ? t("Thin line") : t("Thick line")} title={w === "thin" ? t("Thin") : t("Thick")} onClick={() => setWidth(w)}>
              <span aria-hidden="true" style={{ display: "block", width: 20, height: w === "thin" ? 2 : 6, borderRadius: 3, background: "currentColor" }} />
            </button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
