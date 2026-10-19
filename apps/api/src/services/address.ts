/**
 * Settings → Web address: moving an instance to the owner's own address (app.theirbusiness.com).
 *
 *   start    the owner picks an address. With Railway access (Login with Railway, or a project
 *            token), Crewtavo adds it to the crewtavo service and shows Railway's exact DNS
 *            records; without, the screen says what to do in Railway, and the records to expect.
 *   waiting  the records go in. The screen checks them as they do (lib/dns.ts); the "address"
 *            task asks Railway every two minutes whether it has verified the address and issued
 *            its certificate, then makes sure https://address answers as this instance.
 *   switching  APP_URL is set to the new address and auth and crewtavo redeploy with it.
 *   done     the new deployment sees APP_URL is the new address: everyone is told, Railway access
 *            is forgotten, and pages on the old address forward to the new one (lib/address.ts).
 *
 * Without Railway access (or off Railway) the owner changes APP_URL themselves; it's done as soon
 * as Crewtavo runs with the new address.
 */
import {
  ADMINS,
  addressProblem,
  addressUrl,
  normalizeDomain,
  providerForNameservers,
  suggestAddress,
  type AddressChange,
  type AddressCheck,
  type AddressOverview,
  type DnsRecordCheck,
  type Tables,
} from "@crewtavo/core";
import type { Env } from "../env";
import { forgetAddressHistory, originOf, platformOf, railwayLinks, reachesThisInstance } from "../lib/address";
import { checkRecord, currentTarget, findZone, publicLookup, type Lookup, type WantedRecord } from "../lib/dns";
import { renderEmail } from "../lib/email";
import { asJson, HttpError } from "../lib/http";
import { sendEmail } from "../lib/notify";
import type { Db } from "../lib/supabase";
import {
  addCustomDomain,
  certificateOf,
  crewtavoServiceId,
  customDomainStatus,
  deleteCustomDomain,
  projectAccess,
  railwayRecords,
  redeploy,
  serviceDomains,
  setVariable,
  type RailwayAccess,
} from "../integrations/railway";
import { railwayAccess, railwayState } from "./railway";

type Row = Tables<"web_address">;
type StoredRecord = WantedRecord & { ok?: boolean };

/** Railway restarts both services in a few minutes; after this long, something went wrong. */
export const SWITCH_TIMEOUT_MS = 20 * 60_000;

let lookup: Lookup = publicLookup();
/** Tests answer DNS questions themselves. */
export const useLookup = (next: Lookup) => {
  lookup = next;
};

const unique = (values: Array<string | null | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))];
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function loadRow(admin: Db, companyId: string): Promise<Row | null> {
  const { data, error } = await admin.from("web_address").select("*").eq("company_id", companyId).maybeSingle();
  if (error) throw new HttpError(500, "Couldn't load the web address. Try again.");
  return data;
}

async function update(admin: Db, companyId: string, patch: Partial<Row>): Promise<void> {
  const { error } = await admin.from("web_address").update(patch).eq("company_id", companyId);
  if (error) throw new Error(`Couldn't save the web address: ${error.message}`);
  forgetAddressHistory();
}

const isLive = (env: Env, domain: string) => originOf(env.APP_URL) === addressUrl(domain);

/** The records to expect before Railway has said exactly which (or off Railway, where there's no telling). */
function expectedRecords(env: Env, domain: string): StoredRecord[] {
  return platformOf(env) === "railway"
    ? [{ type: "CNAME", purpose: "route", name: domain, value: null }]
    : [{ type: "A", purpose: "route", name: domain, value: null }];
}

// ---------------------------------------------------------------------------------------------
// Checking an address before starting
// ---------------------------------------------------------------------------------------------

