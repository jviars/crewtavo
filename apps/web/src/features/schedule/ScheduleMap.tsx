/**
 * The schedule's map view: a day's visits as numbered pins on the street map the measuring map
 * uses (MapLibre, with OpenFreeMap's streets). Each pin is a button, so it can be tabbed to, and
 * opens its visit. On a phone or tablet it can fill the screen (lib/extendMap). Loaded only when the
 * map view opens, since MapLibre is large.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { useExtendedMap } from "@/lib/extendMap";

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  /** The visit's place in the day: 1, 2, 3... */
  label: string;
  /** "9:00 AM · Mow the front", for the pin's tooltip and its name for screen readers. */
  title: string;
  color?: string;
}

// The same street map as MeasureMap (features/measure/MeasureMap.tsx).
const STREETS = "https://tiles.openfreemap.org/styles/liberty";

export function ScheduleMap({ pins, onOpen }: { pins: MapPin[]; onOpen: (id: string) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [failed, setFailed] = useState(false);
  const extend = useExtendedMap();
  const open = useRef(onOpen);
  open.current = onOpen;

  useEffect(() => {
    if (!el.current) return;
    try {
      const first = pins[0];
      mapRef.current = new maplibregl.Map({
        container: el.current,
        style: STREETS,
        center: first ? [first.lng, first.lat] : [-98, 39],
        zoom: 11,
        attributionControl: { compact: true },
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current.touchZoomRotate.disableRotation();
    mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The map is made once; the pins effect below follows the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redrawn only when the pins themselves change, so a refresh every 20 seconds doesn't undo a pan.
  const key = JSON.stringify(pins);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = pins.map((p) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "schedule-pin";
      pin.textContent = p.label;
      pin.title = p.title;
      pin.setAttribute("aria-label", `${p.label}. ${p.title}`);
      if (p.color) pin.style.setProperty("--crew", p.color);
      pin.addEventListener("click", () => open.current(p.id));
      return new maplibregl.Marker({ element: pin }).setLngLat([p.lng, p.lat]).addTo(map);
    });
    if (pins.length) {
      const bounds = new maplibregl.LngLatBounds();
      for (const p of pins) bounds.extend([p.lng, p.lat]);
      map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
    }
    return () => markers.forEach((m) => m.remove());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (failed) return <p className="muted">This browser can't show the map (WebGL is turned off or not supported). Try an up-to-date Chrome, Edge, Safari or Firefox, or turn on hardware acceleration.</p>;
  return (
    <div className="schedule-map-frame" data-extended={extend.extended || undefined}>
      <div ref={el} className="schedule-map" role="region" aria-label="Map of the day's visits" />
      {extend.available && (
        <button type="button" className="map-extend" onClick={() => extend.setExtended(!extend.extended)} title={extend.extended ? "Back to the page" : "Fill the screen with the map"} aria-label="Full-screen map" aria-pressed={extend.extended}>
          <Icon name={extend.extended ? "minimize" : "maximize"} size={16} />
        </button>
      )}
    </div>
  );
}
