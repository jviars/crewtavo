/**
 * fal.ai: runs Meta's Segment Anything 3 (SAM 3) for a business, on its own fal.ai account and key
 * (Apps → fal.ai), to find pavement and stalls, or a lawn with its trees and play sets, on an aerial picture. The picture goes to fal and
 * the masks come back in the same answer (sync_mode: data URIs), so nothing is kept at fal's end
 * for us to fetch. Each target is one request, half a cent to the business (fal's price, October 2026).
 */
import { serviceUrl, type Env } from "../env";
import { HttpError } from "../lib/http";

export const SAM3_ENDPOINT = "fal-ai/sam-3/image";
type Where = Pick<Env, "LOOKALYKE_URL">;
const runUrl = (env: Where) => `${serviceUrl(env, "fal", "https://fal.run")}/${SAM3_ENDPOINT}`;
const pricingUrl = (env: Where) => `${serviceUrl(env, "fal", "https://api.fal.ai")}/v1/models/pricing?endpoint_id=${encodeURIComponent(SAM3_ENDPOINT)}`;

/** The most masks SAM 3 gives in one answer: fal's schema has `max_masks` from 1 to 32 and refuses more with a 422. */
export const SAM3_MAX_MASKS = 32;

/** What Find everything in view looks for, the words SAM 3 is given for each, and how many masks to ask for (SAM3_MAX_MASKS at most). */
export const DETECT_TARGETS = {
  asphalt: { prompt: "asphalt pavement", masks: 12 },
  concrete: { prompt: "concrete sidewalk", masks: 16 },
  stalls: { prompt: "parking space", masks: 32 },
  lawn: { prompt: "grass lawn", masks: 8 },
  trees: { prompt: "tree", masks: 32 },
  trampolines: { prompt: "trampoline", masks: 6 },
  playsets: { prompt: "playground equipment", masks: 6 },
} as const;
export type DetectTarget = keyof typeof DETECT_TARGETS;

export interface DetectResult {
  target: DetectTarget;
  /** Mask pictures as data URIs, the size of the picture sent: white where the thing is. */
  masks: string[];
  scores: number[];
}
/** A target fal didn't answer for, and why, in a sentence to show. */
export interface DetectFailure {
  target: DetectTarget;
  error: string;
}

type FetchLike = typeof fetch;

/** Messages for what fal.ai says back, for an office manager rather than a developer. */
export function falProblem(status: number, body: string): string {
  if (status === 401) return "fal.ai didn't accept the key on the Apps page. Make a new key at fal.ai and paste it on the fal.ai app's page.";
  if (status === 402 || /balance|credit|billing|payment/i.test(body)) return "Your fal.ai account is out of credit. Add some at fal.ai under Billing, then try again.";
  if (status === 403) return "fal.ai refused the key. Check that it's an API key with access to models, then paste it again.";
  if (status === 429) return "fal.ai is busy right now. Try again in a minute.";
  if (status === 422 || status === 400) {
    // A 422 names what it refused. Only the picture is something zooming can change.
    const refused = refusedInput(body);
    if (refused) return `fal.ai refused part of what Crewtavo asked for (${refused}). Zooming in won't change that.`;
    return "fal.ai couldn't read the map picture. Zoom in a little and try again.";
  }
  return "fal.ai had a problem looking at the aerial. Try again in a minute.";
}

/**
 * What a 422 from fal refused, as "field: its sentence", when that isn't the picture: fal answers
 * { detail: [{ loc: ["body", "max_masks"], msg, type }] }. Null for the picture (loc image_url, or
 * a type like image_load_error or file_download_error) and for an answer with nothing to read.
 */
function refusedInput(body: string): string | null {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown } | null)?.detail;
  } catch {
    return null;
  }
  if (!Array.isArray(detail)) return null;
  for (const entry of detail as Array<{ loc?: unknown; msg?: unknown; type?: unknown }>) {
    const loc = Array.isArray(entry?.loc) ? entry.loc.map(String) : [];
    if (loc.includes("image_url") || /^(image|file)_/.test(String(entry?.type ?? ""))) continue;
    const field = loc.filter((part) => part !== "body").join(".");
    const msg = typeof entry?.msg === "string" ? entry.msg.slice(0, 200) : "";
    if (field || msg) return [field, msg].filter(Boolean).join(": ");
  }
  return null;
}

/** Checks a key with fal.ai's price list, which costs nothing. Returns a sentence to show, or null when it works. */
export async function checkFalKey(env: Where, key: string, fetcher: FetchLike = fetch): Promise<string | null> {
  const res = await fetcher(pricingUrl(env), { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return "Couldn't reach fal.ai to check the key. Check the server's internet connection and try again.";
  if (res.ok) return null;
  if (res.status === 401 || res.status === 403) return "fal.ai didn't accept that key. Copy the whole key from fal.ai (it has a colon in the middle) and paste it again.";
  return `fal.ai couldn't check the key right now (error ${res.status}). Try again in a minute.`;
}

/**
 * Finds each target on the picture (a data:image/jpeg URI). The targets run side by side, and fal
 * charges for each one that answers, so one it refuses doesn't throw the others away: what answered
 * comes back in `results` and the rest in `failed`, each with its reason. It throws only when none answered.
 */
export async function detect(env: Where, key: string, image: string, targets: DetectTarget[], fetcher: FetchLike = fetch): Promise<{ results: DetectResult[]; failed: DetectFailure[] }> {
  const settled = await Promise.allSettled(
    targets.map(async (target): Promise<DetectResult> => {
      const { prompt, masks } = DETECT_TARGETS[target];
      const res = await fetcher(runUrl(env), {
        method: "POST",
        headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: image,
          prompt,
          apply_mask: false,
          sync_mode: true,
          output_format: "png",
          return_multiple_masks: true,
          max_masks: Math.min(masks, SAM3_MAX_MASKS),
          include_scores: true,
        }),
        signal: AbortSignal.timeout(90_000),
      }).catch(() => null);
      if (!res) throw new HttpError(502, "Couldn't reach fal.ai. Try again in a minute.");
      if (!res.ok) throw new HttpError(res.status === 401 || res.status === 402 || res.status === 403 ? 400 : 502, falProblem(res.status, await res.text().catch(() => "")));
      const body = (await res.json().catch(() => ({}))) as { masks?: Array<{ url?: string }>; scores?: number[] };
      const list = body.masks ?? [];
      const urls = await Promise.all(list.map((m) => asDataUri(m.url ?? "", fetcher)));
      const kept = urls.flatMap((url, i) => (url ? [{ url, score: body.scores?.[i] }] : []));
      return { target, masks: kept.map((k) => k.url), scores: kept.map((k) => k.score ?? 1) };
    }),
  );
  const results: DetectResult[] = [];
  const failed: DetectFailure[] = [];
  let first: unknown;
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") return void results.push(outcome.value);
    first ??= outcome.reason;
    failed.push({ target: targets[i]!, error: outcome.reason instanceof HttpError ? outcome.reason.message : "fal.ai had a problem looking at the aerial. Try again in a minute." });
  });
  if (!results.length && failed.length) throw first;
  return { results, failed };
}

/** A mask as a data URI. fal sends them inline when asked; one it hosted instead is read from fal's own servers. */
async function asDataUri(url: string, fetcher: FetchLike): Promise<string | null> {
  if (url.startsWith("data:image/")) return url;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!/(^|\.)fal\.(media|ai|run)$/.test(host)) return null;
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res?.ok) return null;
  const type = res.headers.get("content-type") ?? "image/png";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
