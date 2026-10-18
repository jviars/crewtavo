/**
 * Where a domain's DNS is managed and how to add a record there (Settings → Web address): the
 * provider is recognized from the domain's nameservers, and its steps are filled in with each
 * record to add. The shared types (DnsProvider) and address helpers live in address.ts.
 */
import type { DnsProvider } from "./address";

/** The usual Name box: the provider puts the domain on the end itself. */
const addsDomain = (provider: string, box: string, root = "type @") =>
  `${provider} adds your domain to the ${box} itself: type just the part before it (app, not app.example.com). For the domain itself, ${root}.`;

export const DNS_PROVIDERS: DnsProvider[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    match: ["ns.cloudflare.com"],
    dnsUrl: "https://dash.cloudflare.com/",
    steps: [
      "Open your domain, then DNS → Records.",
      "Press Add record and choose {type}.",
      "Type {host} as the Name and {value} as the Target (Content for TXT).",
      "For a CNAME, set Proxy status to DNS only (grey cloud). Press Save.",
    ],
    hostNote: "Cloudflare takes either the part before your domain (app) or the whole address (app.example.com). For the domain itself, type @.",
    rootCname: true,
    note: "Keep the record DNS only (grey cloud), not Proxied (orange cloud). Railway sets up the HTTPS certificate itself, and the orange cloud needs extra SSL settings to work with it.",
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    match: ["domaincontrol.com"],
    dnsUrl: "https://dcc.godaddy.com/control/portfolio",
    steps: [
      "Open Domain Portfolio, choose your domain, then DNS.",
      "Press Add New Record and choose {type}.",
      "Type {host} as the Name and {value} as the Value, then press Save.",
    ],
    hostNote: addsDomain("GoDaddy", "Name"),
    rootCname: false,
  },
  {
    id: "namecheap",
    label: "Namecheap",
    match: ["registrar-servers.com"],
    dnsUrl: "https://ap.www.namecheap.com/domains/list/",
    steps: [
      "Open Domain List, press Manage next to your domain, then Advanced DNS.",
      "Press Add New Record and choose {type} Record.",
      "Type {host} as the Host and {value} as the Value (Target for a CNAME), then press the tick to save.",
    ],
    hostNote: addsDomain("Namecheap", "Host"),
    rootCname: true,
    note: "For the domain itself, choose ALIAS Record instead of CNAME Record.",
  },
  {
    id: "squarespace",
    label: "Squarespace",
    match: ["squarespacedns.com", "googledomains.com"],
    dnsUrl: "https://account.squarespace.com/domains",
    steps: [
      "Open Domains, choose your domain, then DNS → DNS Settings.",
      "Under Custom records, press Add record and choose {type}.",
      "Type {host} as the Host and {value} as the Data, then press Save.",
    ],
    hostNote: addsDomain("Squarespace", "Host"),
    rootCname: false,
    note: "Domains bought from Google Domains moved to Squarespace, so they're managed there now.",
  },
  {
    id: "route53",
    label: "Amazon Route 53",
    // ns-123.awsdns-45.com, .net, .org or .co.uk
    match: ["awsdns-"],
    dnsUrl: "https://console.aws.amazon.com/route53/v2/hostedzones",
    steps: [
      "Open Hosted zones and choose your domain.",
      "Press Create record, type {host} in Record name and choose {type} as the Record type.",
      "Put {value} in Value and press Create records.",
    ],
    hostNote: addsDomain("Route 53", "Record name", "leave it empty"),
    rootCname: false,
  },
  {
    id: "hostinger",
    label: "Hostinger",
    match: ["dns-parking.com", "hostinger.com"],
    dnsUrl: "https://hpanel.hostinger.com/domains",
    steps: [
      "Open Domains, press Manage next to your domain, then DNS / Nameservers.",
      "Choose {type} as the Type, type {host} as the Name and put {value} in the Target or Points to box.",
      "Press Add Record.",
    ],
    hostNote: addsDomain("Hostinger", "Name"),
    rootCname: false,
  },
  {
    id: "ionos",
    label: "IONOS",
    // ns1045.ui-dns.com, .de, .org or .biz
    match: ["ui-dns."],
    dnsUrl: "https://my.ionos.com/domains",
    steps: [
      "Open Domains & SSL, choose your domain, then the DNS tab.",
      "Press Add record and choose {type}.",
      "Type {host} as the Host name and {value} as Points to (Value for TXT), then press Save.",
    ],
    hostNote: addsDomain("IONOS", "Host name"),
    rootCname: false,
  },
  {
    id: "porkbun",
    label: "Porkbun",
    match: ["porkbun.com"],
    dnsUrl: "https://porkbun.com/account/domainsSpeedy",
    steps: [
      "Open Domain Management, hover over your domain and press DNS.",
      "Choose {type} as the Type, type {host} as the Host and {value} as the Answer.",
      "Press Add.",
    ],
    hostNote: addsDomain("Porkbun", "Host", "leave it empty"),
    rootCname: false,
  },
  {
    id: "wix",
    label: "Wix",
    match: ["wixdns.net"],
    dnsUrl: "https://www.wix.com/account/domains",
    steps: [
      "Open Domains, press ⋯ next to your domain and choose Manage DNS Records.",
      "In the {type} section, press + Add Record.",
      "Type {host} as the Host Name and {value} as the Value, then press Save.",
    ],
    hostNote: addsDomain("Wix", "Host Name", "leave it empty (not @)"),
    rootCname: false,
  },
  {
    id: "bluehost",
    label: "Bluehost",
    match: ["bluehost.com"],
    dnsUrl: "https://www.bluehost.com/my-account/login",
    steps: [
      "Open Domains, choose your domain, then the DNS tab.",
      "Press + Add record and choose {type}.",
      "Type {host} as the Host Record and {value} as Points To (or Value), then press Add.",
    ],
    hostNote: addsDomain("Bluehost", "Host Record"),
    rootCname: false,
  },
  {
    id: "networksolutions",
    label: "Network Solutions",
    match: ["worldnic.com"],
    dnsUrl: "https://www.networksolutions.com/my-account/login",
    steps: [
      "Open Domains, press Manage next to your domain, then the DNS tab.",
      "Press + Add Record and choose {type}.",
      "Under Refers to, choose Other Host and type {host} as the Host Name. Put {value} in the Alias to box (TXT Value for TXT) and press Add.",
    ],
    hostNote: addsDomain("Network Solutions", "Host Name", "choose @ under Refers to"),
    rootCname: false,
  },
  {
    id: "dnsimple",
    label: "DNSimple",
    // ns1.dnsimple.com, or ns1.dnsimple-edge.com, .net, .io and .org
    match: ["dnsimple.com", "dnsimple-edge."],
    dnsUrl: "https://app.dnsimple.com/",
    steps: [
      "Open your domain from Domain Names, then press Record editor.",
      "Press Add record and choose {type}.",
      "Type {host} as the Name and {value} as the Content, then press Add Record.",
    ],
    hostNote: addsDomain("DNSimple", "Name", "leave it empty"),
    rootCname: true,
    note: "For the domain itself, choose ALIAS instead of CNAME.",
  },
  {
    id: "namecom",
    label: "Name.com",
    match: ["name.com"],
    dnsUrl: "https://www.name.com/account/domain",
    steps: [
      "Open My Domains, choose your domain, then Manage DNS Records.",
      "Choose {type} as the Type, type {host} as the Host and {value} as the Answer.",
      "Press Add Record.",
    ],
    hostNote: addsDomain("Name.com", "Host", "leave it empty"),
    rootCname: false,
  },
  {
    id: "hover",
    label: "Hover",
    match: ["hover.com"],
    dnsUrl: "https://www.hover.com/control_panel/domains",
    steps: [
      "Open your domain, then the DNS tab.",
      "Press Add A Record and choose {type}.",
      "Type {host} as the Hostname and {value} as the Target Name (Value for TXT), then press Add Record.",
    ],
    hostNote: addsDomain("Hover", "Hostname"),
    rootCname: false,
  },
  {
    id: "vercel",
    label: "Vercel",
    match: ["vercel-dns.com"],
    dnsUrl: "https://vercel.com/dashboard/domains",
    steps: [
      "Open Domains and choose your domain.",
      "Under DNS Records, type {host} as the Name, choose {type} and put {value} as the Value.",
      "Press Add.",
    ],
    hostNote: addsDomain("Vercel", "Name", "leave it empty"),
    rootCname: false,
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    match: ["digitalocean.com"],
    dnsUrl: "https://cloud.digitalocean.com/networking/domains",
    steps: [
      "Open Networking → Domains and choose your domain.",
      "Pick the {type} tab and type {host} as the Hostname.",
      "Put {value} in the next box and press Create Record.",
    ],
    hostNote: addsDomain("DigitalOcean", "Hostname"),
    rootCname: false,
  },
  // Last: nsone.net is NS1's, which Squarespace and others run on too, so their own names come first.
  {
    id: "netlify",
    label: "Netlify",
    // Not nsone.net: Netlify shares it with Squarespace and other NS1 customers.
    match: ["netlifydns.com"],
    dnsUrl: "https://app.netlify.com/",
    steps: [
      "Open Domains in your Netlify team and choose your domain.",
      "Press Add new record and choose {type}.",
      "Type {host} as the Name and {value} as the Value, then press Save.",
    ],
    hostNote: addsDomain("Netlify", "Name"),
    rootCname: false,
  },
];