export async function checkAddress(env: Env, input: string): Promise<AddressCheck> {
  const domain = normalizeDomain(input);
  if (!domain) return { domain: input.trim(), zone: null, provider: null, root: false, warnings: [], problem: "That doesn't look like a web address. Type it like crm.yourbusiness.com." };
  let problem = addressProblem(domain) ?? (isLive(env, domain) ? "Crewtavo already uses this address." : null);
  const found = await findZone(lookup, domain);
  const provider = found ? providerForNameservers(found.nameservers) : null;
  const root = found?.zone === domain;
  const warnings: string[] = [];
  if (!found) warnings.push(`Crewtavo couldn't find the DNS for ${domain} yet. Check the spelling. A domain bought today can take a little while to show up.`);
  if (root) {
    if (platformOf(env) === "railway" && provider && !provider.rootCname) {
      if (provider.id !== "other") problem ??= `${provider.label} can't point ${domain} itself at Railway. Use a name under it instead, like crm.${domain}.`;
      else warnings.push(`Pointing ${domain} itself at Railway only works with some DNS providers. A name under it, like crm.${domain}, works with all of them.`);
    }
    warnings.push(`If your website is at ${domain}, using it for Crewtavo would replace it. A name like crm.${domain} keeps both.`);
  } else {
    const target = await currentTarget(lookup, domain);
    if (target && !/\.railway\.app$/.test(target)) warnings.push(`${domain} already points somewhere else (${target}). Using it for Crewtavo replaces that.`);
  }
  return { domain, zone: found?.zone ?? null, provider: provider?.id ?? null, root, warnings, problem };
}

// ---------------------------------------------------------------------------------------------
// What the screen shows
// ---------------------------------------------------------------------------------------------

export async function addressOverview(env: Env, admin: Db, companyId: string): Promise<AddressOverview> {
  let row = await loadRow(admin, companyId);
  if (row && row.status !== "done" && isLive(env, row.domain)) row = await markDone(env, admin, row);
  const [company, railway] = await Promise.all([
    admin.from("companies").select("website, email").eq("id", companyId).maybeSingle(),
    platformOf(env) === "railway" ? railwayState(env, admin, companyId) : Promise.resolve(null),
  ]);
  const inUse = new Set([originOf(env.APP_URL), row && row.status !== "done" ? addressUrl(row.domain) : null]);
  return {
    current: originOf(env.APP_URL),
    platform: platformOf(env),
    railway: railway && { ...railway, domains: railway.connected ? (await railwayDomains(env, admin, companyId)).filter((d) => !inUse.has(addressUrl(d.domain))) : [] },
    suggestion: suggestAddress(company.data?.website, company.data?.email),
    change: row ? await describeChange(env, row) : null,
  };
}

const domainCache = new Map<string, { at: number; domains: NonNullable<AddressOverview["railway"]>["domains"] }>();

/**
 * Domains already on the crewtavo service in Railway, such as one bought there: the owner can switch
 * to one without adding any records. Cached briefly: the screen asks every few seconds while it
 * waits for a purchase, and Railway's API allows about 1,000 requests an hour.
 */
async function railwayDomains(env: Env, admin: Db, companyId: string): Promise<NonNullable<AddressOverview["railway"]>["domains"]> {
  const cached = domainCache.get(companyId);
  if (cached && Date.now() - cached.at < 10_000) return cached.domains;
  try {
    const access = await railwayAccess(env, admin, companyId);
    const found = access ? await serviceDomains(env, access) : [];
    const domains = found.map((d) => ({ domain: d.domain, verified: d.status.verified, certificate: certificateOf(d.status) }));
    domainCache.set(companyId, { at: Date.now(), domains });
    return domains;
  } catch (error) {
    console.error("Couldn't list Railway's domains", failure(error));
    return [];
  }
}

