/**
 * Directions in the maps app people use. A web app can't see which apps a phone has (browsers keep
 * that private), so it offers the common ones for the device: Apple Maps on iPhone, iPad and Mac,
 * Google Maps, Waze, and on Android "Other app", which opens Android's own list of installed maps
 * apps. Each opens its app when it's installed and its website when it isn't. A choice can be
 * remembered on this device (Settings → Profile changes it).
 *
 * A crew's whole day opens as one route (the shop, then each stop in order) in Apple Maps or Google
 * Maps, the two that take many stops from a link. Each takes only so many, so a long day opens in
 * parts, each starting where the last one ended.
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

/** The apps that open a whole route from a link (Waze and Android's list take one place). */
export type RouteApp = "apple" | "google";

export interface Route {
  /** Where the route starts; null starts from where the phone is. */
  start: Place | null;
  stops: Place[];
  /** Where it ends after the last stop (back at the shop), or null to end at the last stop. */
  end: Place | null;
}

export interface RouteLeg {
  /** The stops this link covers, counting from 1. */
  first: number;
  last: number;
  /** Ends back at `end`. */
  back: boolean;
  url: string;
}

/**
 * How many places a link takes after the start, the last one included. Google Maps takes nine
 * waypoints and a destination (its phone website takes three waypoints, so phones want the app).
 * Apple said 15 stops when Apple Maps got them, testers fit 13, so 12 leaves room.
 */
const LEG_PLACES: Record<RouteApp, number> = { google: 10, apple: 12 };

/** A place as a maps app finds it: the address, as the crew knows it, or else its map point. */
const placeQuery = (p: Place) => placeText(p) || (hasPoint(p) ? `${p.lat},${p.lng}` : "");

/** The route apps worth offering on this device, most likely first. */
export function routeApps(): RouteApp[] {
  return mapsApps().filter((app): app is RouteApp => app === "apple" || app === "google");
}

/** The route app to open without asking: the one this device remembers, or the only one offered. */
export function routeApp(): RouteApp | null {
  const apps = routeApps();
  const app = rememberedApp();
  return apps.find((a) => a === app) ?? (apps.length === 1 ? apps[0]! : null);
}

/** The links that open a route in that app: one, or for a long day, one per part, the parts even. */
export function routeLegs(app: RouteApp, route: Route): RouteLeg[] {
  const stops = route.stops.filter(placeQuery);
  const parts = Math.ceil(stops.length / LEG_PLACES[app]);
  // Back at the end, unless that would take a part of its own.
  const end = route.end && placeQuery(route.end) && stops.length < parts * LEG_PLACES[app] ? route.end : null;
  const places = end ? [...stops, end] : stops;
  const size = Math.ceil(places.length / parts);
  const legs: RouteLeg[] = [];
  let from = route.start && placeQuery(route.start) ? route.start : null;
  for (let i = 0; i < places.length; i += size) {
    const part = places.slice(i, i + size);
    legs.push({ first: i + 1, last: Math.min(i + size, stops.length), back: Boolean(end) && i + size >= places.length, url: legUrl(app, from, part) });
    from = part.at(-1)!;
  }
  return legs;
}

function legUrl(app: RouteApp, from: Place | null, places: Place[]): string {
  const q = (p: Place) => encodeURIComponent(placeQuery(p));
  const to = places.at(-1)!;
  const between = places.slice(0, -1);
  if (app === "apple") {
    // Apple's unified Maps links (iOS 18.4 and macOS 15.4 on): one waypoint parameter per stop.
    const params = [from && `source=${q(from)}`, `destination=${q(to)}`, ...between.map((p) => `waypoint=${q(p)}`), "mode=driving"];
    return `https://maps.apple.com/directions?${params.filter(Boolean).join("&")}`;
  }
  const params = [from && `origin=${q(from)}`, `destination=${q(to)}`, between.length > 0 && `waypoints=${between.map(q).join("%7C")}`, "travelmode=driving"];
  return `https://www.google.com/maps/dir/?api=1&${params.filter(Boolean).join("&")}`;
}

/** The shop (Settings → Company): its address and map point, or null when there's neither. */
export function shopPlace(company: { address?: Place | null; settings?: Record<string, unknown> | null }): Place | null {
  const address = company.address ?? {};
  const depot = (company.settings?.depot ?? null) as { lat: number; lng: number } | null;
  if (!address.line1 && !depot) return null;
  return { line1: address.line1, city: address.city, region: address.region, postal_code: address.postal_code, lat: depot?.lat, lng: depot?.lng };
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
