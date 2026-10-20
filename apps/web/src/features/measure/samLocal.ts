/**
 * Find paving for free, on this device: SlimSAM (a small Segment Anything, Apache-2.0, from Hugging
 * Face's Xenova/slimsam-77-uniform) runs in the browser with onnxruntime-web, so nothing is sent
 * anywhere and there's no account or key. The model (about 14 MB) downloads from Hugging Face the
 * first time and stays in the browser's cache after that.
 *
 * A picture of the map goes through the image encoder once per view (a second or two); each tap is
 * then a point prompt through the small decoder (a few hundredths of a second), which answers with
 * three masks of different sizes on a 256 × 256 grid over the 1024 px picture: the same grid
 * detect.ts turns into outlines.
 */
import type { InferenceSession, Tensor } from "onnxruntime-web";

const MODEL = "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx";
const FILES = { encoder: `${MODEL}/vision_encoder_quantized.onnx`, decoder: `${MODEL}/prompt_encoder_mask_decoder_quantized.onnx` };
const CACHE = "crewtavo-models-v1";
/** The picture's longest side, and the padded square the model sees. */
export const SAM_SIZE = 1024;
/** The masks' grid: one cell is 4 × 4 picture pixels. */
export const SAM_GRID = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Ort = typeof import("onnxruntime-web");
interface Sam { ort: Ort; encoder: InferenceSession; decoder: InferenceSession }
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

/** The model, loaded once per page (downloaded once per browser). */
export function loadSam(progress: Progress = () => {}): Promise<Sam> {
  loading ??= (async () => {
    const [ort, wasm] = await Promise.all([import("onnxruntime-web/wasm"), import("onnxruntime-web/ort-wasm-simd-threaded.wasm?url")]);
    ort.env.wasm.wasmPaths = { wasm: wasm.default };
    // Several threads need the page to be cross-origin isolated, which an instance isn't.
    ort.env.wasm.numThreads = 1;
    const done = { loaded: 0, total: 0 };
    const [encoder, decoder] = await Promise.all([modelBytes(FILES.encoder, progress, done), modelBytes(FILES.decoder, progress, done)]);
    const options: InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    return { ort, encoder: await ort.InferenceSession.create(encoder, options), decoder: await ort.InferenceSession.create(decoder, options) };
  })().catch((error) => {
    loading = null; // try again next time
    throw error;
  });
  return loading;
}

/** A picture run through the encoder: what every tap on it is decoded against. */
export interface Embedding {
  outputs: Record<string, Tensor>;
  /** The picture's size (its longest side is SAM_SIZE). */
  width: number;
  height: number;
}

/** The picture as the model wants it: RGB scaled to 0–1, normalized, top-left in a padded 1024 square. */
export function pixelValues(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const plane = SAM_SIZE * SAM_SIZE;
  const out = new Float32Array(3 * plane); // the padding stays 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = y * SAM_SIZE + x;
      for (let c = 0; c < 3; c++) out[c * plane + o] = (rgba[i + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  return out;
}

/** Runs the picture (longest side SAM_SIZE) through the encoder. */
export async function embed(sam: Sam, canvas: HTMLCanvasElement): Promise<Embedding> {
  const { width, height } = canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser can't read the map picture.");
  const pixels = pixelValues(ctx.getImageData(0, 0, width, height).data, width, height);
  const input = new sam.ort.Tensor("float32", pixels, [1, 3, SAM_SIZE, SAM_SIZE]);
  const outputs = (await sam.encoder.run({ [sam.encoder.inputNames[0]]: input })) as Record<string, Tensor>;
  return { outputs, width, height };
}

export interface Point { x: number; y: number; positive: boolean }
export interface Masks {
  /** One grid per mask (SAM_GRID square, 1 where it is), in the model's order (not by size). */
  grids: Uint8Array[];
  scores: number[];
}

/** Masks for some points on an embedded picture (in picture pixels). */
export async function masksAt(sam: Sam, e: Embedding, points: Point[]): Promise<Masks> {
  const coords = new Float32Array(points.flatMap((p) => [p.x, p.y]));
  const labels = new BigInt64Array(points.map((p) => (p.positive ? 1n : 0n)));
  const feeds: Record<string, Tensor> = {
    input_points: new sam.ort.Tensor("float32", coords, [1, 1, points.length, 2]),
    input_labels: new sam.ort.Tensor("int64", labels, [1, 1, points.length]),
  };
  for (const name of sam.decoder.inputNames) if (e.outputs[name]) feeds[name] = e.outputs[name];
  const out = (await sam.decoder.run(feeds)) as Record<string, Tensor>;
  const maskName = sam.decoder.outputNames.find((n) => /mask/i.test(n)) ?? sam.decoder.outputNames[0];
  const scoreName = sam.decoder.outputNames.find((n) => /iou|score/i.test(n)) ?? sam.decoder.outputNames[1];
  return maskGrids(out[maskName].data as Float32Array, out[maskName].dims as number[], Array.from(out[scoreName].data as Float32Array), e.width, e.height);
}

/**
 * The decoder's low-resolution masks (logits, [.., masks, 256, 256] over the padded square) as
 * on/off grids, with the padding beyond the picture left off.
 */
export function maskGrids(logits: Float32Array, dims: number[], scores: number[], width: number, height: number): Masks {
  const side = dims[dims.length - 1];
  const count = dims[dims.length - 3] ?? 1;
  const scale = SAM_SIZE / side;
  const [cols, rows] = [Math.ceil(width / scale), Math.ceil(height / scale)];
  const grids: Uint8Array[] = [];
  for (let m = 0; m < count; m++) {
    const grid = new Uint8Array(SAM_GRID * SAM_GRID);
    const base = m * side * side;
    for (let y = 0; y < Math.min(rows, side); y++) {
      for (let x = 0; x < Math.min(cols, side); x++) {
        if (logits[base + y * side + x] > 0) grid[Math.floor((y * SAM_GRID) / side) * SAM_GRID + Math.floor((x * SAM_GRID) / side)] = 1;
      }
    }
    grids.push(grid);
  }
  return { grids, scores: scores.slice(0, count) };
}

/** How sure the model has to be of an answer for a tap to start on it. */
const FAIRLY_SURE = 0.5;

/**
 * Which of the model's answers to use for a tap on pavement (its index, or -1 with none): the
 * biggest it's fairly sure of, else the one it's surest of. SAM answers a tap with a few nested
 * guesses (a speck, the drive aisles, the whole lot) and tends to score the speck highest, but a
 * paving takeoff wants the whole lot. Smaller and Bigger on the banner step through the rest.
 */
export function pickMask(answers: Array<{ cells: number; score: number }>): number {
  let pick = -1;
  answers.forEach((a, i) => {
    if (a.cells > 0 && a.score >= FAIRLY_SURE && (pick < 0 || a.cells > answers[pick].cells)) pick = i;
  });
  if (pick >= 0) return pick;
  answers.forEach((a, i) => {
    if (a.cells > 0 && (pick < 0 || a.score > answers[pick].score)) pick = i;
  });
  return pick;
}
