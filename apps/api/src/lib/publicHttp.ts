/**
 * Reading a link someone typed in (a calendar's, a website's) from the public internet only: never
 * this server, its network or its cloud's metadata service. A name is checked as it's looked up for
 * the connection itself, so the address checked is the one connected to, even when the name's
 * answer changes from one lookup to the next. Callers put the errors below in their own words.
 */
import dns from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/** The link leads to this server, its network or a cloud's metadata service. */
export class PrivateAddressError extends Error {
  override name = "PrivateAddressError";
}

/** The link's name has no address. */
export class NameNotFoundError extends Error {
  override name = "NameNotFoundError";
  constructor(readonly host: string) {
    super(`Couldn't find ${host}`);
  }
}

/** The answer is bigger than the caller reads. */
export class TooLargeError extends Error {
  override name = "TooLargeError";
}

/** An IPv6 address as its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // An IPv4 ending (::ffff:1.2.3.4) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(gap).fill("0"), ...right].map((group) => parseInt(group, 16));
}

const ipv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
  }
  const g = ipv6Groups(ip);
  const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  // IPv6 addresses that stand for an IPv4 one are as private as it is: IPv4-compatible (::a.b.c.d,
  // which takes in :: and ::1), mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d) and NAT64
  // (64:ff9b::a.b.c.d), and 6to4 (2002:a.b.c.d::/48).
  if (zeros(0, 6) || (zeros(0, 5) && g[5] === 0xffff) || (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))) {
    return privateAddress(ipv4(g[6], g[7]));
  }
  if (g[0] === 0x2002) return privateAddress(ipv4(g[1], g[2]));
  // Teredo (2001::/32) and local-use NAT64 (64:ff9b:1::/48) tunnel to IPv4 addresses too; no public link needs them.
  if ((g[0] === 0x2001 && g[1] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)) return true;
  // Unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10) and multicast (ff00::/8).
  return g[0] >= 0xfc00;
}

/** A link whose name or address is plainly inside (localhost, *.internal, 10.0.0.5), before any lookup. */
export function privateHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return /^localhost$|\.localhost$|\.internal$|\.local$/i.test(host) || Boolean(isIP(host) && privateAddress(host));
}

/** Looks a link's name up for its connection, and refuses it if any address is private. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(new NameNotFoundError(hostname), []);
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return callback(new PrivateAddressError(hostname), []);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

/** Send a GET to a public address and wait for the response's headers. Check privateHost first. */
export function publicGet(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
  // Its own connection (no agent), so nothing reuses one made to another address.
  const options = { headers, lookup: publicLookup, agent: false as const, signal };
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest(url, options, resolve) : httpRequest(url, options, resolve);
    request.on("error", reject).end();
  });
}

/**
 * A response's body as text, unpacked, up to `maxBytes` (TooLargeError past that). A body cut off
 * partway, or too slow to finish, is an Error too.
 */
export async function readLimited(response: IncomingMessage, maxBytes: number): Promise<string> {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  // deflate isn't asked for, but some servers send it anyway (fetch used to unpack it).
  const unzip =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  const body: Readable = unzip ? pipeline(response, unzip, () => undefined) : response;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new TooLargeError(`Over ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    if (!response.complete) throw new Error("The response was cut off.");
  } finally {
    response.destroy();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
