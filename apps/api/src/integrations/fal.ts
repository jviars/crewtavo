/**
 * fal.ai: runs Meta's Segment Anything 3 (SAM 3) for a business, on its own fal.ai account and key
 * (Apps → fal.ai), to find pavement and stalls on an aerial picture. The picture goes to fal and
 * the masks come back in the same answer (sync_mode: data URIs), so nothing is kept at fal's end
 * for us to fetch. Each request costs the business half a cent (fal's price, October 2026).
 */
import { HttpError } from "../lib/http";

export const SAM3_ENDPOINT = "fal-ai/sam-3/image";
const RUN_URL = `https://fal.run/${SAM3_ENDPOINT}`;
const PRICING_URL = `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(SAM3_ENDPOINT)}`;

/** What Find paving looks for, and the words SAM 3 is given for each. */
export const DETECT_TARGETS = {
  asphalt: { prompt: "asphalt pavement", masks: 12 },
  concrete: { prompt: "concrete sidewalk", masks: 16 },
  stalls: { prompt: "parking space", masks: 32 },
} as const;
export type DetectTarget = keyof typeof DETECT_TARGETS;

export interface DetectResult {
  target: DetectTarget;
  /** Mask pictures as data URIs, the size of the picture sent: white where the thing is. */
  masks: string[];
  scores: number[];
}

type FetchLike = typeof fetch;

/** Messages for what fal.ai says back, for an office manager rather than a developer. */
export function falProblem(status: number, body: string): string {
  if (status === 401) return "fal.ai didn't accept the key on the Apps page. Make a new key at fal.ai and paste it on the fal.ai app's page.";
  if (status === 402 || /balance|credit|billing|payment/i.test(body)) return "Your fal.ai account is out of credit. Add some at fal.ai under Billing, then try again.";
  if (status === 403) return "fal.ai refused the key. Check that it's an API key with access to models, then paste it again.";
  if (status === 429) return "fal.ai is busy right now. Try again in a minute.";
  if (status === 422 || status === 400) return "fal.ai couldn't read the map picture. Zoom in a little and try again.";
  return "fal.ai had a problem finding paving. Try again in a minute.";
}

/** Checks a key with fal.ai's price list, which costs nothing. Returns a sentence to show, or null when it works. */
export async function checkFalKey(key: string, fetcher: FetchLike = fetch): Promise<string | null> {
  const res = await fetcher(PRICING_URL, { headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return "Couldn't reach fal.ai to check the key. Check the server's internet connection and try again.";
  if (res.ok) return null;
  if (res.status === 401 || res.status === 403) return "fal.ai didn't accept that key. Copy the whole key from fal.ai (it has a colon in the middle) and paste it again.";
  return `fal.ai couldn't check the key right now (error ${res.status}). Try again in a minute.`;
}

/** Finds each target on the picture (a data:image/jpeg URI). The targets run side by side. */
export async function detect(key: string, image: string, targets: DetectTarget[], fetcher: FetchLike = fetch): Promise<DetectResult[]> {
  return Promise.all(
    targets.map(async (target) => {
      const { prompt, masks } = DETECT_TARGETS[target];
      const res = await fetcher(RUN_URL, {
        method: "POST",
        headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: image,
          prompt,
          apply_mask: false,
          sync_mode: true,
          output_format: "png",
          return_multiple_masks: true,
          max_masks: masks,
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
