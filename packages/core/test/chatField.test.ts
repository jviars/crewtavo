import { describe, expect, it } from "vitest";
import {
  clockStatus,
  clockText,
  isAudio,
  nextMondayAt,
  nextSpeed,
  pickedTime,
  pickerStart,
  recordedFile,
  recordingType,
  remindChoices,
  retryDelay,
  sendLaterChoices,
  statusUntil,
  tomorrowAt,
  waitsForSignal,
  weekdayOf,
} from "../src/chatField";

describe("voice notes", () => {
  it("records the best kind the browser has: Opus in WebM, else MP4 (Safari), else the browser's own", () => {
    expect(recordingType((t) => t.startsWith("audio/webm"))).toMatchObject({ mimeType: "audio/webm;codecs=opus", ext: "webm" });
    expect(recordingType((t) => t === "audio/mp4")).toMatchObject({ mimeType: "audio/mp4", type: "audio/mp4", ext: "m4a" });
    expect(recordingType(() => false)).toEqual({ mimeType: "", type: "audio/webm", ext: "webm" });
    expect(
      recordingType((t) => {
        if (t.includes("codecs")) throw new Error("unknown");
        return t === "audio/webm";
      }),
    ).toMatchObject({ mimeType: "audio/webm" });
  });

  it("stores a recording by what the recorder made, with an ending the database takes", () => {
    const webm = recordingType((t) => t.startsWith("audio/webm"));
    expect(recordedFile("audio/webm;codecs=opus", webm)).toEqual({ type: "audio/webm", ext: "webm" });
    expect(recordedFile("audio/mp4; codecs=mp4a.40.2", webm)).toEqual({ type: "audio/mp4", ext: "m4a" });
    expect(recordedFile("", webm)).toEqual({ type: "audio/webm", ext: "webm" });
    expect(recordedFile("video/webm", webm)).toEqual({ type: "audio/webm", ext: "webm" });
  });

  it("tells a voice note from a photo by its type or its ending", () => {
    expect(isAudio({ type: "audio/mp4", path: "a/chat/b/c.m4a" })).toBe(true);
    expect(isAudio({ path: "a/chat/b/c.webm" })).toBe(true);
    expect(isAudio({ type: "image/jpeg", path: "a/chat/b/c.jpg" })).toBe(false);
    expect(isAudio({ type: "application/pdf", path: "a/chat/b/c.pdf" })).toBe(false);
    // The type is the sender's word: a document called audio is still a document (and isn't sent to be written out).
    expect(isAudio({ type: "audio/webm", path: "a/chat/b/c.pdf" })).toBe(false);
    expect(isAudio({ type: "audio/mp4" })).toBe(true);
  });

  it("writes times as a clock and plays at 1×, 1.5× and 2× in turn", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(42.9)).toBe("0:42");
    expect(clockText(245)).toBe("4:05");
    expect(clockText(Number.POSITIVE_INFINITY)).toBe("0:00");
    expect([nextSpeed(1), nextSpeed(1.5), nextSpeed(2)]).toEqual([1.5, 2, 1]);
  });
});

describe("messages waiting for signal", () => {
  it("waits longer each time, up to 5 minutes, a little earlier or later", () => {
    expect(retryDelay(0)).toBe(5_000);
    expect(retryDelay(1)).toBe(10_000);
    expect(retryDelay(3)).toBe(40_000);
    expect(retryDelay(20)).toBe(300_000);
    expect(retryDelay(0, 0)).toBe(4_000);
    expect(retryDelay(0, 1)).toBe(6_000);
  });

  it("keeps a message only when the network didn't answer or the server was restarting, not when it was refused", () => {
    expect([0, 502, 503, 504].map(waitsForSignal)).toEqual([true, true, true, true]);
    expect([400, 401, 403, 409, 413, 500].map(waitsForSignal)).toEqual([false, false, false, false, false, false]);
  });
});

