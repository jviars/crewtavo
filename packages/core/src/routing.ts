/**
 * Route planning for a crew's day: the order to visit stops in (nearest neighbor, then 2-opt to
 * remove crossings), and the time each stop starts once driving is counted. Straight-line distances
 * times a road factor, so it needs no map service; real road routing (VROOM/OSRM or Google's Route
 * Optimization API) can replace the distances later behind the same functions.
 */
import { haversineM } from "./geo";

export interface Stop {
  id: string;
  lat: number;
  lng: number;
}
export interface LatLng {
  lat: number;
  lng: number;
}

const dist = (a: LatLng, b: LatLng) => haversineM([a.lng, a.lat], [b.lng, b.lat]);

export function routeLengthM(start: LatLng, stops: Stop[], returnToStart = true): number {
  const points = [start, ...stops, ...(returnToStart ? [start] : [])];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  return total;
}

export function orderStops(start: LatLng, stops: Stop[], returnToStart = true): Stop[] {
  // Nearest neighbor
  const remaining = [...stops];
  const route: Stop[] = [];
  let current: LatLng = start;
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (dist(current, remaining[i]) < dist(current, remaining[best])) best = i;
    }
    current = remaining.splice(best, 1)[0];
    route.push(current as Stop);
  }

  // 2-opt: reverse segments while that shortens the route.
  let improved = true;
  let passes = 0;
  while (improved && passes++ < 50) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (routeLengthM(start, candidate, returnToStart) + 1e-6 < routeLengthM(start, route, returnToStart)) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return route;
}

// ---- Schedule settings ------------------------------------------------------------------------------

/** Minutes that dragging on the schedule snaps to. 5 is what Google Calendar's phone app uses. */
export const TIME_STEPS = [1, 5, 15] as const;

export interface ScheduleSettings {
  /** Dragging a visit snaps to this many minutes (1, 5 or 15). Typed times can be any minute. */
  timeStep: number;
  /** Organize each crew's coming days automatically (and fit new anytime visits in). */
  autoRoutes: boolean;
  /** Routes end back at the shop, not at the last stop. */
  returnToShop: boolean;
  /** Average driving speed for drive-time estimates, in mph. */
  speedMph: number;
  /** Organizing gives each stop a time (true), or only numbers the stops, anytime that day (false). */
  routeTimes: boolean;
  /** Minutes at each stop to unload and load the equipment, on top of the work. */
  setupMin: number;
}

export const SCHEDULE_DEFAULTS: ScheduleSettings = { timeStep: 5, autoRoutes: false, returnToShop: true, speedMph: 30, routeTimes: true, setupMin: 0 };

/** The schedule settings in a company's settings (`settings.schedule`), with defaults filled in. */
export function scheduleSettings(settings: unknown): ScheduleSettings {
  const s = ((settings as { schedule?: Record<string, unknown> } | null)?.schedule ?? {}) as Record<string, unknown>;
  const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
  return {
    timeStep: (TIME_STEPS as readonly number[]).includes(s.time_step as number) ? (s.time_step as number) : SCHEDULE_DEFAULTS.timeStep,
    autoRoutes: s.auto_routes === true,
    returnToShop: s.return_to_shop !== false,
    speedMph: num(s.speed_mph, 5, 80, SCHEDULE_DEFAULTS.speedMph),
    routeTimes: s.route_times !== false,
    setupMin: Math.round(num(s.setup_min, 0, 120, SCHEDULE_DEFAULTS.setupMin)),
  };
}

// ---- Planning a day ---------------------------------------------------------------------------------

/** Roads wind: straight-line distance times this is a fair guess at the driving distance in town. */
export const ROAD_FACTOR = 1.3;
const M_PER_MILE = 1609.344;

export interface RouteStop {
  id: string;
  /** Where the work is. null: no map location yet, so it goes last and no driving is counted. */
  at: LatLng | null;
  /** How long the work takes, in minutes. */
  minutes: number;
  /** A start time that stays put (minutes after midnight): the customer expects it. */
  fixed?: number | null;
}

export interface PlannedStop {
  id: string;
  /** Minutes after midnight. */
  start: number;
  end: number;
  /** Estimated driving to this stop from the one before (or from the start). */
  driveMin: number;
  driveMiles: number;
  fixed: boolean;
  /** A fixed stop the crew can't reach by its time. */
  late: boolean;
  located: boolean;
}

export interface RoutePlan {
  stops: PlannedStop[];
  /** Estimated driving, including the way back when the route returns to the shop. */
  miles: number;
  driveMin: number;
  /** When the crew is done (back at the shop, when it returns there), minutes after midnight. */
  finish: number;
  /** Driving back to the shop at the end, included in miles and finish. */
  returnMiles: number;
}

export interface RouteInput {
  /** Where the day starts: the shop, or where the crew is now. null: at the first stop. */
  from: LatLng | null;
  stops: RouteStop[];
  /** When the first stop can start, minutes after midnight. */
  dayStart: number;
  /** Come back here at the end of the day (the shop), or null to finish at the last stop. */
  returnTo?: LatLng | null;
  speedMph: number;
  setupMin?: number;
  /** Round start times up to this many minutes (5: 9:35, not 9:33). */
  step?: number;
  /**
   * Keep these stops in this order (someone set it by hand, or the day is already organized).
   * Stops not listed are fitted in where they add the least driving. Without it: the shortest order.
   */
  order?: string[];
}

