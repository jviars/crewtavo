/**
 * Which of Measure's tools show: a roof's (a pitch and roof edges on every row) or a lawn's (lawn
 * items, Find, each area's slope and the Lawn card). Never both: a lawn's areas aren't roof sections.
 */
export function roofOrLawn(is: {
  /** A roof for sure: Roofing is installed, it was opened from Roofing, or a pitch or a roof edge is set. */
  roof: boolean;
  /** "Roof pitch and edges" is open. */
  roofCardOpen: boolean;
  /** A lawn is wanted: a lawn care business, a drawing with lawn items or a slope, or Lawn turned on. */
  lawn: boolean;
}): { roofing: boolean; lawn: boolean } {
  // Only looking into the roof card doesn't make a lawn a roof: its lawn tools would vanish while the card is open.
  const roofing = is.roof || (is.roofCardOpen && !is.lawn);
  return { roofing, lawn: is.lawn && !roofing };
}
