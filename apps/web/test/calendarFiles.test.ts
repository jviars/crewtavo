import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { calendarName, pickCalendar, readCalendarFiles } from "../src/features/apps/calendarFiles";
import { isZip, unzip } from "../src/lib/unzip";

/** A .zip the way Google Calendar's Export makes one (deflated), or stored, with `files` in it. */
function zip(files: Array<{ name: string; text: string }>, method: 0 | 8 = 8): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const raw = new TextEncoder().encode(file.text);
    const data = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + name.length + data.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(8, method, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, raw.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, method, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, raw.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const ics = (name: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Mow\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe("calendar files", () => {
  it("opens Google Calendar's export .zip, one calendar per .ics, skipping everything else", async () => {
    const export_ = zip([
      { name: "jordan@gmail.com.ics", text: ics("Jordan Rivera") },
      { name: "Crew A_c_8f1d@group.calendar.google.com.ics", text: ics("Crew A") },
      { name: "__MACOSX/._Crew A.ics", text: "junk" },
      { name: "notes.txt", text: "not a calendar" },
    ]);
    expect(isZip(export_)).toBe(true);
    const files = await readCalendarFiles(new File([export_ as BlobPart], "jordan@gmail.com.ical.zip"));
    expect(files.map((f) => [f.fileName, f.name])).toEqual([["jordan@gmail.com.ics", "Jordan Rivera"], ["Crew A_c_8f1d@group.calendar.google.com.ics", "Crew A"]]);
    expect(files[1]!.text).toBe(ics("Crew A"));
    // Stored (not deflated) files too.
    expect((await unzip(zip([{ name: "a.ics", text: "hi" }], 0), () => true)).map((f) => new TextDecoder().decode(f.bytes))).toEqual(["hi"]);
  });

  it("reads a plain .ics as one calendar, and explains a .zip without any", async () => {
    expect(await readCalendarFiles(new File([ics("Office")], "office.ics"))).toEqual([{ fileName: "office.ics", name: "Office", text: ics("Office") }]);
    await expect(readCalendarFiles(new File([zip([{ name: "readme.txt", text: "x" }]) as BlobPart], "x.zip"))).rejects.toThrow(/no calendar \(\.ics\) files/);
    await expect(readCalendarFiles(new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])], "broken.zip"))).rejects.toThrow(/looks damaged/);
  });

  it("stops unpacking a file that grows too big", async () => {
    const bomb = zip([{ name: "big.ics", text: "A".repeat(2_000_000) }]);
    await expect(unzip(bomb, () => true, 1_000_000)).rejects.toThrow(/too big/);
  });

  it("reads a calendar's own name, folded and escaped", () => {
    expect(calendarName("BEGIN:VCALENDAR\r\nX-WR-CALNAME;VALUE=TEXT:Smith\\, Jones \r\n & Co\r\nEND:VCALENDAR")).toBe("Smith, Jones & Co");
    expect(calendarName("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeNull();
  });

  it("picks the calendar to upload again from a .zip by its name", () => {
    const files = [{ fileName: "a.ics", name: "Office", text: "a" }, { fileName: "b.ics", name: "Crew A", text: "b" }];
    expect(pickCalendar(files, "crew a").text).toBe("b");
    expect(pickCalendar([files[0]!], "Anything").text).toBe("a");
    expect(() => pickCalendar(files, "Days off")).toThrow(/none is called Days off/);
  });
});
