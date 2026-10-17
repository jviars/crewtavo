import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Modal built on native <dialog>: the browser handles focus trapping, Escape and the backdrop.
 * Renders the title and a close button; children are usually a <form> (or a .dialog-body div).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Start typing straight away on desktop; on phones don't pop the keyboard over the sheet.
      const finePointer = window.matchMedia("(pointer: fine)").matches;
      const target = finePointer
        ? bodyRef.current?.querySelector<HTMLElement>('[autofocus], input:not([type="hidden"]):not([disabled]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled]), select:not([disabled])')
        : null;
      (target ?? dialog).focus({ preventScroll: true });
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // No unmount cleanup: removing an open <dialog> takes it out of the top layer by itself, and
  // calling close() here would fire onClose during React's development double-mount.

  return (
    <dialog
      ref={ref}
      className={["dialog", size !== "md" && `dialog-${size}`, className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      tabIndex={-1}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <header className="dialog-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 id={titleId}>{title}</h2>
              {description && <p>{description}</p>}
            </div>
            <button type="button" className="icon-btn dialog-close" aria-label="Close" onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          </header>
          <div ref={bodyRef} className="dialog-content">{children}</div>
        </>
      )}
    </dialog>
  );
}
