/**
 * Telling a picture of nothing from a photo. A server that draws its imagery on request answers for
 * a place it has no photos of with a whole picture in one colour: Maryland's sends 1,686 bytes of
 * black JPEG for a house in Virginia, too big to pass for a blank tile by its size alone. So a tile
 * that's big enough to be a picture is looked at too, where the browser can decode it.
 */

/**
 * How far apart a channel's darkest and lightest pixel may be in a picture of one colour: what JPEG
 * does to a flat fill, no more. A real photo, even of dark water or a mown field, spreads far wider,
 * and calling one empty would hide good imagery, so the rule is strict.
 */
const FLAT_RANGE = 8;

/**
 * Whether a picture's pixels (RGBA, a byte each, as a canvas gives them) are all one colour: black,
 * white, or see-through all over. One that's part photo and part blank (the edge of what a state
 * flew) is a photo.
 */
export function flatPicture(pixels: ArrayLike<number>): boolean {
  if (pixels.length < 4) return false;
  const min = [255, 255, 255, 255];
  const max = [0, 0, 0, 0];
  for (let i = 0; i < pixels.length; i++) {
    const c = i & 3;
    const v = pixels[i];
    if (v < min[c]) min[c] = v;
    if (v > max[c]) max[c] = v;
    if (max[c] - min[c] > FLAT_RANGE) return false;
  }
  return true;
}

/** A tile's pixels (RGBA), or null where they can't be read: a browser without the means, or bytes that aren't a picture. */
export async function tilePixels(tile: Blob): Promise<Uint8ClampedArray | null> {
  if (typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(tile);
    const { width, height } = bitmap;
    if (!width || !height) return null;
    const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height) : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
