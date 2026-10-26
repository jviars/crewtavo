/** The .zip Settings → Your data downloads (lib/zip.ts): what unzip.ts and other apps read back, byte for byte. */
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unzip } from "../src/lib/unzip";
import { zip } from "../src/lib/zip";

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
/** As written, a byte-order mark included. */
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

describe("zip", () => {
  it("packs files in folders that unzip back as they were", async () => {
    const csv = "Name,Email\r\n" + "Mary Smith,mary@example.com\r\n".repeat(500);
    const files = [
      { name: "export/READ ME.txt", data: "Hi" },
      { name: "export/spreadsheets/clients.csv", data: "﻿" + csv },
      { name: "export/spreadsheets/José's café.csv", data: "Señora,Ñandú" },
      { name: "export/photo.bin", data: new Uint8Array([0, 255, 7, 128]) },
    ];
    const packed = await bytesOf(await zip(files));
    const out = await unzip(packed, () => true);
    expect(out.map((f) => f.name)).toEqual(files.map((f) => f.name));
    expect(text(out[1].bytes)).toBe("﻿" + csv);
    expect(text(out[2].bytes)).toBe("Señora,Ñandú");
    expect([...out[3].bytes]).toEqual([0, 255, 7, 128]);
    // The spreadsheet is deflated; it repeats, so it's much smaller packed.
    expect(packed.length).toBeLessThan(csv.length / 10);
  });

  it("writes each file's checksum, sizes and a UTF-8 name, as other unzip apps check", async () => {
    const data = new TextEncoder().encode("Ñandú ".repeat(100));
    const packed = await bytesOf(await zip([{ name: "Ñ.txt", data }], new Date(2026, 9, 26, 14, 30, 10)));
    const view = new DataView(packed.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(8);
    expect(view.getUint32(14, true)).toBe(crc32(data));
    expect(view.getUint32(22, true)).toBe(data.length);
    // 2:30:10 pm on Oct 26, 2026, as MS-DOS keeps it.
    expect(view.getUint16(10, true)).toBe((14 << 11) | (30 << 5) | 5);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (10 << 5) | 26);
    const end = packed.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(1);
  });

  it("stores a file that deflating wouldn't make smaller", async () => {
    const packed = await bytesOf(await zip([{ name: "a.txt", data: "x" }]));
    expect(new DataView(packed.buffer).getUint16(8, true)).toBe(0);
    expect(text((await unzip(packed, () => true))[0].bytes)).toBe("x");
  });
});
