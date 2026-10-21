/**
 * A crew's day as a route for Apple Maps or Google Maps (lib/maps.ts): the stops still to drive to,
 * in the schedule's order, starting at the shop, or from where the phone is once the day is under
 * way. It ends back at the shop when routes do (Settings → Schedule).
 */
import { scheduleSettings } from "@crewtavo/core/routing";
import { shopPlace, type Place, type Route } from "@/lib/maps";
import type { Company } from "@/lib/session";

const UNDER_WAY = ["en_route", "in_progress", "completed"];
const TO_DRIVE = ["scheduled", "en_route"];

/** `visits` in route order, as the schedule lists them. */
export function dayRoute(visits: Array<{ status: string; property: Place | null }>, company: Company): Route {
  const shop = shopPlace(company);
  const started = visits.some((v) => UNDER_WAY.includes(v.status));
  return {
    start: started ? null : shop,
    stops: visits.filter((v) => TO_DRIVE.includes(v.status) && v.property).map((v) => v.property!),
    end: scheduleSettings(company.settings).returnToShop ? shop : null,
  };
}
