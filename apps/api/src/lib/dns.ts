/**
 * DNS checks for Settings → Web address: which provider hosts a domain's DNS, and whether each
 * record the owner was asked to add is there yet, with what to fix when it isn't. Lookups go to
 * public resolvers (Cloudflare's and Google's) rather than the host's, so a record shows up as soon
 * as the internet can see it, not when a local cache expires.
 */
import { Resolver } from "node:dns/promises";
import { hostLabel, providerById, type DnsRecordCheck } from "@crewtavo/core";

/** One DNS question; empty when the name has no such record (or the lookup failed). */
export interface Lookup {
  cname(name: string): Promise<string[]>;
  txt(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  aaaa(name: string): Promise<string[]>;
  ns(name: string): Promise<string[]>;
}

const bare = (name: string) => name.toLowerCase().replace(/\.$/, "");

export function publicLookup(): Lookup {
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const quiet = <T>(work: Promise<T[]>) => work.catch(() => [] as T[]);
  return {
    cname: (name) => quiet(resolver.resolveCname(name)).then((r) => r.map(bare)),
    // A TXT record can arrive in several chunks; they're one value.
    txt: (name) => quiet(resolver.resolveTxt(name)).then((r) => r.map((chunks) => chunks.join(""))),
    a: (name) => quiet(resolver.resolve4(name)),
    aaaa: (name) => quiet(resolver.resolve6(name)),
    ns: (name) => quiet(resolver.resolveNs(name)).then((r) => r.map(bare)),
  };
}

/** The domain whose DNS holds `name`'s records (example.com for app.example.com), and its nameservers. */
export async function findZone(lookup: Lookup, name: string): Promise<{ zone: string; nameservers: string[] } | null> {
  const labels = bare(name).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    const nameservers = await lookup.ns(candidate);
    // A name that points elsewhere (CNAME) answers with the target's nameservers, not its own.
    if (nameservers.length && !(await lookup.cname(candidate)).length) return { zone: candidate, nameservers };
  }
  return null;
}

/** What `name` points at right now, for "that name is already in use" warnings. */
export async function currentTarget(lookup: Lookup, name: string): Promise<string | null> {
  const [cname] = await lookup.cname(name);
  if (cname) return cname;
  const addresses = [...(await lookup.a(name)), ...(await lookup.aaaa(name))];
  return addresses.length ? addresses.join(", ") : null;
}

export interface WantedRecord {
  type: DnsRecordCheck["type"];
  purpose: DnsRecordCheck["purpose"];
  name: string;
  host?: string;
  /** Null when only Railway knows it: any CNAME to Railway counts. */
  value: string | null;
}

const RAILWAY_TARGET = /\.railway\.app$/;

/**
 * Whether one record is in place, and if not, what's wrong in words an owner can act on. `ok`
 * forces it in place (Railway already sees it, whatever our resolvers say).
 */
export async function checkRecord(lookup: Lookup, record: WantedRecord, zone: string | null, providerId: string | null, ok = false): Promise<DnsRecordCheck> {
  const name = bare(record.name);
  const value = record.value === null ? null : record.type === "TXT" ? record.value : bare(record.value);
  const host = record.host ?? hostLabel(name, zone);
  const provider = providerById(providerId);
  const result = (status: DnsRecordCheck["status"], found: string[], hint: string | null = null): DnsRecordCheck =>
    ({ type: record.type, purpose: record.purpose, name, host, value: record.value, status, found, hint });

  let found: string[];
  if (record.type === "CNAME") found = await lookup.cname(name);
  else if (record.type === "TXT") found = await lookup.txt(name);
  else if (record.type === "A") found = await lookup.a(name);
  else found = await lookup.aaaa(name);
  if (ok) return result("ok", found);

  if (record.type === "CNAME") {
    if (found.length) {
      const right = value ? found.includes(value) : found.some((f) => RAILWAY_TARGET.test(f));
      if (right) return result("ok", found);
      return result("wrong", found, `${host} points to ${found[0]}. Change its value to ${value ?? "the one Railway shows"}.`);
    }
    const addresses = await lookup.a(name);
    if (addresses.length) {
      return provider.id === "cloudflare"
        ? result("wrong", addresses, "Cloudflare's proxy (the orange cloud) is on for this record. Switch it to DNS only (grey cloud) so Railway can set up HTTPS.")
        : result("wrong", addresses, `There's an A record for ${host}. Delete it, then add the CNAME record.`);
    }
  } else if (record.type === "TXT") {
    if (value ? found.includes(value) : found.length) return result("ok", found);
    if (found.length) return result("wrong", found, `There's a different TXT value for ${host}. Replace it with the value above.`);
  } else if (found.length) {
    // Self-hosted: any address will do; the new address answering as Crewtavo is the real test.
    return result("ok", found);
  }

  // The classic slip: the whole domain typed where only the first part goes.
  if (zone && name !== zone) {
    const doubled = `${name}.${zone}`;
    const there = record.type === "TXT" ? await lookup.txt(doubled) : record.type === "CNAME" ? await lookup.cname(doubled) : await lookup.a(doubled);
    if (there.length) {
      return result("wrong", [], `It went in as ${doubled}: ${provider.id === "other" ? "your DNS provider" : provider.label} adds ${zone} by itself, so the Name should be just ${host}.`);
    }
  }
  return result("missing", found);
}
