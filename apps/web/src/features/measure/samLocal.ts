/**
 * Find paving for free, on this device: Meta's SAM 2.1 (the tiny one, Apache-2.0, as exported for
 * browsers by Hugging Face's onnx-community) runs in the browser with onnxruntime-web, so nothing is
 * sent anywhere and there's no account or key. It replaced SlimSAM, which answered a tap on a lot
 * with either every paved surface around it (the road and the neighbors' lots too) or a scrap of it.
 *
 * The picture of the map goes through the image encoder once per view; each tap or box is then a
 * prompt through the small decoder (a tenth of a second), which answers with three guesses (masks)
 * on a 256 × 256 grid over the picture, each with how sure it is. Where the browser can use the
 * graphics card (WebGPU: Chrome, Edge, Safari 26), the half-precision encoder runs on it (67 MB,
 * well under a second); otherwise the 8-bit one runs on the processor (53 MB, a few seconds). The
 * 8-bit decoder (9 MB) runs on the processor either way. The files download from Hugging Face the
 * first time (pinned to one revision) and stay in the browser's cache after that.
 */
import type { InferenceSession, Tensor } from "onnxruntime-web";

const MODEL = "https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX/resolve/814a066640debee5a91e70aa401fb8e17e030503/onnx";
/** Each is a graph (.onnx) with its weights beside it (.onnx_data). */
const FILES = { gpu: "vision_encoder_fp16", cpu: "vision_encoder_quantized", decoder: "prompt_encoder_mask_decoder_quantized" };
const CACHE = "crewtavo-models-v2";
/** The square the model sees: any picture is stretched to it, the way SAM 2 was trained. */
export const SAM_SIZE = 1024;
/** The masks' grid, over the whole picture. */
export const SAM_GRID = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Ort = typeof import("onnxruntime-web");
export interface Sam {
  ort: Ort;
  encoder: InferenceSession;
  decoder: InferenceSession;
  device: "gpu" | "cpu";
  /** Why it's on the processor (about 30 times slower), to say so: no WebGPU, or the card wouldn't run it. */
  slow?: "no-webgpu" | "gpu-failed";
}
let loading: Promise<Sam> | null = null;

/** Bytes downloaded so far and the total, while the model is fetched the first time. */
export type Progress = (loaded: number, total: number) => void;

async function modelBytes(url: string, progress: Progress, done: { loaded: number; total: number }): Promise<Uint8Array> {
  const cache = await caches.open(CACHE).catch(() => null);
  const cached = await cache?.match(url);
  const res = cached ?? (await fetch(url));
  if (!res.ok) throw new Error("Couldn't download the paving model. Check the internet connection and try again.");
  const size = Number(res.headers.get("content-length")) || 0;
  done.total += size;
  const reader = res.clone().body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    parts.push(value);
    done.loaded += value.length;
    progress(done.loaded, done.total);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  // Kept so the next time is instant and works offline.
  if (!cached) await cache?.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return bytes;
}

/** A graph and its weights. */
async function modelFiles(name: string, progress: Progress, done: { loaded: number; total: number }) {
  const [graph, weights] = await Promise.all([modelBytes(`${MODEL}/${name}.onnx`, progress, done), modelBytes(`${MODEL}/${name}.onnx_data`, progress, done)]);
  return { name, graph, weights };
}

/** A graph and its weights as a session on the given device. */
function session(ort: Ort, { name, graph, weights }: Awaited<ReturnType<typeof modelFiles>>, device: "webgpu" | "wasm") {
  // Errors only: not its notes on which steps it keeps on the processor.
  return ort.InferenceSession.create(graph, { executionProviders: [device], graphOptimizationLevel: "all", logSeverityLevel: 3, externalData: [{ path: `${name}.onnx_data`, data: weights }] });
}

/** Whether the browser offers WebGPU, so the model can run on the graphics card. */
export async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