async function describeChange(env: Env, row: Row): Promise<AddressChange> {
  const stored = row.records as unknown as StoredRecord[];
  const base = {
    domain: row.domain,
    status: row.status as AddressChange["status"],
    automatic: row.automatic,
    started_at: row.started_at,
    updated_at: row.updated_at,
    from_url: row.from_url,
    error: row.error,
    certificate: row.certificate as AddressChange["certificate"],
    live: isLive(env, row.domain),
  };
  if (row.status === "done") {
    const records = stored.map((r): DnsRecordCheck => ({ type: r.type, purpose: r.purpose, name: r.name, host: r.host ?? r.name, value: r.value, status: "ok", found: [], hint: null }));
    return { ...base, zone: null, provider: null, records, reachable: true };
  }
  const found = await findZone(lookup, row.domain);
  const provider = found ? providerForNameservers(found.nameservers).id : null;
  const zone = found?.zone ?? null;
  const records = await Promise.all(stored.map((r) => checkRecord(lookup, r, zone, provider, r.ok === true)));
  const routed = records.filter((r) => r.purpose === "route").every((r) => r.status === "ok");
  const reachable = base.live || (routed && (await reachesThisInstance(env, row.domain)));
  return { ...base, zone, provider, records, reachable };
}

// ---------------------------------------------------------------------------------------------
// Starting, finishing, stopping
// ---------------------------------------------------------------------------------------------

export async function startChange(env: Env, admin: Db, companyId: string, userId: string, input: string): Promise<AddressOverview> {
  const check = await checkAddress(env, input);
  if (check.problem) throw new HttpError(400, check.problem);
  const existing = await loadRow(admin, companyId);
  if (existing?.status === "switching") throw new HttpError(409, `Crewtavo is switching to ${existing.domain} right now. Wait a few minutes, then try again.`);
  const access = await railwayAccess(env, admin, companyId).catch(() => null);
  // An address set up earlier but never finished: take it back out of Railway.
  if (existing && existing.status !== "done" && existing.railway_domain_id && existing.railway_domain_added && existing.domain !== check.domain && access) {
    await deleteCustomDomain(access, existing.railway_domain_id).catch(() => undefined);
  }
  const { error } = await admin.from("web_address").upsert({
    company_id: companyId,
    domain: check.domain,
    status: "waiting",
    automatic: false,
    railway_domain_id: null,
    railway_domain_added: false,
    records: asJson(expectedRecords(env, check.domain)),
    certificate: null,
    error: null,
    from_url: originOf(env.APP_URL),
    previous_urls: existing ? unique([...existing.previous_urls, existing.from_url]) : [],
    started_by: userId,
    started_at: new Date().toISOString(),
    switching_at: null,
    finished_at: null,
  });
  if (error) throw new HttpError(500, "Couldn't save the address. Try again.");
  forgetAddressHistory();
  if (access) await adoptRailway(env, admin, companyId, access);
  return addressOverview(env, admin, companyId);
}

/** "Check again" / "Try again": asks Railway now, and switches over if everything's ready. */
export async function finishChange(env: Env, admin: Db, companyId: string): Promise<AddressOverview> {
  const row = await loadRow(admin, companyId);
  if (!row) throw new HttpError(404, "There's no address being set up.");
  if (row.status === "failed") await update(admin, companyId, { status: "waiting", error: null, switching_at: null });
  if (row.automatic && row.status !== "done" && row.status !== "switching" && !isLive(env, row.domain)) {
    await refreshChange(env, admin, { ...row, status: "waiting" });
  }
  return addressOverview(env, admin, companyId);
}

export async function cancelChange(env: Env, admin: Db, companyId: string): Promise<AddressOverview> {
  const row = await loadRow(admin, companyId);
  if (row?.status === "switching") throw new HttpError(409, `Crewtavo is switching to ${row.domain} right now. Wait a few minutes.`);
  if (row && row.status !== "done") {
    if (row.railway_domain_id && row.railway_domain_added) {
      const access = await railwayAccess(env, admin, companyId).catch(() => null);
      if (access) await deleteCustomDomain(access, row.railway_domain_id).catch(() => undefined);
    }
    const current = originOf(env.APP_URL);
    // An earlier switch stays on record, so its old addresses keep working.
    if (row.previous_urls.length && current) {
      await update(admin, companyId, {
        domain: new URL(current).hostname, status: "done", automatic: false, railway_domain_id: null, railway_domain_added: false, records: asJson([]), certificate: null, error: null,
        from_url: row.previous_urls.at(-1) ?? null, previous_urls: row.previous_urls,
      });
    } else {
      await admin.from("web_address").delete().eq("company_id", companyId);
      forgetAddressHistory();
    }
  }
  return addressOverview(env, admin, companyId);
}

