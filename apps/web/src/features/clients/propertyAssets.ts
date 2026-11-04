/** Equipment at a property (property_assets): what the screens say about an item, and its service history. */
import { formatDate } from "@/lib/format";

export interface PropertyAsset {
  id: string;
  property_id: string;
  name: string;
  make: string | null;
  model: string | null;
  serial: string | null;
  installed_on: string | null;
  warranty_until: string | null;
  location: string | null;
  notes: string | null;
  photo_path: string | null;
  status: string;
}

export const ASSET_FIELDS = "id, property_id, name, make, model, serial, installed_on, warranty_until, location, notes, photo_path, status";

/** Offered as the name is typed: what HVAC, plumbing, electrical and pool businesses look after. */
export const ASSET_NAMES = [
  "AC unit", "Air handler", "Boiler", "Furnace", "Heat pump", "Mini split", "Thermostat", "Water heater", "Tankless water heater",
  "Water softener", "Sump pump", "Well pump", "Electrical panel", "Generator", "EV charger", "Pool pump", "Pool filter", "Pool heater",
  "Irrigation controller", "Backflow preventer",
];

/** "Lennox EL296 · Serial SN-1 · Basement": what tells one item from another. */
export const assetDetails = (a: Pick<PropertyAsset, "make" | "model" | "serial" | "location">) =>
  [[a.make, a.model].filter(Boolean).join(" "), a.serial && `Serial ${a.serial}`, a.location].filter(Boolean).join(" · ");

/** Its warranty on `today` (YYYY-MM-DD), or null when none is kept. */
export const warrantyNote = (until: string | null, today: string) =>
  !until ? null : until >= today ? `Under warranty until ${formatDate(until)}` : `Warranty ended ${formatDate(until)}`;

export interface ServiceVisit {
  id: string;
  title: string;
  scheduled_on: string | null;
  completed_at: string | null;
  crew: { name: string } | null;
  assignees: Array<{ user_id: string }>;
  checklists: Array<{ id: string; completed_at: string | null; template: { name: string } | null }>;
}

/** The visits that serviced an item, newest first (the day it was done, or the day it's scheduled). */
export const byNewest = (visits: ServiceVisit[]) =>
  [...visits].sort((a, b) => (b.completed_at ?? b.scheduled_on ?? "").localeCompare(a.completed_at ?? a.scheduled_on ?? ""));
