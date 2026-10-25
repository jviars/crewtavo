/**
 * Drawn signatures and initials for the tests, as far as the server reads them (services/logo.ts
 * isDrawnPng): a PNG data URL with the signature and the header (IHDR) giving its size, then `tag`, so
 * two drawings can be told apart. Nothing decodes the rest, so no picture data follows.
 */
export function drawnPng(width = 600, height = 180, tag = "") {
  const size = new Uint8Array(8);
  new DataView(size.buffer).setUint32(0, width);
  new DataView(size.buffer).setUint32(4, height);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    Buffer.from("IHDR", "latin1"),
    size,
    // 8-bit RGBA, then the chunk's checksum (never checked).
    Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from(tag, "utf8"),
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
