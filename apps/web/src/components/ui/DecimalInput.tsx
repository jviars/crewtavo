/**
 * A text box for an amount, a price or a percent that reads a decimal comma as a point: "12,50" is
 * 12.50, as people write it in Canada, Europe and South Africa, while a comma before three digits is
 * still a thousands separator, as in the US ("1,250" is 1250; lib/decimal decimalPoint). It shows
 * what's typed and tells onChange the number with a point and no thousands commas, so a form keeps
 * and reads it as it always has; once it's left, it shows that. Otherwise it's an <input>.
 */
import { useState, type ChangeEventHandler, type InputHTMLAttributes } from "react";
import { decimalPoint } from "@/lib/decimal";
import { changeEvent } from "./changeEvent";

export type DecimalInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
};

/**
 * What the box shows: what was typed, while the value it was given is the one that was read from it
 * (`shown.read`); the value itself when it was set some other way (a reset, a suggestion) or the
 * form changed what it heard (left out a letter).
 */
export const shownText = (shown: { typed: string; read: string }, value: string) => (shown.read === value ? shown.typed : value);

export function DecimalInput({ value, onChange, onBlur, ...props }: DecimalInputProps) {
  const [shown, setShown] = useState({ typed: value, read: value });
  return (
    <input
      {...props}
      value={shownText(shown, value)}
      onChange={(e) => {
        const read = decimalPoint(e.target.value);
        setShown({ typed: e.target.value, read });
        onChange(changeEvent<HTMLInputElement>(read, e.target.name, e.target.id));
      }}
      onBlur={(e) => {
        // Left: the number as it was read ("1250", "12.5").
        setShown({ typed: value, read: value });
        onBlur?.(e);
      }}
    />
  );
}
