/**
 * The sign-in server's discovery document (RFC 8414 authorization server metadata, or OpenID
 * Connect discovery), the way AI assistants' connectors need it to sign in to Crewtavo.
 *
 * An instance's Supabase Auth has no issuer set (GOTRUE_JWT_ISSUER), so its own document has an
 * empty issuer and endpoints that are bare paths (/oauth/authorize), which no client can use, and
 * ChatGPT refuses an issuer that isn't the address it was told. It also lists the openid scope, but
 * Auth only signs ID tokens with an RS256 or ES256 key and an instance signs with its HS256
 * JWT_SECRET: a client that asks for openid (ChatGPT asks for every OpenID scope listed) gets
 * "Error generating ID token" at the very last step. So Crewtavo serves the document fixed: the
 * issuer the connector was given, full endpoint addresses, and openid only when Auth can sign ID
 * tokens. That holds for every instance, old ones included, without changing Auth's settings. A
 * Supabase project's own document is already right, and comes back as it was.
 */

type Metadata = Record<string, unknown>;

/** The document with `issuer` filled in where Auth left it empty, and without openid if ID tokens can't be signed. */
export function fixAuthMetadata(metadata: Metadata, issuer: string, signsIdTokens: boolean): Metadata {
  const own = typeof metadata.issuer === "string" && metadata.issuer ? metadata.issuer.replace(/\/$/, "") : issuer.replace(/\/$/, "");
  const fixed: Metadata = { ...metadata, issuer: own };
  for (const [key, value] of Object.entries(metadata)) {
    if ((key.endsWith("_endpoint") || key === "jwks_uri") && typeof value === "string" && value.startsWith("/")) fixed[key] = own + value;
  }
  if (!signsIdTokens && Array.isArray(metadata.scopes_supported)) fixed.scopes_supported = metadata.scopes_supported.filter((s) => s !== "openid");
  return fixed;
}

const signing = new Map<string, { at: number; value: boolean }>();

/**
 * Whether Auth can sign ID tokens: its JWKS has a public key (RSA or EC). With only the HS256
 * secret, which is never published, it's empty. Remembered for 10 minutes; a JWKS that doesn't
 * answer counts as no.
 */
export async function signsIdTokens(jwksUrl: string): Promise<boolean> {
  const cached = signing.get(jwksUrl);
  if (cached && Date.now() - cached.at < 600_000) return cached.value;
  const keys = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000) })
    .then((res) => (res.ok ? (res.json() as Promise<{ keys?: Array<{ kty?: string }> }>) : null))
    .catch(() => null);
  const value = Boolean(keys?.keys?.some((k) => k.kty && k.kty !== "oct"));
  signing.set(jwksUrl, { at: Date.now(), value });
  return value;
}

/** The first of these that answers with JSON, fixed; null when none does. `auth` is where Auth answers, for its JWKS. */
export async function authMetadata(urls: string[], auth: string, issuer: string): Promise<Metadata | null> {
  for (const url of urls) {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
    if (upstream?.ok && upstream.headers.get("content-type")?.includes("json")) {
      return fixAuthMetadata((await upstream.json()) as Metadata, issuer, await signsIdTokens(`${auth.replace(/\/$/, "")}/.well-known/jwks.json`));
    }
  }
  return null;
}

/**
 * A sign-in that asks for openid when Auth can't sign ID tokens, without it: Auth would otherwise
 * take the person all the way through consent and then fail. Null when there's nothing to change.
 */
export function withoutOpenId(url: URL): URL | null {
  const scope = url.searchParams.get("scope");
  if (!scope || !scope.split(/\s+/).includes("openid")) return null;
  const next = new URL(url);
  const rest = scope.split(/\s+/).filter((s) => s && s !== "openid");
  if (rest.length) next.searchParams.set("scope", rest.join(" "));
  else next.searchParams.delete("scope");
  return next;
}
