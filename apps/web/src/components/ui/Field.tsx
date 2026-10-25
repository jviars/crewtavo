import { useEffect, useId, useRef, type ReactNode } from "react";

const CONTROL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"], [role="textbox"]';

/**
 * A labelled form field. The label is tied to the field's first text control by id rather than by
 * wrapping, so buttons inside the field (tag chips, pickers, show-password) never steal label clicks.
 * A set of radio buttons in it becomes a radio group named by the label, so each choice is heard
 * with the question it answers.
 */
export function Field({ label, hint, error, optional, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; children: ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;
  const hasNote = Boolean(error || hint);
  useEffect(() => {
    const radio = ref.current?.querySelector<HTMLInputElement>('input[type="radio"]');
    const group = radio ? (radio.closest("label")?.parentElement ?? radio.parentElement) : null;
    if (group && ref.current?.contains(group) && group !== ref.current && (!group.hasAttribute("aria-labelledby") || group.dataset.fieldLabel)) {
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-labelledby", labelId);
      group.dataset.fieldLabel = "1";
    }
    const control = ref.current?.querySelector<HTMLElement>(CONTROL);
    if (!control) return;
    if (!control.hasAttribute("aria-label") && (!control.hasAttribute("aria-labelledby") || control.dataset.fieldLabel)) {
      control.setAttribute("aria-labelledby", labelId);
      control.dataset.fieldLabel = "1";
    }
    if (hasNote) control.setAttribute("aria-describedby", noteId);
    else if (control.getAttribute("aria-describedby") === noteId) control.removeAttribute("aria-describedby");
    // Only undo aria-invalid that this field set; some controls manage their own.
    if (error) {
      if (control.getAttribute("aria-invalid") !== "true") {
        control.setAttribute("aria-invalid", "true");
        control.dataset.fieldInvalid = "1";
      }
    } else if (control.dataset.fieldInvalid) {
      control.removeAttribute("aria-invalid");
      delete control.dataset.fieldInvalid;
    }
  });
  return (
    <div ref={ref} className={className ? `field ${className}` : "field"}>
      <span
        id={labelId}
        className="field-label"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a")) return;
          ref.current?.querySelector<HTMLElement>(CONTROL)?.focus();
        }}
      >
        {label}
        {optional && <span className="optional"> (optional)</span>}
      </span>
      {children}
      {error ? <span id={noteId} className="field-error" role="alert">{error}</span> : hint && <span id={noteId} className="hint">{hint}</span>}
    </div>
  );
}

/** Error banner at the bottom of a form. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="form-error" role="alert">{message}</div>;
}
