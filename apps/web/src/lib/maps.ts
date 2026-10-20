/**
 * Directions in the maps app people use. A web app can't see which apps a phone has (browsers keep
 * that private), so it offers the common ones for the device: Apple Maps on iPhone, iPad and Mac,
 * Google Maps, Waze, and on Android "Other app", which opens Android's own list of installed maps
 * apps. Each opens its app when it's installed and its website when it isn't. A choice can be
 * remembered on this device (Settings → Profile changes it).
 */

export type MapsApp = "apple" | "google" | "waze" | "other";

export interface Place {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** A free-text location (another calendar's event): used when there's no street address. */
  text?: string | null;
}

const KEY = "crewtavo.maps.app";

export const MAPS_LABELS: Record<MapsApp, string> = { apple: "Apple Maps", google: "Google Maps", waze: "Waze", other: "Other app" };

/** The address as one line, for copying and for apps that search by address. */
export function placeText(p: Place): string {
  if (p.text && !p.line1) return p.text.replace(/\s*\n\s*/g, ", ");
  return [p.line1, p.line2, p.city, [p.region, p.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

const hasPoint = (p: Place) => p.lat != null && p.lng != null;

export function device(): "apple" | "android" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  // iPadOS reports itself as a Mac with touch.
  if (/iPhone|iPad|iPod|Macintosh/i.test(ua)) return "apple";
  return "other";
}

/** The apps worth offering on this device, most likely first. */
export function mapsApps(): MapsApp[] {
  const d = device();
  if (d === "apple") return ["apple", "google", "waze"];
  if (d === "android") return ["google", "waze", "other"];
  return ["google", "apple", "waze"];
}

/** A link that starts directions to the place in that app (or its website). */
export function mapsUrl(app: MapsApp, p: Place): string {
  const text = placeText(p);
  const point = hasPoint(p) ? `${p.lat},${p.lng}` : null;
  const q = encodeURIComponent(text || point || "");
  switch (app) {
    case "apple":
      // Coordinates find the exact spot; the address names it.
      return point ? `https://maps.apple.com/?daddr=${point}&q=${q}&dirflg=d` : `https://maps.apple.com/?daddr=${q}&dirflg=d`;
    case "waze":
      return point ? `https://waze.com/ul?ll=${point}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`;
    case "other":
      // Android asks which installed app to use.
      return point ? `geo:${point}?q=${point}(${encodeURIComponent(text || "Stop")})` : `geo:0,0?q=${q}`;
    case "google":
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(point ?? text)}`;
  }
}

/** The app this device remembers, if it's one offered here. */
export function rememberedApp(): MapsApp | null {
  try {
    const value = localStorage.getItem(KEY) as MapsApp | null;
    return value && mapsApps().includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remember (or with null, forget) the app for directions on this device. */
export function rememberApp(app: MapsApp | null) {
  try {
    if (app) localStorage.setItem(KEY, app);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode: asked each time
  }
}
