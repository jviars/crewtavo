/**
 * OpenAI's Responses API, asked with fetch (no SDK), two ways: with a company's own API key
 * (Apps → ChatGPT), and with a person's ChatGPT plan token (integrations/chatgptPlan.ts), which
 * OpenAI serves only as a stream and with fewer fields. services/ai.ts decides which is used and
 * what a problem here means for whoever asked.
 *
 * Nothing here logs or returns a key or a token: a problem carries only what OpenAI called it.
 */
import { serviceUrl, type Env } from "../env";

export const OPENAI_API = "https://api.openai.com/v1";
/** An API key's calls go to Lookalyke's fake while LOOKALYKE_URL is set. A ChatGPT plan's stay with OpenAI: the fake has no ChatGPT sign-in to issue its tokens. */
const keyApi = (env: Pick<Env, "LOOKALYKE_URL">) => `${serviceUrl(env, "openai", "https://api.openai.com")}/v1`;

/** What went wrong, as the rest of the app needs to tell them apart. */
export type OpenAiKind =
  | "key" // the key or token was turned down
  | "model" // the model isn't there for this key or plan
  | "unsupported" // the request holds something this route or model doesn't take (`param` says what)
  | "usage_limit" // a plan's usage limit, or a key's credit or spending limit
  | "not_eligible" // the ChatGPT plan can't be used here
  | "not_allowed" // the sign-in doesn't cover plan use
  | "busy"
  | "unavailable"
  | "timeout"
  | "interrupted" // a stream that stopped before OpenAI said the answer was whole
  | "cut_off"
  | "declined"
  | "empty"
  | "error";

export class OpenAiProblem extends Error {
  override name = "OpenAiProblem";
  constructor(
    readonly kind: OpenAiKind,
    readonly status = 0,
    readonly code: string | null = null,
    readonly param: string | null = null,
  ) {
    super(`OpenAI ${kind}${status ? ` (${status}${code ? `: ${code}` : ""})` : ""}`);
  }
}

const BY_CODE: Record<string, OpenAiKind> = {
  // ChatGPT plan use (developers.openai.com/siwc, Errors and recovery).
  subscription_sharing_usage_limit_exceeded: "usage_limit",
  subscription_sharing_user_not_eligible: "not_eligible",
  subscription_sharing_usage_unavailable: "unavailable",
  subscription_sharing_user_unavailable: "unavailable",
  subscription_sharing_unsupported_capability: "unsupported",
  subscription_sharing_route_not_supported: "error",
  subscription_sharing_invalid_user: "key",
  chatpass_v2_scope_not_authorized: "not_allowed",
  chatpass_v2_invalid_authorization_context: "not_allowed",
  // The API with a key.
  invalid_api_key: "key",
  model_not_found: "model",
  insufficient_quota: "usage_limit",
  credit_balance_exhausted: "usage_limit",
  organization_spend_limit_exceeded: "usage_limit",
  project_spend_limit_exceeded: "usage_limit",
  organization_usage_limit_exceeded: "usage_limit",
  unsupported_parameter: "unsupported",
  unsupported_value: "unsupported",
  rate_limit_exceeded: "busy",
  slow_down: "busy",
  server_is_overloaded: "busy",
};

type ErrorBody = { code?: unknown; type?: unknown; param?: unknown } | null | undefined;

/** A problem from OpenAI's error object (in an error answer, or inside a stream) and the HTTP status it came with. */
export function problemOf(error: ErrorBody, status: number, route: "key" | "plan"): OpenAiProblem {
  const code = typeof error?.code === "string" ? error.code : null;
  const type = typeof error?.type === "string" ? error.type : null;
  const param = typeof error?.param === "string" ? error.param : null;
  const named = (code && BY_CODE[code]) || (type && BY_CODE[type]) || null;
  if (named) return new OpenAiProblem(named, status, code, param);
  let kind: OpenAiKind = "error";
  if (status === 401) kind = "key";
  // With a key, 403 is a key that isn't allowed to do this; on the plan route it's OpenAI's policy.
  else if (status === 403) kind = route === "plan" ? "not_eligible" : "key";
  else if (status === 404) kind = "model";
  else if (status === 429) kind = "busy";
  else if (status === 408 || status === 504) kind = "timeout";
  else if (status >= 500) kind = "unavailable";
  else if (status === 400 && param) kind = param === "model" ? "model" : "unsupported";
  return new OpenAiProblem(kind, status, code, param);
}

