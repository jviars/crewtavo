/**
 * The largest file this Crewtavo takes, on Railway, and raising it for an owner with one press. The
 * storage service checks uploads against its FILE_SIZE_LIMIT variable: 200 MB in the template now
 * (plan sets run big), 50 MB in instances deployed before it. With Crewtavo's Railway connection
 * (services/railway.ts) it can read that variable and change it, then restart storage, which takes
 * about a minute and pauses uploads meanwhile.
 */
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import { redeploy, RailwayError, serviceIdByName, serviceVariables, setServiceVariable } from "../integrations/railway";
import { railwayAccess } from "./railway";

/** 200 MB, the template's FILE_SIZE_LIMIT (.railway/railway.ts, docker-compose.yml). */
export const UPLOAD_LIMIT = 209_715_200;

export interface UploadLimit {
  /** Crewtavo holds Railway access, so it can read and change the limit. */
  connected: boolean;
  /** What the storage service takes now, in bytes; null when it isn't known. */
  limit: number | null;
  /** What raising it sets. */
  target: number;
  /** The limit was just raised and storage is restarting. */
  raised?: boolean;
}

async function storageOf(env: Env, admin: Db, companyId: string) {
  const access = await railwayAccess(env, admin, companyId);
  if (!access) return null;
  const serviceId = await serviceIdByName(env, access, "storage");
  if (!serviceId) throw new RailwayError("Crewtavo can't find the storage service in this Railway project, so the limit has to be changed by hand.");
  const vars = await serviceVariables(env, access, serviceId);
  const limit = Number(vars.UPLOAD_FILE_SIZE_LIMIT ?? vars.FILE_SIZE_LIMIT);
  return { access, serviceId, limit: Number.isFinite(limit) && limit > 0 ? limit : null };
}

export async function uploadLimit(env: Env, admin: Db, companyId: string): Promise<UploadLimit> {
  const storage = await storageOf(env, admin, companyId);
  return { connected: Boolean(storage), limit: storage?.limit ?? null, target: UPLOAD_LIMIT };
}

/** Sets the storage service's limit to 200 MB and restarts it. Never lowers one set higher. */
export async function raiseUploadLimit(env: Env, admin: Db, companyId: string): Promise<UploadLimit> {
  const storage = await storageOf(env, admin, companyId);
  if (!storage) throw new HttpError(400, "Connect Crewtavo to Railway first, in Settings → Web address. Then try again.");
  if (storage.limit !== null && storage.limit >= UPLOAD_LIMIT) return { connected: true, limit: storage.limit, target: UPLOAD_LIMIT, raised: false };
  await setServiceVariable(env, storage.access, storage.serviceId, "FILE_SIZE_LIMIT", String(UPLOAD_LIMIT));
  // The storage service reads it as it starts.
  await redeploy(env, storage.access, storage.serviceId);
  return { connected: true, limit: UPLOAD_LIMIT, target: UPLOAD_LIMIT, raised: true };
}
