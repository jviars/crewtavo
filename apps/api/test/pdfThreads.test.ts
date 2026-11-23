/**
 * The threads PDFs are made on (pdf/threads.ts): how many at once, and a thread stopped when it takes
 * too long while the server's own thread keeps answering. A stand-in script plays the PDF's thread
 * (fixtures/pdf-thread.mjs); documentPdf.test.ts makes real PDFs on one.
 */
import { describe, expect, it } from "vitest";
import { Busy, gate, onThread, TookTooLong } from "../src/pdf/threads";

const SCRIPT = new URL("./fixtures/pdf-thread.mjs", import.meta.url);
const limits = { timeoutMs: 5_000, memoryMb: 64 };

describe("a PDF's thread", () => {
  it("answers what the thread posts back, given what it's sent", async () => {
    expect(await onThread(SCRIPT, "hello", { fonts: "/fonts/" }, limits)).toEqual({ echo: "hello", data: { fonts: "/fonts/" } });
  });

  it("is stopped when it takes too long, while this thread keeps answering", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    await expect(onThread(SCRIPT, "spin", null, { ...limits, timeoutMs: 500 })).rejects.toBeInstanceOf(TookTooLong);
    clearInterval(timer);
    expect(Date.now() - started).toBeLessThan(4_000);
    // The thread that runs everything else was free the whole time.
    expect(ticks).toBeGreaterThan(5);
  });

  it("fails when the thread stops or throws without answering", async () => {
    await expect(onThread(SCRIPT, "exit", null, limits)).rejects.toThrow(/exit code 3/);
    await expect(onThread(SCRIPT, "throw", null, limits)).rejects.toThrow("Broke");
  });
});

describe("how many PDFs are made at once", () => {
  it("lets so many through, has a few more wait their turn in order, and turns the rest away", async () => {
    const turn = gate(2, 1);
    const first = await turn();
    const second = await turn();
    const order: string[] = [];
    const third = turn().then((done) => (order.push("third"), done));
    await expect(turn()).rejects.toBeInstanceOf(Busy);
    expect(order).toEqual([]);
    first();
    // Done twice is done once: it doesn't let two more in.
    first();
    const thirdDone = await third;
    expect(order).toEqual(["third"]);
    const fourth = turn();
    await expect(turn()).rejects.toBeInstanceOf(Busy);
    second();
    thirdDone();
    (await fourth)();
    // All done: two at once again, and the next one waits.
    const a = await turn();
    const b = await turn();
    let waited = false;
    const c = turn().then((done) => ((waited = true), done));
    await Promise.resolve();
    expect(waited).toBe(false);
    a();
    (await c)();
    b();
    expect(waited).toBe(true);
  });
});