/** The new address is live: record it and tell the team. Safe to call twice. */
async function markDone(env: Env, admin: Db, row: Row): Promise<Row> {
  const railwayOrigin = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null;
  const previous = unique([...row.previous_urls, row.from_url, railwayOrigin]).filter((u) => u !== addressUrl(row.domain));
  const { data, error } = await admin
    .from("web_address")
    .update({ status: "done", error: null, finished_at: new Date().toISOString(), previous_urls: previous })
    .eq("company_id", row.company_id)
    .neq("status", "done")
    .select("*")
    .maybeSingle();
  forgetAddressHistory();
  if (error || !data) return (await loadRow(admin, row.company_id)) ?? row;
  await announce(env, admin, data).catch((e) => console.error("Couldn't announce the new address", failure(e)));
  return data;
}

async function announce(env: Env, admin: Db, row: Row) {
  const url = addressUrl(row.domain);
  const { data: company } = await admin.from("companies").select("name").eq("id", row.company_id).maybeSingle();
  const { data: admins } = await admin.from("memberships").select("user_id").eq("company_id", row.company_id).eq("active", true).in("role", [...ADMINS]);
  if (admins?.length) {
    await admin.from("notifications").insert(
      admins.map((m) => ({ company_id: row.company_id, user_id: m.user_id, kind: "info", title: `Crewtavo is now at ${row.domain}`, body: `Links in emails, quotes and invoices use ${url} from now on.`, link: "/settings?tab=address" })),
    );
  }
  if (!row.started_by) return;
  const { data: person } = await admin.from("profiles").select("email, full_name").eq("user_id", row.started_by).maybeSingle();
  if (!person?.email) return;
  const name = company?.name ?? "Crewtavo";
  const text = [
    `${person.full_name ? `Hi ${person.full_name.split(/\s+/)[0]},\n\n` : ""}Crewtavo is now at ${url}. Invites, quotes, invoices and the client hub use it from now on.`,
    `Everyone signs in once on the new address. On phones, open ${url} and add it to the home screen again, then turn notifications back on.`,
    "Links sent before today keep working, and the old address forwards to the new one.",
  ].join("\n\n");
  await sendEmail(env, { to: person.email, subject: `Crewtavo is now at ${row.domain}`, ...renderEmail({ companyName: name, text }), fromName: name }, row.company_id);
}

// ---------------------------------------------------------------------------------------------
// Railway: watching the address and switching over
// ---------------------------------------------------------------------------------------------

/** Puts a change into Railway's hands: adds the address there (or finds it), and from then on Crewtavo finishes it. */
export async function adoptRailway(env: Env, admin: Db, companyId: string, access: RailwayAccess): Promise<void> {
  const row = await loadRow(admin, companyId);
  if (!row || row.status === "done" || row.status === "switching" || row.automatic) return;
  try {
    const added = await addCustomDomain(env, access, row.domain);
    const zone = (await findZone(lookup, row.domain))?.zone ?? null;
    await update(admin, companyId, {
      automatic: true,
      status: "waiting",
      railway_domain_id: added.id,
      railway_domain_added: added.added,
      records: asJson(railwayRecords(row.domain, added.status, zone)),
      certificate: certificateOf(added.status),
      error: null,
    });
  } catch (error) {
    await update(admin, companyId, { error: failure(error) });
  }
}

