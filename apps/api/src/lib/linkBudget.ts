/**
 * What one public link may send of its files in a day. Pictures behind a link anyone can open (a
 * guide shared with anyone, a showcase, a quote's or invoice's map drawings on the Client Hub) are
 * sent by this server each time they're asked for, and sending costs money on Railway ($0.05 a GB)
 * with nothing else to stop it: one link posted somewhere public, or a script asking for the same
 * picture over and over from many addresses, could run up the bill while every visitor stays under
 * their own limit. So each link has a day's worth (LINK_BYTES_A_DAY, far more than people reading
 * it use: a guide with 20 pictures is a few MB a read; PUBLIC_LINK_GB_A_DAY changes it, and 0 turns
 * it off, for a business whose showcase is shared widely), counted in the database (rate_limit_spend,
 * 20261118000200_storage_cost_limits.sql) so every replica shares it. Past it, the link's pictures
 * answer 429 until the day is over; the page itself still opens, and owners and admins hear once a
 * day which link it was, so they can make a new one if it went somewhere it shouldn't. A new link
 * starts afresh. A count that can't be made lets the picture through: a budget never stops normal
 * use. On Railway or not: a server's bandwidth costs something wherever it runs.
 */
import { ADMINS } from "@crewtavo/core";
import type { Env } from "../env";
import { allow } from "./limit";
import { reportError } from "./monitoring";
import { adminClient } from "./supabase";

/** What one link's files may send in a day: 2 GB, about $0.10 on Railway, unless PUBLIC_LINK_GB_A_DAY says otherwise. */
export const LINK_BYTES_A_DAY = 2_000_000_000;
/** The most it can be set to: what the database's count holds, in KB. */
const MOST_BYTES_A_DAY = 2_000_000_000 * 1000;

/** The day's budget for each link: PUBLIC_LINK_GB_A_DAY (GB), or LINK_BYTES_A_DAY; null for none (0). */
export function linkBytesADay(env: Pick<Env, "PUBLIC_LINK_GB_A_DAY">): number | null {
  const set = env.PUBLIC_LINK_GB_A_DAY?.trim();
  if (!set) return LINK_BYTES_A_DAY;
  const gb = Number(set);
  if (!Number.isFinite(gb) || gb < 0) return LINK_BYTES_A_DAY;
  if (gb === 0) return null;
  return Math.min(Math.max(1_000_000, Math.floor(gb * 1_000_000_000)), MOST_BYTES_A_DAY);
}
const DAY_SECONDS = 86_400;

/** Counted in KB, so a day's worth fits the database's count. */
const KB = 1000;

/** What a picture past its link's budget answers. */
export const LINK_PAUSED = "This link has sent a lot today, so its pictures are paused until tomorrow.";

/**
 * Counts `bytes` sent through `link` (its kind and its token or id, like "guide:<token>"), and says
 * whether it's within the link's day: false once it has sent LINK_BYTES_A_DAY. A HEAD counts 0 and
 * only asks. When it's over, `paused` tells the company's owners and admins, once a day per link.
 */
export async function linkCanSend(env: Env, link: string, bytes: number, paused?: { company: string; title: string; body: string; open: string }): Promise<boolean> {
  const budget = linkBytesADay(env);
  if (budget === null) return true;
  let within: unknown;
  try {
    const { data, error } = await adminClient(env).rpc("rate_limit_spend", {
      p_key: `link-bytes:${link}`.slice(0, 200),
      p_amount: Math.ceil(Math.max(0, bytes) / KB),
      p_max: Math.floor(budget / KB),
      p_window_seconds: DAY_SECONDS,
    });
    if (error) throw new Error(error.message);
    within = data;
  } catch (error) {
    reportError(new Error(`A link's daily budget couldn't be counted: ${error instanceof Error ? error.message : String(error)}`));
    return true;
  }
  if (within !== false) return true;
  if (paused && (await allow(env, `link-paused-told:${link}`.slice(0, 200), 1, DAY_SECONDS))) await tellAdmins(env, paused).catch((e: unknown) => console.warn("Couldn't say a link was paused:", e instanceof Error ? e.message : e));
  return false;
}

/** A notice on the bell for the company's owners and admins (kind "hosting"), opening `open` in the app. */
export async function tellAdmins(env: Env, paused: { company: string; title: string; body: string; open: string }) {
  const admin = adminClient(env);
  const { data: people, error } = await admin.from("memberships").select("user_id").eq("company_id", paused.company).eq("active", true).in("role", [...ADMINS]);
  if (error) throw new Error(error.message);
  if (!people?.length) return;
  const { error: sendError } = await admin.from("notifications").insert(people.map((p) => ({ company_id: paused.company, user_id: p.user_id, kind: "hosting", title: paused.title, body: paused.body, link: paused.open })));
  if (sendError) throw new Error(sendError.message);
}
