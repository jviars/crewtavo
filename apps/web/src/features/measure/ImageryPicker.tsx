/**
 * The Imagery button on the measuring map: what's under the drawing now, and what else there is.
 * Free choices first; a state's sharper imagery shows when the map is over that state; Esri and
 * Google say how to turn them on when there's no key.
 */
import { STATE_IMAGERY, stateImageryAt, type MapKeys } from "@crewtavo/core/imagery";
import { useId, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { imageryInfo, stateId, type ImageryId } from "./imagery";

export function ImageryPicker({
  value, center, keys, isAdmin, streetMap, streetNames, onPick, onStreetNames,
}: {
  value: ImageryId;
  center: { lng: number; lat: number } | null;
  keys: MapKeys;
  isAdmin: boolean;
  /** The street map loaded (it's an outside service, so it may not have). */
  streetMap: boolean;
  streetNames: boolean;
  onPick: (id: ImageryId) => void;
  onStreetNames: (show: boolean) => void;
}) {
  const id = useId();
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const here = center ? stateImageryAt(center.lng, center.lat) : [];
  const current = imageryInfo(value);
  const pick = (next: ImageryId) => {
    pop.current?.hidePopover();
    button.current?.focus();
    onPick(next);
  };
  const place = () => {
    const b = button.current!.getBoundingClientRect();
    const p = pop.current!;
    const width = Math.min(340, window.innerWidth - 16);
    p.style.width = `${width}px`;
    p.style.left = `${Math.max(8, Math.min(b.right - width, window.innerWidth - width - 8))}px`;
    p.style.top = `${b.bottom + 6}px`;
  };

  const option = (choice: ImageryId, opts: { disabledNote?: ReactNode } = {}) => {
    const info = imageryInfo(choice);
    const selected = choice === value;
    return (
      <div key={choice}>
        <button type="button" role="menuitemradio" aria-checked={selected} className="imagery-option" disabled={Boolean(opts.disabledNote)} onClick={() => pick(choice)}>
          <span className="imagery-check" aria-hidden="true">{selected && <Icon name="check" size={15} />}</span>
          <span className="grow">
            <strong>{info.name}</strong>
            <span className="muted small">{info.detail}</span>
          </span>
        </button>
        {opts.disabledNote && <p className="small imagery-note">{opts.disabledNote}</p>}
      </div>
    );
  };
  const needsKey = (provider: "Esri" | "Google") =>
    isAdmin ? (
      <>Add a key in <Link to="/settings?tab=maps" target="_blank" rel="noreferrer">Settings › Maps</Link> (opens a new tab, so your drawing stays).</>
    ) : (
      <>Ask an admin to add a {provider} key in Settings › Maps.</>
    );

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn btn-sm imagery-button"
        aria-haspopup="menu"
        popovertarget={id}
        title="Change the imagery under the map"
        onClick={() => requestAnimationFrame(place)}
      >
        <Icon name="layers" size={15} />
        <span className="imagery-button-label">{current.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      <div ref={pop} id={id} className="menu imagery-menu" role="menu" popover="auto">
        <div className="menu-label">Free</div>
        {option("naip")}
        {here.map((s) => option(stateId(s)))}
        {value.startsWith("state:") && !here.some((s) => stateId(s) === value) && option(value)}
        {option("street", { disabledNote: streetMap ? undefined : "The street map couldn't load. Check your connection and reload." })}
        {!here.length && (
          <p className="muted small imagery-aside">
            Sharper free imagery shows up here when the map is over one of these: {STATE_IMAGERY.map((s) => s.state).join(", ")}.
          </p>
        )}
        <div className="menu-sep" role="separator" />
        <div className="menu-label">Worldwide, with a key</div>
        {option("esri", { disabledNote: keys.esri_key ? undefined : needsKey("Esri") })}
        {option("google", { disabledNote: keys.google_key ? undefined : needsKey("Google") })}
        <div className="menu-sep" role="separator" />
        <label className="imagery-toggle">
          <input type="checkbox" className="switch" checked={streetNames || value === "street"} disabled={value === "street" || !streetMap} onChange={(e) => onStreetNames(e.target.checked)} />
          Street names on the imagery
        </label>
      </div>
    </>
  );
}
