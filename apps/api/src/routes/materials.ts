/**
 * Material prices: the materials in a price list's services, from the business's own ABC Supply
 * account (integrations/abcSupply.ts), and an estimate's materials priced at its branch today
 * (Roofing → Estimate → Materials). Each material is a supplier item and how many of it go into one
 * unit of the service; the service's cost is its materials plus the rest (labor_cost).
 *
 * Roofing → Catalog browses ABC's catalog here too: searches, what the account usually buys, an
 * item's colors and sizes and ABC's picture of it, every material checked with ABC at once, and one
 * replaced everywhere it's used. Prices are asked for when they're shown, never kept apart from
 * the price list (ABC's terms).
 *
 * ABC takes a second or more to answer, so the Catalog shows its cards first and asks for their
 * prices and pictures after (/materials/prices, /materials/pictures). What doesn't change from
 * minute to minute is kept for a while in memory: the account's usual items, which picture and
 * brand an item has, and its picture made small for a card (lib/thumbnail.ts). Prices never are.
 */
import { SALES } from "@crewtavo/core";
import { keptPrice, lineUnitCost, priceMaterials, serviceUnitCost, type LineMaterials, type MaterialLink } from "@crewtavo/core/materials";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { abcBillTo, abcConnection, AbcProblem, ASSET_ID, settingsOf, type AbcClient, type AbcItem, type AbcSettings, type AbcUsualItem } from "../integrations/abcSupply";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, must, param, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient, type Db } from "../lib/supabase";
import { THUMBNAIL_PX, thumbnail } from "../lib/thumbnail";
import { pricePackages, recostServices } from "../services/roofPackages";

export const materials = new Hono<AppEnv>();

/** Quotes whose lines can still change (and so be priced again). */
const EDITABLE = ["draft", "sent", "changes_requested"];

const LINK_FIELDS = "id, service_id, item_number, name, uom, uom_name, length_ft, per_unit, unit_price, priced_at, price_note, sort";
type LinkRow = MaterialLink & { id: string; service_id: string; priced_at: string | null; sort: number };

/** An ABC Supply problem as the answer, in its own words. A token ABC turned down twice is an outage here. */
const supplierAnswer = (error: unknown) => (error instanceof AbcProblem ? new HttpError(error.status === 401 ? 502 : error.status, error.message) : error);

async function connection(c: Context<AppEnv>) {
  try {
    return await abcConnection(c.env, adminClient(c.env), c.var.companyId);
  } catch (error) {
    throw supplierAnswer(error);
  }
}

/** Where material prices come from, for everyone who prices estimates (Apps itself is for admins). */
materials.get("/materials/supplier", requireUser, requireCompany(SALES), async (c) => {
  const { data } = await adminClient(c.env).from("integrations").select("status, settings, last_error").match({ company_id: c.var.companyId, provider: "abc_supply" }).maybeSingle();
  const settings = data && data.status !== "disconnected" ? settingsOf(data.settings) : null;
  return c.json({
    supplier: settings
      ? { id: "abc_supply", name: "ABC Supply", status: data!.status, last_error: data!.last_error, environment: settings.environment, ship_to_name: settings.ship_to_name, branch: settings.branch, branch_name: settings.branch_name }
      : null,
  });
});

const SEARCHES_PER_10_MIN = 120;

/** Items with the account's price for one of each, in the unit they're ordered in. */
async function withPrices(client: AbcClient, settings: AbcSettings, items: AbcItem[]) {
  // Items cut to length can't be priced until a length is picked.
  const prices = await client.prices(
    settings.ship_to,
    settings.branch,
    items.filter((i) => !i.dimensional).map((i) => ({ id: i.item_number, item_number: i.item_number, quantity: 1, uom: i.stocking_uom })),
    "estimating",
  );
  return items.map((i) => ({ ...i, uom: i.stocking_uom, unit_price: prices.get(i.item_number)?.unit_price ?? null, note: i.dimensional ? "Pick a length to see its price." : (prices.get(i.item_number)?.note ?? null) }));
}

