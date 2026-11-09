/**
 * The address box on the measuring map, and the Address field of a calendar entry (VisitDialog). As
 * someone types it suggests the company's own clients' properties first, then places near the map
 * or the shop (OpenStreetMap, through GET /api/places/suggest). Enter on a suggestion picks it. On
 * the map, Enter with none picked looks the whole address up exactly (the Census geocoder for US
 * addresses), which finds the rural house numbers OpenStreetMap lacks; in a form it's just a field.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { api } from "@/lib/api";

export interface ClientSuggestion { property_id: string; client_id: string | null; client: string | null; label: string; detail: string | null; lat: number | null; lng: number | null }
export interface PlaceSuggestion { label: string; detail: string | null; lat: number; lng: number; country: string | null; kind: "address" | "street" | "place" }
interface Suggestions { clients: ClientSuggestion[]; places: PlaceSuggestion[]; places_unavailable?: boolean }

type Item = { key: string; group: string; icon: IconName; title: string; sub: string | null; pick: () => void };

export function AddressSearch({
  disabled, busy, near, onSubmit, onPickClient, onPickPlace, onEdit, initial = "", placeholder = "Search a client or an address, US or worldwide", label = "Search a client or an address",
}: {
  disabled: boolean;
  /** An exact lookup is running. */
  busy?: boolean;
  /** Where the map (or the shop) is, so nearby places come first. */
  near: { lat: number; lng: number } | null;
  /** Its own search form: Enter looks the typed address up. Without it, it's a field in the surrounding form. */
  onSubmit?: (text: string) => void;
  onPickClient?: (s: ClientSuggestion) => void;
  onPickPlace?: (s: PlaceSuggestion) => void;
  /** The text in the box, as typed or picked. */
  onEdit: (text: string) => void;
  initial?: string;
  placeholder?: string;
  /** Leave out inside a Field, which labels it. */
  label?: string | null;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(initial);
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);

  // Ask once typing pauses, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const area = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "";
  const suggest = useQuery({
    queryKey: ["place-suggest", term.toLowerCase(), area],
    queryFn: () => api.get<Suggestions>(`/places/suggest?${new URLSearchParams({ q: term, ...(near ? { lat: String(near.lat), lng: String(near.lng) } : {}) })}`),
    enabled: open && term.length >= 3,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });

  const close = () => {
    setOpen(false);
    setIndex(-1);
  };
  const choose = (pick: () => void, label: string) => {
    setText(label);
    close();
    onEdit(label);
    pick();
  };
  const data = term.length >= 3 ? suggest.data : undefined;
  const items: Item[] = [
    ...(data?.clients ?? []).map((s) => ({
      key: `c-${s.property_id}`,
      group: "Your clients",
      icon: "user" as IconName,
      title: s.label,
      sub: [s.client, s.detail].filter(Boolean).join(" · ") || null,
      pick: () => choose(() => onPickClient?.(s), [s.label, s.detail].filter(Boolean).join(", ")),
    })),
    ...(data?.places ?? []).map((s, i) => ({
      key: `p-${i}-${s.label}`,
      group: "Places",
      icon: (s.kind === "place" ? "map" : "pin") as IconName,
      title: s.label,
      sub: s.detail,
      pick: () => choose(() => onPickPlace?.(s), [s.label, s.detail].filter(Boolean).join(", ")),
    })),
  ];
  const showList = open && text.trim().length >= 3;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      setOpen(true);
      setIndex((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      setIndex((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && !onSubmit && index >= 0 && items[index]) {
      // In a form, Enter on a suggestion picks it instead of sending the form.
      e.preventDefault();
      items[index].pick();
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (index >= 0 && items[index]) return items[index].pick();
    const address = text.trim();
    if (address.length < 5) return;
    close();
    onSubmit?.(address);
  };

  // Clicking anywhere else closes the list.
  useEffect(() => {
    if (!showList) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [showList]);

  const enter = onSubmit ? " Press Enter to look up the full address." : "";
  let lastGroup = "";
  const field = (
    <div className="input-group address-search" ref={box}>
      <span className="addon">{busy || (suggest.isFetching && showList) ? <span className="spinner" style={{ width: 14, height: 14 }} /> : <Icon name="search" size={14} />}</span>
      <input
        name="address"
        className="input"
        placeholder={placeholder}
        aria-label={label ?? undefined}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={`${id}-list`}
        aria-activedescendant={index >= 0 && items[index] ? `${id}-${index}` : undefined}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint={onSubmit ? "search" : undefined}
        disabled={disabled}
        value={text}
        onFocus={() => setOpen(true)}
        maxLength={300}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setIndex(-1);
          onEdit(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <div className="address-suggest" id={`${id}-list`} role="listbox" aria-label="Suggestions">
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? <div className="palette-group" role="presentation">{item.group}</div> : null;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {header}
                <button
                  type="button"
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className="palette-item"
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={item.pick}
                >
                  <span className="p-icon"><Icon name={item.icon} size={14} /></span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span className="p-title ellipsis" style={{ display: "block" }}>{item.title}</span>
                    {item.sub && <span className="p-sub ellipsis" style={{ display: "block" }}>{item.sub}</span>}
                  </span>
                </button>
              </div>
            );
          })}
          <div className="address-suggest-foot muted small">
            {term.length < 3 || (suggest.isFetching && !items.length)
              ? "Looking…"
              : suggest.isError
                ? `Suggestions aren't available right now.${enter}`
                : !items.length
                  ? onSubmit ? "No suggestions yet. Type the full address and press Enter to look it up exactly." : "No suggestions yet. Type the full address."
                  : data?.places_unavailable
                    ? `Place suggestions aren't available right now.${enter}`
                    : onSubmit ? "Not listed? Type the full address and press Enter." : "Not listed? Type the full address."}
          </div>
        </div>
      )}
    </div>
  );
  return onSubmit ? <form className="measure-find" onSubmit={submit} role="search">{field}</form> : field;
}