async function httpProblem(response: Response, route: "key" | "plan"): Promise<OpenAiProblem> {
  // Before a plan's stream opens the body can be {"detail": "..."} instead: then the status says it.
  const body = (await response.json().catch(() => null)) as { error?: ErrorBody } | null;
  // A 403 that isn't OpenAI's own answer (a proxy's error page) says nothing about the plan.
  if (route === "plan" && response.status === 403 && (!body || typeof body !== "object")) return new OpenAiProblem("unavailable", 403);
  return problemOf(body && typeof body.error === "object" ? body.error : null, response.status, route);
}

/** fetch that gives up, with what went wrong on the way as a problem. */
async function reach(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new OpenAiProblem((error as Error)?.name === "TimeoutError" ? "timeout" : "unavailable");
  }
}

export interface OpenAiAsk {
  model: string;
  system: string;
  prompt: string;
  /** A photo or a PDF to read, as base64. */
  file?: { data: string; mediaType: string };
  /** The JSON schema the answer must follow (structured outputs). */
  schema?: Record<string, unknown>;
  /** False sends the schema without strict mode, for one strict mode turned down. */
  strict?: boolean;
  /** Null leaves reasoning effort out, for a model that doesn't take it. */
  effort: "low" | "medium" | "high" | null;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Room for a reasoning model to think before it answers: OpenAI counts that against
 * max_output_tokens too, so a short answer's allowance alone could all go on thinking.
 */
const REASONING_ROOM = 2000;

/**
 * The Responses request for an ask. The system text goes in `instructions` and nothing is kept at
 * OpenAI (`store: false`), on both routes. The plan route must stream and refuses a list of fields,
 * max_output_tokens among them, so the answer's length is the model's own there.
 */
export function responsesBody(ask: OpenAiAsk, route: "key" | "plan"): Record<string, unknown> {
  const content = ask.file
    ? [
        ask.file.mediaType === "application/pdf"
          ? { type: "input_file", filename: "document.pdf", file_data: `data:application/pdf;base64,${ask.file.data}` }
          : { type: "input_image", image_url: `data:${ask.file.mediaType};base64,${ask.file.data}` },
        { type: "input_text", text: ask.prompt },
      ]
    : ask.prompt;
  return {
    model: ask.model,
    instructions: ask.system,
    input: [{ role: "user", content }],
    store: false,
    ...(ask.effort ? { reasoning: { effort: ask.effort } } : {}),
    ...(ask.schema ? { text: { format: { type: "json_schema", name: "answer", schema: ask.schema, strict: ask.strict !== false } } } : {}),
    ...(route === "plan" ? { stream: true } : { max_output_tokens: ask.maxTokens + (ask.effort ? REASONING_ROOM : 0) }),
  };
}

interface ResponseObject {
  status?: string;
  error?: ErrorBody;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
}

/** The text of a finished response; anything less than a whole answer is a problem. `streamed`: the text its stream carried, when the response itself holds none. */
export function answerOf(response: ResponseObject | null | undefined, route: "key" | "plan", streamed = ""): string {
  if (response?.status === "failed") throw problemOf(response.error, 200, route);
  if (response?.status === "incomplete") throw new OpenAiProblem(response.incomplete_details?.reason === "content_filter" ? "declined" : "cut_off", 200);
  const parts = (response?.output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const text = (parts.filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("") || streamed).trim();
  if (!text && parts.some((part) => part.type === "refusal")) throw new OpenAiProblem("declined", 200);
  if (!text) throw new OpenAiProblem("empty", 200);
  return text;
}

const headers = (bearer: string) => ({ Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" });

/** Ask with a company's API key: one request, one answer. */
export async function askWithKey(env: Pick<Env, "LOOKALYKE_URL">, apiKey: string, ask: OpenAiAsk): Promise<string> {
  const response = await reach(`${keyApi(env)}/responses`, { method: "POST", headers: headers(apiKey), body: JSON.stringify(responsesBody(ask, "key")) }, ask.timeoutMs);
  if (!response.ok) throw await httpProblem(response, "key");
  return answerOf((await response.json().catch(() => null)) as ResponseObject | null, "key");
}

/**
 * Ask with a person's ChatGPT plan token. The answer arrives as a stream of events and counts only
 * once `response.completed` has come: a failure (the usage limit, for one) can arrive partway
 * through, and a stream that just stops is not an answer.
 */
export async function askWithPlan(accessToken: string, ask: OpenAiAsk): Promise<string> {
  const response = await reach(
    `${OPENAI_API}/responses`,
    { method: "POST", headers: { ...headers(accessToken), Accept: "text/event-stream" }, body: JSON.stringify(responsesBody(ask, "plan")) },
    ask.timeoutMs,
  );
  if (!response.ok) throw await httpProblem(response, "plan");
  if (!response.body) throw new OpenAiProblem("interrupted", response.status);
  return readStream(response.body);
}

interface StreamEvent {
  type?: string;
  delta?: unknown;
  response?: ResponseObject;
  code?: unknown;
  param?: unknown;
  error?: ErrorBody;
}

/** The answer a Responses event stream carries (server-sent events), or the problem it ended in. */
export async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let refused = false;
  /** Takes one event in: the finished response once `response.completed` arrives, null until then. */
  const take = (block: string): ResponseObject | null => {
    let named = "";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) named = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length || data[0] === "[DONE]") return null;
    let event: StreamEvent;
    try {
      event = JSON.parse(data.join("\n")) as StreamEvent;
    } catch {
      return null;
    }
    const type = event.type ?? named;
    if (type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
    else if (type === "response.refusal.delta" || type === "response.refusal.done") refused = true;
    else if (type === "response.failed") throw problemOf(event.response?.error, 200, "plan");
    else if (type === "response.incomplete") throw new OpenAiProblem(event.response?.incomplete_details?.reason === "content_filter" ? "declined" : "cut_off", 200);
    else if (type === "error") throw problemOf(event.error ?? event, 200, "plan");
    else if (type === "response.completed") return event.response ?? {};
    return null;
  };
  try {
    for (;;) {
      let done = false;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (error) {
        throw new OpenAiProblem((error as Error)?.name === "TimeoutError" ? "timeout" : "interrupted");
      }
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : (blocks.pop() ?? "");
      for (const block of blocks) {
        const completed = take(block);
        if (!completed) continue;
        if (refused && !text.trim()) throw new OpenAiProblem("declined", 200);
        return answerOf({ ...completed, status: "completed" }, "plan", text);
      }
      if (done) throw new OpenAiProblem("interrupted", 200);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** OpenAI's models that write out speech, best fit first: the small GPT-4o one, else Whisper, which every key has had. */
export const TRANSCRIBE_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"] as const;

/**
 * A recording written out with a company's API key (POST /v1/audio/transcriptions): its words, or
 * "" when there were none to hear. `language` (ISO 639-1, "en") helps when it's known. A model the
 * key can't use is a problem of kind "model", so the caller can try the next.
 */
export async function transcribeWithKey(
  env: Pick<Env, "LOOKALYKE_URL">,
  apiKey: string,
  audio: { body: Blob; fileName: string },
  options: { model: string; language?: string | null; timeoutMs: number },
): Promise<string> {
  const form = new FormData();
  form.append("file", audio.body, audio.fileName);
  form.append("model", options.model);
  form.append("response_format", "json");
  if (options.language) form.append("language", options.language);
  const response = await reach(`${keyApi(env)}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form }, options.timeoutMs);
  if (!response.ok) throw await httpProblem(response, "key");
  const json = (await response.json().catch(() => null)) as { text?: unknown } | null;
  return typeof json?.text === "string" ? json.text.trim() : "";
}

export interface OpenAiModel {
  slug: string;
  display_name: string;
}

/**
 * OpenAI's general-purpose models as of November 2026, best fit first, used only to choose which of
 * the models OpenAI lists is ticked to begin with: GPT-6.1 Sol is what its documentation calls the
 * balance of intelligence and cost. The admin or the person can pick any other listed model, and
 * OPENAI_MODEL in the environment overrides them all.
 */
const PREFERRED_MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"];

/** Model ids the API lists that don't answer in text: left out of the list an admin picks from. */
const NOT_TEXT = /embedding|whisper|tts|dall-e|image|audio|realtime|transcribe|moderation|sora|babbage|davinci|computer-use|search/i;

/**
 * The model to use: OPENAI_MODEL when the deployment sets it, else the one saved while OpenAI still
 * lists it, else the first of the preferred ones it lists, else the first it lists. Null with nothing listed.
 */
export function pickModel(env: Env, models: readonly OpenAiModel[], saved?: string | null): string | null {
  if (env.OPENAI_MODEL) return env.OPENAI_MODEL;
  if (saved && models.some((m) => m.slug === saved)) return saved;
  return PREFERRED_MODELS.find((slug) => models.some((m) => m.slug === slug)) ?? models[0]?.slug ?? null;
}

async function list(api: string, bearer: string, route: "key" | "plan"): Promise<Record<string, unknown>> {
  const response = await reach(`${api}/models`, { headers: { Authorization: `Bearer ${bearer}` } }, 15_000);
  if (!response.ok) throw await httpProblem(response, route);
  return ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
}

/** The text models a key can use (GET /v1/models costs nothing), the preferred ones first, then newest first. */
export async function listKeyModels(env: Pick<Env, "LOOKALYKE_URL">, apiKey: string): Promise<OpenAiModel[]> {
  const data = ((await list(keyApi(env), apiKey, "key")).data ?? []) as Array<{ id?: unknown; created?: unknown }>;
  const rank = (slug: string) => (PREFERRED_MODELS.includes(slug) ? PREFERRED_MODELS.indexOf(slug) : PREFERRED_MODELS.length);
  return data
    .filter((m): m is { id: string; created?: unknown } => typeof m.id === "string" && m.id.length <= 200 && !NOT_TEXT.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || Number(b.created ?? 0) - Number(a.created ?? 0) || a.id.localeCompare(b.id))
    .slice(0, 200)
    .map((m) => ({ slug: m.id, display_name: m.id }));
}

/** The models a ChatGPT plan offers here, in OpenAI's order: the ones marked for listing, by the name OpenAI shows. */
export async function listPlanModels(accessToken: string): Promise<OpenAiModel[]> {
  const models = ((await list(OPENAI_API, accessToken, "plan")).models ?? []) as Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
  return models
    .filter((m): m is { slug: string; display_name?: unknown; visibility: "list" } => m.visibility === "list" && typeof m.slug === "string" && m.slug.length > 0 && m.slug.length <= 200)
    .slice(0, 200)
    .map((m) => ({ slug: m.slug, display_name: typeof m.display_name === "string" && m.display_name.trim() ? m.display_name.trim().slice(0, 200) : m.slug }));
}

/**
 * Whether an OpenAI key works, asked of OpenAI before it's saved or a feature that spends it is
 * turned on: the models it can use, or what to fix. Listing models costs nothing.
 */
export async function checkOpenAiKey(env: Pick<Env, "LOOKALYKE_URL">, apiKey: string): Promise<{ models: OpenAiModel[] } | { problem: string }> {
  try {
    const models = await listKeyModels(env, apiKey);
    if (!models.length) return { problem: "That OpenAI key can't use any of OpenAI's text models. Check the key's project and permissions at platform.openai.com." };
    return { models };
  } catch (error) {
    if (!(error instanceof OpenAiProblem)) throw error;
    if (error.status === 403) return { problem: "That OpenAI key isn't allowed to list models. Give it All permissions, or Read on Models, at platform.openai.com/api-keys." };
    if (error.kind === "key") return { problem: "OpenAI turned the key down. Check that it was copied correctly, or make a new one at platform.openai.com/api-keys." };
    if (error.kind === "busy") return { problem: "OpenAI is busy right now. Try again in a minute." };
    return { problem: "Crewtavo couldn't reach OpenAI to check the key. Try again in a minute." };
  }
}
