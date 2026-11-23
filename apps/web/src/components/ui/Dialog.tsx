import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { afterExit, announceTopLayer } from "@/lib/motion";
import { springBack } from "@/lib/spring";
import { Icon } from "./Icon";
import { t } from "@/lib/i18n";

/**
 * Modal built on native <dialog>: the browser handles focus trapping, Escape and the backdrop.
 * Renders the title and a close button; children are usually a <form> (or a .dialog-body div).
 * Once closed it keeps showing what it showed last until it has animated out, then calls onExited.
 */
export function Dialog({
  open,
  onClose,
  onExited,
  title,
  description,
  size = "md",
  focusField = true,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** After it has closed and finished animating out: the time to clear what it showed. */
  onExited?: () => void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** False when its first field isn't where to start (a composer that starts with picking photos). */
  focusField?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Leaving starts in the same render that closes it, so the content never blinks out first.
  const [wasOpen, setWasOpen] = useState(open);
  const [leaving, setLeaving] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    setLeaving(!open);
  }
  // The caller often clears what's inside as it closes; the exit plays on what was last shown.
  const shown = useRef({ title, description, children });
  if (open) shown.current = { title, description, children };
  const exited = useRef(onExited);
  exited.current = onExited;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // Pulled down and dropped last time: it comes back up from below like any other time.
      delete dialog.dataset.pulled;
      dialog.style.removeProperty("--pull");
      dialog.showModal();
      announceTopLayer();
      // Start typing straight away on desktop; on phones don't pop the keyboard over the sheet. A field
      // out of sight (a picker's search, in its shut menu) is passed over: focus that can't land would
      // stay on the close button, where showModal put it.
      const finePointer = window.matchMedia("(pointer: fine)").matches;
      const target = finePointer && focusField
        ? [...(bodyRef.current?.querySelectorAll<HTMLElement>('[autofocus], input:not([type="hidden"]):not([disabled]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])') ?? [])].find((el) => el.getClientRects().length > 0)
        : null;
      target?.focus({ preventScroll: true });
      if (!target || document.activeElement !== target) dialog.focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!leaving || !dialog) return;
    return afterExit(dialog, () => {
      setLeaving(false);
      exited.current?.();
    });
  }, [leaving]);

  // No close() on unmount: removing an open <dialog> takes it out of the top layer by itself, and
  // calling close() here would fire onClose during React's development double-mount.
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) leaveInPlace(dialog);
    };
  }, []);

  const pull = useSheetPull(ref, onClose);
  const view = shown.current;
  return (
    <dialog
      ref={ref}
      className={["dialog", size !== "md" && `dialog-${size}`, className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      tabIndex={-1}
      // The close event arrives a moment after close(): by then it may have opened again (the next
      // confirmation in the same dialog), and that one mustn't be closed with it.
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {(open || leaving) && (
        <>
          <header className="dialog-head" {...pull}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 id={titleId}>{view.title}</h2>
              {view.description && <p>{view.description}</p>}
            </div>
            <button type="button" className="icon-btn dialog-close" aria-label={t("Close")} onClick={onClose}>
              <Icon name="x" size={20} />
            </button>
          </header>
          <div ref={bodyRef} className="dialog-content">{view.children}</div>
        </>
      )}
    </dialog>
  );
}

/** Up to here a dialog is a sheet from the bottom of the screen (components.css). */
const SHEET = "(max-width: 900px)";
/** How far down, as a share of its height, a sheet has to be pulled for letting go to close it. */
const PULL_CLOSES = 1 / 3;
/** Or how fast it's moving down when let go, in pixels a millisecond: a flick closes it too. */
const FLICK = 0.5;
/** Still open this long after a pull asked it to close, the screen kept it open. */
const KEPT_OPEN_MS = 250;

/**
 * On a phone a dialog is a sheet, and its header is the handle: it follows a finger pulling it down
 * and, let go far enough down or with a flick, carries on down and closes like any other close.
 * Short of that it springs back. Pulled upwards it only gives a little, against the screen's edge.
 * The content below the header scrolls as before; buttons in the header still just get tapped.
 */
function useSheetPull(ref: RefObject<HTMLDialogElement>, onClose: () => void) {
  const pull = useRef<{ pointer: number; y: number; dy: number; at: number; speed: number; pulling: boolean } | null>(null);
  const move = (dialog: HTMLDialogElement, dy: number) => {
    const y = dy >= 0 ? dy : -Math.sqrt(-dy) * 2;
    dialog.style.setProperty("--pull", `${y}px`);
    return y;
  };
  return {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.pointerType === "mouse" || !window.matchMedia(SHEET).matches) return;
      if ((e.target as Element).closest("button, a, input, select, textarea, [contenteditable]")) return;
      pull.current = { pointer: e.pointerId, y: e.clientY, dy: 0, at: e.timeStamp, speed: 0, pulling: false };
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const p = pull.current;
      const dialog = ref.current;
      if (!p || p.pointer !== e.pointerId || !dialog) return;
      const dy = e.clientY - p.y;
      if (!p.pulling) {
        if (Math.abs(dy) < 6) return;
        p.pulling = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // The finger already lifted.
        }
        dialog.dataset.pulling = "";
        // Caught again while still springing back: the finger has it now.
        for (const a of dialog.getAnimations?.() ?? []) if (!("transitionProperty" in a) && !("animationName" in a)) a.cancel();
      }
      const dt = e.timeStamp - p.at;
      if (dt > 0) p.speed = (dy - p.dy) / dt;
      p.at = e.timeStamp;
      p.dy = dy;
      move(dialog, dy);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => letGo(e),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => letGo(e),
  };

  function letGo(e: ReactPointerEvent<HTMLElement>) {
    const p = pull.current;
    const dialog = ref.current;
    if (!p || p.pointer !== e.pointerId || !dialog) return;
    pull.current = null;
    if (!p.pulling) return;
    delete dialog.dataset.pulling;
    const closes = e.type === "pointerup" && p.dy > 0 && (p.dy > dialog.offsetHeight * PULL_CLOSES || (p.speed > FLICK && p.dy > 24));
    if (closes) {
      // Its closed state (components.css) is all the way down, so the exit picks up from here.
      dialog.dataset.pulled = "";
      onClose();
      // The screen may keep it open instead (changes not saved yet, something still running):
      // then it comes back up rather than staying where it was dropped.
      window.setTimeout(() => {
        if (!dialog.isConnected || !dialog.open || dialog.dataset.pulled === undefined) return;
        delete dialog.dataset.pulled;
        springHome(dialog, p.dy);
      }, KEPT_OPEN_MS);
      return;
    }
    springHome(dialog, p.dy);
  }

  function springHome(dialog: HTMLDialogElement, dy: number) {
    const from = `translateY(${move(dialog, dy)}px)`;
    dialog.style.removeProperty("--pull");
    void springBack(dialog, from);
  }
}

