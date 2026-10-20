/**
 * Bringing clients and their properties in from somewhere else: a spreadsheet in the browser
 * (Clients → Import; Jobber's Clients and Properties exports and most other tools') or rows an AI
 * assistant read from one (the import_clients tool). Both group rows into clients and match them
 * against the clients already in Crewtavo the same way:
 *   - rows with the same client ID from the old system, email, or name are one client;
 *   - a client already here is found by that old-system ID (kept in custom_fields.source_id), then
 *     by email, then by name when the row has no email; it isn't duplicated, it gets any new
 *     properties, and its status when the row gives one;
 *   - a property already on the client (the same street) isn't added again.
 * So running the same import twice changes nothing the second time.
 */

export const CLIENT_STATUSES = ["lead", "active", "archived"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** A spreadsheet's status, in Crewtavo's words: Active, Inactive, Archived, Lead, Prospect... Null when it isn't one. */
export function clientStatus(value: string | null | undefined): ClientStatus | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (/^(active|current|yes|y|true|1|customer|client)$/.test(v)) return "active";
  if (/^(inactive|archived?|former|past|closed|no|n|false|0|lost|cancel(l)?ed|lapsed)$/.test(v)) return "archived";
  if (/^(lead|prospect|new|potential)$/.test(v)) return "lead";
  return null;
}

export const IMPORT_TARGETS = [
  { key: "display_name", label: "Name", match: /^(name|display ?name|full ?name|client|client ?name|customer|customer ?name|contact ?name)$/i },
  { key: "first_name", label: "First name", match: /^(client )?first ?name$/i },
  { key: "last_name", label: "Last name", match: /^(client )?(last ?name|surname)$/i },
  { key: "company_name", label: "Company", match: /^(company|company ?name|business|business ?name|organization)$/i },
  { key: "client_ref", label: "Client ID (from your old system)", match: /^(j-?id|client ?(j-?)?id|customer ?id|client ?number|account ?(id|number))$/i },
  { key: "status", label: "Status", match: /^(client |customer |account )?(status|active)$/i },
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
export type ImportTargetKey = (typeof IMPORT_TARGETS)[number]["key"];
export type ImportMapping = Partial<Record<ImportTargetKey, number>>;

/** Guess which column is which. Each column is used once, and the first good match wins. */
export function guessMapping(headers: string[]): ImportMapping {
  const guess: ImportMapping = {};
  const used = new Set<number>();
  for (const t of IMPORT_TARGETS) {
    const i = headers.findIndex((h, idx) => !used.has(idx) && t.match.test(h.trim()));
    if (i >= 0) {
      guess[t.key] = i;
      used.add(i);
    }
  }
  return guess;
}

export interface ImportAddress { label: string | null; line1: string; line2: string | null; city: string | null; region: string | null; postal_code: string | null; notes?: string | null }
export interface ImportClient {
  key: string;
  /** The client's ID in the old system, kept so a second import finds it. */
  source_id: string | null;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  lead_source: string | null;
  tags: string[];
  notes: string | null;
  /** Null: active for a new client, unchanged for one already here. */
  status: ClientStatus | null;
  billing: Omit<ImportAddress, "label" | "line2" | "notes"> | null;
  properties: ImportAddress[];
}

/** "a@x.com, b@y.com" or "(540) 555-0100, (540) 555-0199": the first one. */
const first = (value: string) => value.split(/[,;\n]| {2,}/).map((s) => s.trim()).find(Boolean) ?? "";
export const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Street words written either way: "Street" and "St", "North" and "N". */
const STREET_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", boulevard: "blvd", place: "pl", circle: "cir",
  parkway: "pkwy", highway: "hwy", terrace: "ter", trail: "trl", square: "sq", route: "rte", north: "n", south: "s", east: "e", west: "w",
};
/** A street address as a key: lowercase, the usual words abbreviated, no punctuation or spaces. */
export const streetKey = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join("");
export const sameStreet = (a: string, b: string) => streetKey(a) === streetKey(b);
const tagList = (value: string | readonly string[]) => (typeof value === "string" ? value.split(/[;,|]/) : [...value]).map((t) => t.trim()).filter(Boolean).slice(0, 20);

