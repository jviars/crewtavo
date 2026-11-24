/**
 * A drop-in for <input type="number">, on Base UI's NumberField (MIT): the same value and onChange
 * (e.target.value is the text, "" when empty), min, max, step, required, name, placeholder and
 * aria-*. Arrow keys step it (Shift by 10, Alt by 0.1), and with a mouse there are up and down
 * buttons that keep counting while held; a finger types on the phone's number pad instead.
 *
 * Like a native number box, it doesn't round or clamp what's typed: a form's checks (Field.tsx) say
 * "Enter 365 or less." or "Use whole numbers." on submit, from its hidden number input. Only the
 * arrows and buttons keep within min and max. className and style go on the box; the rest on the
 * text field in it.
 *
 * A decimal comma is read as a point ("2,5" is 2.5) and a comma before three digits as a thousands
 * separator ("1,250" is 1250), as lib/decimal decimalPoint reads them: onChange hears the number
 * that way, and the box shows it so once it's left. Base UI's own reading, in US English, would
 * take "2,5" for 2.
 */
import { NumberField } from "@base-ui/react/number-field";
import { useRef, type ChangeEventHandler, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { decimalPoint } from "@/lib/decimal";
import { t } from "@/lib/i18n";
import { changeEvent } from "./changeEvent";
import { useFieldOnTrigger } from "./fieldLink";
import { Icon } from "./Icon";
import "./pickers.css";

export type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "defaultValue" | "onChange" | "min" | "max" | "step"> & {
  value?: string | number | null;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  /** The up and down buttons (for a mouse). On unless a box is too narrow for them, like a price in a table. */
  steppers?: boolean;
  /** Decimal places it shows once left, for a box that keeps its own rounding (MoneyInput). Unset: up to 3, as typed. */
  decimals?: number;
};

/** A number from a prop or what's typed: null for "", for text that isn't a number, and for none. */
export function readNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The keyboard a phone shows: one with a decimal point unless only whole numbers are taken (a step
 * of 1, or none). Android's plain number pad has no point to type 0.5 with.
 */
export function numberKeyboard(step: number | string | undefined): "numeric" | "decimal" {
  if (step === undefined || step === "") return "numeric";
  if (step === "any") return "decimal";
  const n = Number(step);
  return Number.isInteger(n) ? "numeric" : "decimal";
}

/**
 * What onChange hears as a number is typed or pasted in: the text as typed ("2.", "0.50", like a
 * native number box's value while typing), with a decimal comma read as a point (decimalPoint), so
 * "2,5" is "2.5" and "1,250" is "1250"; the number itself for the arrows and buttons. `details` is
 * Base UI's: a paste's text is the box's with the pasted words where they go, as Base UI puts them,
 * and the number Base UI read when that isn't a number on its own ("12 ft").
 */
export function heardText(next: number | null, details: { reason: string; event: Event }): string {
  const box = details.event.target as HTMLInputElement | null;
  if (details.reason === "input-change" && box) return decimalPoint(box.value);
  if (details.reason === "input-paste" && box) {
    const pasted = (details.event as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
    const from = box.selectionStart ?? box.value.length;
    const to = box.selectionEnd ?? from;
    const text = decimalPoint(box.value.slice(0, from) + pasted + box.value.slice(to)).trim();
    if (text !== "" && Number.isFinite(Number(text))) return text;
  }
  return next === null ? "" : String(next);
}

export function NumberInput({ value, onChange, min, max, step, steppers = true, decimals, className, style, id, name, required, disabled, readOnly, inputMode, ...inputProps }: NumberInputProps) {
  const emit = (text: string) => onChange?.(changeEvent<HTMLInputElement>(text, name, id));
  const shown = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  // A Field checks the hidden number input, which has the min, max and step, and words its sentence
  // ("Enter 365 or less."); it hears what happens in the box people type in through it, and the box
  // takes the red edge it's given (the label it gets itself, as the first control in the Field).
  useFieldOnTrigger(shown, hidden, { label: true, described: true, invalid: "aria-invalid" in inputProps });
  const tellField = (type: "input" | "focusout") =>
    setTimeout(() => hidden.current?.dispatchEvent(type === "input" ? new Event("input", { bubbles: true }) : new FocusEvent("focusout", { bubbles: true })));
  const box = ["input", "number-field", ...(className ?? "").split(/\s+/).filter((c) => c && c !== "input")].join(" ");
  return (
    <NumberField.Root
      value={readNumber(value)}
      onValueChange={(next, details) => {
        // Leaving the box only tidies how the number is written, and a box that saves as it's left
        // (MoneyInput) has already decided what to keep, so that's never passed on.
        if (details.event.type === "focusout" || details.event.type === "blur") return;
        tellField("input");
        // What was typed, as typed ("2.", "0.50"), with a decimal comma read as a point. The box keeps
        // showing it as typed; once it's left, it shows this, the value it's given back.
        emit(heardText(next, details));
      }}
      min={readNumber(min) ?? undefined}
      max={readNumber(max) ?? undefined}
      step={step === "any" ? "any" : (readNumber(step) ?? undefined)}
      // Typing isn't clamped, so a wrong number is said rather than quietly changed; the buttons still clamp.
      allowOutOfRange
      // The app writes numbers in US English: 1.5, and no thousands commas in a box.
      locale="en-US"
      format={decimals === undefined ? { useGrouping: false } : { useGrouping: false, maximumFractionDigits: decimals }}
      id={id}
      name={name}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
      className={box}
      style={style}
      inputRef={hidden}
    >
      <NumberField.Input
        ref={shown}
        className="number-field-input"
        inputMode={inputMode ?? numberKeyboard(step)}
        {...inputProps}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement> & { preventBaseUIHandler?: () => void }) => {
          // Home and End move the caret, as in any text box. Base UI would set the box to its min or
          // max instead, and a box that saves as it's left (MoneyInput) would then save 0.
          if ((e.key === "Home" || e.key === "End") && !e.ctrlKey && !e.metaKey) e.preventBaseUIHandler?.();
          inputProps.onKeyDown?.(e);
        }}
        onBlur={(e) => {
          inputProps.onBlur?.(e);
          tellField("focusout");
        }}
      />
      {steppers && !readOnly && (
        <span className="number-field-steps">
          <NumberField.Increment className="number-field-step" aria-label={t("Increase")}>
            <Icon name="chevronUp" size={12} bold />
          </NumberField.Increment>
          <NumberField.Decrement className="number-field-step" aria-label={t("Decrease")}>
            <Icon name="chevronDown" size={12} bold />
          </NumberField.Decrement>
        </span>
      )}
    </NumberField.Root>
  );
}