/**
 * ABC Supply's catalog at the company's branch, each item with the account's price for one. With
 * prices=0 the items come back sooner, without them, for asking /materials/prices after.
 */
materials.get("/materials/search", requireUser, requireCompany(SALES), async (c) => {
  const query = (c.req.query("q") ?? "").trim().slice(0, 80);
  if (query.length < 2) throw new HttpError(400, "Type at least two letters to search.");
  // The Catalog's categories ask for more at once than a search as you type.
  const limit = Math.min(60, Math.max(10, Math.round(Number(c.req.query("limit")) || 30)));
  if (!(await allow(c.env, `materials-search:${c.var.companyId}`, SEARCHES_PER_10_MIN, 10 * 60))) throw new HttpError(429, "That's a lot of searches in a few minutes. Wait a little and try again.");
  const { client, settings } = await connection(c);
  try {
    const items = await client.searchItems(query, settings.branch, limit);
    if (c.req.query("prices") === "0") return c.json({ branch_name: settings.branch_name, items: items.map((i) => ({ ...i, uom: i.stocking_uom, unit_price: null, note: null })) });
    return c.json({ branch_name: settings.branch_name, items: await withPrices(client, settings, items) });
  } catch (error) {
    throw supplierAnswer(error);
  }
});

/** The colors and sizes of one product (its family) that the branch carries, with prices. */
materials.get("/materials/family/:id", requireUser, requireCompany(SALES), async (c) => {
  const id = c.req.param("id") ?? "";
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) throw new HttpError(400, "That isn't an ABC product family.");
  if (!(await allow(c.env, `materials-search:${c.var.companyId}`, SEARCHES_PER_10_MIN, 10 * 60))) throw new HttpError(429, "That's a lot of searches in a few minutes. Wait a little and try again.");
  const { client, settings } = await connection(c);
  try {
    return c.json({ branch_name: settings.branch_name, items: await withPrices(client, settings, await client.family(id, settings.branch)) });
  } catch (error) {
    throw supplierAnswer(error);
  }
});

/** Kept for a while, the oldest dropped first past `max`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value as K);
}

const MINUTE = 60_000;

/** A company's usual items (no prices): its invoices don't change from minute to minute. */
const usualKept = new Map<string, { at: number; items: AbcUsualItem[] }>();
const USUAL_FOR = 30 * MINUTE;

/**
 * What the account buys again and again (ABC's record of its invoices), without prices: the
 * Catalog asks for those next (/materials/prices). Kept for half an hour. When ABC won't share
 * it, the catalog says why and the rest of it still works.
 */
materials.get("/materials/usual", requireUser, requireCompany(SALES), async (c) => {
  const { client, settings } = await connection(c);
  const none = (note: string) => c.json({ branch_name: settings.branch_name, items: [], note });
  const key = `${c.var.companyId}:${settings.environment}:${settings.ship_to}:${settings.branch}`;
  const kept = usualKept.get(key);
  if (kept && Date.now() - kept.at < USUAL_FOR) return c.json({ branch_name: settings.branch_name, items: kept.items });
  if (!(await allow(c.env, `materials-search:${c.var.companyId}`, SEARCHES_PER_10_MIN, 10 * 60))) throw new HttpError(429, "That's a lot of searches in a few minutes. Wait a little and try again.");
  try {
    const billTo = await abcBillTo(adminClient(c.env), c.var.companyId, client, settings);
    if (!billTo) return none("ABC Supply didn't say which account your purchases are billed to, so it can't show what you usually buy.");
    const usual = (await client.usual(billTo, settings.branch)).slice(0, 40);
    if (!usual.length) {
      return none(
        settings.environment === "sandbox"
          ? "ABC's sandbox has no purchases to go by. Once you're on your real prices, what your account buys most shows here."
          : "Nothing yet. ABC lists the items your account was invoiced for at least twice in the last 6 months.",
      );
    }
    remember(usualKept, key, { at: Date.now(), items: usual }, 500);
    return c.json({ branch_name: settings.branch_name, items: usual });
  } catch (error) {
    // Busy or down is worth trying again; anything else ABC said no to, the page explains.
    if (error instanceof AbcProblem && error.status !== 429 && error.status !== 502) return none(`ABC Supply didn't share what you usually buy. ${error.message}`);
    throw supplierAnswer(error);
  }
});

