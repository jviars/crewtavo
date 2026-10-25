/**
 * The business's own letterhead on an estimate template (Settings → Estimate template, Letterhead →
 * Your own): the pictures it prints, and uploading a PDF or picture of the stationery. Crewtavo
 * finds where its printed top and bottom are, the person moves the lines if they like, and the two
 * bands go on the template (features/documents/letterhead.ts), to be kept when the template is saved.
 */
import { letterheadSrc, type LetterheadPicture } from "@crewtavo/core/documents";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { readLetterhead, saveLetterhead, type LetterheadBands, type LetterheadPage, type LetterheadPictures } from "../documents/letterhead";
import styles from "./OwnLetterhead.module.css";

export function OwnLetterhead({ header, footer, onChange }: { header: LetterheadPicture | null; footer: LetterheadPicture | null; onChange: (pictures: LetterheadPictures) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<LetterheadPage | null>(null);
  const read = useMutation({
    meta: { inline: true },
    mutationFn: async (file: File) => {
      const opened = await readLetterhead(file);
      if (!opened) throw new Error("Crewtavo can't open that file. Try a PDF, PNG or JPEG of your letterhead.");
      return opened;
    },
    onSuccess: setPage,
  });
  const close = () => {
    if (page) page.canvas.width = page.canvas.height = 0; // hand the memory back
    setPage(null);
  };

  return (
    <div className={styles.own}>
      {header || footer ? (
        <div className={styles.pictures}>
          {header && <Picture picture={header} caption="Top of the first page" />}
          {footer && <Picture picture={footer} caption="Along the bottom" />}
        </div>
      ) : (
        <p className={styles.empty}>Until you upload it, your estimates and invoices print with Crewtavo's letterhead.</p>
      )}
      <div className="stack-sm" style={{ gap: 6 }}>
        <Button size="sm" icon="upload" loading={read.isPending} style={{ justifySelf: "start" }} onClick={() => input.current?.click()}>
          {header || footer ? "Upload a different one" : "Upload your letterhead"}
        </Button>
        <span className="muted small">A PDF of a blank page of your letterhead prints cleanest: in Word, choose File → Save as PDF. A scan or photo of a printed page works too.</span>
      </div>
      <FormError error={read.error} />
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf,image/*,.svg,.heic,.heif"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) read.mutate(file);
        }}
      />
      {page && (
        <LetterheadDialog
          page={page}
          onClose={close}
          onSaved={(pictures) => {
            onChange(pictures);
            close();
          }}
        />
      )}
    </div>
  );
}

/** One of the pictures, on white, as it prints. */
function Picture({ picture, caption }: { picture: LetterheadPicture; caption: string }) {
  return (
    <figure className={styles.picture}>
      <span className={styles.paper}>
        <img src={letterheadSrc(picture.path)} width={picture.width} height={picture.height} alt="" />
      </span>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** Inches, to a tenth. */
const inches = (px: number, dpi: number) => `${(Math.round((px / dpi) * 10) / 10).toFixed(1)} in`;

/** The page with a line where the header ends and one where the footer starts, each dragged or moved with the arrow keys. */
function LetterheadDialog({ page, onClose, onSaved }: { page: LetterheadPage; onClose: () => void; onSaved: (pictures: LetterheadPictures) => void }) {
  const { canvas, dpi } = page;
  const height = canvas.height;
  const [bands, setBands] = useState<LetterheadBands>(page.bands);
  const [src, setSrc] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const save = useMutation({ meta: { inline: true }, mutationFn: () => saveLetterhead(page, bands), onSuccess: onSaved });

  useEffect(() => {
    let url: string | null = null;
    canvas.toBlob((blob) => {
      if (!blob) return;
      url = URL.createObjectURL(blob);
      setSrc(url);
    }, "image/jpeg", 0.85);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [canvas]);

  // The header and footer keep at least an inch of page between them.
  const room = Math.round(dpi);
  const move = (line: keyof LetterheadBands, y: number) =>
    setBands((b) =>
      line === "headerEnd"
        ? { ...b, headerEnd: Math.round(Math.min(Math.max(0, y), b.footerStart - room)) }
        : { ...b, footerStart: Math.round(Math.max(Math.min(height, y), b.headerEnd + room)) },
    );
  const drag = (line: keyof LetterheadBands) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId) || !box.current) return;
      const rect = box.current.getBoundingClientRect();
      move(line, ((e.clientY - rect.top) / rect.height) * height);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = (e.shiftKey ? 0.25 : 0.05) * dpi;
      const at = bands[line];
      const to = e.key === "ArrowUp" ? at - step : e.key === "ArrowDown" ? at + step : e.key === "Home" ? 0 : e.key === "End" ? height : null;
      if (to === null) return;
      e.preventDefault();
      move(line, to);
    },
  });
  const headerText = bands.headerEnd > 0 ? `${inches(bands.headerEnd, dpi)} tall` : "None";
  const footerText = bands.footerStart < height ? `${inches(height - bands.footerStart, dpi)} tall` : "None";
  // The header and footer together leave the estimate less than half the first page.
  const cramped = bands.footerStart - bands.headerEnd < height / 2;

  return (
    <Dialog open onClose={onClose} title="Your letterhead" description="Move the lines to where your letterhead's top ends and its bottom starts." size="lg">
      <div className="dialog-body">
        <div className={styles.split}>
          <div ref={box} className={styles.page} style={{ aspectRatio: `${canvas.width} / ${height}` }}>
            {src && <img src={src} alt="The first page of your letterhead" draggable={false} />}
            <div className={styles.header} style={{ height: `${(bands.headerEnd / height) * 100}%` }}>
              {bands.headerEnd > 0 && <span>Header</span>}
            </div>
            <div className={styles.middle} style={{ top: `${(bands.headerEnd / height) * 100}%`, bottom: `${100 - (bands.footerStart / height) * 100}%` }}>
              <span>Your estimate prints here</span>
            </div>
            <div className={styles.footer} style={{ height: `${100 - (bands.footerStart / height) * 100}%` }}>
              {bands.footerStart < height && <span>Footer</span>}
            </div>
            <div
              className={styles.line}
              style={{ top: `${(bands.headerEnd / height) * 100}%` }}
              role="slider"
              tabIndex={0}
              aria-label="Where the header ends"
              aria-valuemin={0}
              aria-valuemax={Math.round(height / dpi * 10) / 10}
              aria-valuenow={Math.round(bands.headerEnd / dpi * 10) / 10}
              aria-valuetext={bands.headerEnd > 0 ? `${inches(bands.headerEnd, dpi)} from the top` : "No header"}
              {...drag("headerEnd")}
            >
              <span>Header ends</span>
            </div>
            <div
              className={styles.line}
              style={{ top: `${(bands.footerStart / height) * 100}%` }}
              role="slider"
              tabIndex={0}
              aria-label="Where the footer starts"
              aria-valuemin={0}
              aria-valuemax={Math.round(height / dpi * 10) / 10}
              aria-valuenow={Math.round(bands.footerStart / dpi * 10) / 10}
              aria-valuetext={bands.footerStart < height ? `${inches(height - bands.footerStart, dpi)} from the bottom` : "No footer"}
              {...drag("footerStart")}
            >
              <span>Footer starts</span>
            </div>
          </div>
          <div className={styles.about}>
            <dl className={styles.sizes}>
              <dt>Header</dt>
              <dd>{headerText}</dd>
              <dt>Footer</dt>
              <dd>{footerText}</dd>
            </dl>
            <p>The header prints at the top of the first page, in place of Crewtavo's. The footer prints along the bottom, in place of the footer's words.</p>
            <p>Drag a line to the very top or bottom of the page to leave that part out. Without a top, Crewtavo's header prints there, in the style you pick; without a bottom, the footer's words do.</p>
            {page.rough && (
              <div className="callout callout-warning">
                <Icon name="alert" size={16} />
                <div className="grow">This looks like a photo, so its paper may still print gray, and its size may be off. For a clean letterhead, upload a PDF from Word or a flat scan of the page.</div>
              </div>
            )}
            {cramped && (
              <div className="callout callout-warning">
                <Icon name="alert" size={16} />
                <div className="grow">The header and footer leave your estimate less than half the page. Move the lines closer to your letterhead's top and bottom.</div>
              </div>
            )}
          </div>
        </div>
        <FormError error={save.error} />
        <div className="form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={save.isPending} disabled={bands.headerEnd <= 0 && bands.footerStart >= height} onClick={() => save.mutate()}>
            Use this letterhead
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