/**
 * Lets a layer of the page's own (the file viewer, at the end of <body>) open over the dialogs
 * that are open. A modal dialog shows above everything else and leaves the rest of the page out of
 * reach, so a file opened from one (a snow customer's Plans and files) would open behind it. Each
 * open modal dialog becomes an ordinary one, hidden and out of reach, until the function this
 * returns puts it back (the one with focus last, so it's on top again), unless it was closed
 * meanwhile. A dialog that is going away has gone by the time this is called (from an effect).
 */
export function lowerDialogs(): () => void {
  let modal: HTMLDialogElement[];
  try {
    modal = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")];
  } catch {
    modal = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")]; // a browser without :modal
  }
  if (!modal.length) return () => undefined;
  const focused = document.activeElement?.closest("dialog");
  modal.sort((a, b) => Number(a === focused) - Number(b === focused));
  for (const dialog of modal) {
    // Its close event finds it open again, so Dialog's onClose doesn't take this for closing.
    dialog.close();
    dialog.show();
    dialog.inert = true;
    dialog.style.visibility = "hidden";
  }
  return () => {
    let raised = false;
    for (const dialog of modal) {
      dialog.inert = false;
      dialog.style.visibility = "";
      if (!dialog.isConnected || !dialog.open) continue;
      dialog.close();
      dialog.showModal();
      raised = true;
    }
    if (raised) announceTopLayer();
  };
}

/**
 * Most dialogs close by not being rendered any more ({editing && <EditDialog open />}), which would
 * take them off the screen at once. So a copy is left where it was, inert and over a copy of the
 * backdrop, plays the same exit and is removed. It's taken while the dialog is still in the page
 * (scroll positions, a signature on a canvas) and put in only once React has really removed it,
 * not for its development double-mount.
 */
function leaveInPlace(dialog: HTMLDialogElement) {
  const ghost = dialog.cloneNode(true) as HTMLDialogElement;
  const from = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")];
  const scrolled = from.flatMap((el, i) => (el.scrollTop || el.scrollLeft ? [{ i, top: el.scrollTop, left: el.scrollLeft }] : []));
  const canvases = Array.from(dialog.querySelectorAll("canvas"));
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  // A copied frame or video would load all over again.
  ghost.querySelectorAll("iframe, video, audio, source, embed").forEach((el) => el.removeAttribute("src"));
  ghost.querySelectorAll("object").forEach((el) => el.removeAttribute("data"));
  const backdrop = document.createElement("div");
  backdrop.className = "dialog-ghost-backdrop";
  queueMicrotask(() => {
    if (dialog.isConnected) return;
    ghost.style.transition = "none";
    document.body.append(backdrop, ghost);
    const to = [ghost, ...ghost.querySelectorAll<HTMLElement>("*")];
    for (const { i, top, left } of scrolled) to[i]?.scrollTo(left, top);
    ghost.querySelectorAll("canvas").forEach((canvas, i) => {
      try {
        if (canvases[i]) canvas.getContext("2d")?.drawImage(canvases[i], 0, 0);
      } catch {
        // A canvas drawn some other way just shows blank as it fades.
      }
    });
    // Shown as it was first, then let go, so it transitions out rather than in.
    ghost.getBoundingClientRect();
    ghost.style.removeProperty("transition");
    ghost.removeAttribute("open");
    afterExit(ghost, () => {
      ghost.remove();
      backdrop.remove();
    });
  });
}