/** The account's price for one of each, in the unit asked (keyed "item:unit"), for cards shown before their prices. */
materials.post("/materials/prices", requireUser, requireCompany(SALES), async (c) => {
  const body = await readJson(c, z.object({ lines: z.array(z.object({ item_number: z.string().trim().min(1).max(40), uom: z.string().trim().min(1).max(12), length_ft: z.number().positive().max(1000).nullable().optional() })).min(1).max(60) }));
  if (!(await allow(c.env, `materials-search:${c.var.companyId}`, SEARCHES_PER_10_MIN, 10 * 60))) throw new HttpError(429, "That's a lot of searches in a few minutes. Wait a little and try again.");
  const { client, settings } = await connection(c);
  try {
    const lines = body.lines.map((l) => ({ id: `${l.item_number}:${l.uom.toUpperCase()}`, item_number: l.item_number, quantity: 1, uom: l.uom.toUpperCase(), length_ft: l.length_ft ?? null }));
    return c.json({ prices: Object.fromEntries(await client.prices(settings.ship_to, settings.branch, lines, "estimating")) });
  } catch (error) {
    throw supplierAnswer(error);
  }
});

/** What a card shows of an item besides its name: ABC's picture of it, its brand, color and kind. */
interface CardLook { image: string | null; brand: string | null; color: string | null; kind: string | null }

/** Each item's look, by item number; null for one ABC doesn't have. Kept a day. */
const looksKept = new Map<string, { at: number; look: CardLook | null }>();
const LOOK_FOR = 24 * 60 * MINUTE;

/**
 * The looks of items the Catalog lists without them (what the account usually buys): one search
 * for them all, then one by one for any it didn't answer for, a few at a time.
 */
async function looksOf(c: Context<AppEnv>, numbers: string[]): Promise<Record<string, CardLook | null>> {
  const out: Record<string, CardLook | null> = {};
  const now = Date.now();
  const missing = numbers.filter((n) => {
    const kept = looksKept.get(n);
    if (kept && now - kept.at < LOOK_FOR) out[n] = kept.look;
    return !(n in out);
  });
  if (!missing.length) return out;
  const { client, settings } = await connection(c);
  const keep = (n: string, look: CardLook | null) => {
    out[n] = look;
    remember(looksKept, n, { at: now, look }, 5000);
  };
  const lookOf = (i: AbcItem): CardLook => ({ image: i.image, brand: i.brand, color: i.color, kind: i.kind });
  const found = await client.itemsByNumber(missing, settings.branch).catch(() => [] as AbcItem[]);
  for (const item of found) if (missing.includes(item.item_number)) keep(item.item_number, lookOf(item));
  const rest = missing.filter((n) => !(n in out));
  for (let i = 0; i < rest.length; i += 4) {
    await Promise.all(
      rest.slice(i, i + 4).map(async (n) => {
        try {
          keep(n, lookOf(await client.item(n, false)));
        } catch (error) {
          // One ABC doesn't have is kept as that; anything else is left to try again next time.
          if (error instanceof AbcProblem && error.status === 404) keep(n, null);
        }
      }),
    );
  }
  return out;
}

/** The pictures, brands and colors of up to 24 items (?items=a,b,c), for cards listed without them. */
materials.get("/materials/pictures", requireUser, requireCompany(SALES), async (c) => {
  const numbers = [...new Set((c.req.query("items") ?? "").split(",").map((n) => n.trim()).filter((n) => /^[A-Za-z0-9._-]{1,40}$/.test(n)))].slice(0, 24);
  if (!numbers.length) throw new HttpError(400, "Say which items.");
  try {
    return c.json({ looks: await looksOf(c, numbers) });
  } catch (error) {
    throw supplierAnswer(error);
  }
});