/** Asks Railway how the address is doing; once it's verified, secured and answering, switches over. */
async function refreshChange(env: Env, admin: Db, row: Row): Promise<"waiting" | "switching"> {
  try {
    const access = await railwayAccess(env, admin, row.company_id);
    if (!access) {
      await update(admin, row.company_id, { automatic: false, error: "Crewtavo no longer has access to Railway. Log in with Railway again, or finish the steps by hand." });
      return "waiting";
    }
    if (!row.railway_domain_id) {
      await adoptRailway(env, admin, row.company_id, access);
      return "waiting";
    }
    const domain = await customDomainStatus(env, access, row.railway_domain_id);
    const zone = (await findZone(lookup, row.domain))?.zone ?? null;
    const certificate = certificateOf(domain.status);
    await update(admin, row.company_id, {
      records: asJson(railwayRecords(row.domain, domain.status, zone)),
      certificate,
      error: certificate === "failed" ? `Railway couldn't set up HTTPS for ${row.domain}${domain.status.certificateErrorMessage ? `: ${domain.status.certificateErrorMessage}` : "."} Check the records, then press Check again.` : null,
    });
    if (!domain.status.verified || certificate !== "issued" || !(await reachesThisInstance(env, row.domain))) return "waiting";
    await switchOver(env, admin, row, access);
    return "switching";
  } catch (error) {
    await update(admin, row.company_id, { error: failure(error) }).catch(() => undefined);
    return "waiting";
  }
}

async function switchOver(env: Env, admin: Db, row: Row, access: RailwayAccess): Promise<void> {
  const { authServiceId } = await projectAccess(env, access);
  await update(admin, row.company_id, { status: "switching", switching_at: new Date().toISOString(), error: null });
  try {
    await setVariable(env, access, "APP_URL", addressUrl(row.domain));
    // Auth builds sign-in links from the address too (${{crewtavo.APP_URL}} in the template).
    if (authServiceId) await redeploy(env, access, authServiceId);
    await redeploy(env, access, crewtavoServiceId(env));
  } catch (error) {
    await update(admin, row.company_id, { status: "failed", error: `Railway didn't take the new address: ${failure(error)}` });
  }
}

/** The "address" task: finishes, watches and times out changes in progress. */
export async function runAddressTask(env: Env, admin: Db): Promise<{ checked: number; switching: number; done: number }> {
  const { data: rows, error } = await admin.from("web_address").select("*").in("status", ["waiting", "switching", "failed"]);
  if (error) throw new Error(error.message);
  let switching = 0;
  let done = 0;
  for (const row of rows ?? []) {
    if (isLive(env, row.domain)) {
      await markDone(env, admin, row);
      done++;
    } else if (row.status === "switching" && Date.now() - Date.parse(row.switching_at ?? row.updated_at) > SWITCH_TIMEOUT_MS) {
      await update(admin, row.company_id, {
        status: "failed",
        error: "Railway didn't finish restarting Crewtavo with the new address. Open the crewtavo service's Deployments in Railway to see why, then press Try again.",
      });
    } else if (row.status === "waiting" && row.automatic) {
      if ((await refreshChange(env, admin, row)) === "switching") switching++;
    }
  }
  return { checked: rows?.length ?? 0, switching, done };
}

/** Railway access was removed: a change in progress goes back to the by-hand steps. */
export async function stopAutomatic(admin: Db, companyId: string): Promise<void> {
  const row = await loadRow(admin, companyId).catch(() => null);
  if (row?.automatic && row.status !== "done") await update(admin, companyId, { automatic: false });
}

/** Records Crewtavo can add for the owner (Cloudflare), once Railway has said exactly what they are. */
export async function recordsToAdd(admin: Db, companyId: string): Promise<{ domain: string; zone: string; records: { type: WantedRecord["type"]; name: string; value: string }[] }> {
  const row = await loadRow(admin, companyId);
  if (!row || row.status === "done") throw new HttpError(404, "There's no address being set up.");
  const stored = row.records as unknown as StoredRecord[];
  if (!row.automatic || !stored.length || stored.some((r) => !r.value)) throw new HttpError(400, "Crewtavo doesn't know the records yet. Log in with Railway first.");
  const zone = (await findZone(lookup, row.domain))?.zone;
  if (!zone) throw new HttpError(400, `Crewtavo couldn't find the DNS for ${row.domain}. Check the address is right.`);
  return { domain: row.domain, zone, records: stored.map((r) => ({ type: r.type, name: r.name, value: r.value! })) };
}

