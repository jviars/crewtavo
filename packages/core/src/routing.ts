/**
 * Route ordering for a crew's day: nearest neighbor, then 2-opt to remove crossings.
 * Straight-line distances; good for small routes. Real road routing (VROOM/OSRM or Google's
 * Route Optimization API) can replace this later behind the same function.
 */
import { haversineM } from "./geo";

export interface Stop {
  id: string;
  lat: number;
  lng: number;
}

const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  haversineM([a.lng, a.lat], [b.lng, b.lat]);

export function routeLengthM(start: { lat: number; lng: number }, stops: Stop[], returnToStart = true): number {
  const points = [start, ...stops, ...(returnToStart ? [start] : [])];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1]);
  return total;
}

export function orderStops(start: { lat: number; lng: number }, stops: Stop[], returnToStart = true): Stop[] {
  // Nearest neighbor
  const remaining = [...stops];
  const route: Stop[] = [];
  let current: { lat: number; lng: number } = start;
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