/** Pictures made small for cards, by ABC's asset id. About 30 KB each. */
const thumbnailsKept = new Map<string, { at: number; body: Uint8Array; type: string }>();
const THUMBNAIL_FOR = 24 * 60 * MINUTE;

/** Forgets everything kept above (for tests, which share one server). */
export function forgetCatalogMemory() {
  usualKept.clear();
  looksKept.clear();
  thumbnailsKept.clear();
}

/**
 * ABC's picture of an item, through Crewtavo since ABC wants the app's sign-in for it, made small
 * for a card (at most THUMBNAIL_PX). ABC's are up to a megabyte; this is a few dozen kilobytes.
 */
materials.get("/materials/images/:asset", requireUser, requireCompany(SALES), async (c) => {
  const asset = c.req.param("asset") ?? "";
  if (!ASSET_ID.test(asset)) throw new HttpError(400, "That isn't an ABC picture.");
  const headers = (type: string) => ({ "Content-Type": type, "Cache-Control": "private, max-age=86400" });
  const kept = thumbnailsKept.get(asset);
  if (kept && Date.now() - kept.at < THUMBNAIL_FOR) return new Response(kept.body, { headers: headers(kept.type) });
  if (!(await allow(c.env, `materials-images:${c.var.companyId}`, 900, 10 * 60))) throw new HttpError(429, "That's a lot of pictures in a few minutes. Wait a little and try again.");
  const { client } = await connection(c);
  let image;
  try {
    image = await client.image(asset);
  } catch (error) {
    throw supplierAnswer(error);
  }
  if (!image) throw new HttpError(404, "ABC Supply has no picture of that.");
  const small = await thumbnail(new Uint8Array(image.body), image.type, THUMBNAIL_PX);
  // Only small ones are kept: a photo that couldn't be made small isn't held in memory.
  if (small.body.byteLength <= 200_000) remember(thumbnailsKept, asset, { at: Date.now(), ...small }, 400);
  return new Response(small.body, { headers: headers(small.type) });
});

/** One item: its units, and the lengths it's cut to. A price for the unit asked for (and length). */
materials.get("/materials/items/:number", requireUser, requireCompany(SALES), async (c) => {
  const number = c.req.param("number") ?? "";
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(number)) throw new HttpError(400, "That isn't an ABC item number.");
  const { client, settings } = await connection(c);
  try {
    const item = await client.item(number);
    const uom = (c.req.query("uom") ?? item.stocking_uom).toUpperCase();
    const length = Number(c.req.query("length_ft")) || (item.dimensional ? (item.lengths[0] ?? null) : null);
    const price = item.dimensional && !length ? null : (await client.prices(settings.ship_to, settings.branch, [{ id: "1", item_number: item.item_number, quantity: 1, uom, length_ft: length }], "estimating")).get("1")!;
    return c.json({ item, uom, length_ft: length, unit_price: price?.unit_price ?? null, note: price?.note ?? null });
  } catch (error) {
    throw supplierAnswer(error);
  }
});

/** A service's materials, in order. */
const linksOf = async (db: Db, serviceId: string) => must(await db.from("service_materials").select(LINK_FIELDS).eq("service_id", serviceId).order("sort").order("created_at")) as unknown as LinkRow[];

/**
 * The service's cost from its materials and the rest. With no materials left, the rest is its
 * whole cost again, and labor_cost goes back to empty.
 */
async function updateServiceCost(db: Db, companyId: string, serviceId: string, links: LinkRow[], laborCost: number | null) {
  const change = links.length ? { labor_cost: laborCost ?? 0, unit_cost: serviceUnitCost(links, laborCost) } : { labor_cost: null, unit_cost: laborCost };
  const { error } = await db.from("services").update(change).eq("id", serviceId).eq("company_id", companyId);
  if (error) throw dbError(error);
  return change;
}

const serviceOf = async (db: Db, companyId: string, id: string) =>
  must(await db.from("services").select("id, name, unit, unit_cost, labor_cost").eq("id", id).eq("company_id", companyId).maybeSingle(), "That service wasn't found. It may have been deleted.");