export function driveBetween(a: LatLng | null, b: LatLng | null, speedMph: number): { miles: number; minutes: number } {
  if (!a || !b) return { miles: 0, minutes: 0 };
  const miles = (dist(a, b) * ROAD_FACTOR) / M_PER_MILE;
  return { miles, minutes: (miles / speedMph) * 60 };
}

const roundUp = (minutes: number, step: number) => Math.ceil(minutes / step - 1e-9) * step;

/** Times along a route in a set order: each stop starts after the one before plus the drive. */
function timeline(input: RouteInput, sequence: RouteStop[]): RoutePlan {
  const step = Math.max(1, input.step ?? 1);
  const setup = input.setupMin ?? 0;
  let t = input.dayStart;
  let cur = input.from ?? sequence.find((s) => s.at)?.at ?? null;
  let miles = 0;
  let driveMin = 0;
  const stops: PlannedStop[] = [];
  for (const s of sequence) {
    const drive = driveBetween(cur, s.at, input.speedMph);
    const arrive = t + drive.minutes + setup;
    const fixed = s.fixed != null;
    const start = fixed ? s.fixed! : roundUp(arrive, step);
    stops.push({ id: s.id, start, end: start + s.minutes, driveMin: Math.round(drive.minutes), driveMiles: drive.miles, fixed, late: fixed && arrive > s.fixed! + 0.5, located: Boolean(s.at) });
    // A crew running late to a fixed stop starts it late, and the stops after it follow.
    t = Math.max(start, arrive) + s.minutes;
    miles += drive.miles;
    driveMin += drive.minutes;
    if (s.at) cur = s.at;
  }
  const back = input.returnTo ? driveBetween(cur, input.returnTo, input.speedMph) : { miles: 0, minutes: 0 };
  return { stops, miles: miles + back.miles, driveMin: Math.round(driveMin + back.minutes), finish: t + back.minutes, returnMiles: back.miles };
}

/** How bad a plan is: fixed stops missed first, then driving. */
const cost = (plan: RoutePlan) => plan.stops.filter((s) => s.late).length * 1e6 + plan.miles;

/**
 * The day's plan: the order (shortest, or `order` with the rest fitted in) and each stop's times.
 * Fixed stops keep their times; flexible stops go around them, and stops with no map location go
 * last.
 */
export function planRoute(input: RouteInput): RoutePlan {
  const byId = new Map(input.stops.map((s) => [s.id, s]));
  if (input.order) {
    const kept = input.order.map((id) => byId.get(id)).filter((s): s is RouteStop => Boolean(s));
    const keptIds = new Set(kept.map((s) => s.id));
    const rest = input.stops.filter((s) => !keptIds.has(s.id));
    const sequence = [...kept];
    // Each new stop goes where it costs least; ones with no location can't be placed, so go last.
    for (const s of rest.filter((r) => r.at || r.fixed != null)) {
      let best = sequence.length;
      let bestCost = Infinity;
      for (let i = 0; i <= sequence.length; i++) {
        const c = cost(timeline(input, [...sequence.slice(0, i), s, ...sequence.slice(i)]));
        if (c < bestCost - 1e-9) {
          bestCost = c;
          best = i;
        }
      }
      sequence.splice(best, 0, s);
    }
    sequence.push(...rest.filter((r) => !r.at && r.fixed == null));
    return timeline(input, sequence);
  }

  const flexible = input.stops.filter((s) => s.at && s.fixed == null);
  const fixed = input.stops.filter((s) => s.fixed != null).sort((a, b) => a.fixed! - b.fixed!);
  const nowhere = input.stops.filter((s) => !s.at && s.fixed == null);
  const origin = input.from ?? flexible[0]?.at ?? null;
  const ordered = origin
    ? orderStops(origin, flexible.map((s) => ({ id: s.id, lat: s.at!.lat, lng: s.at!.lng })), Boolean(input.returnTo)).map((s) => byId.get(s.id)!)
    : flexible;

  // Walk the shortest order. Before a fixed stop, do the next stop only if the crew still makes the
  // fixed time; if it wouldn't, fill the time with the nearest stop that fits instead of waiting,
  // and go to the fixed stop when none does.
  const sequence: RouteStop[] = [];
  const queue = [...ordered];
  const due = [...fixed];
  const makesIt = (s: RouteStop, appointment: RouteStop) => !timeline(input, [...sequence, s, appointment]).stops.at(-1)!.late;
  while (queue.length || due.length) {
    const appointment = due[0];
    if (!appointment) {
      sequence.push(queue.shift()!);
      continue;
    }
    if (queue[0] && makesIt(queue[0], appointment)) {
      sequence.push(queue.shift()!);
      continue;
    }
    const here = [...sequence].reverse().find((s) => s.at)?.at ?? input.from;
    let best = -1;
    for (let i = 1; i < queue.length; i++) {
      if (!makesIt(queue[i]!, appointment)) continue;
      if (best === -1 || (here && dist(here, queue[i]!.at!) < dist(here, queue[best]!.at!))) best = i;
    }
    sequence.push(best === -1 ? due.shift()! : queue.splice(best, 1)[0]!);
  }
  sequence.push(...nowhere);
  return timeline(input, sequence);
}
