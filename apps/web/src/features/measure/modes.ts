/**
 * Which of Measure's tools show: a roof's (a pitch and roof edges on every row) or a lawn's (lawn
 * items, Find, each area's slope and the Lawn card). Never both: a lawn's areas aren't roof sections.
 *
 * A drawing opened from Roofing, or with a pitch or a roof edge set, is a roof whatever else is true.
 * Short of that, anything that says lawn wins, with Roofing installed too: a business that mows and
 * roofs gets its lawn tools on a plain drawing, and `offer` names the other set to switch to.
 */
export function roofOrLawn(is: {
  /** A roof for sure: it was opened from Roofing, or a pitch or a roof edge is set. */
  roof: boolean;
  /** Roofing is installed: a drawing nothing says is a lawn is a roof. */
  roofingApp: boolean;
  /** With Roofing installed, the roof tools were asked for on a drawing that would show a lawn's. */
  roofPicked: boolean;
  /** "Roof pitch and edges" is open. */
  roofCardOpen: boolean;
  /** A lawn is wanted: a lawn care business, a drawing with lawn items or a slope, or Lawn turned on. */
  lawn: boolean;
}): { roofing: boolean; lawn: boolean; offer: "roof" | "lawn" | null } {
  // Only looking into the roof card doesn't make a lawn a roof: its lawn tools would vanish while the card is open.
  const roofing = is.roof || (is.roofingApp && is.roofPicked) || ((is.roofingApp || is.roofCardOpen) && !is.lawn);
  // The way to the other set, while it could be either: Roofing is installed, something says lawn, and nothing makes it a roof for sure.
  const offer = is.roofingApp && is.lawn && !is.roof ? (roofing ? "lawn" : "roof") : null;
  return { roofing, lawn: is.lawn && !roofing, offer };
}