describe("status", () => {
  it("reads the clock: driving, a break, or on a job for a visit or an assessment", () => {
    expect(clockStatus("drive")).toBe("driving");
    expect(clockStatus("break")).toBe("break");
    expect(clockStatus("visit")).toBe("on_job");
    expect(clockStatus("assessment")).toBe("on_job");
    expect(clockStatus("shop")).toBeNull();
    expect(clockStatus(null)).toBeNull();
  });

  it("clears in so long, at the end of the business's day or week, or never", () => {
    // Thursday Nov 26, 2026, 3:00 PM in Chicago (21:00 UTC).
    const now = new Date("2026-11-26T21:00:00Z");
    expect(statusUntil("30m", now, "America/Chicago")?.toISOString()).toBe("2026-11-26T21:30:00.000Z");
    expect(statusUntil("4h", now, "America/Chicago")?.toISOString()).toBe("2026-11-27T01:00:00.000Z");
    expect(statusUntil("today", now, "America/Chicago")?.toISOString()).toBe("2026-11-27T06:00:00.000Z");
    expect(statusUntil("week", now, "America/Chicago")?.toISOString()).toBe("2026-11-30T06:00:00.000Z");
    expect(statusUntil("never", now, "America/Chicago")).toBeNull();
    // Late Thursday in Chicago is already Friday in London: its own day ends a day later.
    expect(statusUntil("today", new Date("2026-11-27T01:00:00Z"), "Europe/London")?.toISOString()).toBe("2026-11-28T00:00:00.000Z");
    // A Sunday's week ends that night.
    expect(statusUntil("week", new Date("2026-11-29T15:00:00Z"), "America/Chicago")?.toISOString()).toBe("2026-11-30T06:00:00.000Z");
  });
});

describe("sending later and reminders, where the business is", () => {
  it("knows each date's weekday", () => {
    expect(weekdayOf("2026-11-26")).toBe(4);
    expect(weekdayOf("2026-11-29")).toBe(0);
    expect(weekdayOf("2026-11-30")).toBe(1);
  });

  it("sends tomorrow at 6:30 AM and on Monday at 7:00 AM in the business's time zone, not the phone's", () => {
    // Thursday 11:30 PM in Denver is Friday in UTC: tomorrow is still Friday in Denver.
    const now = new Date("2026-11-27T06:30:00Z");
    const [tomorrow, monday] = sendLaterChoices(now, "America/Denver");
    expect(tomorrow.at.toISOString()).toBe("2026-11-27T13:30:00.000Z");
    expect(monday.at.toISOString()).toBe("2026-11-30T14:00:00.000Z");
    // On a Monday, Monday is a week on.
    expect(nextMondayAt("07:00", new Date("2026-11-30T18:00:00Z"), "America/Denver").toISOString()).toBe("2026-12-07T14:00:00.000Z");
    // Across the change back from summer time: 6:30 AM is still 6:30 AM there.
    expect(tomorrowAt("06:30", new Date("2026-10-31T18:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-01T11:30:00.000Z");
  });

  it("reminds in an hour, or tomorrow at 9:00 AM where the business is", () => {
    const now = new Date("2026-11-26T21:00:00Z");
    const [hour, tomorrow] = remindChoices(now, "Australia/Sydney");
    expect(hour.at.toISOString()).toBe("2026-11-26T22:00:00.000Z");
    // 8:00 AM Friday in Sydney: tomorrow is Saturday.
    expect(tomorrow.at.toISOString()).toBe("2026-11-27T22:00:00.000Z");
  });

  it("reads a picked date and time in the business's zone, and only in the future", () => {
    const now = new Date("2026-11-26T21:00:00Z");
    expect(pickedTime("2026-12-01", "07:15", now, "America/Chicago")?.toISOString()).toBe("2026-12-01T13:15:00.000Z");
    expect(pickedTime("2026-11-26", "14:00", now, "America/Chicago")).toBeNull();
    expect(pickedTime("2026-12-01", "", now, "America/Chicago")).toBeNull();
    expect(pickerStart(now, "America/Chicago")).toEqual({ date: "2026-11-26", time: "16:00" });
  });
});
