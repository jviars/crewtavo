// Run by pdfThreads.test.ts on a thread of its own (pdf/threads.ts onThread), as the PDF's is: it
// answers the message it's sent with that and its workerData, or for "spin" keeps busy for good,
// for "exit" stops, and for "throw" fails.
import { parentPort, workerData } from "node:worker_threads";

parentPort.once("message", (message) => {
  if (message === "spin") for (;;);
  if (message === "exit") process.exit(3);
  if (message === "throw") throw new Error("Broke");
  parentPort.postMessage({ echo: message, data: workerData });
});
