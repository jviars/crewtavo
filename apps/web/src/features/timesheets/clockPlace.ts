import { FT_PER_M, haversineM } from "@crewtavo/core/geo";

/** Where a clock started or stopped, as time_entry_places() returns it: the phone's place, or why there was none, and whose phone it was. */
export interface StoredPlace {
  lat?: number;
  lng?: number;
  /** Metres, as the phone reported it. */
  accuracy?: number;
  missing?: "denied" | "unavailable" | "timeout" | "unsupported";
  by?: string;
}
/** The place the work was at: the visit's or job's property, or the shop for shop time. */
export interface Site { kind: "job" | "shop"; lat: number; lng: number }
export interface EntryPlaces { id: string; in_place: StoredPlace | null; out_place: StoredPlace | null; site: Site | null }

/** This close to the job counts as being there, plus the phone's own margin (up to as much again): big lots and rough fixes. */
const ON_SITE_M = 200;
/** A fix less sure than this says so. */
const ROUGH_M = 500;
const M_PER_MILE = 1609.344;

/** "450 ft", "1.2 mi", "38 mi". */
export function distanceLabel(meters: number): string {
  const miles = meters / M_PER_MILE;
  if (miles < 0.1) return `${Math.max(10, Math.round((meters * FT_PER_M) / 10) * 10)} ft`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/**
 * What a clock-in or clock-out place tells the office: at the job, how far from it, just a point on
 * the map (no job or shop to compare with), or why the phone didn't say.
 */
export function describePlace(place: StoredPlace, site: Site | null): { text: string; tone: "good" | "warning" | "plain"; mapUrl: string | null; title?: string } {
  if (place.lat == null || place.lng == null) {
    const text = place.missing === "denied" ? "location turned off" : place.missing === "unsupported" ? "phone can't share location" : "no location found";
    return { text, tone: "warning", mapUrl: null };
  }
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  const title = place.accuracy != null ? `Accurate to about ${distanceLabel(place.accuracy)}` : undefined;
  const rough = place.accuracy != null && place.accuracy > ROUGH_M ? " (rough location)" : "";
  if (!site) return { text: `see map${rough}`, tone: "plain", mapUrl, title };
  const meters = haversineM([place.lng, place.lat], [site.lng, site.lat]);
  const where = site.kind === "shop" ? "the shop" : "the job";
  if (meters <= ON_SITE_M + Math.min(place.accuracy ?? 0, ON_SITE_M)) return { text: `at ${where}`, tone: "good", mapUrl, title };
  return { text: `${distanceLabel(meters)} from ${where}${rough}`, tone: "warning", mapUrl, title };
}
