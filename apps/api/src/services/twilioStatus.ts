/**
 * What Twilio reports about a text after taking it (its StatusCallback, routes/messages.ts): a text
 * Crewtavo keeps on a client's timeline is marked delivered, or failed with why, as Quo's reports
 * are (services/quo.ts). Twilio answers "queued" to a text it later can't deliver (a phone that's
 * off, a US number not yet registered for A2P 10DLC), so without this such a text reads as sent.
 *
 * The message is found by Twilio's MessageSid: its external_id, or the id kept on one person when
 * the text went to several (services/recipients.ts recipientsColumn), and then only that person is
 * marked. Reports can come in any order and more than once, so the first word on how a text ended
 * stands: a later "delivered" never clears a failure, and a failure never replaces "delivered" on
 * a text to one person (to several, who it reached isn't kept per person, so a failure marks them).
 */
import type { Db } from "../lib/supabase";

/** Twilio's reasons a text didn't arrive, in words for the office. Any other code is given as its number. */
const WHY: Record<number, string> = {
  21610: "They opted out of texts from your number",
  30002: "Your Twilio account is suspended",
  30003: "Their phone is off or out of reach",
  30004: "Their number is blocked from getting this text",
  30005: "That number is unknown and may no longer be in service",
  30006: "That number is a landline, or its carrier can't be reached",
  30007: "Twilio or their carrier filtered it out as unwanted",
  30008: "Their carrier didn't deliver it and gave no reason",
  30032: "Your toll-free number isn't verified for texting yet. Check its status in Twilio",
  30034: "Your Twilio number isn't registered to text US numbers yet (A2P 10DLC). Finish the registration in Twilio",
};

/** "Their phone is off or out of reach (Twilio error 30003)." */
export function twilioFailure(code: string | undefined): string {
  const n = /^\d{1,6}$/.test(code ?? "") ? Number(code) : null;
  const why = (n !== null && WHY[n]) || "Twilio couldn't deliver it";
  return n === null ? `${why}.` : `${why} (Twilio error ${n}).`;
}

type Person = Record<string, unknown>;

/**
 * Brings the message for a text up to date with Twilio's report. `companies` are the ones whose
 * Twilio account signed it (null: the server's, which several share). Only how a text ended counts
 * ("delivered", "undelivered", "failed"); a text nobody kept a message for is let go. The message
 * is saved just after Twilio takes the text, so a report that beats it is looked for twice.
 */
export async function noteTwilioStatus(
  admin: Db,
  companies: readonly string[] | null,
  report: { sid?: string; status?: string; code?: string },
  wait: (ms: number) => Promise<unknown> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const sid = report.sid ?? "";
  const failed = report.status === "undelivered" || report.status === "failed";
  if (!sid || (!failed && report.status !== "delivered")) return;
  const find = async () => {
    const texts = () => {
      const query = admin.from("messages").select("id, status, recipients").eq("channel", "sms").eq("direction", "out");
      return companies ? query.in("company_id", [...companies]) : query;
    };
    // As JSON text: given an array, the client writes a Postgres array, which a jsonb column refuses (services/quo.ts).
    const [byId, byPerson] = await Promise.all([texts().eq("external_id", sid).limit(10), texts().contains("recipients", JSON.stringify([{ id: sid }])).limit(10)]);
    const error = byId.error ?? byPerson.error;
    if (error) throw new Error(`Couldn't look up the text Twilio reported on: ${error.message}`);
    return [...(byId.data ?? []), ...(byPerson.data ?? []).filter((row) => !byId.data?.some((k) => k.id === row.id))];
  };
  let rows = await find();
  if (!rows.length) {
    await wait(3000);
    rows = await find();
  }
  for (const row of rows) {
    const list = Array.isArray(row.recipients) ? (row.recipients as Person[]) : null;
    // About one person's text when each person's id was kept; otherwise about the whole send.
    const each = Boolean(list?.some((p) => p.id));
    const person = each ? list!.find((p) => p.id === sid) : null;
    if (each ? !person || person.failed : row.status === "failed" || (failed && row.status === "delivered")) continue;
    let update: { status: string; recipients?: typeof row.recipients };
    if (failed) {
      const recipients = list?.map((p) => (!each || p === person ? { ...p, failed: true, reason: twilioFailure(report.code) } : p));
      update = { status: !recipients || recipients.every((p) => p.failed) ? "failed" : row.status, ...(recipients ? { recipients: recipients as typeof row.recipients } : {}) };
    } else if (row.status === "sent" || row.status === "queued") {
      // Only the status: writing the people back could undo a failure another report just marked on one of them.
      update = { status: "delivered" };
    } else continue;
    const { error } = await admin.from("messages").update(update).eq("id", row.id);
    if (error) throw new Error(`Couldn't note what Twilio said about a text: ${error.message}`);
  }
}
