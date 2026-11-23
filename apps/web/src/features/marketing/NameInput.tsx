/**
 * A draft campaign's or postcard's name, typed over in the page title. A one-line box that grows to
 * a second line as a long name does (the quote title's way), so a phone shows all of it rather than
 * cutting it at the edge. Enter ends the edit instead of starting a new line, and pasted line breaks
 * become spaces: a name is one line.
 */
import { useEffect, useRef } from "react";
import { cx } from "@/components/ui/Button";
import styles from "./Marketing.module.css";

export function NameInput({ value, onChange, label, maxLength = 120 }: { value: string; onChange: (name: string) => void; label: string; maxLength?: number }) {
  const box = useRef<HTMLTextAreaElement>(null);
  // As tall as its words, at any width: measured again as they or the page's width change.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el.parentElement ?? el);
    return () => watch.disconnect();
  }, [value]);
  return (
    <textarea
      ref={box}
      className={cx("title-input", styles.nameBox)}
      aria-label={label}
      rows={1}
      value={value}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
    />
  );
}
