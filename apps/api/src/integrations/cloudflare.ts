/**
 * Cloudflare, for Settings → Web address: when the owner's domain is on Cloudflare, Crewtavo can
 * add the DNS records Railway asked for, with an API token the owner makes from a pre-filled page
 * (cloudflareTokenUrl in @crewtavo/core). The token is used for this one request and never stored.
 * Records go in as "DNS only": Railway issues the HTTPS certificate itself.
 */
const API = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) throw new CloudflareError("Couldn't reach Cloudflare. Try again in a moment.");
  if (res.status === 401 || res.status === 403) {
    throw new CloudflareError("Cloudflare didn't accept that token. Make it again from the button above (it needs DNS edit for your domain) and paste the whole token.");
  }
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!json?.success) throw new CloudflareError(`Cloudflare said: ${json?.errors?.[0]?.message ?? `error ${res.status}`}`);
  return json.result;
}

export interface CloudflareRecord {
  type: "CNAME" | "TXT" | "A" | "AAAA";
  name: string;
  value: string;
}

const same = (a: string, b: string) => a.toLowerCase().replace(/\.$/, "").replace(/^"|"$/g, "") === b.toLowerCase().replace(/\.$/, "").replace(/^"|"$/g, "");

/**
 * Adds each record to the zone unless it's already there. Never replaces anything: a different
 * record with the same name stops it with what to do, before anything is added.
 */
export async function addCloudflareRecords(token: string, zone: string, records: CloudflareRecord[]): Promise<number> {
  const zones = await call<{ id: string; name: string }[]>(token.trim(), `/zones?name=${encodeURIComponent(zone)}`);
  const zoneId = zones.find((z) => z.name === zone)?.id;
  if (!zoneId) throw new CloudflareError(`That token can't see ${zone}. Make it for "All zones", or pick ${zone} under Zone Resources.`);

  const todo: CloudflareRecord[] = [];
  for (const record of records) {
    const existing = await call<{ type: string; content: string }[]>(token.trim(), `/zones/${zoneId}/dns_records?name=${encodeURIComponent(record.name)}`);
    if (existing.some((e) => e.type === record.type && same(e.content, record.value))) continue;
    // A name with a CNAME can't have anything else, and a TXT name can hold several values.
    const clash = record.type === "TXT" ? null : existing.find((e) => e.type === "CNAME" || ((e.type === "A" || e.type === "AAAA") && record.type === "CNAME"));
    if (clash) {
      throw new CloudflareError(`${record.name} already has a ${clash.type} record in Cloudflare (pointing to ${clash.content}). Delete it there if nothing uses it, or pick a different address, then try again.`);
    }
    todo.push(record);
  }
  for (const record of todo) {
    await call(token.trim(), `/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: record.type, name: record.name, content: record.value, ttl: 1, ...(record.type === "TXT" ? {} : { proxied: false }), comment: "Crewtavo" }),
    });
  }
  return todo.length;
}
