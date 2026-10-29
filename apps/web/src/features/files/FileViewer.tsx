/**
 * The file viewer: a full-screen layer over the app that shows a stored file (PDFs, Word documents,
 * pictures, text files) and, for people who can add files, edits PDFs and Word documents. Saving an
 * edit always adds a new version; nothing is overwritten.
 *
 *   {viewing && <FileViewer file={viewing} canEdit={canAdd} onClose={() => setViewing(null)} onSaved={refresh} />}
 *
 * This part is small and safe to import anywhere (every screen is prefetched): the viewers and
 * editors load the first time a file is opened (FileViewerBody.tsx and the parts it loads).
 *
 * It's a layer of its own rather than a modal <dialog>: the Word editor opens its font and style
 * lists at the end of <body>, which a modal dialog would leave behind it, out of reach. Escape
 * closes it, focus stays inside it, and the page behind it doesn't scroll.
 */
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/ui/Icon";
import type { PlanFile } from "@/features/plans/plans";
import { isTyping, type ViewerFile } from "./files";
import { StageLoading, ViewerBoundary } from "./ViewerParts";
import styles from "./files.module.css";

export { editKind, previewKind, type EditKind, type PreviewKind, type ViewerFile } from "./files";

export interface FileViewerProps {
  file: ViewerFile;
  /** Whether this person may add a version of the file (office roles and crew leads). */
  canEdit: boolean;
  /** Open straight into the editor (an "Edit" menu item). */
  startEditing?: boolean;
  onClose(): void;
  /** Called with the new version after an edit is saved. */
  onSaved?(next: PlanFile): void;
  /**
   * Whether going to another screen with unsaved changes asks first (the default). A screen with
   * unsaved work of its own and its own check (Measure) passes false with onDirtyChange: the router
   * heeds only one such check at a time, so the screen's has to know about both. Closing the viewer,
   * Escape and closing the tab still ask either way.
   */
  blockNavigation?: boolean;
  /**
   * Told whenever the viewer's unsaved changes come or go (false once it closes), for a screen whose
   * own check before leaving has to cover them too (blockNavigation={false}).
   */
  onDirtyChange?(dirty: boolean): void;
  /**
   * Filled in while the viewer is open with its own way of closing (it asks first when there are
   * unsaved changes), for a screen that has to close it itself: the file went to the Trash meanwhile.
   */
  closeRequest?: MutableRefObject<(() => void) | null>;
}

export interface FileViewerBodyProps extends FileViewerProps {
  titleId: string;
  /** The body puts its own close here while it's open: it asks first when there are unsaved changes. */
  closeRef: MutableRefObject<(() => void) | null>;
}

const loadBody = () => import("./FileViewerBody");

/** A list or menu open in the viewer (or in the Word editor's lists at the end of <body>). */
const popupOpen = (root: Element) =>
  [...root.querySelectorAll('[role="listbox"], [role="menu"]'), ...document.querySelectorAll('body > .docx-editor [role="listbox"], body > .docx-editor [role="menu"]')].some(
    (el) => el.getClientRects().length > 0,
  );

/** What can take focus inside the viewer, for keeping Tab inside it. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Where focus may go while the viewer is open: its confirms, menus and toasts, and the Word editor's lists. */
const ALSO_INSIDE = "dialog[open], [popover], .docx-editor, [data-radix-popper-content-wrapper]";

export function FileViewer(props: FileViewerProps) {
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const closeRef = useRef<(() => void) | null>(null);
  const close = () => (closeRef.current ?? onCloseRef.current)();
  const closeRequest = props.closeRequest;
  useEffect(() => {
    if (!closeRequest) return;
    closeRequest.current = () => (closeRef.current ?? onCloseRef.current)();
    return () => {
      closeRequest.current = null;
    };
  }, [closeRequest]);
  const [attempt, setAttempt] = useState(0);
  // A fresh lazy component per attempt, so "Try again" after a failed download really tries again.
  const Body = useMemo(() => lazy(loadBody), [attempt]);
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  const popupAtEscape = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    root.focus({ preventScroll: true });

    // Keep focus in the viewer and in what it opens over itself.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (!target || root.contains(target) || target.closest?.(ALSO_INSIDE)) return;
      root.focus({ preventScroll: true });
    };
    // Focus can fall back to <body> (a list closing, a button going away): Escape still closes the
    // viewer then. Keys inside it come through onKeyDown, so a list in the Word editor that stops
    // its Escape keeps it.
    const onKey = (e: KeyboardEvent) => {
      if (e.target === document.body) onKeyRef.current(e);
    };
    // Whether a list was open when Escape was pressed, noted before anything handles the key:
    // the Word editor shuts its lists from a listener of its own that runs first.
    const notePopup = (e: KeyboardEvent) => {
      if (e.key === "Escape") popupAtEscape.current = popupOpen(root);
    };
    window.addEventListener("keydown", notePopup, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", notePopup, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey);
      html.style.overflow = overflow;
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  onKeyRef.current = (e: KeyboardEvent) => {
    const root = rootRef.current;
    const target = e.target as Element | null;
    if (!root || e.defaultPrevented) return;
    if (e.key === "Escape") {
      // Typing, or a list or menu open (the Word editor's font list): Escape is theirs.
      if (isTyping(target) || popupAtEscape.current || popupOpen(root)) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Shown while the viewer's code downloads, and if it can't.
  const header = (
    <header className={styles.head}>
      <div className={styles.headText}>
        <h2 id={titleId} className={styles.title}>{props.file.title}</h2>
      </div>
      <div className={styles.headActions}>
        <button type="button" className={`icon-btn ${styles.close}`} aria-label="Close" title="Close" onClick={close}>
          <Icon name="x" size={20} />
        </button>
      </div>
    </header>
  );

  return createPortal(
    <div ref={rootRef} className={styles.viewer} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(e) => onKeyRef.current(e.nativeEvent)}>
      <ViewerBoundary key={attempt} header={header} onRetry={() => setAttempt((n) => n + 1)}>
        <Suspense fallback={<>{header}<div className={styles.stage}><StageLoading /></div></>}>
          <Body {...props} titleId={titleId} closeRef={closeRef} />
        </Suspense>
      </ViewerBoundary>
    </div>,
    document.body,
  );
}