const perUnit = z.number().positive("How many has to be more than 0.").max(100000);

/** An item picked from ABC's catalog, as a material: its unit and length checked with ABC, and priced. */
const picked = { item_number: z.string().trim().min(1).max(40), uom: z.string().trim().min(1).max(12).optional(), length_ft: z.number().positive().max(1000).nullable().optional() };

/** The item checked with ABC (its name and units come from there) and priced for one. */
async function pickedItem(client: AbcClient, settings: AbcSettings, body: { item_number: string; uom?: string; length_ft?: number | null }) {
  try {
    const found = await client.item(body.item_number);
    const unit = (body.uom ?? found.stocking_uom).toUpperCase();
    if (found.uoms.length && !found.uoms.some((u) => u.code === unit)) throw new HttpError(400, `ABC Supply doesn't sell ${found.name} by ${unit}.`);
    if (found.dimensional && !body.length_ft) throw new HttpError(400, "Pick the length it's cut to.");
    const answer = (await client.prices(settings.ship_to, settings.branch, [{ id: "1", item_number: found.item_number, quantity: 1, uom: unit, length_ft: body.length_ft }], "estimating")).get("1")!;
    return { item: found, uom: { code: unit, name: found.uoms.find((u) => u.code === unit)?.name ?? unit }, price: answer };
  } catch (error) {
    throw supplierAnswer(error);
  }
}

/**
 * A material in a service: checked with ABC (its name and units come from there), priced, and the
 * service's cost worked out again. The first one splits the service's cost: what its materials
 * don't explain is the labor and the rest, until someone changes it.
 */
materials.post("/services/:id/materials", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ ...picked, per_unit: perUnit }));
  const { db, companyId } = c.var;
  const service = await serviceOf(db, companyId, id);
  const { client, settings } = await connection(c);
  const { item, uom, price } = await pickedItem(client, settings, body);
  const before = await linksOf(db, id);
  const { error } = await db.from("service_materials").insert({
    company_id: companyId,
    service_id: id,
    supplier: "abc_supply",
    item_number: item.item_number,
    name: item.name.slice(0, 300),
    uom: uom.code,
    uom_name: uom.name.slice(0, 60),
    length_ft: item.dimensional ? body.length_ft : null,
    per_unit: body.per_unit,
    unit_price: price.unit_price,
    priced_at: new Date().toISOString(),
    price_note: price.note,
    sort: before.reduce((m, l) => Math.max(m, l.sort), 0) + 1,
  });
  if (error) throw dbError(error);
  const links = await linksOf(db, id);
  const labor = service.labor_cost !== null ? Number(service.labor_cost) : Math.max(0, Math.round((Number(service.unit_cost ?? 0) - serviceUnitCost(links, 0)) * 100) / 100);
  const cost = await updateServiceCost(db, companyId, id, links, labor);
  return c.json({ materials: links, ...cost }, 201);
});

/** How many go into a unit, changed. */
materials.patch("/services/:id/materials/:material", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ per_unit: perUnit }));
  const { db, companyId } = c.var;
  const service = await serviceOf(db, companyId, id);
  const { error } = await db.from("service_materials").update({ per_unit: body.per_unit }).eq("id", param(c, "material")).eq("service_id", id);
  if (error) throw dbError(error);
  const links = await linksOf(db, id);
  return c.json({ materials: links, ...(await updateServiceCost(db, companyId, id, links, service.labor_cost === null ? null : Number(service.labor_cost))) });
});

/** A material out of a service. */
materials.delete("/services/:id/materials/:material", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const { db, companyId } = c.var;
  const service = await serviceOf(db, companyId, id);
  const { error } = await db.from("service_materials").delete().eq("id", param(c, "material")).eq("service_id", id);
  if (error) throw dbError(error);
  const links = await linksOf(db, id);
  return c.json({ materials: links, ...(await updateServiceCost(db, companyId, id, links, service.labor_cost === null ? null : Number(service.labor_cost))) });
});

