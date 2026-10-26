/**
 * A .zip made in the browser, for a download that's many files (Settings → Your data). Files are
 * deflated with the browser's own CompressionStream, or stored when that doesn't make them smaller.
 * Names are UTF-8. No ZIP64, so it's for downloads well under 4 GB; unzip.ts reads them back.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** Bit 11: the name is UTF-8. */
const UTF8 = 0x0800;

let table: Uint32Array | undefined;

function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The date and time as a .zip keeps them (MS-DOS: 2-second steps, from 1980), in local time. */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** `files` (text is written as UTF-8) as a .zip, in order. Folders come from the names ("spreadsheets/clients.csv"). */
export async function zip(files: ReadonlyArray<{ name: string; data: string | Uint8Array }>, date = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, day } = dosTime(date);
  const parts: BlobPart[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const packed = await deflate(raw);
    const method = packed.length < raw.length ? 8 : 0;
    const data = method === 8 ? packed : raw;
    const crc = crc32(raw);

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, LOCAL, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, UTF8, true);
    l.setUint16(8, method, true);
    l.setUint16(10, time, true);
    l.setUint16(12, day, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, raw.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, CENTRAL, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, UTF8, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, day, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);

    parts.push(local as BlobPart, data as BlobPart);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, END, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...(centrals as BlobPart[]), end as BlobPart], { type: "application/zip" });
}
