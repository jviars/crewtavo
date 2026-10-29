import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/errors";
import { phoneDigits } from "@/lib/validate";
import { Icon } from "./Icon";

const CONTROL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), select, textarea, [contenteditable="true"], [role="textbox"]';

type Checkable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const isCheckable = (el: unknown): el is Checkable => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
const hasValue = (control: Checkable) => (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "radio") ? control.checked : control.value.trim() !== "");
const isContact = (control: Checkable) => control instanceof HTMLInputElement && (control.type === "email" || control.type === "tel");

const NOT_RIGHT = "This doesn't look right.";
const DATE_TYPES = new Set(["date", "datetime-local", "month", "week"]);

/** A min or max as people read it: "1,000", or "Oct 28, 2026" for a date. */
function readLimit(control: Checkable, limit: string): string {
  if (control.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(limit)) return new Date(`${limit}T00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return control.type === "number" && limit !== "" && Number.isFinite(Number(limit)) ? Number(limit).toLocaleString("en-US") : limit;
}

/**
 * Why a control's value doesn't pass, as a Crewtavo sentence from its validity, or null when it does.
 * `label` names the field in "{label} is required."; requiredMessage replaces that sentence.
 */
export function validityMessage(control: Checkable, label: string, requiredMessage?: string): string | null {
  const v = control.validity;
  if (v.valid) return null;
  const type = control.type;
  const dated = DATE_TYPES.has(type) || type === "time";
  if (v.valueMissing) return requiredMessage ?? (label && !label.endsWith("?") ? `${label} is required.` : "This is required.");
  if (v.typeMismatch) return type === "email" ? "Enter an email like name@company.com." : type === "url" ? "Enter a web address like https://example.com." : NOT_RIGHT;
  if (v.badInput) return type === "number" ? "Enter a number." : DATE_TYPES.has(type) ? "Enter a full date." : type === "time" ? "Enter a full time." : NOT_RIGHT;
  if (v.rangeUnderflow) return dated ? `Pick ${readLimit(control, (control as HTMLInputElement).min)} or later.` : `Enter ${readLimit(control, (control as HTMLInputElement).min)} or more.`;
  if (v.rangeOverflow) return dated ? `Pick ${readLimit(control, (control as HTMLInputElement).max)} or earlier.` : `Enter ${readLimit(control, (control as HTMLInputElement).max)} or less.`;
  if (v.stepMismatch) {
    const step = control.getAttribute("step") ?? "1";
    if (Number(step) === 1) return "Use whole numbers.";
    const places = /^0\.0*1$/.test(step) ? step.length - 2 : 0;
    return places ? `Use up to ${places} decimal ${places === 1 ? "place" : "places"}.` : `Use steps of ${step}.`;
  }
  if (v.tooShort) return `Use at least ${(control as HTMLInputElement).minLength} characters.`;
  if (v.tooLong) return `Use ${(control as HTMLInputElement).maxLength} characters or fewer.`;
  if (v.patternMismatch) return control.title || NOT_RIGHT;
  return control.validationMessage || NOT_RIGHT;
}

/**
 * Email and phone checks the browser doesn't make: an email needs a dot after its @, and a phone
 * number its area code ("+…" numbers are left alone). Never replaces a message the form set itself.
 */
function checkContact(control: Checkable) {
  if (!(control instanceof HTMLInputElement) || (control.type !== "email" && control.type !== "tel")) return;
  const mine = control.dataset.fieldCustom === "1";
  if (control.validity.customError && !mine) return;
  const value = control.value.trim();
  const digits = phoneDigits(value).length;
  const message =
    control.type === "email"
      ? value.includes("@") && /@[^.]*$/.test(value) ? "Add the rest of the email, like name@company.com." : ""
      : !value.startsWith("+") && ((digits >= 1 && digits <= 9) || digits > 15) ? "Enter the full phone number, with area code." : "";
  if (message) {
    control.setCustomValidity(message);
    control.dataset.fieldCustom = "1";
  } else if (mine) {
    control.setCustomValidity("");
    delete control.dataset.fieldCustom;
  }
}

/** Sets aria-invalid on a control that doesn't manage its own, and takes back only what it set. */
function markInvalid(control: HTMLElement, invalid: boolean) {
  if (invalid) {
    if (!control.hasAttribute("aria-invalid")) {
      control.setAttribute("aria-invalid", "true");
      control.dataset.fieldInvalid = "1";
    }
  } else if (control.dataset.fieldInvalid) {
    control.removeAttribute("aria-invalid");
    delete control.dataset.fieldInvalid;
  }
}

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const focusing = new WeakSet<HTMLFormElement>();

/**
 * After a submit attempt, the first control in the form that needs a look gets focus, in the middle
 * of the screen. Once every field has heard its invalid event, so the order is the form's.
 */
function focusFirstInvalid(control: Checkable) {
  const form = control.form;
  if (!form || focusing.has(form)) return;
  focusing.add(form);
  setTimeout(() => {
    focusing.delete(form);
    const first = Array.from(form.elements).find((el): el is Checkable => isCheckable(el) && el.willValidate && !el.validity.valid);
    // Outside a Field the browser shows its own message on it, and has focused it already.
    if (!first?.closest(".field") || document.activeElement === first) return;
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
  });
}

const labelText = (label: HTMLElement | null) => (label?.textContent ?? "").replace(/\s*\(optional\)\s*$/, "").replace(/[\s:*]+$/, "").trim();

/**
 * A labelled form field. The label is tied to the field's first text control by id rather than by
 * wrapping, so buttons inside the field (tag chips, pickers, show-password) never steal label clicks.
 * A set of radio buttons in it becomes a radio group named by the label, so each choice is heard
 * with the question it answers.
 *
 * It also checks what's typed, in place of the browser's bubble: a sentence under the field from the
 * control's own rules (required, type="email", min, maxLength…), shown once the person leaves a field
 * they typed in, or tries to submit, and cleared the moment it's fixed. A fixed field, and an email or
 * phone number that checks out, gets a small check by its label. The error prop always wins.
 */
export function Field({ label, hint, error, optional, requiredMessage, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; optional?: boolean; requiredMessage?: string; children: ReactNode; className?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const labelId = `${id}-label`;
  const noteId = `${id}-note`;
  const [problem, setProblem] = useState<{ control: Checkable; message: string } | null>(null);
  const [fine, setFine] = useState<Checkable | null>(null);
  const live = useRef({ problem, requiredMessage, typed: new WeakSet<Element>(), wrong: new WeakSet<Element>() });
  live.current.problem = problem;
  live.current.requiredMessage = requiredMessage;
  const note = error || problem?.message;
  const hasNote = Boolean(note || hint);

  const messageFor = (control: Checkable) => validityMessage(control, labelText(labelRef.current), live.current.requiredMessage);

  // Timing like :user-invalid: on leaving a field after typing in it, and on a submit attempt.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const state = live.current;
    const ours = (target: EventTarget | null): target is Checkable => isCheckable(target) && target.closest(".field") === root;
    const wrongNow = (control: Checkable, message: string) => {
      state.wrong.add(control);
      setFine((c) => (c === control ? null : c));
      setProblem({ control, message });
    };
    const onInvalid = (e: Event) => {
      if (!ours(e.target)) return;
      e.preventDefault();
      state.typed.add(e.target);
      wrongNow(e.target, messageFor(e.target) ?? NOT_RIGHT);
      focusFirstInvalid(e.target);
    };
    const onInput = (e: Event) => {
      if (!ours(e.target)) return;
      const control = e.target;
      state.typed.add(control);
      checkContact(control);
      const message = messageFor(control);
      if (!message && hasValue(control) && state.wrong.has(control)) setFine(control);
      else if (message || !hasValue(control)) setFine((c) => (c === control ? null : c));
      // Once a message shows it follows every keystroke, here or in a radio next to it.
      const shown = state.problem;
      if (!shown) return;
      const now = shown.control === control ? message : messageFor(shown.control);
      if (!now) setProblem(null);
      else if (now !== shown.message) setProblem({ control: shown.control, message: now });
    };
    const onLeave = (e: Event) => {
      if (!ours(e.target) || !state.typed.has(e.target)) return;
      const control = e.target;
      checkContact(control);
      const message = messageFor(control);
      if (message) {
        wrongNow(control, message);
        return;
      }
      if (state.problem?.control === control) setProblem(null);
      if (hasValue(control) && (state.wrong.has(control) || isContact(control))) setFine(control);
    };
    root.addEventListener("invalid", onInvalid, true);
    root.addEventListener("input", onInput);
    root.addEventListener("focusout", onLeave);
    return () => {
      root.removeEventListener("invalid", onInvalid, true);
      root.removeEventListener("input", onInput);
      root.removeEventListener("focusout", onLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const radio = root.querySelector<HTMLInputElement>('input[type="radio"]');
    const group = radio ? (radio.closest("label")?.parentElement ?? radio.parentElement) : null;
    if (group && root.contains(group) && group !== root && (!group.hasAttribute("aria-labelledby") || group.dataset.fieldLabel)) {
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-labelledby", labelId);
      group.dataset.fieldLabel = "1";
    }

    // A value the form set itself (a reset, a picked suggestion) is checked again, since no input event says so.
    root.querySelectorAll<HTMLInputElement>("input[data-field-custom]").forEach(checkContact);
    if (problem) {
      const message = problem.control.isConnected ? messageFor(problem.control) : null;
      if (!message) {
        setProblem(null);
        if (problem.control.isConnected && hasValue(problem.control)) setFine(problem.control);
      } else if (message !== problem.message) setProblem({ ...problem, message });
    }
    if (fine && (!fine.isConnected || !fine.validity.valid || !hasValue(fine))) setFine(null);

    const control = root.querySelector<HTMLElement>(CONTROL);
    const invalid = new Set<HTMLElement>();
    if (error && control) invalid.add(control);
    if (problem && !error) invalid.add(problem.control);
    root.querySelectorAll<HTMLElement>("[data-field-invalid]").forEach((el) => !invalid.has(el) && markInvalid(el, false));
    invalid.forEach((el) => markInvalid(el, true));
    if (!control) return;
    if (!control.hasAttribute("aria-label") && (!control.hasAttribute("aria-labelledby") || control.dataset.fieldLabel)) {
      control.setAttribute("aria-labelledby", labelId);
      control.dataset.fieldLabel = "1";
    }
    const described = new Set<HTMLElement>(hasNote ? [control, problem?.control ?? control] : []);
    root.querySelectorAll<HTMLElement>(`[aria-describedby="${noteId}"]`).forEach((el) => !described.has(el) && el.removeAttribute("aria-describedby"));
    described.forEach((el) => el.setAttribute("aria-describedby", noteId));
  });

  return (
    <div ref={ref} className={className ? `field ${className}` : "field"}>
      <span
        id={labelId}
        ref={labelRef}
        className="field-label"
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button, a")) return;
          ref.current?.querySelector<HTMLElement>(CONTROL)?.focus();
        }}
      >
        {label}
        {optional && <span className="optional"> (optional)</span>}
        {fine && !note && <span className="field-ok"><Icon name="check" size={14} strokeWidth={2} /></span>}
      </span>
      {children}
      {note ? <span id={noteId} className="field-error" role="alert">{note}</span> : hint && <span id={noteId} className="hint">{hint}</span>}
    </div>
  );
}

/**
 * "2 fields need a look" beside a form's buttons, from a submit attempt until they're fixed:
 * <div className="form-actions"><FormChecks /><Button type="submit" variant="primary">Save</Button></div>.
 */
export function FormChecks() {
  const ref = useRef<HTMLSpanElement>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    let watching = false;
    let frame = 0;
    // A frame later, so each Field has had its say about the value first.
    const recount = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const needs = new Set<string | Element>();
        for (const el of Array.from(form.elements)) {
          if (!isCheckable(el) || !el.willValidate || el.validity.valid) continue;
          needs.add(el instanceof HTMLInputElement && el.type === "radio" && el.name ? `radio:${el.name}` : el);
        }
        if (!needs.size) watching = false;
        setCount(needs.size);
      });
    };
    const onInvalid = () => {
      watching = true;
      recount();
    };
    const onInput = () => watching && recount();
    const onDone = () => {
      watching = false;
      cancelAnimationFrame(frame);
      setCount(0);
    };
    form.addEventListener("invalid", onInvalid, true);
    form.addEventListener("input", onInput, true);
    form.addEventListener("change", onInput, true);
    form.addEventListener("submit", onDone);
    form.addEventListener("reset", onDone);
    return () => {
      cancelAnimationFrame(frame);
      form.removeEventListener("invalid", onInvalid, true);
      form.removeEventListener("input", onInput, true);
      form.removeEventListener("change", onInput, true);
      form.removeEventListener("submit", onDone);
      form.removeEventListener("reset", onDone);
    };
  }, []);
  return (
    <span ref={ref} className="form-checks" role="status" hidden={!count}>
      {count > 0 && (
        <>
          <Icon name="alert" size={14} />
          {count === 1 ? "1 field needs a look" : `${count} fields need a look`}
        </>
      )}
    </span>
  );
}

/**
 * Error banner at the bottom of a form. With `fields`, an error that belongs to one of those fields
 * (an ApiError's field, shown there with fieldError) is left to the field.
 */
export function FormError({ error, fields }: { error: unknown; fields?: string[] }) {
  if (!error) return null;
  if (fields && error instanceof ApiError && error.field && fields.includes(error.field)) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="form-error" role="alert">{message}</div>;
}
