/**
 * The files in a .zip, opened in the browser: just what calendar exports need (Google Calendar's
 * Export downloads a .zip of .ics files). Stored and deflated files, no encryption or ZIP64. What
 * comes out is capped, so a small file that unpacks to gigabytes stops early.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

export class ZipError extends Error {
  override name = "ZipError";
}

/** Whether these bytes start like a .zip. */
export const isZip = (bytes: Uint8Array) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ZipError("A file in that .zip is too big to read.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The files in `zip` whose names `wanted` accepts (folders and macOS's __MACOSX copies never), each at most `limit` bytes. */
export async function unzip(zip: Uint8Array, wanted: (name: string) => boolean, limit = 10 * 1024 * 1024): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is in the last 22 bytes, plus a comment of up to 64 KB.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError("That .zip file looks damaged. Download it again.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== CENTRAL) throw new ZipError("That .zip file looks damaged. Download it again.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || !wanted(name)) continue;
    if (flags & 1) throw new ZipError("That .zip file has a password. Export the calendar again without one.");
    if (local + 30 > zip.length || view.getUint32(local, true) !== LOCAL) throw new ZipError("That .zip file looks damaged. Download it again.");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + packed);
    if (method === 0) {
      if (data.length > limit) throw new ZipError("A file in that .zip is too big to read.");
      files.push({ name, bytes: data });
    } else if (method === 8) {
      files.push({ name, bytes: await inflate(data, limit) });
    } else {
      throw new ZipError("That .zip file is packed in a way Crewtavo can't open. Unzip it and choose the .ics file inside.");
    }
  }
  return files;
}
