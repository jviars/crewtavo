/**
 * The parts every Settings section is built from (Page-Settings.dc.html), so each one reads the same:
 *
 * - SettingsActions: a section's one main action ("Invite someone", "New role"), drawn beside its
 *   title on a desktop and as the floating green pill on a phone. SettingsPage holds the place.
 * - SwitchRow: a switch with its words and a quiet line under them.
 * - SaveBar: the button that saves a form, on a hairline under it, with what's waiting to be saved;
 *   pinned over the tab bar on a phone.
 * - Suffix: a field with its unit inside it ("days", "%").
 *
 * The groups of a section are <Section level={3}> (components/ui/Section), with their fields in a
 * .set-grid (two across, .set-full for a whole row). The look is in features.css under "Settings".
 */
import { createContext, useContext, useId, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui/Button";
import { SHEET_QUERY } from "@/components/ui/menuModel";

/** Where a section's main action goes: the header's actions, once SettingsPage has drawn them. */
export const SettingsActionsSlot = createContext<{ el: HTMLElement | null } | null>(null);

/** A section's main action, in the page header (outside Settings, where it was put). */
export function SettingsActions({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsActionsSlot);
  if (!slot) return <div className="set-actions">{children}</div>;
  return slot.el ? createPortal(children, slot.el) : null;
}

const subscribe = (change: () => void) => {
  const query = window.matchMedia?.(SHEET_QUERY);
  query?.addEventListener("change", change);
  return () => query?.removeEventListener("change", change);
};

/** A phone's layout (900px or narrower, as the shell's): Settings is a list there, each section a screen of its own. */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, () => Boolean(window.matchMedia?.(SHEET_QUERY).matches), () => false);
}

/**
 * A switch and what it does: its words in ink, a quiet line under them. The switch is the words'
 * control (they're its label); the quiet line describes it. `children` go under, for what the
 * switch brings with it (a field that only matters while it's on).
 */
export function SwitchRow({ label, hint, checked, onChange, disabled, end, children, className }: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  /** On the right: a quiet link ("Edit the message"). */
  end?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cx("set-row", className)}>
      <input id={id} type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <div className="set-row-text">
        <label htmlFor={id} className="set-row-label">{label}</label>
        {hint && <span id={`${id}-hint`} className="set-row-hint">{hint}</span>}
        {children}
      </div>
      {end && <div className="set-row-end">{end}</div>}
    </div>
  );
}

/** Under a form: its one save button, and a quiet word on what's waiting ("2 unsaved changes"). */
export function SaveBar({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="set-save">
      {children}
      {note && <span className="set-save-note" aria-live="polite">{note}</span>}
    </div>
  );
}

/** A field's unit inside it, on the right: <Suffix unit="days"><input …/></Suffix>. */
export function Suffix({ unit, children }: { unit: string; children: ReactNode }) {
  return (
    <span className="set-suffix">
      {children}
      <span aria-hidden="true">{unit}</span>
    </span>
  );
}

/** How many of a form's values differ from what was loaded: "2 unsaved changes". */
export function unsavedCount<T extends object>(now: T | null, loaded: T | null): number {
  if (!now || !loaded) return 0;
  return (Object.keys(now) as Array<keyof T>).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(loaded[k])).length;
}
