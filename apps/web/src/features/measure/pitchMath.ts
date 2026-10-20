/** The math behind the phone and photo pitch gauges (RoofPitch.tsx), kept apart so it can be tested. */

export const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** A pitch as the rise per 12 we'd suggest from a measured angle, to the half inch. */
export function pitchFromAngle(degrees: number): string {
  return `${Math.round(Math.tan(rad(degrees)) * 12 * 2) / 2}/12`;
}

/**
 * How far the phone's screen is tipped from level, whichever way it points: the angle between the
 * screen's face and straight up is acos(cos(beta) * cos(gamma)) for the browser's orientation angles.
 */
export const tiltOf = (beta: number, gamma: number) => deg(Math.acos(Math.min(1, Math.abs(Math.cos(rad(beta)) * Math.cos(rad(gamma))))));

/** Spots on the photo, as fractions of its width and height. */
export type Spot = [number, number];
export type Handles = { roof: [Spot, Spot]; level: [Spot, Spot] };

/** The angle between the roof line and the level line, in degrees (0 to 90), on a photo of this size. */
export function photoAngle(h: Handles, width: number, height: number): number {
  const heading = ([a, b]: [Spot, Spot]) => Math.atan2((b[1] - a[1]) * height, (b[0] - a[0]) * width);
  let d = Math.abs(deg(heading(h.roof) - heading(h.level))) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/** Where the lines start on a new photo: a 6/12 roof line over a level line, well inside the picture. */
export function startingHandles(width: number, height: number): Handles {
  const length = 0.36;
  const run = length * Math.cos(Math.atan(0.5));
  const rise = (length * Math.sin(Math.atan(0.5)) * width) / height;
  return { roof: [[0.2, 0.62], [0.2 + run, 0.62 - rise]], level: [[0.15, 0.8], [0.85, 0.8]] };
}
