/**
 * The Imagery button on the measuring map, like a model picker: Auto at the top (the sharpest free
 * imagery for wherever the map is), then sources to choose yourself, then what lies on top (slope,
 * contours, street names, house numbers). A state's sharper imagery is listed when the map is over that state;
 * Esri and Google say how to turn them on when there's no key. What Measure opens on is marked
 * Default, and whatever's picked can become this person's default.
 */
import { STATE_IMAGERY, stateImageryAt, type MapKeys } from "@crewtavo/core/imagery";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "@/components/ui/Icon";
import { useSession } from "@/lib/session";
import {
  AUTO_NAME, choiceName, DEFAULT_CHOICES, imageryInfo, imageryUsable, mapKeys, myDefault, OVERLAYS, setMyDefault, stateId, teamDefault,
  type ImageryChoice, type ImageryId, type OverlayId,
} from "./imagery";

export function ImageryPicker({
  choice, opening, showing, center, keys, isAdmin, streetMap, streetNames, houseNumbers, overlays, onPick, onMakeDefault, onStreetNames, onHouseNumbers, onOverlay,
}: {
  choice: ImageryChoice;
  /** What Measure opens on for this person (their default, the team's, or Auto). */
  opening: ImageryChoice;
  /** What's on the map now (what Auto picked, when it's Auto). */
  showing: ImageryId | null;
  center: { lng: number; lat: number } | null;
  keys: MapKeys;
  isAdmin: boolean;
  /** The street map loaded (it's an outside service, so it may not have). */
  streetMap: boolean;
  streetNames: boolean;
  houseNumbers: boolean;
  overlays: OverlayId[];
  onPick: (next: ImageryChoice) => void;
  onMakeDefault: (choice: ImageryChoice) => void;
  onStreetNames: (show: boolean) => void;
  onHouseNumbers: (show: boolean) => void;
  onOverlay: (id: OverlayId, on: boolean) => void;
}) {
  const id = useId();
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const here = center ? stateImageryAt(center.lng, center.lat) : [];
  const now = showing ? imageryInfo(showing) : null;
  const close = () => {
    pop.current?.hidePopover();
    button.current?.focus();
  };
  const pick = (next: ImageryChoice) => {
    close();
    onPick(next);
  };
  const place = () => {
    const b = button.current!.getBoundingClientRect();
    const p = pop.current!;
    const width = Math.min(360, window.innerWidth - 16);
    p.style.width = `${width}px`;
    p.style.left = `${Math.max(8, Math.min(b.right - width, window.innerWidth - width - 8))}px`;
    p.style.top = `${b.bottom + 6}px`;
  };

  const row = (value: ImageryChoice, name: ReactNode, detail: ReactNode, note?: ReactNode) => {
    const selected = value === choice;
    return (
      <div key={value}>
        <button type="button" role="menuitemradio" aria-checked={selected} className="imagery-option" disabled={Boolean(note)} onClick={() => pick(value)}>
          <span className="imagery-check" aria-hidden="true">{selected && <Icon name="check" size={15} />}</span>
          <span className="grow">
            <strong>{name}{value === opening && <span className="chip imagery-chip">Default</span>}</strong>
            <span className="muted small">{detail}</span>
          </span>
        </button>
        {note && <p className="small imagery-note">{note}</p>}
      </div>
    );
  };
  const source = (value: ImageryId, note?: ReactNode) => {
    const info = imageryInfo(value);
    return row(value, info.name, info.detail, note);
  };
  const needsKey = (provider: "Esri" | "Google") =>
    isAdmin ? (
      <>Add a key in <Link to="/settings?tab=maps" target="_blank" rel="noreferrer">Settings › Maps</Link> (opens a new tab, so your drawing stays).</>
    ) : (
      <>Ask an admin to add a {provider} key in Settings › Maps.</>
    );
  const label = choice === "auto" ? (now ? `${AUTO_NAME} · ${now.name}` : AUTO_NAME) : now?.name ?? imageryInfo(choice).name;

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
        <span className="imagery-button-label">{label}</span>
        {overlays.length > 0 && <span className="badge">{overlays.length}</span>}
        <Icon name="chevronDown" size={14} />
      </button>
      <div ref={pop} id={id} className="menu imagery-menu" role="menu" popover="auto">
        {row(
          "auto",
          <>{AUTO_NAME} <span className="chip chip-green imagery-chip">Recommended</span></>,
          choice === "auto" && now
            ? <>Showing {now.name} here. Picks the sharpest free imagery wherever you are, and switches if a source isn't answering.</>
            : "Picks the sharpest free imagery wherever you are: your state's own, else US aerial, else USGS.",
        )}
        <div className="menu-sep" role="separator" />
        <div className="menu-label">Choose yourself</div>
        {source("naip")}
        {here.map((s) => source(stateId(s)))}
        {choice.startsWith("state:") && !here.some((s) => stateId(s) === choice) && source(choice as ImageryId)}
        {source("usgs")}
        {source("terrain")}
        {source("street", streetMap ? undefined : "The street map couldn't load. Check your connection and reload.")}
        {!here.length && (
          <p className="muted small imagery-aside">
            Sharper state imagery is listed here when the map is over one of these: {STATE_IMAGERY.map((s) => s.state).join(", ")}.
          </p>
        )}
        <div className="menu-sep" role="separator" />
        <div className="menu-label">Worldwide, with a key</div>
        {source("esri", keys.esri_key ? undefined : needsKey("Esri"))}
        {source("google", keys.google_key ? undefined : needsKey("Google"))}
        {DEFAULT_CHOICES.includes(choice) && choice !== opening && (
          <>
            <div className="menu-sep" role="separator" />
            <button type="button" role="menuitem" className="imagery-option" onClick={() => { close(); onMakeDefault(choice); }}>
              <span className="imagery-check" aria-hidden="true"><Icon name="star" size={15} /></span>
              <span className="grow">
                <strong>Open Measure on {choiceName(choice)} every time</strong>
                <span className="muted small">Just for you, on this device. Change it in Settings › Profile.</span>
              </span>
            </button>
          </>
        )}
        <div className="menu-sep" role="separator" />
        <div className="menu-label">On top</div>
        {(Object.keys(OVERLAYS) as OverlayId[]).map((o) => (
          <label key={o} className="imagery-toggle">
            <input type="checkbox" className="switch" checked={overlays.includes(o)} onChange={(e) => onOverlay(o, e.target.checked)} />
            <span className="grow"><span>{OVERLAYS[o].name}</span><span className="muted small">{OVERLAYS[o].detail}</span></span>
          </label>
        ))}
        <label className="imagery-toggle">
          <input type="checkbox" className="switch" checked={streetNames || showing === "street"} disabled={showing === "street" || !streetMap} onChange={(e) => onStreetNames(e.target.checked)} />
          <span className="grow"><span>Street names</span></span>
        </label>
        <label className="imagery-toggle">
          <input type="checkbox" className="switch" checked={houseNumbers && streetMap} disabled={!streetMap} onChange={(e) => onHouseNumbers(e.target.checked)} />
          <span className="grow"><span>House numbers</span><span className="muted small">Zoomed in close, where OpenStreetMap has them</span></span>
        </label>
      </div>
    </>
  );
}

/** Settings → Profile: what Measure opens on for this person, on this device. */
export function MeasureMapSetting() {
  const session = useSession();
  const settings = session.company.settings ?? {};
  const keys = mapKeys(settings, session.config.mapsBrowserKey);
  const team = teamDefault(settings, keys) ?? "auto";
  const [mine, setMine] = useState<ImageryChoice | "">(() => myDefault(keys) ?? "");
  return (
    <div className="card card-pad stack-sm">
      <strong id="measure-map-title">Measure map</strong>
      <select
        className="select"
        aria-labelledby="measure-map-title"
        style={{ maxWidth: 280 }}
        value={mine}
        onChange={(e) => {
          const next = e.target.value as ImageryChoice | "";
          setMine(next);
          setMyDefault(next || null);
        }}
      >
        <option value="">Team default ({choiceName(team)})</option>
        {DEFAULT_CHOICES.filter((c) => c === "auto" || imageryUsable(c, keys)).map((c) => <option key={c} value={c}>{choiceName(c)}</option>)}
      </select>
      <span className="muted small">The imagery Measure opens on. You can still switch any time from the Imagery button. Saved on this device.</span>
    </div>
  );
}
