/**
 * The thread an estimate's or invoice's PDF is made on (services/documentPdf.ts), bundled next to
 * the server as pdf-worker.mjs (scripts/build-server.mjs). It makes one PDF, from the one job it's
 * sent, and answers with its bytes or what went wrong; the server then stops it, or stops it sooner
 * when it takes too long.
 */
import { parentPort, workerData } from "node:worker_threads";
import { renderDocument, type RenderJob } from "./render";

const { fonts } = workerData as { fonts: string };

parentPort?.once("message", async (job: RenderJob) => {
  try {
    // Its own copy, handed over whole rather than copied again.
    const pdf = new Uint8Array(await renderDocument(job, fonts));
    parentPort!.postMessage({ pdf }, [pdf.buffer as ArrayBuffer]);
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