/** What a service with materials costs besides them, per unit. */
materials.put("/services/:id/labor", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ labor_cost: z.number().min(0).max(10_000_000) }));
  const { db, companyId } = c.var;
  await serviceOf(db, companyId, id);
  const links = await linksOf(db, id);
  if (!links.length) throw new HttpError(400, "Add a material first. Without materials, the price list's cost is the whole cost.");
  return c.json({ materials: links, ...(await updateServiceCost(db, companyId, id, links, Math.round(body.labor_cost * 100) / 100)) });
});

/**
 * Every material in the price list checked with ABC Supply and priced at the branch today (Roofing
 * → Catalog → Your materials): renamed ones take ABC's new name, and ones ABC doesn't carry any more
 * or can't price are marked, keeping their last price.
 */
materials.post("/materials/check", requireUser, requireCompany(SALES, "settings"), async (c) => {
  if (!(await allow(c.env, `materials-check:${c.var.companyId}`, 10, 10 * 60))) throw new HttpError(429, "Your materials were just checked. Wait a few minutes and try again.");
  return c.json(await pricePackages(c.env, c.var.db, c.var.companyId, { all: true, check: true }));
});

/**
 * One material swapped for another item from ABC's catalog in every service it's in (`links`), each
 * with how many of the new one go into a unit. The services' costs and the packages that follow
 * ABC are worked out again; estimates are priced again when they're next opened.
 */
materials.post("/materials/replace", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const body = await readJson(c, z.object({ ...picked, links: z.array(z.object({ id: z.string().uuid(), per_unit: perUnit })).min(1).max(100) }));
  const { db, companyId } = c.var;
  const rows = must(await db.from("service_materials").select("id, service_id").eq("company_id", companyId).in("id", body.links.map((l) => l.id))) as Array<{ id: string; service_id: string }>;
  if (rows.length !== new Set(body.links.map((l) => l.id)).size) throw new HttpError(404, "Some of those materials were taken out already. Reload the page and try again.");
  const { client, settings } = await connection(c);
  const { item, uom, price } = await pickedItem(client, settings, body);
  const pricedAt = new Date().toISOString();
  for (const link of body.links) {
    const { error } = await db
      .from("service_materials")
      .update({
        item_number: item.item_number,
        name: item.name.slice(0, 300),
        uom: uom.code,
        uom_name: uom.name.slice(0, 60),
        length_ft: item.dimensional ? body.length_ft : null,
        per_unit: link.per_unit,
        unit_price: price.unit_price,
        priced_at: pricedAt,
        price_note: price.note,
      })
      .eq("id", link.id)
      .eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  await recostServices(db, companyId, [...new Set(rows.map((r) => r.service_id))]);
  return c.json({ replaced: body.links.length, name: item.name, unit_price: price.unit_price });
});

/**
 * A quote's materials, priced at ABC Supply today: for each line from a service with materials,
 * whole bundles, rolls and pieces at the account's prices at its branch. Each line keeps what its
 * materials came to (materials, material_cost) and its cost per unit with the rest (unit_cost); the
 * price list keeps the newest prices, so its costs stay current too.
 */
