/**
 * Making a PDF takes the processor for as long as it takes. On the server's own thread it would hold
 * up everything else it answers (the API, the database's gateway, the Client Hub, webhooks) until
 * it's done, so PDFs are made on threads of their own (worker_threads): a few at once, each stopped
 * when it takes too long. More wait their turn, up to a point; past it they're told to try again.
 */
import { Worker } from "node:worker_threads";

/** Every place to make one is taken and as many are waiting as may: try again in a moment. */
export class Busy extends Error {
  constructor() {
    super("Too many PDFs are being made at once.");
  }
}

/** It took longer than it may, so its thread was stopped. */
export class TookTooLong extends Error {
  constructor(ms: number) {
    super(`Making the PDF took longer than its ${ms / 1000} s.`);
  }
}

/**
 * Lets `size` through at once and `waiting` more wait their turn, in order; any more are Busy. Each
 * one let through is handed the function to call when it's done, which lets the next one in.
 */
export function gate(size: number, waiting: number): () => Promise<() => void> {
  let running = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    const turn = queue.shift();
    if (turn) turn();
    else running--;
  };
  return async () => {
    if (running < size) running++;
    else if (queue.length < waiting) await new Promise<void>((resolve) => queue.push(resolve));
    else throw new Busy();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      next();
    };
  };
}

export interface ThreadLimits {
  /** How long it may take, from the thread starting to its answer. */
  timeoutMs: number;
  /** The most memory its JavaScript may hold (V8's old generation), in MB: past it, the thread stops. */
  memoryMb: number;
}

/**
 * Runs the script `file` on a thread of its own, sends it `message`, and answers what it posts back.
 * The thread is stopped as soon as it answers, fails, or runs out of time, whatever it's doing.
 */
export function onThread<T>(file: URL, message: unknown, workerData: unknown, limits: ThreadLimits): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(file, { workerData, resourceLimits: { maxOldGenerationSizeMb: limits.memoryMb } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => undefined);
      done();
    };
    timer = setTimeout(() => settle(() => reject(new TookTooLong(limits.timeoutMs))), limits.timeoutMs);
    worker.once("message", (reply: T) => settle(() => resolve(reply)));
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code) => settle(() => reject(new Error(`The PDF's thread stopped before it answered (exit code ${code}).`))));
    worker.postMessage(message);
  });
}
