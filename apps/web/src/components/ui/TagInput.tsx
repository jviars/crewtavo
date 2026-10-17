import { useId, useState, type KeyboardEvent } from "react";
import { Icon } from "./Icon";

/** Tags as removable chips. Enter or comma adds; Backspace on an empty field removes the last. */
export function TagInput({ value, onChange, suggestions = [], placeholder = "Add a tag", max = 20 }: { value: string[]; onChange: (tags: string[]) => void; suggestions?: string[]; placeholder?: string; max?: number }) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const add = (raw: string) => {
    const tag = raw.trim().replace(/,+$/, "").slice(0, 40);
    if (!tag || value.length >= max || value.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...value, tag]);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const remaining = suggestions.filter((s) => !value.some((v) => v.toLowerCase() === s.toLowerCase()));
  return (
    <div className="input" style={{ height: "auto", minHeight: 38, display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 8px", alignItems: "center" }} onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement)?.focus()}>
      {value.map((tag) => (
        <span key={tag} className="chip">
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}><Icon name="x" size={10} strokeWidth={3} /></button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length ? "" : placeholder}
        list={remaining.length ? listId : undefined}
        aria-label={placeholder}
        style={{ flex: "1 0 100px", border: 0, outline: "none", minWidth: 80, height: 24, background: "transparent" }}
      />
      {remaining.length > 0 && (
        <datalist id={listId}>
          {remaining.map((s) => <option key={s} value={s} />)}
        </datalist>
      )}
    </div>
  );
}