materials.post("/quotes/:id/material-prices", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const { db, companyId } = c.var;
  const quote = must(await db.from("quotes").select("id, status").eq("id", id).eq("company_id", companyId).maybeSingle(), "That quote wasn't found.");
  if (!EDITABLE.includes(quote.status)) throw new HttpError(409, "This quote was approved, so its materials keep the prices it was approved with.");
  const lines = must(await db.from("quote_line_items").select("id, service_id, quantity, materials").eq("quote_id", id)) as Array<{ id: string; service_id: string | null; quantity: number; materials: unknown }>;
  const serviceIds = [...new Set(lines.map((l) => l.service_id).filter((s): s is string => Boolean(s)))];
  const [links, services] = serviceIds.length
    ? await Promise.all([
        db.from("service_materials").select(LINK_FIELDS).in("service_id", serviceIds).order("sort").order("created_at"),
        db.from("services").select("id, labor_cost").in("id", serviceIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];
  const byService = new Map<string, LinkRow[]>();
  for (const link of must(links) as unknown as LinkRow[]) byService.set(link.service_id, [...(byService.get(link.service_id) ?? []), link]);
  const labor = new Map((must(services) as Array<{ id: string; labor_cost: number | null }>).map((s) => [s.id, s.labor_cost]));

  // Lines whose service no longer has materials go back to being priced from the price list.
  const plain = lines.filter((l) => l.materials && !(l.service_id && byService.has(l.service_id))).map((l) => l.id);
  if (plain.length) {
    const { error } = await db.from("quote_line_items").update({ materials: null, material_cost: null }).in("id", plain);
    if (error) throw dbError(error);
  }
  const priced = lines.filter((l) => l.service_id && byService.has(l.service_id));
  if (!priced.length) return c.json({ priced_at: null, lines: [] });
  if (!(await allow(c.env, `material-prices:${companyId}`, 60, 10 * 60))) throw new HttpError(429, "Those prices were just updated. Wait a minute and try again.");

  const { client, settings } = await connection(c);
  const asks = priced.flatMap((line) =>
    priceMaterials(line.quantity, byService.get(line.service_id!)!).items.map((item, i) => {
      const link = byService.get(line.service_id!)![i]!;
      return { id: `${line.id}:${link.id}`, item_number: link.item_number, quantity: Math.max(1, item.quantity), uom: link.uom, length_ft: link.length_ft === null || link.length_ft === undefined ? null : Number(link.length_ft) };
    }),
  );
  let prices;
  try {
    prices = await client.prices(settings.ship_to, settings.branch, asks, "quoting");
  } catch (error) {
    throw supplierAnswer(error);
  }
  const pricedAt = new Date().toISOString();
  const admin = adminClient(c.env);

  // The price list keeps each material's newest price, and its services' costs follow. One ABC
  // won't price today keeps its last price, with ABC's reason beside it, so the service's cost
  // (and a package that follows ABC) doesn't drop by what it cost.
  const fresh = new Map<string, { unit_price: number | null; price_note: string | null }>();
  for (const line of priced) {
    for (const link of byService.get(line.service_id!)!) {
      const answer = prices.get(`${line.id}:${link.id}`);
      if (answer && !fresh.has(link.id)) fresh.set(link.id, { unit_price: keptPrice(answer.unit_price, link.unit_price), price_note: answer.note });
    }
  }
  for (const [linkId, price] of fresh) {
    const { error } = await admin.from("service_materials").update({ ...price, priced_at: pricedAt }).eq("id", linkId).eq("company_id", companyId);
    if (error) throw dbError(error);
  }
  for (const serviceId of new Set(priced.map((l) => l.service_id!))) {
    const updated = byService.get(serviceId)!.map((link) => ({ ...link, ...(fresh.get(link.id) ?? {}) }));
    byService.set(serviceId, updated);
    const { error } = await admin.from("services").update({ unit_cost: serviceUnitCost(updated, labor.get(serviceId) ?? null) }).eq("id", serviceId).eq("company_id", companyId);
    if (error) throw dbError(error);
  }

  const results = [];
  for (const line of priced) {
    const links = byService.get(line.service_id!)!.map((link) => ({ ...link, unit_price: prices.get(`${line.id}:${link.id}`)?.unit_price ?? null, price_note: prices.get(`${line.id}:${link.id}`)?.note ?? null }));
    const { items, total, unpriced } = priceMaterials(line.quantity, links);
    const snapshot: LineMaterials = { supplier: "abc_supply", branch: settings.branch, branch_name: settings.branch_name, priced_at: pricedAt, line_quantity: Number(line.quantity), items };
    const { error } = await db
      .from("quote_line_items")
      .update({ materials: asJson(snapshot), material_cost: total, unit_cost: lineUnitCost(total, labor.get(line.service_id!) ?? null, line.quantity) })
      .eq("id", line.id);
    if (error) throw dbError(error);
    results.push({ id: line.id, material_cost: total, unpriced });
  }
  return c.json({ priced_at: pricedAt, branch_name: settings.branch_name, lines: results });
});
