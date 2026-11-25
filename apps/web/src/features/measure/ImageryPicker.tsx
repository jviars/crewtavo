/**
 * The Imagery button on the measuring map, like a model picker: Auto at the top (Google satellite
 * with the company's own key, else the sharpest free imagery for wherever the map is), then sources
 * to choose yourself, then what lies on top (slope, contours, street names, house numbers) in a sub
 * menu. A state's sharper imagery is listed when the map is over that state; Esri and Google say how
 * to turn them on when there's no key. What Measure opens on is marked Default, and whatever's picked
 * can become this person's default. It's the app's Menu, so a phone gets it as a bottom sheet; on a
 * phone's full-screen map it's a sub menu of the map's ⋯ menu instead of a button (imageryMenu).
 */
import { STATE_IMAGERY, stateImageryAt } from "@crewtavo/core/imagery";
import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { useSession } from "@/lib/session";
import {
  AUTO_NAME, choiceName, DEFAULT_CHOICES, googleFirst, imageryInfo, imageryUsable, mapKeys, myDefault, OVERLAYS, setMyDefault, stateId, teamDefault,
  type ImageryChoice, type ImageryId, type OverlayId, type UsableKeys,
} from "./imagery";
import { Select } from "@/components/ui/Select";

export interface ImageryPickerProps {
  choice: ImageryChoice;
  /** What Measure opens on for this person (their default, the team's, or Auto). */
  opening: ImageryChoice;
  /** What's on the map now (what Auto picked, when it's Auto). */
  showing: ImageryId | null;
  center: { lng: number; lat: number } | null;
  keys: UsableKeys;
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
}

/** The imagery choices as menu entries, with the name of what's showing and a note for the menu's foot. */
export function imageryMenu({
  choice, opening, showing, center, keys, isAdmin, streetMap, streetNames, houseNumbers, overlays, onPick, onMakeDefault, onStreetNames, onHouseNumbers, onOverlay,
}: ImageryPickerProps): { items: MenuEntry[]; label: string; note: string | null } {
  const here = center ? stateImageryAt(center.lng, center.lat) : [];
  const now = showing ? imageryInfo(showing) : null;
  const tags = (value: ImageryChoice) => (value === opening ? "Default" : undefined);

  const source = (value: ImageryId): MenuEntry => {
    const info = imageryInfo(value);
    if (info.needs && !(info.needs === "esri" ? keys.esri_key : keys.google_key)) {
      const provider = info.needs === "esri" ? "Esri" : "Google";
      // No key yet: an admin goes to add one (in a new tab, so the drawing stays); anyone else is told who can.
      return isAdmin
        ? { label: info.name, icon: "external", description: `${info.detail}. Opens Settings › Maps in a new tab, so your drawing stays.`, end: "Set up", onSelect: () => window.open("/settings?tab=maps", "_blank", "noopener") }
        : { label: info.name, description: `Ask an admin to add a ${provider} key in Settings › Maps.`, disabled: true, onSelect: () => {} };
    }
    if (value === "street" && !streetMap) return { label: info.name, description: "The street map couldn't load. Check your connection and reload.", disabled: true, onSelect: () => {} };
    return { label: info.name, description: info.detail, end: tags(value), checked: value === choice, onSelect: () => onPick(value) };
  };

  const keyed = choice === "esri" || choice === "google";
  const items: MenuEntry[] = [
    {
      label: AUTO_NAME,
      description:
        choice === "auto" && now
          ? `Showing ${now.name} here. ${googleFirst(keys) ? "Google satellite first, with your team's key" : "The sharpest free imagery wherever you are"}, and it switches if a source isn't answering.`
          : googleFirst(keys)
            ? "Google satellite, since your team added a Google key, else the sharpest free imagery wherever you are."
            : "Picks the sharpest free imagery wherever you are: your state's own, else US aerial, else USGS.",
      end: opening === "auto" ? "Default" : "Recommended",
      checked: choice === "auto",
      onSelect: () => onPick("auto"),
    },
    { separator: true },
    { heading: "Choose yourself" },
    source("naip"),
    ...here.map((s) => source(stateId(s))),
    ...(choice.startsWith("state:") && !here.some((s) => stateId(s) === choice) ? [source(choice as ImageryId)] : []),
    source("usgs"),
    source("terrain"),
    source("street"),
    { label: "Worldwide, with a key", icon: "globe", end: keyed ? imageryInfo(choice as ImageryId).name : undefined, items: [source("esri"), source("google")] },
    { separator: true },
    {
      label: "On top of the map",
      icon: "layers",
      end: overlays.length ? `${overlays.length} on` : undefined,
      items: [
        ...(Object.keys(OVERLAYS) as OverlayId[]).map((o): MenuEntry => ({ label: OVERLAYS[o].name, description: OVERLAYS[o].detail, checkbox: true, checked: overlays.includes(o), onSelect: () => onOverlay(o, !overlays.includes(o)) })),
        { label: "Street names", checkbox: true, checked: streetNames || showing === "street", disabled: showing === "street" || !streetMap, onSelect: () => onStreetNames(!streetNames) },
        { label: "House numbers", description: "Zoomed in close, where OpenStreetMap has them", checkbox: true, checked: houseNumbers && streetMap, disabled: !streetMap, onSelect: () => onHouseNumbers(!houseNumbers) },
      ],
    },
    {
      label: `Open Measure on ${choiceName(choice)} every time`,
      icon: "star",
      description: "Just for you, on this device. Change it in Settings › Profile.",
      hidden: !DEFAULT_CHOICES.includes(choice) || choice === opening,
      onSelect: () => onMakeDefault(choice),
    },
  ];
  const label = choice === "auto" ? (now ? `${AUTO_NAME} · ${now.name}` : AUTO_NAME) : now?.name ?? imageryInfo(choice).name;
  const note = here.length ? null : `Sharper state imagery is listed here when the map is over one of these: ${STATE_IMAGERY.map((s) => s.state).join(", ")}.`;
  return { items, label, note };
}

export function ImageryPicker(props: ImageryPickerProps) {
  const { items, label, note } = imageryMenu(props);
  return (
    <Menu
      items={items}
      label={`Imagery: ${label}`}
      title="Imagery"
      triggerClassName="btn btn-sm btn-ghost imagery-button"
      footer={note ? { text: <span className="imagery-foot">{note}</span> } : undefined}
      trigger={
        <>
          <Icon name="layers" size={15} />
          <span className="imagery-button-label">{label}</span>
          {props.overlays.length > 0 && <span className="imagery-button-count">{props.overlays.length}</span>}
          <Icon name="chevronDown" size={14} />
        </>
      }
    />
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
    <div className="set-item">
      <strong id="measure-map-title">Measure map</strong>
      <Select
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
      </Select>
      <span className="muted small">The imagery Measure opens on. You can still switch any time from the Imagery button. Saved on this device.</span>
    </div>
  );
}
