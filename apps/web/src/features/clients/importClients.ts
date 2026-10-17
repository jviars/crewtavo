/**
 * Turning a spreadsheet of clients into clients and properties. Built for Jobber's exports (the
 * Clients export and the Properties export) and most other tools' too:
 *   - columns are matched by name ("Main Phone #s", "Service Street 1", "Billing City", "J-ID"...);
 *   - rows for the same client (same ID, email, or name) become one client with several properties;
 *   - a client already in Crewtavo (same email, or same name when there's no email) gets the new
 *     properties added instead of a duplicate client.
 */

export const TARGETS = [
  { key: "display_name", label: "Name", match: /^(name|display ?name|full ?name|client|client ?name|customer|customer ?name|contact ?name)$/i },
  { key: "first_name", label: "First name", match: /^(client )?first ?name$/i },
  { key: "last_name", label: "Last name", match: /^(client )?(last ?name|surname)$/i },
  { key: "company_name", label: "Company", match: /^(company|company ?name|business|business ?name|organization)$/i },
  { key: "client_ref", label: "Client ID (from your old system)", match: /^(j-?id|client ?(j-?)?id|customer ?id|client ?number|account ?(id|number))$/i },
  { key: "email", label: "Email", match: /e-?mails?( ?address(es)?)?$/i },
  { key: "phone", label: "Phone", match: /^(main |mobile |cell |primary )?(phone|mobile|cell)( ?#?s?| ?numbers?)?$/i },
  { key: "label", label: "Property name", match: /^(service |job )?property( ?name| ?label)?$/i },
  { key: "line1", label: "Street address", match: /^(service |property |job ?site )?(street( ?1| ?address)?|address( ?1| ?line ?1)?)$/i },
  { key: "line2", label: "Address line 2", match: /^(service |property )?(street ?2|address ?(line ?)?2|unit|apt|suite)$/i },
  { key: "city", label: "City", match: /^(service |property )?(city|town)$/i },
  { key: "region", label: "State", match: /^(service |property )?(state|province|region)$/i },
  { key: "postal_code", label: "ZIP", match: /^(service |property )?(zip( ?code)?|postal( ?code)?|postcode)$/i },
  { key: "billing_line1", label: "Billing street", match: /^billing ?(street( ?1)?|address( ?1)?)$/i },
  { key: "billing_city", label: "Billing city", match: /^billing ?city$/i },
  { key: "billing_region", label: "Billing state", match: /^billing ?(state|province)$/i },
  { key: "billing_postal_code", label: "Billing ZIP", match: /^billing ?(zip( ?code)?|postal( ?code)?)$/i },
  { key: "tags", label: "Tags", match: /^tags?$/i },
  { key: "lead_source", label: "Lead source", match: /^(lead ?)?source|referred by$/i },
  { key: "notes", label: "Notes", match: /^(client )?notes?$/i },
] as const;
export type TargetKey = (typeof TARGETS)[number]["key"];
export type Mapping = Partial<Record<TargetKey, number>>;

/** Guess which column is which. Each column is used once, and the first good match wins. */
export function guessMapping(headers: string[]): Mapping {
  const guess: Mapping = {};
  const used = new Set<number>();
  for (const t of TARGETS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && t.match.test(h.trim()));
    if (i >= 0) {
      guess[t.key] = i;
      used.add(i);
    }
  }
  return guess;
}

export interface Address { label: string | null; line1: string; line2: string | null; city: string | null; region: string | null; postal_code: string | null }
export interface ImportClient {
  key: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  lead_source: string | null;
  tags: string[];
  notes: string | null;
  billing: Omit<Address, "label" | "line2"> | null;
  properties: Address[];
}

/** "a@x.com, b@y.com" or "(540) 555-0100, (540) 555-0199": the first one. */
const first = (value: string) => value.split(/[,;\n]| {2,}/).map((s) => s.trim()).find(Boolean) ?? "";
const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function toClients(rows: string[][], mapping: Mapping): ImportClient[] {
  const get = (row: string[], key: TargetKey) => (mapping[key] === undefined ? "" : (row[mapping[key]!] ?? "").trim());
  const clients = new Map<string, ImportClient>();
  for (const row of rows) {
    const display = get(row, "display_name") || [get(row, "first_name"), get(row, "last_name")].filter(Boolean).join(" ") || get(row, "company_name");
    if (!display) continue;
    const email = first(get(row, "email")).toLowerCase() || null;
    const key = get(row, "client_ref") ? `ref:${get(row, "client_ref")}` : email ? `email:${email}` : `name:${norm(display)}`;
    let client = clients.get(key);
    if (!client) {
      const billingLine = get(row, "billing_line1");
      client = {
        key,
        display_name: display.slice(0, 200),
        company_name: get(row, "company_name") || null,
        email,
        phone: first(get(row, "phone")) || null,
        lead_source: get(row, "lead_source") || null,
        tags: get(row, "tags").split(/[;,|]/).map((t) => t.trim()).filter(Boolean).slice(0, 20),
        notes: get(row, "notes") || null,
        billing: billingLine ? { line1: billingLine, city: get(row, "billing_city") || null, region: get(row, "billing_region") || null, postal_code: get(row, "billing_postal_code") || null } : null,
        properties: [],
      };
      clients.set(key, client);
    }
    const line1 = get(row, "line1");
    if (line1 && !client.properties.some((p) => norm(p.line1) === norm(line1) && norm(p.city ?? "") === norm(get(row, "city")))) {
      client.properties.push({ label: get(row, "label") || null, line1, line2: get(row, "line2") || null, city: get(row, "city") || null, region: get(row, "region") || null, postal_code: get(row, "postal_code") || null });
    }
  }
  // A client with only a billing address gets it as their property too (that's where the work usually is).
  for (const c of clients.values()) {
    if (!c.properties.length && c.billing) c.properties.push({ label: null, line2: null, ...c.billing });
  }
  return [...clients.values()];
}

export const sameStreet = (a: string, b: string) => norm(a) === norm(b);