export const GENERIC_DNS_PROVIDER: DnsProvider = {
  id: "other",
  label: "Your DNS provider",
  match: [],
  dnsUrl: null,
  steps: [
    "Sign in where your domain's DNS is managed (usually where you bought the domain) and open its DNS settings. They may be called DNS records, Zone editor or Advanced DNS.",
    "Add a new {type} record.",
    "Type {host} in the Name or Host box and {value} in the Value, Target or Points to box, then save.",
  ],
  hostNote: "Most providers add your domain to the name themselves: type just the part before it (app, not app.example.com), or @ for the domain itself. If the record ends up as app.example.com.example.com, take your domain off the end.",
  rootCname: false,
};

/** A `match` entry is a suffix at a label boundary; one ending in "." or "-" (ui-dns., awsdns-) can start any label, for hosts spread over several endings. */
function fits(nameserver: string, entry: string): boolean {
  const name = `.${nameserver}`;
  return /[.-]$/.test(entry) ? name.includes(`.${entry}`) : name.endsWith(`.${entry}`);
}

/** Who hosts a domain's DNS, from its nameservers (an NS lookup). */
export function providerForNameservers(nameservers: string[]): DnsProvider {
  const names = nameservers.map((ns) => ns.trim().toLowerCase().replace(/\.$/, ""));
  return DNS_PROVIDERS.find((p) => p.match.some((entry) => names.some((ns) => fits(ns, entry)))) ?? GENERIC_DNS_PROVIDER;
}

export function providerById(id: string | null | undefined): DnsProvider {
  return DNS_PROVIDERS.find((p) => p.id === id) ?? GENERIC_DNS_PROVIDER;
}

/** Cloudflare's "create token" page, filled in: Zone read and DNS edit, named Crewtavo. */
export function cloudflareTokenUrl(): string {
  const permissions = JSON.stringify([{ key: "dns", type: "edit" }, { key: "zone", type: "read" }]);
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(permissions)}&accountId=*&zoneId=all&name=Crewtavo`;
}

/** A provider step with the record put in. `unknown` stands in for a value only the owner can see (Railway's, or their server's address). */
export function fillStep(step: string, record: { type: string; host: string; value: string | null }, unknown = "the value Railway shows"): string {
  const values: Record<string, string> = { type: record.type, host: record.host, value: record.value ?? unknown };
  return step.replace(/\{(type|host|value)\}/g, (_, key: string) => values[key]);
}