function groupKey(sourceId: string | null, email: string | null, name: string) {
  return sourceId ? `ref:${sourceId}` : email ? `email:${email}` : `name:${normalizeKey(name)}`;
}

function addProperty(client: ImportClient, address: ImportAddress) {
  if (!address.line1.trim()) return;
  if (client.properties.some((p) => sameStreet(p.line1, address.line1) && normalizeKey(p.city ?? "") === normalizeKey(address.city ?? ""))) return;
  client.properties.push(address);
}

/** A client with only a billing address gets it as their property too (that's where the work usually is). */
function billingAsProperty(clients: Iterable<ImportClient>) {
  for (const c of clients) if (!c.properties.length && c.billing) c.properties.push({ label: null, line2: null, ...c.billing });
}

/** Spreadsheet rows (without the header) as clients, with the columns mapped. */
export function toClients(rows: string[][], mapping: ImportMapping): ImportClient[] {
  const get = (row: string[], key: ImportTargetKey) => (mapping[key] === undefined ? "" : (row[mapping[key]!] ?? "").trim());
  const clients = new Map<string, ImportClient>();
  for (const row of rows) {
    const display = get(row, "display_name") || [get(row, "first_name"), get(row, "last_name")].filter(Boolean).join(" ") || get(row, "company_name");
    if (!display) continue;
    const email = first(get(row, "email")).toLowerCase() || null;
    const sourceId = get(row, "client_ref") || null;
    const key = groupKey(sourceId, email, display);
    let client = clients.get(key);
    if (!client) {
      const billingLine = get(row, "billing_line1");
      client = {
        key,
        source_id: sourceId,
        display_name: display.slice(0, 200),
        company_name: get(row, "company_name") || null,
        email,
        phone: first(get(row, "phone")) || null,
        lead_source: get(row, "lead_source") || null,
        tags: tagList(get(row, "tags")),
        notes: get(row, "notes") || null,
        status: clientStatus(get(row, "status")),
        billing: billingLine ? { line1: billingLine, city: get(row, "billing_city") || null, region: get(row, "billing_region") || null, postal_code: get(row, "billing_postal_code") || null } : null,
        properties: [],
      };
      clients.set(key, client);
    }
    addProperty(client, { label: get(row, "label") || null, line1: get(row, "line1"), line2: get(row, "line2") || null, city: get(row, "city") || null, region: get(row, "region") || null, postal_code: get(row, "postal_code") || null });
  }
  billingAsProperty(clients.values());
  return [...clients.values()];
}

/** A client as an AI assistant hands it over (the import_clients tool). */
export interface ImportRecord {
  source_id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  status?: string | null;
  tags?: readonly string[] | null;
  lead_source?: string | null;
  notes?: string | null;
  billing_address?: { line1: string; city?: string | null; region?: string | null; postal_code?: string | null } | null;
  properties?: ReadonlyArray<{ label?: string | null; line1: string; line2?: string | null; city?: string | null; region?: string | null; postal_code?: string | null; notes?: string | null }> | null;
}