async function load(device: "gpu" | "cpu", progress: Progress): Promise<Sam> {
  // The WebGPU build of the runtime is a bigger file; only browsers that can use it fetch it.
  const [ort, wasm] =
    device === "gpu"
      ? await Promise.all([import("onnxruntime-web/webgpu"), import("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url")])
      : await Promise.all([import("onnxruntime-web/wasm"), import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url")]);
  ort.env.wasm.wasmPaths = { wasm: wasm.default };
  ort.env.logLevel = "error";
  // Several threads need the page to be cross-origin isolated, which an instance isn't.
  ort.env.wasm.numThreads = 1;
  const done = { loaded: 0, total: 0 };
  const [encoderFiles, decoderFiles] = await Promise.all([modelFiles(device === "gpu" ? FILES.gpu : FILES.cpu, progress, done), modelFiles(FILES.decoder, progress, done)]);
  // One at a time: two sessions starting together both try to start the runtime, and the second fails.
  const encoder = await session(ort, encoderFiles, device === "gpu" ? "webgpu" : "wasm");
  const decoder = await session(ort, decoderFiles, "wasm");
  return { ort, encoder, decoder, device };
}

/** The model, loaded once per page (downloaded once per browser), on the graphics card when it can be. */
export function loadSam(progress: Progress = () => {}): Promise<Sam> {
  loading ??= (async (): Promise<Sam> => {
    void caches.delete("crewtavo-models-v1").catch(() => {}); // SlimSAM, which this replaced
    // On the processor it still works, just slower, and the banner says so (TapOutline.tsx).
    if (!(await hasWebGpu())) return { ...(await load("cpu", progress)), slow: "no-webgpu" };
    try {
      return await load("gpu", progress);
    } catch (error) {
      console.warn("Tap to outline: the graphics card couldn't run the model, so it's on the processor.", error);
      return { ...(await load("cpu", progress)), slow: "gpu-failed" };
    }
  })().catch((error) => {
    loading = null; // try again next time
    throw error;
  });
  return loading;
}

/** A picture run through the encoder: what every prompt on it is decoded against. */
export interface Embedding {
  outputs: Record<string, Tensor>;
  /** The picture's size, in its own pixels (prompts and masks are in these). */
  width: number;
  height: number;
}

/** A SAM_SIZE square of RGBA as the model wants it: RGB scaled to 0–1 and normalized, by channel. */
export function pixelValues(rgba: Uint8ClampedArray): Float32Array {
  const plane = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) out[c * plane + i] = (rgba[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  return out;
}

/** Runs a picture through the encoder (stretched to the model's square). */
export async function embed(sam: Sam, picture: HTMLCanvasElement): Promise<Embedding> {
  const square = document.createElement("canvas");
  square.width = square.height = SAM_SIZE;
  const ctx = square.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read the map picture.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(picture, 0, 0, SAM_SIZE, SAM_SIZE);
  const input = new sam.ort.Tensor("float32", pixelValues(ctx.getImageData(0, 0, SAM_SIZE, SAM_SIZE).data), [1, 3, SAM_SIZE, SAM_SIZE]);
  const outputs = (await sam.encoder.run({ [sam.encoder.inputNames[0]]: input })) as Record<string, Tensor>;
  return { outputs, width: picture.width, height: picture.height };
}

export interface Point { x: number; y: number; positive: boolean }
/** What the model is asked about, in picture pixels: some points, a box around the thing, or both. */
export interface Prompt { points: Point[]; box?: [number, number, number, number] | null }
export interface Answers {
  /** The model's scores for each guess, SAM_GRID square (above 0 is in), in the model's order. */
  logits: Float32Array[];
  /** How sure it is of each guess. */
  scores: number[];
  /** Whether it thinks there's anything there at all. */
  found: boolean;
}

/** The model's guesses for a prompt on an embedded picture. */
export async function decode(sam: Sam, e: Embedding, { points, box }: Prompt): Promise<Answers> {
  const [sx, sy] = [SAM_SIZE / e.width, SAM_SIZE / e.height];
  const { Tensor } = sam.ort;
  const feeds: Record<string, Tensor> = {
    input_points: new Tensor("float32", new Float32Array(points.flatMap((p) => [p.x * sx, p.y * sy])), [1, 1, points.length, 2]),
    input_labels: new Tensor("int64", new BigInt64Array(points.map((p) => (p.positive ? 1n : 0n))), [1, 1, points.length]),
    input_boxes: box ? new Tensor("float32", new Float32Array([box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]), [1, 1, 4]) : new Tensor("float32", new Float32Array(0), [1, 0, 4]),
  };
  for (const name of sam.decoder.inputNames) if (e.outputs[name]) feeds[name] = e.outputs[name];
  const out = (await sam.decoder.run(feeds)) as Record<string, Tensor>;
  const masks = out.pred_masks;
  const side = masks.dims[masks.dims.length - 1];
  const count = masks.dims[masks.dims.length - 3];
  const data = masks.data as Float32Array;
  const logits = Array.from({ length: count }, (_, i) => resample(data.subarray(i * side * side, (i + 1) * side * side), side));
  const found = out.object_score_logits ? (out.object_score_logits.data as Float32Array)[0] > 0 : true;
  return { logits, scores: Array.from(out.iou_scores.data as Float32Array), found };
}

/** A square grid of scores at SAM_GRID across (the export gives 256 already; this is in case one doesn't). */
function resample(grid: Float32Array, side: number): Float32Array {
  if (side === SAM_GRID) return grid.slice();
  const out = new Float32Array(SAM_GRID * SAM_GRID);
  const f = side / SAM_GRID;
  for (let y = 0; y < SAM_GRID; y++) for (let x = 0; x < SAM_GRID; x++) out[y * SAM_GRID + x] = grid[Math.min(side - 1, Math.floor(y * f)) * side + Math.min(side - 1, Math.floor(x * f))];
  return out;
}

/** How sure the model has to be of a guess for it to be the biggest one picked. */
const FAIRLY_SURE = 0.5;

/**
 * Which guess to use (its index, or -1 with none). To outline: the biggest it's fairly sure of,
 * else the one it's surest of. SAM answers with nested guesses (a speck, the drive aisles, the
 * whole lot; or in a box, the lot without its parked cars and with them) and tends to score the
 * smaller ones highest, but a paving takeoff wants the whole lot (a box keeps it to the lot, and
 * buildings are cut out after). To take something out: the surest, which is the thing under the
 * tap. Smaller and Bigger on the banner step through the rest.
 */
export function pickMask(answers: Array<{ cells: number; score: number }>, { prefer = "biggest" }: { prefer?: "biggest" | "surest" } = {}): number {
  let pick = -1;
  if (prefer === "biggest") {
    answers.forEach((a, i) => {
      if (a.cells > 0 && a.score >= FAIRLY_SURE && (pick < 0 || a.cells > answers[pick].cells)) pick = i;
    });
    if (pick >= 0) return pick;
  }
  answers.forEach((a, i) => {
    if (a.cells > 0 && (pick < 0 || a.score > answers[pick].score)) pick = i;
  });
  return pick;
}