/** Records as clients, grouped like spreadsheet rows; records without a name are skipped (with their place in the list). */
export function recordsToClients(records: readonly ImportRecord[]): { clients: ImportClient[]; skipped: Array<{ row: number; reason: string }> } {
  const clients = new Map<string, ImportClient>();
  const skipped: Array<{ row: number; reason: string }> = [];
  records.forEach((r, i) => {
    const display = (r.name?.trim() || [r.first_name?.trim(), r.last_name?.trim()].filter(Boolean).join(" ") || r.company_name?.trim() || "").slice(0, 200);
    if (!display) return skipped.push({ row: i, reason: "No name, first and last name, or company." });
    if (r.status && !clientStatus(r.status)) return skipped.push({ row: i, reason: `Status "${r.status}" isn't one of active, inactive (archived) or lead.` });
    const email = first(r.email ?? "").toLowerCase() || null;
    const sourceId = r.source_id?.trim() || null;
    const key = groupKey(sourceId, email, display);
    let client = clients.get(key);
    if (!client) {
      client = {
        key,
        source_id: sourceId,
        display_name: display,
        company_name: r.company_name?.trim() || null,
        email,
        phone: first(r.phone ?? "") || null,
        lead_source: r.lead_source?.trim() || null,
        tags: tagList(r.tags ?? []),
        notes: r.notes?.trim() || null,
        status: clientStatus(r.status),
        billing: r.billing_address?.line1?.trim()
          ? { line1: r.billing_address.line1.trim(), city: r.billing_address.city?.trim() || null, region: r.billing_address.region?.trim() || null, postal_code: r.billing_address.postal_code?.trim() || null }
          : null,
        properties: [],
      };
      clients.set(key, client);
    } else if (!client.status && r.status) {
      client.status = clientStatus(r.status);
    }
    for (const p of r.properties ?? []) {
      addProperty(client, { label: p.label?.trim() || null, line1: p.line1.trim(), line2: p.line2?.trim() || null, city: p.city?.trim() || null, region: p.region?.trim() || null, postal_code: p.postal_code?.trim() || null, notes: p.notes?.trim() || null });
    }
  });
  billingAsProperty(clients.values());
  return { clients: [...clients.values()], skipped };
}

export interface ExistingClient { id: string; display_name: string; email: string | null; status: string; source_id: string | null }

export interface ImportDecision {
  key: string;
  display_name: string;
  /** New, or found by the old-system ID, email or name. */
  action: "create" | "match";
  matched_by: "source_id" | "email" | "name" | null;
  client_id: string | null;
  /** The status it gets: a new client's, or a found one's when the row gives a different one. */
  status: ClientStatus | null;
  status_change: { from: string; to: ClientStatus } | null;
  add_properties: ImportAddress[];
  /** Properties it already has at those streets. */
  kept_properties: number;
}

export interface ImportPlan {
  decisions: ImportDecision[];
  totals: { clients: number; create: number; match: number; status_changes: number; properties: number; kept_properties: number };
}

/**
 * What an import would do: which clients are new and which are already here (and how they were
 * found), each client's status, and which properties get added. `streets` is the streets each
 * existing client already has, by client id.
 */
export function planImport(clients: readonly ImportClient[], existing: readonly ExistingClient[], streets: ReadonlyMap<string, readonly string[]>): ImportPlan {
  const bySource = new Map(existing.filter((c) => c.source_id).map((c) => [c.source_id!, c]));
  const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c]));
  const byName = new Map(existing.map((c) => [normalizeKey(c.display_name), c]));
  const decisions = clients.map((c): ImportDecision => {
    const [found, matchedBy] = ((c.source_id && bySource.get(c.source_id)) ? [bySource.get(c.source_id)!, "source_id" as const]
      : c.email && byEmail.get(c.email) ? [byEmail.get(c.email)!, "email" as const]
      : !c.email && byName.get(normalizeKey(c.display_name)) ? [byName.get(normalizeKey(c.display_name))!, "name" as const]
      : [null, null]);
    const have = found ? (streets.get(found.id) ?? []) : [];
    const add = c.properties.filter((p) => !have.some((line) => sameStreet(line, p.line1)));
    const statusChange = found && c.status && c.status !== found.status ? { from: found.status, to: c.status } : null;
    return {
      key: c.key,
      display_name: c.display_name,
      action: found ? "match" : "create",
      matched_by: matchedBy,
      client_id: found?.id ?? null,
      status: found ? (statusChange ? c.status : null) : (c.status ?? "active"),
      status_change: statusChange,
      add_properties: add,
      kept_properties: c.properties.length - add.length,
    };
  });
  return {
    decisions,
    totals: {
      clients: decisions.length,
      create: decisions.filter((d) => d.action === "create").length,
      match: decisions.filter((d) => d.action === "match").length,
      status_changes: decisions.filter((d) => d.status_change).length,
      properties: decisions.reduce((n, d) => n + d.add_properties.length, 0),
      kept_properties: decisions.reduce((n, d) => n + d.kept_properties, 0),
    },
  };
}
